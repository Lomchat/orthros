// A game's base installation and a version's overrides form one read-only folder (a port's engine release's game
// files over both, the files of the versions a GoldSrc port requires beneath).
import fs from 'node:fs';
import path from 'node:path';
import { LIGHT_DIR, lightCopy } from './light-copies.js';
import { isMediaFile } from '../vfs/game-tree.js';

/**
 * A port's engine release's own game files (`gamefiles/`, present or not), laid over its version's whatever the
 * runtime (re3, GoldSrc: game-catalog.js puts it in the manifest's `overlays`): files Orthros builds itself — reVC's
 * texts, the Counter-Strike bots' navigation meshes, Half Strike's models and sounds — served as the game's own data
 * (/gamez, light copies, the learned order, the OPFS store), not as engine files fetched whole before the start.
 */
export const releaseGameFiles = (enginesDir, release) => path.join(enginesDir, release, 'gamefiles');

export function gameLayers(manifest) {
  // (underlays: the folders of versions a GoldSrc port requires, beneath its own; overlays: folders over the version's
  // own, a port's engine release's game files, releaseGameFiles — both from game-catalog.js)
  return [...(manifest.overlays ?? []), ...(manifest.baseFolder ? [manifest.folder, manifest.baseFolder] : [manifest.folder]), ...(manifest.underlays ?? [])];
}

/**
 * List one layer, replacing same-named entries without changing the guest-visible path. `mark(file, entry)`: each
 * file's entry completed (its light copy's size); `seen`: every folder looked at (there or not) pushed to it.
 */
function mergeDir(layers, mark = null, seen = null, rel = '') {
  const node = { dirs: {}, files: {} }, entries = new Map();
  for (const dir of layers) {
    seen?.push(dir);
    if (!dir || !fs.existsSync(dir)) continue;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const key = ent.name.toLowerCase();
      if (ent.isDirectory()) {
        const previous = entries.get(key);
        if (!previous) entries.set(key, { name: ent.name, dirs: [path.join(dir, ent.name)] });
        else if (previous.dirs) previous.dirs.push(path.join(dir, ent.name));
      } else if (ent.isFile() && !entries.has(key)) {
        entries.set(key, { name: ent.name, file: path.join(dir, ent.name) });
      }
    }
  }
  for (const entry of entries.values()) {
    const at = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.dirs) node.dirs[entry.name] = mergeDir(entry.dirs, mark, seen, at);
    else {
      const st = fs.statSync(entry.file), e = node.files[entry.name] = { size: st.size, mtime: st.mtimeMs };
      if (isMediaFile(entry.name, st.size)) e.media = true; // (game-tree.js: after the rest on a link that is not fast)
      mark?.(entry.file, st, e, at);
    }
  }
  return node;
}

/**
 * The game's files as the browsers read them: its layers, and the folders of its engine's release it serves beside them
 * (`dataMounts`: [{ at, dir }] — an engine's own data, as OpenMW's asset pack, under a folder of its own, `at`; not part
 * of the game's layers, which a native server laying out the game reads too). With manifest.lightCopies, a file that has
 * a light copy (light-copies.js) tells its size: `light`. A media file by its format (isMediaFile, game-tree.js) is
 * marked `media: true`. `seen`: the folders it was listed from pushed to it (dirsStamp: whether it changed since).
 * `ownerOf(id)`: the manifest of a version the tree's underlays belong to (manifest.underlayOwners, game-catalog.js) —
 * a file taken from one is marked `owner: <id>` (fileOwner): the browsers store and fetch it under that version.
 */
export function listGameTree(manifest, seen = null, ownerOf = null) {
  const light = manifest.lightCopies ? (file, st, e) => { const c = lightCopy(file, st); if (c) e.light = c.size; } : null;
  const owner = ownerOf && manifest.underlayOwners?.length ? fileOwner(manifest, ownerOf, seen) : null;
  const mark = light && owner ? (file, st, e, rel) => { light(file, st, e); owner(file, st, e, rel); } : light ?? owner;
  const tree = mergeDir(gameLayers(manifest), mark, seen);
  for (const { at, dir } of manifest.dataMounts ?? []) { if (fs.existsSync(dir)) tree.dirs[at] = mergeDir([dir], mark, seen, at); else seen?.push(dir); }
  return tree;
}

