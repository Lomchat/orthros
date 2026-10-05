// The real-machine measurement kit (docs/real-machine-bench.md): the frame-time histogram, the scenario language and
// its player (src/host/scenario.js), the telemetry summaries (src/host/perf-summary.js), the GPU / GL call probe
// (src/gfx/gpu-probe.js) and the bench definitions of tools/scenarios/bench.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HIST_N, histBucket, histUpper, histQuantile, histSparse, histAddSparse, FrameStats, N_CATS, C } from '../src/core/frame-acct.js';
import { parseScenario, unsupportedSteps, ScenarioPlayer, inRanges } from '../src/host/scenario.js';
import { PerfWindow, SummaryClock, compactPhase } from '../src/host/perf-summary.js';
import { GpuProbe, WINDOW_FRAMES, PERIOD_MS, GL_FRAMES, GL_PERIOD_MS } from '../src/gfx/gpu-probe.js';
import { scanCodeOfVk } from '../src/win32/vk-scan.js';
import { scanCodeOfVk as dinputScan } from '../src/win32/dinput8.js';

const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };

test('histogram buckets: contiguous, increasing, every duration inside its bucket', () => {
  let prevUpper = 0;
  for (let b = 0; b < HIST_N - 1; b++) { const u = histUpper(b); assert.ok(u > prevUpper, `bucket ${b}`); prevUpper = u; }
  assert.equal(histUpper(HIST_N - 1), Infinity);
  const r = rng(7);
  for (let i = 0; i < 20000; i++) {
    const ms = r() < 0.5 ? r() * 120 : r() * 8000;
    const b = histBucket(ms);
    assert.ok(b >= 0 && b < HIST_N);
    assert.ok(ms < histUpper(b) || b === HIST_N - 1, `${ms} in ${b}`);
    if (b > 0) assert.ok(ms >= histUpper(b - 1), `${ms} above bucket ${b - 1}`);
  }
  assert.equal(histBucket(0), 0); assert.equal(histBucket(-3), 0); assert.equal(histBucket(NaN), 0);
  assert.equal(histBucket(33.4), 33); assert.equal(histBucket(100), 100); assert.equal(histBucket(299.9), 139); assert.equal(histBucket(300), 140); assert.equal(histBucket(1e6), HIST_N - 1);
});

test('histogram quantiles match the sorted durations to the bucket width', () => {
  const r = rng(11);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(r() * 3000), dts = [];
    for (let i = 0; i < n; i++) dts.push(r() < 0.9 ? 10 + r() * 30 : 30 + r() * (r() < 0.5 ? 200 : 3000));
    const h = new Array(HIST_N).fill(0); for (const d of dts) h[histBucket(d)]++;
    const sorted = [...dts].sort((a, b) => a - b), max = sorted[n - 1];
    for (const q of [0.5, 0.9, 0.99, 1]) {
      const exact = sorted[Math.min(n - 1, Math.floor(q * n))], got = histQuantile(h, q, max);
      const b = histBucket(exact);
      assert.ok(got >= exact - 1e-9 && got <= Math.min(histUpper(b), max), `q ${q}: ${got} for ${exact}`);
    }
    // (sparse round trip)
    assert.deepEqual(histAddSparse(new Array(HIST_N).fill(0), histSparse(h)), h);
  }
  assert.equal(histQuantile(new Array(HIST_N).fill(0), 0.5), null);
});

test('FrameStats intervals carry the slow counts and the frame-time histogram', () => {
  const fs_ = new FrameStats(1000), cats = new Float64Array(N_CATS);
  const dts = [10, 20, 33.4, 33.5, 39, 41, 50, 51, 99, 101, 250];
  for (const dt of dts) { cats.fill(0); cats[C.guest] = dt; fs_.add(dt, cats, 0); }
  const iv = fs_.takeInterval();
  assert.equal(iv.frames, dts.length);
  assert.equal(iv.s33, dts.filter((d) => d > 33.4).length);
  assert.equal(iv.s40, dts.filter((d) => d > 40).length);
  assert.equal(iv.s50, dts.filter((d) => d > 50).length);
  assert.equal(iv.s100, dts.filter((d) => d > 100).length);
  const h = histAddSparse(new Array(HIST_N).fill(0), iv.h);
  assert.equal(h.reduce((a, b) => a + b, 0), dts.length);
  for (const d of dts) assert.ok(h[histBucket(d)] > 0);
  assert.equal(fs_.takeInterval(), null);
});

