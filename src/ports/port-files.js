// The game files of a browser port whose engine runs in the page (GoldSrc, re3 — CLAUDE.md "Standardization"): the
// game data every Orthros game reads (src/vfs/data-client.js: the data worker, the browser's OPFS copy, the learned
// order, the whole download) opened, the copy an earlier page kept in IndexedDB handed over to it, the files mounted in
// the engine's file system (src/vfs/emscripten-files.js), what earlier sessions read first loaded before the start; the
// loading indicator every game shows while it waits for its data (src/host/web/data-meter.js).
import '../host/web/data-meter.js'; // (the loading indicator, before the game data: attached to it — data-client.js)
import { GameData, PIECE } from '../vfs/data-client.js';
import { mountFiles } from '../vfs/emscripten-files.js';
import { eachStorage, removeStorage } from './goldsrc/storage.js';

/** Bytes per message to the data worker while an earlier copy is handed over. */
const BATCH = 16 << 20;

/**
 * The installation's game data: { data (GameData), nodes } once its files are mounted under `root`.
 * @param {{ name: string, tree: object, files: { path: string, at?: string }[], FS: object, root: string,
 *   session: string, lang?: string, log: (text: string) => void, db?: IDBDatabase, asyncReads?: boolean, rewritable?: boolean,
 *   onCopy?: (bytes: number) => void, onProgress?: (p: object) => void }} o
 *   files: the tree's files as the engine sees them (a language's view: languageFiles); db: the installation's IndexedDB,
 *   whose 'content' store an earlier page kept the game files in (handed over, then emptied)
 */
export async function openPortFiles(o) {
  const data = await GameData.open({ name: o.name, tree: o.tree, session: o.session, lang: o.lang, prefetch: 'startup', log: o.log });
  if (o.onProgress) data.onProgress(o.onProgress); // (the loading in the background: the shell's pill, shell.setData)
  if (o.db) await handOver(data, o.name, o.db, o.log, o.onCopy);
  const nodes = mountFiles(o.FS, o.root, data, o.name, o.files, { asyncReads: o.asyncReads, rewritable: o.rewritable, log: o.log });
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
