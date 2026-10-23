// Report of the server's telemetry (src/host/server.js --telemetry: <dir>/telemetry-<date>.jsonl, one batch per line):
// per session, the machine (browser, GPU, cores, memory, screen), the game / version, the build and the options it ran
// with (render mode actually used), then
// - per stretch of play (consecutive ~0.5 s samples of one kind: a 3D scene — many draws per frame — or not) the
//   frames > 33 / > 50 ms per minute, the mean work per frame and the time by category (docs/frame-accounting.md);
// - the ~20 s summaries (frame-time percentiles, frames > 33 / 40 / 50 / 100 ms, draws and GL calls per frame, GPU
//   time per frame when the browser measures it, render worker waits) merged per stretch, with the slow frames'
//   categories;
// - the bench runs (?bench=<name>, docs/real-machine-bench.md): per phase results;
// and a comparison of the bench runs, per bench: one line per run, its phases side by side.
// Usage: node tools/telemetry-report.mjs <telemetry dir | .jsonl file>... [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//          [--session <id>] [--game <manifest>] [--bench [<name>]] [--perf [--gpu <name>]] [--min-seconds 60] [--json]
//   --bench: only the sessions with bench runs (of that bench) and the comparison
//   --perf [--gpu <part of its name>]: the passive session records (every runtime, src/host/perf-record.js) per game ×
//          GPU: medians over the sessions, all frames merged, the worst minutes, the slow frames' causes, host timing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIST_N, histAddSparse, histQuantile } from '../src/core/frame-acct.js';
import { audioVerdict, audioText } from '../src/host/web/sound.js';
import { probeLine } from '../src/host/web/timing-probe.js';

const FILE_DATE = /telemetry-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** The .jsonl files of the arguments (directories expanded), those of dates outside [from, to] left out. */
export function telemetryFiles(inputs, { from = null, to = null } = {}) {
  const files = [];
  for (const a of inputs) {
    const list = fs.statSync(a).isDirectory() ? fs.readdirSync(a).sort().filter((f) => f.endsWith('.jsonl')).map((f) => path.join(a, f)) : [a];
    for (const f of list) {
      const d = FILE_DATE.exec(f)?.[1];
      if (d && ((from && d < from) || (to && d > to))) continue;
      files.push(f);
    }
  }
  return files;
}

/**
 * Sessions from batches (the parsed lines). `at` (the server's receipt time) filters by date when from / to are
 * given (YYYY-MM-DD, inclusive).
 */
export function buildSessions(lines, { from = null, to = null, session = null, game = null } = {}) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  for (const r of lines) {
    if (!r?.session || (session && r.session !== session)) continue;
    const day = typeof r.at === 'string' ? r.at.slice(0, 10) : null;
    if (day && ((from && day < from) || (to && day > to))) continue;
    let s = sessions.get(r.session);
    if (!s) sessions.set(r.session, (s = { id: r.session, game: r.game ?? null, first: r.at ?? null, last: r.at ?? null, env: null, options: null, version: null, samples: [], summaries: [], benches: [], slow: 0, events: {} }));
    if (r.game) s.game = r.game;
    if (r.at) { if (!s.first || r.at < s.first) s.first = r.at; if (!s.last || r.at > s.last) s.last = r.at; }
    if (r.env) { s.env = r.env; s.version ??= r.env.version ?? null; }
    for (const x of r.samples ?? []) {
      if (x.event === 'options') { s.options = x.options; s.version = x.version ?? s.version; }
      else if (x.event === 'slow') s.slow++;
      else if (x.event === 'summary') s.summaries.push(x);
      else if (x.event === 'bench') s.benches.push(x);
      else if (x.event) s.events[x.event] = (s.events[x.event] ?? 0) + 1;
      else if (x.dt) s.samples.push(x);
    }
  }
  for (const s of sessions.values()) if (game && s.game !== game) sessions.delete(s.id);
  return sessions;
}

export function readLines(files) {
  const out = [];
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* a torn line */ } }
  return out;
}

const add = (into, o, k = 1) => { for (const [n, v] of Object.entries(o ?? {})) into[n] = (into[n] ?? 0) + v * k; };
const fmt = (o, scale = 1, min = 0.3) => Object.entries(o).map(([k, v]) => [k, v * scale]).filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
const kindOf = (frames, draws) => (frames > 0 && draws / frames >= 50 ? '3D' : frames > 0 ? 'other' : 'no frames');

