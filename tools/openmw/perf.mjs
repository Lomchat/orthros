// In-world frame measurement of an OpenMW port: its engine page straight into an exterior cell as a new character
// (?start=<cell>), then the player walking (W held) and turning for --seconds: the frames the engine drew (a frame: an
// animation frame with draws) — their gaps (p50, p99, max, counts over 100 and 250 ms), the engine's work in each
// animation-frame callback, the synchronous WebGL calls per frame (readPixels, getError, checkFramebufferStatus,
// getShaderParameter/getProgramParameter), the data stalls (the streaming's) and the shader variants built. Prints
// the WebGL renderer and the tier the page chose. --discard: rasterizer discard forced (an init script turns
// RASTERIZER_DISCARD on and ignores its disable) — SwiftShader then runs no rasterization, so the numbers are the
// engine's CPU and the browser's (upper bounds: vertex work still runs). Not a gameplay check.
// Always through tools/with-browser-slot.sh:
//   tools/with-browser-slot.sh node tools/openmw/perf.mjs <manifest> --url <origin> [--seconds 60] [--warm 10]
//     [--start -2,-9] [--query tier=high] [--discard] [--run] [--profile] [--out <dir>] [--mem-every s] [--mark]
//     [--net-after KB/s] [--glcalls] [--console] [--workers] [--gctrace] [--heap [--heap-old] [--heap-interval bytes]]
//     [--snapshot] [--channel chromium|shell]   (--channel: Chromium itself in its new headless mode by default, as the bench suite
//     runs it; shell: Playwright's headless shell, which composites otherwise — 47 fps on the glide where Chromium and
//     the suite measure 31, tools/port-perf.mjs)   (--run: Shift held, running;
//     --profile: a CPU profile of the measured seconds, its longest busy stretches and what they ran, tools/port-perf.mjs;
//     --glide <dx>,<dy>[,<speed>[,<z>]]: instead of walking, the player carried in a straight line from the start
//     cell's centre, <speed> units a second (300: a run) at height <z> (3000) — several cells crossed the same way
//     at every run, whatever stands in the way)
// --glcalls: every WebGL call of the measured seconds counted by name (glCalls: per drawn frame, the 30 commonest) — its
// own wrapping costs time: not with the timings of a comparison.
// The game data's indicator over the measured seconds too (meter: the seconds it was shown, those the engine's reads
// waited; meter-<s>.png at each time it shows, no-meter-<s>.png now and then).
// The engine's work per frame (the page's pump, Module._omw_pump_frame): its quantiles, the frames over 16.7, 33, 50 and
// 100 ms (work.over16 ...) and every frame's work in order (workRaw, ms) for a closer look (tools/openmw/frame-attr.py).
// --console: the engine's log lines (the page's console, from the page's load on) that say error, fail, traceback,
// abort or warn, and the Orthros switch lines (OPENMW_ORTHROS_*, "Orthros: ..."), into the JSON ("log": "[+s] text",
// the first 1000; logCount: all of them).
// --workers (with --profile): the page's workers profiled too — the engine's pthreads (Lua, NIF, physics, work queue),
// the data worker — each its own <out>/perf-worker-<n>.cpuprofile over the same measured seconds (Chromium's own
// debugging socket, a free local port: Target.setAutoAttach on the page, flattened sessions, Profiler at 250 µs in each),
// listed in the JSON ("workers": file, title, busy ms). Each sampling profiler costs its thread a little: compare runs
// with the same flags. tools/openmw/frame-attr.py reads any of them.
// --gctrace: the page's garbage collections over the measured seconds (a trace with v8, disabled-by-default-v8.gc,
// blink_gc and cppgc; only the GC events and the metadata kept) into <out>/gc-trace.json — each event with its reason
// (scavenge, allocation limit, memory reducer...) and its phases.
// --heap: a V8 allocation profile of the page's thread over the measured seconds (HeapProfiler sampling, every
// --heap-interval bytes, 16384 by default, the objects that minor and major collections free kept too: the garbage's
// sources) into <out>/perf.heapprofile (Chromium DevTools' Memory panel or any reader of .heapprofile); --heap-old:
// without those minor collections free (what reaches the old generation). --snapshot: a heap snapshot of the page
// once the measure is over (after the trace and the profiles: its forced full collections are in none of them) into
// <out>/perf.heapsnapshot — over 100 MB for the game: delete it after use. Allocation sampling and the GC trace cost
// the page's thread time and move its collections: compare GC counts and timings only between runs with the same flags.
// --mem-every s: the page's memory every s seconds of the walk (port-perf.mjs memSampler) and its growth per 10 minutes;
// --seconds up to 3600 then (300 otherwise)
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { launchOptions, startProfile, stopProfile, memSampler, meterSampler } from '../port-perf.mjs';

