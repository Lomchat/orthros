// A game's base installation and a version's overrides form one read-only folder (an re3 port's engine files over
// both, the files of the versions a GoldSrc port requires beneath).
import fs from 'node:fs';
import path from 'node:path';
import { LIGHT_DIR, lightCopy } from './light-copies.js';
import { isMediaFile } from '../vfs/game-tree.js';

export function gameLayers(manifest) {
  // (underlays: the folders of versions a GoldSrc port requires, beneath its own; overlays: folders over the version's
  // own, an re3 port's engine files — both from game-catalog.js)
  return [...(manifest.overlays ?? []), ...(manifest.baseFolder ? [manifest.folder, manifest.baseFolder] : [manifest.folder]), ...(manifest.underlays ?? [])];
}

/**
 * List one layer, replacing same-named entries without changing the guest-visible path. `mark(file, entry)`: each
 * file's entry completed (its light copy's size); `seen`: every folder looked at (there or not) pushed to it.
 */
function mergeDir(layers, mark = null, seen = null) {
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
    if (entry.dirs) node.dirs[entry.name] = mergeDir(entry.dirs, mark, seen);
    else {
      const st = fs.statSync(entry.file), e = node.files[entry.name] = { size: st.size, mtime: st.mtimeMs };
      if (isMediaFile(entry.name, st.size)) e.media = true; // (game-tree.js: after the rest on a link that is not fast)
      mark?.(entry.file, st, e);
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
 */
export function listGameTree(manifest, seen = null) {
  const mark = manifest.lightCopies ? (file, st, e) => { const c = lightCopy(file, st); if (c) e.light = c.size; } : null;
  const tree = mergeDir(gameLayers(manifest), mark, seen);
  for (const { at, dir } of manifest.dataMounts ?? []) { if (fs.existsSync(dir)) tree.dirs[at] = mergeDir([dir], mark, seen); else seen?.push(dir); }
  return tree;
}

/**
 * The state of folders (listGameTree's `seen`): a file or folder added, removed or renamed in one of them — a version,
 * a map, an engine release installed — changes it; a folder there or gone too. One stat a folder, not one a file (a
 * game has ~50 times more files than folders: Morrowind and its mods, 42 000 files in 565 folders).
 */
export function dirsStamp(dirs) {
  let stamp = '';
  for (const dir of dirs) { try { const st = fs.statSync(dir); stamp += `${st.ino}:${st.mtimeMs}:${st.ctimeMs};`; } catch { stamp += '-;'; } }
  return stamp;
}

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
