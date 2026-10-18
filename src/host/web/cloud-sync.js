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
 * The profile's files as the account keeps them: { raw (the JSON's bytes, whose hash is the content's), files }.
 * `files`: [{ path ('/'-separated, relative), data: Uint8Array }]; sorted by path, so the same content is the same bytes.
 */
export function encodeProfile(game, files) {
  const list = files.filter((f) => validPath(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const json = JSON.stringify({ format: FORMAT, version: 1, game, files: list.map((f) => ({ path: f.path, data: toBase64(f.data) })) });
  return new TextEncoder().encode(json);
}
/** The files of an account's copy (gzip bytes), checked: [{ path, data: Uint8Array }] and the raw JSON's bytes. */
export async function decodeProfile(game, gz) {
  const raw = await pipe(gz, new DecompressionStream('gzip'));
  const doc = JSON.parse(new TextDecoder().decode(raw));
  if (doc?.format !== FORMAT || doc.version !== 1 || doc.game !== game || !Array.isArray(doc.files)) throw new Error('not a save of this game');
  for (const f of doc.files) if (!validPath(f.path) || typeof f.data !== 'string') throw new Error('invalid save path');
  return { raw, files: doc.files.map((f) => ({ path: f.path, data: fromBase64(f.data) })) };
}

/**
 * A game's saves on the account of `user` (null: not signed in — nothing leaves the browser).
 * `read()`: the profile's files now; `write(files)`: the profile replaced by these (the page keeps the previous one
 * aside when it can). `onStatus(status)`: { state, ...} — off (not signed in), idle, saving, saved ({ at, version }),
 * error ({ message }), conflict ({ remote }), toobig.
 */
export class CloudSave {
  constructor({ game, user, read, write, onStatus = () => {}, fetchImpl = (...a) => fetch(...a), storage = globalThis.localStorage }) {
    Object.assign(this, { game, user, read, write, onStatus, fetchImpl, storage });
    this.status = { state: user ? 'idle' : 'off' };
    this.remote = null; // (the account's latest: { hash, version, at })
    this.busy = null; this.again = false;
  }
  get key() { return `orthros.sync.${this.user}.${this.game}`; }
  get known() { try { return JSON.parse(this.storage.getItem(this.key)); } catch { return null; } }
  set known(v) { try { this.storage.setItem(this.key, JSON.stringify(v)); this.storage.setItem(`orthros.owner.${this.game}`, this.user); } catch { /* storage off */ } }
  /** Which account this browser's profile of the game was last in step with (null: none). */
  owner() { try { return this.storage.getItem(`orthros.owner.${this.game}`); } catch { return null; } }
  set(status) { this.status = status; try { this.onStatus(status); } catch (e) { console.error(e); } }
  url(tail = '') { return `/api/cloud/${encodeURIComponent(this.game)}${tail}`; }

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
    let remote, files, raw;
    try {
      [remote, files] = await Promise.all([this.fetchRemote(), this.read()]);
    } catch (e) {
      if (e.status === 401) { this.user = null; this.set({ state: 'off' }); return 'none'; }
      this.set({ state: 'error', message: e.message }); return 'offline';
    }
    raw = encodeProfile(this.game, files);
    const localHash = await sha256(raw), known = this.known, owner = this.owner();
    // (a profile last in step with another account: not this player's — kept aside, the account's own put in place)
    const foreign = !!owner && owner !== this.user && files.length > 0;
    let what = foreign ? (remote ? 'restore' : 'reset') : decide({ known, remoteHash: remote?.hash ?? null, localEmpty: files.length === 0, localUnchanged: known?.local === localHash });
    let decoded = null;
    if (what === 'compare') {
      decoded = await decodeProfile(this.game, remote.bytes).catch(() => null);
      what = decoded && await sha256(decoded.raw) === localHash ? 'same' : 'conflict';
    }
    this.remoteHash = remote?.hash ?? null;
    if (what === 'same') { this.known = { parent: remote.hash, local: localHash }; this.set({ state: 'saved', at: Date.now() }); }
    else if (what === 'restore') { await this.applyRemote(remote, decoded); }
    else if (what === 'reset') { await this.write([]); this.known = { parent: 'none', local: await sha256(encodeProfile(this.game, [])) }; this.set({ state: 'idle' }); }
    else if (what === 'push') { await this.push(); }
    else if (what === 'conflict') { this.conflict = remote; this.set({ state: 'conflict' }); }
    else this.set({ state: 'idle' });
    return what;
  }
  async applyRemote(remote, decoded = null) {
    const doc = decoded ?? await decodeProfile(this.game, remote.bytes);
    await this.write(doc.files);
    this.known = { parent: remote.hash, local: await sha256(encodeProfile(this.game, doc.files)) };
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
    const raw = encodeProfile(this.game, files), localHash = await sha256(raw), known = this.known;
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