/** Consecutive samples of one kind (3D scene or not, by draws per frame) as stretches. */
export function stretches(samples) {
  const out = []; let cur = null;
  for (const x of samples) {
    const frames = (x.fps ?? 0) * x.dt, kind = kindOf(frames, x.draws ?? 0);
    if (!cur || cur.kind !== kind) out.push(cur = { kind, t0: x.t, seconds: 0, frames: 0, s33: 0, s50: 0, acctFrames: 0, work: 0, cats: {}, slowCats: {}, worst: null, busy: 0 });
    cur.seconds += x.dt; cur.frames += frames; cur.s33 += x.s33 ?? 0; cur.s50 += x.s50 ?? 0; cur.busy += (x.busy ?? 0) * x.dt;
    if (x.c) { cur.acctFrames += frames; cur.work += (x.w ?? 0) * frames; add(cur.cats, x.c, frames); }
    if (x.sc) add(cur.slowCats, x.sc);
    if (x.wf && (!cur.worst || x.wf[0] > cur.worst[0])) cur.worst = x.wf;
  }
  // (a stretch shorter than 10 s is merged into the previous one — a loading hiccup — then neighbours of one kind)
  const merge = (a, b) => { a.seconds += b.seconds; a.frames += b.frames; a.s33 += b.s33; a.s50 += b.s50; a.busy += b.busy; a.acctFrames += b.acctFrames; a.work += b.work; add(a.cats, b.cats); add(a.slowCats, b.slowCats); if (b.worst && (!a.worst || b.worst[0] > a.worst[0])) a.worst = b.worst; };
  const kept = [];
  for (const st of out) {
    const last = kept[kept.length - 1];
    if (last && (st.seconds < 10 || st.kind === last.kind)) merge(last, st); else kept.push(st);
  }
  return kept;
}

/**
 * The ~20 s summaries merged per stretch (consecutive summaries of one kind, a 3D scene or not): frame-time
 * percentiles from the merged histograms, slow-frame rates, draws / GL calls / GPU time / render waits per frame.
 */