test('scenario parsing: the harness form, new lines, comments, anchors and relative times', () => {
  const { steps, errors } = parseScenario('# a comment\n+3:key:27;+6:key:27\n10:waitframe:10,30,150,100000;0:mark:menu\n8:click:216,555;9:text:Or:thros;12:waitfps:15;0:mark:play;30:keydown:87;31.2:keyup:87');
  assert.deepEqual(errors, []);
  assert.deepEqual(steps.map((s) => [s.t, s.rel, s.anchored, s.kind]), [[3, true, false, 'key'], [6, true, false, 'key'], [10, false, false, 'waitframe'], [0, false, true, 'mark'], [8, false, true, 'click'], [9, false, true, 'text'], [12, false, true, 'waitfps'], [0, false, true, 'mark'], [30, false, true, 'keydown'], [31.2, false, true, 'keyup']]);
  assert.deepEqual(steps[2].args, [10, 30, 150, 100000]);
  assert.deepEqual(steps[5].args, ['Or:thros']); // (a string argument keeps its colons)
  assert.deepEqual(steps[3].args, ['menu']);
  const bad = parseScenario('x:click:1,2;5:click:3;6:waitframe:1;7:waitfps;8:move:a,b');
  assert.equal(bad.errors.length, 5);
  assert.deepEqual(unsupportedSteps(parseScenario('1:waitpixel:1,2,3,4,5;2:dbg:X=1;3:click:1,2;4:shot').steps).map((s) => s.kind), ['waitpixel', 'dbg']);
  assert.ok(inRanges(20, [10, 30, 150, 1e5]) && inRanges(200, [10, 30, 150, 1e5]) && !inRanges(60, [10, 30, 150, 1e5]) && !inRanges(-1, [1, 100]));
});

test('every scenario of tools/scenarios parses', () => {
  for (const f of fs.readdirSync(new URL('../tools/scenarios/', import.meta.url))) {
    if (!f.endsWith('.txt')) continue;
    const { steps, errors } = parseScenario(fs.readFileSync(new URL(`../tools/scenarios/${f}`, import.meta.url), 'utf8'));
    assert.deepEqual(errors, [], f); assert.ok(steps.length > 0, f);
  }
});

/** Drive a player: stats every 0.5 s from `statsAt(t)`, ticks every 0.1 s; the actions with their times. */
function play(player, statsAt, until) {
  const out = []; let stats = null, seq = 0;
  for (let i = 0; i <= until * 10; i++) {
    const t = i / 10;
    if (i % 5 === 0) { const s = statsAt(t); stats = s ? { ...s, seq: ++seq, dt: 0.5 } : null; }
    for (const a of player.tick(t, stats)) out.push({ ...a, t });
  }
  return out;
}

test('player: absolute times, +N from the first Direct3D frame, waits hold the steps after them', () => {
  const { steps } = parseScenario('2:move:1,1;+1:key:27;5:waitfps:20;0:mark:play;2:click:10,10');
  const p = new ScenarioPlayer(steps);
  // Direct3D frames from t = 4; fps above 20 from t = 10
  const acts = play(p, (t) => ({ fps: t >= 10 ? 30 : 5, d3d: t >= 4 ? { frames: Math.round((t - 4) * 30), draws: 0 } : null }), 30);
  const at = (k) => acts.find((a) => a.kind === k)?.t;
  assert.equal(at('move'), 2);
  assert.equal(at('key'), 5.5); // (the first frame is seen in the 4.5 s sample)
  const anchor = at('waitfps');
  assert.ok(anchor >= 12.5 && anchor <= 13, `waitfps anchor ${anchor}`); // 3 s of samples above 20 from t = 10
  assert.equal(at('mark'), anchor); assert.ok(Math.abs(at('click') - (anchor + 2)) < 1e-9);
  assert.ok(p.done); assert.equal(p.phase, 'play');
  assert.deepEqual(acts.find((a) => a.kind === 'key').args, [27]);
});

