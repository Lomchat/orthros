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
//   The save, once (--make-save, or --save missing): the engine page ?start=<--to>&novid on a plain local server of
//   --warm-tree (no proxy: a throwaway profile and origin, the warm store untouched), in the world, the data quiet,
//   F5 (QuickSave), the newest .omwsave read back from the engine's FS into --save, its character folder in <save>.json.
// - --engine <release>: the measured version's openmw.engine replaced by that release, in a scratch games folder
//   (<scratch>/games-<release>: one real folder a game, of links to the live game's entries — the server's catalog
//   takes real folders only —, a modified copy of the measured game's manifest.json; the versions it requires keep
//   theirs), its engine from --engines-dir (default the live one). The live games folder checked for new links after.
// One JSON line per run in --out: the engine's start, the frozen load (the longest gap between frames drawn after the
// COE or the key), the proxy log's stretch of that frozen frame (loadWindow: the game's reads — count, decoded, wire,
// spacing, ttfb, idle — and the background's bytes by kind and file category, 'upgrade' the full file of a light copy
// read this run), the same to the player in the world (S) and to the frames' return (toSteady), the data stats' delta
// (__streamfsStats), the whole run's summary. Runs are sequential; the whole tool holds one browser slot:
//
//   tools/with-browser-slot.sh node tools/openmw/place-load.mjs <manifest> --tree <code tree> [--mode coe|save] [--runs 2]
//     [--tag baseline] [--pristine /tmp/orthros-scratch/mw-load/pristine] [--scratch /tmp/orthros-scratch/mw-load]
//     [--profile-warm <dir>] [--warm-tree /srv/orthros] [--warm-seconds 120] [--rate 1.8m] [--rtt 90] [--listen 18447]
//     [--start -2,-9] [--to -2,6] [--quiet 10] [--after 30] [--out <scratch>/results.jsonl] [--games-dir ..]
//     [--engines-dir ..] [--engine <release>] [--covers off|<dir>] [--warm-only]
//     save: [--entry play|engine] [--menu 10] [--save <scratch>/saves/<to>.omwsave] [--make-save]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
/** Where the engine's saves may be (IDBFS): the engine's user data folder — /userdata/saves in the r8 page, seen —, its XDG data home's. */
export const SAVES_DIRS = ['/userdata/saves', '/userdata/data-home/openmw/saves'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s1 = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : Math.round(ms / 100) / 10);

/**
 * A games folder for a test server whose `version` runs `engine`: `out` (made anew: a real folder) holds one real folder
 * per game of `live` — the server's catalog takes real folders only (a link's Dirent is no directory) — of links to the
 * live game's entries (base, versions, cover…), the game of `version` with a copy of its manifest.json, that version's
 * openmw.engine replaced (the versions it requires keep their own). Never a link into an existing link: every folder
 * linked into is made here, checked a real folder first. `live` is only read. Returns { out, game, previous }.
 */
export function scratchGames({ live, out, version, engine }) {
  const games = fs.readdirSync(live, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  let game = null, spec = null, previous = null;
  for (const g of games) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(live, g, 'manifest.json'), 'utf8')); } catch { continue; }
    const v = m.versions?.find((x) => x.id === version);
    if (v) { game = g; spec = m; previous = v.openmw?.engine ?? null; if (!v.openmw) throw new Error(`${version}: not an OpenMW version`); v.openmw = { ...v.openmw, engine }; }
  }
  if (!game) throw new Error(`${version}: no version of that id in ${live}`);
  clearScratchGames(out);
  fs.mkdirSync(out);
  for (const g of games) {
    const dir = path.join(out, g);
    fs.mkdirSync(dir);
    if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== path.resolve(dir)) throw new Error(`${dir}: not a real folder of the scratch`);
    for (const e of fs.readdirSync(path.join(live, g))) {
      if (g === game && e === 'manifest.json') fs.writeFileSync(path.join(dir, e), JSON.stringify(spec, null, 2) + '\n');
      else fs.symlinkSync(path.join(live, g, e), path.join(dir, e));
    }
  }
  return { out, game, previous };
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