export function summaryStretches(summaries) {
  const out = []; let cur = null;
  for (const x of summaries) {
    const kind = kindOf(x.d3dFrames ?? x.frames ?? 0, (x.drawsPerFrame ?? 0) * (x.d3dFrames ?? 0));
    if (!cur || cur.kind !== kind) out.push(cur = { kind, t0: x.t, n: 0, seconds: 0, frames: 0, s33: 0, s40: 0, s50: 0, s100: 0, max: 0, hist: new Array(HIST_N).fill(0), cats: {}, slowCats: {}, work: 0, d3dFrames: 0, draws: 0, glFrames: 0, glCalls: 0, gpuFrames: 0, gpuMs: 0, gpuHist: new Array(HIST_N).fill(0), gpuState: null, gpuMax: 0, rwWait: 0, rwReplay: 0, rwFrames: 0, render: null, visible: 0 });
    cur.n++; cur.seconds += x.seconds ?? 0; cur.frames += x.frames ?? 0;
    for (const k of ['s33', 's40', 's50', 's100']) cur[k] += x[k] ?? 0;
    if ((x.dt?.max ?? 0) > cur.max) cur.max = x.dt.max;
    histAddSparse(cur.hist, x.h);
    add(cur.cats, x.cats, x.frames ?? 0); add(cur.slowCats, x.slowCats); cur.work += (x.work ?? 0) * (x.frames ?? 0);
    if (x.drawsPerFrame !== null && x.drawsPerFrame !== undefined) { cur.d3dFrames += x.d3dFrames ?? 0; cur.draws += x.drawsPerFrame * (x.d3dFrames ?? 0); }
    if (x.glCalls?.frames) { cur.glFrames += x.glCalls.frames; cur.glCalls += x.glCalls.perFrame * x.glCalls.frames; }
    if (x.gpu?.state) cur.gpuState = cur.gpuState === 'on' ? 'on' : x.gpu.state;
    if (x.gpu?.frames) { cur.gpuFrames += x.gpu.frames; cur.gpuMs += x.gpu.mean * x.gpu.frames; histAddSparse(cur.gpuHist, x.gpu.h); if ((x.gpu.max ?? 0) > cur.gpuMax) cur.gpuMax = x.gpu.max; }
    if (x.render && x.frames) { cur.rwWait += x.render.waitMs * x.frames; cur.rwReplay += x.render.replayMs * x.frames; cur.rwFrames += x.frames; }
    if (x.renderMode) cur.render = x.renderMode;
    cur.visible += (x.visible ?? 1) * (x.seconds ?? 0);
  }
  return out.map((c) => {
    const min = c.seconds / 60, n = c.frames || 1, slowTotal = Object.values(c.slowCats).reduce((a, b) => a + b, 0), hasGpuHist = c.gpuHist.some((v) => v);
    return {
      kind: c.kind, at: c.t0 ? new Date(c.t0).toISOString().slice(11, 19) : null, summaries: c.n, seconds: Math.round(c.seconds), fps: c.seconds ? +(c.frames / c.seconds).toFixed(1) : 0,
      p50: histQuantile(c.hist, 0.5, c.max || Infinity), p90: histQuantile(c.hist, 0.9, c.max || Infinity), p99: histQuantile(c.hist, 0.99, c.max || Infinity), max: c.max,
      per33: min ? +(c.s33 / min).toFixed(1) : 0, per40: min ? +(c.s40 / min).toFixed(1) : 0, per50: min ? +(c.s50 / min).toFixed(1) : 0, per100: min ? +(c.s100 / min).toFixed(1) : 0,
      work: c.frames ? +(c.work / n).toFixed(1) : null, cats: c.frames ? fmt(c.cats, 1 / n) : '', slowShares: slowTotal ? fmt(c.slowCats, 100 / slowTotal, 1) : null,
      drawsPerFrame: c.d3dFrames ? Math.round(c.draws / c.d3dFrames) : null, glCallsPerFrame: c.glFrames ? Math.round(c.glCalls / c.glFrames) : null,
      gpu: c.gpuFrames ? { frames: c.gpuFrames, mean: +(c.gpuMs / c.gpuFrames).toFixed(2), p50: hasGpuHist ? histQuantile(c.gpuHist, 0.5, c.gpuMax || Infinity) : null, p99: hasGpuHist ? histQuantile(c.gpuHist, 0.99, c.gpuMax || Infinity) : null, max: c.gpuMax || null } : c.gpuState,
      renderWaitMs: c.rwFrames ? +(c.rwWait / c.rwFrames).toFixed(2) : null, replayMs: c.rwFrames ? +(c.rwReplay / c.rwFrames).toFixed(2) : null, render: c.render,
      visible: c.seconds ? +(c.visible / c.seconds).toFixed(2) : null,
    };
  });
}

/** A short description of the machine (env of the first batch). */
export function machineLine(env) {
  if (!env) return 'machine unknown';
  const ua = env.ua ?? '', chrome = /Chrome\/(\d+)/.exec(ua)?.[1], os = /Windows NT [\d.]+|Mac OS X [\d_]+|Android [\d.]+|CrOS|Linux/.exec(ua)?.[0];
  const wg = env.webgpu ? (env.webgpu.state ? `WebGPU ${env.webgpu.state}` : `WebGPU ${[env.webgpu.vendor, env.webgpu.architecture, env.webgpu.description].filter(Boolean).join(' ') || 'adapter'}`) : null;
  return [env.gpu ?? 'GPU ?', env.gpuVendor && !String(env.gpu ?? '').includes(env.gpuVendor) ? `(${env.gpuVendor})` : null, env.cores ? `${env.cores} cores` : null, env.memGB ? `${env.memGB} GB` : null,
    env.screen ? `screen ${env.screen}` : null, chrome ? `Chrome ${chrome}` : null, os, env.coi === false ? 'NOT cross-origin isolated' : null, wg].filter(Boolean).join(', ');
}
const renderModeOf = (s) => s.summaries.findLast?.((x) => x.renderMode)?.renderMode ?? (s.options ? (s.options.renderWorker ? 'worker' : `glworker=${s.options.glWorker ?? '?'}`) : null);

