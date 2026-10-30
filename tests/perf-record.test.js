// Passive session records (src/host/perf-record.js, src/host/web/perf-page.js, docs/real-machine-bench.md "Passive
// session records"): the recording per minute and per phase, hidden time left out, the counters' differences, the
// bounds, the server's validation and the /api/telemetry route, the page side with a fake window (frames, the
// engine's work, the GPU timer, the end), what a port's data waits were for (portDataSummary, compactDataSum), its
// session events (portEvents), the --perf report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PerfRecorder, sanitizePerfRecord, fitRecord, compactProbe, compactDataSum, MAX_RECORDS, MAX_ENTRIES, PERF_MAX_BYTES, PATH_MAX } from '../src/host/perf-record.js';
import { PerfSession, timerContext, portDataSummary, portEvents } from '../src/host/web/perf-page.js';
import { GameData } from '../src/vfs/data-client.js';
import { createServer } from '../src/host/server.js';
import { perfSessions, perfReport, formatPerf, gpuLabel, buildSessions } from '../tools/telemetry-report.mjs';
import { HIST_N, histBucket } from '../src/core/frame-acct.js';

const IRIS = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const header = { session: 'abcd1234', game: 'g1', runtime: 'goldsrc', version: '1.0', build: 'b1', tier: null };

/** `seconds` of play at `dt` ms frames (every `slowEvery`th frame `slowMs` long), the clock every second. */
function play(rec, t0, seconds, { dt = 33.3, slowEvery = 0, slowMs = 120, work = 20, visible = true, phase = 'running', data = 0 } = {}) {
  let t = t0, next = t0 + 1000, i = 0;
  while (t < t0 + seconds * 1000) {
    const d = slowEvery && ++i % slowEvery === 0 ? slowMs : dt; t += d;
    if (visible) rec.frame(d, work, d === slowMs ? data : 0);
    while (t >= next) { rec.clock(next, visible, phase); next += 1000; }
  }
  return t;
}

test('frames per minute: fps, percentiles, slow frames, work and wait; a record every 2 min with the totals', () => {
  const r = new PerfRecorder({ header });
  r.clock(0, true, 'running');
  play(r, 0, 125, { slowEvery: 30, slowMs: 120 });
  const rec = r.take(125000);
  assert.ok(rec, 'a record after 2 min');
  assert.equal(rec.event, 'perf'); assert.equal(rec.seq, 0); assert.equal(rec.final, false); assert.equal(rec.session, 'abcd1234');
  assert.equal(rec.mins.length, 2, 'two whole minutes');
  const m = rec.mins[0];
  assert.equal(m.t, 0); assert.equal(m.ph, 'running');
  assert.ok(Math.abs(m.s - 60) <= 1, `visible seconds ${m.s}`);
  assert.ok(m.fps > 25 && m.fps < 30, `fps ${m.fps}`);
  assert.equal(m.p50, 34); // (the bucket's upper bound of 33.3 ms)
  assert.ok(m.p99 >= 120, `p99 ${m.p99}`);
  assert.ok(m.f40 >= 50 && m.f40 <= 70, `f40 ${m.f40}`); assert.equal(m.f40, m.f100);
  assert.equal(m.work, 20);
  assert.ok(m.wait > 13 && m.wait < 20, `wait ${m.wait}`);
  assert.ok(m.slow.work > 0 && m.slow.other > 0, 'the slow frames by cause');
  assert.equal(rec.tot.n, rec.mins[0].n + rec.mins[1].n + (rec.tot.n - rec.mins[0].n - rec.mins[1].n));
  assert.ok(Array.isArray(rec.tot.h) && rec.tot.h.length > 0);
  assert.equal(r.take(126000), null, 'not due again');
});

test('hidden time is counted apart and its frames left out; a hidden tab sends nothing', () => {
  const r = new PerfRecorder({ header });
  r.clock(0, true, 'running');
  let t = play(r, 0, 30);
  r.clock(30000, false, 'running');
  // (frames while hidden: ignored)
  for (let i = 0; i < 100; i++) r.frame(16, 5, 0);
  for (let s = 31; s <= 90; s++) r.clock(s * 1000, false, 'running');
  r.clock(91000, true, 'running');
  t = play(r, 91000, 40);
  const rec = r.take(131000);
  assert.ok(rec);
  const hid = rec.mins.reduce((a, e) => a + e.hid, 0), vis = rec.mins.reduce((a, e) => a + e.s, 0);
  assert.ok(hid >= 58 && hid <= 62, `hidden ${hid}`);
  assert.ok(vis >= 57 && vis <= 61, `visible in the two minutes closed ${vis}`);
  assert.ok(rec.vis >= 68 && rec.vis <= 72, `visible in the session ${rec.vis}`);
  assert.ok(rec.tot.fps > 28 && rec.tot.fps < 31, `the totals' fps over the visible time: ${rec.tot.fps}`);
  assert.ok(rec.tot.p50 >= 33 && rec.tot.p50 <= 34, `no 16 ms frame counted: p50 ${rec.tot.p50}`);
  assert.ok(Math.abs(rec.hid - 61) <= 2 && rec.len === 131);
  // a long hidden stretch: no record without entries
  const h = new PerfRecorder({ header });
  h.clock(0, false, 'running');
  for (let s = 1; s <= 400; s++) h.clock(s * 1000, false, 'running');
  assert.equal(h.take(400000), null);
});

