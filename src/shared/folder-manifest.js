// Manifests for bare game folders, the same rules wherever the folder comes from: `orthros run <folder>` (the server,
// src/server/manifest.js, reading the disk) and a folder the player drops in the page (src/vfs/local-games.js, reading
// the browser's File objects). The main executable is chosen by generic rules (never by game name): executables at the
// top of the folder (else one level down), minus the usual installer / updater / launcher / crash-reporter tools,
// preferring the one whose name matches the folder's, then the largest.

/** Executable names that are not the game itself (installers, updaters, launchers, tools, redistributables). */
export const NOT_THE_GAME = /^(setup|install|uninst|unins\d*|unwise|autorun|config|configure|settings|patch|update|updater|launcher|crash|bugreport|errorreport|report|dxsetup|dxwebsetup|vcredist|directx|register|registration|activation|readme|support|easetup|eauninstall|touchup|cleanup|dotnet|oalinst|physx)/i;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The game executable among a folder's files (relative '/'-separated paths with their size; `folder`: the folder's
 * name), or null: the candidates are the executables at the top level, else one level down.
 * @param {{ path: string, size?: number }[]} files @param {string} folder @returns {string|null}
 */
export function pickExeFrom(files, folder) {
  const exe = (f) => /\.exe$/i.test(f.path);
  let all = files.filter((f) => exe(f) && !f.path.includes('/'));
  if (!all.length) all = files.filter((f) => exe(f) && f.path.split('/').length === 2);
  if (!all.length) return null;
  const base = (p) => p.split('/').pop().replace(/\.exe$/i, '');
  const games = all.filter((f) => !NOT_THE_GAME.test(base(f.path)) && !/uninstall|setup/i.test(base(f.path)));
  const pool = games.length ? games : all;
  const name = norm(folder);
  const score = (f) => { const n = norm(base(f.path)); return n && (name.includes(n) || n.includes(name)) ? 1 : 0; };
  return pool.slice().sort((a, b) => score(b) - score(a) || (b.size ?? 0) - (a.size ?? 0))[0].path;
}

/** Defaults shared by every manifest source. */
export function withDefaults(m) {
  m.mount ??= 'C:\\Game'; m.args ??= ''; m.dllOverrides ??= {}; m.env ??= {}; m.display ??= { width: 1024, height: 768 };
  return m;
}