/** The report's data: one entry per session kept. */
export function report(sessions, { minSeconds = 60, bench = undefined } = {}) {
  const out = [];
  for (const s of sessions.values()) {
    const seconds = s.samples.reduce((a, x) => a + x.dt, 0) || s.summaries.reduce((a, x) => a + (x.seconds ?? 0), 0);
    const benches = bench === undefined ? s.benches : s.benches.filter((b) => bench === true || b.bench === bench);
    if (bench !== undefined && !benches.length) continue;
    if (seconds < minSeconds && !benches.length) continue;
    const r = { session: s.id, game: s.game, first: s.first, machine: machineLine(s.env), env: s.env, version: s.version, options: s.options, render: renderModeOf(s), seconds: Math.round(seconds), slowEvents: s.slow, events: s.events, stretches: [], summaryStretches: summaryStretches(s.summaries), audio: audioVerdict(s.summaries.map((x) => x.audio)), benches };
    for (const st of stretches(s.samples)) {
      const min = st.seconds / 60, n = st.acctFrames || 1, slowTotal = Object.values(st.slowCats).reduce((a, b) => a + b, 0);
      r.stretches.push({ kind: st.kind, at: new Date(st.t0).toISOString().slice(11, 19), seconds: Math.round(st.seconds), fps: +(st.frames / st.seconds).toFixed(1), busy: Math.round(st.busy / st.seconds), per33: Math.round(st.s33 / min), per50: Math.round(st.s50 / min),
        work: st.acctFrames ? +(st.work / n).toFixed(1) : null, cats: st.acctFrames ? fmt(st.cats, 1 / n) : null, slowShares: slowTotal ? fmt(st.slowCats, 100 / slowTotal, 1) : null, worst: st.worst });
    }
    out.push(r);
  }
  return out;
}

/** Bench runs grouped by bench: per bench, the phases seen and one row per run. */
export function benchComparison(reports) {
  const by = new Map();
  for (const r of reports) for (const b of r.benches) {
    let g = by.get(b.bench); if (!g) by.set(b.bench, (g = { bench: b.bench, title: b.title ?? null, phases: [], runs: [] }));
    // (a phase new to the bench goes after the phase that precedes it in this run: the scenario's order)
    let at = -1;
    for (const p of b.phases ?? []) { const i = g.phases.indexOf(p.label); if (i >= 0) at = i; else g.phases.splice(++at, 0, p.label); }
    g.runs.push({ session: r.session, at: r.first, manifest: b.manifest, machine: machineLine(b.env ?? r.env), cores: (b.env ?? r.env)?.cores ?? null, version: b.version ?? r.version, render: b.options ? (b.options.renderWorker ? 'worker' : `glworker=${b.options.glWorker}`) : r.render, outcome: b.outcome, firstLaunch: !!b.firstLaunch, display: b.display ?? null, interrupted: b.interrupted ?? null,
      marks: b.marks ?? [], phases: Object.fromEntries((b.phases ?? []).map((p) => [p.label, p])) });
  }
  return [...by.values()];
}

const cell = (p) => (p ? `${p.fps} fps p99 ${p.dt?.p99 ?? '?'} >33 ${p.per33}/min${p.gpu?.frames ? ` gpu p99 ${p.gpu.p99}` : ''}` : '-');

