// A game of the player's own: a Windows game folder (or a CD image, .iso) picked in the page — the home's "Lancer mon
// jeu" entry, ?dropgame=1 until validated (docs/drop-game.md) — run like any game of the server's, and nothing of it
// sent to the server. Its files are copied into the browser's block store of its own (orthros-files-local-<id>, the
// OPFS store every game's reader keeps its blocks in: opfs-store.js), under the keys the reader looks them up by
// (http-backend.js storeKey), by the whole-game download's worker (src/web/download-worker.js `import`); its tree and
// its manifest — synthesized by the rules of `orthros run <folder>` (src/shared/folder-manifest.js) — are kept beside
// them (local.json). The game's worker then opens it as it opens any version (game-data.js openVersion: the manifest
// and the tree given, the store 'opfs'): every block is in the store, the reader never goes to the network (a miss
// fails at once: `local`). Its profile (saves) is an OPFS profile like any game's, under its id.
import { BLOCK, storeKey } from './http-backend.js';
import { pickExeFrom, withDefaults } from '../shared/folder-manifest.js';

/** A local game's manifest name (and store, profile key): 'local-<folder>-<hash of its listing>'. */
export const LOCAL_PREFIX = 'local-';
export const isLocalGame = (name) => typeof name === 'string' && name.startsWith(LOCAL_PREFIX);
const STORE_PREFIX = 'orthros-files-';
const META = 'local.json';

/**
 * @typedef {{ path: string, file: Blob, size: number, mtime: number }} LocalFile a file of a dropped folder: its path
 * ('/'-separated, from the folder's top), its bytes (a File, or a slice of a CD image), size and date (ms)
 */

/** The files of a folder the player picked (showDirectoryPicker): { name, files }. */
export async function filesOfHandle(dir) {
  const files = [];
  const walk = async (d, prefix) => {
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, prefix + name + '/');
      else { const f = await h.getFile(); files.push({ path: prefix + name, file: f, size: f.size, mtime: f.lastModified }); }
    }
  };
  await walk(dir, '');
  return { name: dir.name, files };
}

/** The files of an <input type=file webkitdirectory> (each File's webkitRelativePath: '<folder>/<path>'): { name, files }. */
export function filesOfList(list) {
  const files = []; let name = null;
  for (const f of list) {
    const rel = String(f.webkitRelativePath || f.name), cut = rel.indexOf('/');
    name ??= cut > 0 ? rel.slice(0, cut) : 'game';
    files.push({ path: cut > 0 ? rel.slice(cut + 1) : rel, file: f, size: f.size, mtime: f.lastModified });
  }
  return { name: name ?? 'game', files };
}

/**
 * The files of a CD image (ISO 9660, its Joliet names when it has them — long, mixed-case names): { name (the volume
 * label), label, files } — each file a slice of the image (nothing read but its directories). Multi-extent files and
 * UDF-only images are not read (an error).
 * @param {Blob & { name?: string, lastModified?: number }} iso
 */
