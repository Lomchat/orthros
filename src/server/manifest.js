// Manifests for bare game folders: `orthros run <folder>` needs no per-game file. The main executable is chosen
// by generic rules (never by game name): executables at the top of the folder (else one level down), minus the
// usual installer / updater / launcher / crash-reporter tools, preferring the one whose name matches the folder's,
// then the largest. A manifest.json in the folder, or explicit options, override the guess.
import fs from 'node:fs';
import path from 'node:path';

/** Executable names that are not the game itself (installers, updaters, launchers, tools, redistributables). */
const NOT_THE_GAME = /^(setup|install|uninst|unins\d*|unwise|autorun|config|configure|settings|patch|update|updater|launcher|crash|bugreport|errorreport|report|dxsetup|dxwebsetup|vcredist|directx|register|registration|activation|readme|support|easetup|eauninstall|touchup|cleanup|dotnet|oalinst|physx)/i;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The candidate executables of `dir` (relative paths, '/'-separated): top level, else one level down. */
function executables(dir) {
  const top = fs.readdirSync(dir, { withFileTypes: true });
  const here = top.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe')).map((e) => e.name);
  if (here.length) return here;
  const below = [];
  for (const e of top) {
    if (!e.isDirectory()) continue;
    try { for (const f of fs.readdirSync(path.join(dir, e.name))) if (f.toLowerCase().endsWith('.exe')) below.push(`${e.name}/${f}`); } catch { /* unreadable */ }
  }
  return below;
}

/** The game executable of `dir` (relative path) or null. */
export function pickExe(dir) {
  const all = executables(dir);
  if (!all.length) return null;
  const base = (p) => p.split('/').pop().replace(/\.exe$/i, '');
  const games = all.filter((p) => !NOT_THE_GAME.test(base(p)) && !/uninstall|setup/i.test(base(p)));
  const pool = games.length ? games : all;
  const folder = norm(path.basename(path.resolve(dir)));
  const size = (p) => { try { return fs.statSync(path.join(dir, p)).size; } catch { return 0; } };
  const score = (p) => { const n = norm(base(p)); return n && (folder.includes(n) || n.includes(folder)) ? 1 : 0; };
  return pool.slice().sort((a, b) => score(b) - score(a) || size(b) - size(a))[0];
}

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

/** Defaults shared by every manifest source. */
export function withDefaults(m) {
  m.mount ??= 'C:\\Game'; m.args ??= ''; m.dllOverrides ??= {}; m.env ??= {}; m.display ??= { width: 1024, height: 768 };
  return m;
}
