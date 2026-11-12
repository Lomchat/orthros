// A game version's data, the same for every runtime (CLAUDE.md "Standardization", docs/slow-network.md): its tree
// (/api/tree), the reader over the server's compressed ranges (HttpBackend, /gamez), the browser's copy of what it read
// (the OPFS block store orthros-files-<manifest>), the order earlier sessions read it in (/api/prefetch) and the
// versions it requires (manifest.extraMounts), all on one connection (NetLink). Opened by the Windows games' worker
// (src/web/worker.js), the data worker of the engines that run in the page (data-worker.js) and the whole-game
// download (src/web/download-worker.js).
// The files a version takes from one it requires (a port's underlays: the server marks them `owner`, game-files.js) are
// that version's: read through a part of its own (`shared`), its store orthros-files-<owner> and /gamez/<owner>/ —
// one copy in the browser for every version that reads them (docs/slow-network.md "Files of a required version"). The
// same for the files of a game's base/ its versions share (owner `<game>@base`): one copy whatever version is played.
import { HttpBackend } from './http-backend.js';
import { NetLink } from './net-link.js';
import { OpfsBlockStore } from './opfs-store.js';
import { OpenPredictor } from './open-predict.js';
import { treeBytes, treeOwner, splitOwners, treeLookup, treeStat, treeReaddir } from './game-tree.js';

const enc = encodeURIComponent;
async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/**
 * The browser's copy of a version's files (OPFS: one context at a time), or null when it cannot be opened. Opened under
 * the store's Web Lock (storeLocks): an open waits out the home's probe counting the store in this tab or another (a
 * moment), instead of failing and running the session without its store.
 */
export const openStore = (name) => storeLocks([name], () => openStoreNow(name));
/** openStore without the lock: the caller holds it (the home's probe, download-worker.js `probe`). */
export const openStoreNow = (name) => OpfsBlockStore.open('orthros-files-' + name);

/**
 * Runs `fn(got)` holding the Web Locks of the stores of `names` (navigator.locks, shared by every tab and worker of the
 * origin; held only while a store is opened — openStore — or opened, counted and closed — the probe). `o.ifAvailable`:
 * do not wait — `got` false when another context holds one of them (fn runs unlocked, to say so). Without Web Locks
 * (an old browser, a test): fn(true) at once. Taken in one order, by name, whoever asks (a version's store and its
 * owners' — a page of one edition and a probe or a page of another take the same locks —: no two contexts each wait
 * for the lock the other holds).
 * @template T @param {string[]} names @param {(got: boolean) => T|Promise<T>} fn @param {{ ifAvailable?: boolean }} [o]
 * @returns {Promise<T>}
 */
export async function storeLocks(names, fn, o = {}) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request || !names.length) return fn(true);
  const [n, ...rest] = [...new Set(names)].sort();
  return locks.request('orthros-store-' + n, { ifAvailable: !!o.ifAvailable }, (l) => (l || !o.ifAvailable ? lockedRest(rest, fn, o) : fn(false)));
}
// (the rest of storeLocks' names, already in order)
const lockedRest = (names, fn, o) => {
  if (!names.length) return fn(true);
  const [n, ...rest] = names;
  return navigator.locks.request('orthros-store-' + n, { ifAvailable: !!o.ifAvailable }, (l) => (l || !o.ifAvailable ? lockedRest(rest, fn, o) : fn(false)));
};

/**
 * A store that may hold an owner's files from before they were shared (manifest.ownerLegacy: another version of the
 * game kept them in its own), opened only when it exists and no other context holds or opens it (its lock taken
 * without waiting: a page playing that version keeps it), else null. One left empty — every block moved under its
 * owner, nothing of its own — is removed instead (its data file's bytes are dead: OpfsBlockStore appends only).
 */
export const openLegacyStore = (name) => storeLocks([name], async (got) => {
  if (!got || (await storeExists(name)) !== true) return null;
  const st = await openStoreNow(name);
  if (!st || st.map.size) return st;
  st.close();
  try { await (await navigator.storage.getDirectory()).removeEntry('orthros-files-' + name, { recursive: true }); } catch { /* opened meanwhile: kept */ }
  return null;
}, { ifAvailable: true });

/**
 * The browser has a copy of a version's files: true when its OPFS directory exists (looked up without creating it —
 * openStore creates it), false when it does not, null when OPFS cannot say (no OPFS, an error).
 */