test('player: waitframe checks once a second, needs new frames and 3 checks in range', () => {
  const { steps } = parseScenario('0:waitframe:10,30,150,1000;0:mark:menu');
  const p = new ScenarioPlayer(steps);
  // 20 draws per frame from t = 5, but no new frame between t = 6 and t = 9 (a slow screen)
  let frames = 0, draws = 0, last = -1;
  const acts = play(p, (t) => { if (t >= 5 && !(t >= 6 && t < 9) && t !== last) { frames += 15; draws += 300; last = t; } return { fps: 30, d3d: { frames, draws } }; }, 20);
  const m = acts.find((a) => a.kind === 'waitframe');
  assert.ok(m, 'waitframe satisfied');
  // checks at 5 (20 draws/frame: 1), 6 (2), 7 and 8 (no new frame: the count holds, as in the harness), 9 (3)
  assert.equal(m.t, 9);
  assert.equal(m.dpf, 20);
  // out of range: never satisfied
  const q = new ScenarioPlayer(parseScenario('0:waitframe:40,100').steps);
  let f = 0; assert.equal(play(q, () => ({ d3d: { frames: (f += 10), draws: f * 20 } }), 20).length, 0);
  assert.equal(q.waiting.kind, 'waitframe');
});

test('player: pointer coordinates scaled from the scenario space to the display', () => {
  const { steps } = parseScenario('0:click:216,555;0:move:799,599;0:key:65;0:down:0,0');
  let display = [1024, 768];
  const p = new ScenarioPlayer(steps, { from: [800, 600], display: () => display });
  const acts = p.tick(0, null);
  assert.deepEqual(acts.map((a) => a.args), [[276, 710], [1023, 767], [65], [0, 0]]);
  display = [800, 600];
  const p2 = new ScenarioPlayer(steps, { from: [800, 600], display: () => display });
  assert.deepEqual(p2.tick(0, null)[0].args, [216, 555]);
});

test('scan codes: the shared table is the one DirectInput uses', () => {
  for (let vk = 0; vk < 256; vk++) assert.equal(scanCodeOfVk(vk), dinputScan(vk));
  assert.equal(scanCodeOfVk(27), 1); assert.equal(scanCodeOfVk(0x26), 0x148);
});

/** a stats message as the worker posts it */
function statsMsg({ dts = [], d3d = null, gl = null, render = 'worker' } = {}) {
  const fs_ = new FrameStats(100), cats = new Float64Array(N_CATS);
  for (const dt of dts) { cats.fill(0); cats[C.guest] = dt * 0.6; cats[C.sleep] = dt * 0.4; fs_.add(dt, cats); }
  return { dt: 0.5, fps: dts.length * 2, busy: 50, mips: 100, acct: fs_.takeInterval(), d3d, gl, render };
}

