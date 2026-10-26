// A returning player's load of a place outside the learned area, OpenMW (docs/slow-network.md "Measuring"): the engine
// page (?start=<cell>: a new character dropped there, QA auto-chargen) over the player's-link proxy (tools/net-proxy.mjs:
// HTTP/2, one shared link, a round trip a request) in front of an Orthros server of the code tree under test (--tree:
// its src/host/server.js on a fresh copy of the pristine learned directory and the pristine precompressed units, frozen),
// in a browser profile that already played once (its block store, link measure and HTTP cache: the proxy's port and
// certificate pinned, so the origin is the same at every run).
// - Warm-up, once (when --profile-warm does not exist yet, with --warm-tree's code): the page booted into --start, in
//   the world, then --warm-seconds more; the profile kept as the warm profile, the store's size and link measure noted.
// - Each measured run (scenario C, a debug COE): a copy of the warm profile, a warm boot to the world (the engine's
//   start measured: navigation to the first frame drawn and to the player in the world), the data quiet (--quiet
//   seconds without one of the game's own reads), a marker request through the proxy (its clock and the page's
//   aligned), then Module._omw_debug_coe(--to) — a whole exterior worldspace load, the page's thread held by it —, the
//   cell reached (view.lua's 'orthros.cell') and frames flowing, --after seconds more, closed.
// One JSON line per run in --out: the engine's start, the frozen load (the longest gap between frames drawn after the
// COE), the proxy log's stretch of that frozen frame (loadWindow: the game's reads — count, decoded, wire, spacing,
// ttfb, idle — and the background's bytes by kind and file category, 'upgrade' the full file of a light copy read
// this run), the same to the frames' return (toSteady), the data stats' delta (__streamfsStats), the whole run's
// summary. Runs are sequential; the whole tool holds one browser slot:
//
//   tools/with-browser-slot.sh node tools/openmw/place-load.mjs <manifest> --tree <code tree> [--runs 2] [--tag baseline]
//     [--pristine /tmp/orthros-scratch/mw-load/pristine] [--scratch /tmp/orthros-scratch/mw-load] [--profile-warm <dir>]
//     [--warm-tree /srv/orthros] [--warm-seconds 120] [--rate 1.8m] [--rtt 90] [--listen 18447] [--start -2,-9]
//     [--to -2,6] [--quiet 10] [--after 30] [--out <scratch>/results.jsonl] [--games-dir ..] [--engines-dir ..]
//     [--covers off|<dir>] [--warm-only]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { launchOptions } from '../port-perf.mjs';
import { startProxy, startOrigin, spkiOf, parseRate, readLog, loadWindow, summarize, urlKind } from '../net-proxy.mjs';