export async function storeExists(name) {
  let root; try { root = await navigator.storage.getDirectory(); } catch { return null; }
  try { await root.getDirectoryHandle('orthros-files-' + name); return true; } catch (e) { return e?.name === 'NotFoundError' ? false : null; }
}

/** The order earlier sessions read a version in (/api/prefetch: [path, block, pieces mask, ms]); [] when none. */
export const learnedOrder = (name, lang = null) => fetch(`/api/prefetch/${enc(name)}${lang ? `?lang=${enc(lang)}` : ''}`).then((r) => (r.ok ? r.json() : [])).then((l) => (Array.isArray(l) ? l : [])).catch(() => []);

/**
 * The learned orders of an opened version's parts (openVersion), one list a part in its order: each version's own
 * (learnedOrder), its entries of files another version owns (treeOwner: a required version's, read by this one's
 * sessions — the version learns them as its own reads) moved to that owner's part, in their order; a shared part has
 * no order of its own (the owner's is its own players', not this game's reads).
 */
export async function learnedOrders(version, lang = null) {
  const lists = await Promise.all(version.parts.map((p) => (p.shared ? [] : learnedOrder(p.name, lang))));
  const at = new Map(version.parts.map((p, i) => [p.name, i]));
  version.parts.forEach((p, i) => {
    if (p.shared || !p.owned?.size) return;
    const keep = [];
    for (const e of lists[i]) {
      const owner = typeof e?.[0] === 'string' ? treeOwner(p.tree, e[0], p.name) : null, j = owner ? at.get(owner) : undefined;
      if (j !== undefined && j !== i) lists[j].push(e); else keep.push(e);
    }
    lists[i] = keep;
  });
  return lists;
}

/**
 * The part of an opened version (openVersion) that reads the file `path` of part `name` as the game sees it: that
 * part, or the part of the version owning the file (treeOwner) — remembered per path. Null for no such part.
 */
export function partOf(version, name, path) {
  const routes = version.routes ??= new Map(), key = name + '\n' + path;
  let p = routes.get(key);
  if (p === undefined) {
    const own = version.parts.find((q) => q.name === name && !q.shared) ?? null;
    const owner = own?.owned?.size ? treeOwner(own.tree, path, own.name) : null;
    p = (owner && version.parts.find((q) => q.name === owner)) || own;
    routes.set(key, p);
  }
  return p;
}

/**
 * One version's data: { name, tree, store, files (its HttpBackend), total (bytes) }.
 * @param {string} name the manifest
 * @param {{ tree?: object, store?: object|null|'opfs', net?: NetLink, link?: Set<HttpBackend>, session?: string,
 *   budget?: object, cacheBlocks?: number, encoded?: boolean, onFetch?: Function, onRetry?: Function, onRead?: Function }} [o]
 *   store: the block store, 'opfs' for the version's own, null for none; encoded: the compressed ranges (default);
 *   batch: batched requests (default; HttpBackend.batch);
 *   onRead: each read of the game (path, start, end), whatever answered it; local: a game of the player's own
 *   (local-games.js) — its store holds every block, nothing is on the server: a miss fails at once, never retried
 */
export async function openData(name, o = {}) {
  const tree = o.tree ?? await json(`/api/tree/${enc(name)}`);
  const store = o.store === 'opfs' ? await openStore(name) : o.store ?? null;
  const files = new HttpBackend(`/game/${name}/`, tree, { cacheBlocks: o.cacheBlocks, store, encoded: o.encoded ?? true, session: o.session ?? '', batch: o.batch ?? true,
    link: o.link, net: o.net, budget: o.budget, onFetch: o.onFetch, onRetry: o.onRetry, onRead: o.onRead, ...(o.local ? { retryWaits: [] } : {}) });
  return { name, tree, store, files, total: treeBytes(tree) };
}

