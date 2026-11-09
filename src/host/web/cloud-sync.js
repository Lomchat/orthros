// A game's saves kept on the player's Orthros account, the same way for every runtime (Windows games, browser ports):
// the profile (the files the game wrote: saves, settings) restored from the account before the game starts, sent
// after it changed, while the game runs and when it ends. The page says where its files are (`read`, `write`); the
// account API (src/host/accounts.js) keeps the versions, 20 per game, and refuses an upload made from a version that
// is not its latest (another device sent one meanwhile): nothing is overwritten without the player's choice.
//
// What this browser knows of the account's copy, per account and game (localStorage orthros.sync.<user>.<game>):
//   parent — the hash of the account's version this profile was last in step with,
//   local  — the hash of the profile's content then.
// A profile whose content hash is still `local` has nothing new; an account whose latest hash is still `parent` has
// nothing new either. Both new: a conflict, settled by the player.
//
// A profile shared by a game's versions (`shared`, docs/profiles.md): its key is the game's (profile-share.js), its
// copies kept per version before — in this browser and on the account — merged into it once on each side (the
// browser: profile-share.js migrateProfile, before this sync; the account: accounts.js migrateProfiles, at the server's
// start). Their first sync under the shared key (no record of it marked `shared` yet) must neither ask the player nor
// lose a file. So:
//   - every per-version copy this browser merged was in step with the account (its content hash the one its record
//     kept), the account merged that same version's copy (the list's `merged`), and the profile has not changed since
//     the merge: the account's merged copy is this profile's newer state — it is put in place (the previous one kept
//     aside, as any restore);
//   - else (a copy never sent, played since, or the account's merge missing): the two are merged here, by the same rule
//     (profile-merge.js), and the result sent over the account's latest — its parent the account's head, no conflict;
//   - another account's copies among them: the account's own put in place, as for any profile of another account.
import { mergeProfiles } from '../../vfs/profile-merge.js';

const FORMAT = 'orthros-profile';
export const MAX_BACKUP = 64 * 1024 * 1024;

/**
 * What to do before the game starts, from what is known (null: never in step on this device), the account's latest
 * hash (null: no copy on the account), whether the profile is empty and whether its content is the one last in step.
 * @returns {'none'|'same'|'push'|'restore'|'compare'|'conflict'}
 *   compare: no record on this device, a profile and a copy on the account — the same content or a conflict, known
 *   once the copy is downloaded (sameContent()).
 */
