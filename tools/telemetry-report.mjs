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
//          [--session <id>] [--game <manifest>] [--bench [<name>]] [--min-seconds 60] [--json]
//   --bench: only the sessions with bench runs (of that bench) and the comparison
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIST_N, histAddSparse, histQuantile } from '../src/core/frame-acct.js';

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
    const r = { session: s.id, game: s.game, first: s.first, machine: machineLine(s.env), env: s.env, version: s.version, options: s.options, render: renderModeOf(s), seconds: Math.round(seconds), slowEvents: s.slow, events: s.events, stretches: [], summaryStretches: summaryStretches(s.summaries), benches };
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
    for (const p of b.phases ?? []) if (!g.phases.includes(p.label)) g.phases.push(p.label);
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
    if (r.summaryStretches.length) L.push('  summaries (every ~20 s), merged per stretch:');
    for (const st of r.summaryStretches) {
      L.push(`  ${st.at ?? '--:--:--'} ${st.kind.padEnd(9)} ${String(st.seconds).padStart(5)} s ${String(st.fps).padStart(5)} fps; frame ms p50 ${st.p50} p90 ${st.p90} p99 ${st.p99} max ${st.max}; >33 ${st.per33}/min >40 ${st.per40} >50 ${st.per50} >100 ${st.per100}; draws/frame ${st.drawsPerFrame ?? '-'}, GL calls/frame ${st.glCallsPerFrame ?? '-'}; GPU ${typeof st.gpu === 'object' && st.gpu ? `${st.gpu.mean} ms/frame p50 ${st.gpu.p50} p99 ${st.gpu.p99} (${st.gpu.frames} frames timed)` : st.gpu ?? '-'}${st.renderWaitMs !== null ? `; render worker waits ${st.renderWaitMs} ms/frame, replay ${st.replayMs}` : ''}${st.visible !== null && st.visible < 0.99 ? `; visible ${Math.round(st.visible * 100)}%` : ''}`);
      if (st.work !== null) L.push(`      work ${st.work} ms/frame: ${st.cats}${st.slowShares ? `; slow frames' time (%): ${st.slowShares}` : ''}`);
    }
    for (const b of r.benches) {
      L.push(`  bench ${b.bench} (${b.manifest}): ${b.outcome}${b.detail ? ` — ${b.detail}` : ''}, ${b.seconds} s, display ${b.display ?? '?'}${b.firstLaunch ? ', first launch' : ''}${b.interrupted && (b.interrupted.hiddenSeconds || b.interrupted.blurs) ? `, INTERRUPTED (hidden ${b.interrupted.hiddenSeconds} s, ${b.interrupted.blurs} focus losses)` : ''}; marks ${(b.marks ?? []).map((m) => `${m.label}@${m.at}s`).join(' ')}`);
      for (const p of b.phases ?? []) {
        L.push(`    ${String(p.label).padEnd(12)} ${String(p.seconds ?? '?').padStart(6)} s ${String(p.fps ?? '?').padStart(5)} fps; frame ms p50 ${p.dt?.p50 ?? '-'} p90 ${p.dt?.p90 ?? '-'} p99 ${p.dt?.p99 ?? '-'} max ${p.dt?.max ?? '-'}; >33 ${p.per33}/min >50 ${p.per50} >100 ${p.per100}; draws/frame ${p.drawsPerFrame ?? '-'}, GL calls/frame ${p.glCalls?.perFrame ?? p.glCalls?.state ?? '-'}; GPU ${p.gpu?.frames ? `p50 ${p.gpu.p50} p99 ${p.gpu.p99} ms` : p.gpu?.state ?? '-'}${p.render ? `; render waits ${p.render.waitMs} ms/frame` : ''}`);
        if (p.mean) L.push(`      mean frame (ms): ${Object.entries(p.mean).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')}${p.excessShares && Object.keys(p.excessShares).length ? `; slow frames' excess (%): ${Object.entries(p.excessShares).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}${p.hitches && Object.keys(p.hitches).length ? `; hitches: ${Object.entries(p.hitches).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
      }
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

function main(args) {
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const valued = new Set(['--from', '--to', '--session', '--game', '--min-seconds']);
  const inputs = []; let benchName;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.has(a)) { i++; continue; }
    // (--bench [name]: a name unless the next argument is a flag or an existing path; without one, every bench)
    if (a === '--bench') { const n = args[i + 1]; if (n && !n.startsWith('--') && !fs.existsSync(n)) { benchName = n; i++; } else benchName = true; continue; }
    if (!a.startsWith('--')) inputs.push(a);
  }
  if (!inputs.length) { console.error('usage: node tools/telemetry-report.mjs <telemetry dir | file.jsonl>... [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--session id] [--game manifest] [--bench [name]] [--min-seconds 60] [--json]'); return 2; }
  const range = { from: opt('from', null), to: opt('to', null) };
  const sessions = buildSessions(readLines(telemetryFiles([...new Set(inputs)], range)), { ...range, session: opt('session', null), game: opt('game', null) });
  const reports = report(sessions, { minSeconds: Number(opt('min-seconds', 60)), bench: benchName });
  const comparison = benchComparison(reports);
  if (args.includes('--json')) console.log(JSON.stringify({ sessions: reports, benches: comparison }, null, 1));
  else console.log(formatReport(reports, comparison));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