/**
 * A version and the versions it requires (manifest.extraMounts), on one connection: { net, manifest, parts:
 * [primary, ...dependencies, ...shared] } (openData's). Each part's `tree` is its tree as the game sees it, its `files`
 * read its own files only (`files.tree`, `total` their bytes); the files it takes from another version (the server's
 * `owner` marks, splitOwners) are read by a part of that version — one already opened, else a `shared` part (its tree
 * those files only, no session: the owner's order does not learn another game's reads), after the others. `owned`: a
 * part's owners. Route a read with partOf, a learned order with learnedOrders. `o.store`: a store option for every part,
 * or (name, primary, shared) => one — a shared part's null when the owner's store cannot be had (another tab's game
 * holds it): its files then kept where they were before the owners, the store of the parts that read them.
 * `o.kept(name)`: whether that version's store is the browser's (default: any store; the data worker's in memory are
 * not). A shared part's store is an UnderStore over the stores of the parts that read its files: what they kept of them
 * before (pages before the `owner` marks) is read there, and moved under the owner as it is read — and over the stores
 * of the other versions that kept them before (manifest.ownerLegacy: a game's versions, before their base was shared),
 * those `o.legacy(name)` opens (openLegacyStore: the ones that exist and no other context holds; none without it),
 * closed with that UnderStore — one opened here already (a part, another shared part's owner) read through its store.
 * The parts' memory caches share one budget, a mounted version's each (HttpBackend `budget`).
 * The manifest (`o.manifest`, the page's when it holds it: no request), the version's tree (`o.tree`, likewise) and its
 * store are had at once, then every required version's tree and store at once: one wait each instead of one after
 * another (a page that opens its data while its engine downloads — docs/slow-network.md "Opened early"). A failure
 * closes the stores that opened.
 */
export async function openVersion(name, o = {}) {
  const net = o.net ?? new NetLink({ bw: o.bw }), link = new Set();
  const storeOf = (n, primary, sh = false) => (typeof o.store === 'function' ? o.store(n, primary, sh) : o.store);
  const kept = (n, st) => !!st && typeof st === 'object' && (o.kept ? !!o.kept(n) : true);
  // (a version's tree and store, together; its store closed when its tree cannot be had. Each promise observed as it
  // is made — awaited later: a store that fails while the tree is in flight, or a tree while the manifest is, is not an
  // unhandled rejection — Node's process killed, the worker's "Uncaught (in promise)" before its clean failure)
  const both = async (n, primary, tree) => {
    const store = Promise.resolve(storeOf(n, primary));
    store.catch(() => {});
    try { return { n, tree: await (tree ?? json(`/api/tree/${enc(n)}`)), store: await store }; }
    catch (e) { store.then((st) => st?.close?.(), () => {}); throw e; }
  };
  const first = both(name, true, o.tree);
  first.catch(() => {});
  let manifest;
  try { manifest = await (o.manifest ?? json(`/api/manifest/${enc(name)}`)); }
  catch (e) { first.then((x) => x.store?.close?.(), () => {}); throw e; }
  const deps = [...new Set((Array.isArray(manifest.extraMounts) ? manifest.extraMounts.map((d) => d.manifest).filter(Boolean) : []))].filter((n) => n !== name);
  const got = await Promise.allSettled([first, ...deps.map((n) => both(n, false))]);
  const bad = got.find((g) => g.status === 'rejected');
  if (bad) { for (const g of got) if (g.status === 'fulfilled') g.value.store?.close?.(); throw bad.reason; }
  const names = [name, ...deps], parts = [], shared = new Map(), legacy = new Map();
  // (one memory budget for the parts' caches: a mounted version's, each — its own files and those of a shared base it
  // reads together, as before the base was split from them: HttpBackend `budget`)
  const budget = { members: new Set(), units: 0 };
  for (const { value: { n, tree, store } } of got) {
    const { own, owners } = splitOwners(tree, n);
    const part = await openData(n, { ...o, net, link, budget, store, tree: own });
    parts.push(Object.assign(part, { tree, owned: new Set(owners.keys()) }));
    for (const [owner, t] of owners) shared.set(owner, shared.has(owner) ? mergeTrees(shared.get(owner), t) : t);
  }
  // (every shared owner's store first: one may be a store that kept another owner's files before — a port's required
  // version, which held its game's base — read there as that owner's `below`, never opened a second time: OPFS opens a
  // store in one place at a time)
  const owners = [...shared.keys()].filter((n) => !names.includes(n)), tops = new Map();
  for (const owner of owners) tops.set(owner, await storeOf(owner, false, true));
  /** the store of `n` that may hold an owner's files from before it was shared: a part's (borrowed), else o.legacy's */
  const legacyStore = async (n) => {
    const p = parts.find((q) => q.name === n);
    if (p) return kept(n, p.store) ? p.store : null;
    if (tops.has(n)) return kept(n, tops.get(n)) ? tops.get(n) : null;
    if (!o.legacy) return null;
    if (!legacy.has(n)) legacy.set(n, Promise.resolve().then(() => o.legacy(n)).catch(() => null));
    return legacy.get(n);
  };
  for (const owner of owners) {
    const top = tops.get(owner), below = parts.filter((p) => p.owned.has(owner) && kept(p.name, p.store)).map((p) => p.store), old = [];
    const list = Array.isArray(manifest.ownerLegacy?.[owner]) ? manifest.ownerLegacy[owner] : [];
    for (const n of list) {
      if (typeof n !== 'string' || !n || n === owner) continue;
      const st = await legacyStore(n); if (!st || st === top || below.includes(st)) continue;
      below.push(st);
      if (!parts.some((p) => p.name === n) && !tops.has(n)) old.push(st); // (opened for it: closed with it)
    }
    const store = !below.length ? top : new UnderStore(kept(owner, top) ? top : null, below, old);
    const part = await openData(owner, { ...o, net, link, budget, store, tree: shared.get(owner), session: '' });
    parts.push(Object.assign(part, { shared: true, owned: new Set() }));
  }
  budget.units = parts.filter((p) => !isBaseOwner(p.name)).length;
  return { net, manifest, parts };
}

