// Manifests for bare game folders: `orthros run <folder>` needs no per-game file. The main executable is chosen by the
// generic rules of src/shared/folder-manifest.js (shared with the folders players drop in the page). A manifest.json
// in the folder, or explicit options, override the guess.
import fs from 'node:fs';
import path from 'node:path';
import { pickExeFrom, withDefaults } from '../shared/folder-manifest.js';

export { withDefaults };

/** The executables of `dir` (relative paths, '/'-separated, with their size): top level and one level down. */
function executables(dir) {
  const out = [], size = (p) => { try { return fs.statSync(path.join(dir, p)).size; } catch { return 0; } };
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) out.push(e.name);
    else if (e.isDirectory()) { try { for (const f of fs.readdirSync(path.join(dir, e.name))) if (f.toLowerCase().endsWith('.exe')) out.push(`${e.name}/${f}`); } catch { /* unreadable */ } }
  }
  return out.map((p) => ({ path: p, size: size(p) }));
}

/** The game executable of `dir` (relative path) or null (the shared rules: src/shared/folder-manifest.js). */
export const pickExe = (dir) => pickExeFrom(executables(dir), path.basename(path.resolve(dir)));

/**
 * Manifest for a folder (its manifest.json when present, else synthesized) with the defaults filled in;
 * `over` (exe, args, ...) takes precedence.
 */
export function folderManifest(dir, over = {}) {
  const file = path.join(dir, 'manifest.json');
  const m = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  Object.assign(m, Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)));
  m.exe ??= pickExe(dir);
  if (!m.exe) throw new Error(`no executable found in ${dir}`);
  m.name ??= path.basename(path.resolve(dir));
  m.folder = path.resolve(dir);
  return withDefaults(m);
}
