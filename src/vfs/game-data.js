// A game version's data, the same for every runtime (CLAUDE.md "Standardization", docs/slow-network.md): its tree
// (/api/tree), the reader over the server's compressed ranges (HttpBackend, /gamez), the browser's copy of what it read
// (the OPFS block store orthros-files-<manifest>), the order earlier sessions read it in (/api/prefetch) and the
// versions it requires (manifest.extraMounts), all on one connection (NetLink). Opened by the Windows games' worker
// (src/host/web/worker.js), the data worker of the engines that run in the page (data-worker.js) and the whole-game
// download (src/host/web/download-worker.js).
import { HttpBackend } from './http-backend.js';
import { NetLink } from './net-link.js';
import { OpfsBlockStore } from './opfs-store.js';
import { treeBytes } from './game-tree.js';

const enc = encodeURIComponent;
async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** The browser's copy of a version's files (OPFS: one context at a time), or null when it cannot be opened. */
export const openStore = (name) => OpfsBlockStore.open('orthros-files-' + name);

/** The order earlier sessions read a version in (/api/prefetch: [path, block, pieces mask, ms]); [] when none. */
export const learnedOrder = (name, lang = null) => fetch(`/api/prefetch/${enc(name)}${lang ? `?lang=${enc(lang)}` : ''}`).then((r) => (r.ok ? r.json() : [])).then((l) => (Array.isArray(l) ? l : [])).catch(() => []);

/**
 * One version's data: { name, tree, store, files (its HttpBackend), total (bytes) }.
 * @param {string} name the manifest
 * @param {{ tree?: object, store?: object|null|'opfs', net?: NetLink, link?: Set<HttpBackend>, session?: string,
 *   cacheBlocks?: number, encoded?: boolean, onFetch?: Function, onRetry?: Function }} [o]
 *   store: the block store, 'opfs' for the version's own, null for none; encoded: the compressed ranges (default)
 */
export async function openData(name, o = {}) {
  const tree = o.tree ?? await json(`/api/tree/${enc(name)}`);
  const store = o.store === 'opfs' ? await openStore(name) : o.store ?? null;
  const files = new HttpBackend(`/game/${name}/`, tree, { cacheBlocks: o.cacheBlocks, store, encoded: o.encoded ?? true, session: o.session ?? '',
    link: o.link, net: o.net, onFetch: o.onFetch, onRetry: o.onRetry });
  return { name, tree, store, files, total: treeBytes(tree) };
}

/**
 * A version and the versions it requires (manifest.extraMounts), on one connection: { net, manifest, parts:
 * [primary, ...dependencies] } (openData's). `o.store`: a store option for every part, or (name, primary) => one.
 */
export async function openVersion(name, o = {}) {
  const net = o.net ?? new NetLink({ bw: o.bw }), link = new Set();
  const manifest = o.manifest ?? await json(`/api/manifest/${enc(name)}`);
  const names = [name, ...(Array.isArray(manifest.extraMounts) ? manifest.extraMounts.map((d) => d.manifest).filter(Boolean) : [])];
  const parts = [];
  for (const [i, n] of names.entries()) {
    const store = typeof o.store === 'function' ? await o.store(n, i === 0) : o.store;
    parts.push(await openData(n, { ...o, net, link, store, tree: i === 0 ? o.tree : undefined }));
  }
  return { net, manifest, parts };
}