test('a phase change starts a new entry (a short one takes the new phase)', () => {
  const r = new PerfRecorder({ header });
  r.clock(0, true, 'starting');
  r.clock(2000, true, 'loading'); // (2 s: the entry takes the new phase)
  play(r, 2000, 20, { phase: 'loading' });
  play(r, 22000, 20, { phase: 'running' });
  const rec = r.take(42000, true);
  assert.deepEqual(rec.mins.map((e) => e.ph), ['loading', 'running']);
  assert.equal(rec.final, true);
  assert.equal(r.take(500000, true), null, 'nothing after the end');
});

test('Win32 intervals: frame accounting counts, categories, slow categories', () => {
  const r = new PerfRecorder({ header: { ...header, runtime: 'win32' } });
  r.clock(0, true, 'running');
  for (let i = 1; i <= 120; i++) {
    r.interval({ frames: 15, h: [33, 14, 120, 1], s40: 1, s100: 1, max: 121, w: 18, c: { guest: 12, draw: 6, wait: 15 }, sc: { guest: 80, wait: 40 } }, 15 * 33);
    if (i % 2 === 0) r.clock(i * 500, true, 'running');
  }
  const rec = r.take(60000, true);
  const m = rec.mins[0];
  assert.equal(m.n, 1800); assert.equal(m.f40, 120); assert.equal(m.f100, 120);
  assert.equal(m.work, 18); assert.equal(m.cats.guest, 12); assert.equal(m.cats.wait, 15);
  assert.equal(m.slow.guest, 9600); assert.equal(m.slow.wait, 4800);
  assert.equal(m.p50, 34); assert.equal(m.max, 121);
});

test('GPU timer and data waits: differences per entry, totals over the session', () => {
  const r = new PerfRecorder({ header });
  const hist = new Array(HIST_N).fill(0);
  r.counters({ gpu: { state: 'on', frames: 0, ms: 0, hist }, data: { waits: 0, ms: 0 } });
  r.clock(0, true, 'running');
  play(r, 0, 59);
  hist[histBucket(8.5)] += 120;
  r.counters({ gpu: { state: 'on', frames: 120, ms: 1020, hist }, data: { waits: 3, ms: 450 } });
  play(r, 59000, 2);
  play(r, 61000, 58);
  hist[histBucket(12.5)] += 60;
  r.counters({ gpu: { state: 'on', frames: 180, ms: 1770, hist }, data: { waits: 4, ms: 500 } });
  play(r, 119000, 3);
  const rec = r.take(122000);
  assert.deepEqual(rec.mins[0].gpu, { n: 120, mean: 8.5, p50: 9, p90: 9, p99: 9 });
  assert.deepEqual(rec.mins[0].data, { n: 3, ms: 450 });
  assert.deepEqual(rec.mins[1].gpu, { n: 60, mean: 12.5, p50: 13, p90: 13, p99: 13 });
  assert.deepEqual(rec.mins[1].data, { n: 1, ms: 50 });
  assert.equal(rec.tot.gpu.n, 180); assert.equal(rec.tot.data.ms, 500);
  // a browser without the timer: its state
  const u = new PerfRecorder({ header }); u.counters({ gpu: { state: 'unavailable' } }); u.clock(0, true, 'x'); play(u, 0, 10, { phase: 'x' });
  assert.deepEqual(u.take(10000, true).mins[0].gpu, { state: 'unavailable' });
  // queries lost (no result), and a frame past the histogram's last bound
  const l = new PerfRecorder({ header }); l.counters({ gpu: { state: 'on', frames: 0, ms: 0, lost: 0, hist: new Array(HIST_N).fill(0) } }); l.clock(0, true, 'x'); play(l, 0, 10, { phase: 'x' });
  const big = new Array(HIST_N).fill(0); big[histBucket(9000)] = 1;
  l.counters({ gpu: { state: 'on', frames: 0, ms: 0, lost: 7, hist: big.map(() => 0) } });
  assert.deepEqual(l.take(10000, true).mins[0].gpu, { n: 0, lost: 7 });
  const o = new PerfRecorder({ header }); o.clock(0, true, 'x'); o.counters({ gpu: { state: 'on', frames: 1, ms: 9000, hist: big } }); play(o, 0, 10, { phase: 'x' });
  assert.equal(o.take(10000, true).mins[0].gpu.p99, 5000);
});