const args = process.argv.slice(2), id = args[0], opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!id || id.startsWith('--') || !opt('tree')) { console.error('usage: node tools/openmw/place-load.mjs <manifest> --tree <code tree> [--runs 2] [--tag t] [--pristine dir] [--scratch dir] [--to x,y] ...'); process.exit(2); }
const scratch = path.resolve(opt('scratch', '/tmp/orthros-scratch/mw-load'));
const pristine = path.resolve(opt('pristine', path.join(scratch, 'pristine')));
const tree = path.resolve(opt('tree')), warmTree = path.resolve(opt('warm-tree', '/srv/orthros'));
const warmDir = path.resolve(opt('profile-warm', path.join(scratch, 'profile-warm')));
const outFile = path.resolve(opt('out', path.join(scratch, 'results.jsonl')));
const rate = parseRate(opt('rate', '1.8m')), rtt = Number(opt('rtt', 90)), listen = Number(opt('listen', 18447));
const start = opt('start', '-2,-9'), [toX, toY] = opt('to', '-2,6').split(',').map(Number), target = `${toX} ${toY}`;
const quietS = Number(opt('quiet', 10)), afterS = Number(opt('after', 30)), warmS = Number(opt('warm-seconds', 120));
const gamesDir = opt('games-dir', '/srv/orthros/data/games'), enginesDir = opt('engines-dir', '/srv/orthros/data/engines');
const covers = opt('covers', 'off'), runs = Number(opt('runs', 2)), tag = opt('tag', 'run');
for (const d of [pristine, warmDir, scratch]) if (d.startsWith('/var/lib')) throw new Error(`${d}: never the live state — a copy under the scratch`);
const certs = path.join(scratch, 'cert');
const pageUrl = (port) => `https://127.0.0.1:${port}/ports/openmw/${encodeURIComponent(id)}/app/index.html?src=hosted&start=${encodeURIComponent(start)}&novid`;
const log = (...a) => console.log('[place-load]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s1 = (ms) => (ms === null || ms === undefined ? null : Math.round(ms / 100) / 10);

/** The page's probe, before its scripts (the engine page only): frames drawn, the gaps between them once armed, the world and the cells reached. */
function probe() {
  if (!location.pathname.includes('/app/')) return;
  const P = window.__placeProbe = { draws: 0, firstDraw: null, inWorldAt: null, last: null, on: false, frames: [], gaps: [], cellAt: {} };
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
  setInterval(() => {
    const st = window.omw?.state ?? {};
    if (P.inWorldAt === null && st['orthros.view'] !== undefined) P.inWorldAt = performance.now();
    const c = st['orthros.cell']; if (c && !(c in P.cellAt)) P.cellAt[c] = performance.now();
  }, 100);
}

/** An evaluate that gives up (null) while the page's thread is held (a load in one frame). */
const look = (page, fn, arg, ms = 3000) => {
  // (one at a time: those asked while the thread is held would all run at its end)
  if (page.lookBusy) return Promise.race([page.lookBusy.then(() => null), sleep(ms).then(() => null)]);
  const p = page.lookBusy = page.evaluate(fn, arg).catch(() => null).finally(() => { if (page.lookBusy === p) page.lookBusy = null; });
  return Promise.race([p, sleep(ms).then(() => null)]);
};
const stats = (page) => look(page, () => (window.__streamfsStats ? JSON.parse(JSON.stringify(window.__streamfsStats)) : null));
const storage = (page) => look(page, async () => ({ estimateMB: await navigator.storage.estimate().then((e) => Math.round(e.usage / 1e5) / 10).catch(() => null), netBw: localStorage.getItem('orthros.netBw'), offlineCopy: localStorage.getItem('orthros.offlineCopy') }), undefined, 10000);
const delta = (a, b) => (a && b ? Object.fromEntries(Object.keys(b).filter((k) => typeof b[k] === 'number' && typeof a[k] === 'number').map((k) => [k, Math.round(b[k] - a[k])])) : null);

/** One browser session through a proxy at the pinned port over the tree's server: `body(page, ctx)` once the page is in the world. */
async function session({ codeTree, profile, dir, body }) {
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
    const page = ctx.pages()[0] ?? await ctx.newPage();
    page.on('pageerror', (e) => faults.push(e.message.slice(0, 300)));
    page.on('crash', () => faults.push('page crashed'));
    page.on('console', (m) => consoleLog.write(`${m.type()} ${m.text()}\n`));
    await page.goto(pageUrl(listen), { timeout: 120000 });
    await page.waitForFunction(() => window.__placeProbe?.inWorldAt !== null, null, { timeout: 900000, polling: 500 });
    return await body(page, { proxyNow, faults, dir });
  } finally {
    // (left as a player leaves: the page's pagehide saves the link's measure, localStorage 'orthros.netBw' — a closed
    // context fires none)
    const page = ctx?.pages()[0];
    if (page) await Promise.race([page.goto('about:blank').catch(() => {}), sleep(20000)]);
    await ctx?.close().catch(() => {}); consoleLog.end();
    await proxy.close(); await origin.close();
  }
}

/** The tree's commit and whether it has changes (the code measured). */
function treeId(t) {
  try { return `${execFileSync('git', ['-C', t, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}${execFileSync('git', ['-C', t, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim() ? '+dirty' : ''}`; } catch { return null; }
}

