// Shared worlds ("MMO"): one generic hub per game version whose manifest has an `mmo` object (any runtime). The page's
// link (src/host/web/mmo-link.js) carries the engine's records over a WebSocket on /api/mmo/<versionId>/ws; this module
// knows nothing of any game: it keeps accounts' characters (opaque state blobs), slots, seniority ranks and entity tags,
// relays the realtime records with the sender's slot, arbitrates the ownership of 32-bit network ids, keeps records
// with locks, a world clock and world variables (opaque ids and values), checks admins (admins.json) for world changes,
// and saves all of it under its directory. Wire protocol: src/host/mmo-proto.js.
//
// Files under `dir`: admins.json (["name" or { name, id }, ...]: account names whatever their case, re-read when it
// changes; none: no admin) and admin-ids.json ({ name: account id }: a listed name without its id is bound to the first
// account that signs in under it — an account deleted and its name registered again is no admin);
// <versionId>/characters.json { nextId, characters: [{ id, user (account id), name, skin, money, state (base64),
// createdAt, updatedAt }] }; <versionId>/world.json { minutes, msPerMinute, vars: { id: value }, records: { key:
// base64 }, recordsBy: { key: the character that stored it } }. A file that cannot be read is never taken for an empty
// one (refused, read again at the next try). Written atomically (temporary file, fsync, rename), 5 s after a change, when a world's last player leaves,
// on flush() and on close().
//
// A world is loaded at its first JOIN and unloaded (saved) when its last player leaves: its clock only runs while
// loaded (minutes(t) = baseMinutes + (t - baseMs) / msPerMinute; a new world starts at minute 720 of day 0, one game
// minute per real second).
import fs from 'node:fs';
import path from 'node:path';
import { acceptWebSocket } from './lan.js';
import { MMO_PROTOCOL, MMO_C as C, MMO_S as S, MMO_REFUSED as R, MMO_RESULT as CR, MMO_DENIED as D, MMO_NOBODY as NOBODY } from './mmo-proto.js';

const VERSION_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/**
 * A character's name (2 to 16 ASCII characters: letters and digits, single separators — space _ . - — between them; unique
 * per version whatever the case and the separators: mmoNameKey) and a skin's (a model name).
 */
export const MMO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|[ _.-](?=[A-Za-z0-9])){1,15}$/;
/** What makes two names the same name: 'Tom my', 'tom_my' and 'TOMMY' are one. */
export const mmoNameKey = (name) => String(name).toLowerCase().replace(/[ _.-]/g, '');
export const MMO_SKIN = /^[A-Za-z0-9_]{1,20}$/;
export const MMO_LIMITS = Object.freeze({
  frame: 65536, // (an inbound message; bigger: the connection closes)
  state: 4096, // (a character's state; a record's data)
  recordKeys: 4096, // (records per world)
  recordBytes: 1 << 20, // (the data of a world's records together)
  recordsPerChar: 16, recordBytesPerChar: 64 * 1024, // (records a character last stored, their data together)
  locksPerSlot: 16, // (locks a player holds at once)
  locksPerSec: 4, locksBurst: 8, // (LOCK, STORE, UNLOCK)
  keptLockMs: 120000, // (a departed holder's locks kept for its character: its game may still hold what it took out)
  owners: 65536, // (ownership entries and known entity states per world)
  chatLines: 20, chatBytes: 120,
  recordsPerSec: 800, bytesPerSec: 256 * 1024, lobbyPerSec: 5, chatPerSec: 1, chatBurst: 5,
  backlog: 1 << 20, // (a socket's unsent bytes over which its realtime records are dropped)
  backlogClose: 8 << 20, // (... and over which it is closed)
  outMessage: 65536, // (an outbound message: a turn's records, split at record boundaries)
  silenceMs: 45000, pingMs: 15000, helloMs: 10000, recheckMs: 60000, sweepMs: 5000, saveMs: 5000,
  stateRecentMs: 15000, ownerIdleMs: 60000, handoverRange: 300,
  socketsPerUser: 4, lobbySocketsPerUser: 2, socketsPerPlayer: 4,
  playerState: 12 + 240, entityState: 18 + 400, entityGone: 64, event: 1 + 1000, targeted: 5 + 1000,
});
const DEFAULTS = Object.freeze({ maxCharacters: 8, maxPlayers: 16, records: null });
const LOCK_TYPES = new Set([C.LOCK, C.STORE, C.UNLOCK]);
const NEW_WORLD_MINUTES = 720, DEFAULT_MS_PER_MINUTE = 1000;
const PLAYER_IDS = 0xfff00000;
const LOBBY_TYPES = new Set([C.HELLO, C.CHAR_CREATE, C.CHAR_SKIN, C.CHAR_DELETE, C.JOIN, C.LEAVE]);
const EMPTY = Buffer.alloc(0);

/** What is wrong with a version's `mmo` entry, or null (none: no shared world). */
export function mmoProblem(m) {
  if (m === undefined) return null;
  const int = (v, lo, hi) => v === undefined || (Number.isInteger(v) && v >= lo && v <= hi);
  const ranges = (v) => v === undefined || (Array.isArray(v) && v.length >= 1 && v.length <= 64
    && v.every((r) => Array.isArray(r) && r.length === 2 && r.every((k) => Number.isInteger(k) && k >= 0 && k <= 0xffff) && r[0] <= r[1]));
  const ok = !!m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).every((k) => k in DEFAULTS)
    && int(m.maxCharacters, 1, 16) && int(m.maxPlayers, 2, 32) && ranges(m.records);
  return ok ? null : 'mmo : { maxCharacters: 1 à 16 (8 par défaut), maxPlayers: 2 à 32 (16 par défaut), records: [[première clé, dernière clé], …] (0 à 65535 ; toutes par défaut) }';
}
/** A version's shared world settings, its defaults filled in (`records`: the record keys allowed, only when it says). */
export const mmoSettings = (m) => ({ maxCharacters: m?.maxCharacters ?? DEFAULTS.maxCharacters, maxPlayers: m?.maxPlayers ?? DEFAULTS.maxPlayers,
  ...(m?.records ? { records: m.records.map((r) => [r[0], r[1]]) } : {}) });
/** Whether a version's settings allow a record key. */
const keyAllowed = (cfg, key) => !cfg.records || cfg.records.some(([lo, hi]) => key >= lo && key <= hi);