export async function filesOfIso(iso) {
  const SECTOR = 2048, read = async (at, n) => new Uint8Array(await iso.slice(at, at + n).arrayBuffer());
  let pvd = null, joliet = null;
  for (let s = 16; s < 64; s++) {
    const d = await read(s * SECTOR, SECTOR);
    if (d.length < SECTOR || String.fromCharCode(...d.subarray(1, 6)) !== 'CD001') break;
    if (d[0] === 255) break;
    if (d[0] === 1) pvd ??= d;
    if (d[0] === 2 && d[88] === 0x25 && d[89] === 0x2f && [0x40, 0x43, 0x45].includes(d[90])) joliet ??= d;
  }
  if (!pvd) throw new Error('not an ISO 9660 image');
  const vd = joliet ?? pvd, u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const text = (b) => (joliet ? new TextDecoder('utf-16be') : new TextDecoder('latin1')).decode(b);
  const label = text(vd.subarray(40, 72)).replace(/[\s\0]+$/, '') || String(iso.name ?? 'cd').replace(/\.iso$/i, '');
  const date = (b, o) => { const t = Date.UTC(1900 + b[o], b[o + 1] - 1, b[o + 2], b[o + 3], b[o + 4], b[o + 5]) - ((b[o + 6] << 24) >> 24) * 15 * 60000; return Number.isFinite(t) ? t : 0; };
  const files = [], seen = new Set();
  const walk = async (lba, len, prefix, depth) => {
    if (depth > 32 || seen.has(lba)) return; seen.add(lba);
    const d = await read(lba * SECTOR, len);
    for (let p = 0; p < d.length;) {
      const n = d[p];
      if (!n) { p = (Math.floor(p / SECTOR) + 1) * SECTOR; continue; } // (records never cross a sector: the rest is padding)
      const ext = u32(d, p + 2), size = u32(d, p + 10), flags = d[p + 25], nl = d[p + 32], raw = d.subarray(p + 33, p + 33 + nl);
      p += n;
      if (nl === 1 && raw[0] <= 1) continue; // (. and ..)
      let name = text(raw); if (!joliet || (flags & 2) === 0) name = name.replace(/;\d+$/, ''); if (!(flags & 2)) name = name.replace(/\.$/, '');
      if (flags & 0x80) throw new Error(`${prefix + name}: multi-extent files are not read`);
      if (flags & 2) await walk(ext, size, prefix + name + '/', depth + 1);
      else files.push({ path: prefix + name, file: iso.slice(ext * SECTOR, ext * SECTOR + size), size, mtime: date(d, p - n + 18) });
    }
  };
  await walk(u32(vd, 156 + 2), u32(vd, 156 + 10), '', 0);
  return { name: label, label, files };
}

/** A dropped folder's tree, as the server lists a version's (/api/tree: { dirs, files: { name: { size, mtime } } }). */
export function folderTree(files) {
  const root = { dirs: {}, files: {} };
  for (const f of files) {
    const parts = f.path.split('/'); let node = root;
    for (const d of parts.slice(0, -1)) node = node.dirs[d] ??= { dirs: {}, files: {} };
    node.files[parts[parts.length - 1]] = { size: f.size, mtime: f.mtime };
  }
  return root;
}

/** A dropped folder's id (its manifest name): its name and a hash of its listing — the same folder dropped again, the same id. */
export async function localId(name, files) {
  const listing = files.map((f) => `${f.path}\n${f.size}\n${f.mtime}`).sort().join('\n');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name + '\n' + listing)));
  const slug = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'game';
  return LOCAL_PREFIX + slug + '-' + [...h.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A dropped folder's manifest, synthesized as `orthros run <folder>` synthesizes one (the folder's manifest.json, when it
 * has one, is read by the caller and given as `over`): exe by the shared rules, the defaults; `cd`: the files are a CD
 * image's — also a CD-ROM drive (manifest `cdrom`) under its volume label.
 */
/**
 * The options a dropped folder's own manifest.json may set: what `orthros run` takes for a Win32 game, nothing that leaves
 * the page or reaches the server (launchUrl/languageLaunchUrls — a `javascript:` URL run on Orthros' origin —, a port
 * runtime, extraMounts/parts/ownerLegacy naming catalog versions, profile keys). Any other key is dropped.
 */
export const LOCAL_KEYS = ['exe', 'args', 'cwd', 'mount', 'env', 'dllOverrides', 'display', 'cdrom', 'registry', 'keys',
  'languages', 'languageFiles', 'languageFileAliases', 'patches', 'profileMoves', 'profileSettings'];
export function localOptions(over) {
  const out = {};
  if (!over || typeof over !== 'object' || Array.isArray(over)) return out;
  for (const k of LOCAL_KEYS) if (Object.hasOwn(over, k)) out[k] = over[k];
  if (out.exe !== undefined && typeof out.exe !== 'string') delete out.exe;
  return out;
}