async function warmUp() {
  const dir = path.join(scratch, 'warm'), building = warmDir + '.building';
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(building, { recursive: true, force: true });
  log(`warm-up: ${warmTree}, ${warmS} s in the world, profile ${warmDir}`);
  const t0 = Date.now();
  const res = await session({ codeTree: warmTree, profile: building, dir, body: async (page, { faults }) => {
    const inWorldS = s1((await look(page, () => window.__placeProbe.inWorldAt)));
    await sleep(warmS * 1000);
    return { inWorldS, storage: await storage(page), stats: await stats(page), cell: await look(page, () => window.omw?.state?.['orthros.cell'] ?? null), faults };
  } });
  const recs = readLog(path.join(dir, 'proxy.jsonl'));
  const row = { warm: true, tree: warmTree, commit: treeId(warmTree), seconds: warmS, wallS: Math.round((Date.now() - t0) / 1000), ...res, all: summarize(recs) };
  fs.renameSync(building, warmDir);
  fs.writeFileSync(path.join(scratch, 'warm.json'), JSON.stringify(row, null, 1));
  fs.rmSync(path.join(dir, 'learn'), { recursive: true, force: true }); fs.rmSync(path.join(dir, 'telemetry'), { recursive: true, force: true });
  execFileSync('gzip', ['-f', path.join(dir, 'proxy.jsonl')]);
  log(`warm-up done: in world ${row.inWorldS} s, store ${row.storage?.estimateMB} MB, netBw ${row.storage?.netBw}, ${row.all.wireMB} MB on the wire`);
}