const args = process.argv.slice(2), id = args[0], arg = (k, d = null) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
if (!id) throw new Error('Expected a manifest id');
const base = arg('--url', 'http://localhost:8080'), seconds = Math.max(5, Math.min(arg('--mem-every') ? 3600 : 300, Number(arg('--seconds', 60))));
const warm = Math.max(0, Number(arg('--warm', 10))), start = arg('--start', '-2,-9');
const discard = args.includes('--discard'), profile = args.includes('--profile'), glide = arg('--glide'), glcalls = args.includes('--glcalls');
const consoleLog = args.includes('--console'), workers = profile && args.includes('--workers');
// (--discard with the engine drawing on its own thread, ?omwenv=OPENMW_ORTHROS_DRAWTHREAD=1: the init script below only
// reaches the page's contexts — the draw thread's is the engine's own "discard" value: asked for here, never a run that
// rasterizes on the worker while the page's contexts discard)
const extra = discard ? arg('--query', '').replace(/(OPENMW_ORTHROS_DRAWTHREAD=)1(?=$|[,&])/, '$1discard') : arg('--query', '');
const dir = arg('--out', `/tmp/orthros-scratch/openmw-perf-${id}`);
fs.mkdirSync(dir, { recursive: true }); process.env.TMPDIR = dir;
// (--workers: Chromium's debugging socket on a free local port besides Playwright's pipe)
const cdpPort = workers ? await new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); }) : null;
const browser = await chromium.launch(launchOptions({ gl: 'swiftshader', channel: arg('--channel', 'chromium'), args: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [] }));
const faults = [], logLines = [];
let logCount = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => faults.push(e.message));
  // (--console: the engine's print/printErr reach the page's console, its pthreads' through the page too)
  const logT0 = Date.now(), logWanted = /WebGL|Too many|error|fail|traceback|abort|warn|lost|reload|crash|quit|exit|OPENMW_ORTHROS_|\bOrthros:/i;
  if (consoleLog) page.on('console', (m) => { const t = m.text(); if (!logWanted.test(t)) return; logCount++; const line = `[+${((Date.now() - logT0) / 1000).toFixed(1)}s] ${t.slice(0, 2000)}`; if (logLines.length < 1000) logLines.push(line); if (logCount < 20000) fs.appendFileSync(path.join(dir, 'console.log'), line + '\n'); });
  // (a navigation of the engine page after its load — a reload — said: the measure would mix two sessions)
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) { const line = `[+${((Date.now() - logT0) / 1000).toFixed(1)}s] NAVIGATION ${f.url().slice(0, 200)}`; logLines.push(line); fs.appendFileSync(path.join(dir, 'console.log'), line + '\n'); } });
  page.on('crash', () => console.error('perf: the page crashed'));
  // (a measurement: nothing reported to the server — its learned order, telemetry and the gateway's client log stay clean)
  await page.route((u) => /\/clientlog$|\/api\/(telemetry|prefetch|profile-seed|programs|regions)(\/|$)/.test(u.pathname), (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204, body: '' }));
  await page.addInitScript(({ discard, glcalls }) => {
    // (its own name: the engine page's window.orthrosPerf is the passive session record, frame-meter.js)
    const P = window.__omwPerfProbe = { draws: 0, frames: [], work: [], workEngine: [], suspended: 0, timerWait: 0, sync: {}, syncFrames: [], cur: {} };
    const proto = WebGL2RenderingContext.prototype;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = proto[name]; proto[name] = function (...a) { P.draws++; return f.apply(this, a); };
    }
    for (const name of ['readPixels', 'getError', 'checkFramebufferStatus', 'getShaderParameter', 'getProgramParameter', 'finish', 'clientWaitSync']) {
      const f = proto[name]; proto[name] = function (...a) { P.sync[name] = (P.sync[name] ?? 0) + 1; P.cur[name] = (P.cur[name] ?? 0) + 1; return f.apply(this, a); };
    }
    if (discard) {
      const RD = 0x8C89, enable = proto.enable, disable = proto.disable, getContext = HTMLCanvasElement.prototype.getContext;
      proto.disable = function (cap) { if (cap === RD) return; return disable.call(this, cap); };
      HTMLCanvasElement.prototype.getContext = function (...a) { const gl = getContext.apply(this, a); if (gl && gl instanceof WebGL2RenderingContext) enable.call(gl, RD); return gl; };
    }
    // (the engine's frame timed whole — frame-meter.js orthrosFrameTimer: a frame that suspends while it waits for its
    // files, JSPI, until its end —: the page pumps it, Module._omw_pump_frame, from a message after each animation frame)
    const raf = window.requestAnimationFrame.bind(window);
    // (and the Orthros build's skipped first plays of sounds: streamfs.js orthrosFileReady answering false)
    // (and, r5, the preloads' reads put off: orthrosRangeReady answering false)
    P.notReady = 0; P.rangeNotReady = 0;
    const wrapReady = setInterval(() => {
      const r = window.orthrosFileReady, rr = window.orthrosRangeReady; if (!r || !rr) return;
      window.orthrosFileReady = (name) => { const ok = r(name); if (!ok && P.on) P.notReady++; return ok; };
      window.orthrosRangeReady = (...a) => { const ok = rr(...a); if (!ok && P.on) P.rangeNotReady++; return ok; }; clearInterval(wrapReady);
    }, 50);
    const wrap = setInterval(() => {
      const M = window.Module, f = M?._omw_pump_frame; if (!f || f.orthrosTimed) return;
      // (a page without orthrosFrameTimer 10 s after the engine's frames began — a code tree before r17's frame-meter.js —:
      // the call timed, as it was then)
      if (!window.orthrosFrameTimer && ++P.timerWait < 200) return;
      const done = (ms, suspendedMs) => { if (P.on) { P.work.push(ms); P.workEngine.push(ms - suspendedMs); P.suspended += suspendedMs; } };
      const timed = window.orthrosFrameTimer?.(f, done) ?? function (...a) { const t0 = performance.now(); try { return f.apply(this, a); } finally { done(performance.now() - t0, 0); } };
      timed.orthrosTimed = true; M._omw_pump_frame = timed; clearInterval(wrap);
    }, 50);
    let seen = 0;
    P.raf = []; P.pumps = [];
    const tick = (t) => {
      // (when each animation frame's callbacks ran — the page's rendering opportunities: the draw thread's present delay
      // counted in them below)
      if (P.on && P.raf.length < 200000) P.raf.push(performance.now());
      // (an engine drawing on its own thread, OPENMW_ORTHROS_DRAWTHREAD: no WebGL call on the page — its frames are the
      // bitmaps it hands to the page, counted in __omwDrawThreadFrames)
      const drawn = P.draws + (window.__omwDrawThreadFrames ?? 0);
      if (drawn !== seen) {
        seen = drawn;
        if (P.on) { P.frames.push(t); P.syncFrames.push(P.cur); }
        P.cur = {};
      }
      raf(tick);
    };
    raf(tick);
    // (--glcalls: each WebGL2 method counted while measuring)
    if (glcalls) {
      P.gl = {};
      for (const name of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (name === 'constructor' || typeof d.value !== 'function') continue;
        const f = proto[name]; proto[name] = function (...a) { if (P.on) P.gl[name] = (P.gl[name] ?? 0) + 1; return f.apply(this, a); };
      }
    }
  }, { discard, glcalls });
  const url = `${base}/ports/openmw/${encodeURIComponent(id)}/app/index.html?src=hosted&start=${encodeURIComponent(start)}&perfstats=1${extra ? '&' + extra : ''}`;
  const t0 = Date.now();
  await page.goto(url);
  // (in the world: Orthros' script's first report, view.lua — or the engine running and drawing for a while)
  await page.waitForFunction(() => window.omw?.state?.['orthros.view'] !== undefined || (window.Module?.__omwRunning && window.__omwPerfProbe.draws + (window.__omwDrawThreadFrames ?? 0) > 2000), null, { timeout: 600000, polling: 500 });
  const bootMs = Date.now() - t0;
  // (the engine's counters when the world shows: what the boot's loading screens compiled, OPENMW_ORTHROS_PRECOMPILE,
  // and the draw thread's, OPENMW_ORTHROS_DRAWTHREAD)
  const atBoot = await page.evaluate(() => { const dt = window.__omwDrawThread; return { precompile: window.__omwPrecompile ? { ...window.__omwPrecompile } : null,
    drawThread: dt ? { ...dt, drawMs: undefined, drawFrames: dt.drawMs?.length ?? 0, drawMax: dt.drawMs?.length ? Math.max(...dt.drawMs) : null } : null,
    prepared: window.__omwDrawThreadPrep ?? null, present: window.__omwDrawThreadPresent ? { posted: window.__omwDrawThreadPresent.posted, dropped: window.__omwDrawThreadPresent.dropped, frames: window.__omwDrawThreadPresent.frames } : null }; });
  await page.mouse.click(640, 400);
  await page.waitForTimeout(warm * 1000);
  const before = await page.evaluate(() => ({ stall: window.__streamfsStats?.stallMs ?? null, sync: window.__streamfsStats?.syncFetches ?? 0, misses: window.__omwShaderMisses ?? 0, cell: window.omw?.state?.['orthros.cell'] ?? null, drawn: window.__omwDrawThread?.drawMs?.length ?? 0 }));
  // (the exterior cells walked through: view.lua's report, looked at every half second)
  await page.evaluate(() => { const P = window.__omwPerfProbe; P.cells = new Set(); P.cellLook = setInterval(() => { const c = window.omw?.state?.['orthros.cell']; if (c) P.cells.add(c); }, 500); });
  const wprof = workers ? await workerProfiler(cdpPort, page.url()) : null;
  const cdp = profile ? await startProfile(page) : null;
  const heapCdp = args.includes('--heap') ? await page.context().newCDPSession(page) : null;
  const trCdp = args.includes('--gctrace') ? await page.context().newCDPSession(page) : null, trEvents = [];
  if (trCdp) { trCdp.on('Tracing.dataCollected', (e) => { for (const v of e.value) if (v.ph === 'M' || /GC|gc|Sweep|Mark|Scaveng/.test(v.name)) trEvents.push(v); }); await trCdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'blink_gc', 'cppgc'], excludedCategories: ['*'] }, transferMode: 'ReportEvents' }); }
  if (heapCdp) { await heapCdp.send('HeapProfiler.enable'); await heapCdp.send('HeapProfiler.startSampling', { samplingInterval: Number(arg('--heap-interval', 16384)), includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: !args.includes('--heap-old') }); }
  if (wprof) await wprof.start();
  // (--trace s: a Chrome trace of the measure's first s seconds — the page's and the workers' tasks, animation frames,
  // the compositor's frames — trace.json, for the frame timeline's attribution)
  const traceS = Number(arg('--trace', 0));
  const tcCdp = traceS > 0 ? await page.context().newCDPSession(page) : null;
  let traceDone = null;
  if (tcCdp) {
    const chunks = [];
    tcCdp.on('Tracing.dataCollected', (e) => { for (const v of e.value) chunks.push(v); });
    traceDone = new Promise((ok) => tcCdp.once('Tracing.tracingComplete', () => { fs.writeFileSync(path.join(dir, 'trace.json'), JSON.stringify({ traceEvents: chunks })); ok(); }));
    await tcCdp.send('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'viz', 'gpu', 'benchmark', 'disabled-by-default-devtools.timeline', '__metadata'], excludedCategories: ['*'] }, transferMode: 'ReportEvents' });
    setTimeout(() => { tcCdp.send('Tracing.end').catch(() => {}); }, traceS * 1000);
  }
  await page.evaluate(() => { window.__omwPerfProbe.on = true; window.__omwPerfProbe.t0 = performance.now(); });
  if (args.includes('--mark')) console.log('MEASURE START', Date.now()); // (for a recorder outside: perf record, a thread sampler)
  const memStop = arg('--mem-every') ? await memSampler(page, Number(arg('--mem-every')), '() => Module.HEAPU8.length') : null;
  // (--mem-every: the browser's processes' resident memory too — the GPU process holds the WebGL objects and the
  // bitmaps of an engine drawing on its own thread, which no page heap shows)
  const rssStop = arg('--mem-every') ? rssSampler(Number(arg('--mem-every'))) : null;
  // (--net-after KB/s: Chrome's link at that speed from the measure on, 50 ms round trip — the world streamed over a slow link)
  if (arg('--net-after')) { const c = await page.context().newCDPSession(page); await c.send('Network.enable'); await c.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: Number(arg('--net-after')) * 1024, uploadThroughput: 64 * 1024 }); }
  // (the game data's indicator over the measured seconds: shown only while the game truly waits — data-meter-worker.js)
  const meterStop = await meterSampler(page, { shots: dir });
  const end = Date.now() + seconds * 1000;
  if (glide) {
    // (a straight line at a set speed from the start cell's centre, whatever is in the way: the engine's debug
    // teleport, omw_debug_teleport, every 33 ms — the cells crossed and their loads the same at every run; an Orthros
    // build from r17 on moves the player at its next frame's start, to the last position asked — inside the frame, its
    // crossings' reads suspending it as a walk's —, an older one in the call itself)
    const [dx, dy, speed, z] = glide.split(',').map(Number), [cx, cy] = start.split(',').map(Number), n = Math.hypot(dx, dy) || 1;
    await page.evaluate(({ x0, y0, vx, vy, z }) => {
      const t0 = performance.now();
      window.__omwPerfProbe.glide = setInterval(() => { const t = (performance.now() - t0) / 1000; window.Module._omw_debug_teleport(x0 + vx * t, y0 + vy * t, z); }, 33);
    }, { x0: (cx + 0.5) * 8192, y0: (cy + 0.5) * 8192, vx: dx / n * (speed || 300), vy: dy / n * (speed || 300), z: Number.isFinite(z) ? z : 3000 });
    await page.waitForTimeout(seconds * 1000);
    await page.evaluate(() => clearInterval(window.__omwPerfProbe.glide));
  } else {
    if (args.includes('--run')) await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    while (Date.now() < end) { await page.mouse.move(640 + 60, 400, { steps: 4 }); await page.mouse.move(640, 400, { steps: 4 }); await page.waitForTimeout(400); }
    await page.keyboard.up('w');
    if (args.includes('--run')) await page.keyboard.up('Shift');
  }
  const meter = await meterStop();
  const mem = memStop ? await memStop() : null;
  const rss = rssStop ? rssStop() : null;
  const r = await page.evaluate(({ before }) => {
    const P = window.__omwPerfProbe; P.on = false; clearInterval(P.cellLook);
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : null; };
    const gaps = P.frames.slice(1).map((t, i) => t - P.frames[i]), secs = (P.frames.at(-1) - P.frames[0]) / 1000;
    let renderer = null; try { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); renderer = gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER); } catch { /* none */ }
    const perFrame = {}; for (const f of P.syncFrames) for (const [k, v] of Object.entries(f)) perFrame[k] = (perFrame[k] ?? 0) + v;
    for (const k of Object.keys(perFrame)) perFrame[k] = +(perFrame[k] / Math.max(1, P.syncFrames.length)).toFixed(3);
    const log = document.querySelector('#log')?.textContent ?? '';
    // (the engine's canvas: its drawing buffer's size, the page's pixel ratio and the context's attributes — a
    // multisampled or preserved drawing buffer costs on every GPU)
    const cv = document.querySelector('canvas'), cx = cv?.getContext('webgl2'), ca = cx?.getContextAttributes();
    const canvas = cv ? { buffer: `${cx?.drawingBufferWidth ?? cv.width}x${cx?.drawingBufferHeight ?? cv.height}`, css: `${cv.clientWidth}x${cv.clientHeight}`, dpr: devicePixelRatio, antialias: ca?.antialias ?? null, samples: cx?.getParameter(cx.SAMPLES) ?? null, preserveDrawingBuffer: ca?.preserveDrawingBuffer ?? null } : null;
    return {
      renderer, canvas, tier: window.__omwTier ?? null, tierChoice: window.orthrosTierChoice ?? null, tierLog: /\[tier\][^\n]*/.exec(log)?.[0] ?? null,
      frames: P.frames.length, fps: +(P.frames.length / Math.max(0.001, secs)).toFixed(2),
      gap: { p50: q(gaps, 0.5), p90: q(gaps, 0.9), p99: q(gaps, 0.99), max: q(gaps, 1), over100: gaps.filter((g) => g > 100).length, over250: gaps.filter((g) => g > 250).length },
      work: { p50: q(P.work, 0.5), p90: q(P.work, 0.9), p99: q(P.work, 0.99), max: q(P.work, 1), over16: P.work.filter((w) => w > 1000 / 60).length, over33: P.work.filter((w) => w > 100 / 3).length, over50: P.work.filter((w) => w > 50).length, over100: P.work.filter((w) => w > 100).length },
      workRaw: P.work.map((w) => +w.toFixed(2)),
      // (the frames' time without their suspensions — the engine running —, and the suspensions' sum: JSPI builds only)
      workEngine: { p50: q(P.workEngine, 0.5), p90: q(P.workEngine, 0.9), p99: q(P.workEngine, 0.99), max: q(P.workEngine, 1) }, suspendedMs: Math.round(P.suspended),
      jspi: window.StreamFS?.jspi?.() ?? null,
      syncPerFrame: perFrame, syncTotal: P.sync,
      glCalls: P.gl ? (() => { const n = Math.max(1, P.frames.length), all = Object.entries(P.gl).sort((x, y) => y[1] - x[1]);
        return { perFrame: +(all.reduce((t, [, v]) => t + v, 0) / n).toFixed(0), top: Object.fromEntries(all.slice(0, 30).map(([k, v]) => [k, +(v / n).toFixed(1)])) }; })() : undefined,
      dataStallMs: window.__streamfsStats ? +(window.__streamfsStats.stallMs - (before.stall ?? 0)).toFixed(0) : null,
      shaderVariantsBuilt: (window.__omwShaderMisses ?? 0) - before.misses, soundsNotReady: P.notReady, readsPutOff: P.rangeNotReady,
      syncFetches: window.__streamfsStats ? (window.__streamfsStats.syncFetches ?? 0) - before.sync : null, cells: [...(P.cells ?? [])],
      phase: window.__omwPhase ?? null,
      // (the view's growth at the end — view-grow.js —, its last step's time from the measure's start)
      view: window.orthrosViewState ? (({ p99s, ...v }) => ({ ...v, sinceRelMs: Math.round(v.since - P.frames[0]) }))(window.orthrosViewState()) : null,
    };
  }, { before });
  if (trCdp) { const done = new Promise((ok) => trCdp.once('Tracing.tracingComplete', ok)); await trCdp.send('Tracing.end'); await done; fs.writeFileSync(path.join(dir, 'gc-trace.json'), JSON.stringify(trEvents)); }
  if (heapCdp) { const { profile: hp } = await heapCdp.send('HeapProfiler.stopSampling'); fs.writeFileSync(path.join(dir, 'perf.heapprofile'), JSON.stringify(hp)); }
  const prof = cdp ? await stopProfile(cdp, r.frames, path.join(dir, 'perf.cpuprofile')) : undefined;
  const workerProfiles = wprof ? await wprof.stop(dir) : undefined;
  // (the heap snapshot last: its forced full collections and its stall outside the trace and the profiles above)
  if (args.includes('--snapshot')) { const sc = await page.context().newCDPSession(page); const fd = fs.openSync(path.join(dir, 'perf.heapsnapshot'), 'w'); sc.on('HeapProfiler.addHeapSnapshotChunk', (e) => fs.writeSync(fd, e.chunk)); await sc.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); fs.closeSync(fd); }
  const out = { manifest: id, discard, seconds, warm, start, glide, query: extra, bootMs, atBoot, ...r, meter, ...(mem ? { memGrowthPer10min: mem.growthPer10min, memFirst: mem.samples[0], memLast: mem.samples.at(-1), memSamples: mem.samples } : {}), ...(rss ? { rss } : {}), faults, profile: prof,
    ...(workerProfiles ? { workers: workerProfiles } : {}), ...(consoleLog ? { logCount, log: logLines } : {}) };
  if (traceDone) await traceDone;
  // (the frame timeline of the measure, timeline.json: the animation frames, the engine's pumps [start, end], the frames
  // counted, and with the draw thread its timeline — tools/openmw ../frame-timeline analysis)
  const tl = await page.evaluate(() => { const P = window.__omwPerfProbe, dt = window.__omwDrawThread, pr = window.__omwDrawThreadPresent;
    return { t0: P.t0, raf: P.raf, pumps: P.pumps, frames: P.frames, tlPage: dt?.tlPage ?? null, tlDraw: dt?.tlDraw ?? null, lat: pr?.lat ?? null, mode: pr?.mode ?? null, prep: window.__omwDrawThreadPrep ?? null }; });
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl));
  fs.writeFileSync(path.join(dir, 'perf.json'), JSON.stringify(out, null, 2));
  await page.screenshot({ path: path.join(dir, 'perf.png') });
  // (the printed line without the raw arrays: they stay in perf.json)
  const { workRaw: _, log: __, framesRaw: ___, ...line } = out;
  console.log(JSON.stringify(line));
} finally { await browser.close(); }

