// A returning player's load of a place outside the learned area, OpenMW (docs/slow-network.md "Measuring"): the engine
// page over the player's-link proxy (tools/net-proxy.mjs: HTTP/2, one shared link, a round trip a request) in front of
// an Orthros server of the code tree under test (--tree: its src/host/server.js on a fresh copy of the pristine learned
// directory and the pristine precompressed units, frozen), in a browser profile that already played once (its block
// store, link measure and HTTP cache: the proxy's port and certificate pinned, so the origin is the same at every run).
// - Warm-up, once (when --profile-warm does not exist yet, with --warm-tree's code): the engine page booted into
//   --start (?start=<cell>: a new character dropped there, QA auto-chargen), in the world, then --warm-seconds more; the
//   profile kept as the warm profile, the store's size and link measure noted.
// - Each measured run, on a copy of the warm profile, one of two scenarios (--mode):
//   - coe (scenario C, a debug COE): a warm boot to the world (the engine's start measured: navigation to the first
//     frame drawn and to the player in the world), the data quiet (--quiet seconds without one of the game's own reads),
//     a marker request through the proxy (its clock and the page's aligned), then Module._omw_debug_coe(--to) — a whole
//     exterior worldspace load, the page's thread held by it —, the cell reached (view.lua's 'orthros.cell') and frames
//     flowing, --after seconds more, closed.
//   - save (scenario S, a save loaded from the menu, the owner's way): the player's own entry (--entry play: the play
//     page /ports/openmw/<manifest>/?mode=solo, its engine frame app/index.html?src=hosted[&novid] as the play page
//     chooses; --entry engine: that frame's page alone), so the engine boots to its MENU; a save made once at --to
//     (--save, made when missing: below) written into the engine's saves folder (IDBFS: the folder it was made in, /userdata/saves/
//     <character>/ with the r8 page) by an init script, inside IDBFS's populate callback — after its reconcile, before the
//     engine's main lists the saves; the menu (Module.__omwRunning: the engine's main loop) left --menu seconds as is,
//     the marker, then F9 pressed in the engine's frame — this engine's QuickLoad at the menu loads the newest save of
//     any character (statemanagerimp.cpp, __EMSCRIPTEN__), StateManager::requestLoad as the Load menu's click —; the
//     load measured from the key (its keydown in the frame) to the player in the world (view.lua's first report), the
//     cell reached and frames flowing, then --after seconds.
//   - glide (scenario G, the network's part in exterior crossings — docs/openmw.md "In play: crossings and doors"): the
//     warm boot at --start, the data quiet, the marker, then perf.mjs's glide (--glide dx,dy[,speed[,z]], default
//     0,1,300,3000: north at a run's speed from the start cell's centre, the engine's debug teleport every 33 ms) for
//     --seconds (150); each cell entered (view.lua's report) a crossing: its frame gaps (longest, over 250 ms), the game
//     data's counters over it (stallMs, syncFetches, wantWaits, wantWaitMs: the probe's samples), its network reads
//     (demand, read-ahead, announced: count, MB, the five files most read) and how much of them the learned places had
//     (the cell's own set, any place's).
//   - door (scenario D, a door's load): the warm boot at --start (default -3,-2, Balmora), the data quiet, then the
//     console's COC to --interior (default 'balmora, south wall cornerclub': a door's own path into the interior),
//     timed from its Enter to frames flowing in the interior (view.lua's '' cell); --lead s: the interior's learned set
//     asked at the place's priority that long before the Enter (the page guessing the door right: the upper bound of a
//     lead); the set's bytes fetched before the Enter, and the load's network reads against it.
//   The save, once (--make-save, or --save missing): the engine page ?start=<--to>&novid on a plain local server of
//   --warm-tree (no proxy: a throwaway profile and origin, the warm store untouched), in the world, the data quiet,
//   F5 (QuickSave), the newest .omwsave read back from the engine's FS into --save, its character folder in <save>.json.
// - --engine <release>: the measured version's openmw.engine replaced by that release, in a scratch games folder
//   (<scratch>/games-<release>: one real folder a game, of links to the live game's entries — the server's catalog
//   takes real folders only —, a modified copy of the measured game's manifest.json; the versions it requires keep
//   theirs), its engine from --engines-dir (default the live one). The live games folder checked for new links after.
// - Stage 3 (docs/slow-network.md "Announced reads": the places learned from what engines announced, the page's prediction
//   from the saves): --teach N runs the same scenario N times first, unmeasured, on one learn copy of the invocation
//   (<scratch>/teach/<tag>-<time>/learn, from the pristine one; the server's places-<manifest>.json written there — each
//   teach run left at least 25 s after its load: the server's learnSave timer is 20 s, its exit flushes none), and every
//   measured run then starts from a copy of THAT learn directory — another player already loaded the place —, the
//   teach copy removed at the end. --profile new: each run (taught or measured) on a fresh empty profile — a new device:
//   no store, no HTTP cache (the engine itself through the link), no link measure, no place hint —, the save of
//   scenario S still injected; no warm-up then. --engine-br: the brotli siblings of --engine's openmw.{js,wasm,data}
//   (as tools/openmw/build.sh makes them: quality 11, window 24) made once when missing or older than their file — only
//   for a release under /tmp/orthros-scratch (a dev build; a release in data/engines has its own) —, else that engine
//   goes uncompressed through the link (213 MB, ~2 min at 1.8 MB/s) on a new profile. --dry: the options resolved and
//   the plan printed, nothing started.
//   Scenario S's row adds `stage3`: the place hint (localStorage 'orthros.place.<manifest>') at the menu and at the end,
//   the learned places (the learn copy's places file: size, places, the target's units), the menu-time prefetch (the
//   announced ranges, kind 'want', started before the key: before the menu and in it, their end against the key, those
//   still in flight at it; the /api/places requests) and the load (key -> in world, its serial reads, its announced
//   ranges, the engine's waits — wantWaits, wantWaitMs, wantTimeouts of the data stats' delta).
// One JSON line per run in --out: the engine's start, the frozen load (the longest gap between frames drawn after the
// COE or the key), the proxy log's stretch of that frozen frame (loadWindow: the game's reads — count, decoded, wire,
// spacing, ttfb, idle — and the background's bytes by kind and file category, 'upgrade' the full file of a light copy
// read this run), the same to the player in the world (S) and to the frames' return (toSteady), the data stats' delta
// (__streamfsStats), the whole run's summary. Runs are sequential; the whole tool holds one browser slot:
//
//   tools/with-browser-slot.sh node tools/openmw/place-load.mjs <manifest> --tree <code tree> [--mode coe|save|glide|door] [--runs 2]
//     [--tag baseline] [--pristine /tmp/orthros-scratch/mw-load/pristine] [--scratch /tmp/orthros-scratch/mw-load]
//     [--profile-warm <dir>] [--warm-tree /srv/orthros] [--warm-seconds 120] [--rate 1.8m] [--rtt 90] [--listen 18447]
//     [--start -2,-9] [--to -2,6] [--quiet 10] [--after 30] [--out <scratch>/results.jsonl] [--games-dir ..]
//     [--engines-dir ..] [--engine <release>] [--covers off|<dir>] [--warm-only]
//     [--profile warm|new] [--teach 0] [--engine-br] [--dry]
//     save: [--entry play|engine] [--menu 10] [--save <scratch>/saves/<to>.omwsave] [--make-save]
//     glide: [--glide 0,1,300,3000] [--seconds 150]   door: [--interior '<cell id>'] [--lead 0]
//     in play (coe, glide, door): [--query lead=1] (added to the measured runs' engine page — not the teach runs': an A/B
//     of a page switch) [--teach-query lead=1] (added to the teach runs' engine page: what a session with the switch
//     teaches the next ones)
//   (--profile-warm defaults to <scratch>/profile-warm for --start -2,-9, <scratch>/profile-warm-<start> otherwise)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseRate, urlKind, dataRead } from '../net-proxy.mjs';
import { engineLower } from '../../src/ports/openmw/save-place.js';
import { nextRow } from '../../src/ports/openmw/place-lead.js';

const MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
/** Where the engine's saves may be (IDBFS): the engine's user data folder — /userdata/saves in the r8 page, seen —, its XDG data home's. */
export const SAVES_DIRS = ['/userdata/saves', '/userdata/data-home/openmw/saves'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s1 = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : Math.round(ms / 100) / 10);

/**
 * A games folder for a test server whose `version` runs `engine` (or each version of `engines`, { [version]: release }:
 * an engine release a version of each edition — reVC's two, say): `out` (made anew: a real folder) holds one real folder
 * per game of `live` — the server's catalog takes real folders only (a link's Dirent is no directory) — of links to the
 * live game's entries (base, versions, cover…), each game of a changed version with a copy of its manifest.json, that
 * version's engine replaced — its port's (`openmw.engine`, `re3.engine`, `goldsrc.engine`; the versions it requires keep their own).
 * Never a link into an existing link: every folder linked into is made here, checked a real folder first. `live` is only
 * read. Returns { out, game, previous } (the first changed version's game and former release), `changed`: every one's
 * { [version]: { game, previous } }.
 */