async function measured(n) {
  const dir = path.join(scratch, 'runs', `${tag}-${n}-${new Date().toISOString().replace(/[:.]/g, '-')}`), profile = path.join(dir, 'profile');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('cp', ['-a', warmDir, profile]);
  const t0 = Date.now(), notes = [];
  const res = await session({ codeTree: tree, profile, dir, body: async (page, { proxyNow, faults }) => {
    const boot = await look(page, () => ({ firstDraw: window.__placeProbe.firstDraw, inWorldAt: window.__placeProbe.inWorldAt, cell: window.omw?.state?.['orthros.cell'] ?? null }));
    const store0 = await storage(page);
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
    const quietWaitS = Math.round((Date.now() - quietFrom) / 1000);
    const before = await stats(page);
    // (the marker: through the proxy, its log's clock against the page's)
    const mark = `place-${n}-${Date.now()}`;
    const markAt = await page.evaluate(async (mark) => { const t = performance.now(); await fetch(`/__qa/mark?${mark}`, { cache: 'no-store' }).catch(() => {}); return t; }, mark);
    const has = await page.evaluate(({ x, y }) => {
      const P = window.__placeProbe; if (typeof window.Module?._omw_debug_coe !== 'function') return false;
      P.on = true; P.gaps = []; P.frames = [];
      setTimeout(() => { P.coeCall = performance.now(); try { window.Module._omw_debug_coe(x, y); } catch (e) { P.coeErr = String(e?.message ?? e); } P.coeRet = performance.now(); }, 0);
      return true;
    }, { x: toX, y: toY });
    if (!has) throw new Error('Module._omw_debug_coe is not exported by this engine');
    // (the end: the cell reached and frames flowing — SwiftShader draws a town at a few frames a second on this machine:
    // 3 frames in the last 3 s, no gap over 1 s among them; another cell reported than --to: 20 s of that, noted)
    const deadline = Date.now() + 15 * 60000; let end = null, said = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const s = await look(page, (target) => {
        const P = window.__placeProbe, now = performance.now(), cells = Object.entries(P.cellAt).filter(([, t]) => t > (P.coeCall ?? Infinity));
        const flowing = P.coeRet !== undefined && P.frames.filter((t) => t > now - 3000).length >= 3 && !P.gaps.some(([a, b]) => b > now - 3000 && b - a > 1000);
        return { now, flowing, at: P.cellAt[target] ?? null, cells, frames: P.frames.length, cell: window.omw?.state?.['orthros.cell'] ?? null };
      }, target);
      if (s && Date.now() - said > 30000) { said = Date.now(); log(`  load: ${s.frames} frames since the COE, cell ${s.cell}, flowing ${s.flowing}`); }
      if (s?.flowing && (s.at !== null || (s.cells.length && s.now - s.cells[0][1] > 20000))) { end = s; if (s.at === null) notes.push(`cell ${target} never reported: ${s.cell}`); break; }
    }
    if (!end) notes.push(`cell ${target} not reached with frames flowing in 15 min`);
    const afterLoad = await stats(page);
    await sleep(afterS * 1000);
    const P = await look(page, () => { const P = window.__placeProbe; return { coeCall: P.coeCall, coeRet: P.coeRet, coeErr: P.coeErr ?? null, gaps: P.gaps, cellAt: P.cellAt, frames: P.frames.length, cell: window.omw?.state?.['orthros.cell'] ?? null }; }, undefined, 10000);
    return { boot, store0, quietWaitS, before, afterLoad, after: await stats(page), store1: await storage(page), mark, markAt, end, P, faults };
  } });
  const recs = readLog(path.join(dir, 'proxy.jsonl'));
  const markRec = recs.find((r) => r.url?.startsWith(`/__qa/mark?${res.mark}`)), docRec = recs.find((r) => r.url?.includes('/app/index.html'));
  if (!markRec) notes.push('marker not in the proxy log: page times not aligned');
  const proxyOf = (pageT) => (markRec ? markRec.t + (pageT - res.markAt) : null);
  const { P } = res;
  const gaps = (P?.gaps ?? []).filter(([, b]) => b >= (P.coeCall ?? 0));
  const longest = gaps.reduce((m, g) => (!m || g[1] - g[0] > m[1] - m[0] ? g : m), null);
  // (frames flowing again: the end of the last gap over 250 ms before the cell's report plus 2 s)
  const cellAt = P?.cellAt?.[target] ?? null;
  const steadyAt = Math.max(longest?.[1] ?? 0, ...gaps.filter(([a, b]) => b - a > 250 && (cellAt === null || a <= cellAt + 2000)).map(([, b]) => b));
  const from = P?.coeCall;
  const row = {
    tag, run: n, tree, commit: treeId(tree), scenario: 'C', manifest: id, link: { rate, rtt }, start, to: target, wallS: Math.round((Date.now() - t0) / 1000),
    engineStart: { firstFrameS: s1(res.boot?.firstDraw), inWorldS: s1(res.boot?.inWorldAt), toInWorld: docRec && res.boot ? summarize(recs, docRec.t + res.boot.inWorldAt) : null },
    quietWaitS: res.quietWaitS,
    load: {
      coeSyncMs: P?.coeRet !== undefined ? Math.round(P.coeRet - P.coeCall) : null, coeErr: P?.coeErr ?? null,
      frozenMs: longest ? Math.round(longest[1] - longest[0]) : null, frozenStartMs: longest ? Math.round(longest[0] - from) : null,
      stallsOver250Ms: Math.round(gaps.filter(([a, b]) => b - a > 250).reduce((n, [a, b]) => n + b - a, 0)),
      cellReachedS: cellAt !== null ? s1(cellAt - from) : null, steadyS: steadyAt ? s1(steadyAt - from) : null, cellAtEnd: P?.cell ?? null,
    },
    frozen: longest && markRec ? loadWindow(recs, proxyOf(from), proxyOf(longest[1])) : null,
    toSteady: steadyAt && markRec ? loadWindow(recs, proxyOf(from), proxyOf(steadyAt)) : null,
    streamfs: { load: delta(res.before, res.afterLoad), toEnd: delta(res.before, res.after) },
    store: { before: res.store0, after: res.store1 }, all: summarize(recs), faults: res.faults, notes,
  };
  fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
  // (kept: the logs, small; the profile copy and the server's copies removed)
  for (const d of ['profile', 'learn', 'telemetry']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  execFileSync('gzip', ['-f', path.join(dir, 'proxy.jsonl')]);
  const w = row.frozen;
  log(`${tag} #${n}: engine in world ${row.engineStart.inWorldS} s; frozen ${row.load.frozenMs} ms, steady ${row.load.steadyS} s, cell ${row.load.cellAtEnd}; demand ${w?.demand.count} reads, ${w?.demand.decodedMB} MB decoded, spacing p50 ${w?.demand.spacing.p50} ms; background ${w?.backgroundMB} MB ${JSON.stringify(w?.backgroundByCategory ?? {})}${notes.length ? ' — ' + notes.join('; ') : ''}`);
  return row;
}

fs.mkdirSync(scratch, { recursive: true });
if (!fs.existsSync(warmDir)) await warmUp();
if (!args.includes('--warm-only')) for (let n = 1; n <= runs; n++) await measured(n);