/**
 * --mem-every: the resident memory (MB) of the browser's processes every `everyS` seconds, by kind (gpu, renderer,
 * other: Chromium's --type), from /proc; at the end the samples and each kind's growth per 10 minutes after 120 s.
 */
function rssSampler(everyS) {
  // (the browser's own process: the one whose profile is in this run's directory — TMPDIR, set above)
  const root = (() => { for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue;
    try { const c = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); if (c.includes(`--user-data-dir=${dir}`) && !c.includes('--type=')) return Number(d); } catch { /* gone */ } } return null; })();
  const t0 = Date.now(), samples = [];
  const kids = (pid) => { try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
  const one = () => {
    if (!root) return;
    const s = { t: Math.round((Date.now() - t0) / 1000), gpu: 0, renderer: 0, other: 0 };
    const todo = [root];
    while (todo.length) {
      const pid = todo.pop(); todo.push(...kids(pid));
      try {
        const kb = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
        const type = /--type=([\w-]+)/.exec(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '))?.[1];
        s[type === 'gpu-process' ? 'gpu' : type === 'renderer' ? 'renderer' : 'other'] += kb / 1024;
      } catch { /* gone */ }
    }
    for (const k of ['gpu', 'renderer', 'other']) s[k] = +s[k].toFixed(0);
    samples.push(s);
  };
  one();
  const timer = setInterval(one, everyS * 1000);
  return () => {
    clearInterval(timer); one();
    const later = samples.filter((s) => s.t >= 120), slope = (k) => {
      const n = later.length; if (n < 2) return null;
      const mx = later.reduce((a, s) => a + s.t, 0) / n, my = later.reduce((a, s) => a + s[k], 0) / n;
      return +(later.reduce((a, s) => a + (s.t - mx) * (s[k] - my), 0) / Math.max(1e-9, later.reduce((a, s) => a + (s.t - mx) ** 2, 0)) * 600).toFixed(1);
    };
    return { samples, growthPer10min: { gpu: slope('gpu'), renderer: slope('renderer'), other: slope('other') } };
  };
}

/**
 * --workers: every worker of the page (and theirs) profiled over Chromium's debugging socket on `port` — the page's
 * target (its URL `pageUrl`) attached in flattened mode, its workers auto-attached (those already running reported at
 * once, later ones as they start). start(): Profiler at 250 µs in each, and in each worker attached afterwards;
 * stop(dir): each profile written to dir/perf-worker-<n>.cpuprofile, their list returned (file, title, url, busy ms).
 */
async function workerProfiler(port, pageUrl) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error('perf: the debugging socket did not open')); });
  let next = 1, started = false;
  const waits = new Map(), sessions = new Map();
  const send = (method, params = {}, sessionId) => new Promise((ok, ko) => {
    const msgId = next++; waits.set(msgId, { ok, ko });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const begin = async (sid) => {
    const s = sessions.get(sid); if (s.running) return; s.running = true;
    try { await send('Profiler.enable', {}, sid); await send('Profiler.setSamplingInterval', { interval: 250 }, sid); await send('Profiler.start', {}, sid); } catch (e) { s.error = e.message; }
  };
  const autoAttach = (sid) => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => {});
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { const w = waits.get(m.id); waits.delete(m.id); if (w) m.error ? w.ko(new Error(`${m.error.message}`)) : w.ok(m.result); return; }
    if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = m.params;
      if (!/worker/.test(targetInfo.type)) return;
      sessions.set(sessionId, { title: targetInfo.title, url: targetInfo.url, type: targetInfo.type });
      autoAttach(sessionId);
      if (started) begin(sessionId);
    } else if (m.method === 'Target.detachedFromTarget' && sessions.has(m.params.sessionId)) sessions.get(m.params.sessionId).gone = true;
  };
  const { targetInfos } = await send('Target.getTargets');
  const target = targetInfos.find((t) => t.type === 'page' && t.url === pageUrl) ?? targetInfos.find((t) => t.type === 'page' && t.url.split('?')[0] === pageUrl.split('?')[0]);
  if (!target) throw new Error(`perf: the page's target was not found (${pageUrl})`);
  const { sessionId: pageSession } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await autoAttach(pageSession);
  await new Promise((ok) => setTimeout(ok, 300)); // (the workers already running: their attachedToTarget events)
  return {
    async start() { started = true; await Promise.all([...sessions.keys()].map(begin)); },
    async stop(dir) {
      const out = []; let n = 0;
      for (const [sid, s] of sessions) {
        if (!s.running || s.gone || s.error) { if (s.error) out.push({ title: s.title, url: s.url, error: s.error }); continue; }
        let pr; try { ({ profile: pr } = await send('Profiler.stop', {}, sid)); } catch (e) { out.push({ title: s.title, url: s.url, error: e.message }); continue; }
        const byId = new Map(pr.nodes.map((x) => [x.id, x])); let busy = 0;
        pr.samples.forEach((nodeId, i) => { if (byId.get(nodeId).callFrame.functionName !== '(idle)') busy += pr.timeDeltas[i] ?? 0; });
        const file = `perf-worker-${n++}.cpuprofile`;
        fs.writeFileSync(path.join(dir, file), JSON.stringify(pr));
        out.push({ file, title: s.title, url: s.url.slice(0, 200), busyMs: Math.round(busy / 1000), samples: pr.samples.length });
      }
      ws.close();
      return out.sort((a, b) => (b.busyMs ?? -1) - (a.busyMs ?? -1));
    },
  };
}