/** The text report. */
export function formatReport(reports, comparison) {
  const L = [];
  for (const r of reports) {
    L.push(`session ${r.session} ${r.game ?? '?'} ${r.first ? r.first.slice(0, 16).replace('T', ' ') : ''} ${r.seconds} s${r.version ? `, build ${r.version}` : ''}${r.render ? `, render ${r.render}` : ''}; ${r.slowEvents} slow-frame events${Object.keys(r.events).length ? `; events ${Object.entries(r.events).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
    L.push(`  machine: ${r.machine}`);
    if (r.options) L.push(`  options: ${Object.entries(r.options).filter(([, v]) => v !== '' && v !== false && v !== null).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const st of r.stretches) {
      L.push(`  ${st.at} ${st.kind.padEnd(9)} ${String(st.seconds).padStart(5)} s ${String(st.fps).padStart(5)} fps busy ${st.busy}% >33 ms ${st.per33}/min >50 ms ${st.per50}/min${st.work !== null ? `; work ${st.work} ms/frame: ${st.cats}` : ''}`);
      if (st.slowShares) L.push(`      slow frames' time (%): ${st.slowShares}; worst ${st.worst[0]} ms (work ${st.worst[1]}: ${Object.entries(st.worst[2]).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    }
    if (r.audio && r.audio.verdict !== 'none') L.push(`  ${audioText(r.audio)}`);
    if (r.summaryStretches.length) L.push('  summaries (every ~20 s), merged per stretch:');
    for (const st of r.summaryStretches) {
      L.push(`  ${st.at ?? '--:--:--'} ${st.kind.padEnd(9)} ${String(st.seconds).padStart(5)} s ${String(st.fps).padStart(5)} fps; frame ms p50 ${st.p50} p90 ${st.p90} p99 ${st.p99} max ${st.max}; >33 ${st.per33}/min >40 ${st.per40} >50 ${st.per50} >100 ${st.per100}; draws/frame ${st.drawsPerFrame ?? '-'}, GL calls/frame ${st.glCallsPerFrame ?? '-'}; GPU ${typeof st.gpu === 'object' && st.gpu ? `${st.gpu.mean} ms/frame p50 ${st.gpu.p50} p99 ${st.gpu.p99} (${st.gpu.frames} frames timed)` : st.gpu ?? '-'}${st.renderWaitMs !== null ? `; render worker waits ${st.renderWaitMs} ms/frame, replay ${st.replayMs}` : ''}${st.visible !== null && st.visible < 0.99 ? `; visible ${Math.round(st.visible * 100)}%` : ''}`);
      if (st.work !== null) L.push(`      work ${st.work} ms/frame: ${st.cats}${st.slowShares ? `; slow frames' time (%): ${st.slowShares}` : ''}`);
    }
    for (const b of r.benches) {
      L.push(`  bench ${b.bench} (${b.manifest}): ${b.outcome}${b.detail ? ` — ${b.detail}` : ''}, ${b.seconds} s, display ${b.display ?? '?'}${b.firstLaunch ? ', first launch' : ''}${b.interrupted && (b.interrupted.hiddenSeconds || b.interrupted.blurs) ? `, INTERRUPTED (hidden ${b.interrupted.hiddenSeconds} s, ${b.interrupted.blurs} focus losses)` : ''}; marks ${(b.marks ?? []).map((m) => `${m.label}@${m.at}s`).join(' ')}`);
      if (b.audio) L.push(`    ${audioText(audioVerdict([b.audio]))}`);
      for (const p of b.phases ?? []) {
        L.push(`    ${String(p.label).padEnd(12)} ${String(p.seconds ?? '?').padStart(6)} s ${String(p.fps ?? '?').padStart(5)} fps; frame ms p50 ${p.dt?.p50 ?? '-'} p90 ${p.dt?.p90 ?? '-'} p99 ${p.dt?.p99 ?? '-'} max ${p.dt?.max ?? '-'}; >33 ${p.per33}/min >40 ${p.per40 ?? "-"} >50 ${p.per50} >100 ${p.per100}; draws/frame ${p.drawsPerFrame ?? '-'}, GL calls/frame ${p.glCalls?.perFrame ?? p.glCalls?.state ?? '-'}; GPU ${p.gpu?.frames ? `p50 ${p.gpu.p50} p99 ${p.gpu.p99} ms` : p.gpu?.state ?? '-'}${p.render ? `; render waits ${p.render.waitMs} ms/frame` : ''}`);
        if (p.mean) L.push(`      mean frame (ms): ${Object.entries(p.mean).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')}${p.excessShares && Object.keys(p.excessShares).length ? `; slow frames' excess (%): ${Object.entries(p.excessShares).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}${p.hitches && Object.keys(p.hitches).length ? `; hitches: ${Object.entries(p.hitches).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
      }
      // (the host's wake-ups: core/host-wait.js per phase, the timing probes of timing-probe.js)
      for (const p of b.phases ?? []) if (p.hostWait?.waits) L.push(`    ${String(p.label).padEnd(12)} host waits: late ${p.hostWait.overMean} ms on average (max ${p.hostWait.overMax}), late for the frame ${p.hostWait.lateMsPerFrame ?? '-'} ms/frame, estimate ${p.hostWait.est} ms, timers ${p.hostWait.timerEst} ms, spin ${p.hostWait.spinMsPerFrame} ms/frame${p.hostWait.injected ? `, injected ${p.hostWait.injected} ms timer` : ''}${p.hostWait.adaptive === true ? '' : p.hostWait.adaptive ? ', adaptive switched' : ', adaptive off'}`);
      for (const pr of b.hostTiming ?? []) L.push(`    timer probe ${pr.label}@${pr.at}s: ${probeLine(pr)}`);
    }
  }
  for (const g of comparison) {
    L.push('', `bench ${g.bench}${g.title ? ` — ${g.title}` : ''}: ${g.runs.length} run(s)`);
    for (const run of g.runs) {
      L.push(`  ${(run.at ?? '').slice(0, 16).replace('T', ' ')} ${run.session} ${run.manifest} ${run.outcome}${run.firstLaunch ? ' first-launch' : ''}${run.interrupted && (run.interrupted.hiddenSeconds || run.interrupted.blurs) ? ' INTERRUPTED' : ''} | ${run.machine} | build ${run.version ?? '?'} render ${run.render ?? '?'} display ${run.display ?? '?'}`);
      L.push(`      ${g.phases.map((ph) => `${ph}: ${cell(run.phases[ph])}`).join(' | ')}`);
      const m = run.marks.map((x) => `${x.label}@${x.at}s`).join(' '); if (m) L.push(`      marks ${m}`);
    }
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- --perf: the passive session records (perf-record.js)
/** A short name of the GPU from the WebGL renderer string ("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x…) Direct3D11 …)" -> "Intel Iris Xe Graphics"). */
export function gpuLabel(renderer) {
  let r = String(renderer ?? '').trim();
  if (!r) return 'GPU ?';
  if (/swiftshader/i.test(r)) return 'SwiftShader';
  const angle = /^ANGLE \((.*)\)$/.exec(r);
  if (angle) { const parts = angle[1].split(', '); r = parts.length > 1 ? parts[1] : parts[0]; }
  r = r.replace(/^ANGLE Metal Renderer: /, '').replace(/\((R|TM|tm|r)\)/g, '').replace(/\s*\(0x[0-9a-f]+\)/ig, '')
    .replace(/\s+(Direct3D\d*|D3D\d+|OpenGL|Vulkan|Metal)\b.*$/i, '').replace(/\s+/g, ' ').trim();
  return r || 'GPU ?';
}
const median = (v) => { const a = v.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const per = (count, seconds) => (seconds > 0 ? +(count / (seconds / 60)).toFixed(1) : null);

/** The perf records by session (their entries in order, the latest totals). `gpu`: a part of the GPU's name or renderer. */
export function perfSessions(lines, { from = null, to = null, session = null, game = null, gpu = null } = {}) {
  const by = new Map();
  for (const r of lines) {
    if (r?.event !== 'perf' || !r.session || (session && r.session !== session) || (game && r.game !== game)) continue;
    const day = typeof r.at === 'string' ? r.at.slice(0, 10) : null;
    if (day && ((from && day < from) || (to && day > to))) continue;
    let s = by.get(r.session);
    if (!s) by.set(r.session, (s = { id: r.session, game: r.game ?? null, runtime: r.runtime, first: r.at ?? null, env: null, probe: null, seqs: new Set(), mins: [], tot: null, totSeq: -1, len: 0, vis: 0, hid: 0, final: false, version: null, build: null, tier: null, bench: null }));
    if (s.seqs.has(r.seq)) continue; // (a record sent twice)
    s.seqs.add(r.seq);
    if (r.at && (!s.first || r.at < s.first)) s.first = r.at;
    if (r.env) s.env = r.env; if (r.probe) s.probe = r.probe;
    for (const k of ['version', 'build', 'tier', 'bench']) if (r[k]) s[k] = r[k];
    s.mins.push(...(r.mins ?? []));
    if (r.seq > s.totSeq) { s.totSeq = r.seq; s.tot = r.tot; s.len = r.len ?? s.len; s.vis = r.vis ?? s.vis; s.hid = r.hid ?? s.hid; }
    if (r.final) s.final = true;
  }
  for (const s of by.values()) {
    s.mins.sort((a, b) => a.t - b.t);
    s.gpu = gpuLabel(s.env?.gpu);
    if (gpu && !s.gpu.toLowerCase().includes(gpu.toLowerCase()) && !String(s.env?.gpu ?? '').toLowerCase().includes(gpu.toLowerCase())) by.delete(s.id);
  }
  return by;
}

/** One session's figures from its totals. */
function sessionFigures(s) {
  const t = s.tot ?? {}, sec = t.s ?? s.vis ?? 0;
  return { session: s.id, at: s.first, runtime: s.runtime, tier: s.tier, build: s.build, seconds: Math.round(sec), len: s.len, visible: s.len ? +(s.vis / s.len).toFixed(2) : null, final: s.final,
    fps: t.fps ?? null, p50: t.p50 ?? null, p90: t.p90 ?? null, p99: t.p99 ?? null, max: t.max ?? null, per40: per(t.f40 ?? 0, sec), per100: per(t.f100 ?? 0, sec),
    work: t.work ?? null, wait: t.wait ?? null, gpu: t.gpu?.n ? t.gpu : null, gpuState: t.gpu?.state ?? null, dataMsPerMin: t.data ? per(t.data.ms, sec) : null, dataWaits: t.data?.n ?? null,
    machine: machineLine(s.env), probe: s.probe };
}

/** The sessions grouped per game × GPU: medians over the sessions, the merged frame times, the worst minutes, the slow frames' causes. */
export function perfReport(sessions, { minSeconds = 60 } = {}) {
  const groups = new Map();
  for (const s of sessions.values()) {
    if ((s.tot?.s ?? s.vis ?? 0) < minSeconds) continue;
    const key = `${s.game ?? '?'}\n${s.gpu}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { game: s.game, gpu: s.gpu, runtime: s.runtime, sessions: [], hist: new Array(HIST_N).fill(0), max: 0, minutes: [], slow: {}, seconds: 0 }));
    g.sessions.push(s); g.seconds += s.tot?.s ?? 0;
    if (s.tot?.h) histAddSparse(g.hist, s.tot.h);
    if ((s.tot?.max ?? 0) > g.max) g.max = s.tot.max;
    for (const e of s.mins) { g.minutes.push({ session: s.id, ...e }); add(g.slow, e.slow); }
  }
  return [...groups.values()].map((g) => {
    const f = g.sessions.map(sessionFigures), slowTotal = Object.values(g.slow).reduce((a, b) => a + b, 0);
    const m = (k) => median(f.map((x) => x[k]));
    // (the worst minutes: those with the most frames over 40 ms a minute, then the highest p99; at least 20 s of play)
    const worst = g.minutes.filter((e) => (e.s ?? 0) >= 20 && e.n > 0).map((e) => ({ ...e, per40: per(e.f40 ?? 0, e.s) })).sort((a, b) => (b.per40 - a.per40) || ((b.p99 ?? 0) - (a.p99 ?? 0))).slice(0, 3);
    const probes = f.map((x) => x.probe).filter(Boolean);
    return {
      game: g.game, gpu: g.gpu, runtime: g.runtime, sessions: f.length, minutes: +(g.seconds / 60).toFixed(1),
      median: { fps: m('fps'), p50: m('p50'), p90: m('p90'), p99: m('p99'), per40: m('per40'), per100: m('per100'), work: m('work'), wait: m('wait'), gpuMean: median(f.map((x) => x.gpu?.mean)), gpuP90: median(f.map((x) => x.gpu?.p90)), dataMsPerMin: m('dataMsPerMin'), visible: m('visible') },
      merged: { p50: histQuantile(g.hist, 0.5, g.max || Infinity), p90: histQuantile(g.hist, 0.9, g.max || Infinity), p99: histQuantile(g.hist, 0.99, g.max || Infinity), max: g.max || null },
      gpuStates: [...new Set(f.map((x) => x.gpuState).filter(Boolean))],
      slowShares: slowTotal ? Object.fromEntries(Object.entries(g.slow).map(([k, v]) => [k, Math.round(v / slowTotal * 100)]).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1])) : null,
      worst, probe: probes.length ? { atomicsWait1P50: median(probes.map((p) => p.atomicsWait1?.[0])), setTimeout1P50: median(probes.map((p) => p.setTimeout1?.[0])), onBattery: probes.filter((p) => p.battery && !p.battery.charging).length, n: probes.length } : null,
      perSession: f,
    };
  }).sort((a, b) => String(a.game).localeCompare(String(b.game)) || a.gpu.localeCompare(b.gpu));
}

/** The --perf text. */
export function formatPerf(groups) {
  const L = [];
  const v = (x, unit = '') => (x === null || x === undefined ? '-' : `${x}${unit}`);
  if (!groups.length) L.push('no passive session records (event "perf") in the selection');
  for (const g of groups) {
    const md = g.median;
    L.push(`${g.game ?? '?'} (${g.runtime}) × ${g.gpu}: ${g.sessions} session(s), ${g.minutes} min of visible play`);
    L.push(`  medians over the sessions: ${v(md.fps)} fps; frame ms p50 ${v(md.p50)} p90 ${v(md.p90)} p99 ${v(md.p99)}; >40 ms ${v(md.per40)}/min >100 ms ${v(md.per100)}/min; work ${v(md.work)} wait ${v(md.wait)} ms/frame; GPU ${md.gpuMean !== null ? `${md.gpuMean} ms/frame p90 ${v(md.gpuP90)}` : g.gpuStates.join('/') || '-'}; data waits ${v(md.dataMsPerMin)} ms/min; visible ${md.visible !== null ? Math.round(md.visible * 100) + '%' : '-'}`);
    L.push(`  all frames merged: p50 ${v(g.merged.p50)} p90 ${v(g.merged.p90)} p99 ${v(g.merged.p99)} max ${v(g.merged.max)} ms`);
    if (g.slowShares) L.push(`  slow frames' time by cause (%): ${Object.entries(g.slowShares).map(([k, x]) => `${k} ${x}`).join(', ')}`);
    for (const w of g.worst) L.push(`  worst minute: ${w.session} t=${w.t}s ${w.ph ?? '-'} ${w.fps} fps p99 ${v(w.p99)} >40 ms ${w.per40}/min${w.work !== undefined ? ` work ${w.work} wait ${w.wait}` : ''}${w.gpu?.n ? ` gpu ${w.gpu.mean}` : ''}${w.data?.ms ? ` data ${w.data.ms} ms` : ''}${w.slow ? ` slow: ${Object.entries(w.slow).map(([k, x]) => `${k} ${x}`).join(', ')}` : ''}`);
    if (g.probe) L.push(`  host timing: Atomics.wait(1) late p50 ${v(g.probe.atomicsWait1P50)} ms, setTimeout(1) ${v(g.probe.setTimeout1P50)} ms (median of ${g.probe.n}); ${g.probe.onBattery} on battery`);
    for (const s of g.perSession) L.push(`    ${(s.at ?? '').slice(0, 16).replace('T', ' ')} ${s.session} ${s.seconds} s${s.visible !== null && s.visible < 0.99 ? ` (visible ${Math.round(s.visible * 100)}%)` : ''}${s.final ? '' : ' (no end record)'}: ${v(s.fps)} fps p99 ${v(s.p99)} >40 ${v(s.per40)}/min work ${v(s.work)} gpu ${s.gpu ? s.gpu.mean : v(s.gpuState)}${s.tier ? ` tier ${s.tier}` : ''} | ${s.machine}${s.build ? ` | build ${s.build}` : ''}`);
  }
  return L.join('\n');
}

function main(args) {
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const valued = new Set(['--from', '--to', '--session', '--game', '--gpu', '--min-seconds']);
  const inputs = []; let benchName;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.has(a)) { i++; continue; }
    // (--bench [name]: a name unless the next argument is a flag or an existing path; without one, every bench)
    if (a === '--bench') { const n = args[i + 1]; if (n && !n.startsWith('--') && !fs.existsSync(n)) { benchName = n; i++; } else benchName = true; continue; }
    if (!a.startsWith('--')) inputs.push(a);
  }
  if (!inputs.length) { console.error('usage: node tools/telemetry-report.mjs <telemetry dir | file.jsonl>... [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--session id] [--game manifest] [--bench [name]] [--perf [--gpu name]] [--min-seconds 60] [--json]'); return 2; }
  const range = { from: opt('from', null), to: opt('to', null) };
  if (args.includes('--perf')) {
    const groups = perfReport(perfSessions(readLines(telemetryFiles([...new Set(inputs)], range)), { ...range, session: opt('session', null), game: opt('game', null), gpu: opt('gpu', null) }), { minSeconds: Number(opt('min-seconds', 60)) });
    console.log(args.includes('--json') ? JSON.stringify(groups, null, 1) : formatPerf(groups));
    return 0;
  }
  const sessions = buildSessions(readLines(telemetryFiles([...new Set(inputs)], range)), { ...range, session: opt('session', null), game: opt('game', null) });
  const reports = report(sessions, { minSeconds: Number(opt('min-seconds', 60)), bench: benchName });
  const comparison = benchComparison(reports);
  if (args.includes('--json')) console.log(JSON.stringify({ sessions: reports, benches: comparison }, null, 1));
  else console.log(formatReport(reports, comparison));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