export function scratchGames({ live, out, version, engine, engines = { [version]: engine } }) {
  const games = fs.readdirSync(live, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const specs = new Map(), changed = {};
  for (const g of games) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(live, g, 'manifest.json'), 'utf8')); } catch { continue; }
    for (const v of m.versions ?? []) {
      if (!Object.hasOwn(engines, v.id)) continue;
      const port = ['openmw', 're3', 'goldsrc'].find((k) => v[k] && typeof v[k] === 'object');
      if (!port) throw new Error(`${v.id}: not a browser port version with an engine release (openmw, re3, goldsrc)`);
      changed[v.id] = { game: g, previous: v[port].engine ?? null };
      v[port] = { ...v[port], engine: engines[v.id] };
      specs.set(g, m);
    }
  }
  const missing = Object.keys(engines).filter((v) => !changed[v]);
  if (missing.length) throw new Error(`${missing.join(', ')}: no version of that id in ${live}`);
  clearScratchGames(out);
  fs.mkdirSync(out);
  for (const g of games) {
    const dir = path.join(out, g);
    fs.mkdirSync(dir);
    if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== path.resolve(dir)) throw new Error(`${dir}: not a real folder of the scratch`);
    for (const e of fs.readdirSync(path.join(live, g))) {
      if (specs.has(g) && e === 'manifest.json') fs.writeFileSync(path.join(dir, e), JSON.stringify(specs.get(g), null, 2) + '\n');
      else fs.symlinkSync(path.join(live, g, e), path.join(dir, e));
    }
  }
  const first = changed[Object.keys(engines)[0]];
  return { out, game: first.game, previous: first.previous, changed };
}

/** Removes a scratch games folder of scratchGames: its links unlinked (never followed), its own files and folders, nothing recursive. */
export function clearScratchGames(out) {
  if (!fs.existsSync(out)) return;
  if (fs.lstatSync(out).isSymbolicLink()) throw new Error(`${out}: a link, not a scratch games folder`);
  for (const g of fs.readdirSync(out)) {
    const dir = path.join(out, g), st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || st.isFile()) { fs.unlinkSync(dir); continue; }
    for (const e of fs.readdirSync(dir)) {
      const f = path.join(dir, e), es = fs.lstatSync(f);
      if (!es.isSymbolicLink() && !es.isFile()) throw new Error(`${f}: neither a link nor a file — not made by scratchGames`);
      fs.unlinkSync(f);
    }
    fs.rmdirSync(dir);
  }
  fs.rmdirSync(out);
}

/** The flags without a value (every other option takes the next argument). */
const FLAGS = ['make-save', 'warm-only', 'engine-br', 'dry'];

/**
 * The command line's options (`argv` after the script: the manifest first), resolved with their defaults — absolute
 * paths, numbers, the scenario's checks; throws on a missing or wrong one (the message says which). Nothing is touched.
 */
export function parseArgs(argv) {
  const id = argv[0];
  if (!id || id.startsWith('--')) throw new Error('the manifest id comes first');
  const known = new Set([...FLAGS, 'tree', 'mode', 'runs', 'tag', 'pristine', 'scratch', 'profile-warm', 'warm-tree', 'warm-seconds', 'rate', 'rtt', 'listen', 'start', 'to', 'quiet', 'after', 'out',
    'games-dir', 'engines-dir', 'engine', 'covers', 'entry', 'menu', 'save', 'profile', 'teach', 'glide', 'seconds', 'interior', 'lead', 'query', 'teach-query']);
  const val = new Map(), flags = new Set();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], k = a.startsWith('--') ? a.slice(2) : null;
    if (!k || !known.has(k)) throw new Error(`${a}: unknown option`);
    if (FLAGS.includes(k)) { flags.add(k); continue; }
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${k}: a value expected`);
    val.set(k, argv[++i]);
  }
  const opt = (k, d = null) => (val.has(k) ? val.get(k) : d);
  const num = (k, d, { int = false, min = 0 } = {}) => {
    const n = Number(opt(k, d));
    if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new Error(`--${k} ${opt(k, d)}: ${int ? 'an integer' : 'a number'} >= ${min} expected`);
    return n;
  };
  const one = (k, d, ok) => { const v = opt(k, d); if (!ok.includes(v)) throw new Error(`--${k} ${v}: ${ok.join(' or ')}`); return v; };
  if (!opt('tree')) throw new Error('--tree <code tree> is required');
  const mode = one('mode', 'coe', ['coe', 'save', 'glide', 'door']);
  // (a door's town by default: Balmora, its cornerclub the interior the learned places know)
  const to = opt('to', '-2,6'), start = opt('start', mode === 'door' ? '-3,-2' : '-2,-9');
  for (const [k, c] of [['to', to], ['start', start]]) if (!/^-?\d+,-?\d+$/.test(c)) throw new Error(`--${k} ${c}: an exterior cell x,y`);
  const [toX, toY] = to.split(',').map(Number);
  const scratch = path.resolve(opt('scratch', '/tmp/orthros-scratch/mw-load'));
  const o = {
    id, tree: path.resolve(opt('tree')), mode, entry: one('entry', 'play', ['play', 'engine']), profile: one('profile', 'warm', ['warm', 'new']),
    scratch, pristine: path.resolve(opt('pristine', path.join(scratch, 'pristine'))), warmTree: path.resolve(opt('warm-tree', '/srv/orthros')),
    // (a warm profile a start cell: the store of another town is not this one's)
    warmDir: path.resolve(opt('profile-warm', path.join(scratch, start === '-2,-9' ? 'profile-warm' : `profile-warm-${start}`))), outFile: path.resolve(opt('out', path.join(scratch, 'results.jsonl'))),
    rate: parseRate(opt('rate', '1.8m')), rtt: num('rtt', 90), listen: num('listen', 18447, { int: true, min: 1 }),
    start, to, toX, toY, target: `${toX} ${toY}`, place: `${toX},${toY}`,
    quietS: num('quiet', 10), afterS: num('after', 30), warmS: num('warm-seconds', 120), menuS: num('menu', 10),
    liveGames: path.resolve(opt('games-dir', '/srv/orthros/data/games')), enginesDir: path.resolve(opt('engines-dir', '/srv/orthros/data/engines')),
    engine: opt('engine'), engineBr: flags.has('engine-br'),
    saveFile: path.resolve(opt('save', path.join(scratch, 'saves', `${to.replace(/[^0-9a-z-]+/gi, '_')}.omwsave`))),
    covers: opt('covers', 'off'), runs: num('runs', 2, { int: true }), teach: num('teach', 0, { int: true }), tag: opt('tag', 'run'),
    makeSave: flags.has('make-save'), warmOnly: flags.has('warm-only'), dry: flags.has('dry'),
    glide: glideSpec(opt('glide', '0,1,300,3000')), seconds: num('seconds', 150, { min: 5 }),
    // (the engine's key: its ASCII-only lower case — an id's accented capitals stay, as the learned places have them)
    interior: engineLower(opt('interior', 'balmora, south wall cornerclub')), leadS: num('lead', 0),
    query: opt('query', ''), teachQuery: opt('teach-query', ''),
  };
  for (const [k, q] of [['query', o.query], ['teach-query', o.teachQuery]]) if (q && !/^[\w.-]+=[\w.,-]*(&[\w.-]+=[\w.,-]*)*$/.test(q)) throw new Error(`--${k} ${q}: name=value[&name=value] for the engine page`);
  if (!o.interior || o.interior.length > 64 || /["\x00-\x1f]/.test(o.interior)) throw new Error(`--interior ${o.interior}: an interior cell's id (64 characters, no quote)`);
  if (!(o.rate > 0)) throw new Error(`--rate ${opt('rate')}: bytes per second, e.g. 1.8m`);
  if (o.engineBr && !o.engine) throw new Error('--engine-br: with --engine <release> only');
  for (const d of [o.pristine, o.warmDir, o.scratch]) if (d.startsWith('/var/lib')) throw new Error(`${d}: never the live state — a copy under the scratch`);
  if (o.scratch.startsWith('/srv/orthros/data')) throw new Error(`${o.scratch}: never under the live data`);
  return o;
}

/** The scratch root a dev engine release must be under to get brotli siblings made here (never a release of data/engines). */
export const ENGINE_BR_ROOT = '/tmp/orthros-scratch/';

/**
 * The brotli siblings of an engine release's openmw.{js,wasm,data} (e/<hash>/), the server's whole-file answer to a
 * browser asking for br (src/host/server.js: a .br at least as new as its file), made as tools/openmw/build.sh makes
 * them (quality 11, window 24, size hint), at nice 19 in a child, one file at a time — those missing or older than
 * their file. `release`: the release's folder (a link resolved first); refused unless it is under `root`. `make`
 * false: the list only. Returns [{ file, bytes, made, brBytes, ms }].
 */
export function engineBrotli(release, { root = ENGINE_BR_ROOT, make = true } = {}) {
  const real = fs.realpathSync(release);
  if (!real.startsWith(path.resolve(root) + path.sep)) throw new Error(`${release} (${real}): brotli siblings are made here only for a release under ${root}`);
  if (!fs.existsSync(path.join(real, 'release.json'))) throw new Error(`${real}: no release.json — not an engine release`);
  const out = [];
  const eDir = path.join(real, 'e');
  for (const h of fs.existsSync(eDir) ? fs.readdirSync(eDir).sort() : []) {
    for (const n of ['openmw.js', 'openmw.wasm', 'openmw.data']) {
      const file = path.join(eDir, h, n);
      if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) continue;
      const st = fs.statSync(file);
      let fresh = false; try { fresh = fs.statSync(file + '.br').mtimeMs >= st.mtimeMs; } catch { /* none */ }
      const row = { file, bytes: st.size, made: false, brBytes: fresh ? fs.statSync(file + '.br').size : null, ms: 0 };
      if (!fresh && make) {
        const t0 = Date.now();
        // (written beside, then renamed: a cut run leaves no truncated sibling the server would send)
        execFileSync('nice', ['-n', '19', process.execPath, '-e',
          "const z=require('zlib'),fs=require('fs'),f=process.argv[1];fs.writeFileSync(f+'.br.tmp',z.brotliCompressSync(fs.readFileSync(f),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11,[z.constants.BROTLI_PARAM_LGWIN]:24,[z.constants.BROTLI_PARAM_SIZE_HINT]:fs.statSync(f).size}}));fs.renameSync(f+'.br.tmp',f+'.br')",
          file], { stdio: 'inherit' });
        Object.assign(row, { made: true, brBytes: fs.statSync(file + '.br').size, ms: Date.now() - t0 });
      }
      out.push(row);
    }
  }
  return out;
}