export function localManifest(id, name, files, over = {}, cd = null) {
  const m = localOptions(over);
  m.exe ??= pickExeFrom(files, name);
  if (!m.exe) throw new Error('no executable (.exe) in this folder');
  m.name ??= name; m.profileKey = id; m.local = true;
  if (cd && m.cdrom === undefined) m.cdrom = { drive: 'D', label: cd };
  return withDefaults(m);
}

/**
 * Copies the files into the store (OpfsBlockStore or MemBlockStore), block by block under the reader's keys; the blocks
 * already there are skipped (an interrupted copy resumes). `progress` ({ bytes, total, stored }) is updated as it goes;
 * `stop()` true ends it early. Returns true once every block is in the store; throws when the store fails (the device
 * full, another context holding it).
 */
export async function copyIntoStore(files, store, progress = {}, stop = () => false) {
  progress.total = files.reduce((n, f) => n + f.size, 0); progress.bytes = 0; progress.stored = 0;
  for (const f of files) {
    for (let i = 0; i * BLOCK < f.size; i++) {
      if (stop()) return false;
      const key = storeKey(f.path, f.size, f.mtime, i), a = i * BLOCK, b = Math.min(f.size, a + BLOCK);
      if (!store.map.has(key)) {
        const bytes = new Uint8Array(await f.file.slice(a, b).arrayBuffer());
        if (bytes.length !== b - a) throw new Error(`${f.path}: read ${bytes.length} bytes of ${b - a} (the file changed?)`);
        store.put(key, bytes);
        if (store.failed || !store.map.has(key)) throw new Error('the browser\'s storage refused the copy (full?)');
        progress.stored += b - a;
      }
      progress.bytes += b - a;
    }
  }
  store.flush?.(true);
  return true;
}

/** The OPFS directory of a local game's store (created when `create`), or null. */
async function storeDir(id, create = false) {
  try { return await (await navigator.storage.getDirectory()).getDirectoryHandle(STORE_PREFIX + id, { create }); } catch { return null; }
}

/** Keeps a local game's description (its manifest, tree, size, whether its copy is complete) beside its blocks. */
export async function saveLocal(meta) {
  const dir = await storeDir(meta.id, true); if (!dir) throw new Error('the browser\'s storage (OPFS) is not available');
  const w = await (await dir.getFileHandle(META, { create: true })).createWritable();
  await w.write(JSON.stringify(meta)); await w.close();
}

/** A local game's description ({ id, name, manifest, tree, bytes, complete, at }), or null. */
export async function loadLocal(id) {
  const dir = await storeDir(id); if (!dir) return null;
  let meta; try { meta = JSON.parse(await (await (await dir.getFileHandle(META)).getFile()).text()); } catch { return null; }
  // (a description written by an earlier page: its manifest filtered again — only the synthesized fields and LOCAL_KEYS)
  if (meta?.manifest) { const m = meta.manifest; meta.manifest = Object.assign(localOptions(m), { name: String(m.name ?? ''), profileKey: id, local: true }); withDefaults(meta.manifest); }
  return meta;
}

/** The local games of this browser, newest first (their descriptions without their trees). */
export async function listLocal() {
  const out = [];
  let root; try { root = await navigator.storage.getDirectory(); } catch { return out; }
  for await (const [name, h] of root.entries()) {
    if (h.kind !== 'directory' || !name.startsWith(STORE_PREFIX + LOCAL_PREFIX)) continue;
    const meta = await loadLocal(name.slice(STORE_PREFIX.length));
    if (meta) { delete meta.tree; out.push(meta); }
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** Removes a local game's copy (its blocks and description; its profile — saves — stays, as the data manager's cache removal). */
export async function removeLocal(id) {
  await (await navigator.storage.getDirectory()).removeEntry(STORE_PREFIX + id, { recursive: true }).catch((e) => { if (e?.name !== 'NotFoundError') throw e; });
}
