// The game files of a browser port whose engine runs in the page (GoldSrc, re3 — CLAUDE.md "Standardization"): the
// game data every Orthros game reads (src/vfs/data-client.js: the data worker, the browser's OPFS copy, the learned
// order, the whole download) opened at the page's start, beside the engine's download (openPortData), then the copy an
// earlier page kept in IndexedDB handed over to it and the files mounted in the engine's file system
// (src/vfs/emscripten-files.js) once the engine is in (mountPortFiles), what earlier sessions read first loaded before
// the start; the loading indicator every game shows while it waits for its data (src/host/web/data-meter.js).
import '../host/web/data-meter.js'; // (the loading indicator, before the game data: attached to it — data-client.js)
import { GameData, PIECE } from '../vfs/data-client.js';
import { mountFiles } from '../vfs/emscripten-files.js';
import { eachStorage, removeStorage } from './goldsrc/storage.js';

/**
 * A port page's engine file addresses: `at(rel)` the URL of release path `rel` — by its content when the server gives it
 * (/api/manifest engineUrls, src/host/engine-content.js: a release's unchanged files keep their address, and the
 * browser's copy), else under the release (/engines/<release>/<rel>, encoded `encode`d).
 * @param {{ engineUrls?: Record<string, string> }} config the version's /api/manifest
 * @param {string} release the engine release's id
 */
export const engineUrls = (config, release, encode = false) => {
  const base = `/engines/${encodeURIComponent(release)}/`;
  return (rel) => config.engineUrls?.[rel] ?? base + (encode ? rel.split('/').map(encodeURIComponent).join('/') : rel);
};

/** Bytes per message to the data worker while an earlier copy is handed over. */
const BATCH = 16 << 20;

/**
 * The installation's game data opened now, as soon as the page knows its version — not after its engine: the data
 * worker, the version's store and the learned order's list ready while the engine downloads and compiles
 * (docs/slow-network.md "Opened early"). Returns the GameData at once (its `ready` settles once the worker answered);
 * mountPortFiles mounts it once the engine's file system exists.
 * @param {{ name: string, tree: object, manifest?: object, session: string, lang?: string, log: (text: string) => void }} o
 *   tree, manifest: the version's, as the page fetched them (not asked again: game-data.js openVersion)
 */
export function openPortData(o) {
  const data = new GameData({ name: o.name, tree: o.tree, manifest: o.manifest, session: o.session, lang: o.lang, prefetch: 'startup', orderAtOpen: true, log: o.log,
    // (the page's ?piecereuse=0: its pieces each a copy of its own, left to the collector — GameData's pieceReuse)
    pieceReuse: new URLSearchParams(globalThis.location?.search ?? '').get('piecereuse') !== '0' });
  data.ready.catch(() => {}); // (its failure told where the page waits for it: mountPortFiles)
  return data;
}

/**
 * The game data an openPortData opened, its files mounted under `root` once it is ready: { data, nodes }.
 * @param {GameData} data
 * @param {{ name: string, files: { path: string, at?: string }[], FS: object, root: string, log: (text: string) => void,
 *   db?: IDBDatabase, asyncReads?: boolean, rewritable?: boolean, onCopy?: (bytes: number) => void,
 *   onProgress?: (p: object) => void }} o
 *   files: the tree's files as the engine sees them (a language's view: languageFiles); db: the installation's IndexedDB,
 *   whose 'content' store an earlier page kept the game files in (handed over, then emptied)
 */
export async function mountPortFiles(data, o) {
  await data.ready;
  if (o.onProgress) data.onProgress(o.onProgress); // (the loading in the background: the shell's pill, shell.setData)
  if (o.db) await handOver(data, o.name, o.db, o.log, o.onCopy);
  const nodes = mountFiles(o.FS, o.root, data, o.name, o.files, { asyncReads: o.asyncReads, rewritable: o.rewritable, log: o.log });
  data.times.mounted = Math.round(performance.now());
  return { data, nodes };
}

/**
 * The game files an earlier page kept in IndexedDB ('content': `<path>\n<size>\n<mtime>` whole, `…\n#<piece>` 64 KiB
 * pieces) into the game data's store — those of the files as they are now —, then removed.
 */
async function handOver(data, name, db, log, onCopy = () => {}) {
  let batch = [], bytes = 0, moved = 0;
  const keys = [];
  const send = () => { if (batch.length) { data.migrate(batch); moved += bytes; onCopy(moved); } batch = []; bytes = 0; };
  try {
    await eachStorage(db, 'content', (key, value) => {
      keys.push(key);
      if (typeof key !== 'string' || !(value instanceof Uint8Array)) return;
      const cut = key.lastIndexOf('\n#'), file = cut < 0 ? key : key.slice(0, cut), [path, size, mtime] = file.split('\n');
      const h = data.file(name, path);
      if (!h || h.size !== Number(size) || h.mtime !== Number(mtime)) return; // (a file since changed: not handed over)
      batch.push({ name, path: h.path, at: cut < 0 ? 0 : Number(key.slice(cut + 2)) * PIECE, bytes: value }); bytes += value.length;
      if (bytes >= BATCH) send();
    });
    send();
    if (keys.length) await removeStorage(db, 'content', keys);
    if (moved) log(`Earlier copy of the game files handed over: ${Math.round(moved / 1048576)} MB`);
  } catch (error) { log('Earlier copy of the game files not handed over: ' + (error?.message ?? error)); }
}