/** The page's probe, before its scripts (the engine page only): frames drawn, the gaps between them once armed, the engine's main loop, the world and the cells reached, the trigger key. */
function probe() {
  if (!location.pathname.includes('/app/')) return;
  const P = window.__placeProbe = { draws: 0, firstDraw: null, menuAt: null, inWorldAt: null, last: null, on: false, frames: [], gaps: [], cellAt: {}, keyAt: null };
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!type) continue;
    for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = type.prototype[m]; if (f) type.prototype[m] = function (...a) { P.draws++; return f.apply(this, a); };
    }
  }
  const raf = window.requestAnimationFrame.bind(window);
  let seen = 0;
  const tick = (t) => {
    if (P.draws !== seen) {
      seen = P.draws; P.firstDraw ??= t;
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
    const c = st['orthros.cell']; if (c && !(c in P.cellAt)) P.cellAt[c] = performance.now();
  }, 100);
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
const storage = (f) => look(f, async () => ({ estimateMB: await navigator.storage.estimate().then((e) => Math.round(e.usage / 1e5) / 10).catch(() => null), netBw: localStorage.getItem('orthros.netBw'), offlineCopy: localStorage.getItem('orthros.offlineCopy') }), undefined, 10000);
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
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('../port-perf.mjs');
  const { startProxy, startOrigin, spkiOf, parseRate, readLog, loadWindow, summarize, urlKind } = await import('../net-proxy.mjs');

  const args = process.argv.slice(2), id = args[0], opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
  if (!id || id.startsWith('--') || !opt('tree')) { console.error('usage: node tools/openmw/place-load.mjs <manifest> --tree <code tree> [--mode coe|save] [--runs 2] [--tag t] [--engine <release>] [--engines-dir dir] [--to x,y] ... (see the header)'); process.exit(2); }
  const mode = opt('mode', 'coe'); if (!['coe', 'save'].includes(mode)) throw new Error(`--mode ${mode}: coe or save`);
  const scratch = path.resolve(opt('scratch', '/tmp/orthros-scratch/mw-load'));
  const pristine = path.resolve(opt('pristine', path.join(scratch, 'pristine')));
  const tree = path.resolve(opt('tree')), warmTree = path.resolve(opt('warm-tree', '/srv/orthros'));
  const warmDir = path.resolve(opt('profile-warm', path.join(scratch, 'profile-warm')));
  const outFile = path.resolve(opt('out', path.join(scratch, 'results.jsonl')));
  const rate = parseRate(opt('rate', '1.8m')), rtt = Number(opt('rtt', 90)), listen = Number(opt('listen', 18447));
  const start = opt('start', '-2,-9'), to = opt('to', '-2,6'), [toX, toY] = to.split(',').map(Number), target = `${toX} ${toY}`;
  const quietS = Number(opt('quiet', 10)), afterS = Number(opt('after', 30)), warmS = Number(opt('warm-seconds', 120)), menuS = Number(opt('menu', 10));
  const entry = opt('entry', 'play'); if (!['play', 'engine'].includes(entry)) throw new Error(`--entry ${entry}: play or engine`);
  const liveGames = path.resolve(opt('games-dir', '/srv/orthros/data/games')), enginesDir = path.resolve(opt('engines-dir', '/srv/orthros/data/engines'));
  const engine = opt('engine'), saveFile = path.resolve(opt('save', path.join(scratch, 'saves', `${to.replace(/[^0-9a-z-]+/gi, '_')}.omwsave`)));
  const covers = opt('covers', 'off'), runs = Number(opt('runs', 2)), tag = opt('tag', 'run');
  for (const d of [pristine, warmDir, scratch]) if (d.startsWith('/var/lib')) throw new Error(`${d}: never the live state — a copy under the scratch`);
  if (path.resolve(scratch).startsWith('/srv/orthros/data')) throw new Error(`${scratch}: never under the live data`);
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
  }

  /**
   * One browser session through a proxy at the pinned port over the tree's server: `ready` (in the engine's frame)
   * awaited, then `body(frame, { page, proxyNow, faults, dir })`. `init`: [script, arg] added after the probe.
   */
  async function session({ codeTree, profile, dir, url, ready, init = null, body }) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('cp', ['-a', path.join(pristine, 'learn'), path.join(dir, 'learn')]);
    const origin = await startOrigin({ tree: codeTree, learn: path.join(dir, 'learn'), telemetry: path.join(dir, 'telemetry'), brcache: path.join(pristine, 'brcache'), covers, gamesDir, enginesDir, log: path.join(dir, 'server.log') });
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
      return { inWorldS, storage: await storage(frame), stats: await stats(frame), cell: await look(frame, () => window.omw?.state?.['orthros.cell'] ?? null), faults };
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

  async function measured(n) {
    const dir = path.join(scratch, 'runs', `${tag}-${n}-${new Date().toISOString().replace(/[:.]/g, '-')}`), profile = path.join(dir, 'profile');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('cp', ['-a', warmDir, profile]);
    const t0 = Date.now(), notes = [];
    const save = mode === 'save' ? JSON.parse(fs.readFileSync(saveFile + '.json', 'utf8')) : null;
    const url = mode === 'coe' ? enginePage(`&start=${encodeURIComponent(start)}&novid`) : entry === 'play' ? `/ports/openmw/${encodeURIComponent(id)}/?mode=solo` : enginePage('&novid');
    const init = save ? [injectSave, { dir: save.dir, character: save.character, file: save.file, b64: fs.readFileSync(saveFile).toString('base64') }] : null;
    const ready = mode === 'coe' ? inWorld : () => window.__placeProbe?.menuAt != null;
    const res = await session({ codeTree: tree, profile, dir, url, ready, init, body: async (frame, { page, proxyNow, faults }) => {
      const boot = await look(frame, () => ({ firstDraw: window.__placeProbe.firstDraw, menuAt: window.__placeProbe.menuAt, inWorldAt: window.__placeProbe.inWorldAt, cell: window.omw?.state?.['orthros.cell'] ?? null, save: window.__placeSave ?? null }));
      const store0 = await storage(frame);
      let quietWaitS = null;
      if (mode === 'coe') {
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
      // (the marker: through the proxy, its log's clock against the engine frame's)
      const mark = `place-${n}-${Date.now()}`;
      const markAt = await frame.evaluate(async (mark) => { const t = performance.now(); await fetch(`/__qa/mark?${mark}`, { cache: 'no-store' }).catch(() => {}); return t; }, mark);
      if (mode === 'coe') {
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
      const deadline = Date.now() + 15 * 60000, keyed = Date.now(); let end = null, said = 0;
      while (Date.now() < deadline) {
        await sleep(1000);
        const s = await look(frame, (target) => {
          const P = window.__placeProbe, now = performance.now(), cells = Object.entries(P.cellAt).filter(([, t]) => t > (P.from ?? Infinity));
          const started = P.from !== undefined && (P.coeRet !== undefined || P.coeCall === undefined);
          const flowing = started && P.frames.filter((t) => t > now - 3000).length >= 3 && !P.gaps.some(([a, b]) => b > now - 3000 && b - a > 1000);
          return { now, flowing, at: P.cellAt[target] ?? null, cells, frames: P.frames.length, inWorld: P.inWorldAt !== null, cell: window.omw?.state?.['orthros.cell'] ?? null };
        }, target);
        if (s && Date.now() - said > 30000) { said = Date.now(); log(`  load: ${s.frames} frames since the ${mode === 'coe' ? 'COE' : 'key'}, in world ${s.inWorld}, cell ${s.cell}, flowing ${s.flowing}`); }
        if (s?.flowing && (s.at !== null || (s.cells.length && s.now - s.cells[0][1] > 20000))) { end = s; if (s.at === null) notes.push(`cell ${target} never reported: ${s.cell}`); break; }
        if (mode === 'save' && s && !s.inWorld && s.flowing && Date.now() - keyed > 90000) { notes.push('no load 90 s after F9: still in the menu'); break; }
      }
      if (!end) notes.push(`cell ${target} not reached with frames flowing`);
      const afterLoad = await stats(frame);
      await sleep(afterS * 1000);
      const P = await look(frame, () => { const P = window.__placeProbe; return { from: P.from ?? null, keyAt: P.keyAt, armAt: P.armAt ?? null, coeCall: P.coeCall, coeRet: P.coeRet, coeErr: P.coeErr ?? null, gaps: P.gaps, cellAt: P.cellAt, inWorldAt: P.inWorldAt, menuAt: P.menuAt, firstDraw: P.firstDraw, frames: P.frames.length, cell: window.omw?.state?.['orthros.cell'] ?? null }; }, undefined, 10000);
      return { boot, store0, quietWaitS, before, afterLoad, after: await stats(frame), store1: await storage(frame), mark, markAt, end, P, faults };
    } });
    const recs = readLog(path.join(dir, 'proxy.jsonl'));
    const markRec = recs.find((r) => r.url?.startsWith(`/__qa/mark?${res.mark}`)), docRec = recs.find((r) => r.url?.includes('/app/index.html'));
    if (!markRec) notes.push('marker not in the proxy log: page times not aligned');
    const proxyOf = (pageT) => (markRec && pageT !== null && pageT !== undefined ? markRec.t + (pageT - res.markAt) : null);
    const win = (a, b) => (a !== null && b !== null ? loadWindow(recs, a, b) : null);
    const { P } = res, from = P?.from ?? null;
    const cellAt = P?.cellAt?.[target] ?? null;
    const lt = from !== null ? loadTimes({ gaps: P.gaps, from, cellAt }) : loadTimes({ from: Infinity });
    const inWorldAt = mode === 'save' && P?.inWorldAt !== null && P?.inWorldAt >= (from ?? Infinity) ? P.inWorldAt : null;
    const row = {
      tag, run: n, tree, commit: treeId(tree), scenario: mode === 'coe' ? 'C' : 'S', manifest: id, link: { rate, rtt }, ...(mode === 'coe' ? { start } : { entry, menuS, save: path.basename(saveFile) }), to: target,
      ...(engineNote ? { engine: engineNote } : {}), wallS: Math.round((Date.now() - t0) / 1000),
      engineStart: mode === 'coe'
        ? { firstFrameS: s1(res.boot?.firstDraw), inWorldS: s1(res.boot?.inWorldAt), toInWorld: docRec && res.boot ? summarize(recs, docRec.t + res.boot.inWorldAt) : null }
        : { firstFrameS: s1(res.boot?.firstDraw), menuS: s1(res.boot?.menuAt), toMenu: docRec && res.boot?.menuAt ? summarize(recs, docRec.t + res.boot.menuAt) : null, save: res.boot?.save ?? null },
      quietWaitS: res.quietWaitS,
      load: {
        ...(mode === 'coe' ? { coeSyncMs: P?.coeRet !== undefined ? Math.round(P.coeRet - P.coeCall) : null, coeErr: P?.coeErr ?? null } : { keySeen: P?.keyAt !== null && P?.keyAt !== undefined, inWorldS: inWorldAt !== null ? s1(inWorldAt - from) : null }),
        frozenMs: lt.frozenMs, frozenStartMs: lt.frozenStartMs, stallsOver250Ms: lt.stallsOver250Ms,
        cellReachedS: cellAt !== null && from !== null ? s1(cellAt - from) : null, steadyS: lt.steadyAt && from !== null ? s1(lt.steadyAt - from) : null, cellAtEnd: P?.cell ?? null,
      },
      frozen: lt.longest ? win(proxyOf(from), proxyOf(lt.longest[1])) : null,
      ...(mode === 'save' ? { toInWorld: inWorldAt !== null ? win(proxyOf(from), proxyOf(inWorldAt)) : null, menu: win(proxyOf(res.markAt - menuS * 1000), proxyOf(res.markAt)) } : {}),
      toSteady: lt.steadyAt ? win(proxyOf(from), proxyOf(lt.steadyAt)) : null,
      streamfs: { load: delta(res.before, res.afterLoad), toEnd: delta(res.before, res.after) },
      store: { before: res.store0, after: res.store1 }, all: summarize(recs), faults: res.faults, notes,
    };
    fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
    // (kept: the logs, small; the profile copy and the server's copies removed)
    for (const d of ['profile', 'learn', 'telemetry']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    execFileSync('gzip', ['-f', path.join(dir, 'proxy.jsonl')]);
    const w = row.frozen, l = row.toInWorld ?? row.toSteady;
    log(`${tag} #${n} (${row.scenario}): engine ${mode === 'coe' ? `in world ${row.engineStart.inWorldS}` : `menu ${row.engineStart.menuS}`} s; ${mode === 'save' ? `in world ${row.load.inWorldS} s after the key, ` : ''}frozen ${row.load.frozenMs} ms, steady ${row.load.steadyS} s, cell ${row.load.cellAtEnd}; frozen: demand ${w?.demand.count} reads, ${w?.demand.decodedMB} MB decoded, spacing p50 ${w?.demand.spacing.p50} ms; background ${w?.backgroundMB} MB ${JSON.stringify(w?.backgroundByCategory ?? {})}; ${mode === 'save' ? 'to the world' : 'to steady'}: demand ${l?.demand.count}, background ${l?.backgroundMB} MB${notes.length ? ' — ' + notes.join('; ') : ''}`);
    return row;
  }

  fs.mkdirSync(scratch, { recursive: true });
  if (!fs.existsSync(warmDir)) await warmUp();
  if (mode === 'save' && (args.includes('--make-save') || !fs.existsSync(saveFile + '.json'))) await makeSave();
  if (!args.includes('--warm-only')) for (let n = 1; n <= runs; n++) await measured(n);
}
