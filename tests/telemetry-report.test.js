// tools/dev/telemetry-report.mjs: sessions from the telemetry batches, date filters, summaries merged per stretch, bench
// runs and their comparison, the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSessions, report, benchComparison, formatReport, summaryStretches, machineLine, telemetryFiles, sampleClasses, summaryClasses, perfSessions, perfReport } from '../tools/dev/telemetry-report.mjs';
import { PerfWindow } from '../src/web/perf-summary.js';
import { FrameStats, N_CATS, C } from '../src/core/frame-acct.js';

const env = { version: 'abc1234', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', gpu: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpuVendor: 'Google Inc. (Intel)', cores: 20, memGB: 8, screen: '1920x1080@1.25', window: '1536x730', coi: true, webgpu: { vendor: 'intel', architecture: 'xe-lpg', device: '', description: '' } };

/** a ~20 s summary as the page builds it, from frames of `dt` ms (and every 10th of `slow` ms) */
function summary(t, dt, slow, draws = 400) {
  const w = new PerfWindow();
  let d3dFrames = 0, drawsN = 0;
  for (let i = 0; i < 41; i++) {
    const fs_ = new FrameStats(100), cats = new Float64Array(N_CATS);
    const n = Math.round(500 / dt);
    for (let k = 0; k < n; k++) { const d = k % 10 === 0 ? slow : dt; cats.fill(0); cats[C.guest] = d * 0.7; cats[C.draw] = d * 0.3; fs_.add(d, cats); }
    d3dFrames += n; drawsN += n * draws;
    w.add({ dt: 0.5, fps: n * 2, busy: 60, mips: 300, acct: fs_.takeInterval(), d3d: { frames: d3dFrames, draws: drawsN, gpu: { state: 'unavailable' }, glCalls: { state: 'on', frames: i * 30, calls: i * 30 * 1800, draws: i * 30 * 400 } }, gl: { gpuWaitMs: i * 10, fenceMs: 0, frameMs: i * 10, replayMs: i * 20, readbackMs: 0 }, render: 'worker' }, { t, visible: true });
  }
  return { t, event: 'summary', ...w.take() };
}

function benchRecord(fps, p99, outcome = 'done') {
  return { t: 1, event: 'bench', bench: 'vicecity-drive', title: 'Vice City', manifest: 'vice-city-1.1-elamigos-2014', version: 'abc1234', outcome, detail: null, seconds: 140, firstLaunch: true, display: '640x480', options: { renderWorker: true, glWorker: '1' },
    marks: [{ label: 'menu', at: 31 }, { label: 'load', at: 35 }, { label: 'play', at: 45 }, { label: 'end', at: 105 }], anchors: [],
    phases: [{ label: 'start', seconds: 31, fps: 50, frames: 1550, dt: { p50: 3, p90: 7, p99: 50, max: 900 }, per33: 120, per50: 70, per100: 19 }, { label: 'play', at: 45, seconds: 60, fps, frames: fps * 60, dt: { p50: 30, p90: 32, p99: p99, max: 120 }, per33: 12, per50: 3, per100: 0.5, gpu: { state: 'unavailable' }, glCalls: { frames: 30, perFrame: 1200 }, drawsPerFrame: 300, mean: { guest: 12, draw: 6 } }],
    interrupted: { hiddenSeconds: 0, blurs: 0 }, env };
}

function batches() {
  const A = 'sessA', B = 'sessB';
  return [
    { at: '2026-10-04T10:00:00.000Z', session: A, game: 'bfme2', env, samples: [{ t: 1, event: 'options', version: 'abc1234', options: { renderWorker: true, glWorker: '1' } }] },
    { at: '2026-10-04T10:01:00.000Z', session: A, game: 'bfme2', samples: Array.from({ length: 200 }, (_, i) => ({ t: 1791100000000 + i * 500, dt: 0.5, fps: 30, draws: 15 * 400, s33: i % 4 === 0 ? 1 : 0, s50: 0, busy: 70, c: { guest: 20, draw: 8 }, w: 28 })) },
    { at: '2026-10-04T10:02:00.000Z', session: A, game: 'bfme2', samples: [summary(1791100020000, 30, 60), summary(1791100040000, 30, 120)] },
    { at: '2026-10-05T09:00:00.000Z', session: B, game: 'vice-city-1.1-elamigos-2014', env: { ...env, cores: 8, gpu: 'SwiftShader' }, samples: [benchRecord(40, 45)] },
    { at: '2026-10-05T09:30:00.000Z', session: 'sessC', game: 'vice-city-1.1-elamigos-2014', env, samples: [benchRecord(60, 25)] },
  ];
}

test('sessions: batches grouped, events sorted out, date and game filters', () => {
  const all = buildSessions(batches());
  assert.deepEqual([...all.keys()], ['sessA', 'sessB', 'sessC']);
  const a = all.get('sessA');
  assert.equal(a.samples.length, 200); assert.equal(a.summaries.length, 2); assert.equal(a.options.renderWorker, true); assert.equal(a.version, 'abc1234');
  assert.equal(all.get('sessB').benches.length, 1);
  assert.deepEqual([...buildSessions(batches(), { from: '2026-10-05' }).keys()], ['sessB', 'sessC']);
  assert.deepEqual([...buildSessions(batches(), { to: '2026-10-04' }).keys()], ['sessA']);
  assert.deepEqual([...buildSessions(batches(), { game: 'bfme2' }).keys()], ['sessA']);
});

test('summaries merged per stretch: percentiles from the merged histograms, rates per minute', () => {
  const s = buildSessions(batches()).get('sessA');
  const [st] = summaryStretches(s.summaries);
  assert.equal(st.kind, 'play'); assert.equal(st.summaries, 2);
  assert.equal(st.p50, 31); // (30 ms frames: the bucket [30, 31))
  assert.ok(st.p99 >= 60 && st.p99 <= 120, `p99 ${st.p99}`);
  assert.equal(st.max, 120);
  assert.equal(st.drawsPerFrame, 400); assert.equal(st.glCallsPerFrame, 1800);
  assert.ok(st.per33 > 0 && st.per100 > 0 && st.per100 < st.per33);
  assert.equal(st.gpu, 'unavailable'); assert.equal(st.render, 'worker'); assert.ok(st.renderWaitMs > 0);
});

test('report and bench comparison', () => {
  const reps = report(buildSessions(batches()), { minSeconds: 60 });
  assert.equal(reps.length, 3);
  assert.match(reps[0].machine, /Iris\(R\) Xe/); assert.match(reps[0].machine, /20 cores/); assert.match(reps[0].machine, /Chrome 141/); assert.match(reps[0].machine, /Windows NT 10.0/);
  assert.equal(reps[0].render, 'worker');
  assert.equal(reps[0].stretches.length, 1); assert.equal(reps[0].stretches[0].per33, 30);
  const cmp = benchComparison(reps);
  assert.equal(cmp.length, 1); assert.equal(cmp[0].runs.length, 2); assert.deepEqual(cmp[0].phases, ['start', 'play']);
  assert.equal(cmp[0].runs[1].phases.play.fps, 60);
  const text = formatReport(reps, cmp);
  assert.match(text, /session sessA bfme2/); assert.match(text, /summaries \(every ~20 s\)/); assert.match(text, /bench vicecity-drive \(vice-city-1.1-elamigos-2014\): done/);
  assert.match(text, /bench vicecity-drive — Vice City: 2 run\(s\)/); assert.match(text, /play: 60 fps p99 25/);
  // --bench: only the sessions with bench runs
  assert.deepEqual(report(buildSessions(batches()), { bench: true }).map((r) => r.session), ['sessB', 'sessC']);
  assert.deepEqual(report(buildSessions(batches()), { bench: 'other' }), []);
  assert.equal(machineLine(null), 'machine unknown');
  // a phase only some runs have keeps the scenario's order
  const extra = benchRecord(50, 30); extra.phases.splice(1, 0, { label: 'loadscreen', seconds: 9, fps: 12, per33: 1 });
  const cmp2 = benchComparison(report(buildSessions([...batches(), { at: '2026-10-05T10:00:00.000Z', session: 'sessD', env, samples: [extra] }]), { bench: true }));
  assert.deepEqual(cmp2[0].phases, ['start', 'loadscreen', 'play']);
});

// (the owner's telemetry, 2026-11-18 audit: the worst minutes were a 24 fps video and frames spanning a hidden tab)
test('windows told apart: a hidden tab and its frame back, a video, a menu are not play — samples, summaries, --perf minutes', () => {
  const T0 = Date.parse('2026-11-18T10:00:00.000Z'), smp = [];
  const put = (n, o) => { for (let i = 0; i < n; i++) smp.push({ t: T0 + 500 * (smp.length + 1), dt: 0.5, busy: 50, mips: 300, s33: 0, s50: 0, max: 34, vis: true, ...o }); };
  put(40, { fps: 30, draws: 15 * 500 }); // play: 500 draws a frame
  put(40, { fps: 24, draws: 12 * 2, s33: 12, max: 42 }); // a video: 2 draws a frame, every frame over 33 ms
  put(40, { fps: 0, draws: 0, vis: false, mips: 30, busy: 20 }); // the tab hidden
  put(1, { fps: 2, draws: 500, s33: 1, s50: 1, max: 20000, wf: [20000, 50, { late: 19950 }] }); // the frame back spans the hidden time
  put(40, { fps: 30, draws: 15 * 500 });
  put(20, { fps: 30, draws: 15 * 20 }); // a 2D menu
  const cls = sampleClasses(smp), count = (k) => cls.filter((c) => c === k).length;
  assert.deepEqual([count('play'), count('loading'), count('hidden'), count('menu')], [80, 40, 41, 20]);
  // (a summary that holds the frame back is set apart though its tab was visible all along)
  assert.deepEqual(summaryClasses([{ t: T0 + 20000, seconds: 20, frames: 600, d3dFrames: 600, drawsPerFrame: 500, visible: 1 }, { t: T0 + 80000, seconds: 20, frames: 590, d3dFrames: 590, drawsPerFrame: 500, visible: 1 }], smp), ['play', 'hidden']);
  const [r] = report(buildSessions([{ at: '2026-11-18T10:01:31.000Z', session: 'sessH', game: 'g', env, samples: smp }]));
  assert.deepEqual(r.windows, { play: 40, loading: 20, hidden: 21, menu: 10 });
  assert.equal(r.play.samples.per33, 0); assert.equal(r.play.samples.worst, null); // (neither the video's frames nor the frame back)
  assert.deepEqual([r.hiddenTab.seconds, r.hiddenTab.times, r.hiddenTab.mipsHidden, r.hiddenTab.mipsBefore], [20, 1, 30, 300]);
  // the passive record of the same session: its minutes classed by the samples; without them the video's is play
  const m = (t, s, n, p, f40, o = {}) => ({ t, ph: 'running', s, hid: 0, n, fps: Math.round(n / s), p50: p, p90: p, p99: p, max: p, f40, f100: 0, ...o });
  const rec = { at: new Date(T0 + 91000).toISOString(), event: 'perf', v: 1, session: 'sessH', game: 'g', runtime: 'win32', seq: 0, final: true, len: 91, vis: 70.5, hid: 20, env,
    mins: [m(0, 20, 600, 34, 0), m(20, 20, 480, 42, 480), m(40, 0.5, 1, 20000, 1, { hid: 20, f100: 1 }), m(61, 20, 600, 34, 0), m(81, 10, 300, 34, 0)],
    tot: { s: 70.5, n: 1981, fps: 28, p50: 34, p90: 42, p99: 42, max: 20000, f40: 481, f100: 1 } };
  const [g] = perfReport(perfSessions([rec]), { samples: new Map([['sessH', smp]]) });
  assert.deepEqual(g.worst.map((w) => w.t), [0, 61]); assert.equal(g.merged.max, 34); assert.equal(g.minutes, 0.7);
  assert.deepEqual(g.apart, { loading: 0.3, hidden: 0.3, menu: 0.2 });
  // (no summary: the play percentiles only bounded, never rebuilt from the minutes' percentiles — those came out ×1.5-7)
  assert.deepEqual([g.perSession[0].pct, g.perSession[0].p99, g.perSession[0].bound.p99], ['bound', null, 34]);
  assert.equal(perfReport(perfSessions([rec]))[0].worst[0].t, 20);
});

test('command line: a directory, a date range, --bench, --json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-telemetry-'));
  try {
    const b = batches();
    fs.writeFileSync(path.join(dir, 'telemetry-2026-10-04.jsonl'), b.slice(0, 3).map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'telemetry-2026-10-05.jsonl'), b.slice(3).map((x) => JSON.stringify(x)).join('\n') + '\n{torn');
    assert.deepEqual(telemetryFiles([dir], { from: '2026-10-05' }).map((f) => path.basename(f)), ['telemetry-2026-10-05.jsonl']);
    const tool = new URL('../tools/dev/telemetry-report.mjs', import.meta.url).pathname;
    const run = (...a) => spawnSync(process.execPath, [tool, ...a], { encoding: 'utf8' });
    const all = run(dir);
    assert.equal(all.status, 0, all.stderr); assert.match(all.stdout, /session sessA/); assert.match(all.stdout, /session sessC/);
    const later = run(dir, '--from', '2026-10-05');
    assert.doesNotMatch(later.stdout, /session sessA/); assert.match(later.stdout, /2 run\(s\)/);
    const j = JSON.parse(run('--bench', dir, '--json').stdout);
    assert.deepEqual(j.sessions.map((s) => s.session), ['sessB', 'sessC']); assert.equal(j.benches[0].runs.length, 2);
    const named = JSON.parse(run(dir, '--bench', 'vicecity-drive', '--json').stdout);
    assert.equal(named.sessions.length, 2);
    assert.equal(run().status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compatibility gaps: bounded summary from the worker, the latest per session, merged per game (--compat)', async () => {
  const { compatSummary, MAX } = await import('../src/core/compat-stats.js');
  const { compatByGame, compatLines } = await import('../tools/dev/telemetry-report.mjs');
  const imports = new Map([['dsound.dll!Unused', { calls: 0 }]]);
  for (let i = 0; i < MAX + 5; i++) imports.set(`kernel32.dll!F${i}`, { calls: i + 1 });
  const c = compatSummary({ unknownImports: imports, notImpl: new Map([['IDirectDraw7::GetDeviceIdentifier', 3]]), shaderOps: { 'ps9 texm3x2depth': 2 } });
  assert.equal(c.imports.length, MAX); assert.equal(c.more.imports, 5); // (bounded; never-called imports left out)
  assert.deepEqual(c.imports[0], [`kernel32.dll!F${MAX + 4}`, MAX + 5]);
  assert.equal(compatSummary({ unknownImports: new Map([['a!b', { calls: 0 }]]) }), null);
  const lines = [
    { session: 's1', game: 'g', samples: [{ t: 1, event: 'compat', ...compatSummary({ notImpl: new Map([['IA::M', 1]]) }) }, { t: 2, event: 'compat', ...c }] },
    { session: 's2', game: 'g', samples: [{ t: 1, event: 'compat', ...compatSummary({ notImpl: new Map([['IDirectDraw7::GetDeviceIdentifier', 1]]) }) }] },
    { session: 's3', game: 'g', samples: [{ t: 1, dt: 0.5, fps: 30 }] },
  ];
  const sessions = buildSessions(lines);
  assert.equal(sessions.get('s1').compat.shaderOps.length, 1); // (the latest summary of a session wins)
  const [g] = compatByGame(sessions);
  assert.equal(g.sessions, 3); assert.equal(g.withGaps, 2);
  assert.deepEqual(g.kinds.notImpl[0], { name: 'IDirectDraw7::GetDeviceIdentifier', sessions: 2, count: 4 });
  assert.ok(compatLines(sessions.get('s1').compat).some((l) => l.includes('+5 more')));
});