test('PerfWindow: percentiles, slow-frame rates, categories and counter differences', () => {
  const w = new PerfWindow();
  const r = rng(3), all = [];
  let d3dFrames = 100, draws = 1000;
  const gpu = { state: 'on', frames: 0, ms: 0, max: 0, over16: 0, over33: 0, disjoint: 0, lost: 0, hist: new Array(HIST_N).fill(0) };
  const glc = { state: 'on', frames: 0, calls: 0, draws: 0 };
  const g = { gpuWaitMs: 0, fenceMs: 0, frameMs: 0, replayMs: 0, readbackMs: 0 };
  for (let i = 0; i < 40; i++) {
    const dts = []; for (let k = 0; k < 15; k++) { const d = r() < 0.95 ? 30 + r() * 5 : 60 + r() * 80; dts.push(d); all.push(d); }
    d3dFrames += 15; draws += 15 * 300;
    for (let k = 0; k < 15; k++) { const ms = 5 + r() * 10; gpu.frames++; gpu.ms += ms; gpu.hist[histBucket(ms)]++; if (ms > gpu.max) gpu.max = ms; }
    if (i === 10) { glc.frames += 30; glc.calls += 30 * 2500; glc.draws += 30 * 300; }
    g.gpuWaitMs += 15 * 2; g.replayMs += 15 * 4;
    w.add(statsMsg({ dts, d3d: { frames: d3dFrames, draws, gpu: structuredClone(gpu), glCalls: { ...glc } }, gl: { ...g } }), { t: 1000 + i * 500, visible: true });
  }
  const s = w.take();
  const sorted = [...all].sort((a, b) => a - b), n = all.length;
  assert.equal(s.frames, n); assert.equal(s.seconds, 20); assert.equal(s.fps, n / 20);
  assert.equal(s.s33, all.filter((d) => d > 33.4).length); assert.equal(s.s100, all.filter((d) => d > 100).length);
  for (const [q, k] of [[0.5, 'p50'], [0.9, 'p90'], [0.99, 'p99']]) { const exact = sorted[Math.floor(q * n)]; assert.ok(s.dt[k] >= exact && s.dt[k] <= exact + 5, `${k} ${s.dt[k]} vs ${exact}`); }
  assert.equal(s.dt.max, Math.round(sorted[n - 1]));
  // the first message is the base of the counters: its own draws and GPU frames are not in the window
  assert.equal(s.d3dFrames, 39 * 15); assert.equal(s.drawsPerFrame, 300);
  assert.equal(s.gpu.state, 'on'); assert.equal(s.gpu.frames, 39 * 15); assert.ok(s.gpu.p50 >= 5 && s.gpu.p50 <= 16 && s.gpu.p99 <= 16);
  assert.deepEqual(s.glCalls, { frames: 30, perFrame: 2500, drawsPerFrame: 300 });
  assert.ok(Math.abs(s.render.waitMs - 39 * 15 * 2 / n) < 0.01);
  assert.ok(s.cats.guest > 0 && s.cats.sleep > 0 && s.work > 0);
  assert.equal(s.renderMode, 'worker'); assert.equal(s.visible, 1);
  // the next window starts from this one's counters; a counter that restarted (new device) counts from zero
  w.add(statsMsg({ dts: [30, 31], d3d: { frames: 4, draws: 40, gpu: { state: 'unavailable' }, glCalls: { state: 'unavailable' } } }));
  const s2 = w.take();
  assert.equal(s2.d3dFrames, 4); assert.equal(s2.drawsPerFrame, 10); assert.deepEqual(s2.gpu, { state: 'unavailable' }); assert.deepEqual(s2.glCalls, { state: 'unavailable' });
  assert.equal(w.take(), null);
});

test('SummaryClock: one summary every 20 s of samples, capped', () => {
  const c = new SummaryClock(20000, 3);
  let got = 0;
  for (let i = 0; i < 400; i++) if (c.add(statsMsg({ dts: [33, 33] }))) got++;
  assert.equal(got, 3); // (400 samples = 200 s = 10 periods, 3 sent)
  const d = new SummaryClock(20000, 100); let first = -1;
  for (let i = 0; i < 100 && first < 0; i++) if (d.add(statsMsg({ dts: [20] }))) first = i;
  assert.equal(first, 39);
  assert.equal(compactPhase(null), null);
  assert.equal(compactPhase({ label: 'x', frames: 3, worst: [1, 2, 3, 4] }).worst.length, 3);
});

/** a WebGL2 context double with the timer query extension (results available `lag` presents later) */
function fakeTimerGl({ lag = 2, ext = true, nsOf = () => 8e6 } = {}) {
  const st = { calls: 0, frame: 0, disjoint: false, queries: [], active: null };
  class Ctx {
    getExtension(n) { return ext && n === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb } : null; }
    createQuery() { const q = { id: st.queries.length }; st.queries.push(q); return q; }
    beginQuery(t, q) { assert.equal(st.active, null); st.active = q; q.begin = st.frame; }
    endQuery() { st.active.end = st.frame; st.active.ns = nsOf(st.active.id); st.active = null; }
    deleteQuery(q) { q.deleted = true; }
    getParameter(p) { if (p === 0x8fbb) { const d = st.disjoint; st.disjoint = false; return d; } return 0; }
    getQueryParameter(q, p) { if (p === this.QUERY_RESULT_AVAILABLE) return st.frame - q.end >= lag; return q.ns; }
    drawElements() { st.calls++; }
    uniform4fv() { st.calls++; }
  }
  Ctx.prototype.QUERY_RESULT_AVAILABLE = 0x8867; Ctx.prototype.QUERY_RESULT = 0x8866;
  return { gl: new Ctx(), st };
}

