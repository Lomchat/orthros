// A game's base installation and a version's overrides form one read-only folder (an re3 port's engine files over
// both, the files of the versions a GoldSrc port requires beneath).
import fs from 'node:fs';
import path from 'node:path';

export function gameLayers(manifest) {
  // (underlays: the folders of versions a GoldSrc port requires, beneath its own; overlays: folders over the version's
  // own, an re3 port's engine files — both from game-catalog.js)
  return [...(manifest.overlays ?? []), ...(manifest.baseFolder ? [manifest.folder, manifest.baseFolder] : [manifest.folder]), ...(manifest.underlays ?? [])];
}

/** List one layer, replacing same-named entries without changing the guest-visible path. */
function mergeDir(layers) {
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
    if (entry.dirs) node.dirs[entry.name] = mergeDir(entry.dirs);
    else { const st = fs.statSync(entry.file); node.files[entry.name] = { size: st.size, mtime: st.mtimeMs }; }
  }
  return node;
}

/**
 * The game's files as the browsers read them: its layers, and the folders of its engine's release it serves beside them
 * (`dataMounts`: [{ at, dir }] — an engine's own data, as OpenMW's asset pack, under a folder of its own, `at`; not part
 * of the game's layers, which a native server laying out the game reads too).
 */
export function listGameTree(manifest) {
  const tree = mergeDir(gameLayers(manifest));
  for (const { at, dir } of manifest.dataMounts ?? []) if (fs.existsSync(dir)) tree.dirs[at] = mergeDir([dir]);
  return tree;
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
