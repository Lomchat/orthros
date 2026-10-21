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
 * file's entry completed (its light copy's size).
 */
function mergeDir(layers, mark = null) {
  const node = { dirs: {}, files: {} }, entries = new Map();
  for (const dir of layers) {
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
    if (entry.dirs) node.dirs[entry.name] = mergeDir(entry.dirs, mark);
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
 * marked `media: true`.
 */
export function listGameTree(manifest) {
  const mark = manifest.lightCopies ? (file, st, e) => { const c = lightCopy(file, st); if (c) e.light = c.size; } : null;
  const tree = mergeDir(gameLayers(manifest), mark);
  for (const { at, dir } of manifest.dataMounts ?? []) if (fs.existsSync(dir)) tree.dirs[at] = mergeDir([dir], mark);
  return tree;
}

/** The light copy of a version's path under LIGHT_DIR: { file, st, copy } (light-copies.js), or null. */
export function resolveLightFile(manifest, rel) {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!manifest.lightCopies || parts[0] !== LIGHT_DIR) return null;
  const file = resolveGameFile(manifest, parts.slice(1).join('/')); if (!file) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  const copy = lightCopy(file, st);
  return copy ? { file, st, copy } : null;
}

/** Resolve a guest path through all layers, with the version taking precedence (a data mount's under its folder). */
export function resolveGameFile(manifest, rel) {
  const top = rel.replace(/\\/g, '/').split('/').filter(Boolean)[0];
  const mount = (manifest.dataMounts ?? []).find((m) => m.at === top);
  if (mount) return resolveIn([mount.dir], rel.replace(/\\/g, '/').split('/').filter(Boolean).slice(1).join('/'));
  return resolveIn(gameLayers(manifest), rel);
}

function resolveIn(layers, rel) {
  let dirs = layers;
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null;
  for (let i = 0; i < parts.length; i++) {
    const nextDirs = [];
    let file = null;
    for (const dir of dirs) {
      let names; try { names = fs.readdirSync(dir); } catch { continue; }
      const hit = names.find((n) => n === parts[i]) ?? names.find((n) => n.toLowerCase() === parts[i].toLowerCase());
      if (!hit) continue;
      const p = path.join(dir, hit), st = fs.statSync(p);
      if (st.isFile()) { if (!nextDirs.length) { file = p; break; } continue; }
      if (st.isDirectory()) nextDirs.push(p);
    }
    if (file) return i === parts.length - 1 ? file : null;
    if (!nextDirs.length) return null;
    dirs = nextDirs;
  }
  return null;
}
