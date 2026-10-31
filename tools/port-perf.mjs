// The browser ports' frame measurement, one for every port tool (tools/re3/perf.mjs, tools/goldsrc/perf.mjs, the
// ports' checks): the browser's launch flags for a rendering mode, a probe installed before the page's scripts (the
// engine's work a frame, the frames shown, the WebGL calls a frame by kind, the synchronous ones apart, the WebGL
// renderer), its reading, and a CPU profile's summary (self time, the longest busy stretches).
//
// Rendering modes (--gl): headless Chromium here always renders WebGL with SwiftShader (ANGLE's null backend,
// --use-angle=null, is ignored: the renderer string stays SwiftShader's with every flag combination — checked
// 2026-10-21), so a frame's time includes the CPU drawing its pixels.
// - `swiftshader`: drawn, the GPU's share on the CPU (slow: mostly SwiftShader's own time).
// - `discard`: the same, with RASTERIZER_DISCARD kept on (turned on at the context's creation, the engine's disable
//   ignored): every WebGL call is still validated and sent, the vertex work still done, no pixel drawn — the closest
//   this machine gets to the engine's own CPU cost a frame (an upper bound: SwiftShader's vertex threads still compete).
//   Nothing is visible on the screenshots; readPixels reads nothing meaningful.
// - `gpu`: no rendering flag — the machine's own GPU when it has one (the renderer printed tells).
// The synchronous calls (`sync`): those that wait for the GPU process' answer (getError, checkFramebufferStatus,
// readPixels, shader/program queries, …) — on a real GPU each one stops the CPU and the GPU working in parallel.

import { mkdirSync } from 'node:fs';
import { v8LogArgs } from './v8-logs.mjs';

export const GL_MODES = ['swiftshader', 'discard', 'gpu'];