test('GPU probe: timed windows, results read when available, disjoint results dropped', () => {
  let now = 0;
  const { gl, st } = fakeTimerGl({ nsOf: (id) => (id % 10 === 0 ? 40e6 : 8e6) });
  const p = new GpuProbe(gl, { now: () => now, wrapGl: false });
  assert.equal(p.stats.gpu.state, 'on'); assert.equal(p.stats.glCalls.state, 'unavailable');
  const frame = () => { st.frame++; p.frame(); now += 16; };
  while (now < 3000 + 60 * 16) frame(); // (the first window opens at 3 s)
  assert.ok(p.cur && p.pending.length > 0 && p.pending.length <= 3, 'in flight: the current frame and the ones not yet available');
  while (now < 3000 + (WINDOW_FRAMES + 10) * 16) frame();
  assert.equal(p.stats.gpu.frames, WINDOW_FRAMES); assert.equal(p.pending.length, 0); assert.equal(p.cur, null);
  assert.equal(p.stats.gpu.over33, WINDOW_FRAMES / 10); assert.ok(Math.abs(p.stats.gpu.ms - (WINDOW_FRAMES * 0.9 * 8 + WINDOW_FRAMES * 0.1 * 40)) < 1e-6);
  assert.equal(histQuantile(p.stats.gpu.hist, 0.5), 9); assert.equal(Math.round(p.stats.gpu.max), 40);
  assert.ok(st.queries.every((q) => q.deleted || q === p.cur));
  // the next window comes PERIOD_MS later; a disjoint operation drops what was in flight
  while (now < 3000 + PERIOD_MS + 100) frame();
  assert.ok(p.pending.length > 0);
  const inFlight = p.pending.length; st.disjoint = true; frame();
  assert.ok(p.stats.gpu.disjoint >= inFlight);
  // without the extension: unavailable, no query ever made
  const plain = fakeTimerGl({ ext: false }); const q = new GpuProbe(plain.gl, { now: () => now, wrapGl: false });
  for (let i = 0; i < 400; i++) { now += 16; q.frame(); }
  assert.equal(q.stats.gpu.state, 'unavailable'); assert.equal(plain.st.queries.length, 0);
});

test('GPU probe: a GPU far behind leaves frames untimed rather than piling queries', () => {
  let now = 5000;
  const { gl, st } = fakeTimerGl({ lag: 1e9 });
  const p = new GpuProbe(gl, { now: () => now, wrapGl: false });
  for (let i = 0; i < 400; i++) { st.frame++; p.frame(); now += 16; } // (a window from 8 s)
  assert.ok(p.pending.length <= 16); assert.ok(p.stats.gpu.lost > 0); assert.equal(p.stats.gpu.frames, 0);
  // a result that never comes is given up after 240 presents: the queries after it are read again
  const lost = p.stats.gpu.lost;
  for (let i = 0; i < 300; i++) { st.frame++; p.frame(); now += 16; }
  assert.ok(p.stats.gpu.lost >= lost + 16 && p.pending.length === 0, `lost ${p.stats.gpu.lost}, pending ${p.pending.length}`);
  p.reset(); assert.equal(p.pending.length, 0);
});

