// The bench suite (docs/real-machine-bench.md, "The bench suite"): the scenario language's nudge and the ports' steps
// (src/host/scenario.js), the suite's definitions (tools/scenarios/bench/index.json), the frames of a port's page
// measured from outside it (src/host/web/page-meter.js), the scripted DOM input (dom-input.js), the virtual keys as DOM
// keys (src/win32/vk-scan.js), the suite's addresses and records (bench-suite.js), and its report
// (tools/telemetry-report.mjs --suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseScenario, unsupportedSteps, ScenarioPlayer, PLAYER_KINDS, PORT_KINDS } from '../src/host/scenario.js';
import { PageMeter, benchHooks } from '../src/host/web/page-meter.js';
import { domInput, TYPE_GAP_MS } from '../src/host/web/dom-input.js';
import { domKeyOfVk, vkOfCode } from '../src/win32/vk-scan.js';
import { PerfWindow, compactPhase } from '../src/host/perf-summary.js';
import { buildSessions, report, suiteRuns, formatSuites } from '../tools/telemetry-report.mjs';

// (bench-suite.js and bench.js read the page's language at load: a page's globals for Node)
globalThis.location ??= new URL('http://127.0.0.1:8080/?benchsuite=all');
const { loadSuite, itemUrl, compactResult, suiteRecord, lostRecord, suiteMinutes } = await import('../src/host/web/bench-suite.js');
const BENCH = new URL('../tools/scenarios/bench/', import.meta.url);
const index = JSON.parse(fs.readFileSync(new URL('index.json', BENCH), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

test('nudge: its key pressed every N s while the next wait holds, none once the wait is satisfied', () => {
  const { steps, errors } = parseScenario('0:mark:menu\n2:nudge:32,3\n2:waitframe:80,100000\n0:mark:city\n5:key:13\n6:waitfps:1000');
  assert.deepEqual(errors, []);
  // (frames from the start: 10 draws a frame until 20 s, then 100)
  let frames = 0, draws = 0;
  const acts = play(new ScenarioPlayer(steps), (t) => { frames += 30; draws += 30 * (t < 20 ? 10 : 100); return { fps: 60, d3d: { frames, draws } }; }, 40);
  const nudges = acts.filter((a) => a.kind === 'key' && a.args[0] === 32).map((a) => a.t);
  const anchor = acts.find((a) => a.kind === 'waitframe').t;
  assert.ok(anchor > 20 && anchor < 24, `anchor ${anchor}`);
  assert.equal(nudges[0], 2); // (at once: the wait holds from the start)
  for (let i = 1; i < nudges.length; i++) assert.ok(Math.abs(nudges[i] - nudges[i - 1] - 3) < 0.11, `every 3 s: ${nudges}`);
  assert.ok(nudges.every((t) => t < anchor) && nudges.length >= 6, `${nudges} before ${anchor}`);
  assert.ok(acts.some((a) => a.kind === 'key' && a.args[0] === 13 && Math.abs(a.t - anchor - 5) < 0.11), 'the steps after the wait still run');
  // (a nudge needs a key and a period)
  assert.ok(parseScenario('0:nudge:32').errors.length && parseScenario('0:nudge:32,0').errors.length);
});

test('the ports\' steps: cmd takes a string, look and glide numbers; only a port plays them', () => {
  const { steps, errors } = parseScenario('1:cmd:map de_dust2\n2:look:40,-10,4,200\n3:glide:-12288,-69632,0,300,5000\n4:glide');
  assert.deepEqual(errors, []);
  assert.deepEqual(steps.map((s) => s.args), [['map de_dust2'], [40, -10, 4, 200], [-12288, -69632, 0, 300, 5000], []]);
  assert.equal(unsupportedSteps(steps).length, 4); // (the Win32 page's player: not its steps)
  assert.deepEqual(unsupportedSteps(steps, PORT_KINDS), []);
  assert.ok(parseScenario('1:glide:1,2,3').errors.length && parseScenario('1:look:5').errors.length);
  for (const k of PLAYER_KINDS) assert.ok(PORT_KINDS.has(k), k);
});

test('suite definitions: every bench of a suite exists, plays its version, ports name their runtime; all seven games', () => {
  const names = new Map(index.benches.map((b) => [b.name, b]));
  const all = index.suites.find((s) => s.name === 'all');
  assert.ok(all, 'the "all" suite');
  assert.deepEqual(all.benches.map((b) => b.bench), ['bfme1-108-short', 'bfme2-short', 'rotwk-short', 'revc-drive', 'morrowind-glide', 'halflife-c1a0', 'cs-bots']);
  for (const s of index.suites) for (const it of s.benches) {
    const b = names.get(it.bench); assert.ok(b, it.bench);
    assert.ok(!it.manifest || b.manifests.includes(it.manifest), `${it.bench}: ${it.manifest}`);
  }
  for (const b of index.benches.filter((x) => x.runtime && x.runtime !== 'win32')) {
    assert.ok(['re3', 'goldsrc', 'openmw'].includes(b.runtime), b.name);
    const { steps, errors } = parseScenario(fs.readFileSync(new URL(b.file, BENCH), 'utf8'));
    assert.deepEqual(errors, [], b.name); assert.deepEqual(unsupportedSteps(steps, PORT_KINDS), [], b.name);
    const marks = steps.filter((s) => s.kind === 'mark').map((s) => s.args[0]);
    assert.equal(marks.at(-1), 'end', b.name);
    assert.ok(steps.some((s) => s.kind.startsWith('wait')), `${b.name}: waits for its game`);
  }
  // (the suite's games: ~60-75 s measured each once in the game — the time from the first mark after the last wait to the end)
  for (const it of all.benches) {
    const b = names.get(it.bench), steps = parseScenario(fs.readFileSync(new URL(b.file, BENCH), 'utf8')).steps;
    const last = steps.filter((s) => s.anchored && s.kind === 'mark');
    const end = last.find((s) => s.args[0] === 'end');
    assert.ok(end && end.t >= 40 && end.t <= 100, `${b.name}: measured ${end?.t} s after its last wait`);
    assert.ok(b.maxSeconds >= 300, `${b.name}: room for a first launch`);
  }
});

test('the short Win32 benches keep their longer bench\'s menu steps', () => {
  const src = (f) => parseScenario(fs.readFileSync(new URL(f, BENCH), 'utf8')).steps.map((s) => s.src);
  const head = (f) => { const s = src(f); return s.slice(0, s.indexOf('0:mark:play')); };
  assert.deepEqual(head('bfme1-108-short.txt'), head('bfme1-108-quick.txt'));
  assert.deepEqual(head('bfme2-short.txt'), head('bfme2-quick.txt'));
  assert.deepEqual(head('rotwk-short.txt'), head('rotwk-quick.txt'));
});

/** A port's window, enough for the meter: WebGL prototypes, frames driven by hand, a canvas, hooks. */
function fakeWindow() {
  let now = 0;
  const cbs = [];
  class WebGL2RenderingContext { constructor() { this.enabled = new Set(); this.ext = null; } drawArrays() {} drawElements() {} enable(c) { this.enabled.add(c); } disable(c) { this.enabled.delete(c); } getExtension(n) { return n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 1 } : null; } getParameter(k) { return k === 1 ? 'Test GPU' : null; } isContextLost() { return false; } }
  const W = {
    WebGL2RenderingContext, performance: { now: () => now },
    requestAnimationFrame: (cb) => { cbs.push(cb); return cbs.length; },
    setInterval: () => 1, clearInterval: () => {},
    orthrosBenchHooks: null,
    /** One browser frame at time t: the callbacks asked for before it, each with t. */
    frame(t, during) { now = t; const run = cbs.splice(0); for (const cb of run) cb(t); during?.(); },
    set now(v) { now = v; }, get now() { return now; },
  };
  return W;
}

test('page meter: a frame is a browser frame the engine drew in; its work, its data waits, the phase report', () => {
  const W = fakeWindow();
  let waited = 0;
  W.orthrosBenchHooks = { data: () => ({ waits: 1, waitMs: waited, bytes: 10 }) };
  const m = new PageMeter(W); m.install();
  const gl = new W.WebGL2RenderingContext();
  // (the engine's loop: in each frame it asks for the next one after 10 ms of work and draws 5 times; every 4th
  // browser frame it skips — no draw: not a frame; at frame 20 it waited 30 ms for its data)
  const engine = (t) => { W.requestAnimationFrame(engine); };
  W.requestAnimationFrame(engine);
  let t = 0;
  for (let i = 0; i < 120; i++) {
    t += 1000 / 60;
    W.frame(t, () => {
      if (i % 4 === 3) return;
      if (i === 20) waited += 30;
      for (let k = 0; k < 5; k++) gl.drawArrays();
      W.now = t + 10; W.requestAnimationFrame(() => {}); // (its request for the next frame, at the end of its work)
    });
  }
  assert.equal(m.renderer, 'Test GPU');
  assert.ok(m.frames >= 89 && m.frames <= 91, `frames ${m.frames}`);
  assert.equal(m.draws, 450);
  const fr = m.frames;
  const first = m.emit();
  for (let i = 0; i < 6; i++) { t += 1000 / 60; W.frame(t, () => { for (let k = 0; k < 5; k++) gl.drawArrays(); }); }
  const s = m.emit();
  assert.equal(s.d3d.frames, m.frames); assert.equal(s.d3d.draws, m.framesDraws);
  assert.equal(s.d3d.gpu.state, 'unavailable'); // (a context without TIME_ELAPSED queries)
  assert.deepEqual(s.data, { waits: 1, waitMs: 30, bytes: 10 });
  assert.equal(s.d3d.frames - first.d3d.frames, 5); // (a frame counted at the next browser frame: the last one still to come)
  const ph = compactPhase(m.phase('play'));
  assert.equal(ph.label, 'start');
  // (shown frames: 3 of 4 browser frames — gaps of 16.7 ms and every third one 33.3 ms)
  assert.ok(Math.abs(ph.dt.p50 - 16.7) < 0.2 && Math.abs(ph.dt.max - 33) <= 1, JSON.stringify(ph.dt));
  assert.ok(Math.abs(ph.work.p50 - 10) < 0.2, `work ${JSON.stringify(ph.work)}`); // (10 ms each, the 30 ms wait within the frame's work)
  assert.equal(ph.slow40, 0);
  assert.ok(ph.mean.ioWait > 0, JSON.stringify(ph.mean));
  // (the stats message feeds the summaries as the Win32 worker's does)
  const w = new PerfWindow(); w.add(first); w.add(s); const sum = w.take();
  assert.ok(sum.frames > 0 && sum.drawsPerFrame === 5, JSON.stringify(sum));
});

test('page meter: a port\'s own count of its engine\'s work (hooks.workMs) wins over the animation frames\' measure', () => {
  const W = fakeWindow();
  let work = 0;
  W.orthrosBenchHooks = { workMs: () => work };
  const m = new PageMeter(W); m.install();
  const gl = new W.WebGL2RenderingContext();
  const engine = () => { W.requestAnimationFrame(engine); };
  W.requestAnimationFrame(engine);
  let t = 0;
  for (let i = 0; i < 40; i++) { t += 1000 / 60; W.frame(t, () => { gl.drawArrays(); work += 7; W.now = t + 12; W.requestAnimationFrame(() => {}); }); }
  const ph = compactPhase(m.phase('x'));
  assert.ok(Math.abs(ph.work.p50 - 7) < 0.2, JSON.stringify(ph.work));
});

test('page meter: rasterizer discarded on the engine\'s context, its disable ignored; installed once a window', () => {
  const W = fakeWindow();
  const m = new PageMeter(W, { discard: true }); assert.equal(m.install(), true);
  assert.equal(new PageMeter(W).install(), false); // (a second meter: the first one stays)
  const gl = new W.WebGL2RenderingContext();
  gl.drawArrays();
  assert.ok(gl.enabled.has(0x8C89));
  gl.disable(0x8C89); assert.ok(gl.enabled.has(0x8C89));
  gl.enable(0x0B71); gl.disable(0x0B71); assert.ok(!gl.enabled.has(0x0B71));
});

test('bench hooks: a page\'s own, else its portSession\'s command and data reads', () => {
  const said = [];
  const W = { portSession: { command: (c) => said.push(c), files: { stats: { waits: 3, waitMs: 120, fetchedBytes: 9 } } } };
  const h = benchHooks(W);
  h.command('map c1a0'); assert.deepEqual(said, ['map c1a0']);
  assert.deepEqual(h.data(), { waits: 3, waitMs: 120, bytes: 9 });
  assert.equal(benchHooks(W), h); // (made once per session)
  const own = { teleport() {} }; W.orthrosBenchHooks = own; assert.equal(benchHooks(W), own);
  assert.equal(benchHooks(null), null);
});

test('virtual keys as DOM keys, and back', () => {
  for (const vk of [0x0d, 0x1b, 0x20, 0x25, 0x26, 0x27, 0x28, 0x30, 0x39, 0x41, 0x57, 0x5a, 0x70, 0x7b, 0x60, 0xa0, 0xa2]) {
    const k = domKeyOfVk(vk); assert.ok(k, vk.toString(16));
    assert.equal(vkOfCode(k.code), vk, `${vk.toString(16)} ${k.code}`);
  }
  assert.deepEqual(domKeyOfVk(0x57), { code: 'KeyW', key: 'w', keyCode: 0x57 });
  assert.deepEqual(domKeyOfVk(0x10), { code: 'ShiftLeft', key: 'Shift', keyCode: 0x10 });
  assert.equal(domKeyOfVk(0xa2).keyCode, 0x11); // (either Control: VK_CONTROL, as browsers report it)
  assert.equal(domKeyOfVk(0x0d).key, 'Enter'); assert.equal(domKeyOfVk(0x20).key, ' ');
  assert.equal(domKeyOfVk(0xff), null);
});

/** A window that records the events dispatched to its canvas, with the DOM's event constructors' shape. */
function eventWindow() {
  const events = [];
  class Ev { constructor(type, init) { Object.assign(this, init); this.type = type; } }
  const canvas = { getBoundingClientRect: () => ({ left: 10, top: 50 }), dispatchEvent: (e) => { events.push(e); return true; } };
  const W = { KeyboardEvent: Ev, MouseEvent: Ev, PointerEvent: Ev, document: { querySelector: () => canvas, body: canvas }, orthrosBenchHooks: null };
  return { W, events };
}

test('DOM input: keys with their code and keyCode (a keypress for a character), clicks at the canvas\' place, the port\'s console and teleport', async () => {
  const { W, events } = eventWindow();
  const tele = [], cmds = [];
  W.orthrosBenchHooks = { command: (c) => cmds.push(c), teleport: (x, y, z) => tele.push([x, y, z]) };
  const inp = domInput(() => W);
  inp.key(0x57, 0, true); inp.key(0x57, 0, true); inp.key(0x57, 0, false);
  assert.deepEqual(events.map((e) => [e.type, e.code, e.keyCode, !!e.repeat]), [['keydown', 'KeyW', 87, false], ['keypress', 'KeyW', 87, false], ['keydown', 'KeyW', 87, true], ['keypress', 'KeyW', 87, false], ['keyup', 'KeyW', 87, false]]);
  events.length = 0;
  inp.button(1, true, 100, 200); inp.button(1, false, 100, 200);
  const downs = events.filter((e) => e.type === 'mousedown' || e.type === 'mouseup');
  assert.deepEqual(downs.map((e) => [e.type, e.button, e.clientX, e.clientY, e.buttons]), [['mousedown', 2, 110, 250, 2], ['mouseup', 2, 110, 250, 0]]);
  assert.ok(events.some((e) => e.type === 'contextmenu'));
  inp.command('map c1a0'); assert.deepEqual(cmds, ['map c1a0']);
  events.length = 0;
  inp.text('Ab1');
  await sleep(TYPE_GAP_MS * 3 + 200);
  assert.deepEqual(events.filter((e) => e.type === 'keydown').map((e) => e.code), ['KeyA', 'KeyB', 'Digit1']);
  assert.deepEqual(events.filter((e) => e.type === 'keyup').map((e) => e.code), ['KeyA', 'KeyB', 'Digit1']);
  inp.glide([100, 200, 0, 300, 5000]);
  await sleep(150);
  inp.glide([]); const n = tele.length; await sleep(80);
  assert.ok(n >= 2 && tele.length === n, `teleports ${n} then ${tele.length}`);
  assert.ok(tele.every(([x, , z]) => x === 100 && z === 5000) && tele.at(-1)[1] > 200, JSON.stringify(tele.at(-1)));
  inp.key(0x41, 0, true); events.length = 0; inp.release();
  assert.deepEqual(events.map((e) => e.type), ['keyup']);
});

const fetcher = async (u) => {
  const f = new URL(String(u).replace('/tools/scenarios/bench/', ''), BENCH);
  return { ok: fs.existsSync(f), status: 404, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')), text: async () => fs.readFileSync(f, 'utf8') };
};

test('suite: loaded by name or as a list of benches; the games\' addresses', async () => {
  const all = await loadSuite('all', { fetcher });
  assert.equal(all.items.length, 7);
  assert.equal(all.items[0].def.manifest, 'bfme1-108'); assert.equal(all.items[4].def.manifest, 'morrowind-goty-vanilla-plus-fr');
  assert.ok(suiteMinutes(all) >= 12 && suiteMinutes(all) <= 20, `${suiteMinutes(all)} minutes`);
  const two = await loadSuite('halflife-c1a0,cs-bots', { fetcher });
  assert.deepEqual(two.items.map((i) => i.def.name), ['halflife-c1a0', 'cs-bots']);
  const fr = await loadSuite('bfme1-108-short', { fetcher, gameLang: 'fr', manifest: 'bfme1-108' });
  assert.equal(fr.items[0].gameLang, 'fr'); assert.equal(fr.items[0].def.manifest, 'bfme1-108');
  await assert.rejects(loadSuite('bfme1-108-short', { fetcher, manifest: 'bfme2' })); // (a version the bench does not play)
  await assert.rejects(loadSuite('nothing', { fetcher }));
  await assert.rejects(loadSuite('halflife-c1a0,nothing', { fetcher }));
  const run = { run: 'r1', name: 'all', index: 1, of: 7 }, pass = new URLSearchParams('gldiscard=1&lang=fr&dbg=X=1');
  const w = new URL(itemUrl(all.items[0], run, { origin: 'https://o.example', pass }));
  assert.equal(w.pathname, '/');
  assert.deepEqual(Object.fromEntries(w.searchParams), { bench: 'bfme1-108-short', manifest: 'bfme1-108', benchauto: '1', gldiscard: '1', dbg: 'X=1', benchrun: 'r1', benchsuitename: 'all', benchindex: '1', benchof: '7', gameLang: 'fr' });
  // (a cold-start suite, ?benchsuite=...&snapshot=0: each game's page starts without a snapshot, main.js snapshotsOn)
  assert.equal(new URL(itemUrl(all.items[0], run, { origin: 'https://o.example', pass: new URLSearchParams('snapshot=0') })).searchParams.get('snapshot'), '0');
  const mw = all.items[4], launch = { launchUrl: '/ports/openmw/morrowind-goty-vanilla-plus-fr/', languageLaunchUrls: { en: '/ports/openmw/morrowind-goty-vanilla-plus-en/' } };
  const p = new URL(itemUrl(mw, { ...run, index: 5 }, { origin: 'https://o.example', launch, pass }));
  assert.equal(p.pathname, '/ports/openmw/morrowind-goty-vanilla-plus-fr/app/index.html');
  assert.equal(p.searchParams.get('start'), '-2,-9'); assert.equal(p.searchParams.get('src'), 'hosted'); assert.ok(p.searchParams.has('novid'));
  assert.equal(p.searchParams.get('benchrun'), 'r1'); assert.equal(p.searchParams.get('gldiscard'), '1');
  const hl = new URL(itemUrl(all.items[5], run, { origin: 'https://o.example', launch: { launchUrl: '/ports/goldsrc/half-life-original-en/' } }));
  assert.equal(hl.pathname, '/ports/goldsrc/half-life-original-en/');
  assert.throws(() => itemUrl(all.items[5], run, { origin: 'https://o.example', launch: null }));
});

/** A game's bench record as BenchRun makes it. */
const record = (bench, manifest, runtime, outcome, run, index, fps = 30) => ({
  event: 'bench', bench, title: bench, runtime, manifest, outcome, detail: outcome === 'done' ? null : 'why', seconds: 90, renderer: 'ANGLE (Intel, Iris Xe)', suite: { run, name: 'all', index, of: 3 },
  marks: [{ label: 'play', at: 10 }, { label: 'end', at: 70 }],
  phases: [{ label: 'start', seconds: 10, fps: 20 }, { label: 'play', seconds: 60, frames: 60 * fps, fps, dt: { p50: 33.3, p90: 35, p99: 41, max: 90 }, per40: 3, slow40: 3, work: { p50: 12.3456, p90: 20, p99: 30.04 }, gpu: { state: 'on', frames: 240, p50: 8, p99: 15, mean: 9 }, dataWaitMs: 120, drawsPerFrame: 300 }],
  hostTiming: [{ label: 'start', at: 0, atomicsWait1: { p50: 14.2, p90: 15 }, setTimeout1: { p50: 14.9 }, battery: { charging: true, level: 0.8 } }],
});

test('suite records: a game\'s compact result, the suite\'s record, a lost game', () => {
  const run = { run: 'r2', name: 'all', index: 2, of: 3 };
  const c = compactResult(record('cs-bots', 'counter-strike-rebuilt-en', 'goldsrc', 'done', 'r2', 2));
  assert.deepEqual(c.phases[1], { label: 'play', seconds: 60, fps: 30, dt: { p50: 33.3, p90: 35, p99: 41, max: 90 }, per40: 3, slow40: 3, work: { p50: 12.3, p99: 30 }, gpu: { p50: 8, p99: 15, mean: 9, frames: 240 }, dataWaitMs: 120, drawsPerFrame: 300 });
  assert.deepEqual(c.hostTiming, [{ atomicsWait1: 14.2, setTimeout1: 14.9, battery: { charging: true, level: 0.8 } }]);
  const lost = lostRecord({ def: { name: 'revc-drive', runtime: 're3', manifest: 'vice-city-revc' } }, run, 'no result');
  assert.equal(lost.outcome, 'lost'); assert.deepEqual(lost.suite, run);
  const s = suiteRecord({ name: 'all', title: 'Every game' }, 'r2', [record('a', 'm', 'win32', 'done', 'r2', 1), lost], { gpu: 'X' }, { seconds: 600.4 });
  assert.equal(s.event, 'bench-suite'); assert.equal(s.games, 2); assert.equal(s.done, 1); assert.equal(s.failed, 1); assert.equal(s.seconds, 600);
  assert.ok(JSON.stringify(s).length < 60000);
});

test('report --suite: per run, its games in order — a game known only from the suite\'s record included; --players leaves benches out', () => {
  const at = '2026-10-23T10:00:00.000Z', env = { gpu: 'ANGLE (Intel, Iris Xe)', cores: 8, ua: 'Chrome/154.0.0.0 Windows NT 10.0' };
  const lines = [
    { at, session: 'win32a', game: 'bfme1-108', bench: 'r3', env, samples: [{ t: 1, event: 'bench', ...record('bfme1-108-short', 'bfme1-108', 'win32', 'done', 'r3', 1) }] },
    { at, session: 'r3.3', game: 'counter-strike-rebuilt-en', bench: 'r3', env, samples: [{ t: 2, event: 'bench', ...record('cs-bots', 'counter-strike-rebuilt-en', 'goldsrc', 'timeout', 'r3', 3, 22) }] },
    { at, session: 'r3.0', game: null, bench: 'r3', env, samples: [{ t: 3, ...suiteRecord({ name: 'all', title: 'Every game' }, 'r3', [record('bfme1-108-short', 'bfme1-108', 'win32', 'done', 'r3', 1), record('revc-drive', 'vice-city-revc', 're3', 'done', 'r3', 2), record('cs-bots', 'counter-strike-rebuilt-en', 'goldsrc', 'timeout', 'r3', 3, 22)], env, { seconds: 640 }) }] },
    { at, session: 'player', game: 'bfme1-108', env, samples: [{ t: 1, dt: 0.5, fps: 30 }, ...Array.from({ length: 200 }, (_, i) => ({ t: i, dt: 0.5, fps: 30 }))] },
  ];
  const sessions = buildSessions(lines);
  const runs = suiteRuns(sessions);
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.suite, 'all'); assert.deepEqual(r.games.map((g) => [g.index, g.bench, g.outcome, !!g.fromSuite]), [[1, 'bfme1-108-short', 'done', false], [2, 'revc-drive', 'done', true], [3, 'cs-bots', 'timeout', false]]);
  const text = formatSuites(runs);
  assert.match(text, /suite all run r3 .*2\/3 games done, 640 s/);
  assert.match(text, /3\. cs-bots \(counter-strike-rebuilt-en, goldsrc\): timeout — why/);
  assert.match(text, /play\s+60 s\s+22 fps; frame ms p50 33\.3 p90 35 p99 41; >40 ms 3\/min \(3\); work p50 12\.3 p99 30 ms; GPU p50 8 p99 15 ms; data waits 120 ms/);
  assert.match(text, /from the suite record/);
  assert.equal(suiteRuns(sessions, 'other').length, 0);
  // (the players' sessions alone)
  assert.deepEqual(report(sessions, { players: true, minSeconds: 0 }).map((x) => x.session), ['player']);
  assert.ok(report(sessions, { minSeconds: 0 }).length === 4);
  // (the command line)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-report-'));
  try {
    fs.writeFileSync(path.join(dir, 'telemetry-2026-10-23.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const cli = spawnSync(process.execPath, [new URL('../tools/telemetry-report.mjs', import.meta.url).pathname, dir, '--suite'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /suite all run r3/);
    const one = spawnSync(process.execPath, [new URL('../tools/telemetry-report.mjs', import.meta.url).pathname, dir, '--suite', 'r3', '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(one.stdout).suites[0].games.length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