/**
 * A learn directory's places as the server stores them (places-<id>.json, src/host/server.js placesWrite: [[lang, place,
 * at, sessions, gen, [[kind index, path, start, end, gen, rank]]]]): { file, bytes, mtime, places, target, targetMB,
 * sessions } — `target` the records of `place` (its most recently announced entry, any language), null when absent —,
 * and `paths` (not for the row: the target's files, to find its requests in a proxy log). null when there is no file.
 */
export function placesSummary(learnDir, id, place) {
  const file = path.join(learnDir, `places-${id}.json`);
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file), row = { file: path.basename(file), bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), places: null, target: null, targetMB: null, sessions: null };
  let doc; try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ...row, error: String(e.message ?? e) }; }
  if (!Array.isArray(doc)) return { ...row, error: 'not the server\'s places list' };
  row.places = doc.length;
  const P = doc.filter((e) => Array.isArray(e) && e[1] === place && Array.isArray(e[5])).sort((x, y) => (Number(y[2]) || 0) - (Number(x[2]) || 0))[0];
  if (!P) return row;
  const recs = P[5].filter((r) => Array.isArray(r) && typeof r[1] === 'string');
  Object.assign(row, { target: recs.length, targetMB: Math.round(recs.reduce((n, r) => n + Math.max(0, (Number(r[3]) || 0) - (Number(r[2]) || 0)), 0) / 1e4) / 100, sessions: P[3] ?? null });
  Object.defineProperty(row, 'paths', { value: new Set(recs.map((r) => r[1])), enumerable: false });
  return row;
}

/**
 * Stage 3's menu-time prefetch from a proxy log (its clock, ms; null: unknown) before the key `keyT`: the predicted
 * place's set — background ranges (`p=1`: HttpBackend.wantList `prio: 'place'` asks as background) of the place's files
 * (`placePaths`, its learned records' paths; a light copy counts as its file) —, all of them, those before the menu
 * `menuT` and those in it, the last one's end against the key (s; negative: done before it), those still in flight at
 * it; the announced ranges (`w=1`) started before the key (none expected: the engine announces at the load); the
 * /api/places requests.
 */
export function prefetchReport(recs, { docT = 0, menuT = null, keyT, placePaths = null }) {
  const MB = (n) => Math.round(n / 1e4) / 100, S = (ms) => (ms === null ? null : Math.round(ms / 100) / 10);
  const sum = (a) => ({ count: a.length, wireMB: MB(a.reduce((n, r) => n + (r.wire ?? 0), 0)), decodedMB: MB(a.reduce((n, r) => n + (r.decoded ?? 0), 0)) });
  const want = [], place = [], places = [];
  for (const r of recs) {
    if (r.mark || r.url === undefined || r.t < docT) continue;
    if (r.url.startsWith('/api/places')) places.push({ atS: S(r.t - docT), keyS: keyT === null ? null : S(r.t - keyT), method: r.method ?? 'GET', status: r.status ?? null, ms: r.ms ?? null, url: r.url.slice(0, 160) });
    if (keyT === null || r.t >= keyT) continue;
    const kind = urlKind(r.url), d = kind === 'want' || kind === 'bg' ? dataRead(r.url) : null;
    if (!d) continue;
    const x = { t: r.t, end: r.t + (r.ms ?? 0), wire: r.wire, decoded: d.decoded ?? 0 };
    if (kind === 'want') want.push(x);
    else if (placePaths?.has(d.path)) place.push(x);
  }
  const span = (a) => {
    const lastEnd = a.reduce((m, r) => Math.max(m, r.end), -Infinity);
    return { ...sum(a), firstS: a.length ? S(a[0].t - docT) : null, lastEndS: a.length ? S(lastEnd - docT) : null, lastEndToKeyS: a.length ? S(lastEnd - keyT) : null, inFlightAtKey: a.filter((r) => r.end > keyT).length };
  };
  return {
    place: span(place), want: span(want),
    beforeMenu: menuT === null ? null : sum(place.filter((r) => r.t < menuT)), inMenu: menuT === null ? null : sum(place.filter((r) => r.t >= menuT)),
    places,
  };
}

/**
 * A measured load's times from the page's frames (ms, the page's clock): `gaps` [a, b] between frames drawn once armed,
 * `from` the trigger (COE call, key), `cellAt` the target cell's report (null: never). The longest gap after `from`
 * (the frozen frame), the stalls over 250 ms summed, and frames flowing again: the end of the last gap over 250 ms
 * before the cell's report plus 2 s (the longest gap's end at least).
 */
export function loadTimes({ gaps = [], from, cellAt = null }) {
  const after = gaps.filter(([, b]) => b >= from);
  const longest = after.reduce((m, g) => (!m || g[1] - g[0] > m[1] - m[0] ? g : m), null);
  const steadyAt = Math.max(longest?.[1] ?? 0, ...after.filter(([a, b]) => b - a > 250 && (cellAt === null || a <= cellAt + 2000)).map(([, b]) => b));
  return {
    longest, steadyAt: steadyAt || null,
    frozenMs: longest ? Math.round(longest[1] - longest[0]) : null, frozenStartMs: longest ? Math.round(longest[0] - from) : null,
    stallsOver250Ms: Math.round(after.filter(([a, b]) => b - a > 250).reduce((n, [a, b]) => n + b - a, 0)),
  };
}

/** OpenMW's exterior cell side (engine units). */
export const CELL_UNITS = 8192;

/** --glide's `dx,dy[,speed[,z]]` (perf.mjs's): a direction, units a second (300: a run) and a height; throws on a wrong one. */
export function glideSpec(text) {
  const v = String(text).split(',').map(Number);
  if (v.length < 2 || v.length > 4 || v.some((n) => !Number.isFinite(n)) || !(Math.hypot(v[0], v[1]) > 0) || (v.length > 2 && !(v[2] > 0))) throw new Error(`--glide ${text}: dx,dy[,speed[,z]] (a direction, speed > 0)`);
  return { dx: v[0], dy: v[1], speed: v[2] ?? 300, z: v[3] ?? 3000 };
}

/** The glide's straight line from the start cell's centre (`start` 'x,y'): { x0, y0, vx, vy, z } (units, units a second). */
export function glideLine(start, { dx, dy, speed, z }) {
  const [cx, cy] = start.split(',').map(Number), n = Math.hypot(dx, dy);
  return { x0: (cx + 0.5) * CELL_UNITS, y0: (cy + 0.5) * CELL_UNITS, vx: dx / n * speed, vy: dy / n * speed, z };
}

/**
 * A glide's cell crossings from the page's probe (page clock, ms): `cells` [[cell 'x y', t]] as view.lua reported them
 * (the first one the cell glided from), `gaps` [a, b] between frames drawn, `samples` [[t, stallMs, syncFetches,
 * wantWaits, wantWaitMs, wants]] of the game data's counters (taken while the page's thread runs), the glide `from`-`to`.
 * One row a cell entered after `from`, its window to the next one's (the last: `to`): its frame gaps (the longest, those
 * over 250 ms: count and sum) and the counters' growth over it (the last sample at or before each end).
 */
export function crossings({ cells = [], gaps = [], samples = [], from, to }) {
  const at = (t) => { let s = null; for (const x of samples) { if (x[0] <= t) s = x; else break; } return s; };
  const entered = cells.filter(([, t]) => t > from && t < to);
  return entered.map(([cell, a], i) => {
    const b = i + 1 < entered.length ? entered[i + 1][1] : to;
    const g = gaps.filter(([x, y]) => y > a && x < b).map(([x, y]) => y - x), over = g.filter((d) => d > 250);
    const s0 = at(a), s1x = at(b), d = (k) => (s0 && s1x ? Math.round(s1x[k] - s0[k]) : null);
    return {
      cell, atS: Math.round((a - from) / 100) / 10, ms: Math.round(b - a), longestGapMs: g.length ? Math.round(Math.max(...g)) : 0,
      gapsOver250: over.length, gapsOver250Ms: Math.round(over.reduce((n, x) => n + x, 0)),
      stallMs: d(1), syncFetches: d(2), wantWaits: d(3), wantWaitMs: d(4), wants: d(5),
    };
  });
}

/**
 * Every learned place's records of a learn directory (places-<id>.json, as placesSummary reads it; each place's most
 * recently announced entry, any language): Map(place -> Map(path -> [[start, end]])). Empty when there is none.
 */
export function learnedSets(learnDir, id) {
  const out = new Map();
  let doc; try { doc = JSON.parse(fs.readFileSync(path.join(learnDir, `places-${id}.json`), 'utf8')); } catch { return out; }
  if (!Array.isArray(doc)) return out;
  const newest = new Map();
  for (const e of doc) if (Array.isArray(e) && typeof e[1] === 'string' && Array.isArray(e[5]) && (Number(e[2]) || 0) >= (Number(newest.get(e[1])?.[2]) || 0)) newest.set(e[1], e);
  for (const [place, e] of newest) {
    const files = new Map();
    for (const r of e[5]) if (Array.isArray(r) && typeof r[1] === 'string') { let a = files.get(r[1]); if (!a) files.set(r[1], (a = [])); a.push([Number(r[2]) || 0, Number(r[3]) || 0]); }
    out.set(place, files);
  }
  return out;
}

