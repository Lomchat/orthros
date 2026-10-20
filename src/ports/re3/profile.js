// The player's profile of an re3 port (docs/browser-ports.md, "re3 ports"). The engine reads the game's files and
// writes its own — saves and settings (its "userfiles" folder), its ini file, maybe caches — in one folder, the game
// root, where the page mounted the game's files (../goldsrc/files.js). The profile is every regular file there that is
// not a mounted game file: created by the engine, or a game file it replaced. It is kept as { path relative to the
// root, data }, in IndexedDB and on the player's account, and put back before the engine starts.
import { bytesToText, textToBytes, setIni } from './ini.js';

/** A profile path: relative, '/'-separated, no empty, '.' or '..' part, no control character. */
export const profilePathOk = (p) => typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.startsWith('/') && !p.includes('\\') && !/[\x00-\x1f]/.test(p) && p.split('/').every((x) => x && x !== '.' && x !== '..');

const nodeAt = (FS, at) => { try { return FS.lookupPath(at, { follow: false }).node; } catch { return null; } };

/**
 * The profile's files under `root` ([{ path, data }], paths relative to it): every regular file but the mounted game
 * files (`game`: their nodes — never read: their bytes may not be here yet).
 */
export function profileSnapshot(FS, root, game) {
  const files = [];
  (function walk(dir, rel) {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const at = `${dir}/${name}`, node = nodeAt(FS, at);
      if (!node || game.has(node)) continue;
      if (FS.isDir(node.mode)) walk(at, `${rel}${name}/`);
      else if (FS.isFile(node.mode)) files.push({ path: rel + name, data: FS.readFile(at) });
    }
  })(root, '');
  return files;
}

/**
 * The profile's files put back under `root`, before the engine starts: each in place of a game file of the same path
 * (the engine had replaced it). A file that cannot be put back (its path a folder, an invalid path) is told and left out.
 */
export function restoreProfile(FS, root, files, log = () => {}) {
  for (const f of files ?? []) {
    if (!profilePathOk(f?.path) || !ArrayBuffer.isView(f.data)) { log(`Profile: ${String(f?.path).slice(0, 80)} left out (invalid)`); continue; }
    const at = `${root}/${f.path}`;
    try {
      FS.mkdirTree(at.slice(0, at.lastIndexOf('/')));
      const old = nodeAt(FS, at);
      if (old && FS.isDir(old.mode)) { log(`Profile: ${f.path} left out (a folder there)`); continue; }
      if (old) FS.unlink(at);
      FS.writeFile(at, f.data);
    } catch (e) { log(`Profile: ${f.path} left out (${e.message})`); }
  }
}

/**
 * `rel` under `root` spelled as what is there, whatever the case of its parts (the engine's own way: it lists folders):
 * `found`, the whole path is there; else its parts from the first missing one on as `rel` has them.
 */
export function casePath(FS, root, rel) {
  let dir = root, found = true;
  const parts = rel.split('/').map((part) => {
    let hit = null;
    if (found) {
      let names = null; try { names = FS.readdir(dir); } catch { /* not a folder */ }
      hit = names && (names.find((n) => n === part) ?? names.find((n) => n.toLowerCase() === part.toLowerCase()));
      if (!hit) found = false;
    }
    dir = `${dir}/${hit ?? part}`;
    return hit ?? part;
  });
  return { path: parts.join('/'), found };
}

/** The path under `root` that `rel` names, whatever the case of its parts, or null. */
export const findPath = (FS, root, rel) => { const p = casePath(FS, root, rel); return p.found ? p.path : null; };

/**
 * A language's settings put in the ini file `rel` of the profile (setIni: the rest of the file kept as it is): the
 * file the profile has under that name whatever its case; else the game's own, copied into the profile even when its
 * settings are already these — a mounted game file is read-only, and the engine writes its settings there; else a new
 * one, in the folders there whatever their case. Returns what was done: 'same', 'set', 'copied' or 'created'. `edit`:
 * how the settings go in (setIni; setIniDefaults: defaults set once).
 */
export function setProfileIni(FS, root, rel, sections, game, edit = setIni) {
  const { path: p, found } = casePath(FS, root, rel), at = `${root}/${p}`, node = found ? nodeAt(FS, at) : null;
  if (node && !FS.isFile(node.mode)) return 'same';
  const before = node ? bytesToText(FS.readFile(at)) : '', after = edit(before, sections);
  if (!node) {
    if (!after) return 'same';
    FS.mkdirTree(at.slice(0, at.lastIndexOf('/')));
    FS.writeFile(at, textToBytes(after));
    return 'created';
  }
  if (game.has(node)) FS.unlink(at); // (a game file: the profile's own copy from now on)
  else if (after === before) return 'same';
  FS.writeFile(at, textToBytes(after));
  return after === before ? 'copied' : 'set';
}

/**
 * The ini settings a game language puts in the profile ([file, sections]): for every file one of the version's
 * languages names (re3.languages.<code>.ini, file names without case), this language's sections, else none — the
 * game's own file then still copied into the profile (setProfileIni), whichever language the player chose.
 */
export function languageIni(languages, language) {
  const out = new Map();
  for (const own of Object.values(languages ?? {})) for (const file of Object.keys(own?.ini ?? {})) if (!out.has(file.toLowerCase())) out.set(file.toLowerCase(), [file, {}]);
  for (const [file, sections] of Object.entries(languages?.[language]?.ini ?? {})) out.set(file.toLowerCase(), [file, sections]);
  return [...out.values()];
}

/**
 * A language's environment variables (re3.languages.<code>.env) as the Module's preRun hook: set in its ENV before the
 * runtime starts — the C library copies the environment once, as its constructors run, before the Module is handed
 * over: set later, getenv() never sees it.
 */
export const envPreRun = (env, log = () => {}) => (M) => {
  for (const [key, value] of Object.entries(env ?? {})) { if (M.ENV) M.ENV[key] = value; else log(`${key}: the engine exposes no environment`); }
};

// What the account keeps of a profile (src/host/web/cloud-sync.js): its files less what the engine makes again —
// logs and screenshots.
const KEEP = (path) => !/(^|\/)(screenshots|logs)\//i.test(path) && !/\.log$/i.test(path);
/** A profile's files as the account keeps them. */
export const toCloud = (list) => (list ?? []).filter((f) => KEEP(f.path));