/** Chromium's launch flags for a rendering mode (GL_MODES). */
export function chromeArgs(gl = 'swiftshader') {
  if (gl === 'null') throw new Error("--gl null: ANGLE's null backend is ignored by this Chromium (it still renders with SwiftShader); use --gl discard for the CPU cost without drawing");
  if (!GL_MODES.includes(gl)) throw new Error(`--gl ${gl}: one of ${GL_MODES.join(', ')}`);
  return ['--no-sandbox', ...(gl === 'gpu' ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--autoplay-policy=no-user-gesture-required'];
}

// Browsers (--channel): `chromium` (the default) is Chromium itself in its new headless mode, as the bench suite
// (tools/bench-suite-check.mjs) and the re3 check run it: its page composited through the GPU process as a browser
// does. `shell` is Playwright's lighter headless shell: it composites otherwise (OpenMW's glide 47 fps there, 31 in
// Chromium, 2026-10-23), and once a page holds the pointer lock it sends that page ~40,000 synthetic mouse moves a
// second (zero movement; its browser and renderer compositor threads each a whole core; Chromium sends none) — a
// headless shell artifact, no browser does that.
export const CHANNELS = ['chromium', 'shell'];
/**
 * Playwright's launch options for a port measurement: the rendering mode's flags (chromeArgs), the channel (CHANNELS),
 * `args` besides (a --js-flags' V8 logs under the scratch, tools/v8-logs.mjs). Chromium's profile socket must stay
 * under 108 bytes: its temporary directory (TMPDIR) is moved to a short one under the scratch when the caller's is long.
 */
export function launchOptions({ gl = 'swiftshader', channel = 'chromium', args = [] } = {}) {
  if (!CHANNELS.includes(channel)) throw new Error(`--channel ${channel}: one of ${CHANNELS.join(', ')}`);
  if (channel === 'chromium' && (process.env.TMPDIR ?? '/tmp').length > 48) {
    process.env.TMPDIR = '/tmp/orthros-scratch/pw';
    mkdirSync(process.env.TMPDIR, { recursive: true });
  }
  // (ORTHROS_CHROME_ARGS: more flags, space-separated — a diagnosis', e.g. '--enable-logging=stderr --v=0' for a renderer
  // crash's reason in the browser's log, DEBUG=pw:browser printing it)
  const extra = (process.env.ORTHROS_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  return { headless: true, ...(channel === 'shell' ? {} : { channel }), args: v8LogArgs([...chromeArgs(gl), ...args, ...extra]) };
}

/** The WebGL methods that wait for the GPU process' answer. */
export const SYNC_CALLS = ['getError', 'checkFramebufferStatus', 'readPixels', 'finish', 'clientWaitSync', 'getSyncParameter', 'getQueryParameter',
  'getBufferSubData', 'getShaderParameter', 'getProgramParameter', 'getShaderInfoLog', 'getProgramInfoLog', 'getUniformLocation', 'getAttribLocation',
  'getActiveUniform', 'getActiveAttrib', 'getUniformBlockIndex', 'getFragDataLocation', 'getUniform', 'getVertexAttrib', 'getTexParameter',
  'getFramebufferAttachmentParameter', 'getRenderbufferParameter', 'getInternalformatParameter'];

/**
 * The probe, in the page before its scripts (a Playwright page or context): `window.perfProbe`. `discard`: the
 * rasterizer discarded (the `discard` mode); `stacks`: WebGL methods whose callers are kept (their JS/wasm stacks,
 * counted, in the measured seconds).
 */
export async function addProbe(target, { discard = false, stacks = [] } = {}) {
  await target.addInitScript(({ discard, stacks, sync }) => {
    const P = window.perfProbe = { calls: new Map(), counting: false, draws: 0, frames: 0, work: [], resumedAt: 0, shown: [], drawsAt: 0, renderer: null, discard, stacks: new Map(), sync };
    const RASTERIZER_DISCARD = 0x8C89, traced = new Set(stacks);
    for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!type) continue;
      const proto = type.prototype;
      for (const k of Object.getOwnPropertyNames(proto)) {
        const d = Object.getOwnPropertyDescriptor(proto, k); if (typeof d.value !== 'function' || k === 'constructor') continue;
        const o = d.value, draw = ['drawArrays', 'drawElements', 'drawRangeElements', 'drawArraysInstanced', 'drawElementsInstanced'].includes(k);
        const keep = traced.has(k), skipDisable = discard && k === 'disable';
        proto[k] = function (...a) {
          if (draw) P.draws++;
          if (P.counting) {
            P.calls.set(k, (P.calls.get(k) ?? 0) + 1);
            if (keep) { const s = (new Error().stack ?? '').split('\n').slice(2, 9).map((l) => l.trim()).join(' < '); P.stacks.set(`${k}: ${s}`, (P.stacks.get(`${k}: ${s}`) ?? 0) + 1); }
          }
          if (skipDisable && a[0] === RASTERIZER_DISCARD) return undefined;
          return o.apply(this, a);
        };
      }
    }
    // (the context's creation: its renderer, and the rasterizer discarded from its start)
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      const gl = getContext.call(this, kind, ...rest);
      if (gl && /webgl/.test(kind) && !gl.__perfSeen) {
        gl.__perfSeen = true;
        try { const info = gl.getExtension('WEBGL_debug_renderer_info'); P.renderer ??= gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER); } catch { /* lost */ }
        if (discard && window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext) gl.enable(RASTERIZER_DISCARD);
      }
      return gl;
    };
    // (a frame: one browser frame, whatever number of callbacks the page has in it — the engine's, the frame meter's;
    // the work a frame: from its first callback to the last request for the next one made in it — the engine asks for
    // it at the end of its iteration, with an asynchronous main loop as well; the frames shown: a browser frame after
    // one the engine drew in)
    const raf = window.requestAnimationFrame.bind(window);
    const tick = (t) => {
      if (t === P.tickT) return;
      if (P.lastAsk) { P.work.push(P.lastAsk - P.tickAt); if (P.work.length > 20000) P.work.shift(); }
      P.tickT = t; P.tickAt = performance.now(); P.lastAsk = 0; P.frames++;
      if (P.draws !== P.drawsAt) { P.drawsAt = P.draws; P.shown.push(t); if (P.shown.length > 20000) P.shown.shift(); }
    };
    window.requestAnimationFrame = (cb) => {
      if (P.tickAt) P.lastAsk = performance.now();
      return raf((t) => { tick(t); cb(t); });
    };
  }, { discard, stacks, sync: SYNC_CALLS });
}