/** A game folder's shared base (game-catalog.js baseOwnerOf: `<game>@base` — '@' is in no version id), not a version. */
const isBaseOwner = (name) => typeof name === 'string' && name.endsWith('@base');

/**
 * A shared part's store (openVersion): the owner's store `top` over the stores of the versions that read its files
 * (`below`, each the browser's) — those kept their own copies of them before the server marked their owner. A block is
 * here when either has it; read from `below`, it is put into `top` and forgotten there (moved as it is read: no copy of
 * a whole store at the open — 1.5 GB of an offline copy before the page is ready —, nothing fetched again). New blocks
 * go to `top`; with no `top` (the owner's store held by another tab's game) or once it failed (the device full), to the
 * first of `below` that works — as before the owners: the files kept, not fetched again at each launch. A moved
 * block is forgotten in the store it left once `top`'s index holds it (its sync point: settle) — `top` failing before
 * (the device full), it is still read there. Its bytes stay in that store's data file until its cache is cleared
 * (OpfsBlockStore appends only). Closing it closes `top` and those of `below` it was given (`own`: another version's
 * store opened for it, openVersion's legacy ones), not the others: each is its own part's.
 */
export class UnderStore {
  /** @param {object|null} top @param {object[]} below @param {object[]} [own] */
  constructor(top, below, own = []) {
    this.top = top; this.below = below; this.own = own;
    /** blocks moved into `top` whose record waits for its next sync point: [store of `below`, its key] (settle) */
    this.moving = [];
    /** a store of `below` -> its keys by their lower case (made at the first fold: see fold) */
    this.lower = new Map();
    const has = (k) => !!top?.map.has(k) || below.some((b) => b.map.has(k)) || this.fold(k) !== null;
    this.map = { has, get size() { return (top?.map.size ?? 0) + below.reduce((a, b) => a + b.map.size, 0); } };
    this.stats = top?.stats ?? below[0]?.stats ?? { hits: 0, puts: 0, bytes: 0 };
  }
  /**
   * A block of `below` kept under another case of `key`'s path ([store, its key]), or null: a version whose folder
   * names a directory otherwise than the owner kept the owner's files under its own paths (the owner's part reads them
   * at the owner's, game-tree.js splitOwners `op`: BFME 1.08's Data/ over the base's data/, 1 GB). One file of a
   * version's tree a case-insensitive path, its size and date the same: the same bytes.
   */
  fold(key) {
    if (!this.below.length) return null;
    const low = key.toLowerCase();
    for (const b of this.below) {
      let l = this.lower.get(b);
      if (!l) { l = new Map(); for (const k of b.map.keys?.() ?? []) l.set(k.toLowerCase(), k); this.lower.set(b, l); }
      const k = l.get(low); if (k !== undefined && k !== key && b.map.has(k)) return [b, k];
    }
    return null;
  }
  /** the store new blocks go to (null: none works) */
  get writer() { return this.top && !this.top.failed ? this.top : this.below.find((b) => !b.failed) ?? null; }
  get failed() { return !this.writer; }
  /** The moved blocks `top`'s index now holds forgotten below; none once `top` failed (read below again). */
  settle() {
    if (!this.moving.length) return;
    const top = this.top;
    if (!top || top.failed) { this.moving = []; return; }
    if (top.pending?.length) return;
    for (const [b, k] of this.moving) b.drop(k);
    this.moving = [];
  }
  get(key) {
    this.settle();
    const t = this.top && !this.top.failed ? this.top.get(key) : null; if (t) return t;
    const move = (b, k) => {
      const bytes = b.get(k); if (!bytes) return null;
      const top = this.top;
      if (top && !top.failed) { top.put(key, bytes); if (top.map.has(key)) { if (top.pending?.length) this.moving.push([b, k]); else b.drop(k); } }
      return bytes;
    };
    for (const b of this.below) {
      if (!b.map.has(key)) continue;
      const bytes = move(b, key); if (bytes) return bytes;
    }
    const f = this.fold(key);
    return f ? move(f[0], f[1]) : null;
  }
  put(key, bytes) { if (!this.map.has(key)) this.writer?.put(key, bytes); }
  drop(key) { this.top?.drop(key); for (const b of this.below) b.drop(key); const f = this.fold(key); f?.[0].drop(f[1]); }
  flush(force = false) { this.top?.flush?.(force); this.settle(); for (const b of this.below) b.flush?.(force); }
  close() { this.flush(true); this.top?.close?.(); for (const b of this.own) b.close?.(); }
}