test('slow frames waiting for the game data are said so', () => {
  const r = new PerfRecorder({ header });
  r.clock(0, true, 'running');
  play(r, 0, 30, { slowEvery: 20, slowMs: 200, work: 190, data: 150 });
  const m = r.take(30000, true).mins[0];
  assert.ok(m.slow.data > m.slow.work && m.slow.work > m.slow.other, JSON.stringify(m.slow));
});

test('bounds: records per session, entries per record, size', () => {
  const r = new PerfRecorder({ header, recordMs: 1000, minuteMs: 500 });
  r.clock(0, true, 'running');
  let n = 0;
  for (let s = 1; s <= MAX_RECORDS * 2 + 10; s++) { r.frame(30, 10); r.clock(s * 1000, true, 'running'); if (r.take(s * 1000)) n++; }
  assert.equal(n, MAX_RECORDS);
  assert.ok(r.take(1e7, true), 'the end is still sent');
  // entries over the cap: the oldest dropped, counted
  const e = new PerfRecorder({ header, minuteMs: 1000 });
  e.clock(0, true, 'running');
  for (let s = 1; s <= MAX_ENTRIES + 5; s++) { e.frame(30, 10); e.clock(s * 1000, true, 'running'); }
  const rec = e.take(1e5, true);
  assert.equal(rec.mins.length, MAX_ENTRIES); assert.ok(rec.dropped >= 5);
  // a record over the size: the histogram, then entries
  const big = { event: 'perf', mins: Array.from({ length: 12 }, () => ({ cats: Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['k' + i, i])) })), tot: { h: Array.from({ length: 300 }, (_, i) => i) } };
  const fit = fitRecord(big);
  assert.ok(JSON.stringify(fit).length <= PERF_MAX_BYTES && fit.dropped > 0 && !fit.tot.h);
});

test('the probe, compact; sent once and at the end', () => {
  const p = compactProbe({ atomicsWait1: { n: 24, mean: 14, p50: 14.6, p90: 15.1, max: 16 }, setTimeout1: { n: 24, mean: 15, p50: 15.6, p90: 16, max: 17 }, battery: { charging: false, level: 0.5 }, injected: 0 });
  assert.deepEqual(p, { atomicsWait1: [14.6, 15.1, 16], setTimeout1: [15.6, 16, 17], battery: { charging: false, level: 0.5 } });
  const r = new PerfRecorder({ header, recordMs: 10000, minuteMs: 5000 });
  r.clock(0, true, 'running'); r.setProbe({ atomicsWait1: { p50: 1, p90: 2, max: 3 } });
  play(r, 0, 11, { phase: 'running' }); r.clock(11000, true, 'running');
  const r1 = r.take(11000); assert.ok(r1.probe);
  play(r, 11000, 11, { phase: 'running' });
  const r2 = r.take(22000); assert.equal(r2?.probe, undefined);
  assert.ok(r.take(23000, true).probe);
});