/** The WebGL renderer of the page's canvas (its context as the engine made it; null before), for the checks' logs. */
export const rendererOf = (page, selector = '#canvas') => page.evaluate((selector) => {
  const c = document.querySelector(selector), gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
  if (!gl) return null;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
}, selector);

/**
 * The page's reports kept off the server (a measuring session is not a player's): its posts to the telemetry and to
 * what the server learns from sessions (prefetch order, first-launch profile, heat, programs, regions) answered here.
 */
export const quietReports = (page) => page.route(/\/api\/(telemetry|prefetch|profile-seed|heat|programs|regions)\b/, (route) =>
  (route.request().method() === 'GET' ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })));

/** The measured seconds start (the counters reset; `calls`: the WebGL calls counted by kind). */
export const startMeasure = (page, { calls = true } = {}) => page.evaluate((calls) => {
  const P = perfProbe; P.work = []; P.shown = []; P.calls.clear(); P.stacks.clear(); P.counting = calls; P.f0 = P.frames; P.d0 = P.draws; P.t0 = performance.now();
}, calls);

/** The measured seconds' summary: frames, the engine's work a frame, gaps between shown frames, WebGL calls a frame. */
export const readMeasure = (page) => page.evaluate(() => {
  const P = perfProbe, frames = Math.max(1, P.frames - P.f0), ms = performance.now() - P.t0, w = P.work.slice().sort((a, b) => a - b);
  const q = (a, f) => Math.round((a[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0) * 100) / 100;
  const calls = [...P.calls].sort((a, b) => b[1] - a[1]), total = calls.reduce((n, [, c]) => n + c, 0), per = (c) => Math.round(c / frames * 10) / 10;
  const gaps = P.shown.slice(1).map((t, i) => t - P.shown[i]), hist = {}, sortedGaps = gaps.slice().sort((a, b) => a - b);
  for (const g of gaps) { const b = g < 25 ? '<25' : g < 42 ? '25-42' : g < 58 ? '42-58' : '58+'; hist[b] = (hist[b] ?? 0) + 1; }
  const sync = calls.filter(([k]) => P.sync.includes(k));
  return {
    renderer: P.renderer, discard: P.discard, fps: Math.round(frames / ms * 1000 * 10) / 10, shownFps: Math.round(gaps.length / ms * 1000 * 10) / 10, frames,
    work: { p50: q(w, 0.5), p90: q(w, 0.9), p99: q(w, 0.99), max: q(w, 1) },
    gaps: { p50: q(sortedGaps, 0.5), p99: q(sortedGaps, 0.99), max: Math.round(Math.max(0, ...gaps)), over50: gaps.filter((g) => g > 50).length, over250: gaps.filter((g) => g > 250).length },
    intervals: hist, draws: Math.round((P.draws - P.d0) / frames),
    glCalls: per(total), top: Object.fromEntries(calls.slice(0, 14).map(([k, c]) => [k, per(c)])),
    syncCalls: per(sync.reduce((n, [, c]) => n + c, 0)), sync: Object.fromEntries(sync.map(([k, c]) => [k, per(c)])),
    stacks: [...P.stacks].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => ({ n, s })),
    heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)
  };
});

/** A CPU profile of the measured seconds starts (CDP's sampling profiler, 250 µs). */
export async function startProfile(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start');
  return cdp;
}

/**
 * A browser trace (CDP Tracing, every process: the page's thread, the compositor, the GPU process) started on `page`'s
 * session — what the page's rendering, the GPU's queue and input do around a load (a diagnosis: place-load.mjs
 * ORTHROS_PLACE_TRACE=1). Ended by stopTrace.
 */
export async function startTrace(page, categories = TRACE_CATEGORIES) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', streamCompression: 'gzip', traceConfig: { recordMode: 'recordContinuously', includedCategories: categories } });
  return cdp;
}
/** The categories of startTrace: tasks and frames of every process, the GPU's scheduling, input's path. */
export const TRACE_CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'viz', 'gpu', 'gpu.service',
  'disabled-by-default-gpu.service', 'input', 'latencyInfo', 'benchmark', 'v8.execute', 'scheduler', 'renderer.scheduler'];