/** The bytes of [a, b) inside `ranges` ([[start, end]], may overlap). */
function covered(ranges, a, b) {
  const parts = (ranges ?? []).map(([x, y]) => [Math.max(a, x), Math.min(b, y)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let n = 0, end = a;
  for (const [x, y] of parts) { if (y <= end) continue; n += y - Math.max(x, end); end = y; }
  return n;
}

/**
 * The game's own reads over the network in a stretch of a proxy log (its clock: `from`-`to`; demand, read-ahead and
 * announced — not the background's): how many, their bytes (decoded: the files' ranges), and how much of them the
 * learned places (`sets`, learnedSets) named: `inPlace` the sets of `place` (a key — a crossing's cell 'x,y', an interior's
 * id — or several: a read named by any of them), `inAny` any place's; `files` the five files read most there and the part of each no place named. A read counts whole
 * when it touches a learned record of its file (the data system fetches units — an archive's block, a read-ahead —
 * larger than the records the engine names); a light copy counts as its file (a place learns the files, and a light
 * copy's range is its own).
 */
export function readCoverage(recs, from, to, sets, place = null) {
  const MB = (n) => Math.round(n / 1e4) / 100;
  const keys = place === null ? [] : Array.isArray(place) ? place : [place];
  const mine = keys.map((k) => sets.get(k)).filter(Boolean), byFile = new Map();
  let reads = 0, bytes = 0, inPlace = 0, inAny = 0;
  for (const r of recs) {
    if (r.mark || r.url === undefined || r.t < from || r.t > to) continue;
    const kind = urlKind(r.url);
    if (kind !== 'demand' && kind !== 'ahead' && kind !== 'want') continue;
    const d = dataRead(r.url), m = /(?:^|[?&])r=(\d+)-(\d+)/.exec(r.url);
    if (!d || !m) continue;
    const a = Number(m[1]), b = Number(m[2]), n = b - a;
    const named = (files) => !!files?.get(d.path) && (d.light || covered(files.get(d.path), a, b) > 0);
    const any = [...sets.values()].some(named) ? n : 0;
    reads++; bytes += n; inAny += any; inPlace += mine.some(named) ? n : 0;
    const f = byFile.get(d.path) ?? { MB: 0, unknownMB: 0 }; f.MB += n; f.unknownMB += n - any; byFile.set(d.path, f);
  }
  const files = [...byFile].sort((x, y) => y[1].MB - x[1].MB).slice(0, 5).map(([p, f]) => ({ path: p, MB: MB(f.MB), unknownMB: MB(f.unknownMB) }));
  return { reads, MB: MB(bytes), inPlaceMB: MB(inPlace), inAnyMB: MB(inAny), placeKnown: mine.length > 0, files };
}

/**
 * A glide run's report: its crossings (crossings) each with its network reads (readCoverage over the crossing's
 * window in the proxy's clock — `proxyOf` the page's time to it, null: not aligned — against the learned sets of the cell
 * entered and of the next one, keys 'x,y': the engine announces a cell's key as it enters it, but its preload fetched
 * that row ~4 s before, in the window before — the next cell the next crossing's, else the one after it the same way),
 * and the run's totals. `P` the probe's (from, gaps, cells, samples), `glideEnd` the page's time it
 * stopped.
 */
export function glideReport({ P, glideEnd, recs, proxyOf, sets, line = null, spec = null }) {
  const from = P?.from ?? null, to = glideEnd ?? null;
  if (from === null || to === null) return { line, spec, crossings: [], total: null };
  const rows = crossings({ cells: (P.cells ?? []).filter(([c]) => c), gaps: P.gaps ?? [], samples: P.samples ?? [], from, to });
  const glided = (P.cells ?? []).map(([c]) => c).filter(Boolean);
  rows.forEach((c, i) => {
    const a = proxyOf(from + c.atS * 1000), b = proxyOf(from + c.atS * 1000 + c.ms), key = c.cell.replace(' ', ',');
    const next = rows[i + 1]?.cell.replace(' ', ',') ?? nextRow(i ? rows[i - 1].cell : glided[0] ?? null, c.cell);
    c.net = a !== null && b !== null ? readCoverage(recs, a, b, sets ?? new Map(), next && next !== key ? [key, next] : key) : null;
  });
  const g = (P.gaps ?? []).filter(([x, y]) => y > from && x < to).map(([x, y]) => y - x), over = g.filter((d) => d > 250);
  const sum = (k) => rows.reduce((n, c) => n + (c[k] ?? 0), 0);
  return {
    line, spec, cells: (P.cells ?? []).map(([c, t]) => [c, Math.round((t - from) / 100) / 10]), crossings: rows, leads: P.leads ?? null,
    total: {
      seconds: Math.round((to - from) / 100) / 10, crossings: rows.length, longestGapMs: g.length ? Math.round(Math.max(...g)) : 0, gapsOver250: over.length,
      gapsOver250Ms: Math.round(over.reduce((n, x) => n + x, 0)), stallMs: sum('stallMs'), syncFetches: sum('syncFetches'), wantWaitMs: sum('wantWaitMs'),
      netMB: Math.round(rows.reduce((n, c) => n + (c.net?.MB ?? 0), 0) * 100) / 100, learnedMB: Math.round(rows.reduce((n, c) => n + (c.net?.inPlaceMB ?? 0), 0) * 100) / 100,
    },
  };
}

/**
 * In the page: a place's learned set (GET /api/places) asked of the game data at the place's priority, as streamfs.js
 * anticipate asks a save's place (GameData.want `prio: 'place'`) — door mode's --lead: the page guessing the door right.
 * Its meshes and terrain only, as the page's own guesses (place-lead.js LEAD.kinds: never textures).
 */
async function placeLead({ name, place, kinds = ['meshes', 'terrain'] }) {
  const d = window.StreamFS?.data?.(), at = performance.now();
  if (!d) return { err: 'no game data' };
  const r = await fetch(`/api/places/${encodeURIComponent(name)}?place=${encodeURIComponent(place)}`, { cache: 'no-store' }).catch(() => null);
  if (!r?.ok) return { status: r?.status ?? null };
  const doc = await r.json(), list = Array.isArray(doc) ? doc : Array.isArray(doc?.list) ? doc.list : [], entries = [];
  let bytes = 0;
  for (const x of list) {
    const [p, a, b, kind] = Array.isArray(x) ? x : [x?.path, x?.start, x?.end, x?.kind];
    const h = typeof p === 'string' && kinds.includes(kind) ? d.file(name, p) : null;
    if (!h) continue;
    const off = Math.max(0, Number(a) || 0), end = b === undefined || b === null ? -1 : Number(b), len = end >= 0 ? Math.max(0, end - off) : -1;
    bytes += len < 0 ? Math.max(0, (h.size ?? 0) - off) : len;
    entries.push({ h, off, len });
  }
  return { at, listed: list.length, asked: d.want(entries, { prio: 'place', label: 'lead:' + place }), MB: Math.round(bytes / 1e4) / 100 };
}

/** The page's probe, before its scripts (the engine page only): frames drawn, the gaps between them once armed, the engine's main loop, the world and the cells reached, the trigger key. */
function probe() {
  if (!location.pathname.includes('/app/')) return;
  const P = window.__placeProbe = { draws: 0, firstDraw: null, menuAt: null, inWorldAt: null, last: null, on: false, frames: [], gaps: [], cellAt: {}, keyAt: null, cells: [], samples: [] };
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!type) continue;
    for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = type.prototype[m]; if (f) type.prototype[m] = function (...a) { P.draws++; return f.apply(this, a); };
    }
  }
  const raf = window.requestAnimationFrame.bind(window);
  let seen = 0;
  const tick = (t) => {
    // (an engine drawing on its own thread, OPENMW_ORTHROS_DRAWTHREAD: no WebGL call on this page — its frames are the
    // pictures it hands to the page, window.__omwDrawThreadFrames, as src/ports/openmw/frame-meter.js counts them)
    const drawn = P.draws + (window.__omwDrawThreadFrames ?? 0);
    if (drawn !== seen) {
      seen = drawn; P.firstDraw ??= t;
      if (P.on) { if (P.last !== null && t - P.last > 100) P.gaps.push([P.last, t]); P.frames.push(t); }
      P.last = t;
    }
    raf(tick);
  };
  raf(tick);
  // (the trigger key as the engine's frame receives it: the load's start)
  window.addEventListener('keydown', (e) => { if (P.on && P.keyAt === null && e.key === P.key) { P.keyAt = performance.now(); P.from = P.keyAt; } }, true);
  setInterval(() => {
    if (P.menuAt === null && window.Module?.__omwRunning !== undefined) P.menuAt = performance.now();
    const st = window.omw?.state ?? {};
    if (P.inWorldAt === null && st['orthros.view'] !== undefined) P.inWorldAt = performance.now();
    // (an interior: view.lua's '' — kept once armed, a door's destination reached; every change kept once armed: a glide's crossings)
    const c = st['orthros.cell'], now = performance.now();
    if ((c || (c === '' && P.on)) && !(c in P.cellAt)) P.cellAt[c] = now;
    if (P.on && c !== undefined && P.cells.at(-1)?.[0] !== c) P.cells.push([c, now]);
  }, 100);
  // (the game data's counters while armed, twice a second — none while the page's thread is held: the next one has its growth)
  setInterval(() => {
    const s = P.on && window.__streamfsStats;
    if (s) P.samples.push([performance.now(), s.stallMs ?? 0, s.syncFetches ?? 0, s.wantWaits ?? 0, s.wantWaitMs ?? 0, s.wants ?? 0]);
  }, 500);
}

