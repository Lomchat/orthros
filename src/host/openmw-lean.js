// OpenMW engine releases: the engine's data package without what a game of its own never reads (docs/openmw.md "The
// engine's package"). An OpenMW-Web build preloads one Emscripten package (openmw.data, 204 MB; 33 MB in brotli) holding
// the engine's resources, the free example world it boots with ?nomw (/gamedata/: 144 MB, 22 MB of the brotli) and ICU's
// data twice (/icu/icudt68l.dat, the one the engine opens: u_setDataDirectory("/icu") in its main.cpp, and an unused
// root copy, 28.5 MB apart — beyond brotli's window, so 7 MB of brotli each). A game of its own (Morrowind: every data
// path of the engine page writes an openmw.cfg without data=/gamedata) never reads /gamedata nor the root copy, yet every
// new player downloaded them before the menu. The lean package is the same package — same size, the same offsets, the
// metadata in openmw.js unchanged — with those bytes zeroed, which brotli turns into almost nothing. Keyed by the
// package's CONTENT (its sha256: release.json engineFiles, else hashed once), not by the release: engine releases that
// change only the wasm (r8 -> r9 -> r10 -> r11 in one day) share one package, which a returning player's browser keeps.
// Made once per content and rule by a niced child (openmw-lean-worker.js) into the server's cache directory, served
// immutable under /engines/_c/<sha256>/lean<rule>/openmw.data; until it is there (being made, or failed) the page loads
// the newest lean package already on disk for it (an earlier rule's, or an earlier server's release-keyed one), else the
// release's own package. The page asks for it unless it boots the example world. The release-keyed addresses of earlier servers
// (/engines/<release>/lean<n>/<build>/openmw.data) keep answering for the pages still open with them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engineFile } from './goldsrc.js';

/**
 * The rule that made a lean package (its URL and file carry it: a new rule is a new immutable URL). 1: the example
 * world zeroed; 2: ICU's unused root copy too.
 */
export const LEAN_RULE = 2;
/** The example world's folder in the package: the files left out. */
const EXAMPLE_DIR = '/gamedata/';
/**
 * ICU's data: the copy the engine opens (u_setDataDirectory("/icu"), before any ICU use — the page's ENV.ICU_DATA='/'
 * does nothing in this build) and the root copy the build stages beside it (tools/openmw/build.sh), left out only when
 * the opened one is there.
 */
const ICU_OPENED = '/icu/icudt68l.dat', ICU_UNUSED = '/icudt68l.dat';
const SHA256 = /^[0-9a-f]{64}$/;
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'openmw-lean-worker.js');

/** The package's files in Emscripten's metadata (the openmw.js of the build): [{ name, start, end }]. */
export const packageFiles = (js) => [...js.matchAll(/filename:"([^"]*)",start:(\d+),end:(\d+)/g)].map((m) => ({ name: m[1], start: Number(m[2]), end: Number(m[3]) }));
/**
 * The byte ranges a lean package zeroes ([start, end), in order): the example world's files, and ICU's root copy when
 * the package has the copy the engine opens (by name: a release without the root copy zeroes the example world only).
 */
export const leanRanges = (js) => {
  const files = packageFiles(js), opened = files.some((f) => f.name === ICU_OPENED && f.end > f.start);
  return files.filter((f) => (f.name.startsWith(EXAMPLE_DIR) || opened && f.name === ICU_UNUSED) && f.end > f.start).map((f) => [f.start, f.end]).sort((a, b) => a[0] - b[0]);
};

/**
 * The package of an engine release, from its release.json: { build (the e/<hash> directory), data, js (their files),
 * sha (its openmw.data's sha256 as the release says, engineFiles, or null) } or null when it has none.
 */
function packageOf(enginesDir, release) {
  try {
    const r = JSON.parse(fs.readFileSync(engineFile(enginesDir, release, 'release.json'), 'utf8'));
    const f = (r.files ?? []).find((x) => /^e\/[0-9a-f]+\/openmw\.data$/.test(x)); if (!f) return null;
    const build = f.split('/')[1], sha = r.engineFiles?.['openmw.data'];
    return { build, data: engineFile(enginesDir, release, f), js: engineFile(enginesDir, release, `e/${build}/openmw.js`), sha: SHA256.test(sha ?? '') ? sha : null };
  } catch { return null; }
}

