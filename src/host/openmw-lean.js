// OpenMW engine releases: the engine's data package without the example world (docs/openmw.md "The engine's
// package"). An OpenMW-Web build preloads one Emscripten package (openmw.data, 204 MB; 33 MB in brotli) holding the
// engine's resources and the free example world it boots with ?nomw (/gamedata/: 144 MB, 22 MB of the brotli). A game
// of its own (Morrowind: every data path of the engine page writes an openmw.cfg without data=/gamedata) never reads
// /gamedata, yet every new player downloaded it before the menu: 4 to 5 minutes of an 85 KB/s link. The lean package is
// the same package — same size, the same offsets, the metadata in openmw.js unchanged — with the example world's bytes
// zeroed, which brotli turns into almost nothing. Made once per release by a niced child (openmw-lean-worker.js) into
// the server's cache directory, served immutable under /engines/<release>/lean<rule>/<build>/openmw.data; until it is
// there the page loads the release's own package. The page asks for it unless it boots the example world.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engineFile } from './goldsrc.js';

/** The rule that made a lean package (its URL and file carry it: a new rule is a new immutable URL). */
export const LEAN_RULE = 1;
/** The example world's folder in the package: the files left out. */
const EXAMPLE_DIR = '/gamedata/';
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'openmw-lean-worker.js');

/** The package's files in Emscripten's metadata (the openmw.js of the build): [{ name, start, end }]. */
export const packageFiles = (js) => [...js.matchAll(/filename:"([^"]*)",start:(\d+),end:(\d+)/g)].map((m) => ({ name: m[1], start: Number(m[2]), end: Number(m[3]) }));
/** The byte ranges a lean package zeroes: the example world's files ([start, end), in order). */
export const leanRanges = (js) => packageFiles(js).filter((f) => f.name.startsWith(EXAMPLE_DIR) && f.end > f.start).map((f) => [f.start, f.end]).sort((a, b) => a[0] - b[0]);

/** The build directory (e/<hash>) of an engine release that has a package, from its release.json: hash or null. */
function buildOf(enginesDir, release) {
  try {
    const r = JSON.parse(fs.readFileSync(engineFile(enginesDir, release, 'release.json'), 'utf8'));
    const f = (r.files ?? []).find((x) => /^e\/[0-9a-f]+\/openmw\.data$/.test(x));
    return f ? f.split('/')[1] : null;
  } catch { return null; }
}

/**
 * The lean packages of the installed engine releases, kept in `dir` (<dir>/<release>/lean<rule>/<build>/openmw.data.br).
 * `url(release)`: the page's address of the release's lean package once made (its making started otherwise: null until
 * then); `file(release, rest)`: the file for a request of /engines/<release>/<rest>, or null.
 */
export function leanPackages({ dir, enginesDir, log = () => {} }) {
  const making = new Map(); // release -> true while its child runs, false once it failed (not tried again this run)
  const outOf = (release, build) => path.join(dir, release, `lean${LEAN_RULE}`, build, 'openmw.data.br');
  const make = (release, build) => {
    if (making.has(release)) return;
    const data = engineFile(enginesDir, release, `e/${build}/openmw.data`), js = engineFile(enginesDir, release, `e/${build}/openmw.js`);
    if (!data || !js) { making.set(release, false); return; }
    const out = outOf(release, build), t0 = Date.now();
    making.set(release, true);
    let child;
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      child = fork(WORKER, [data, js, out], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      try { os.setPriority(child.pid, 19); } catch { /* not allowed: as it is */ }
    } catch (e) { making.set(release, false); log(`openmw lean package ${release}: ${e.message}`); return; }
    child.on('exit', (code) => {
      if (code === 0 && fs.existsSync(out)) { making.delete(release); log(`openmw lean package ${release}: ${fs.statSync(out).size} bytes in ${Math.round((Date.now() - t0) / 1000)} s`); }
      else { making.set(release, false); log(`openmw lean package ${release}: failed (${code})`); }
    });
  };
  return {
    url(release) {
      const build = buildOf(enginesDir, release); if (!build) return null;
      if (fs.existsSync(outOf(release, build))) return `/engines/${release}/lean${LEAN_RULE}/${build}/`;
      make(release, build);
      return null;
    },
    /** The bytes of the release's lean package (brotli), or null when it is not made. */
    size(release) {
      const build = buildOf(enginesDir, release); if (!build) return null;
      try { return fs.statSync(outOf(release, build)).size; } catch { return null; }
    },
    file(release, rest) {
      const m = new RegExp(`^lean${LEAN_RULE}/([0-9a-f]+)/openmw\\.data$`).exec(rest);
      if (!m || buildOf(enginesDir, release) !== m[1]) return null;
      const f = outOf(release, m[1]);
      return fs.existsSync(f) ? f : null;
    },
  };
}

/**
 * The engine page loading the lean package (its address `leanUrl`, a directory) in place of the release's own, unless
 * it boots the example world (?nomw, or the page's own __FORCE_NOMW).
 */
export const withLeanPackage = (html, leanUrl) => !leanUrl ? html : html.replace('locateFile: function(path){ return __ENGINE_DIR + path; }',
  `locateFile: function(path){ return (path === 'openmw.data' && !(window.__FORCE_NOMW || /[?&]nomw\\b/.test(location.search)) ? ${JSON.stringify(leanUrl)} : __ENGINE_DIR) + path; }`);