/** Scenario S's save into the engine's saves folder: in IDBFS's populate callback (its __idbfsReadyResolve, called there before the engine may start), after the reconcile that would drop a file written earlier. */
function injectSave(save) {
  if (!save || !location.pathname.includes('/app/')) return;
  let resolve;
  Object.defineProperty(window, '__idbfsReadyResolve', {
    configurable: true, get: () => resolve,
    set(f) {
      resolve = function (...a) {
        try {
          const dir = `${save.dir}/${save.character}`, bin = atob(save.b64), bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          window.FS.mkdirTree(dir); window.FS.writeFile(`${dir}/${save.file}`, bytes);
          window.__placeSave = { ok: true, at: performance.now(), bytes: bytes.length };
        } catch (e) { window.__placeSave = { ok: false, err: String(e?.message ?? e) }; }
        return f.apply(this, a);
      };
    },
  });
}

/** The tree's commit and whether it has changes (the code measured). */
function treeId(t) {
  try { return `${execFileSync('git', ['-C', t, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}${execFileSync('git', ['-C', t, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim() ? '+dirty' : ''}`; } catch { return null; }
}

/** An evaluate (page or frame) that gives up (null) while the page's thread is held (a load in one frame). */
const look = (on, fn, arg, ms = 3000) => {
  // (one at a time: those asked while the thread is held would all run at its end)
  if (on.lookBusy) return Promise.race([on.lookBusy.then(() => null), sleep(ms).then(() => null)]);
  const p = on.lookBusy = on.evaluate(fn, arg).catch(() => null).finally(() => { if (on.lookBusy === p) on.lookBusy = null; });
  return Promise.race([p, sleep(ms).then(() => null)]);
};
const stats = (f) => look(f, () => (window.__streamfsStats ? JSON.parse(JSON.stringify(window.__streamfsStats)) : null));
const storage = (f, id) => look(f, async (id) => ({ estimateMB: await navigator.storage.estimate().then((e) => Math.round(e.usage / 1e5) / 10).catch(() => null), netBw: localStorage.getItem('orthros.netBw'), offlineCopy: localStorage.getItem('orthros.offlineCopy'), placeHint: localStorage.getItem(`orthros.place.${id}`) }), id, 10000);
const delta = (a, b) => (a && b ? Object.fromEntries(Object.keys(b).filter((k) => typeof b[k] === 'number' && typeof a[k] === 'number').map((k) => [k, Math.round(b[k] - a[k])])) : null);

/** The engine's frame of the page (the page itself on the engine page; the play page's frame), once there. */
async function appFrame(page, ms = 180000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const f = page.frames().find((x) => x.url().includes('/app/index.html'));
    if (f) return f;
  }
  throw new Error('no engine frame (app/index.html) in 3 min');
}

/** Focus on the engine's canvas (in its frame, the play page's frame focused first, as its mouse button does) and a key pressed there. */
async function pressInEngine(page, frame, key) {
  if (frame !== page.mainFrame()) await page.evaluate(() => document.querySelector('iframe')?.focus());
  await frame.evaluate(() => { window.focus(); document.getElementById('canvas')?.focus(); });
  await page.keyboard.press(key, { delay: 150 });
}

/** The newest .omwsave of the engine's saves folders (every entry looked at alone): { dir, character, file, size, mtime }, or null. */
const newestSave = (frame) => look(frame, (dirs) => {
  const FS = window.FS; let best = null, dir = null;
  const walk = (d, depth) => {
    let names = []; try { names = FS.readdir(d); } catch { return; }
    for (const n of names) {
      if (n === '.' || n === '..') continue;
      const f = `${d}/${n}`;
      try {
        const st = FS.stat(f);
        if (FS.isDir(st.mode)) { if (depth < 3) walk(f, depth + 1); continue; }
        const mtime = +new Date(st.mtime);
        if (n.toLowerCase().endsWith('.omwsave') && (!best || mtime > best.mtime)) best = { dir, character: d.slice(dir.length + 1), file: n, size: st.size, mtime };
      } catch { /* gone */ }
    }
  };
  for (dir of dirs) walk(dir, 0);
  return best;
}, SAVES_DIRS);