/**
 * The lean packages of the installed engine releases, kept in `dir` by content (<dir>/_c/<sha256>/lean<rule>/
 * openmw.data.br; earlier servers' <dir>/<release>/lean<n>/<build>/ still served). `url(release)`: the page's address
 * of the release's lean package once made (its making started otherwise — after hashing its package when the release
 * does not say its sha256 —: meanwhile an older lean package of it on disk, else null); `pending(release)`: its making
 * (or hashing) runs with no older one to give (the page will ask for the lean package once it is there, not for the
 * release's own: nothing to prepare meanwhile); `size(release)`: the brotli bytes of the one url() gives; `decoded(release)`: its decoded bytes (the release's own package's: the same size); `file(release,
 * rest)`: the file for a request of /engines/<release>/<rest> (an earlier server's address), or null;
 * `contentFile(sha, rest)`: { file, decoded } for a request of /engines/_c/<sha>/<rest>, or null.
 */
export function leanPackages({ dir, enginesDir, log = () => {} }) {
  const making = new Map(); // sha -> true while its child runs, false once it failed (not tried again this run)
  const hashes = new Map(); // "<file>\0<size>\0<mtime>" -> sha256, null while hashed, false once failed
  const sizes = new Map(); // sha -> the package's decoded bytes (a release's that has it)
  const outOf = (sha, rule = LEAN_RULE) => path.join(dir, '_c', sha, `lean${rule}`, 'openmw.data.br');
  const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const make = (sha, pkg) => {
    if (making.has(sha)) return;
    if (!pkg.data || !pkg.js) { making.set(sha, false); return; }
    const out = outOf(sha), t0 = Date.now();
    making.set(sha, true);
    let child;
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      child = fork(WORKER, [pkg.data, pkg.js, out, sha], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      try { os.setPriority(child.pid, 19); } catch { /* not allowed: as it is */ }
    } catch (e) { making.set(sha, false); log(`openmw lean package ${sha.slice(0, 12)}: ${e.message}`); return; }
    child.on('exit', (code) => {
      if (code === 0 && exists(out)) { making.delete(sha); log(`openmw lean package ${sha.slice(0, 12)} (lean${LEAN_RULE}): ${fs.statSync(out).size} bytes in ${Math.round((Date.now() - t0) / 1000)} s`); }
      else { making.set(sha, false); log(`openmw lean package ${sha.slice(0, 12)}: failed (${code})`); }
    });
  };
  /**
   * The release's package with its sha256 ({ ...packageOf, sha }), or null: none, or its hashing runs (started here
   * when the release does not say it, once per file, size and mtime; its making follows).
   */
  const keyed = (release) => {
    const pkg = packageOf(enginesDir, release); if (!pkg?.data) return null;
    let st; try { st = fs.statSync(pkg.data); } catch { return null; }
    let sha = pkg.sha;
    if (!sha) {
      const key = `${pkg.data}\0${st.size}\0${st.mtimeMs}`;
      sha = hashes.get(key);
      if (sha === undefined) {
        hashes.set(key, null);
        const h = crypto.createHash('sha256');
        fs.createReadStream(pkg.data, { highWaterMark: 1 << 20 }).on('data', (b) => h.update(b))
          .on('error', (e) => { hashes.set(key, false); log(`openmw lean package ${release}: ${e.message}`); })
          .on('end', () => { const s = h.digest('hex'); hashes.set(key, s); sizes.set(s, st.size); if (!exists(outOf(s))) make(s, { ...pkg, sha: s }); });
      }
      if (!sha) return null;
    }
    sizes.set(sha, st.size);
    return { ...pkg, sha };
  };
  /** Is the release's package being hashed? */
  const hashing = (release) => {
    const pkg = packageOf(enginesDir, release); if (!pkg?.data || pkg.sha) return false;
    try { const st = fs.statSync(pkg.data); return hashes.get(`${pkg.data}\0${st.size}\0${st.mtimeMs}`) === null; } catch { return false; }
  };
  /**
   * The lean package a page of the release is given: { url, file } — this content's under the current rule (its making
   * started otherwise), else, while that one is made or after it failed, the newest already on disk for the same
   * package: an earlier rule's of this content, or an earlier server's release-keyed file of this build (served by
   * contentFile / file, a lighter package than the release's own) — or null (none: the release's own package).
   */
  const chosen = (release) => {
    const pkg = keyed(release);
    if (pkg) {
      if (exists(outOf(pkg.sha))) return { url: `/engines/_c/${pkg.sha}/lean${LEAN_RULE}/`, file: outOf(pkg.sha) };
      make(pkg.sha, pkg);
      for (let n = LEAN_RULE - 1; n >= 1; n--) if (exists(outOf(pkg.sha, n))) return { url: `/engines/_c/${pkg.sha}/lean${n}/`, file: outOf(pkg.sha, n) };
    }
    // (being hashed, or no sha: the release-keyed files need only the build)
    const own = pkg ?? packageOf(enginesDir, release); if (!own?.build) return null;
    for (let n = LEAN_RULE; n >= 1; n--) {
      const f = path.join(dir, release, `lean${n}`, own.build, 'openmw.data.br');
      if (exists(f)) return { url: `/engines/${release}/lean${n}/${own.build}/`, file: f };
    }
    return null;
  };
  return {
    url(release) { return chosen(release)?.url ?? null; },
    pending(release) {
      // (made once its file is there, the child's exit seen or not yet; an older lean package on disk meanwhile: the
      // page asks for that one, nothing pending)
      if (chosen(release)) return false;
      if (hashing(release)) return true;
      const pkg = keyed(release);
      return !!pkg && making.get(pkg.sha) === true;
    },
    decoded(release) {
      const pkg = packageOf(enginesDir, release);
      try { return pkg?.data ? fs.statSync(pkg.data).size : null; } catch { return null; }
    },
    /** The bytes of the release's lean package (brotli), or null when it is not made. */
    size(release) {
      const c = chosen(release); if (!c) return null;
      try { return fs.statSync(c.file).size; } catch { return null; }
    },
    file(release, rest) {
      // (an earlier server's address of the release's build: its own file while kept, else this content's — the same
      // package, its offsets and size unchanged, only bytes no game of its own reads zeroed)
      const m = /^lean(\d+)\/([0-9a-f]+)\/openmw\.data$/.exec(rest);
      const pkg = m && packageOf(enginesDir, release);
      if (!pkg || pkg.build !== m[2]) return null;
      const old = path.join(dir, release, `lean${m[1]}`, m[2], 'openmw.data.br');
      if (exists(old)) return old;
      const now = keyed(release);
      return now && exists(outOf(now.sha)) ? outOf(now.sha) : null;
    },
    contentFile(sha, rest) {
      // (any rule's file kept: a page opened before a new rule asks for the one it was given)
      const m = /^lean(\d+)\/openmw\.data$/.exec(rest);
      if (!SHA256.test(sha) || !m) return null;
      const f = outOf(sha, m[1]);
      return exists(f) ? { file: f, decoded: sizes.get(sha) ?? null } : null;
    },
  };
}

/**
 * The engine page loading the lean package (its address `leanUrl`, a directory) in place of the release's own, unless
 * it boots the example world (?nomw, or the page's own __FORCE_NOMW).
 */
export const withLeanPackage = (html, leanUrl) => !leanUrl ? html : html.replace('locateFile: function(path){ return __ENGINE_DIR + path; }',
  `locateFile: function(path){ return (path === 'openmw.data' && !(window.__FORCE_NOMW || /[?&]nomw\\b/.test(location.search)) ? ${JSON.stringify(leanUrl)} : __ENGINE_DIR) + path; }`);
