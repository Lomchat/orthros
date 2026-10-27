// OpenMW engine releases: the engine's data package without what a game of its own never reads (docs/openmw.md "The
// engine's package"). An OpenMW-Web build preloads one Emscripten package (openmw.data, 204 MB; 33 MB in brotli) holding
// the engine's resources, the free example world it boots with ?nomw (/gamedata/: 144 MB, 22 MB of the brotli) and ICU's
// data twice (/icu/icudt68l.dat, the one the engine opens: u_setDataDirectory("/icu") in its main.cpp, and an unused
// root copy, 28.5 MB apart — beyond brotli's window, so 7 MB of brotli each). A game of its own (Morrowind: every data
// path of the engine page writes an openmw.cfg without data=/gamedata) never reads /gamedata nor the root copy, yet every
// new player downloaded them before the menu. The lean package is the same package — same size, the same offsets, the
// metadata in openmw.js unchanged — with those bytes zeroed, which brotli turns into almost nothing, and the opened ICU
// copy without the feature trees the engine never opens (rule 3: its table of contents rewritten in place). Keyed by the
// package's CONTENT (its sha256 as the server's engine files by content hash it, engine-content.js: one hashing, one
// rule — the bytes read, a release.json's word only checked), not by the release: engine releases that
// change only the wasm (r8 -> r9 -> r10 -> r11 in one day) share one package, which a returning player's browser keeps.
// Made once per content and rule by a niced child (openmw-lean-worker.js) into the server's cache directory, served
// immutable under /engines/_c/<sha256>/lean<rule>/openmw.data; until it is there (being made, or failed) the page loads
// the newest lean package already on disk for it (an earlier rule's, or an earlier server's release-keyed one), else the
// release's own package. The page asks for it unless it boots the example world. The release-keyed addresses of earlier servers
// (/engines/<release>/lean<n>/<build>/openmw.data) keep answering for the pages still open with them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { engineFile } from './goldsrc.js';
import { engineContent } from './engine-content.js';

/**
 * The rule that made a lean package (its URL and file carry it: a new rule is a new immutable URL). 1: the example
 * world zeroed; 2: ICU's unused root copy too; 3: inside the opened ICU copy, the feature trees no engine call opens
 * (ICU_DROPPED) left out of its table of contents and zeroed.
 */
export const LEAN_RULE = 3;
/** The example world's folder in the package: the files left out. */
const EXAMPLE_DIR = '/gamedata/';
/**
 * ICU's data: the copy the engine opens (u_setDataDirectory("/icu"), before any ICU use — the page's ENV.ICU_DATA='/'
 * does nothing in this build) and the root copy the build stages beside it (tools/openmw/build.sh), left out only when
 * the opened one is there.
 */
const ICU_OPENED = '/icu/icudt68l.dat', ICU_UNUSED = '/icudt68l.dat';
/**
 * The trees of ICU's common data the engine never opens (rule 3), by what opens them in ICU 68 and what the engine
 * calls (docs/openmw.md "The engine's package"): its only ICU uses are MessageFormat (number skeletons ::.00 and
 * :: group-off, plural, select — DecimalFormatSymbols, number patterns, plurals.res, numberingSystems.res, all kept) and
 * Locale::getDisplayName in the Options' language list (lang/ and region/, kept: a mod's zh-cn needs region/).
 * Kept too: curr/ (DecimalFormatSymbols::initialize opens it with the caller's status: without it every number fails),
 * every locale and every root item (converters, normalization, supplemental data). Left out: collation (Collator),
 * break iteration (BreakIterator, toTitle), time-zone names (date formats), transliteration, unit names (MeasureFormat,
 * unit skeletons), rule-based number spelling (spellout/ordinal/duration) — the trees OpenMW's own ICU build filters out
 * too (extern/icufilters.json), plus unit/ and rbnf/.
 */
export const ICU_DROPPED = ['brkitr', 'coll', 'rbnf', 'translit', 'unit', 'zone'];
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
 * The files a lean package rewrites in place (rule 3: [{ start, end, rewrite(bytes) }], in order): the ICU copy the engine
 * opens, its dropped trees left out (leanIcuData). Same length: the offsets of the package stay.
 */
export const leanRewrites = (js) => packageFiles(js).filter((f) => f.name === ICU_OPENED && f.end > f.start)
  .map((f) => ({ start: f.start, end: f.end, rewrite: (b) => leanIcuData(b) ?? b }));

/**
 * ICU's common data (a .dat: a data header, then a table of contents — the item count and, per item sorted by name,
 * its name's and its data's offsets from the table — then the names and the items) without the items of the `drop`
 * trees (their names <prefix>/<tree>/...): the table rewritten with the kept entries only (still sorted: ICU looks items
 * up by binary search), its freed slots, the dropped names and the dropped items' bytes zeroed. The same length and
 * every kept item at its offset; a kept item's length as ICU computes it (the next entry's offset minus its own) may
 * grow over zeroed bytes, which resource bundles bound by their own indexes. Returns a new buffer, or null when `buf`
 * is not little-endian ASCII common data ("CmnD") or its table does not parse (then left whole).
 */