/** a valid record as the page sends it */
function sample() {
  const r = new PerfRecorder({ header: { ...header, runtime: 'win32' } });
  r.counters({ gpu: { state: 'on', frames: 0, ms: 0, hist: new Array(HIST_N).fill(0) }, data: { waits: 0, ms: 0 } });
  r.clock(0, true, 'running'); play(r, 0, 30, { slowEvery: 25 });
  r.setProbe({ atomicsWait1: { p50: 1, p90: 2, max: 3 }, battery: { charging: true, level: 1 } });
  const rec = r.take(30000, true);
  rec.env = { gpu: IRIS, gpuVendor: 'Google Inc. (Intel)', gpuClass: 'integrated', cores: 8, memGB: 8, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0', screen: '1920x1080@1.25' };
  return JSON.parse(JSON.stringify(rec));
}

test('the server-side check: known fields kept, the rest dropped, bad records refused', () => {
  const rec = sample(), v = sanitizePerfRecord(rec);
  assert.ok(v.ok, v.error);
  assert.deepEqual(v.rec, rec, 'a page\'s record passes unchanged');
  const extra = { ...sample(), secret: 'x', env: { ...sample().env, email: 'a@b.c' }, mins: [{ ...sample().mins[0], name: 'me', cats: { ok: 1, 'bad key': 2, n: NaN } }] };
  const w = sanitizePerfRecord(extra);
  assert.ok(w.ok);
  assert.equal(w.rec.secret, undefined); assert.equal(w.rec.env.email, undefined); assert.equal(w.rec.mins[0].name, undefined);
  assert.deepEqual(w.rec.mins[0].cats, { ok: 1 });
  for (const [k, bad] of [['session', 'x'], ['session', '../../etc'], ['runtime', 'dos'], ['seq', -1], ['seq', MAX_RECORDS + 1], ['seq', 1.5], ['v', 2], ['mins', 'no'], ['mins', new Array(MAX_ENTRIES + 1).fill({})], ['tot', null]]) {
    assert.equal(sanitizePerfRecord({ ...sample(), [k]: bad }).ok, false, `${k}=${JSON.stringify(bad).slice(0, 30)}`);
  }
  const long = sanitizePerfRecord({ ...sample(), game: 'g'.repeat(500), mins: [{ ...sample().mins[0], ph: 'p'.repeat(100), fps: Infinity, p99: -3 }] });
  assert.equal(long.rec.game.length, 120); assert.equal(long.rec.mins[0].ph.length, 24);
  assert.equal(long.rec.mins[0].fps, undefined); assert.equal(long.rec.mins[0].p99, undefined);
  assert.equal(sanitizePerfRecord({ ...sample(), tot: { ...sample().tot, h: [1, 2, 3.5] } }).rec.tot.h, undefined);
});

test('/api/telemetry: perf records checked, limited in size, written rebuilt', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-perf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), tel = path.join(root, 'tel'); fs.mkdirSync(games); fs.mkdirSync(tel);
  const server = createServer({ gamesDir: games, enginesDir: path.join(root, 'engines'), telemetryDir: tel, lanLog: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/telemetry`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }).then((r) => r.status);
  assert.equal(await post({ ...sample(), extra: 1 }), 204);
  assert.equal(await post({ ...sample(), runtime: 'nope' }), 400);
  assert.equal(await post({ ...sample(), pad: 'x'.repeat(PERF_MAX_BYTES) }), 413);
  assert.equal(await post({ session: 'old', samples: [{ dt: 0.5, pad: 'x'.repeat(PERF_MAX_BYTES) }] }), 204, 'other telemetry keeps its own limit');
  await new Promise((r) => setTimeout(r, 100));
  const lines = fs.readdirSync(tel).flatMap((f) => fs.readFileSync(path.join(tel, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
  const perf = lines.filter((l) => l.event === 'perf');
  assert.equal(perf.length, 1); assert.equal(perf[0].extra, undefined); assert.ok(perf[0].at);
  assert.equal(lines.length, 2);
});

/** A window for PerfSession: animation frames run by the test, visibility, listeners. */
function fakeWindow() {
  const listeners = {}, docListeners = {}, frames = [];
  const win = {
    document: { visibilityState: 'visible', addEventListener: (k, f) => { (docListeners[k] ??= []).push(f); }, removeEventListener: () => {} },
    addEventListener: (k, f) => { (listeners[k] ??= []).push(f); }, removeEventListener: () => {},
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    run(t) { const cbs = frames.splice(0); for (const cb of cbs) cb(t); },
    fire(k) { for (const f of listeners[k] ?? []) f(); }, fireDoc(k) { for (const f of docListeners[k] ?? []) f(); },
  };
  return win;
}

test('the page side: frames shown, the engine\'s work per frame, the GPU timer, hidden frames, the end once', (t) => {
  const win = fakeWindow(), sent = [];
  let now = 0, draws = 0, queries = 0;
  const realNow = performance.now;
  // (the engine's work: performance.now as the fake clock)
  performance.now = () => now;
  t.after(() => { performance.now = realNow; });
  const gl = { getExtension: (n) => (n === 'EXT_disjoint_timer_query_webgl2' ? {} : null), createQuery: () => ({ id: ++queries }), beginQuery() {}, endQuery() {}, deleteQuery() {}, getParameter: () => false, getQueryParameter: (q, p) => (p === 'avail' ? true : 7e6), QUERY_RESULT_AVAILABLE: 'avail', QUERY_RESULT: 'res' };
  const s = new PerfSession({ runtime: 'openmw', game: 'mw', session: 'sess1234', win, now: () => now, probe: false, send: (r) => sent.push(r), phase: () => 'world', data: () => ({ waits: 0, ms: 0 }), env: () => ({ gpu: IRIS, cores: 8, memGB: 8 }) });
  t.after(() => clearInterval(s.timer));
  s.watchFrames({ gl: () => gl, draws: () => draws });
  // the engine: an animation frame loop drawing every frame, 12 ms of work, frames every 33 ms (30 fps)
  const engine = (ts) => { now = ts + 12; draws++; win.requestAnimationFrame(engine); };
  win.requestAnimationFrame(engine);
  for (let f = 1; f <= 30 * 70; f++) { const ts = f * 33.333; now = ts; win.run(ts); if (f % 30 === 0) { now = ts + 20; s.tick(); } }
  // hidden 30 s (no frames), then back
  win.document.visibilityState = 'hidden'; win.fireDoc('visibilitychange');
  now += 30000; s.tick();
  win.document.visibilityState = 'visible'; win.fireDoc('visibilitychange');
  const base = now;
  for (let f = 1; f <= 30 * 60; f++) { const ts = base + f * 33.333; now = ts; win.run(ts); if (f % 30 === 0) { now = ts + 20; s.tick(); } }
  assert.equal(sent.length, 1, 'one record after 2 min');
  win.fire('pagehide'); win.fire('pagehide'); s.end();
  assert.equal(sent.length, 2, 'the end once');
  const [first, last] = sent;
  assert.equal(first.runtime, 'openmw'); assert.equal(first.env.gpuClass, 'integrated');
  const m = first.mins[0];
  assert.ok(m.fps > 29 && m.fps < 31, `fps ${m.fps}`);
  assert.ok(m.p50 >= 33 && m.p50 <= 34, `p50 ${m.p50}`); assert.equal(m.f40, 0);
  assert.ok(Math.abs(m.work - 12) < 0.5, `work ${m.work}`); assert.ok(Math.abs(m.wait - 21.3) < 0.5, `wait ${m.wait}`);
  assert.equal(last.final, true);
  assert.ok(last.tot.max < 40, `the hidden gap is no frame (max ${last.tot.max})`);
  assert.ok(last.hid >= 29 && last.hid <= 31, `hidden ${last.hid}`);
  assert.ok(last.tot.gpu?.n > 0 && last.tot.gpu.mean === 7, JSON.stringify(last.tot.gpu));
  assert.ok(sanitizePerfRecord(JSON.parse(JSON.stringify(last))).ok);
});

test('the page side: an engine whose animation frame comes before the meter\'s has its work of the right frame', (t) => {
  const win = fakeWindow(), sent = [];
  let now = 0, draws = 0;
  const realNow = performance.now;
  performance.now = () => now;
  t.after(() => { performance.now = realNow; });
  // (the engine's loop first: in each frame its callback runs before the meter's, its request is that frame's)
  const engine = (ts) => { now = ts + 8; draws++; win.requestAnimationFrame(engine); };
  win.requestAnimationFrame(engine);
  const s = new PerfSession({ runtime: 'goldsrc', game: 'hl', session: 'sess5678', win, now: () => now, probe: false, send: (r) => sent.push(r), phase: () => 'running', env: () => ({ gpu: IRIS }) });
  t.after(() => clearInterval(s.timer));
  s.watchFrames({ draws: () => draws });
  for (let f = 1; f <= 30 * 20; f++) { const ts = f * 33.333; now = ts; win.run(ts); if (f % 30 === 0) { now = ts + 20; s.tick(); } }
  s.end();
  const m = sent.at(-1).tot;
  assert.ok(Math.abs(m.work - 8) < 0.5, `work ${m.work}`);
  assert.equal(m.gpu, undefined, 'no context: no GPU part');
});

test('WebGL1 timer queries through the WebGL2 names', () => {
  const calls = [];
  const ext = { QUERY_RESULT_EXT: 0x8866, QUERY_RESULT_AVAILABLE_EXT: 0x8867, createQueryEXT: () => 'q', beginQueryEXT: (a, q) => calls.push(['begin', a, q]), endQueryEXT: (a) => calls.push(['end', a]), getQueryObjectEXT: (q, p) => (p === 0x8867 ? true : 5), deleteQueryEXT: () => calls.push(['delete']) };
  const gl1 = { getExtension: (n) => (n === 'EXT_disjoint_timer_query' ? ext : null), getParameter: () => false };
  const t = timerContext(gl1);
  assert.equal(t.getExtension('EXT_disjoint_timer_query_webgl2'), ext);
  t.beginQuery(0x88bf, t.createQuery()); t.endQuery(0x88bf);
  assert.deepEqual(calls, [['begin', 0x88bf, 'q'], ['end', 0x88bf]]);
  assert.equal(t.getQueryParameter('q', t.QUERY_RESULT), 5);
  assert.equal(timerContext({ getExtension: () => null }).getExtension('EXT_disjoint_timer_query_webgl2'), null);
});

test('--perf: sessions per game × GPU, medians, the worst minutes, slow frames\' causes, the GPU filter', (t) => {
  const mk = (session, gpu, slowEvery, game = 'g1') => {
    const r = new PerfRecorder({ header: { ...header, session, game } });
    r.clock(0, true, 'running'); play(r, 0, 125, { slowEvery, slowMs: 150 });
    const a = r.take(125000); play(r, 125000, 60, { slowEvery, slowMs: 150 }); r.setProbe({ atomicsWait1: { p50: 14.5, p90: 15, max: 16 }, battery: { charging: false, level: 0.4 } });
    const b = r.take(185000, true);
    return [a, b].map((x) => ({ at: '2026-10-23T10:00:00.000Z', ...x, env: { gpu, cores: 8, memGB: 8, ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/154.0.0.0' } }));
  };
  const blank = new PerfRecorder({ header: { ...header, session: 's5aaaa' } }); blank.clock(0, true, 'loading'); for (let i = 1; i <= 90; i++) blank.clock(i * 1000, true, 'loading');
  const noFrame = { at: '2026-10-23T10:00:00.000Z', ...blank.take(90000, true), env: { gpu: IRIS } };
  const lines = [noFrame, ...mk('s1aaaa', IRIS, 10), ...mk('s2aaaa', IRIS, 50), ...mk('s3aaaa', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x2560) Direct3D11 vs_5_0 ps_5_0, D3D11)', 0), ...mk('s4aaaa', IRIS, 0, 'g2'), { session: 'old', samples: [] }];
  lines.push(lines[0]); // (a record received twice)
  assert.equal(perfSessions(lines).get('s1aaaa').mins.length, 4, 'a record received twice counts once');
  const groups = perfReport(perfSessions(lines));
  assert.deepEqual(groups.map((g) => `${g.game} ${g.gpu} ${g.sessions}`), ['g1 Intel Iris Xe Graphics 2', 'g1 NVIDIA GeForce RTX 3060 1', 'g2 Intel Iris Xe Graphics 1']);
  const iris = groups[0];
  assert.ok(iris.minutes > 6 && iris.minutes < 6.4, `minutes ${iris.minutes}`);
  assert.ok(iris.median.per40 > 0 && iris.worst.length === 3 && iris.worst[0].session === 's1aaaa');
  assert.ok(iris.merged.p99 >= 150);
  assert.ok(iris.slowShares.work > 0 && iris.slowShares.other > 0);
  assert.equal(iris.probe.atomicsWait1P50, 14.5); assert.equal(iris.probe.onBattery, 2);
  const fil = perfReport(perfSessions(lines, { gpu: 'iris', game: 'g1' }));
  assert.deepEqual(fil.map((g) => g.gpu), ['Intel Iris Xe Graphics']);
  const text = formatPerf(groups);
  assert.match(text, /g1 \(goldsrc\) × Intel Iris Xe Graphics: 2 session\(s\), [\d.]+ min of visible play; 1 session\(s\) without a frame shown/);
  assert.match(text, /worst minute: s1aaaa/);
  assert.match(text, /slow frames' time by cause/);
  assert.equal(gpuLabel('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'), 'Apple M2');
  // (the classic per-session report keeps the page's own machine: a perf record of the same session does not replace it)
  const classic = buildSessions([{ session: 's1aaaa', game: 'g1', samples: [], env: { gpu: IRIS, coi: true, version: 'b0' } }, lines[0]]);
  assert.equal(classic.get('s1aaaa').env.coi, true);
  // the command line
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-perf-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'telemetry-2026-10-23.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const out = spawnSync(process.execPath, ['tools/telemetry-report.mjs', dir, '--perf', '--gpu', 'Iris', '--game', 'g1'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Intel Iris Xe Graphics: 2 session/); assert.doesNotMatch(out.stdout, /NVIDIA/);
  const js = JSON.parse(spawnSync(process.execPath, ['tools/telemetry-report.mjs', dir, '--perf', '--json'], { encoding: 'utf8' }).stdout);
  assert.equal(js.length, 3);
});

test('data waits attributed: the files, the engine\'s own stops, announced reads, the background by producer; in the totals only', () => {
  const sum = {
    files: { 'Audio/VROCK.adf': [120, 35000], 'models/gta3.img': [300, 4200], 'Audio/Water.mp3': [9, 900], 'anim/ped.ifp': [1, 20], 'x': [0, 0] },
    blocked: { count: 140, ms: 38123.4, max: 812.6, files: { 'Audio/VROCK.adf': 35100.2, 'models/gta3.img': 3000, 'Audio/Water.mp3': 23.2, 'data/x.dat': 0.1 } },
    wantWaits: 2, wantWaitMs: 310.4, wantTimeouts: 0,
    bgBy: { pf1: { requests: 10, wire: 2 << 20, raw: 3 << 20, inLoad: 1 << 20 }, mediaAhead: { requests: 3, wire: 512 << 10, raw: 512 << 10, inLoad: 0 }, idle: { requests: 0, wire: 0, raw: 0, inLoad: 0 }, 'bad key': { requests: 1, wire: 9, raw: 9, inLoad: 0 } },
  };
  const c = compactDataSum(sum);
  assert.deepEqual(c, {
    files: [['Audio/VROCK.adf', 35000, 120], ['models/gta3.img', 4200, 300], ['Audio/Water.mp3', 900, 9]],
    blocked: { n: 140, ms: 38123, max: 813, top: [['Audio/VROCK.adf', 35100], ['models/gta3.img', 3000], ['Audio/Water.mp3', 23]] },
    want: { n: 2, ms: 310, to: 0 },
    bg: { pf1: [10, 2048, 1024], mediaAhead: [3, 512, 0] },
  });
  assert.equal(compactDataSum({ files: {}, blocked: null, wantWaits: 0, bgBy: null }), null, 'nothing to say: no part');
  assert.equal(compactDataSum({ files: { ['d/'.repeat(200) + 'f.bin']: [1, 5] } }).files[0][0].length, PATH_MAX, 'a long path: its end');
  // in the record: the totals carry the session's so far, the minutes their counts only; the server keeps them
  const r = new PerfRecorder({ header });
  r.counters({ data: { waits: 0, ms: 0, sum: null } }); r.clock(0, true, 'running');
  play(r, 0, 60);
  r.counters({ data: { waits: 430, ms: 40000, sum } });
  play(r, 60000, 61);
  const rec = r.take(121000, true);
  assert.deepEqual(rec.tot.data, { n: 430, ms: 40000, ...c });
  for (const m of rec.mins) assert.deepEqual(Object.keys(m.data ?? {}).sort(), ['ms', 'n']);
  const v = sanitizePerfRecord(JSON.parse(JSON.stringify(rec)));
  assert.ok(v.ok, v.error); assert.deepEqual(v.rec.tot.data, rec.tot.data);
  // (the server: the totals' data rebuilt from its known parts, bounded — paths cut, bad lists and keys dropped)
  const bad = sanitizePerfRecord({ ...rec, tot: { ...rec.tot, data: { n: 1, ms: 2, files: [['a', 1, 2], ['b', -1, 2], ['c'.repeat(400), 1, 1], ['d', 1, 1]], blocked: { n: 1, ms: 2, max: 2, top: [['a', 1, 9]], who: 'x' }, want: 'x', bg: { pf: [1, 2, 3], 'no way': [1, 2, 3], ok: [1, 2] }, secret: 1 } } });
  assert.ok(bad.ok);
  assert.deepEqual(bad.rec.tot.data, { n: 1, ms: 2, files: [['a', 1, 2], ['c'.repeat(PATH_MAX), 1, 1]], blocked: { n: 1, ms: 2, max: 2 }, bg: { pf: [1, 2, 3] } });
  assert.deepEqual(sanitizePerfRecord({ ...rec, mins: [{ ...rec.mins[0], data: { n: 1, ms: 2, files: [['a', 1, 2]] } }] }).rec.mins[0].data, { n: 1, ms: 2 }, 'a minute\'s data: its counts only');
});

test('data waits attributed: compacted only when a record takes them, the same values as compacting at every clock tick', () => {
  // the page's source (portDataSummary): `sum` a getter over live counters; the record compacts what it says when taken
  const live = { files: { 'a.bin': [1, 10] }, blocked: null, wantWaits: 0, wantWaitMs: 0, wantTimeouts: 0, bgBy: null };
  let reads = 0;
  const src = () => ({ waits: 1, ms: 10, get sum() { reads++; return { ...live, files: { ...live.files } }; } });
  const r = new PerfRecorder({ header });
  r.counters({ data: src() }); r.clock(0, true, 'running');
  for (let s = 1; s <= 30; s++) { live.files[`f${s}.bin`] = [s, s]; play(r, (s - 1) * 1000, 1); r.counters({ data: src() }); r.take(s * 1000); }
  assert.equal(reads, 0, 'the clock ticks before a record is due: no summary read, no sort');
  play(r, 30000, 100); r.counters({ data: src() });
  const rec = r.take(130000);
  assert.equal(reads, 1, 'one read for the record');
  assert.deepEqual(rec.tot.data, { n: 1, ms: 10, ...compactDataSum(live) }, 'the values at the record\'s tick');
  // the source gone (no sum any more): what it said last kept, read when it went — as compacting at each tick did
  play(r, 130000, 1); r.counters({ data: src() }); r.take(131000);
  const before = compactDataSum(live);
  r.counters({ data: { waits: 1, ms: 10 } }); assert.equal(reads, 2, 'compacted when the source goes');
  live.files['later.bin'] = [9, 9];
  r.counters({ data: null });
  play(r, 131000, 130); r.counters({ data: { waits: 1, ms: 10 } });
  assert.deepEqual(r.take(261000, true).tot.data, { n: 1, ms: 10, ...before });
});

test('a port\'s data for its record: the shared game data\'s waits by file, the engine\'s stops under its root, the link\'s producers', (t) => {
  assert.equal(portDataSummary(null), null);
  // (the shared game data counts every wait of the engine by file: data-client.js waited)
  const gd = { stats: { fileWaits: {}, misses: 0, stallMs: 0, wantWaits: 1, wantWaitMs: 40, wantTimeouts: 1 }, net: { bgBy: { pf: { requests: 2, wire: 4096, raw: 4096, inLoad: 0 } } } };
  GameData.prototype.waited.call(gd, { path: 'Audio/VROCK.adf' }, 300); GameData.prototype.waited.call(gd, { path: 'Audio/VROCK.adf' }, 200); GameData.prototype.waited.call(gd, { src: 4 }, 10);
  assert.deepEqual(gd.stats.fileWaits, { 'Audio/VROCK.adf': [2, 500], 'src:4': [1, 10] });
  assert.equal(gd.stats.misses, 3); assert.equal(gd.stats.stallMs, 510);
  const engine = { orthrosBlocked: { count: 2, ms: 520, max: 310, files: { '/game/Audio/VROCK.adf': 510, '/elsewhere/x': 10 } } };
  const d = portDataSummary(gd, engine, { root: '/game' });
  assert.equal(d.waits, 3); assert.equal(d.ms, 510);
  assert.deepEqual(d.sum, { files: gd.stats.fileWaits, blocked: { count: 2, ms: 520, max: 310, files: { 'Audio/VROCK.adf': 510, '/elsewhere/x': 10 } }, wantWaits: 1, wantWaitMs: 40, wantTimeouts: 1, bgBy: gd.net.bgBy });
  assert.equal(portDataSummary(gd).sum.blocked, null, 'an engine that does not count its stops');
  // through the page's session: the final record's totals say which file the session waited for
  const win = fakeWindow(), sent = [];
  let now = 0, draws = 0;
  const realNow = performance.now; performance.now = () => now; t.after(() => { performance.now = realNow; });
  const s = new PerfSession({ runtime: 're3', game: 'vc', session: 'sess5678', win, now: () => now, probe: false, send: (r) => sent.push(r), data: () => portDataSummary(gd, engine, { root: '/game' }), env: () => ({}) });
  t.after(() => clearInterval(s.timer));
  s.watchFrames({ draws: () => draws });
  const eng = (ts) => { now = ts + 5; draws++; win.requestAnimationFrame(eng); };
  win.requestAnimationFrame(eng);
  for (let f = 1; f <= 30 * 20; f++) { const ts = f * 33.333; now = ts; win.run(ts); if (f % 30 === 0) { now = ts + 20; s.tick(); } }
  s.end();
  const last = sent.at(-1);
  assert.equal(last.final, true);
  assert.deepEqual(last.tot.data.files[0], ['Audio/VROCK.adf', 500, 2]);
  assert.deepEqual(last.tot.data.blocked.top, [['Audio/VROCK.adf', 510], ['/elsewhere/x', 10]]);
  assert.deepEqual(last.tot.data.want, { n: 1, ms: 40, to: 1 }); assert.deepEqual(last.tot.data.bg, { pf: [2, 4, 0] });
  assert.ok(sanitizePerfRecord(JSON.parse(JSON.stringify(last))).ok);
});

test('a port\'s session events: the page\'s state and storage, 20 at most, the end once', () => {
  const sent = [];
  let state = 'loading';
  const e = portEvents({ port: 're3', state: () => state, storage: { state: null }, bench: 'b1', send: (b) => sent.push(b) });
  assert.match(e.session, /^[0-9a-f]{16}$/);
  e.report('start', { engine: 'x' }); state = 'running';
  e.end({ frames: null }); e.end({ frames: null });
  assert.deepEqual(sent.map((b) => [b.event, b.port, b.state, b.bench, b.session === e.session]), [['start', 're3', 'loading', 'b1', true], ['end', 're3', 'running', 'b1', true]]);
  assert.equal(sent[0].engine, 'x'); assert.ok(sent[0].env);
  for (let i = 0; i < 30; i++) e.report('error', {});
  assert.equal(sent.length, 20);
});