test('GL call counter: windows of GL_FRAMES frames every GL_PERIOD_MS, unwrapped after, away while busy', () => {
  let now = 0;
  const { gl, st } = fakeTimerGl({ ext: false });
  const p = new GpuProbe(gl, { now: () => now, wrapGl: true });
  const frame = (calls) => { for (let i = 0; i < calls; i++) { gl.uniform4fv(); if (i % 10 === 0) gl.drawElements(); } p.frame(); now += 20; };
  const proto = Object.getPrototypeOf(gl), orig = proto.uniform4fv;
  while (now <= 5000) frame(50);
  assert.notEqual(proto.uniform4fv, orig, 'wrapped during the window');
  assert.ok(!Object.prototype.hasOwnProperty.call(gl, 'uniform4fv'), 'never an own property of the context (V8 dictionary mode)');
  for (let i = 0; i < GL_FRAMES; i++) frame(50);
  assert.equal(proto.uniform4fv, orig, 'unwrapped after'); assert.deepEqual(Object.getOwnPropertyNames(gl), []);
  assert.equal(p.stats.glCalls.frames, GL_FRAMES); assert.equal(p.stats.glCalls.calls / GL_FRAMES, 55); assert.equal(p.stats.glCalls.draws / GL_FRAMES, 5);
  assert.ok(st.calls > 0);
  // busy (a capture or GL timing wraps methods itself): the window is dropped and no new one starts
  while (now < 5000 + GL_PERIOD_MS + 50) frame(5);
  assert.ok(p.glWrapped);
  p.busy = true; assert.ok(!p.glWrapped); assert.equal(proto.uniform4fv, orig);
  for (let i = 0; i < 2000; i++) frame(1);
  assert.equal(p.stats.glCalls.frames, GL_FRAMES);
});

test('GL call counter: contexts sharing a prototype count their own calls; the methods come back in any stop order', () => {
  let now = 0;
  const a = fakeTimerGl({ ext: false }), proto = Object.getPrototypeOf(a.gl);
  const b = { gl: new a.gl.constructor() }, origU = proto.uniform4fv, origD = proto.drawElements;
  const pa = new GpuProbe(a.gl, { now: () => now, wrapGl: true }), pb = new GpuProbe(b.gl, { now: () => now, wrapGl: true });
  for (const [first, second] of [[pa, pb], [pb, pa]]) {
    now += GL_PERIOD_MS + 5000;
    pa.frame(); pb.frame();
    assert.ok(pa.glWrapped && pb.glWrapped);
    for (let i = 0; i < 7; i++) a.gl.uniform4fv(); for (let i = 0; i < 3; i++) b.gl.drawElements();
    assert.equal(pa.glCount, 7); assert.equal(pa.glDraws, 0); assert.equal(pb.glCount, 3); assert.equal(pb.glDraws, 3);
    first.busy = true; first.busy = false;
    assert.notEqual(proto.uniform4fv, origU, 'still counting for the other context');
    b.gl.drawElements(); a.gl.uniform4fv();
    assert.equal((second === pa ? pa : pb).glCount, second === pa ? 8 : 4);
    for (let i = 0; i < GL_FRAMES; i++) second.frame();
    assert.equal(proto.uniform4fv, origU); assert.equal(proto.drawElements, origD);
    assert.deepEqual(Object.getOwnPropertyNames(a.gl), []); assert.deepEqual(Object.getOwnPropertyNames(b.gl), []);
  }
});

test('bench definitions: each scenario parses, plays in the page, names its manifests and coordinates', () => {
  const dir = new URL('../tools/scenarios/bench/', import.meta.url);
  const { benches } = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8'));
  assert.ok(benches.length >= 2);
  const names = new Set();
  for (const b of benches) {
    assert.ok(/^[a-z0-9-]+$/.test(b.name) && !names.has(b.name), b.name); names.add(b.name);
    assert.ok(Array.isArray(b.manifests) && b.manifests.length, b.name);
    assert.ok(Array.isArray(b.coords) && b.coords.length === 2 && b.coords.every((v) => v > 0), b.name);
    assert.ok(b.maxSeconds > 60 && b.title, b.name);
    const { steps, errors } = parseScenario(fs.readFileSync(new URL(b.file, dir), 'utf8'));
    assert.deepEqual(errors, [], b.name); assert.deepEqual(unsupportedSteps(steps), [], b.name);
    const marks = steps.filter((s) => s.kind === 'mark').map((s) => s.args[0]);
    assert.ok(marks.length >= 2 && marks[marks.length - 1] === 'end', `${b.name}: marks ${marks}`);
    assert.ok(steps.some((s) => s.kind.startsWith('wait')), b.name);
  }
});