/** Bytes of a record body, built little-endian. */
class Out {
  constructor() { this.b = Buffer.allocUnsafe(256); this.n = 0; }
  room(k) { if (this.n + k > this.b.length) { const nb = Buffer.allocUnsafe(Math.max(this.b.length * 2, this.n + k)); this.b.copy(nb, 0, 0, this.n); this.b = nb; } }
  u8(v) { this.room(1); this.b[this.n++] = v & 255; return this; }
  u16(v) { this.room(2); this.b.writeUInt16LE(v & 0xffff, this.n); this.n += 2; return this; }
  u32(v) { this.room(4); this.b.writeUInt32LE(v >>> 0, this.n); this.n += 4; return this; }
  i32(v) { this.room(4); this.b.writeInt32LE(v | 0, this.n); this.n += 4; return this; }
  f32(v) { this.room(4); this.b.writeFloatLE(v, this.n); this.n += 4; return this; }
  f64(v) { this.room(8); this.b.writeDoubleLE(v, this.n); this.n += 8; return this; }
  bytes(buf) { this.room(buf.length); buf.copy(this.b, this.n); this.n += buf.length; return this; }
  str8(text) { const buf = Buffer.from(String(text), 'latin1').subarray(0, 255); return this.u8(buf.length).bytes(buf); }
  done() { return this.b.subarray(0, this.n); }
}
const SHORT = new Error('short record');
/** A record body read little-endian; a read past its end throws SHORT. */
class In {
  constructor(b) { this.b = b; this.o = 0; }
  take(n) { if (this.o + n > this.b.length) throw SHORT; const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  u8() { return this.take(1)[0]; }
  u16() { return this.take(2).readUInt16LE(0); }
  u32() { return this.take(4).readUInt32LE(0); }
  i32() { return this.take(4).readInt32LE(0); }
  f32() { return this.take(4).readFloatLE(0); }
  f64() { return this.take(8).readDoubleLE(0); }
  str8() { return this.take(this.u8()); }
  left() { return this.b.length - this.o; }
}
/** A server record: u16 len | u8 type | u8 from | body. */
const record = (type, from, body = EMPTY) => {
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt16LE(2 + body.length, 0); out[2] = type; out[3] = from; body.copy(out, 4);
  return out;
};
const isRealtime = (type) => type >= C.PLAYER_STATE && type <= C.TARGETED;
/** Chat text: printable ASCII or Latin-1 0xA0-0xFF. */
const chatOk = (b) => b.length >= 1 && b.length <= MMO_LIMITS.chatBytes && b.every((c) => (c >= 0x20 && c <= 0x7e) || c >= 0xa0);

/** A token bucket: `rate` a second, at most `burst`; take(n) false when short (nothing taken). */
const bucket = (rate, burst, t) => ({ rate, burst, tokens: burst, at: t });
const take = (b, n, t) => {
  const dt = t - b.at; b.at = t;
  if (dt > 0) b.tokens = Math.min(b.burst, b.tokens + (dt * b.rate) / 1000);
  if (b.tokens < n) return false;
  b.tokens -= n; return true;
};

/** A file replaced whole: written beside it, synced, renamed over it (the directory synced too). */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* not supported here */ }
}

/**
 * The shared worlds' hub. `getManifest(versionId)`: the version's manifest (its `mmo` object says it has a shared
 * world); `identify(req)`: the signed-in account ({ id, username }), null when nobody is, undefined on a server without
 * accounts (no shared world then); `dir`: where worlds and characters are kept (null: disabled); `now()`: the server's
 * clock in ms (its time in WELCOME / PONG / WORLD). `handle(req, res, url)`: the status route (GET /api/mmo/<versionId>
 * → { enabled, signedIn, admin, players, maxPlayers }), false for other paths; `upgrade(req, socket, url)`: the
 * WebSocket of /api/mmo/<versionId>/ws, false for other paths; `flush()`: everything saved now; `close()`: saved, every
 * connection closed; `sweep()`: the periodic checks run now (silence, session, forgotten entries — tests).
 * @param {{ getManifest: (id: string) => any, identify?: (req: import('node:http').IncomingMessage) => ({ id: string, username: string } | null | undefined),
 *   dir?: string | null, log?: (line: string) => void, now?: () => number }} options
 * @returns {{ handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => boolean,
 *   upgrade: (req: import('node:http').IncomingMessage, socket: import('node:net').Socket, url: URL) => boolean,
 *   flush: () => void, close: () => void, sweep: () => void }}
 */
