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
//     [--net-after KB/s] [--glcalls] [--console] [--workers] [--channel chromium|shell]   (--channel: Chromium itself in its new headless mode by default, as the bench suite
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
const warm = Math.max(0, Number(arg('--warm', 10))), start = arg('--start', '-2,-9'), extra = arg('--query', '');
const discard = args.includes('--discard'), profile = args.includes('--profile'), glide = arg('--glide'), glcalls = args.includes('--glcalls');
const consoleLog = args.includes('--console'), workers = profile && args.includes('--workers');
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
  const logT0 = Date.now(), logWanted = /error|fail|traceback|abort|warn|OPENMW_ORTHROS_|\bOrthros:/i;
  if (consoleLog) page.on('console', (m) => { const t = m.text(); if (!logWanted.test(t)) return; logCount++; if (logLines.length < 1000) logLines.push(`[+${((Date.now() - logT0) / 1000).toFixed(1)}s] ${t.slice(0, 2000)}`); });
  page.on('crash', () => console.error('perf: the page crashed'));
  // (a measurement: nothing reported to the server — its learned order, telemetry and the gateway's client log stay clean)
  await page.route((u) => /\/clientlog$|\/api\/(telemetry|prefetch|profile-seed|programs|regions)(\/|$)/.test(u.pathname), (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204, body: '' }));
  await page.addInitScript(({ discard, glcalls }) => {
    // (its own name: the engine page's window.orthrosPerf is the passive session record, frame-meter.js)
    const P = window.__omwPerfProbe = { draws: 0, frames: [], work: [], sync: {}, syncFrames: [], cur: {} };
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
    // (the engine's frame timed: the page pumps it, Module._omw_pump_frame, from a message after each animation frame)
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
      const timed = function (...a) { const t0 = performance.now(); try { return f.apply(this, a); } finally { if (P.on) P.work.push(performance.now() - t0); } };
      timed.orthrosTimed = true; M._omw_pump_frame = timed; clearInterval(wrap);
    }, 50);
    let seen = 0;
    const tick = (t) => {
      if (P.draws !== seen) {
        seen = P.draws;
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
  await page.waitForFunction(() => window.omw?.state?.['orthros.view'] !== undefined || (window.Module?.__omwRunning && window.__omwPerfProbe.draws > 2000), null, { timeout: 600000, polling: 500 });
  const bootMs = Date.now() - t0;
  await page.mouse.click(640, 400);
  await page.waitForTimeout(warm * 1000);
  const before = await page.evaluate(() => ({ stall: window.__streamfsStats?.stallMs ?? null, sync: window.__streamfsStats?.syncFetches ?? 0, misses: window.__omwShaderMisses ?? 0, cell: window.omw?.state?.['orthros.cell'] ?? null }));
  // (the exterior cells walked through: view.lua's report, looked at every half second)
  await page.evaluate(() => { const P = window.__omwPerfProbe; P.cells = new Set(); P.cellLook = setInterval(() => { const c = window.omw?.state?.['orthros.cell']; if (c) P.cells.add(c); }, 500); });
  const wprof = workers ? await workerProfiler(cdpPort, page.url()) : null;
  const cdp = profile ? await startProfile(page) : null;
  if (wprof) await wprof.start();
  await page.evaluate(() => { window.__omwPerfProbe.on = true; });
  if (args.includes('--mark')) console.log('MEASURE START', Date.now()); // (for a recorder outside: perf record, a thread sampler)
  const memStop = arg('--mem-every') ? await memSampler(page, Number(arg('--mem-every')), '() => Module.HEAPU8.length') : null;
  // (--net-after KB/s: Chrome's link at that speed from the measure on, 50 ms round trip — the world streamed over a slow link)
  if (arg('--net-after')) { const c = await page.context().newCDPSession(page); await c.send('Network.enable'); await c.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: Number(arg('--net-after')) * 1024, uploadThroughput: 64 * 1024 }); }
  // (the game data's indicator over the measured seconds: shown only while the game truly waits — data-meter-worker.js)
  const meterStop = await meterSampler(page, { shots: dir });
  const end = Date.now() + seconds * 1000;
  if (glide) {
    // (a straight line at a set speed from the start cell's centre, whatever is in the way: the engine's debug
    // teleport, omw_debug_teleport, every 33 ms — the cells crossed and their loads the same at every run)
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
      syncPerFrame: perFrame, syncTotal: P.sync,
      glCalls: P.gl ? (() => { const n = Math.max(1, P.frames.length), all = Object.entries(P.gl).sort((x, y) => y[1] - x[1]);
        return { perFrame: +(all.reduce((t, [, v]) => t + v, 0) / n).toFixed(0), top: Object.fromEntries(all.slice(0, 30).map(([k, v]) => [k, +(v / n).toFixed(1)])) }; })() : undefined,
      dataStallMs: window.__streamfsStats ? +(window.__streamfsStats.stallMs - (before.stall ?? 0)).toFixed(0) : null,
      shaderVariantsBuilt: (window.__omwShaderMisses ?? 0) - before.misses, soundsNotReady: P.notReady, readsPutOff: P.rangeNotReady,
      syncFetches: window.__streamfsStats ? (window.__streamfsStats.syncFetches ?? 0) - before.sync : null, cells: [...P.cells],
      phase: window.__omwPhase ?? null,
    };
  }, { before });
  const prof = cdp ? await stopProfile(cdp, r.frames, path.join(dir, 'perf.cpuprofile')) : undefined;
  const workerProfiles = wprof ? await wprof.stop(dir) : undefined;
  const out = { manifest: id, discard, seconds, warm, start, glide, query: extra, bootMs, ...r, meter, ...(mem ? { memGrowthPer10min: mem.growthPer10min, memFirst: mem.samples[0], memLast: mem.samples.at(-1), memSamples: mem.samples } : {}), faults, profile: prof,
    ...(workerProfiles ? { workers: workerProfiles } : {}), ...(consoleLog ? { logCount, log: logLines } : {}) };
  fs.writeFileSync(path.join(dir, 'perf.json'), JSON.stringify(out, null, 2));
  await page.screenshot({ path: path.join(dir, 'perf.png') });
  // (the printed line without the raw arrays: they stay in perf.json)
  const { workRaw: _, log: __, ...line } = out;
  console.log(JSON.stringify(line));
} finally { await browser.close(); }

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