export function decide({ known, remoteHash, localEmpty, localUnchanged }) {
  if (!remoteHash) return localEmpty ? 'none' : 'push';
  if (known && remoteHash === known.parent) return localUnchanged ? 'same' : 'push';
  if (localEmpty) return 'restore';
  if (!known) return 'compare';
  return localUnchanged ? 'restore' : 'conflict';
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
const validPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.startsWith('/') && !p.includes('\\') && !/[\x00-\x1f]/.test(p) && p.split('/').every((x) => x && x !== '.' && x !== '..');

/**
 * The profile's files as the account keeps them: the JSON's bytes. `files`: [{ path ('/'-separated, relative), data:
 * Uint8Array, mtime? (ms) }]; sorted by path, so the same content is the same bytes. Each file's date goes with it when
 * known (`mtime`: false leaves them out — contentHash): a later merge of copies (profile-merge.js) takes the newest.
 */
export function encodeProfile(game, files, { mtime = true } = {}) {
  const list = files.filter((f) => validPath(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const json = JSON.stringify({ format: FORMAT, version: 1, game, files: list.map((f) => ({ path: f.path, data: toBase64(f.data), ...(mtime && Number.isFinite(f.mtime) ? { mtime: f.mtime } : {}) })) });
  return new TextEncoder().encode(json);
}
/**
 * A profile's content hash: its paths and bytes, not the files' dates (the same content read again is the same — and
 * the hash records kept before the dates were sent stay valid).
 */
export const contentHash = (game, files) => sha256(encodeProfile(game, files, { mtime: false }));
/** The files of an account's copy (gzip bytes), checked: [{ path, data: Uint8Array, mtime? }] and the raw JSON's bytes. */
export async function decodeProfile(game, gz) {
  const raw = await pipe(gz, new DecompressionStream('gzip'));
  const doc = JSON.parse(new TextDecoder().decode(raw));
  if (doc?.format !== FORMAT || doc.version !== 1 || doc.game !== game || !Array.isArray(doc.files)) throw new Error('not a save of this game');
  for (const f of doc.files) if (!validPath(f.path) || typeof f.data !== 'string') throw new Error('invalid save path');
  return { raw, files: doc.files.map((f) => ({ path: f.path, data: fromBase64(f.data), ...(Number.isFinite(f.mtime) ? { mtime: f.mtime } : {}) })) };
}

/**
 * A game's saves on the account of `user` (null: not signed in — nothing leaves the browser), under `game`: the
 * version's profile key (profile-share.js profileKeyOf). `read()`: the profile's files now; `write(files)`: the profile
 * replaced by these (the page keeps the previous one aside when it can). `onStatus(status)`: { state, ...} — off (not
 * signed in), idle, saving, saved ({ at, version }), error ({ message }), conflict ({ remote }), toobig.
 * `shared`: a profile shared by a game's versions (profile-share.js sharesProfile) — { marker: () => this browser's
 * merge of its per-version copies (profile-share.js mergedMarker), settings: the manifest's profileSettings }.
 */
export class CloudSave {
  constructor({ game, user, read, write, shared = null, onStatus = () => {}, fetchImpl = (...a) => fetch(...a), storage = globalThis.localStorage }) {
    Object.assign(this, { game, user, read, write, shared, onStatus, fetchImpl, storage });
    this.status = { state: user ? 'idle' : 'off' };
    this.remote = null; // (the account's latest: { hash, version, at })
    this.remoteRow = null; // (the account's list's row of the game: { hash, version, updatedAt, merged? })
    this.busy = null; this.again = false;
  }
  get key() { return `orthros.sync.${this.user}.${this.game}`; }
  /** This browser's record of key `game` (another one: a version's own, before its profile was shared). */
  record(game = this.game) { try { return JSON.parse(this.storage.getItem(`orthros.sync.${this.user}.${game}`)); } catch { return null; } }
  get known() { return this.record(); }
  set known(v) { try { this.storage.setItem(this.key, JSON.stringify(this.shared ? { ...v, shared: true } : v)); this.storage.setItem(`orthros.owner.${this.game}`, this.user); } catch { /* storage off */ } }
  /** Which account this browser's profile of the game (or of key `game`) was last in step with (null: none). */
  owner(game = this.game) { try { return this.storage.getItem(`orthros.owner.${game}`); } catch { return null; } }
  set(status) { this.status = status; try { this.onStatus(status); } catch (e) { console.error(e); } }
  url(tail = '') { return `/api/cloud/${encodeURIComponent(this.game)}${tail}`; }

  /**
   * The account's latest copy's hash, from the account's list (a few hundred bytes: on a slow link, the copy itself is
   * downloaded only when it is needed); null when there is none.
   */
  async remoteHead() {
    const r = await this.fetchImpl('/api/cloud', { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 401) throw Object.assign(new Error('signed out'), { status: 401 });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    this.remoteRow = (await r.json()).games?.find((g) => g.game === this.game) ?? null;
    return this.remoteRow?.hash ?? null;
  }
  /** The account's latest copy: its gzip bytes and hash, or null when there is none. */
  async fetchRemote() {
    const r = await this.fetchImpl(this.url(), { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 404) { this.remote = null; return null; }
    if (r.status === 401) throw Object.assign(new Error('signed out'), { status: 401 });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    const bytes = new Uint8Array(await r.arrayBuffer()), hash = r.headers.get('X-Orthros-Backup-Hash') ?? await sha256(bytes);
    return { bytes, hash };
  }

  /**
   * Before the game starts: the account's copy put in place when it is newer, the profile sent when it is, a conflict
   * told (resolve(): the player's choice). Resolves to the decision taken ('none', 'same', 'push', 'restore',
   * 'conflict'); a network failure leaves the profile as it is ('offline').
   */
  async pull() {
    if (!this.user) return 'none';
    let head, remote = null, files;
    try {
      [head, files] = await Promise.all([this.remoteHead(), this.read()]);
    } catch (e) {
      if (e.status === 401) { this.user = null; this.set({ state: 'off' }); return 'none'; }
      this.set({ state: 'error', message: e.message }); return 'offline';
    }
    const localHash = await contentHash(this.game, files), known = this.known, owner = this.owner();
    // (a profile last in step with another account: not this player's — kept aside, the account's own put in place)
    const foreign = !!owner && owner !== this.user && files.length > 0;
    const first = !foreign && !!this.shared && !known?.shared;
    let what = foreign ? (head ? 'restore' : 'reset')
      : first ? this.firstShared(head, files.length, localHash)
        : decide({ known, remoteHash: head, localEmpty: files.length === 0, localUnchanged: known?.local === localHash });
    if (['restore', 'compare', 'conflict', 'merge'].includes(what)) {
      try { remote = await this.fetchRemote(); } catch (e) { this.set({ state: 'error', message: e.message }); return 'offline'; }
      if (!remote) what = files.length ? 'push' : 'none'; // (gone meanwhile)
    } else if (head) remote = { hash: head };
    let decoded = null;
    if (what === 'compare') {
      decoded = await decodeProfile(this.game, remote.bytes).catch(() => null);
      what = decoded && await contentHash(this.game, decoded.files) === localHash ? 'same' : 'conflict';
    }
    this.remoteHash = remote?.hash ?? null;
    if (what === 'same') { this.known = { parent: remote.hash, local: localHash }; this.set({ state: 'saved', at: Date.now() }); }
    else if (what === 'restore') { await this.applyRemote(remote, decoded); }
    else if (what === 'merge') { await this.mergeRemote(files, localHash, remote); }
    else if (what === 'reset') { await this.write([]); this.known = { parent: 'none', local: await contentHash(this.game, []) }; this.set({ state: 'idle' }); }
    // (a shared profile's first copy on the account: sent as such, whatever a version's record said before)
    else if (what === 'push') { await this.push(first ? { force: true } : undefined); }
    else if (what === 'conflict') { this.conflict = remote; this.set({ state: 'conflict' }); }
    else this.set({ state: 'idle' });
    return what;
  }
  /**
   * The first sync of a shared profile (see the head of this file): 'restore' (the account's merged copy is this
   * profile's newer state), 'merge' (both merged here, then sent), 'push' / 'none' (no copy on the account), 'reset'.
   */
  firstShared(head, count, localHash) {
    const marker = this.shared.marker?.() ?? null, sources = (marker?.sources ?? []).filter((s) => s.files > 0);
    // (a copy last in step with another account: not this player's)
    if (sources.some((s) => { const o = this.owner(s.name); return !!o && o !== this.user; })) return head ? 'restore' : 'reset';
    if (!head) return count ? 'push' : 'none';
    if (!count) return 'restore';
    // (the key's own copy — a key that is also a version's name — is the account's history under it: merged or not)
    const merged = this.remoteRow?.merged ?? [];
    const inStep = !!marker && marker.merged === localHash && sources.every((s) => this.record(s.name)?.local === s.hash && (s.name === this.game || merged.includes(s.name)));
    if (!inStep) return 'merge';
    return this.record()?.parent === head ? 'same' : 'restore';
  }
  /** This profile and the account's copy merged here (profile-merge.js), put in place, and sent over the account's head. */
  async mergeRemote(files, localHash, remote) {
    const doc = await decodeProfile(this.game, remote.bytes);
    const merged = mergeProfiles([{ label: 'local', at: Date.now(), files }, { label: 'account', at: this.remoteRow?.updatedAt ?? 0, files: doc.files }], { settings: this.shared?.settings }).files;
    const mergedHash = await contentHash(this.game, merged);
    if (mergedHash !== localHash) await this.write(merged);
    this.remoteHash = remote.hash;
    // (nothing here the account lacks: in step with it; else sent over its head)
    if (mergedHash === await contentHash(this.game, doc.files)) { this.known = { parent: remote.hash, local: mergedHash }; this.set({ state: 'saved', at: Date.now() }); return; }
    this.known = { parent: remote.hash, local: localHash };
    await this.push();
  }
  async applyRemote(remote, decoded = null) {
    const doc = decoded ?? await decodeProfile(this.game, remote.bytes);
    await this.write(doc.files);
    this.known = { parent: remote.hash, local: await contentHash(this.game, doc.files) };
    this.remoteHash = remote.hash;
    this.set({ state: 'saved', at: Date.now() });
  }
  /** A conflict settled: 'account' puts the account's copy in place, 'device' sends this profile over it. */
  async resolve(choice) {
    const remote = this.conflict ?? await this.fetchRemote(); this.conflict = null;
    if (choice === 'account' && remote) return this.applyRemote(remote);
    this.remoteHash = remote?.hash ?? null;
    return this.push({ force: true });
  }

  /**
   * The profile sent when it changed since it was last in step (`force`: over the account's latest even if it moved).
   * One at a time: a call during a send runs once more after it.
   */
  push({ force = false } = {}) {
    if (!this.user || this.status.state === 'conflict' && !force) return Promise.resolve(this.status);
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = this.send(force).finally(() => { this.busy = null; if (this.again) { this.again = false; this.push(); } });
    return this.busy;
  }
  async send(force) {
    let files;
    try { files = await this.read(); } catch (e) { this.set({ state: 'error', message: e.message }); return this.status; }
    const raw = encodeProfile(this.game, files), localHash = await contentHash(this.game, files), known = this.known;
    if (!force && known && known.local === localHash && (this.remoteHash ?? known.parent) === known.parent) { if (this.status.state !== 'saved') this.set({ state: 'saved', at: Date.now() }); return this.status; }
    if (!files.length && !known) { this.set({ state: 'idle' }); return this.status; }
    const gz = await pipe(raw, new CompressionStream('gzip'));
    if (gz.length > MAX_BACKUP) { this.set({ state: 'toobig', bytes: gz.length }); return this.status; }
    // (never in step on this device: sent as a first copy — the account refuses it when it has one, a conflict)
    const parent = force ? (this.remoteHash ?? 'none') : (known?.parent ?? 'none');
    this.set({ state: 'saving' });
    let r;
    try { r = await this.fetchImpl(this.url(), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Orthros-Parent-Hash': parent }, body: gz }); }
    catch (e) { this.set({ state: 'error', message: e.message, retry: true }); return this.status; }
    const body = await r.json().catch(() => ({}));
    if (r.status === 409) { this.remoteHash = body.remoteHash ?? null; this.conflict = null; this.set({ state: 'conflict' }); return this.status; }
    if (r.status === 401) { this.user = null; this.set({ state: 'off' }); return this.status; }
    if (!r.ok) { this.set({ state: 'error', message: body.error ?? `HTTP ${r.status}`, retry: r.status === 429 || r.status >= 500 }); return this.status; }
    this.known = { parent: body.hash, local: localHash }; this.remoteHash = body.hash;
    this.set({ state: 'saved', at: Date.now(), version: body.version ?? null });
    return this.status;
  }
}