if (MAIN) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`place-load: ${e.message}\nusage: node tools/openmw/place-load.mjs <manifest> --tree <code tree> [--mode coe|save] [--runs 2] [--tag t] [--engine <release> [--engine-br]] [--engines-dir dir] [--to x,y] [--profile warm|new] [--teach N] [--dry] ... (see the header)`); process.exit(2); }
  const { id, mode, scratch, pristine, tree, warmTree, warmDir, outFile, rate, rtt, listen, start, to, toX, toY, target, quietS, afterS, warmS, menuS, entry, liveGames, enginesDir, engine, saveFile, covers, runs, tag } = o;
  if (o.dry) {
    // (the plan: what this invocation would do, nothing started nor written)
    const brPlan = o.engineBr ? (() => { try { return engineBrotli(path.join(enginesDir, engine), { make: false }).map((r) => ({ file: r.file, MB: Math.round(r.bytes / 1e5) / 10, fresh: r.brBytes !== null })); } catch (e) { return String(e.message); } })() : null;
    console.log(JSON.stringify({ options: o, plan: {
      engineBr: brPlan, warmUp: o.profile === 'warm' && !fs.existsSync(warmDir), makeSave: mode === 'save' && (o.makeSave || !fs.existsSync(saveFile + '.json')),
      teach: o.teach, measured: o.warmOnly ? 0 : runs, profile: o.profile === 'new' ? 'fresh, empty' : warmDir, place: o.place,
    } }, null, 1));
    process.exit(0);
  }
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('../port-perf.mjs');
  const { startProxy, startOrigin, spkiOf, readLog, loadWindow, summarize } = await import('../net-proxy.mjs');
  const certs = path.join(scratch, 'cert');
  const log = (...a) => console.log('[place-load]', ...a);

  // (the games folder the servers read: the live one, or a scratch one whose version runs --engine)
  let gamesDir = liveGames, engineNote = null;
  if (engine) {
    if (!fs.existsSync(path.join(enginesDir, engine, 'release.json'))) throw new Error(`${engine}: no release.json in ${enginesDir}`);
    const stamp = path.join(scratch, `.games-${process.pid}.stamp`);
    fs.mkdirSync(scratch, { recursive: true }); fs.writeFileSync(stamp, '');
    await sleep(1100); // (find -newer compares mtimes: a link made in the same second as the stamp counts)
    const made = scratchGames({ live: liveGames, out: path.join(scratch, `games-${engine}`), version: id, engine });
    const appeared = execFileSync('find', [liveGames, '-maxdepth', '3', '-type', 'l', '-newer', stamp], { encoding: 'utf8' }).trim();
    fs.rmSync(stamp, { force: true });
    if (appeared) throw new Error(`new links in the live games folder after the scratch setup — stop and look:\n${appeared}`);
    // (the server's catalog of the tree under test on it: the version's engine replaced, its requires resolved)
    const { loadGameCatalog } = await import(pathToFileURL(path.join(tree, 'src/host/game-catalog.js')).href);
    const cat = loadGameCatalog(made.out, null, { enginesDir });
    const m = cat.get(id); if (!m || m.openmw?.engine !== engine) throw new Error(`${id}: the scratch catalog does not run ${engine}`);
    gamesDir = made.out; engineNote = { engine, previous: made.previous, game: made.game, gamesDir };
    log(`games: ${made.out} (${made.game}: ${id} on ${engine}, was ${made.previous}; ${cat.size} versions; live folder unchanged)`);
    if (o.engineBr) {
      // (a dev release's brotli siblings, once: the engine's files then go compressed through the link as a built release's)
      const t0 = Date.now(), br = engineBrotli(path.join(enginesDir, engine));
      engineNote.br = br.map((x) => ({ file: path.relative(fs.realpathSync(path.join(enginesDir, engine)), x.file), MB: Math.round(x.bytes / 1e5) / 10, brMB: x.brBytes === null ? null : Math.round(x.brBytes / 1e5) / 10, made: x.made }));
      log(`engine brotli: ${br.filter((x) => x.made).length} made in ${Math.round((Date.now() - t0) / 1000)} s, ${br.length - br.filter((x) => x.made).length} already there (${engineNote.br.map((x) => `${path.basename(x.file)} ${x.MB} -> ${x.brMB} MB`).join(', ')})`);
    }
  }

  /**
   * One browser session through a proxy at the pinned port over the tree's server: `ready` (in the engine's frame)
   * awaited, then `body(frame, { page, proxyNow, faults, dir })`. `init`: [script, arg] added after the probe. The
   * server's learned directory: `learn` (default <dir>/learn), a copy of `learnFrom` made first unless that is null (a
   * teach run: the invocation's teach copy, used in place).
   */
  async function session({ codeTree, profile, dir, url, ready, init = null, body, learn = path.join(dir, 'learn'), learnFrom = path.join(pristine, 'learn') }) {
    fs.mkdirSync(dir, { recursive: true });
    if (learnFrom) execFileSync('cp', ['-a', learnFrom, learn]);
    const origin = await startOrigin({ tree: codeTree, learn, telemetry: path.join(dir, 'telemetry'), brcache: path.join(pristine, 'brcache'), covers, gamesDir, enginesDir, log: path.join(dir, 'server.log') });
    const proxyT0 = performance.now();
    const proxy = await startProxy({ upstream: `127.0.0.1:${origin.port}`, listen, rate, rtt, log: path.join(dir, 'proxy.jsonl'), certs });
    const proxyNow = () => performance.now() - proxyT0;
    const faults = [], consoleLog = fs.createWriteStream(path.join(dir, 'console.log'));
    let ctx = null;
    try {
      ctx = await chromium.launchPersistentContext(profile, { ...launchOptions({ args: [`--ignore-certificate-errors-spki-list=${spkiOf(certs)}`] }), viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(probe);
      if (init) await ctx.addInitScript(...init);
      const page = ctx.pages()[0] ?? await ctx.newPage();
      page.on('pageerror', (e) => faults.push(e.message.slice(0, 300)));
      page.on('crash', () => faults.push('page crashed'));
      page.on('console', (m) => consoleLog.write(`${m.type()} ${m.text()}\n`));
      await page.goto(`https://127.0.0.1:${listen}${url}`, { timeout: 120000 });
      const frame = await appFrame(page);
      await frame.waitForFunction(ready, null, { timeout: 900000, polling: 500 });
      return await body(frame, { page, proxyNow, faults, dir });
    } finally {
      // (left as a player leaves: the page's pagehide saves the link's measure, localStorage 'orthros.netBw' — a closed
      // context fires none)
      const page = ctx?.pages()[0];
      if (page) await Promise.race([page.goto('about:blank').catch(() => {}), sleep(20000)]);
      await ctx?.close().catch(() => {}); consoleLog.end();
      await proxy.close(); await origin.close();
    }
  }

  const enginePage = (q) => `/ports/openmw/${encodeURIComponent(id)}/app/index.html?src=hosted${q}`;
  const inWorld = () => window.__placeProbe?.inWorldAt !== null;

  async function warmUp() {
    const dir = path.join(scratch, 'warm'), building = warmDir + '.building';
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(building, { recursive: true, force: true });
    log(`warm-up: ${warmTree}, ${warmS} s in the world, profile ${warmDir}`);
    const t0 = Date.now();
    const res = await session({ codeTree: warmTree, profile: building, dir, url: enginePage(`&start=${encodeURIComponent(start)}&novid`), ready: inWorld, body: async (frame, { faults }) => {
      const inWorldS = s1((await look(frame, () => window.__placeProbe.inWorldAt)));
      await sleep(warmS * 1000);
      return { inWorldS, storage: await storage(frame, id), stats: await stats(frame), cell: await look(frame, () => window.omw?.state?.['orthros.cell'] ?? null), faults };
    } });
    const recs = readLog(path.join(dir, 'proxy.jsonl'));
    const row = { warm: true, tree: warmTree, commit: treeId(warmTree), seconds: warmS, wallS: Math.round((Date.now() - t0) / 1000), ...res, all: summarize(recs) };
    fs.renameSync(building, warmDir);
    fs.writeFileSync(path.join(scratch, 'warm.json'), JSON.stringify(row, null, 1));
    fs.rmSync(path.join(dir, 'learn'), { recursive: true, force: true }); fs.rmSync(path.join(dir, 'telemetry'), { recursive: true, force: true });
    execFileSync('gzip', ['-f', path.join(dir, 'proxy.jsonl')]);
    log(`warm-up done: in world ${row.inWorldS} s, store ${row.storage?.estimateMB} MB, netBw ${row.storage?.netBw}, ${row.all.wireMB} MB on the wire`);
  }

  /** Scenario S's save, once: a new character at --to on a plain local server (no proxy, a throwaway profile), QuickSave, read back. */
  async function makeSave() {
    const dir = path.join(scratch, 'saves', `make-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('cp', ['-a', path.join(pristine, 'learn'), path.join(dir, 'learn')]);
    const origin = await startOrigin({ tree: warmTree, learn: path.join(dir, 'learn'), telemetry: path.join(dir, 'telemetry'), brcache: path.join(pristine, 'brcache'), covers, gamesDir, enginesDir, log: path.join(dir, 'server.log') });
    let ctx = null;
    try {
      log(`save: a new character at ${to} (${warmTree}, local server :${origin.port})`);
      ctx = await chromium.launchPersistentContext(path.join(dir, 'profile'), { ...launchOptions(), viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(probe);
      const page = ctx.pages()[0] ?? await ctx.newPage();
      const consoleLog = fs.createWriteStream(path.join(dir, 'console.log'));
      page.on('console', (m) => consoleLog.write(`${m.type()} ${m.text()}\n`));
      await page.goto(`http://127.0.0.1:${origin.port}${enginePage(`&start=${encodeURIComponent(to)}&novid`)}`, { timeout: 120000 });
      await page.waitForFunction((t) => window.__placeProbe?.inWorldAt !== null && t in window.__placeProbe.cellAt, target, { timeout: 900000, polling: 500 });
      // (settled: the place's loads done — 20 s after the cell's report)
      await sleep(20000);
      const before = await newestSave(page);
      let saved = null;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        await pressInEngine(page, page.mainFrame(), 'F5');
        for (let i = 0; i < 30 && !saved; i++) { await sleep(1000); const s = await newestSave(page); if (s && (!before || s.mtime > before.mtime || s.file !== before.file)) saved = s; }
      }
      if (!saved) {
        const why = await look(page, () => ({ fs: typeof window.FS, fsFns: typeof window.FS?.readdir, focus: document.activeElement?.id ?? null, hasFocus: document.hasFocus(), state: window.omw?.state ?? null, ls: ['/userdata', '/userdata/saves', '/userdata/data-home/openmw/saves'].map((d) => { try { return [d, window.FS.readdir(d)]; } catch (e) { return [d, String(e)]; } }) }), undefined, 15000);
        throw new Error(`F5 (QuickSave) made no save in 90 s: ${JSON.stringify(why)} (the engine's log: ${dir}/console.log)`);
      }
      await sleep(2000);
      const b64 = await page.evaluate(({ dir, s }) => {
        const bytes = window.FS.readFile(`${dir}/${s.character}/${s.file}`); let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      }, { dir: saved.dir, s: saved });
      fs.mkdirSync(path.dirname(saveFile), { recursive: true });
      fs.writeFileSync(saveFile, Buffer.from(b64, 'base64'));
      const meta = { manifest: id, to, cell: target, dir: saved.dir, character: saved.character, file: saved.file, bytes: Buffer.from(b64, 'base64').length, tree: warmTree, commit: treeId(warmTree), made: new Date().toISOString() };
      fs.writeFileSync(saveFile + '.json', JSON.stringify(meta, null, 1) + '\n');
      log(`save: ${saveFile} (${meta.character}/${meta.file}, ${meta.bytes} bytes)`);
    } finally {
      await ctx?.close().catch(() => {}); await origin.close();
      // (kept on a failure: its logs, the browser's profile and the server's copies removed)
      for (const d of ['profile', 'learn', 'telemetry']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
      if (fs.existsSync(saveFile + '.json')) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * One run of the scenario: measured (its row in --out), or a teach run (`teach`: the invocation's teach learn
   * directory, used in place; its row only in its run folder, left --after but at least 25 s after its load so the
   * server's learnSave timer writes the places). A measured run's server starts on a copy of `learnFrom`.
   */
  async function measured(n, { teach = null, learnFrom = path.join(pristine, 'learn') } = {}) {
    const dir = path.join(scratch, 'runs', `${tag}-${teach ? 'teach-' : ''}${n}-${new Date().toISOString().replace(/[:.]/g, '-')}`), profile = path.join(dir, 'profile');
    fs.mkdirSync(dir, { recursive: true });
    // (a new device: an empty profile, the browser makes it)
    if (o.profile === 'warm') execFileSync('cp', ['-a', warmDir, profile]);
    const t0 = Date.now(), notes = [], learnDir = teach ?? path.join(dir, 'learn');
    const save = mode === 'save' ? JSON.parse(fs.readFileSync(saveFile + '.json', 'utf8')) : null;
    // (in play — coe, glide, door —: a new character dropped at --start; save: the menu)
    const play = mode !== 'save', goal = mode === 'door' ? '' : target;
    // (--query on the measured runs only: the teach runs of both arms of an A/B the same; --teach-query on the teach runs)
    const q = teach ? o.teachQuery : o.query;
    const url = play ? enginePage(`&start=${encodeURIComponent(start)}&novid${q ? '&' + q : ''}`) : entry === 'play' ? `/ports/openmw/${encodeURIComponent(id)}/?mode=solo` : enginePage('&novid');
    const init = save ? [injectSave, { dir: save.dir, character: save.character, file: save.file, b64: fs.readFileSync(saveFile).toString('base64') }] : null;
    const ready = play ? inWorld : () => window.__placeProbe?.menuAt != null;
    const res = await session({ codeTree: tree, profile, dir, url, ready, init, learn: learnDir, learnFrom: teach ? null : learnFrom, body: async (frame, { page, proxyNow, faults }) => {
      const boot = await look(frame, () => ({ firstDraw: window.__placeProbe.firstDraw, menuAt: window.__placeProbe.menuAt, inWorldAt: window.__placeProbe.inWorldAt, cell: window.omw?.state?.['orthros.cell'] ?? null, save: window.__placeSave ?? null }));
      const store0 = await storage(frame, id);
      let quietWaitS = null, lead = null, glideEnd = null;
      if (play) {
        // (the data quiet: none of the game's own reads on the wire, started or ended, for --quiet seconds — the page's
        // synchronous reads never stop, its music streaming from the store)
        const quietFrom = Date.now();
        for (;;) {
          await sleep(1000);
          let lastDemand = 0;
          try { for (const r of readLog(path.join(dir, 'proxy.jsonl'))) if (urlKind(r.url ?? '') === 'demand') lastDemand = Math.max(lastDemand, r.t + r.ms); } catch { /* not written yet */ }
          const waited = (Date.now() - quietFrom) / 1000;
          if (waited >= quietS && proxyNow() - lastDemand >= quietS * 1000) break;
          if (waited > 300) { notes.push('data never quiet in 300 s: the COE sent anyway'); break; }
        }
        quietWaitS = Math.round((Date.now() - quietFrom) / 1000);
      } else {
        // (the player in the menu a fixed time, as the engine left it)
        if (!boot?.save?.ok) notes.push(`save not injected: ${JSON.stringify(boot?.save)}`);
        await sleep(menuS * 1000);
      }
      const before = await stats(frame);
      // (the page's prediction at the key: StreamFS.place() — the place, why, the save, the set's entries listed and asked)
      const predicted = await look(frame, () => window.StreamFS?.place?.() ?? null);
      // (the marker: through the proxy, its log's clock against the engine frame's)
      const mark = `place-${n}-${Date.now()}`;
      const markAt = await frame.evaluate(async (mark) => { const t = performance.now(); await fetch(`/__qa/mark?${mark}`, { cache: 'no-store' }).catch(() => {}); return t; }, mark);
      if (mode === 'glide') {
        // (perf.mjs's glide: the engine's debug teleport every 33 ms along a straight line, the page's own timer — it goes
        // on while this process waits; the cells crossed and their loads the same at every run)
        const has = await frame.evaluate((line) => {
          const P = window.__placeProbe; if (typeof window.Module?._omw_debug_teleport !== 'function') return false;
          P.on = true; P.gaps = []; P.frames = []; P.samples = []; P.cells = [[window.omw?.state?.['orthros.cell'] ?? null, performance.now()]];
          const t0 = P.from = performance.now();
          P.glide = setInterval(() => { const t = (performance.now() - t0) / 1000; window.Module._omw_debug_teleport(line.x0 + line.vx * t, line.y0 + line.vy * t, line.z); }, 33);
          return true;
        }, glideLine(start, o.glide));
        if (!has) throw new Error('Module._omw_debug_teleport is not exported by this engine');
        await sleep(o.seconds * 1000);
        glideEnd = await frame.evaluate(() => { const P = window.__placeProbe; clearInterval(P.glide); return (P.glideEnd = performance.now()); });
      } else if (mode === 'door') {
        // (a door's load: the console's COC to the interior — the door's own path, ActionTeleport into changeToInteriorCell
        // —, the load timed from its Enter. --lead s: the interior's learned set asked at the place's priority that long
        // before — what a page that guessed the door would fetch: the gain's upper bound; 0: nothing ahead)
        if (o.leadS > 0) {
          lead = await frame.evaluate(placeLead, { name: id, place: o.interior });
          await sleep(o.leadS * 1000);
        }
        await frame.evaluate(() => { window.focus(); document.getElementById('canvas')?.focus(); });
        await page.keyboard.press('Backquote'); await sleep(800);
        await page.keyboard.type(`coc "${o.interior}"`); await sleep(300);
        await frame.evaluate(() => { const P = window.__placeProbe; P.on = true; P.gaps = []; P.frames = []; P.samples = []; P.cells = []; P.key = 'Enter'; P.armAt = performance.now(); });
        await page.keyboard.press('Enter');
        if (await look(frame, () => window.__placeProbe.keyAt, undefined, 10000) === null) {
          notes.push('Enter keydown not seen in the frame within 10 s: the load timed from the arming');
          await look(frame, () => { const P = window.__placeProbe; P.from ??= P.armAt; }, undefined, 900000);
        }
      } else if (mode === 'coe') {
        const has = await frame.evaluate(({ x, y }) => {
          const P = window.__placeProbe; if (typeof window.Module?._omw_debug_coe !== 'function') return false;
          P.on = true; P.gaps = []; P.frames = [];
          setTimeout(() => { P.coeCall = P.from = performance.now(); try { window.Module._omw_debug_coe(x, y); } catch (e) { P.coeErr = String(e?.message ?? e); } P.coeRet = performance.now(); }, 0);
          return true;
        }, { x: toX, y: toY });
        if (!has) throw new Error('Module._omw_debug_coe is not exported by this engine');
      } else {
        await frame.evaluate(() => { const P = window.__placeProbe; P.on = true; P.gaps = []; P.frames = []; P.key = 'F9'; P.armAt = performance.now(); });
        await pressInEngine(page, frame, 'F9');
        const got = await look(frame, () => window.__placeProbe.keyAt, undefined, 10000);
        if (got === null) {
          // (the keydown not seen by the frame — or the thread already held by the load: its time is the arming's then)
          notes.push('F9 keydown not seen in the frame within 10 s: the load timed from the key press');
          await look(frame, () => { const P = window.__placeProbe; P.from ??= P.armAt; }, undefined, 900000);
        }
      }
      // (the end: the cell reached and frames flowing — SwiftShader draws a town at a few frames a second on this
      // machine: 3 frames in the last 3 s, no gap over 1 s among them; another cell reported than --to: 20 s of that, noted)
      const deadline = Date.now() + (mode === 'glide' ? 0 : 15 * 60000), keyed = Date.now(); let end = null, said = 0;
      while (Date.now() < deadline) {
        await sleep(1000);
        const s = await look(frame, (target) => {
          const P = window.__placeProbe, now = performance.now(), cells = Object.entries(P.cellAt).filter(([, t]) => t > (P.from ?? Infinity));
          const started = P.from !== undefined && (P.coeRet !== undefined || P.coeCall === undefined);
          const flowing = started && P.frames.filter((t) => t > now - 3000).length >= 3 && !P.gaps.some(([a, b]) => b > now - 3000 && b - a > 1000);
          return { now, flowing, at: P.cellAt[target] ?? null, cells, frames: P.frames.length, inWorld: P.inWorldAt !== null, cell: window.omw?.state?.['orthros.cell'] ?? null };
        }, goal);
        if (s && Date.now() - said > 30000) { said = Date.now(); log(`  load: ${s.frames} frames since the ${mode === 'coe' ? 'COE' : 'key'}, in world ${s.inWorld}, cell ${s.cell}, flowing ${s.flowing}`); }
        if (s?.flowing && (s.at !== null || (s.cells.length && s.now - s.cells[0][1] > 20000))) { end = s; if (s.at === null) notes.push(`cell ${goal || 'interior'} never reported: ${s.cell}`); break; }
        if (mode === 'save' && s && !s.inWorld && s.flowing && Date.now() - keyed > 90000) { notes.push('no load 90 s after F9: still in the menu'); break; }
      }
      if (!end && mode !== 'glide') notes.push(`cell ${goal || 'interior'} not reached with frames flowing`);
      if (mode === 'door') await pressInEngine(page, frame, 'Backquote');
      const afterLoad = await stats(frame);
      await sleep((teach ? Math.max(afterS, 25) : afterS) * 1000);
      const P = await look(frame, () => { const P = window.__placeProbe; return { from: P.from ?? null, keyAt: P.keyAt, armAt: P.armAt ?? null, coeCall: P.coeCall, coeRet: P.coeRet, coeErr: P.coeErr ?? null, gaps: P.gaps, cellAt: P.cellAt, inWorldAt: P.inWorldAt, menuAt: P.menuAt, firstDraw: P.firstDraw, frames: P.frames.length, cell: window.omw?.state?.['orthros.cell'] ?? null, cells: P.cells, samples: P.samples, leads: window.StreamFS?.leads?.() ?? null }; }, undefined, 10000);
      return { boot, store0, quietWaitS, before, predicted, afterLoad, after: await stats(frame), store1: await storage(frame, id), mark, markAt, end, P, faults, lead, glideEnd };
    } });
    const recs = readLog(path.join(dir, 'proxy.jsonl'));
    const markRec = recs.find((r) => r.url?.startsWith(`/__qa/mark?${res.mark}`)), docRec = recs.find((r) => r.url?.includes('/app/index.html'));
    if (!markRec) notes.push('marker not in the proxy log: page times not aligned');
    const proxyOf = (pageT) => (markRec && pageT !== null && pageT !== undefined ? markRec.t + (pageT - res.markAt) : null);
    const win = (a, b) => (a !== null && b !== null ? loadWindow(recs, a, b) : null);
    const { P } = res, from = P?.from ?? null;
    const cellAt = mode === 'glide' ? null : P?.cellAt?.[goal] ?? null;
    const lt = from !== null ? loadTimes({ gaps: P.gaps, from, cellAt }) : loadTimes({ from: Infinity });
    // (glide and door: the learned places the server started from — what a page could have fetched ahead)
    const sets = mode === 'glide' || mode === 'door' ? learnedSets(learnFrom && !teach ? learnFrom : learnDir, id) : null;
    const inWorldAt = mode === 'save' && P?.inWorldAt !== null && P?.inWorldAt >= (from ?? Infinity) ? P.inWorldAt : null;
    const toInWorld = mode === 'save' && inWorldAt !== null ? win(proxyOf(from), proxyOf(inWorldAt)) : null, loadDelta = delta(res.before, res.afterLoad);
    const known = mode === 'save' ? placesSummary(learnFrom && !teach ? learnFrom : learnDir, id, o.place) : null;
    const row = {
      tag, run: n, ...(teach ? { teachRun: true } : {}), ...(o.query ? { query: o.query } : {}), ...(o.teachQuery ? { teachQuery: o.teachQuery } : {}), profile: o.profile, teach: o.teach, tree, commit: treeId(tree), scenario: { coe: 'C', save: 'S', glide: 'G', door: 'D' }[mode], manifest: id, link: { rate, rtt }, ...(mode !== 'save' ? { start } : { entry, menuS, save: path.basename(saveFile) }), to: mode === 'door' ? o.interior : mode === 'glide' ? null : target,
      ...(engineNote ? { engine: engineNote } : {}), wallS: Math.round((Date.now() - t0) / 1000),
      engineStart: mode !== 'save'
        ? { firstFrameS: s1(res.boot?.firstDraw), inWorldS: s1(res.boot?.inWorldAt), toInWorld: docRec && res.boot ? summarize(recs, docRec.t + res.boot.inWorldAt) : null }
        : { firstFrameS: s1(res.boot?.firstDraw), menuS: s1(res.boot?.menuAt), toMenu: docRec && res.boot?.menuAt ? summarize(recs, docRec.t + res.boot.menuAt) : null, save: res.boot?.save ?? null },
      quietWaitS: res.quietWaitS,
      load: {
        ...(mode !== 'save' ? { coeSyncMs: P?.coeRet !== undefined ? Math.round(P.coeRet - P.coeCall) : null, coeErr: P?.coeErr ?? null } : { keySeen: P?.keyAt !== null && P?.keyAt !== undefined, inWorldS: inWorldAt !== null ? s1(inWorldAt - from) : null }),
        frozenMs: lt.frozenMs, frozenStartMs: lt.frozenStartMs, stallsOver250Ms: lt.stallsOver250Ms,
        cellReachedS: cellAt !== null && from !== null ? s1(cellAt - from) : null, steadyS: lt.steadyAt && from !== null ? s1(lt.steadyAt - from) : null, cellAtEnd: P?.cell ?? null,
      },
      frozen: lt.longest ? win(proxyOf(from), proxyOf(lt.longest[1])) : null,
      ...(mode === 'save' ? { toInWorld, menu: win(proxyOf(res.markAt - menuS * 1000), proxyOf(res.markAt)) } : {}),
      toSteady: lt.steadyAt ? win(proxyOf(from), proxyOf(lt.steadyAt)) : null,
      streamfs: { load: loadDelta, toEnd: delta(res.before, res.after) },
      // (stage 3: the hint, the places the server knew, what the page fetched before the key, the load after it)
      ...(mode === 'save' ? { stage3: {
        hint: { menu: res.store0?.placeHint ?? null, end: res.store1?.placeHint ?? null },
        places: known,
        predicted: res.predicted ?? null, placeBg: res.before?.net?.bgBy?.place ?? null,
        prefetch: from !== null ? prefetchReport(recs, { docT: docRec?.t ?? 0, menuT: proxyOf(res.boot?.menuAt), keyT: proxyOf(from), placePaths: known?.paths ?? null }) : null,
        load: {
          keyToWorldS: inWorldAt !== null ? s1(inWorldAt - from) : null, serialReads: toInWorld?.demand.count ?? null, serialWaitMs: toInWorld?.demand.waitMs ?? null, want: toInWorld?.want ?? null,
          waits: loadDelta?.wantWaits ?? null, waitMs: loadDelta?.wantWaitMs ?? null, timeouts: loadDelta?.wantTimeouts ?? null, announced: loadDelta?.wants ?? null,
        },
      } } : {}),
      ...(mode === 'glide' ? { glide: glideReport({ P, glideEnd: res.glideEnd, recs, proxyOf, sets, line: glideLine(start, o.glide), spec: o.glide }) } : {}),
      ...(mode === 'door' ? { door: (() => {
        const known = placesSummary(learnFrom && !teach ? learnFrom : learnDir, id, o.interior), keyT = proxyOf(from);
        return {
          interior: o.interior, leadS: o.leadS, lead: res.lead, learned: known, leads: P?.leads ?? null,
          // (the interior's set fetched before the Enter: requests, bytes, the last one's end against it)
          ahead: keyT !== null ? prefetchReport(recs, { docT: docRec?.t ?? 0, keyT, placePaths: known?.paths ?? null }).place : null,
          // (the load's own network reads, Enter to frames back, and how much of them the learned places had)
          reads: lt.steadyAt && keyT !== null ? readCoverage(recs, keyT, proxyOf(lt.steadyAt), sets, o.interior) : null,
        };
      })() } : {}),
      store: { before: res.store0, after: res.store1 }, all: summarize(recs), faults: res.faults, notes,
    };
    if (teach) fs.writeFileSync(path.join(dir, 'row.json'), JSON.stringify(row) + '\n');
    else fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
    // (kept: the logs, small; the profile and the server's copies removed — a teach run's learn directory is not here)
    for (const d of ['profile', 'learn', 'telemetry']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    execFileSync('gzip', ['-f', path.join(dir, 'proxy.jsonl')]);
    const w = row.frozen, l = row.toInWorld ?? row.toSteady, st3 = row.stage3;
    if (st3) log(`  stage 3: hint ${st3.hint.menu} -> ${st3.hint.end}; places ${st3.places ? `${st3.places.places} (target ${st3.places.target} records, ${st3.places.targetMB} MB)` : 'none'}; predicted ${JSON.stringify(st3.predicted)}; before the key: place set ${st3.prefetch?.place.count} requests (${st3.prefetch?.place.wireMB} MB wire, ${st3.prefetch?.inMenu?.wireMB ?? '?'} in the menu, first ${st3.prefetch?.place.firstS} s, last end ${st3.prefetch?.place.lastEndS} s = ${st3.prefetch?.place.lastEndToKeyS} s from the key, ${st3.prefetch?.place.inFlightAtKey} in flight), announced ${st3.prefetch?.want.count}; load: ${st3.load.keyToWorldS} s, ${st3.load.serialReads} serial reads, want ${st3.load.want?.count} (${st3.load.want?.wireMB} MB), ${st3.load.waits} waits ${st3.load.waitMs} ms, ${st3.load.timeouts} timeouts`);
    if (row.glide) {
      for (const c of row.glide.crossings) log(`  crossing ${c.cell} at ${c.atS} s: longest gap ${c.longestGapMs} ms, ${c.gapsOver250} over 250 ms (${c.gapsOver250Ms} ms), stall ${c.stallMs} ms, ${c.syncFetches} sync reads, ${c.wantWaits} waits ${c.wantWaitMs} ms; network ${c.net?.reads} reads ${c.net?.MB} MB (learned for the cell ${c.net?.inPlaceMB}, any place ${c.net?.inAnyMB})`);
      log(`  glide: ${JSON.stringify(row.glide.total)}`);
    }
    if (row.door) log(`  door ${row.door.interior}: lead ${row.door.leadS} s ${JSON.stringify(row.door.lead)}; ahead ${row.door.ahead?.count} requests ${row.door.ahead?.wireMB} MB wire; load reads ${row.door.reads?.reads} (${row.door.reads?.MB} MB, learned ${row.door.reads?.inPlaceMB}); waits ${row.streamfs.load?.wantWaits} ${row.streamfs.load?.wantWaitMs} ms`);
    log(`${tag} ${teach ? 'teach ' : ''}#${n} (${row.scenario}): engine ${mode !== 'save' ? `in world ${row.engineStart.inWorldS}` : `menu ${row.engineStart.menuS}`} s; ${mode === 'save' ? `in world ${row.load.inWorldS} s after the key, ` : ''}frozen ${row.load.frozenMs} ms, steady ${row.load.steadyS} s, cell ${row.load.cellAtEnd}; frozen: demand ${w?.demand.count} reads, ${w?.demand.decodedMB} MB decoded, spacing p50 ${w?.demand.spacing.p50} ms; background ${w?.backgroundMB} MB ${JSON.stringify(w?.backgroundByCategory ?? {})}; ${mode === 'save' ? 'to the world' : 'to steady'}: demand ${l?.demand.count}, background ${l?.backgroundMB} MB${notes.length ? ' — ' + notes.join('; ') : ''}`);
    return row;
  }

  fs.mkdirSync(scratch, { recursive: true });
  if (o.profile === 'warm' && !fs.existsSync(warmDir)) await warmUp();
  if (mode === 'save' && (o.makeSave || !fs.existsSync(saveFile + '.json'))) await makeSave();
  if (!o.warmOnly) {
    // (taught first: one learn copy for the invocation, the measured runs start from copies of it; removed at the end)
    let learnFrom = path.join(pristine, 'learn'), teachDir = null;
    try {
      if (o.teach > 0) {
        teachDir = path.join(scratch, 'teach', `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        fs.mkdirSync(teachDir, { recursive: true });
        learnFrom = path.join(teachDir, 'learn');
        execFileSync('cp', ['-a', path.join(pristine, 'learn'), learnFrom]);
        for (let n = 1; n <= o.teach; n++) await measured(n, { teach: learnFrom });
        const places = placesSummary(learnFrom, id, o.place);
        log(`taught ${o.teach}: ${places ? `${places.file} ${places.bytes} bytes, ${places.places} places, ${o.place}: ${places.target} units` : `no places-${id}.json in the learn copy (the tree's server learns none?)`}`);
      }
      for (let n = 1; n <= runs; n++) await measured(n, { learnFrom });
    } finally {
      // (the teach copy's places file kept beside its runs, small; the learn copy itself removed)
      if (teachDir) {
        const pf = path.join(learnFrom, `places-${id}.json`);
        if (fs.existsSync(pf)) fs.copyFileSync(pf, path.join(teachDir, path.basename(pf)));
        fs.rmSync(learnFrom, { recursive: true, force: true });
      }
    }
  }
}