/**
 * listGameTree's marker of the files a version takes from another (its underlays): (file, st, entry, rel) marks the
 * entry `owner: <id>` when the first of the versions it requires (manifest.underlayOwners, in order) whose own path
 * `rel` — what /gamez/<id>/<rel> serves, resolveGameFile: through its overlays, data mounts and version folder — is this
 * very file (the same device and inode: the file of the folder they share, or a hard link of it in the version's own
 * folder — Morrowind Vanilla+ FR keeps GOTY FR's archives so —, the same size and time then: the browsers' block keys
 * agree), and, when it has a light copy, when that version serves light copies too. Any other file stays the version's
 * own (fetched as before): one the owner's folder overrides (two versions of one game folder share its base), one the
 * owner hides. The folders the owners' paths were resolved in pushed to `seen` (a file added there changes the answer).
 */
function fileOwner(manifest, ownerOf, seen) {
  const owners = [];
  for (const { manifest: id } of manifest.underlayOwners) { const m = ownerOf(id); if (m && !owners.some((o) => o.id === id)) owners.push({ id, m }); }
  // (resolveGameFile's listings, each folder listed once — and pushed to `seen` then)
  const memo = new Map(), set = memo.set.bind(memo);
  memo.set = (dir, l) => { seen?.push(dir); return set(dir, l); };
  for (const { m } of owners) for (const d of [...gameLayers(m), ...(m.dataMounts ?? []).map((x) => x.dir)]) if (d && !memo.has(d)) listing(d, memo);
  return (file, st, e, rel) => {
    for (const o of owners) {
      const at = resolveGameFile(o.m, rel, memo); if (!at) continue;
      let ost; try { ost = at === file ? st : fs.statSync(at); } catch { continue; }
      if (ost.ino !== st.ino || ost.dev !== st.dev || ost.size !== st.size || ost.mtimeMs !== st.mtimeMs) continue;
      if (e.light && !o.m.lightCopies) return;
      e.owner = o.id; return;
    }
  };
}

/**
 * The state of folders (listGameTree's `seen`): a file or folder added, removed or renamed in one of them — a version,
 * a map, an engine release installed — changes it; a folder there or gone too. One stat a folder, not one a file (a
 * game has ~50 times more files than folders: Morrowind and its mods, 42 000 files in 565 folders).
 */
export function dirsStamp(dirs) {
  let stamp = '', now = Date.now();
  for (const dir of dirs) {
    try {
      const st = fs.statSync(dir);
      // (changed within DirListings.RECENT_MS: a stamp of its own each time — two changes in one tick of the file
      // system's clock leave the same mtime, the second one unseen)
      stamp += now - Math.max(st.mtimeMs, st.ctimeMs) < DirListings.RECENT_MS ? `r${Math.random()};` : `${st.ino}:${st.mtimeMs}:${st.ctimeMs};`;
    } catch { stamp += '-;'; }
  }
  return stamp;
}

/**
 * The folders' listings kept across requests (a `memo` of resolveGameFile), each checked at each use by one stat of its
 * folder — a file added, removed or renamed there changes the folder's mtime: listed again. Without it each /gamez
 * request listed every folder of its path in every layer (readdir of a texture folder of thousands of files: under 20
 * players, 5.5 s of the server's thread in 30 s, measured). At most `maxNames` names kept (least recently used out).
 */