export function leanIcuData(buf, drop = ICU_DROPPED) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.length);
  if (b.length < 32 || b[2] !== 0xda || b[3] !== 0x27) return null;
  const hs = b.readUInt16LE(0);
  // (UDataInfo after the 4-byte header: size, reserved, isBigEndian, charsetFamily, sizeofUChar, reserved, dataFormat)
  if (hs < 24 || hs + 4 > b.length || b[8] !== 0 || b[9] !== 0 || b.toString('latin1', 12, 16) !== 'CmnD') return null;
  const n = b.readUInt32LE(hs), table = hs + 4 + 8 * n;
  if (!n || table > b.length) return null;
  const items = [];
  for (let i = 0; i < n; i++) {
    const name = hs + b.readUInt32LE(hs + 4 + 8 * i), data = hs + b.readUInt32LE(hs + 8 + 8 * i);
    if (name < table || name >= b.length || data < table || data > b.length) return null;
    const end = b.indexOf(0, name); if (end < 0) return null;
    items.push({ entry: b.subarray(hs + 4 + 8 * i, hs + 12 + 8 * i), name, nameEnd: end, data, tree: b.toString('latin1', name, end).split('/') });
  }
  // (an item's bytes run to the next item's start, by offset: the table's order is the names')
  const starts = [...new Set(items.map((x) => x.data))].sort((x, y) => x - y);
  const next = (d) => { let lo = 0, hi = starts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] <= d) lo = m + 1; else hi = m; } return lo < starts.length ? starts[lo] : b.length; };
  const dropped = (x) => x.tree.length > 2 && drop.includes(x.tree[1]);
  const kept = items.filter((x) => !dropped(x));
  if (kept.length === n) return null;
  const out = Buffer.from(b);
  out.writeUInt32LE(kept.length, hs);
  kept.forEach((x, i) => x.entry.copy(out, hs + 4 + 8 * i));
  out.fill(0, hs + 4 + 8 * kept.length, table);
  // (an item another kept entry shares — none in ICU's data, but then its bytes stay)
  const keptData = new Set(kept.map((x) => x.data));
  for (const x of items) if (dropped(x)) { out.fill(0, x.name, x.nameEnd); if (!keptData.has(x.data)) out.fill(0, x.data, next(x.data)); }
  return out;
}

/**
 * The package of an engine release, from its release.json: { build (the e/<hash> directory), rel (its openmw.data's
 * path in the release), data, js (their files) } or null when it has none.
 */
function packageOf(enginesDir, release) {
  try {
    const r = JSON.parse(fs.readFileSync(engineFile(enginesDir, release, 'release.json'), 'utf8'));
    const f = (r.files ?? []).find((x) => /^e\/[0-9a-f]+\/openmw\.data$/.test(x)); if (!f) return null;
    const build = f.split('/')[1];
    return { build, rel: f, data: engineFile(enginesDir, release, f), js: engineFile(enginesDir, release, `e/${build}/openmw.js`) };
  } catch { return null; }
}

/**
 * The lean packages of the installed engine releases, kept in `dir` by content (<dir>/_c/<sha256>/lean<rule>/
 * openmw.data.br; earlier servers' <dir>/<release>/lean<n>/<build>/ still served), their packages' sha256s those of
 * `content` (the server's engineContent: its hashing shared). `url(release)`: the page's address
 * of the release's lean package once made (its making started otherwise — once its package is hashed —: meanwhile an
 * older lean package of it on disk, else null); `pending(release)`: its making
 * (or hashing) runs with no older one to give (the page will ask for the lean package once it is there, not for the
 * release's own: nothing to prepare meanwhile); `size(release)`: the brotli bytes of the one url() gives; `decoded(release)`: its decoded bytes (the release's own package's: the same size); `file(release,
 * rest)`: the file for a request of /engines/<release>/<rest> (an earlier server's address), or null;
 * `contentFile(sha, rest)`: { file, decoded } for a request of /engines/_c/<sha>/<rest>, or null.
 */
export function leanPackages({ dir, enginesDir, log = () => {}, content = engineContent({ enginesDir, log }) }) {
  const making = new Map(); // sha -> true while its child runs, false once it failed (not tried again this run)
  const awaited = new WeakSet(); // content.hashed() promises a making already follows
  const sizes = new Map(); // sha -> the package's decoded bytes (a release's that has it)
  const outOf = (sha, rule = LEAN_RULE) => path.join(dir, '_c', sha, `lean${rule}`, 'openmw.data.br');
  const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const statOf = (f) => { try { return fs.statSync(f); } catch { return null; } };
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
   * The release's package with its sha256 ({ ...packageOf, sha }), or null: none, or its hashing runs (its making
   * follows it).
   */
  const keyed = (release) => {
    const pkg = packageOf(enginesDir, release); if (!pkg?.data) return null;
    const sha = content.sha(release, pkg.rel);
    if (!sha) {
      const p = content.pending(release, pkg.rel) && content.hashed(release, pkg.rel);
      if (p && !awaited.has(p)) { awaited.add(p); p.then((s) => { if (s && !exists(outOf(s))) { const st = statOf(pkg.data); if (st) sizes.set(s, st.size); make(s, { ...pkg, sha: s }); } }); }
      return null;
    }
    const st = statOf(pkg.data); if (st) sizes.set(sha, st.size);
    return { ...pkg, sha };
  };
  /** Is the release's package being hashed? */
  const hashing = (release) => { const pkg = packageOf(enginesDir, release); return !!pkg?.data && content.pending(release, pkg.rel); };
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
 * it boots the example world (?nomw, or the page's own __FORCE_NOMW). Its other files `__ENGINE_DIR + path`: what
 * openmw.js withEngineUrls gives by content.
 */
export const withLeanPackage = (html, leanUrl) => !leanUrl ? html : html.replace('locateFile: function(path){ return __ENGINE_DIR + path; }',
  `locateFile: function(path){ return path === 'openmw.data' && !(window.__FORCE_NOMW || /[?&]nomw\\b/.test(location.search)) ? ${JSON.stringify(leanUrl)} + path : __ENGINE_DIR + path; }`);