/**
 * A version as a Windows game mounts it (src/web/worker.js; any reader of a version by its own paths): version
 * `name` of an opened version (openVersion) — its whole tree as the server lists it, as the guest sees it — whose files
 * are read by the parts that hold them (partOf: its own, or an owner's — its game's shared base, a required version's
 * files). stat, readdir and lookup answer from that tree (game-tree.js); open returns the owning part's file itself:
 * the guest's reads go to it, nothing in between (synchronous, the hot path). Read-only. A file opened is told the
 * version and the path the game opened it under (`readName`, `readPath`): reported so (ReadLog, the server's learned
 * order of the version), whatever part serves it.
 */
export class PartsBackend {
  constructor(version, name) {
    const own = version.parts.find((p) => p.name === name && !p.shared);
    if (!own) throw new Error(`${name}: not opened`);
    this.version = version; this.name = name; this.own = own; this.tree = own.tree;
    /** the parts its files are read through: its own, then its owners' */
    this.parts = [own, ...version.parts.filter((p) => p !== own && own.owned?.has(p.name))];
    /** the files it is about to open, guessed from its opens and fetched ahead (open-predict.js; ?dbg=ORTHROS_PREDICT=0: off) */
    this.predictor = new OpenPredictor(this.tree, {
      net: version.net ?? own.files.net,
      fetch: (path, end) => (partOf(this.version, this.name, path) ?? this.own).files.predict(path, 0, end),
      // (the learned order follows the game: it fetches the next reads already)
      tracked: () => this.parts.some((p) => p.files.learned?.tracked),
      // (the order holds the file: its reads are known)
      covered: (path) => this.parts.some((p) => p.files.learned?.paths.has(path)),
      peek: (path, size, fn) => (partOf(this.version, this.name, path) ?? this.own).files.memoryPieces(path, size, fn),
    });
    // (the bytes of its parts' files as they arrive: the names an opened file holds — open-predict.js noteBytes)
    for (const p of this.parts) p.files.arrivals?.add((path, start, bytes) => this.predictor.noteBytes(path, start, bytes));
  }
  lookup(rel) { return treeLookup(this.tree, rel); }
  stat(rel) { return treeStat(this.tree, rel); }
  readdir(rel) { return treeReaddir(this.tree, rel); }
  open(rel, opts = {}) {
    if (opts.write || opts.create || opts.truncate) return null; // (read-only mount)
    const r = treeLookup(this.tree, rel); if (!r || r.dir) return null;
    const f = (partOf(this.version, this.name, r.path) ?? this.own).files.open(r.path);
    if (f) { f.readName = this.name; f.readPath = r.path; this.predictor.noteOpen(r.path, r.file.size ?? 0); }
    return f;
  }
  mkdir() { return false; }
  unlink() { return false; }
  rename() { return false; }
}

/** Two trees' files together (`a` changed): those of `b` added. */
function mergeTrees(a, b) {
  Object.assign(a.files, b.files);
  for (const [n, d] of Object.entries(b.dirs)) a.dirs[n] = a.dirs[n] ? mergeTrees(a.dirs[n], d) : d;
  return a;
}