export class DirListings {
  constructor(maxNames = 400000) { this.maxNames = maxNames; this.names = 0; this.map = new Map(); this.pending = new Map(); }
  // (null: the folder changed within the last RECENT_MS — a file system's times are coarse, a few ms on Linux: two
  // changes in one tick leave the same mtime —, listed again at each use until it is older)
  static stamp(dir) {
    try {
      const st = fs.statSync(dir);
      return Date.now() - Math.max(st.mtimeMs, st.ctimeMs) < DirListings.RECENT_MS ? null : `${st.ino}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch { return '-'; }
  }
  get(dir) {
    const stamp = DirListings.stamp(dir), e = this.map.get(dir);
    if (e && stamp !== null && e.stamp === stamp) { this.map.delete(dir); this.map.set(dir, e); return e.l; }
    if (e) { this.map.delete(dir); this.names -= e.n; }
    this.pending.set(dir, stamp); // (the folder's state before it is listed: changed while listed, listed again next time)
    return undefined;
  }
  set(dir, l) {
    const stamp = this.pending.has(dir) ? this.pending.get(dir) : DirListings.stamp(dir); this.pending.delete(dir);
    const old = this.map.get(dir); if (old) { this.map.delete(dir); this.names -= old.n; }
    const n = (l?.kinds.size ?? 0) + 1;
    this.map.set(dir, { stamp, l, n }); this.names += n;
    for (const [k, v] of this.map) { if (this.names <= this.maxNames || k === dir) break; this.map.delete(k); this.names -= v.n; }
    return this;
  }
  get size() { return this.map.size; }
}
DirListings.RECENT_MS = 2000;

/** The light copy of a version's path under LIGHT_DIR: { file, st, copy } (light-copies.js), or null. */
export function resolveLightFile(manifest, rel, memo = null) {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!manifest.lightCopies || parts[0] !== LIGHT_DIR) return null;
  const file = resolveGameFile(manifest, parts.slice(1).join('/'), memo); if (!file) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  const copy = lightCopy(file, st);
  return copy ? { file, st, copy } : null;
}

/**
 * Resolve a guest path through all layers, with the version taking precedence (a data mount's under its folder).
 * `memo` (a Map): the folders' listings kept between calls — many paths resolved at once (a launch set's).
 */
export function resolveGameFile(manifest, rel, memo = null) {
  const top = rel.replace(/\\/g, '/').split('/').filter(Boolean)[0];
  const mount = (manifest.dataMounts ?? []).find((m) => m.at === top);
  if (mount) return resolveIn([mount.dir], rel.replace(/\\/g, '/').split('/').filter(Boolean).slice(1).join('/'), memo);
  return resolveIn(gameLayers(manifest), rel, memo);
}

/**
 * A folder's entries: { kinds: name -> 'file' | 'dir' | null (neither), lower: lower-case name -> its first name }, or
 * null (no such folder); from `memo` when it has them. A link is what it points to.
 */
function listing(dir, memo) {
  let l = memo?.get(dir);
  if (l === undefined) {
    l = null;
    try {
      const kinds = new Map(), lower = new Map();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        let kind = e.isFile() ? 'file' : e.isDirectory() ? 'dir' : null;
        if (e.isSymbolicLink()) try { const st = fs.statSync(path.join(dir, e.name)); kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : null; } catch { kind = null; }
        kinds.set(e.name, kind);
        if (!lower.has(e.name.toLowerCase())) lower.set(e.name.toLowerCase(), e.name);
      }
      l = { kinds, lower };
    } catch { /* not a folder */ }
    memo?.set(dir, l);
  }
  return l;
}

function resolveIn(layers, rel, memo = null) {
  let dirs = layers;
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null;
  for (let i = 0; i < parts.length; i++) {
    const nextDirs = [];
    let file = null;
    for (const dir of dirs) {
      const l = listing(dir, memo); if (!l) continue;
      const hit = l.kinds.has(parts[i]) ? parts[i] : l.lower.get(parts[i].toLowerCase());
      if (!hit) continue;
      const p = path.join(dir, hit), kind = l.kinds.get(hit);
      if (kind === 'file') { if (!nextDirs.length) { file = p; break; } continue; }
      if (kind === 'dir') nextDirs.push(p);
    }
    if (file) return i === parts.length - 1 ? file : null;
    if (!nextDirs.length) return null;
    dirs = nextDirs;
  }
  return null;
}