export function mmoApi({ getManifest, identify = () => undefined, dir = null, log = () => {}, now = () => Date.now() } = {}) {
  const enabled = !!dir;
  /** Per version: its characters, its world while loaded, its sockets, its chat history. */
  const versions = new Map();
  const sessions = new Set();
  const pending = new Set(); // (sessions with records to send at the end of this turn)
  let flushScheduled = false, closed = false;
  /** admins.json's names (lowercase) → the account id it gives, or null (bound at the first sign-in: admin-ids.json) */
  const admins = { stamp: null, names: new Map(), bound: null };

  const settingsOf = (id) => {
    if (!VERSION_ID.test(id)) return null;
    const m = getManifest(id)?.mmo;
    if (!m) return null;
    const problem = mmoProblem(m);
    if (problem) { log(`mmo: ${id}: ${problem}`); return null; }
    return mmoSettings(m);
  };
  /**
   * admins.json, read again whenever it changed; missing or unreadable: nobody. An admin is an account, not a name: a
   * name listed without its id is bound to the first account signed in under it (admin-ids.json), for good.
   */
  const isAdmin = (user) => {
    if (!enabled || !user) return false;
    const file = path.join(dir, 'admins.json');
    let st = null; try { st = fs.statSync(file); } catch { /* none */ }
    const stamp = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : null;
    if (stamp !== admins.stamp) {
      admins.stamp = stamp; admins.names = new Map();
      if (st) {
        try {
          const list = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!Array.isArray(list)) throw new Error('not a list');
          for (const n of list) {
            if (typeof n === 'string') admins.names.set(n.toLowerCase(), null);
            else if (typeof n?.name === 'string' && typeof n.id === 'string') admins.names.set(n.name.toLowerCase(), n.id);
          }
        } catch (e) { log(`mmo: admins.json unreadable (${e.message}): no admin`); }
      }
    }
    const name = String(user.username ?? '').toLowerCase();
    if (!admins.names.has(name)) return false;
    const id = admins.names.get(name);
    if (id) return id === String(user.id);
    const boundFile = path.join(dir, 'admin-ids.json');
    if (!admins.bound) {
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(boundFile, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') { log(`mmo: admin-ids.json unreadable (${e.message}): no admin`); return false; }
      }
      admins.bound = new Map(Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}).filter(([, v]) => typeof v === 'string'));
    }
    const bound = admins.bound.get(name);
    if (bound !== undefined) return bound === String(user.id);
    try {
      admins.bound.set(name, String(user.id));
      writeAtomic(boundFile, JSON.stringify(Object.fromEntries(admins.bound), null, 1));
      log(`mmo: admin ${name} is the account ${user.id}`);
      return true;
    } catch (e) { admins.bound.delete(name); log(`mmo: admin-ids.json not saved (${e.message}): not an admin yet`); return false; }
  };

  // ------------------------------------------------------------------------------------------------ persistence
  const charsFile = (id) => path.join(dir, id, 'characters.json');
  const worldFile = (id) => path.join(dir, id, 'world.json');
  /**
   * A JSON file, or null when there is none; a broken one is set aside (never overwritten) and reads as none. A file
   * that cannot be read (EMFILE, EIO, EACCES…) throws: never taken for an empty one, which the next save would replace.
   */
  const readJson = (file) => {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; log(`mmo: ${file}: ${e.message}`); throw e; }
    try { return JSON.parse(text); } catch (e) {
      const aside = `${file}.broken-${Date.now()}`;
      try { fs.renameSync(file, aside); } catch { /* left there */ }
      log(`mmo: ${file}: ${e.message} (kept as ${aside})`);
      return null;
    }
  };
  const versionOf = (id) => {
    let v = versions.get(id);
    if (v) return v;
    const raw = readJson(charsFile(id)), chars = [];
    for (const c of Array.isArray(raw?.characters) ? raw.characters : []) {
      if (!Number.isInteger(c?.id) || c.id < 1 || c.id > 0xffffffff || typeof c.user !== 'string' || typeof c.name !== 'string' || typeof c.skin !== 'string') continue;
      chars.push({ id: c.id, user: c.user, name: c.name, skin: c.skin, money: Number.isInteger(c.money) ? c.money | 0 : 0,
        state: typeof c.state === 'string' ? Buffer.from(c.state, 'base64').subarray(0, MMO_LIMITS.state) : EMPTY,
        createdAt: Number(c.createdAt) || 0, updatedAt: Number(c.updatedAt) || 0, session: null });
    }
    const nextId = Math.max(Number.isInteger(raw?.nextId) ? raw.nextId : 1, ...chars.map((c) => c.id + 1));
    // (kept: record key → { char, until } — the locks of holders gone, kept for their characters a while)
    v = { id, chars, nextId, charsDirty: false, world: null, worldDirty: false, timer: null, sockets: new Set(), chat: [], nextRank: 1, nextTag: 1, kept: new Map() };
    versions.set(id, v);
    return v;
  };
  const minutesAt = (w, t) => w.baseMinutes + (t - w.baseMs) / w.msPerMinute;
  const save = (v, force = false) => {
    if (v.timer) { clearTimeout(v.timer); v.timer = null; }
    try {
      if (v.charsDirty) {
        v.charsDirty = false;
        writeAtomic(charsFile(v.id), JSON.stringify({ nextId: v.nextId, characters: v.chars.map((c) => ({ id: c.id, user: c.user, name: c.name, skin: c.skin, money: c.money,
          state: c.state.toString('base64'), createdAt: c.createdAt, updatedAt: c.updatedAt })) }));
      }
      const w = v.world;
      if (w && (v.worldDirty || force)) {
        v.worldDirty = false;
        const records = {}, recordsBy = {};
        for (const [key, r] of [...w.records].sort((a, b) => a[0] - b[0])) if (r.data.length) { records[key] = r.data.toString('base64'); if (r.by) recordsBy[key] = r.by; }
        const minutes = minutesAt(w, now());
        writeAtomic(worldFile(v.id), JSON.stringify({ minutes, msPerMinute: w.msPerMinute, vars: Object.fromEntries([...w.vars].sort((a, b) => a[0] - b[0])), records, recordsBy }));
        // (nobody there: saved, the world leaves memory — its clock stops)
        if (!w.count) { v.world = null; log(`mmo: ${v.id}: world saved and frozen (minute ${Math.floor(minutes)})`); }
      }
    } catch (e) { log(`mmo: ${v.id}: not saved: ${e.message}`); v.charsDirty = true; if (v.world) v.worldDirty = true; later(v); }
  };
  /** Saved in a few seconds (one write for a burst of changes). */
  const later = (v) => { if (!v.timer && !closed) { v.timer = setTimeout(() => save(v), MMO_LIMITS.saveMs); v.timer.unref?.(); } };
  const charsChanged = (v) => { v.charsDirty = true; later(v); };
  const worldChanged = (v) => { v.worldDirty = true; later(v); };

  // ------------------------------------------------------------------------------------------------ worlds
  const loadWorld = (v, cfg) => {
    const raw = readJson(worldFile(v.id)) ?? {}; // (unreadable: thrown, nothing loaded — the JOIN refused, tried again at the next)
    const vars = new Map(), records = new Map();
    let recordBytes = 0;
    for (const [k, val] of Object.entries(raw.vars ?? {})) { const id = Number(k); if (Number.isInteger(id) && id >= 0 && id <= 255 && Number.isInteger(val) && vars.size < 255) vars.set(id, val | 0); }
    for (const [k, text] of Object.entries(raw.records ?? {})) {
      const key = Number(k), data = typeof text === 'string' ? Buffer.from(text, 'base64').subarray(0, MMO_LIMITS.state) : EMPTY;
      if (!Number.isInteger(key) || key < 0 || key > 0xffff || !data.length || records.size >= MMO_LIMITS.recordKeys || recordBytes + data.length > MMO_LIMITS.recordBytes) continue;
      const by = raw.recordsBy?.[k];
      records.set(key, { data, holder: NOBODY, by: Number.isInteger(by) && by > 0 ? by : 0 });
      recordBytes += data.length;
    }
    const msPerMinute = Number.isFinite(raw.msPerMinute) && raw.msPerMinute >= 30 && raw.msPerMinute <= 60000 ? Math.fround(raw.msPerMinute) : DEFAULT_MS_PER_MINUTE;
    const w = { v, cfg, baseMinutes: Number.isFinite(raw.minutes) ? raw.minutes : NEW_WORLD_MINUTES, baseMs: now(), msPerMinute, vars, records,
      recordBytes, slots: new Array(cfg.maxPlayers).fill(null), count: 0, tags: new Map(), owners: new Map(), states: new Map(), ownersWarned: false };
    v.world = w;
    log(`mmo: ${v.id}: world loaded (minute ${Math.floor(w.baseMinutes)})`);
    return w;
  };
  /** A world nobody is in: saved, then out of memory (kept there while it cannot be saved: tried again later). */
  const unloadWorld = (v) => { if (v.world) save(v, true); };
  const worldBody = (w, out = new Out()) => {
    out.f64(w.baseMs).f64(w.baseMinutes).f32(w.msPerMinute).u8(w.vars.size);
    for (const [id, value] of [...w.vars].sort((a, b) => a[0] - b[0])) out.u8(id).i32(value);
    return out;
  };
  const playerInfo = (s, out = new Out()) => out.u8(s.slot).u32(s.rank).u8(s.admin ? 1 : 0).u8(s.awayBits ? 1 : 0).str8(s.char.name).str8(s.skin);
  const recordOf = (key, r, from = NOBODY) => record(S.RECORD, from, new Out().u16(key).u8(r.holder).u16(r.data.length).bytes(r.data).done());
  const ownerRecord = (netid, owner, previous, from = NOBODY) => record(S.OWNER, from, new Out().u32(netid).u8(owner).u8(previous).done());
  const chatRecord = (line, from) => record(S.CHAT, from, new Out().u8(line.kind).str8(line.name).u8(line.text.length).bytes(line.text).done());

  /** The owner of a network id: a player's own slot; the ownership table's entry; the session whose tag it carries. */
  const ownerOf = (w, netid) => {
    if (netid >= PLAYER_IDS) { const slot = netid - PLAYER_IDS; return slot < w.slots.length && w.slots[slot] ? slot : NOBODY; }
    const e = w.owners.get(netid);
    if (e) return e.owner !== NOBODY && w.slots[e.owner] ? e.owner : NOBODY;
    return w.tags.get(netid >>> 20)?.slot ?? NOBODY;
  };
  /**
   * An entity given to `owner` (NOBODY: orphaned). An entry naming the session whose tag the id carries says nothing
   * more than the tag: dropped. (An entry naming another present player stays as long as that player is there: the
   * entity may be out of everyone's sight, sending no state, and still be its owner's.)
   */
  const setOwner = (w, netid, owner) => {
    if (owner !== NOBODY && w.tags.get(netid >>> 20)?.slot === owner) w.owners.delete(netid);
    else w.owners.set(netid, { owner, at: now() });
  };
  /** The entities `slot` owns (its tag's, those given to it) that the server has heard of. */
  const ownedBy = (w, slot, tag) => {
    const ids = [];
    for (const [id, e] of w.owners) if (e.owner === slot) ids.push(id);
    for (const id of w.states.keys()) if (id >>> 20 === tag && !w.owners.has(id)) ids.push(id);
    return ids;
  };
  /**
   * The entities of a player gone or away, each to the nearest present player not away within range of its last
   * position (its states of the last 15 s; ties: the senior), else orphaned; every change sent as OWNER.
   */
  const handOver = (w, ids, from) => {
    const t = now(), r2 = MMO_LIMITS.handoverRange ** 2;
    const takers = w.slots.filter((p) => p && p.slot !== from && !p.awayBits && p.pos);
    for (const id of ids) {
      const st = w.states.get(id);
      let best = null, bestD = Infinity;
      if (st && t - st.at <= MMO_LIMITS.stateRecentMs) {
        for (const p of takers) {
          const d = (p.pos.x - st.x) ** 2 + (p.pos.y - st.y) ** 2 + (p.pos.z - st.z) ** 2;
          if (d <= r2 && (d < bestD || (d === bestD && p.rank < best.rank))) { best = p; bestD = d; }
        }
      }
      const owner = best ? best.slot : NOBODY;
      setOwner(w, id, owner);
      toWorld(w, ownerRecord(id, owner, from));
    }
  };
  /** A record nobody holds and without data is no record: forgotten (unless kept for a departed holder). */
  const forgetEmpty = (w, key, r) => { if (!r.data.length && r.holder === NOBODY && !w.v.kept.has(key)) w.records.delete(key); };
  /**
   * The locks of a player leaving the world: free for the others to see, but kept for its character a while (its game
   * may still hold what it took out under the lock — a garage's cars —, and stores it back once there again: its
   * JOIN gives them back); nobody else gets them until then.
   */
  const releaseLocks = (w, slot, charId) => {
    for (const [key, r] of [...w.records]) {
      if (r.holder !== slot) continue;
      r.holder = NOBODY;
      if (charId) w.v.kept.set(key, { char: charId, until: now() + MMO_LIMITS.keptLockMs });
      toWorld(w, recordOf(key, r));
      forgetEmpty(w, key, r);
    }
  };
  /** Whether `s` may take the lock of `key`: none kept for another character (expired ones forgotten). */
  const keptFromOthers = (s, key) => {
    const k = s.v.kept.get(key);
    if (!k) return false;
    if (k.char === s.char.id) return false;
    if (now() <= k.until) return true;
    s.v.kept.delete(key);
    return false;
  };
  const freeTag = (v, w) => {
    const used = new Set(w.tags.keys());
    for (const id of w.owners.keys()) used.add(id >>> 20);
    for (const id of w.states.keys()) used.add(id >>> 20);
    for (let i = 0; i < 0xffe; i++) {
      const tag = ((v.nextTag - 1 + i) % 0xffe) + 1;
      if (!used.has(tag)) { v.nextTag = (tag % 0xffe) + 1; return tag; }
    }
    return 0;
  };
  /**
   * A player out of its world (LEAVE, its socket closed, another JOIN): the others told, its locks released (`keep`: kept
   * for its character a while — not after a LEAVE, its game has left the world) and its entities handed on.
   */
  const depart = (s, why, keep = true) => {
    const w = s.world;
    if (!w) return;
    const slot = s.slot, owned = ownedBy(w, slot, s.tag), charId = s.char.id;
    w.slots[slot] = null; w.count--; w.tags.delete(s.tag);
    s.char.session = null;
    s.world = null; s.slot = NOBODY; s.tag = 0; s.pos = null;
    log(`mmo: ${s.v.id}: ${s.user.username} (${s.char.name}, slot ${slot}) left: ${why} (${w.count} in the world)`);
    s.char = null;
    toWorld(w, record(S.PLAYER_LEAVE, NOBODY, Buffer.from([slot])));
    releaseLocks(w, slot, keep ? charId : 0);
    handOver(w, owned, slot);
    if (!w.count) unloadWorld(s.v);
  };

  // ------------------------------------------------------------------------------------------------ sending
  const flushOne = (s) => {
    pending.delete(s);
    const out = s.out; s.out = [];
    if (s.peer.closed || !out.length) return;
    if (s.overflow) { s.peer.why = 'not reading (backlog)'; s.peer.close(); return; }
    let batch = [], size = 0;
    for (const r of out) {
      if (size + r.length > MMO_LIMITS.outMessage && batch.length) { s.peer.send(Buffer.concat(batch, size)); batch = []; size = 0; }
      batch.push(r); size += r.length;
    }
    s.peer.send(batch.length === 1 ? batch[0] : Buffer.concat(batch, size));
  };
  const flushAll = () => { flushScheduled = false; for (const s of [...pending]) flushOne(s); };
  /** A record for `s`, sent with the others of this event-loop turn in one message; realtime ones dropped while it lags. */
  const queue = (s, rec, realtime = false) => {
    if (!s.peer || s.peer.closed) return;
    const backlog = s.peer.socket.writableLength ?? 0;
    if (backlog > MMO_LIMITS.backlogClose) s.overflow = true;
    else if (realtime && backlog > MMO_LIMITS.backlog) return;
    s.out.push(rec); pending.add(s);
    if (!flushScheduled) { flushScheduled = true; setImmediate(flushAll); }
  };
  const toWorld = (w, rec, except = null, realtime = false) => { for (const p of w.slots) if (p && p !== except) queue(p, rec, realtime); };
  /** REFUSED, then the socket closed (what was queued for it sent first). */
  const refuse = (s, reason, detail) => {
    if (s.peer.closed) return;
    flushOne(s);
    s.peer.send(record(S.REFUSED, NOBODY, new Out().u8(reason).str8(detail).done()));
    s.peer.why = `refused ${reason} (${detail})`;
    s.peer.close();
  };
  /** DENIED; a rate limit's (and a realtime record's) at most once a second per type. */
  const deny = (s, type, reason) => {
    if (reason === D.RATE || isRealtime(type)) {
      const t = now(), last = s.deniedAt.get(type);
      if (last !== undefined && t - last < 1000 && t >= last) return;
      s.deniedAt.set(type, t);
    }
    queue(s, record(S.DENIED, NOBODY, Buffer.from([type, reason])));
  };

  /**
   * What a record broadcast from `s` costs the others, taken from its bytes a second (a small record of its own that the
   * server sends big to every player — a record's data — is paid as such); false: not enough left (nothing taken).
   */
  const charge = (s, bytes) => take(s.rate.bytes, bytes, now());

  // ------------------------------------------------------------------------------------------------ lobby
  const mine = (s) => s.v.chars.filter((c) => c.user === s.user.id);
  const sendLobby = (s) => {
    const list = mine(s), cfg = settingsOf(s.v.id) ?? s.cfg;
    const out = new Out().u8(isAdmin(s.user) ? 1 : 0).u8(cfg.maxCharacters).str8(s.user.username).u8(list.length);
    for (const c of list) out.u32(c.id).str8(c.name).str8(c.skin).i32(c.money).u8(c.session ? 1 : 0);
    queue(s, record(S.LOBBY, NOBODY, out.done()));
  };
  const result = (s, op, status, id) => queue(s, record(S.CHAR_RESULT, NOBODY, new Out().u8(op).u8(status).u32(id).done()));
  const join = (s, id) => {
    const c = mine(s).find((x) => x.id === id);
    if (!c) return result(s, 5, CR.NOT_FOUND, id);
    const cfg = settingsOf(s.v.id);
    if (!cfg) return refuse(s, R.NO_WORLD, 'no shared world for this version');
    if (s.world) depart(s, 'joined again');
    if (c.session) refuse(c.session, R.ELSEWHERE, 'this character joined from another connection');
    const v = s.v;
    let w = v.world;
    if (!w) { try { w = loadWorld(v, cfg); } catch (e) { log(`mmo: ${v.id}: world not loaded: ${e.message}`); return result(s, 5, CR.ERROR, id); } }
    const slot = w.slots.indexOf(null), tag = slot < 0 ? 0 : freeTag(v, w);
    if (slot < 0 || !tag) { if (!w.count) unloadWorld(v); return result(s, 5, slot < 0 ? CR.WORLD_FULL : CR.ERROR, id); }
    Object.assign(s, { world: w, slot, tag, rank: v.nextRank++, char: c, skin: c.skin, admin: isAdmin(s.user), pos: null });
    w.slots[slot] = s; w.count++; w.tags.set(tag, s); c.session = s;
    const out = new Out().u8(slot).u16(tag).f64(now()).u8(s.admin ? 1 : 0).u32(c.id).str8(c.name).str8(c.skin).u16(c.state.length).bytes(c.state);
    worldBody(w, out);
    const players = w.slots.filter(Boolean);
    out.u8(players.length);
    for (const p of players) playerInfo(p, out);
    queue(s, record(S.WELCOME, NOBODY, out.done()));
    for (const [key, r] of [...w.records].sort((a, b) => a[0] - b[0])) if (r.data.length || r.holder !== NOBODY) queue(s, recordOf(key, r));
    for (const line of v.chat) queue(s, chatRecord(line, NOBODY));
    for (const [netid, e] of w.owners) if (e.owner !== NOBODY) queue(s, ownerRecord(netid, e.owner, e.owner));
    toWorld(w, record(S.PLAYER_JOIN, NOBODY, playerInfo(s).done()), s);
    // (the locks its character held when it went: its again, everyone told)
    for (const [key, k] of [...v.kept]) {
      if (k.char !== c.id) continue;
      v.kept.delete(key);
      const r = w.records.get(key) ?? { data: EMPTY, holder: NOBODY, by: 0 };
      if (r.holder !== NOBODY) continue;
      w.records.set(key, r); r.holder = slot;
      toWorld(w, recordOf(key, r, slot), s);
      queue(s, recordOf(key, r, slot));
    }
    log(`mmo: ${v.id}: ${s.user.username} joined as ${c.name} (slot ${slot}, ${w.count} in the world)`);
  };

  // ------------------------------------------------------------------------------------------------ records
  const handleRecord = (s, type, body) => {
    const r = new In(body), w = s.world;
    if (!s.hello && type !== C.HELLO && type !== C.PING && type !== C.AWAY) { if (type <= C.PLAYER_INFO || isRealtime(type)) deny(s, type, D.INVALID); return; }
    if (LOBBY_TYPES.has(type) && !take(s.rate.lobby, 1, now())) return deny(s, type, D.RATE);
    if (LOCK_TYPES.has(type) && !take(s.rate.locks, 1, now())) return deny(s, type, D.RATE);
    switch (type) {
      case C.HELLO: {
        const protocol = r.u16();
        if (protocol !== MMO_PROTOCOL) return refuse(s, R.PROTOCOL, `protocol ${protocol}: this server speaks ${MMO_PROTOCOL}`);
        s.lang = r.left() ? r.u8() : 0; s.hello = true;
        return sendLobby(s);
      }
      case C.CHAR_CREATE: {
        const name = r.str8().toString('latin1'), skin = r.str8().toString('latin1'), list = mine(s), cfg = settingsOf(s.v.id) ?? s.cfg;
        const status = !MMO_NAME.test(name) ? CR.INVALID_NAME : !MMO_SKIN.test(skin) ? CR.INVALID_SKIN : list.length >= cfg.maxCharacters ? CR.TOO_MANY
          : s.v.chars.some((c) => mmoNameKey(c.name) === mmoNameKey(name)) ? CR.NAME_TAKEN : s.v.nextId > 0xffffffff ? CR.ERROR : CR.OK;
        let id = 0;
        if (status === CR.OK) {
          id = s.v.nextId++;
          s.v.chars.push({ id, user: s.user.id, name, skin, money: 0, state: EMPTY, createdAt: now(), updatedAt: now(), session: null });
          charsChanged(s.v);
          log(`mmo: ${s.v.id}: ${s.user.username} created ${name}`);
        }
        result(s, 2, status, id);
        return sendLobby(s);
      }
      case C.CHAR_SKIN: {
        const id = r.u32(), skin = r.str8().toString('latin1'), c = mine(s).find((x) => x.id === id);
        const status = !c ? CR.NOT_FOUND : !MMO_SKIN.test(skin) ? CR.INVALID_SKIN : CR.OK;
        if (status === CR.OK) {
          c.skin = skin; c.updatedAt = now(); charsChanged(s.v);
          const p = c.session;
          if (p) { p.skin = skin; toWorld(p.world, record(S.PLAYER_INFO, p.slot, new Out().u8(p.slot).str8(skin).done()), p); }
        }
        result(s, 3, status, id);
        return sendLobby(s);
      }
      case C.CHAR_DELETE: {
        const id = r.u32(), c = mine(s).find((x) => x.id === id);
        const status = !c ? CR.NOT_FOUND : c.session ? CR.ERROR : CR.OK;
        if (status === CR.OK) { s.v.chars.splice(s.v.chars.indexOf(c), 1); charsChanged(s.v); log(`mmo: ${s.v.id}: ${s.user.username} deleted ${c.name}`); }
        result(s, 4, status, id);
        return sendLobby(s);
      }
      case C.JOIN: return join(s, r.u32());
      case C.LEAVE: {
        depart(s, 'left', false);
        queue(s, record(S.LEFT, NOBODY));
        return sendLobby(s);
      }
      case C.PING: return queue(s, record(S.PONG, NOBODY, new Out().f64(r.f64()).f64(now()).done()));
      case C.AWAY: {
        const source = r.u8(), away = r.u8();
        if (source > 7 || away > 1) return deny(s, type, D.INVALID);
        const was = s.awayBits !== 0;
        s.awayBits = away ? s.awayBits | (1 << source) : s.awayBits & ~(1 << source);
        const is = s.awayBits !== 0;
        if (!w || was === is) return;
        toWorld(w, record(S.PLAYER_AWAY, NOBODY, Buffer.from([s.slot, is ? 1 : 0])), s);
        // (its entities to the others; its locks stay its own: what it took out under them is still in its game)
        if (is) handOver(w, ownedBy(w, s.slot, s.tag), s.slot);
        return;
      }
    }
    // (in a world from here on)
    if (!w) { if (type <= C.PLAYER_INFO) deny(s, type, D.INVALID); return; }
    switch (type) {
      case C.CHAR_SAVE: {
        const money = r.i32(), n = r.u16();
        if (n > MMO_LIMITS.state) return deny(s, type, D.INVALID);
        const state = Buffer.from(r.take(n));
        Object.assign(s.char, { money, state, updatedAt: now() });
        return charsChanged(s.v);
      }
      case C.CHAT: {
        const text = r.str8();
        if (!chatOk(text)) return deny(s, type, D.INVALID);
        if (!take(s.rate.chat, 1, now())) return deny(s, type, D.RATE);
        const line = { kind: 0, name: s.char.name, text: Buffer.from(text) };
        s.v.chat.push(line); if (s.v.chat.length > MMO_LIMITS.chatLines) s.v.chat.shift();
        return toWorld(w, chatRecord(line, s.slot));
      }
      case C.WORLD_SET: {
        if (!isAdmin(s.user)) return deny(s, type, D.NOT_ADMIN);
        const op = r.u8(), t = now();
        if (op === 1) {
          const id = r.u8(), value = r.i32();
          if (!w.vars.has(id) && w.vars.size >= 255) return deny(s, type, D.INVALID);
          w.vars.set(id, value);
        } else if (op === 2) {
          const minute = r.u16();
          if (minute > 1439) return deny(s, type, D.INVALID);
          w.baseMinutes = Math.floor(minutesAt(w, t) / 1440) * 1440 + minute; w.baseMs = t;
        } else if (op === 3) {
          const ms = r.f32();
          if (!(ms >= 30 && ms <= 60000)) return deny(s, type, D.INVALID);
          w.baseMinutes = minutesAt(w, t); w.baseMs = t; w.msPerMinute = Math.fround(ms);
        } else return deny(s, type, D.INVALID);
        worldChanged(s.v);
        return toWorld(w, record(S.WORLD, s.slot, worldBody(w).done()));
      }
      case C.WORLD_EVENT: {
        if (!isAdmin(s.user)) return deny(s, type, D.NOT_ADMIN);
        const id = r.u8(), arg = r.i32();
        return toWorld(w, record(S.WORLD_EVENT, s.slot, new Out().u8(id).i32(arg).done()));
      }
      case C.LOCK: {
        const key = r.u16(), cfg = w.cfg;
        let rec = w.records.get(key);
        if (rec && rec.holder !== NOBODY && rec.holder !== s.slot) return queue(s, recordOf(key, rec));
        // (a key the version does not use, a lock kept for a departed holder's character, too many held: denied)
        if (!keyAllowed(cfg, key) || keptFromOthers(s, key)) return deny(s, type, D.INVALID);
        if (rec?.holder !== s.slot) {
          let held = 0;
          for (const x of w.records.values()) if (x.holder === s.slot) held++;
          if (held >= MMO_LIMITS.locksPerSlot || (!rec && w.records.size >= MMO_LIMITS.recordKeys)) return deny(s, type, D.INVALID);
        }
        const out = recordOf(key, rec ?? { data: EMPTY, holder: s.slot }, s.slot);
        if (!charge(s, out.length * w.count)) return deny(s, type, D.RATE);
        if (!rec) { rec = { data: EMPTY, holder: NOBODY, by: 0 }; w.records.set(key, rec); }
        s.v.kept.delete(key);
        rec.holder = s.slot;
        return toWorld(w, recordOf(key, rec, s.slot));
      }
      case C.STORE: {
        const key = r.u16(), n = r.u16();
        if (n > MMO_LIMITS.state) return deny(s, type, D.INVALID);
        const data = Buffer.from(r.take(n)), rec = w.records.get(key);
        if (!rec || rec.holder !== s.slot) return deny(s, type, D.INVALID);
        // (the world's records together, and those each character stored, within their limits)
        let mineKeys = n ? 1 : 0, mineBytes = n;
        for (const [k, x] of w.records) if (k !== key && x.by === s.char.id && x.data.length) { mineKeys++; mineBytes += x.data.length; }
        if (w.recordBytes - rec.data.length + n > MMO_LIMITS.recordBytes || mineKeys > MMO_LIMITS.recordsPerChar || mineBytes > MMO_LIMITS.recordBytesPerChar)
          return deny(s, type, D.INVALID);
        if (!charge(s, (9 + n) * w.count)) return deny(s, type, D.RATE);
        w.recordBytes += n - rec.data.length;
        rec.data = data; rec.holder = NOBODY; rec.by = n ? s.char.id : 0;
        worldChanged(s.v);
        toWorld(w, recordOf(key, rec, s.slot));
        return forgetEmpty(w, key, rec);
      }
      case C.UNLOCK: {
        const key = r.u16(), rec = w.records.get(key);
        if (!rec || rec.holder !== s.slot) return deny(s, type, D.INVALID);
        const out = recordOf(key, { data: rec.data, holder: NOBODY }, s.slot);
        if (!charge(s, out.length * w.count)) return deny(s, type, D.RATE);
        rec.holder = NOBODY;
        toWorld(w, out);
        return forgetEmpty(w, key, rec);
      }
      case C.OWN: {
        const netid = r.u32(), op = r.u8(), to = r.left() ? r.u8() : NOBODY;
        if (op !== 1 && op !== 2) return deny(s, type, D.INVALID);
        const cur = ownerOf(w, netid), unchanged = () => queue(s, ownerRecord(netid, cur, cur, s.slot));
        if (netid >= PLAYER_IDS || netid >>> 20 === 0) return unchanged();
        if (op === 1) {
          const st = w.states.get(netid), holder = cur !== NOBODY ? w.slots[cur] : null;
          // (an entity driven by its owner's player stays its owner's while that player is there and not away)
          if (cur === s.slot || (st && st.flags & 1 && holder && holder !== s && !holder.awayBits)) return unchanged();
          if (!w.owners.has(netid) && w.owners.size >= MMO_LIMITS.owners) return unchanged();
          setOwner(w, netid, s.slot);
          return toWorld(w, ownerRecord(netid, s.slot, cur, s.slot));
        }
        if (cur !== s.slot || to === s.slot || to >= w.slots.length || !w.slots[to]) return unchanged();
        if (!w.owners.has(netid) && w.owners.size >= MMO_LIMITS.owners) return unchanged();
        setOwner(w, netid, to);
        return toWorld(w, ownerRecord(netid, to, s.slot, s.slot));
      }
      case C.PLAYER_INFO: {
        const skin = r.str8().toString('latin1');
        if (!MMO_SKIN.test(skin)) return deny(s, type, D.INVALID);
        s.skin = skin; s.char.skin = skin; s.char.updatedAt = now(); charsChanged(s.v);
        return toWorld(w, record(S.PLAYER_INFO, s.slot, new Out().u8(s.slot).str8(skin).done()), s);
      }
      case C.PLAYER_STATE: {
        if (body.length < 12 || body.length > MMO_LIMITS.playerState) return deny(s, type, D.INVALID);
        s.pos = { x: body.readFloatLE(0), y: body.readFloatLE(4), z: body.readFloatLE(8) };
        return toWorld(w, record(type, s.slot, body), s, true);
      }
      case C.ENTITY_STATE: {
        if (body.length < 18 || body.length > MMO_LIMITS.entityState) return deny(s, type, D.INVALID);
        const netid = body.readUInt32LE(0);
        if (netid >= PLAYER_IDS || ownerOf(w, netid) !== s.slot) return; // (not its own — or no longer: dropped)
        const t = now(), st = w.states.get(netid), e = w.owners.get(netid);
        if (st || w.states.size < MMO_LIMITS.owners) w.states.set(netid, { flags: body[5], x: body.readFloatLE(6), y: body.readFloatLE(10), z: body.readFloatLE(14), at: t });
        if (e) e.at = t;
        return toWorld(w, record(type, s.slot, body), s, true);
      }
      case C.ENTITY_GONE: {
        if (body.length < 5 || body.length > MMO_LIMITS.entityGone) return deny(s, type, D.INVALID);
        const netid = body.readUInt32LE(0);
        if (netid >= PLAYER_IDS || ownerOf(w, netid) !== s.slot) return;
        w.owners.delete(netid); w.states.delete(netid);
        return toWorld(w, record(type, s.slot, body), s, true);
      }
      case C.EVENT: {
        if (body.length < 1 || body.length > MMO_LIMITS.event) return deny(s, type, D.INVALID);
        return toWorld(w, record(type, s.slot, body), s, true);
      }
      case C.TARGETED: {
        if (body.length < 5 || body.length > MMO_LIMITS.targeted) return deny(s, type, D.INVALID);
        const owner = ownerOf(w, body.readUInt32LE(0));
        if (owner !== NOBODY) queue(w.slots[owner], record(type, s.slot, body), true);
        return;
      }
    }
    // (unknown types: ignored)
  };

  const onMessage = (s, msg, text) => {
    if (closed || !s.user || s.peer.closed) return;
    s.lastIn = now();
    if (text) return;
    s.lastRecord = s.lastIn;
    try {
      for (let o = 0; o < msg.length;) {
        if (o + 3 > msg.length) return refuse(s, R.PROTOCOL, 'truncated record');
        const len = msg.readUInt16LE(o);
        if (len < 1 || o + 2 + len > msg.length) return refuse(s, R.PROTOCOL, 'truncated record');
        const type = msg[o + 2], body = msg.subarray(o + 3, o + 2 + len), t = now();
        o += 2 + len;
        if (!take(s.rate.records, 1, t) || !take(s.rate.bytes, 2 + len, t)) { deny(s, type, D.RATE); continue; }
        try { handleRecord(s, type, body); } catch (e) { if (e !== SHORT) throw e; deny(s, type, D.INVALID); }
        if (s.peer.closed) return;
      }
    } catch (e) {
      log(`mmo: ${s.versionId}: ${e.stack ?? e}`);
      refuse(s, R.ERROR, 'server error');
    }
  };
  const onClose = (s) => {
    sessions.delete(s); pending.delete(s); s.out = [];
    s.v?.sockets.delete(s);
    try { if (s.world) depart(s, s.peer?.why ?? 'connection closed'); } catch (e) { log(`mmo: ${s.versionId}: ${e.stack ?? e}`); }
  };

  const upgrade = (req, socket, url) => {
    const m = /^\/api\/mmo\/([^/]+)\/ws$/.exec(url.pathname);
    if (!m) return false;
    let sameOrigin = false; try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { /* no Origin: refused */ }
    // (a page of another site — a sibling subdomain sends the cookie too — never gets a socket)
    if (!sameOrigin || closed) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy()); return true; }
    let versionId = ''; try { versionId = decodeURIComponent(m[1]); } catch { /* refused below */ }
    const t = now();
    const s = { peer: null, req, versionId, v: null, user: null, cfg: null, hello: false, lang: 0, lastIn: t, checkedAt: t,
      world: null, slot: NOBODY, tag: 0, rank: 0, char: null, skin: '', admin: false, awayBits: 0, pos: null,
      out: [], overflow: false, deniedAt: new Map(),
      rate: { records: bucket(MMO_LIMITS.recordsPerSec, MMO_LIMITS.recordsPerSec * 2, t), bytes: bucket(MMO_LIMITS.bytesPerSec, MMO_LIMITS.bytesPerSec * 2, t),
        lobby: bucket(MMO_LIMITS.lobbyPerSec, MMO_LIMITS.lobbyPerSec, t), chat: bucket(MMO_LIMITS.chatPerSec, MMO_LIMITS.chatBurst, t),
        locks: bucket(MMO_LIMITS.locksPerSec, MMO_LIMITS.locksBurst, t) },
      openedAt: t, lastRecord: t, pingAt: t };
    // (a pong is a sign of life: a hidden tab's timers may wait a minute between its PINGs, its browser answers at once)
    s.peer = acceptWebSocket(req, socket, (msg, text) => onMessage(s, msg, text), () => onClose(s), log, { maxMessage: MMO_LIMITS.frame, onPong: () => { s.lastIn = now(); } });
    if (!s.peer) return true;
    sessions.add(s);
    try {
      const cfg = enabled ? settingsOf(versionId) : null, user = cfg ? identify(req) : undefined;
      if (!cfg || user === undefined) { refuse(s, R.NO_WORLD, 'no shared world for this version'); return true; }
      if (!user) { refuse(s, R.SIGN_IN, 'sign-in needed'); return true; }
      const v = versionOf(versionId);
      // (an account's connections: 4 at most, 2 of them outside the world; the oldest goes)
      const own = [...v.sockets].filter((x) => x.user.id === user.id), ownLobby = own.filter((x) => !x.world);
      if (ownLobby.length >= MMO_LIMITS.lobbySocketsPerUser) refuse(ownLobby[0], R.ELSEWHERE, 'connected again elsewhere');
      else if (own.length >= MMO_LIMITS.socketsPerUser) refuse(own[0], R.ELSEWHERE, 'connected again elsewhere');
      // (the version's: at the limit, the connection outside the world idle the longest makes room — never one in it)
      if (v.sockets.size >= cfg.maxPlayers * MMO_LIMITS.socketsPerPlayer) {
        let idle = null;
        for (const x of v.sockets) if (!x.world && (!idle || x.lastRecord < idle.lastRecord)) idle = x;
        if (!idle) { refuse(s, R.FULL, 'too many connections to this world'); return true; }
        refuse(idle, R.FULL, 'too many connections to this world: the idlest closed');
      }
      Object.assign(s, { v, user, cfg });
      v.sockets.add(s);
    } catch (e) { log(`mmo: ${versionId}: ${e.stack ?? e}`); refuse(s, R.ERROR, 'server error'); }
    return true;
  };

  const handle = (req, res, url) => {
    const p = url.pathname;
    if (p !== '/api/mmo' && !p.startsWith('/api/mmo/')) return false;
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body)); };
    try {
      const m = /^\/api\/mmo\/([^/]+)$/.exec(p);
      if (!m) { send(/^\/api\/mmo\/[^/]+\/ws$/.test(p) ? 426 : 404, { error: /\/ws$/.test(p) ? 'websocket' : 'none' }); return true; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, { error: 'method' }); return true; }
      let id = ''; try { id = decodeURIComponent(m[1]); } catch { /* unknown */ }
      const known = VERSION_ID.test(id) && !!getManifest(id), cfg = enabled && known ? settingsOf(id) : null;
      const user = cfg ? identify(req) : undefined;
      send(known ? 200 : 404, { enabled: !!cfg && user !== undefined, signedIn: !!user, admin: !!user && isAdmin(user), players: versions.get(id)?.world?.count ?? 0, maxPlayers: cfg?.maxPlayers ?? 0 });
    } catch (e) { log(`mmo: ${e.stack ?? e}`); if (!res.headersSent) send(500, { error: 'server' }); else res.destroy(); }
    return true;
  };

  const sweep = () => {
    const t = now();
    for (const s of [...sessions]) {
      if (s.peer.closed) continue;
      if (t - s.lastIn > MMO_LIMITS.silenceMs) { s.peer.why = 'silent'; s.peer.close(); continue; }
      // (the protocol opens with HELLO: a socket that never says it is closed — its page connects again if it wants)
      if (s.user && !s.hello && t - s.openedAt > MMO_LIMITS.helloMs) { s.peer.why = 'no HELLO'; s.peer.close(); continue; }
      if (t - s.pingAt >= MMO_LIMITS.pingMs) { s.pingAt = t; s.peer.ping(); }
      if (s.user && t - s.checkedAt >= MMO_LIMITS.recheckMs) {
        s.checkedAt = t;
        let user = null; try { user = identify(s.req); } catch (e) { log(`mmo: session check: ${e.message}`); continue; }
        if (!user || user.id !== s.user.id) refuse(s, R.SIGN_IN, 'signed out');
      }
    }
    for (const v of versions.values()) {
      const w = v.world; if (!w) continue;
      for (const [id, st] of w.states) if (t - st.at > MMO_LIMITS.ownerIdleMs) w.states.delete(id);
      for (const [id, e] of [...w.owners]) {
        if (t - e.at <= MMO_LIMITS.ownerIdleMs) continue;
        if (e.owner === NOBODY) { w.owners.delete(id); continue; }
        // (an entity given to a present player that has said nothing of it for a minute — gone from its game unannounced,
        // or out of everyone's sight —: orphaned, everyone told; its owner renews it if it still has it)
        if (w.states.has(id)) continue;
        setOwner(w, id, NOBODY);
        toWorld(w, ownerRecord(id, NOBODY, e.owner));
      }
      if (!w.ownersWarned && w.owners.size > MMO_LIMITS.owners * 0.9) { w.ownersWarned = true; log(`mmo: ${v.id}: ${w.owners.size} ownership entries (limit ${MMO_LIMITS.owners})`); }
    }
    for (const v of versions.values()) {
      for (const [key, k] of [...v.kept]) {
        if (t <= k.until) continue;
        v.kept.delete(key);
        const r = v.world?.records.get(key);
        if (r) forgetEmpty(v.world, key, r);
      }
    }
  };
  const sweepTimer = setInterval(() => { try { sweep(); } catch (e) { log(`mmo: sweep: ${e.stack ?? e}`); } }, MMO_LIMITS.sweepMs);
  sweepTimer.unref?.();

  const flush = () => { if (enabled) for (const v of versions.values()) save(v, true); };
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(sweepTimer);
    // (a page that stops reading never acknowledges the close: its socket destroyed after a second)
    for (const s of [...sessions]) { const socket = s.peer.socket; s.peer.why = 'server closing'; s.peer.close(); setTimeout(() => socket.destroy(), 1000).unref?.(); }
    flush();
    for (const v of versions.values()) if (v.timer) { clearTimeout(v.timer); v.timer = null; }
  };
  return { handle, upgrade, flush, close, sweep };
}