/** The trace of startTrace ended and written, gzipped (Chrome's JSON trace: chrome://tracing, Perfetto), to `file`. */
export async function stopTrace(cdp, file) {
  const fs = await import('node:fs');
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  const out = fs.openSync(file, 'w');
  try {
    for (;;) {
      const r = await cdp.send('IO.read', { handle: stream, size: 1 << 20 });
      if (r.data) fs.writeSync(out, r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data, 'binary'));
      if (r.eof) break;
    }
  } finally { fs.closeSync(out); await cdp.send('IO.close', { handle: stream }).catch(() => {}); }
  return file;
}

/**
 * The profile's summary: self time by function (the WebAssembly's share apart), and the longest stretches without an
 * idle sample — the hitches: their length and the functions they spent it in (a function counted once a sample
 * wherever it is on the stack). `frames`: the measured frames (the WebAssembly's milliseconds a frame); `save`: a file
 * the raw profile is written to (a .cpuprofile, for a closer look). busy: the page's thread busy — every task, not
 * only the engine's frame (work done between frames counts too) — in ms a frame, and its stretches without an idle
 * sample over 16.7, 33 and 50 ms (busy.over16 ...).
 */
export async function stopProfile(cdp, frames, save = null) {
  const { profile: pr } = await cdp.send('Profiler.stop');
  if (save) (await import('node:fs')).writeFileSync(save, JSON.stringify(pr));
  const byId = new Map(pr.nodes.map((n) => [n.id, n])), self = new Map();
  let total = 0;
  pr.samples.forEach((id, i) => { const n = byId.get(id), us = pr.timeDeltas[i] ?? 0, k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}`.trim(); self.set(k, (self.get(k) ?? 0) + us); total += us; });
  const wasm = [...self].filter(([k]) => k.endsWith('.wasm')).reduce((n, [, us]) => n + us, 0);
  const runs = []; let run = null;
  pr.samples.forEach((id, i) => {
    const n = byId.get(id), us = pr.timeDeltas[i] ?? 0;
    if (n.callFrame.functionName === '(idle)') { if (run) runs.push(run); run = null; return; }
    run ??= { us: 0, ids: [] }; run.us += us; run.ids.push([id, us]);
  });
  if (run) runs.push(run);
  const busyUs = runs.reduce((n, r) => n + r.us, 0), over = (ms) => runs.filter((r) => r.us > ms * 1000).length;
  const busy = { msPerFrame: Math.round(busyUs / 1000 / Math.max(1, frames) * 100) / 100, over16: over(1000 / 60), over33: over(100 / 3), over50: over(50) };
  const parent = new Map(); for (const n of pr.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const hitches = runs.sort((a, b) => b.us - a.us).slice(0, 4).map((r) => {
    const incl = new Map();
    for (const [id, us] of r.ids) {
      const seen = new Set();
      for (let at = id; at != null; at = parent.get(at)) { const f = byId.get(at).callFrame.functionName || '(anon)'; if (!seen.has(f)) { seen.add(f); incl.set(f, (incl.get(f) ?? 0) + us); } }
    }
    return { ms: Math.round(r.us / 1000), top: Object.fromEntries([...incl].filter(([f]) => f !== '(root)').sort((a, b) => b[1] - a[1]).slice(0, 18).map(([f, us]) => [f, Math.round(us / 1000)])) };
  });
  return { wasmMsPerFrame: Math.round(wasm / 1000 / Math.max(1, frames) * 100) / 100, wasmShare: `${(100 * wasm / total).toFixed(1)}%`, busy,
    top: Object.fromEntries([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => [k, `${(100 * us / total).toFixed(1)}%`])), hitches };
}

/**
 * The game data's indicator (src/host/web/data-meter-worker.js, its worker in `page`) sampled every `everyMs` until
 * stop(): stop() returns { samples, shownS, waitingS, shownAt } — the seconds it was shown, those the engine's reads
 * waited for the network (the shared counter it reads, ctrl[6]), and when it was shown ([from, to] s from the start). Read
 * in its worker: sampled while the page's thread is held too. `shots`: a directory — a screenshot at the start of each
 * time it is shown (meter-<s>.png, the first 5), and one where it is not (no-meter-<s>.png, every 20 s).
 */
export async function meterSampler(page, { everyMs = 250, shots = null } = {}) {
  const seen = [], t0 = Date.now();
  let on = true, taken = 0, plainAt = -Infinity;
  const shot = (name) => page.screenshot({ path: `${shots}/${name}-${Math.round((Date.now() - t0) / 1000)}.png` }).catch(() => {});
  const loop = (async () => {
    while (on) {
      const w = page.workers().find((x) => x.url().includes('data-meter-worker'));
      // (the worker's own top-level state: `shown` drawn, `arrived` the game data's counters)
      const s = w ? await w.evaluate(() => ({ shown, waiting: arrived ? Atomics.load(arrived, 6) : 0 })).catch(() => null) : null;
      if (s) {
        const was = seen.at(-1)?.shown, t = (Date.now() - t0) / 1000;
        seen.push({ t, ...s });
        if (shots && s.shown && !was && taken < 5) { taken++; await shot('meter'); }
        if (shots && !s.shown && t - plainAt >= 20) { plainAt = t; await shot('no-meter'); }
      }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  })();
  return async () => {
    on = false; await loop;
    const secs = (k) => +(seen.filter(k).length * everyMs / 1000).toFixed(1), shownAt = [];
    for (const s of seen) { const last = shownAt.at(-1); if (!s.shown) continue; if (last && s.t - last[1] < 2 * everyMs / 1000) last[1] = +s.t.toFixed(1); else shownAt.push([+s.t.toFixed(1), +s.t.toFixed(1)]); }
    return { samples: seen.length, shownS: secs((s) => s.shown), waitingS: secs((s) => s.waiting > 0), shownAt };
  };
}

/**
 * A long session's memory, sampled every `everyS` seconds until stop(): the JS heap used, the engine's WebAssembly heap
 * (`wasmBytes`: a page function's source returning it, e.g. '() => Module.HEAPU8.length'), and the page's DOM nodes,
 * event listeners and documents (CDP Performance.getMetrics: a listener or node count that only grows is a leak).
 * stop() returns { samples: [{ t, heapMB, heapTotalMB, wasmMB, nodes, listeners, docs }] — the last one after a full
 * collection (afterGc) —, growthPer10min: least squares of each after the first `settleS` seconds }.
 */
export async function memSampler(page, everyS, wasmBytes = '() => 0', settleS = 120) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const samples = [], t0 = Date.now();
  const one = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics'), m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const wasm = await page.evaluate(`(() => { try { return (${wasmBytes})(); } catch { return 0; } })()`).catch(() => 0);
    const s = { t: Math.round((Date.now() - t0) / 1000), heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), heapTotalMB: +(m.JSHeapTotalSize / 1048576).toFixed(1), wasmMB: +(wasm / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents };
    samples.push(s); console.log('[mem]', JSON.stringify(s));
  };
  await one();
  const timer = setInterval(() => { one().catch(() => {}); }, everyS * 1000);
  return async () => {
    clearInterval(timer); await one().catch(() => {});
    // (then a full collection and a last sample: what only grew because nothing collected it yet is told apart)
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {}); await one().catch(() => {}); samples.at(-1).afterGc = true;
    const later = samples.filter((s) => s.t >= settleS && !s.afterGc), slope = (k) => {
      const n = later.length; if (n < 2) return null;
      const mx = later.reduce((a, s) => a + s.t, 0) / n, my = later.reduce((a, s) => a + s[k], 0) / n;
      const b = later.reduce((a, s) => a + (s.t - mx) * (s[k] - my), 0) / Math.max(1e-9, later.reduce((a, s) => a + (s.t - mx) ** 2, 0));
      return +(b * 600).toFixed(2);
    };
    return { samples, growthPer10min: Object.fromEntries(['heapMB', 'wasmMB', 'nodes', 'listeners', 'docs'].map((k) => [k, slope(k)])) };
  };
}
