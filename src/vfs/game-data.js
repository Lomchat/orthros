// A game version's data, the same for every runtime (CLAUDE.md "Standardization", docs/slow-network.md): its tree
// (/api/tree), the reader over the server's compressed ranges (HttpBackend, /gamez), the browser's copy of what it read
// (the OPFS block store orthros-files-<manifest>), the order earlier sessions read it in (/api/prefetch) and the
// versions it requires (manifest.extraMounts), all on one connection (NetLink). Opened by the Windows games' worker
// (src/host/web/worker.js), the data worker of the engines that run in the page (data-worker.js) and the whole-game
// download (src/host/web/download-worker.js).
// The files a version takes from one it requires (a port's underlays: the server marks them `owner`, game-files.js) are
// that version's: read through a part of its own (`shared`), its store orthros-files-<owner> and /gamez/<owner>/ —
// one copy in the browser for every version that reads them (docs/slow-network.md "Files of a required version").
import { HttpBackend } from './http-backend.js';
import { NetLink } from './net-link.js';
import { OpfsBlockStore } from './opfs-store.js';
import { treeBytes, treeOwner, splitOwners } from './game-tree.js';

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
 *   cacheBlocks?: number, encoded?: boolean, onFetch?: Function, onRetry?: Function, onRead?: Function }} [o]
 *   store: the block store, 'opfs' for the version's own, null for none; encoded: the compressed ranges (default);
 *   onRead: each read of the game (path, start, end), whatever answered it
 */
export async function openData(name, o = {}) {
  const tree = o.tree ?? await json(`/api/tree/${enc(name)}`);
  const store = o.store === 'opfs' ? await openStore(name) : o.store ?? null;
  const files = new HttpBackend(`/game/${name}/`, tree, { cacheBlocks: o.cacheBlocks, store, encoded: o.encoded ?? true, session: o.session ?? '',
    link: o.link, net: o.net, onFetch: o.onFetch, onRetry: o.onRetry, onRead: o.onRead });
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
 * before (pages before the `owner` marks) is read there, and moved under the owner as it is read.
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
  const names = [name, ...deps], parts = [], shared = new Map();
  for (const { value: { n, tree, store } } of got) {
    const { own, owners } = splitOwners(tree, n);
    const part = await openData(n, { ...o, net, link, store, tree: own });
    parts.push(Object.assign(part, { tree, owned: new Set(owners.keys()) }));
    for (const [owner, t] of owners) shared.set(owner, shared.has(owner) ? mergeTrees(shared.get(owner), t) : t);
  }
  for (const [owner, tree] of shared) {
    if (names.includes(owner)) continue; // (opened already: its tree has them)
    const top = await storeOf(owner, false, true);
    const below = parts.filter((p) => p.owned.has(owner) && kept(p.name, p.store)).map((p) => p.store);
    const store = !below.length ? top : new UnderStore(kept(owner, top) ? top : null, below);
    const part = await openData(owner, { ...o, net, link, store, tree, session: '' });
    parts.push(Object.assign(part, { shared: true, owned: new Set() }));
  }
  return { net, manifest, parts };
}

/**
 * A shared part's store (openVersion): the owner's store `top` over the stores of the versions that read its files
 * (`below`, each the browser's) — those kept their own copies of them before the server marked their owner. A block is
 * here when either has it; read from `below`, it is put into `top` and forgotten there (moved as it is read: no copy of
 * a whole store at the open — 1.5 GB of an offline copy before the page is ready —, nothing fetched again). New blocks
 * go to `top`; with no `top` (the owner's store held by another tab's game) or once it failed (the device full), to the
 * first of `below` that works — as before the owners: the files kept, not fetched again at each launch. A moved
 * block's bytes stay in the data file of the store it left until that store's cache is cleared (OpfsBlockStore appends
 * only). Closing it closes `top` only: each of `below` is its own part's.
 */
export class UnderStore {
  /** @param {object|null} top @param {object[]} below */
  constructor(top, below) {
    this.top = top; this.below = below;
    const has = (k) => !!top?.map.has(k) || below.some((b) => b.map.has(k));
    this.map = { has, get size() { return (top?.map.size ?? 0) + below.reduce((a, b) => a + b.map.size, 0); } };
    this.stats = top?.stats ?? below[0]?.stats ?? { hits: 0, puts: 0, bytes: 0 };
  }
  /** the store new blocks go to (null: none works) */
  get writer() { return this.top && !this.top.failed ? this.top : this.below.find((b) => !b.failed) ?? null; }
  get failed() { return !this.writer; }
  get(key) {
    const t = this.top && !this.top.failed ? this.top.get(key) : null; if (t) return t;
    for (const b of this.below) {
      if (!b.map.has(key)) continue;
      const bytes = b.get(key); if (!bytes) continue;
      const top = this.top;
      if (top && !top.failed) { top.put(key, bytes); if (top.map.has(key)) b.drop(key); }
      return bytes;
    }
    return null;
  }
  put(key, bytes) { if (!this.map.has(key)) this.writer?.put(key, bytes); }
  drop(key) { this.top?.drop(key); for (const b of this.below) b.drop(key); }
  flush(force = false) { this.top?.flush?.(force); for (const b of this.below) b.flush?.(force); }
  close() { this.top?.close?.(); }
}

/** Two trees' files together (`a` changed): those of `b` added. */
function mergeTrees(a, b) {
  Object.assign(a.files, b.files);
  for (const [n, d] of Object.entries(b.dirs)) a.dirs[n] = a.dirs[n] ? mergeTrees(a.dirs[n], d) : d;
  return a;
}
