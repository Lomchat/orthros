// Report of the server's telemetry (src/server/server.js --telemetry: <dir>/telemetry-<date>.jsonl, one batch per line):
// per session, the machine (browser, GPU, cores, memory, screen), the game / version, the build and the options it ran
// with (render mode actually used), then
// - its time by window class (windowClass: visible play, menu, video / loading, hidden tab — the hidden time and the
//   first frame back from it), the visible play's figures only (rates, causes, compiles from the samples; percentiles,
//   GPU, draws from the summaries; any field the report does not know, as its mean), the hidden tab's effect on the
//   guest (MIPS hidden vs visible and just before hiding);
// - per stretch (consecutive ~0.5 s samples of one class) the frames > 33 / > 50 ms per minute, the mean work per
//   frame and the time by category (docs/frame-accounting.md);
// - the ~20 s summaries (frame-time percentiles, frames > 33 / 40 / 50 / 100 ms, draws and GL calls per frame, GPU
//   time per frame when the browser measures it, render worker waits) merged per stretch of one class, with the slow
//   frames' categories;
// - the display pacing (shared/display-pacing.js: the refreshes each frame stayed on the screen, the judder, the frames
//   aligned on the refreshes) per summary stretch, and per game × GPU in --perf;
// - the hidden tab's guest speed by foreground state (hiddenSpeed: visible, hidden kept awake by background-play.js,
//   hidden lowered by the browser);
// - the flicker probe's counters (gfx/flicker-probe.js: `altSame` / `altCmdAba`, the alternating samples whose frames'
//   command signatures were the same / went A-B-A), its logged samples' command patterns, and whether the session sent
//   its flicker capture (read with tools/dev/flicker-capture.mjs); its draw probe's verdict (tools/dev/draw-probe.mjs);
// - the bench runs (?bench=<name>, docs/real-machine-bench.md): per phase results;
// and a comparison of the bench runs, per bench: one line per run, its phases side by side.
// - the bench suite's runs (?benchsuite=, bench-suite.js: every game in a row): per run, each game's outcome and phases
//   (frame time percentiles, frames > 40 ms, work, GPU time, data waits), the renderer, the host's timers.
// Usage: node tools/dev/telemetry-report.mjs <telemetry dir | .jsonl file>... [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//          [--session <id>] [--game <manifest>] [--bench [<name>]] [--suite [<run>]] [--players] [--compat] [--perf [--gpu <name>]]
//          [--min-seconds 60] [--json]
//   --bench: only the sessions with bench runs (of that bench) and the comparison
//   --suite: only the bench suite's runs (that run: its id), per game
//   --players: the sessions of benches (marked by the page: their batches' and passive records' `bench`) left out
//   --compat: per game, over its sessions, the compatibility gaps the sessions met (unknown imports called, COM methods
//          answering E_NOTIMPL, untranslated shader instructions: core/compat-stats.js), by number of sessions
//   --perf [--gpu <part of its name>]: the passive session records (every runtime, src/shared/perf-record.js) per game ×
//          GPU, over their play minutes only (a Windows game's minutes classed by its samples, a port's by its phase;
//          the others' time set apart): medians over the sessions, the play frames merged, the worst play minutes,
//          the slow frames' causes, host timing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIST_N, histAddSparse, histQuantile } from '../../src/core/frame-acct.js';
import { audioVerdict, audioText } from '../../src/web/sound.js';
import { probeLine } from '../../src/web/timing-probe.js';
import { paceMerge, paceText } from '../../src/shared/display-pacing.js';

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
    if (!r?.session || (session && r.session !== session) || r.event === 'perf') continue; // (the passive records: --perf)
    const day = typeof r.at === 'string' ? r.at.slice(0, 10) : null;
    if (day && ((from && day < from) || (to && day > to))) continue;
    let s = sessions.get(r.session);
    if (!s) sessions.set(r.session, (s = { id: r.session, game: r.game ?? null, first: r.at ?? null, last: r.at ?? null, env: null, options: null, version: null, samples: [], summaries: [], benches: [], suites: [], bench: null, slow: 0, events: {}, compat: null, capture: null, drawProbe: null, flickerLogs: [] }));
    if (r.game) s.game = r.game;
    // (the session's flicker capture, gfx/flicker-capture.js: a line of its own — tools/dev/flicker-capture.mjs reads it)
    // (its draw probe, gfx/draw-probe.js: a line of its own too — tools/dev/draw-probe.mjs reads it)
    // (a display report's own probe — trigger `report`, the player's button — kept apart: tools/dev/flicker-report.mjs prints it with its report)
    if (r.event === 'draw-probe') { const d = { at: r.at ?? null, why: r.trigger?.why ?? null, report: r.trigger?.why === 'report' ? r.trigger.id ?? null : null, frames: r.frames?.length ?? 0, odd: r.summary?.odd ?? null, verdict: r.summary?.verdict ?? null, path: r.path ?? null, cut: r.cut ?? [] }; if (d.report !== null) (s.reportProbes ??= []).push(d); else s.drawProbe = d; continue; }
    if (r.event === 'flicker-capture') { s.capture = { at: r.at ?? null, trigger: r.trigger ?? null, small: r.small ?? null, frames: r.frames?.length ?? 0, images: r.images?.length ?? 0, cut: r.cut ?? [], took: r.took ?? null, alt: r.alt?.fields ?? null, renderer: r.gl?.renderer ?? null }; continue; }
    if (r.bench) s.bench = r.bench; // (a bench's session: the page marks its batches — its suite run, or the bench's name)
    if (r.at) { if (!s.first || r.at < s.first) s.first = r.at; if (!s.last || r.at > s.last) s.last = r.at; }
    if (r.env) { s.env = r.env; s.version ??= r.env.version ?? null; }
    for (const x of r.samples ?? []) {
      if (x.event === 'options') { s.options = x.options; s.version = x.version ?? s.version; }
      else if (x.event === 'slow') s.slow++;
      else if (x.event === 'summary') s.summaries.push(x);
      else if (x.event === 'compat') { if (!s.compat || (x.t ?? 0) >= (s.compat.t ?? 0)) s.compat = x; } // (cumulative: the latest)
      else if (x.event === 'bench') s.benches.push({ ...x, at: x.at ?? r.at ?? null, env: x.env ?? r.env ?? null, session: r.session });
      else if (x.event === 'bench-suite') s.suites.push({ ...x, at: r.at ?? null, env: x.env ?? r.env ?? null });
      else if (x.event) {
        s.events[x.event] = (s.events[x.event] ?? 0) + 1;
        // (the probe's logged samples, gfx/flicker-probe.js: their flicker share and the frames' command pattern)
        if (x.event === 'log' && typeof x.msg === 'string' && x.msg.includes('flicker sample:')) s.flickerLogs.push({ t: x.t ?? null, still: Number(/sample: ([\d.]+) %/.exec(x.msg)?.[1] ?? NaN), cmd: /commands (same|aba|differ|unknown)/.exec(x.msg)?.[1] ?? 'unknown' });
      }
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

// ---------------------------------------------------------------- what each window of a session showed
// A session's windows (its ~0.5 s samples, its ~20 s summaries, its passive records' minutes) are told apart before
// any play figure is computed: `hidden` (the tab hidden in it: the browser presents nothing and the game runs at the
// pace it is given; the first frame back spans the hidden time, hundreds of seconds), `loading` (under MIN_FPS frames a
// second, or fewer than MENU_DRAWS draws a frame: a video at its own rate — ~2 draws a frame, 24 fps, every frame over
// 40 ms —, a loading or a still screen), `menu` (fewer than PLAY_DRAWS draws a frame: a 2D screen), `play` (a 3D scene;
// a menu drawn over a 3D backdrop too — the draws cannot tell it). The ports name theirs (`phase`). The play statistics
// are the visible play's only; the other windows are marked and counted apart.
export const PLAY_DRAWS = 50, MENU_DRAWS = 8, MIN_FPS = 1;
export const CLASS_LABEL = { play: 'play', menu: 'menu', loading: 'video/loading', hidden: 'hidden' };
const CLASSES = Object.keys(CLASS_LABEL);
const PHASE_CLASS = { menu: 'menu', choosing: 'menu', loading: 'loading', starting: 'loading' };

/**
 * A window's class from its frames, draws per frame (`dpf`: null when the game draws no Direct3D — then by its frames
 * only), visibility and the runtime's own phase name (the ports: menu / choosing, loading / starting).
 * @param {{ seconds: number, frames: number, dpf?: number|null, hidden?: boolean, phase?: string|null }} w
 */
export function windowClass({ seconds, frames, dpf = null, hidden = false, phase = null }) {
  if (hidden) return 'hidden';
  if (phase && PHASE_CLASS[phase]) return PHASE_CLASS[phase];
  if (!(seconds > 0) || frames / seconds < MIN_FPS) return 'loading';
  if (dpf === null || dpf === undefined) return 'play';
  return dpf < MENU_DRAWS ? 'loading' : dpf < PLAY_DRAWS ? 'menu' : 'play';
}

/**
 * Each sample's class: `hidden` while the page was hidden (`vis` false) and after it up to the first frame shown (the
 * one that spans the hidden time); the others by their frames and draws (a session without a Direct3D draw — a GDI or
 * DirectDraw game —: by frames only).
 */
export function sampleClasses(samples) {
  const d3d = samples.some((x) => (x.draws ?? 0) > 0);
  let back = false;
  return samples.map((x) => {
    const frames = (x.fps ?? 0) * x.dt;
    if (x.vis === false) { back = true; return 'hidden'; }
    if (back) { if (frames > 0) back = false; return 'hidden'; }
    return windowClass({ seconds: x.dt, frames, dpf: d3d && frames > 0 ? (x.draws ?? 0) / frames : null });
  });
}

/** the first index of sorted `a` whose value is >= v */
const lowerBound = (a, v) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; };
/** The samples' classes by time ([t, class], t sorted) and a query of a time range's: hidden if any is, else the longest. */
function classTimeline(samples, classes) {
  const idx = samples.map((x, i) => i).filter((i) => Number.isFinite(samples[i].t)).sort((a, b) => samples[a].t - samples[b].t);
  const ts = idx.map((i) => samples[i].t);
  return {
    /** the class of the samples in (a, b] (ms), null when none */
    of(a, b) {
      const by = {}; let any = false;
      for (let k = lowerBound(ts, a); k < ts.length && ts[k] <= b; k++) { if (ts[k] <= a) continue; const i = idx[k], c = classes[i]; if (c === 'hidden') return 'hidden'; any = true; by[c] = (by[c] ?? 0) + (samples[i].dt ?? 0.5); }
      return any ? Object.entries(by).sort((x, y) => y[1] - x[1])[0][0] : null;
    },
  };
}

/**
 * Each summary's class: hidden when the session's samples in its window have a hidden one (or the tab return's
 * frame), or its own visible share is under 1; else by its frames and draws per frame.
 */
export function summaryClasses(summaries, samples = [], classes = sampleClasses(samples)) {
  const d3d = summaries.some((x) => (x.d3dFrames ?? 0) > 0) || samples.some((x) => (x.draws ?? 0) > 0), tl = classTimeline(samples, classes);
  return summaries.map((x) => {
    // (its window: the samples after the previous summary's — half a sample's margin for the rounded seconds)
    const t1 = x.t, t0 = t1 - (x.seconds ?? 20) * 1000 + 250;
    const hidden = (x.visible ?? 1) < 1 || (Number.isFinite(t1) && tl.of(t0, t1) === 'hidden');
    return windowClass({ seconds: x.seconds ?? 0, frames: x.frames ?? 0, dpf: d3d ? x.drawsPerFrame ?? 0 : null, hidden });
  });
}

// (the samples', summaries' and passive records' minutes' fields this report reads: any other numeric one — a newer
// page's, e.g. a pacing or compile counter — is shown as its mean over the play)
const SAMPLE_FIELDS = new Set(['t', 'dt', 'fps', 'busy', 'jit', 'max', 's33', 's50', 'p99', 'mips', 'api', 'draws', 'io', 'net', 'netReq', 'prog', 'progMs', 'frames', 'st', 'mem', 'au', 'fs', 'vis', 'bw', 'nw', 'rx', 'w', 'c', 'sc', 'wf', 'aw']);
const ENTRY_FIELDS = new Set(['t', 'ph', 's', 'hid', 'n', 'fps', 'p50', 'p90', 'p99', 'max', 'f40', 'f100', 'work', 'wait', 'cats', 'slow', 'gpu', 'data', 'pace']);
const SUMMARY_FIELDS = new Set(['t', 'event', 'seconds', 'frames', 'fps', 's33', 's40', 's50', 's100', 'per33', 'per50', 'per100', 'dt', 'work', 'cats', 'slowCats', 'worst', 'h', 'busy', 'mips', 'visible', 'fullscreen', 'status', 'renderMode', 'd3dFrames', 'drawsPerFrame', 'gpu', 'glCalls', 'render', 'hostWait', 'audio', 'flicker', 'pace', 'awake']);
/** a record's numeric fields unknown to the report (one level of objects too: `a.b`), weighted by `w` into `into` */
function addExtra(into, x, known, w) {
  for (const k in x) {
    if (known.has(k)) continue;
    const v = x[k];
    if (typeof v === 'number' && Number.isFinite(v)) { const e = (into[k] ??= [0, 0]); e[0] += v * w; e[1] += w; }
    else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [kk, vv] of Object.entries(v)) if (typeof vv === 'number' && Number.isFinite(vv)) { const e = (into[`${k}.${kk}`] ??= [0, 0]); e[0] += vv * w; e[1] += w; }
  }
}
const extraOut = (o) => (Object.keys(o).length ? Object.fromEntries(Object.entries(o).map(([k, [s, w]]) => [k, w ? +(s / w).toFixed(2) : null])) : null);

/** A stretch of samples (or every sample of a class) being added up. */
const sampleAcc = (kind, t0) => ({ kind, t0, seconds: 0, frames: 0, s33: 0, s50: 0, acctFrames: 0, work: 0, cats: {}, slowCats: {}, worst: null, busy: 0, mips: 0, mipsS: 0, draws: 0, jit: 0, prog: 0, progMs: 0, extra: {} });
function addSample(a, x) {
  const frames = (x.fps ?? 0) * x.dt;
  a.seconds += x.dt; a.frames += frames; a.s33 += x.s33 ?? 0; a.s50 += x.s50 ?? 0; a.busy += (x.busy ?? 0) * x.dt; a.draws += x.draws ?? 0;
  if (x.mips >= 0) { a.mips += x.mips * x.dt; a.mipsS += x.dt; } // (a negative one: a counter that restarted)
  a.jit += Math.max(0, x.jit ?? 0); a.prog += Math.max(0, x.prog ?? 0); a.progMs += Math.max(0, x.progMs ?? 0);
  if (x.c) { a.acctFrames += frames; a.work += (x.w ?? 0) * frames; add(a.cats, x.c, frames); }
  if (x.sc) add(a.slowCats, x.sc);
  if (x.wf && (!a.worst || x.wf[0] > a.worst[0])) a.worst = x.wf;
  addExtra(a.extra, x, SAMPLE_FIELDS, x.dt);
}
function mergeSamples(a, b) {
  for (const k of ['seconds', 'frames', 's33', 's50', 'busy', 'mips', 'mipsS', 'draws', 'jit', 'prog', 'progMs', 'acctFrames', 'work']) a[k] += b[k];
  add(a.cats, b.cats); add(a.slowCats, b.slowCats); if (b.worst && (!a.worst || b.worst[0] > a.worst[0])) a.worst = b.worst;
  for (const [k, [s, w]] of Object.entries(b.extra)) { const e = (a.extra[k] ??= [0, 0]); e[0] += s; e[1] += w; }
}
/** A samples' stretch as the report shows it. */
function sampleOut(st) {
  const sec = st.seconds || 1, min = sec / 60, n = st.acctFrames || 1, slowTotal = Object.values(st.slowCats).reduce((a, b) => a + b, 0);
  return { kind: st.kind, at: Number.isFinite(st.t0) ? new Date(st.t0).toISOString().slice(11, 19) : null, seconds: Math.round(st.seconds), fps: +(st.frames / sec).toFixed(1), busy: Math.round(st.busy / sec), mips: st.mipsS ? Math.round(st.mips / st.mipsS) : null, per33: Math.round(st.s33 / min), per50: Math.round(st.s50 / min),
    work: st.acctFrames ? +(st.work / n).toFixed(1) : null, cats: st.acctFrames ? fmt(st.cats, 1 / n) : null, slowShares: slowTotal ? fmt(st.slowCats, 100 / slowTotal, 1) : null, worst: st.worst,
    drawsPerFrame: st.frames ? Math.round(st.draws / st.frames) : null, jitMsPerMin: Math.round(st.jit / min), programs: st.prog, programMs: Math.round(st.progMs), extra: extraOut(st.extra) };
}

/** The runs of consecutive samples of one class (sampleClasses), each added up. */
function classRuns(samples, classes) {
  const out = []; let cur = null;
  samples.forEach((x, i) => {
    if (!cur || cur.kind !== classes[i]) out.push(cur = sampleAcc(classes[i], x.t));
    addSample(cur, x);
  });
  return out;
}
const copyAcc = (a) => { const c = sampleAcc(a.kind, a.t0); mergeSamples(c, a); return c; };

/** Consecutive samples of one class (sampleClasses) as stretches. */
export function stretches(samples, classes = sampleClasses(samples), runs = classRuns(samples, classes)) {
  // (a stretch shorter than 10 s is merged into the previous one — a loading hiccup — then neighbours of one class;
  // never a hidden one into another or another into it: the play figures are counted per sample, not per stretch, but
  // a stretch's own should not mix them either)
  const kept = [];
  for (const st of runs) {
    const last = kept[kept.length - 1];
    if (last && (st.kind === last.kind || (st.seconds < 10 && st.kind !== 'hidden' && last.kind !== 'hidden'))) mergeSamples(last, st); else kept.push(copyAcc(st));
  }
  return kept;
}

/** Every sample of each class added up (from its runs): { play, menu, loading, hidden } (those the session has). */
function samplesByClass(runs) {
  const by = {};
  for (const r of runs) mergeSamples(by[r.kind] ??= sampleAcc(r.kind, r.t0), r);
  return by;
}

/**
 * The emulated CPU's speed with the tab visible, hidden and kept in the foreground (`aw` 1: src/web/background-play.js)
 * and hidden without (`aw` 0, or a build before it): the median MIPS of the samples where the worker was busy (≥ 90 % of
 * the interval — a boot, a load, a game held by its CPU), and the guest + API work a frame in play (≥ 10 fps, the frame
 * accounting's categories). Chrome lowers a hidden silent tab's process (2026-11-18: 2.5-4 times slower on the owner's
 * laptop); null when the session was never hidden.
 */
export function hiddenSpeed(samples) {
  const groups = { visible: [], awake: [], hidden: [] };
  for (const x of samples) if (x.st === 'running' || x.st === 'starting') groups[x.vis !== false ? 'visible' : x.aw === 1 ? 'awake' : 'hidden'].push(x);
  if (!groups.awake.length && !groups.hidden.length) return null;
  const med = (v) => { const a = v.filter(Number.isFinite).sort((p, q) => p - q); return a.length ? a[a.length >> 1] : null; };
  const out = {};
  for (const [k, xs] of Object.entries(groups)) {
    const busy = xs.filter((x) => (x.busy ?? 0) >= 90), play = xs.filter((x) => (x.fps ?? 0) >= 10 && x.c);
    out[k] = { seconds: Math.round(xs.reduce((a, x) => a + (x.dt ?? 0), 0)), busySeconds: Math.round(busy.reduce((a, x) => a + (x.dt ?? 0), 0)), mips: med(busy.map((x) => x.mips)),
      playSeconds: Math.round(play.reduce((a, x) => a + (x.dt ?? 0), 0)), work: med(play.map((x) => (x.c.guest ?? 0) + (x.c.api ?? 0))) };
  }
  return out;
}

/**
 * The hidden tab's effect on the game (the samples' `vis`): its time and how many times the page was hidden, the guest's
 * MIPS and the worker's busy share while hidden against the visible time's — all of it, and the BEFORE_S seconds before
 * each hiding (the same activity, most often) —, the frames presented while hidden. null when never hidden.
 */
export const BEFORE_S = 10;
export function hiddenTab(samples) {
  const vis = { s: 0, busy: 0, mips: 0, ms: 0 }, hid = { s: 0, busy: 0, mips: 0, ms: 0, frames: 0 }, before = { mips: 0, ms: 0 };
  let times = 0, prev = false;
  samples.forEach((x, i) => {
    const h = x.vis === false, a = h ? hid : vis;
    a.s += x.dt; a.busy += (x.busy ?? 0) * x.dt;
    if (x.mips >= 0) { a.mips += x.mips * x.dt; a.ms += x.dt; }
    if (h) {
      hid.frames += (x.fps ?? 0) * x.dt;
      if (!prev) { times++; for (let j = i - 1; j >= 0 && samples[j].vis !== false && x.t - samples[j].t <= BEFORE_S * 1000; j--) if (samples[j].mips >= 0) { before.mips += samples[j].mips * samples[j].dt; before.ms += samples[j].dt; } }
    }
    prev = h;
  });
  if (!hid.s) return null;
  const m = (a) => (a.ms ? Math.round(a.mips / a.ms) : null), mv = m(vis), mh = m(hid);
  return { seconds: Math.round(hid.s), times, mipsHidden: mh, mipsVisible: mv, mipsBefore: m(before), ratio: mv ? +(mh / mv).toFixed(2) : null, ratioBefore: before.ms && before.mips ? +(mh / (before.mips / before.ms)).toFixed(2) : null,
    busyHidden: Math.round(hid.busy / hid.s), busyVisible: vis.s ? Math.round(vis.busy / vis.s) : null, fpsHidden: +(hid.frames / hid.s).toFixed(1) };
}

/** A stretch of summaries (or every summary of a class) being added up. */
const summaryAcc = (kind, t0) => ({ kind, t0, n: 0, seconds: 0, frames: 0, s33: 0, s40: 0, s50: 0, s100: 0, max: 0, hist: new Array(HIST_N).fill(0), cats: {}, slowCats: {}, work: 0, d3dFrames: 0, draws: 0, glFrames: 0, glCalls: 0, gpuFrames: 0, gpuMs: 0, gpuHist: new Array(HIST_N).fill(0), gpuState: null, gpuMax: 0, rwWait: 0, rwReplay: 0, rwFrames: 0, render: null, visible: 0, pace: [], extra: {} });

/**
 * The ~20 s summaries merged per stretch (consecutive summaries of one class: summaryClasses): frame-time percentiles
 * from the merged histograms, slow-frame rates, draws / GL calls / GPU time / render waits per frame. `all`: one
 * entry per class instead, every summary of it merged (the play figures).
 */
export function summaryStretches(summaries, classes = summaryClasses(summaries), { all = false } = {}) {
  const out = [], by = {}; let cur = null;
  summaries.forEach((x, i) => {
    const kind = classes[i];
    if (all) cur = by[kind] ??= (out.push(summaryAcc(kind, x.t)), out[out.length - 1]);
    else if (!cur || cur.kind !== kind) out.push(cur = summaryAcc(kind, x.t));
    if (x.pace) cur.pace.push(x.pace);
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
    if (x.flicker) { const f = cur.flk ??= { n: 0, aba: 0, still: 0, stillN: 0, chg: 0, max: 0, over1: 0, alt: 0, abaAlt: 0, altSame: 0, altCmdAba: 0, seqs: 0, runs: 0, glErrors: 0, glError: null }; const n = x.flicker.n ?? 0; f.n += n; f.aba += (x.flicker.aba ?? 0) * n; f.chg += (x.flicker.chg ?? 0) * n; if (x.flicker.still != null) { f.still += x.flicker.still * n; f.stillN += n; } if ((x.flicker.max ?? 0) > f.max) f.max = x.flicker.max; f.over1 += x.flicker.over1 ?? 0; f.alt += x.flicker.alt ?? 0; f.abaAlt += x.flicker.abaAlt ?? 0; f.altSame += x.flicker.altSame ?? 0; f.altCmdAba += x.flicker.altCmdAba ?? 0; f.seqs += x.flicker.seqs ?? 0; f.runs += x.flicker.runs ?? 0; f.glErrors += x.flicker.glErrors ?? 0; if (x.flicker.glError) f.glError = x.flicker.glError; }
    cur.visible += (x.visible ?? 1) * (x.seconds ?? 0);
    addExtra(cur.extra, x, SUMMARY_FIELDS, x.seconds ?? 0);
  });
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
      visible: c.seconds ? +(c.visible / c.seconds).toFixed(2) : null, pace: paceMerge(c.pace),
      flicker: c.flk ? { n: c.flk.n, aba: c.flk.n ? +(c.flk.aba / c.flk.n).toFixed(4) : null, still: c.flk.stillN ? +(c.flk.still / c.flk.stillN).toFixed(4) : null, chg: c.flk.n ? +(c.flk.chg / c.flk.n).toFixed(4) : null, max: c.flk.max, over1: c.flk.over1, alt: c.flk.alt, abaAlt: c.flk.abaAlt, altSame: c.flk.altSame, altCmdAba: c.flk.altCmdAba, seqs: c.flk.seqs, runs: c.flk.runs, glErrors: c.flk.glErrors, glError: c.flk.glError } : null,
      extra: extraOut(c.extra),
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
export function report(sessions, { minSeconds = 60, bench = undefined, players = false } = {}) {
  const out = [];
  for (const s of sessions.values()) {
    if (players && (s.bench || s.benches.length || s.suites.length)) continue;
    const seconds = s.samples.reduce((a, x) => a + x.dt, 0) || s.summaries.reduce((a, x) => a + (x.seconds ?? 0), 0);
    const benches = bench === undefined ? s.benches : s.benches.filter((b) => bench === true || b.bench === bench);
    if (bench !== undefined && !benches.length) continue;
    if (seconds < minSeconds && !benches.length && !s.capture && !s.drawProbe && !s.reportProbes) continue;
    const cmds = {}; for (const x of s.flickerLogs) cmds[x.cmd] = (cmds[x.cmd] ?? 0) + 1;
    // (each window's class: the play figures are the visible play's — the samples' for the rates and causes, the
    // summaries' for the percentiles, GPU and draws —, the time of the others counted apart)
    const sc = sampleClasses(s.samples), mc = summaryClasses(s.summaries, s.samples, sc), runs = classRuns(s.samples, sc), byClass = samplesByClass(runs);
    const sumAll = summaryStretches(s.summaries, mc, { all: true }), windows = {};
    if (s.samples.length) for (const [k, a] of Object.entries(byClass)) windows[k] = Math.round(a.seconds);
    else for (const st of sumAll) windows[st.kind] = st.seconds;
    const r = { session: s.id, game: s.game, bench: s.bench, first: s.first, machine: machineLine(s.env), env: s.env, version: s.version, options: s.options, render: renderModeOf(s), seconds: Math.round(seconds), slowEvents: s.slow, events: s.events,
      windows, play: { samples: byClass.play ? sampleOut(byClass.play) : null, summaries: sumAll.find((x) => x.kind === 'play') ?? null, of: s.summaries.length }, hiddenTab: hiddenTab(s.samples), hidden: hiddenSpeed(s.samples),
      stretches: stretches(s.samples, sc, runs).map(sampleOut), summaryStretches: summaryStretches(s.summaries, mc), audio: audioVerdict(s.summaries.map((x) => x.audio)), compat: s.compat, benches,
      flickerCapture: s.capture, drawProbe: s.drawProbe, reportProbes: s.reportProbes ?? null, flickerLogs: s.flickerLogs.length ? { n: s.flickerLogs.length, maxStill: Math.max(...s.flickerLogs.map((x) => x.still).filter((v) => !Number.isNaN(v)), 0), commands: cmds } : null };
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

/**
 * The bench suite's runs (bench-suite.js), oldest first: per run its suite, machine, build and, per game in the suite's
 * order, the game's bench record (or, when only the suite's own record has it, its compact result). `run`: one run's id.
 */
export function suiteRuns(sessions, run = null) {
  const runs = new Map();
  const get = (id) => { let r = runs.get(id); if (!r) runs.set(id, (r = { run: id, suite: null, title: null, at: null, env: null, version: null, record: null, games: new Map() })); return r; };
  for (const s of sessions.values()) {
    for (const b of s.benches) {
      const id = b.suite?.run; if (!id || (run && id !== run)) continue;
      const r = get(id); r.suite ??= b.suite.name ?? null; if (!r.at || (b.at && b.at < r.at)) r.at = b.at; r.env ??= b.env ?? s.env; r.version ??= b.version ?? s.version;
      r.games.set(b.suite.index ?? r.games.size + 1, { ...b, of: b.suite.of ?? null, session: s.id });
    }
    for (const x of s.suites) {
      if (!x.run || (run && x.run !== run)) continue;
      const r = get(x.run); r.record = x; r.suite = x.suite ?? r.suite; r.title = x.title ?? null; r.env = x.env ?? r.env; r.version = x.version ?? r.version; if (!r.at || (x.at && x.at < r.at)) r.at = x.at;
    }
  }
  return [...runs.values()].map((r) => {
    // (a game whose own record never came: the suite's record still has its result)
    (r.record?.results ?? []).forEach((g, i) => { if (!r.games.has(i + 1)) r.games.set(i + 1, { ...g, fromSuite: true }); });
    return { ...r, games: [...r.games.entries()].sort((a, b) => a[0] - b[0]).map(([index, g]) => ({ index, ...g })) };
  }).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const ms = (v) => (v === null || v === undefined ? '-' : Math.round(v * 10) / 10);
/** The text of the suite's runs: per game, its outcome and phases side by side with the figures read first. */
export function formatSuites(runs) {
  const L = [];
  for (const r of runs) {
    const done = r.games.filter((g) => g.outcome === 'done').length;
    L.push(`suite ${r.suite ?? '?'} run ${r.run} ${(r.at ?? '').slice(0, 16).replace('T', ' ')}: ${done}/${r.record?.games ?? r.games.length} games done${r.record ? `, ${r.record.seconds} s` : ', no suite record (the run did not finish)'}${r.version ? `, build ${r.version}` : ''}`);
    L.push(`  machine: ${machineLine(r.env)}`);
    for (const g of r.games) {
      const probe = g.hostTiming?.[0];
      L.push(`  ${g.index}. ${g.bench} (${g.manifest ?? '?'}, ${g.runtime ?? 'win32'}): ${g.outcome}${g.detail ? ` — ${g.detail}` : ''}${g.seconds !== null && g.seconds !== undefined ? `, ${g.seconds} s` : ''}${g.firstLaunch ? ', first launch' : ''}${g.interrupted && (g.interrupted.hiddenSeconds || g.interrupted.blurs) ? ', INTERRUPTED' : ''}${g.fromSuite ? ' (from the suite record)' : ''}`);
      if (g.renderer) L.push(`      renderer ${g.renderer}${g.display ? `, display ${g.display}` : ''}`);
      for (const p of g.phases ?? []) {
        L.push(`      ${String(p.label).padEnd(10)} ${String(p.seconds ?? '?').padStart(6)} s ${String(p.fps ?? '?').padStart(5)} fps; frame ms p50 ${p.dt?.p50 ?? '-'} p90 ${p.dt?.p90 ?? '-'} p99 ${p.dt?.p99 ?? '-'}; >40 ms ${p.per40 ?? '-'}/min (${p.slow40 ?? '-'}); work p50 ${ms(p.work?.p50)} p99 ${ms(p.work?.p99)} ms; GPU ${p.gpu?.frames ? `p50 ${p.gpu.p50} p99 ${p.gpu.p99} ms` : p.gpu?.state ?? '-'}; data waits ${p.dataWaitMs ?? '-'} ms${p.drawsPerFrame !== null && p.drawsPerFrame !== undefined ? `; draws/frame ${p.drawsPerFrame}` : ''}`);
      }
      if (probe) L.push(`      timers: ${probe.atomicsWait1 && typeof probe.atomicsWait1 === 'object' ? probeLine(probe) : `Atomics.wait(1) +${probe.atomicsWait1 ?? '?'} ms, setTimeout(1) +${probe.setTimeout1 ?? '?'} ms (p50)`}`);
    }
  }
  return L.join('\n');
}

const COMPAT_KINDS = [['imports', 'unknown imports called', 'calls'], ['notImpl', 'COM E_NOTIMPL', 'calls'], ['shaderOps', 'untranslated shader instructions', 'programs']];
/** A session's compatibility summary (core/compat-stats.js) as text lines. */
export function compatLines(c) {
  if (!c) return [];
  return COMPAT_KINDS.filter(([k]) => c[k]?.length).map(([k, label]) => `${label} (${c[k].length + (c.more?.[k] ?? 0)}): ${c[k].map(([n, v]) => `${n} x${v}`).join(', ')}${c.more?.[k] ? `, +${c.more[k]} more` : ''}`);
}

/** --compat: per game, each gap with the sessions that met it and its counts summed, the most frequent first. */
export function compatByGame(sessions, { players = false } = {}) {
  const games = new Map();
  for (const s of sessions.values()) {
    if (players && s.bench) continue;
    const g = games.get(s.game ?? '?') ?? { game: s.game ?? '?', sessions: 0, withGaps: 0, kinds: {} };
    games.set(g.game, g); g.sessions++;
    if (!s.compat) continue;
    g.withGaps++;
    for (const [k] of COMPAT_KINDS) for (const [name, n] of s.compat[k] ?? []) { const m = (g.kinds[k] ??= {}); const e = (m[name] ??= { sessions: 0, count: 0 }); e.sessions++; e.count += n; }
  }
  return [...games.values()].sort((a, b) => b.withGaps - a.withGaps || String(a.game).localeCompare(String(b.game)))
    .map((g) => ({ ...g, kinds: Object.fromEntries(Object.entries(g.kinds).map(([k, m]) => [k, Object.entries(m).sort((a, b) => b[1].sessions - a[1].sessions || b[1].count - a[1].count).map(([name, e]) => ({ name, ...e }))])) }));
}
export function formatCompat(groups) {
  const L = [];
  for (const g of groups) {
    L.push(`${g.game}: ${g.withGaps} of ${g.sessions} session(s) met compatibility gaps`);
    for (const [k, label, unit] of COMPAT_KINDS) if (g.kinds[k]?.length) L.push(`  ${label}: ${g.kinds[k].map((e) => `${e.name} (${e.sessions} session${e.sessions > 1 ? 's' : ''}, ${e.count} ${unit})`).join(', ')}`);
  }
  return L.join('\n') || 'no session';
}

const cell = (p) => (p ? `${p.fps} fps p99 ${p.dt?.p99 ?? '?'} >33 ${p.per33}/min${p.gpu?.frames ? ` gpu p99 ${p.gpu.p99}` : ''}` : '-');
const pairs = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
const worstText = (w) => `worst ${w[0]} ms (work ${w[1]}: ${pairs(w[2])})`;
/** a merged summaries' figures: frame times, slow frames, draws, GPU, render worker */
const summaryText = (st) => `frame ms p50 ${st.p50} p90 ${st.p90} p99 ${st.p99} max ${st.max}; >33 ${st.per33}/min >40 ${st.per40} >50 ${st.per50} >100 ${st.per100}; draws/frame ${st.drawsPerFrame ?? '-'}, GL calls/frame ${st.glCallsPerFrame ?? '-'}; GPU ${typeof st.gpu === 'object' && st.gpu ? `${st.gpu.mean} ms/frame p50 ${st.gpu.p50} p99 ${st.gpu.p99} (${st.gpu.frames} frames timed)` : st.gpu ?? '-'}${st.renderWaitMs !== null ? `; render worker waits ${st.renderWaitMs} ms/frame, replay ${st.replayMs}` : ''}`;
const label = (k) => (CLASS_LABEL[k] ?? k).padEnd(13);

/** The text report. */
export function formatReport(reports, comparison) {
  const L = [];
  for (const r of reports) {
    L.push(`session ${r.session}${r.bench ? ` [bench ${r.bench}]` : ''} ${r.game ?? '?'} ${r.first ? r.first.slice(0, 16).replace('T', ' ') : ''} ${r.seconds} s${r.version ? `, build ${r.version}` : ''}${r.render ? `, render ${r.render}` : ''}; ${r.slowEvents} slow-frame events${Object.keys(r.events).length ? `; events ${Object.entries(r.events).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
    L.push(`  machine: ${r.machine}`);
    // (the flicker probe's logged samples with their frames' command pattern, and the session's flicker capture)
    if (r.flickerLogs) L.push(`  flicker samples logged: ${r.flickerLogs.n} (largest ${r.flickerLogs.maxStill} % flickering; commands ${Object.entries(r.flickerLogs.commands).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    if (r.drawProbe) { const d = r.drawProbe; L.push(`  draw probe: ${d.at ? d.at.slice(11, 19) : '?'}, started by ${d.why ?? '?'} (${d.path ?? '?'}); ${d.frames} frames, ${d.odd ?? '?'} odd${d.cut.length ? `; cut ${d.cut.join(', ')}` : ''}; ${d.verdict ?? ''} — node tools/dev/draw-probe.mjs <telemetry .jsonl> --session ${r.session}`); }
    for (const d of r.reportProbes ?? []) L.push(`  draw probe of display report ${d.report}: ${d.at ? d.at.slice(11, 19) : '?'} (${d.path ?? '?'}); ${d.frames} frames, ${d.odd ?? '?'} odd${d.cut.length ? `; cut ${d.cut.join(', ')}` : ''}; ${d.verdict ?? ''} — node tools/dev/flicker-report.mjs <telemetry .jsonl> --session ${r.session} --id ${d.report}`);
    if (r.flickerCapture) { const c = r.flickerCapture; L.push(`  flicker capture: ${c.at ? c.at.slice(11, 19) : '?'}, trigger ${c.trigger ? `${c.trigger.asked ? 'asked' : `${c.trigger.still} % flickering, commands ${c.trigger.cmd ?? '?'}`}` : '?'}; ${c.frames} frames, ${c.images} pictures${c.small ? ` (${c.small.aba} % A-B-A)` : ''}${c.alt && Object.keys(c.alt).length ? `; alternating draw fields ${Object.entries(c.alt).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}${c.cut.length ? `; cut ${c.cut.join(', ')}` : ''}${c.took ? `; made in ${c.took.ms} ms, longest slice ${c.took.longest} ms` : ''} — node tools/dev/flicker-capture.mjs <telemetry .jsonl> --session ${r.session}`); }
    if (r.options) L.push(`  options: ${Object.entries(r.options).filter(([, v]) => v !== '' && v !== false && v !== null).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    // (the session's time by window class, the visible play's figures — the only ones to read as the game's pace —, the
    // hidden tab's effect on the guest)
    if (Object.keys(r.windows).length) L.push(`  time: ${CLASSES.filter((k) => r.windows[k]).map((k) => `${CLASS_LABEL[k]} ${r.windows[k]} s`).join(', ')}`);
    const p = r.play.samples, q = r.play.summaries;
    if (p) {
      L.push(`  visible play: ${p.seconds} s ${p.fps} fps busy ${p.busy}%${p.mips !== null ? ` MIPS ${p.mips}` : ''}${p.drawsPerFrame !== null ? ` draws/frame ${p.drawsPerFrame}` : ''}; >33 ms ${p.per33}/min >50 ms ${p.per50}/min${p.work !== null ? `; work ${p.work} ms/frame: ${p.cats}` : ''}; compiles: JIT ${p.jitMsPerMin} ms/min, ${p.programs} GL programs built (${p.programMs} ms)`);
      if (p.slowShares) L.push(`      slow frames' time (%): ${p.slowShares}; ${worstText(p.worst)}`);
      if (p.extra) L.push(`      other sample fields (mean): ${pairs(p.extra)}`);
    }
    if (q) {
      L.push(`  visible play, ${q.summaries} of ${r.play.of} summaries (${q.seconds} s): ${q.fps} fps; ${summaryText(q)}`);
      if (q.extra) L.push(`      other summary fields (mean): ${pairs(q.extra)}`);
    }
    if (!p && !q) L.push('  visible play: none');
    if (r.hiddenTab) { const h = r.hiddenTab; L.push(`  hidden tab: ${h.seconds} s, ${h.times} time(s); guest MIPS ${h.mipsHidden ?? '-'} hidden vs ${h.mipsVisible ?? '-'} visible (x${h.ratio ?? '-'})${h.mipsBefore !== null ? `, ${h.mipsBefore} in the ${BEFORE_S} s before hiding (x${h.ratioBefore ?? '-'})` : ''}; worker busy ${h.busyHidden}% vs ${h.busyVisible ?? '-'}%; ${h.fpsHidden} fps presented while hidden`); }
    // (by foreground state: Chrome lowers a hidden silent tab's process, background-play.js keeps it up — hiddenSpeed)
    if (r.hidden) L.push(`  hidden tab, MIPS while the worker is busy (s) | guest+API ms a frame in play (s): ${Object.entries(r.hidden).filter(([, g]) => g.seconds).map(([k, g]) => `${k === 'awake' ? 'hidden kept awake' : k} ${g.mips ?? '-'} (${g.busySeconds}) | ${g.work !== null ? g.work.toFixed(1) : '-'} (${g.playSeconds})`).join('; ')}`);
    for (const st of r.stretches) {
      if (st.kind === 'hidden') { L.push(`  ${st.at} ${label(st.kind)} ${String(st.seconds).padStart(5)} s (set apart: the tab hidden, or its first frame back) ${st.fps} fps busy ${st.busy}%${st.mips !== null ? ` MIPS ${st.mips}` : ''}${st.worst ? `; longest frame ${st.worst[0]} ms` : ''}`); continue; }
      L.push(`  ${st.at} ${label(st.kind)} ${String(st.seconds).padStart(5)} s ${String(st.fps).padStart(5)} fps busy ${st.busy}%${st.mips !== null ? ` MIPS ${st.mips}` : ''} >33 ms ${st.per33}/min >50 ms ${st.per50}/min${st.work !== null ? `; work ${st.work} ms/frame: ${st.cats}` : ''}`);
      if (st.slowShares) L.push(`      slow frames' time (%): ${st.slowShares}; ${worstText(st.worst)}`);
    }
    if (r.audio && r.audio.verdict !== 'none') L.push(`  ${audioText(r.audio)}`);
    for (const line of compatLines(r.compat)) L.push(`  ${line}`);
    if (r.summaryStretches.length) L.push('  summaries (every ~20 s), merged per stretch:');
    for (const st of r.summaryStretches) {
      // (a hidden stretch's frame figures are set apart; its flicker samples are not a pace and stay below)
      if (st.kind === 'hidden') L.push(`  ${st.at ?? '--:--:--'} ${label(st.kind)} ${String(st.seconds).padStart(5)} s (set apart) visible ${Math.round((st.visible ?? 1) * 100)}%, ${st.fps} fps, longest frame ${st.max} ms`);
      else {
        L.push(`  ${st.at ?? '--:--:--'} ${label(st.kind)} ${String(st.seconds).padStart(5)} s ${String(st.fps).padStart(5)} fps; ${summaryText(st)}`);
        if (st.work !== null) L.push(`      work ${st.work} ms/frame: ${st.cats}${st.slowShares ? `; slow frames' time (%): ${st.slowShares}` : ''}`);
        if (st.pace) L.push(`      ${paceText(st.pace)}`);
      }
      // (gfx/flicker-probe.js: frame triples sampled every 10 s, % of their pixels going A-B-A where nothing moved — the
      // flicker; a summary without `still`, from the probe's first version (2026-11-17 morning): only A-B-A anywhere, a
      // scroll's included —, the largest, the samples where it dominates what changed; WebGL errors)
      if (st.flicker?.n || st.flicker?.glErrors) L.push(`      flicker: ${st.flicker.n} samples, ${st.flicker.still != null ? `flickering ${st.flicker.still} % of pixels` : `A-B-A ${st.flicker.aba ?? '-'} % of pixels`} (max ${st.flicker.max ?? '-'} %, ${st.flicker.over1} over 1 %, ${st.flicker.alt ?? 0} alternating${st.flicker.altSame || st.flicker.altCmdAba ? ` (${st.flicker.altSame ?? 0} with the same commands, ${st.flicker.altCmdAba ?? 0} with A-B-A commands)` : ''}, ${st.flicker.abaAlt ?? 0} alternating while moving)${st.flicker.still != null ? `, A-B-A anywhere ${st.flicker.aba ?? '-'} %` : ''}, changed ${st.flicker.chg ?? '-'} %${st.flicker.seqs ? `; alternation samples ${st.flicker.seqs}, ${st.flicker.runs} coming back in runs at the same place` : ''}; WebGL errors ${st.flicker.glErrors}${st.flicker.glError ? ` (last 0x${st.flicker.glError.toString(16)})` : ''}`);
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
export function perfSessions(lines, { from = null, to = null, session = null, game = null, gpu = null, players = false } = {}) {
  const by = new Map();
  for (const r of lines) {
    if (r?.event !== 'perf' || !r.session || (session && r.session !== session) || (game && r.game !== game)) continue;
    if (players && r.bench) continue; // (--players: a bench's records — its suite run, its name — left out)
    const day = typeof r.at === 'string' ? r.at.slice(0, 10) : null;
    if (day && ((from && day < from) || (to && day > to))) continue;
    let s = by.get(r.session);
    if (!s) by.set(r.session, (s = { id: r.session, game: r.game ?? null, runtime: r.runtime, first: r.at ?? null, t0: null, env: null, probe: null, seqs: new Set(), mins: [], tot: null, totSeq: -1, len: 0, vis: 0, hid: 0, final: false, version: null, build: null, tier: null, bench: null }));
    if (s.seqs.has(r.seq)) continue; // (a record sent twice)
    s.seqs.add(r.seq);
    if (r.at && (!s.first || r.at < s.first)) s.first = r.at;
    // (the recording's start on the server's clock — its minutes' `t` count from it —: a record's receipt less its age,
    // the least delayed record's)
    const t0 = Date.parse(r.at) - (r.len ?? NaN) * 1000; if (Number.isFinite(t0) && (s.t0 === null || t0 < s.t0)) s.t0 = t0;
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
    work: t.work ?? null, wait: t.wait ?? null, pace: t.pace ?? null, gpu: t.gpu?.n ? t.gpu : null, gpuRun: t.gpu?.run ?? null, gpuFence: t.gpu?.fence ?? null, gpuState: t.gpu?.state ?? null, dataMsPerMin: t.data ? per(t.data.ms, sec) : null, dataWaits: t.data?.n ?? null,
    machine: machineLine(s.env), probe: s.probe };
}

/**
 * A passive record's minutes' classes (windowClass): by the session's samples in the minute's time when the page sent
 * them too (`samples`: the Windows games' — draws per frame, visibility, the frame back from a hidden tab), else by its
 * hidden time, its phase (the ports': menu, loading) and its frames.
 */
export function entryClasses(s, samples = null) {
  const tl = samples?.length && s.t0 !== null ? classTimeline(samples, sampleClasses(samples)) : null;
  return s.mins.map((e) => {
    if ((e.hid ?? 0) > 0) return 'hidden';
    if (tl) { const a = s.t0 + e.t * 1000, c = tl.of(a, a + ((e.s ?? 0) + (e.hid ?? 0)) * 1000); if (c) return c; }
    return windowClass({ seconds: e.s ?? 0, frames: e.n ?? 0, phase: e.ph ?? null });
  });
}

/**
 * The play frames' histogram of a Windows game's session from its ~20 s summaries classed play (summaryClasses, by the
 * same samples as its minutes): exact percentiles over the play windows, which a minute's p50 / p90 / p99 cannot give
 * (any reconstruction of the frames from them is biased: 2026-11-18 review, ×1.5-7 on the p99). null without one.
 */
function summaryPlayHist(summaries, samples) {
  if (!summaries?.length) return null;
  const cls = summaryClasses(summaries, samples ?? []), hist = new Array(HIST_N).fill(0); let max = 0, any = false;
  summaries.forEach((x, i) => { if (cls[i] !== 'play' || !x.h) return; histAddSparse(hist, x.h); any = true; if ((x.dt?.max ?? 0) > max) max = x.dt.max; });
  return any ? { hist, max } : null;
}

const r2 = (v) => Math.round(v * 100) / 100;
/**
 * One session's figures over its play minutes (`classes`: entryClasses): its totals' when every minute is play (exact),
 * else added up from its play minutes. The frame-time percentiles are then the play summaries' (a Windows game:
 * summaryPlayHist, exact over its play windows, `pct: 'summaries'`), else only bounded: the union's quantile is at most
 * the largest of its minutes' (`bound`, shown "≤", left out of the medians and of the merged frames). null without a play
 * minute. `windows`: its minutes' seconds per class; `hist` its play frames (null when unknown).
 */
function playFigures(s, classes, summaries = null, samples = null) {
  const base = sessionFigures(s), windows = {}, hist = new Array(HIST_N).fill(0);
  s.mins.forEach((e, i) => { windows[classes[i]] = (windows[classes[i]] ?? 0) + (e.s ?? 0) + (e.hid ?? 0); });
  for (const k of Object.keys(windows)) windows[k] = Math.round(windows[k]);
  if (classes.every((c) => c === 'play')) { if (s.tot?.h) histAddSparse(hist, s.tot.h); return { ...base, windows, hist, pct: 'totals' }; }
  const P = s.mins.filter((_, i) => classes[i] === 'play');
  if (!P.length) return null;
  const a = { sec: 0, n: 0, f40: 0, f100: 0, max: 0, wN: 0, work: 0, wait: 0, data: null }, gp = {};
  const series = (k, x) => { if (!(x?.n > 0)) return; const o = (gp[k] ??= { n: 0, ms: 0, p90: 0 }); o.n += x.n; o.ms += x.mean * x.n; o.p90 += (x.p90 ?? x.p99 ?? 0) * x.n; };
  for (const e of P) {
    a.sec += e.s ?? 0; a.n += e.n ?? 0; a.f40 += e.f40 ?? 0; a.f100 += e.f100 ?? 0; if ((e.max ?? 0) > a.max) a.max = e.max;
    if (Number.isFinite(e.work) && e.n) { a.work += e.work * e.n; a.wait += (e.wait ?? 0) * e.n; a.wN += e.n; }
    series('gpu', e.gpu); series('run', e.gpu?.run); series('fence', e.gpu?.fence);
    if (e.data) { a.data ??= { n: 0, ms: 0 }; a.data.n += e.data.n ?? 0; a.data.ms += e.data.ms ?? 0; }
  }
  const sr = (k) => (gp[k] ? { n: gp[k].n, mean: r2(gp[k].ms / gp[k].n), p90: Math.round(gp[k].p90 / gp[k].n * 10) / 10 } : null);
  const sh = summaryPlayHist(summaries, samples), top = (k) => P.reduce((m, e) => (Number.isFinite(e[k]) && e[k] > (m ?? -1) ? e[k] : m), null);
  const q = (x) => histQuantile(sh.hist, x, Math.max(sh.max, a.max) || Infinity);
  const pcts = sh ? { pct: 'summaries', hist: sh.hist, p50: q(0.5), p90: q(0.9), p99: q(0.99) } : { pct: 'bound', hist: null, p50: null, p90: null, p99: null, bound: { p50: top('p50'), p90: top('p90'), p99: top('p99') } };
  return { ...base, windows, ...pcts, seconds: Math.round(a.sec), fps: a.sec ? Math.round(a.n / a.sec * 10) / 10 : null, max: a.max || null,
    per40: per(a.f40, a.sec), per100: per(a.f100, a.sec), work: a.wN ? r2(a.work / a.wN) : null, wait: a.wN ? r2(a.wait / a.wN) : null,
    gpu: sr('gpu'), gpuRun: sr('run'), gpuFence: sr('fence'), dataMsPerMin: a.data ? per(a.data.ms, a.sec) : null, dataWaits: a.data?.n ?? null };
}

/**
 * The sessions grouped per game × GPU, over their play minutes only (entryClasses: the hidden tab's, the videos' and
 * loading screens', the menus' minutes set apart and counted): medians over the sessions, the merged frame times, the
 * worst minutes, the slow frames' causes. `samples`: the classic sessions' samples by session id (buildSessions), to
 * tell a Windows game's minutes apart.
 */
export function perfReport(sessions, { minSeconds = 60, samples = null, summaries = null } = {}) {
  const groups = new Map();
  for (const s of sessions.values()) {
    if ((s.tot?.s ?? s.vis ?? 0) < minSeconds) continue;
    const key = `${s.game ?? '?'}\n${s.gpu}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { game: s.game, gpu: s.gpu, runtime: s.runtime, sessions: [], hist: new Array(HIST_N).fill(0), max: 0, minutes: [], slow: {}, seconds: 0, noFrames: 0, noPlay: 0, apart: {}, fromSummaries: 0, bounded: 0, extra: {} }));
    if (!(s.tot?.n > 0)) { g.noFrames++; continue; } // (no frame shown: a start that never drew — counted, not in the medians)
    const smp = samples?.get(s.id) ?? null, classes = entryClasses(s, smp), f = playFigures(s, classes, summaries?.get(s.id) ?? null, smp);
    s.mins.forEach((e, i) => { if (classes[i] !== 'play') g.apart[classes[i]] = (g.apart[classes[i]] ?? 0) + (e.s ?? 0) + (e.hid ?? 0); });
    if (!f) { g.noPlay++; continue; } // (no play minute: counted, not in the medians)
    g.sessions.push(f); g.seconds += f.seconds;
    if (f.pct === 'summaries') g.fromSummaries++; else if (f.pct === 'bound') g.bounded++;
    f.hist?.forEach((v, i) => { g.hist[i] += v; }); // (a bounded session's frames are unknown: not merged)
    if ((f.max ?? 0) > g.max) g.max = f.max;
    s.mins.forEach((e, i) => { if (classes[i] === 'play') { g.minutes.push({ session: s.id, ...e }); add(g.slow, e.slow); addExtra(g.extra, e, ENTRY_FIELDS, e.n ?? 0); } });
  }
  return [...groups.values()].filter((g) => g.sessions.length || g.noFrames || g.noPlay).map((g) => {
    const f = g.sessions.map(({ hist, ...x }) => x), slowTotal = Object.values(g.slow).reduce((a, b) => a + b, 0);
    const m = (k) => median(f.map((x) => x[k]));
    // (the worst minutes: those with the most frames over 40 ms a minute, then the highest p99; at least 20 s of play)
    const worst = g.minutes.filter((e) => (e.s ?? 0) >= 20 && e.n > 0).map((e) => ({ ...e, per40: per(e.f40 ?? 0, e.s) })).sort((a, b) => (b.per40 - a.per40) || ((b.p99 ?? 0) - (a.p99 ?? 0))).slice(0, 3);
    const probes = f.map((x) => x.probe).filter(Boolean);
    return {
      game: g.game, gpu: g.gpu, runtime: g.runtime, sessions: f.length, noFrames: g.noFrames, noPlay: g.noPlay, minutes: +(g.seconds / 60).toFixed(1),
      apart: Object.fromEntries(Object.entries(g.apart).map(([k, v]) => [k, +(v / 60).toFixed(1)])),
      median: { fps: m('fps'), p50: m('p50'), p90: m('p90'), p99: m('p99'), per40: m('per40'), per100: m('per100'), work: m('work'), wait: m('wait'), gpuMean: median(f.map((x) => x.gpu?.mean)), runMean: median(f.map((x) => x.gpuRun?.mean)), fenceMean: median(f.map((x) => x.gpuFence?.mean)), gpuP90: median(f.map((x) => x.gpu?.p90)), dataMsPerMin: m('dataMsPerMin'), visible: m('visible') },
      merged: { p50: histQuantile(g.hist, 0.5, g.max || Infinity), p90: histQuantile(g.hist, 0.9, g.max || Infinity), p99: histQuantile(g.hist, 0.99, g.max || Infinity), max: g.max || null, fromSummaries: g.fromSummaries, bounded: g.bounded },
      gpuStates: [...new Set(f.map((x) => x.gpuState).filter(Boolean))], pace: paceMerge(f.map((x) => x.pace)),
      slowShares: slowTotal ? Object.fromEntries(Object.entries(g.slow).map(([k, v]) => [k, Math.round(v / slowTotal * 100)]).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1])) : null,
      extra: extraOut(g.extra), worst, probe: probes.length ? { atomicsWait1P50: median(probes.map((p) => p.atomicsWait1?.[0])), setTimeout1P50: median(probes.map((p) => p.setTimeout1?.[0])), onBattery: probes.filter((p) => p.battery && !p.battery.charging).length, n: probes.length } : null,
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
    const apart = (o, unit) => CLASSES.filter((k) => k !== 'play' && o?.[k]).map((k) => `${CLASS_LABEL[k]} ${o[k]} ${unit}`).join(', ');
    L.push(`${g.game ?? '?'} (${g.runtime}) × ${g.gpu}: ${g.sessions} session(s), ${g.minutes} min of visible play${apart(g.apart, 'min') ? `; set apart: ${apart(g.apart, 'min')}` : ''}${g.noPlay ? `; ${g.noPlay} session(s) without a play minute` : ''}${g.noFrames ? `; ${g.noFrames} session(s) without a frame shown` : ''}`);
    L.push(`  medians over the sessions' play: ${v(md.fps)} fps; frame ms p50 ${v(md.p50)} p90 ${v(md.p90)} p99 ${v(md.p99)}; >40 ms ${v(md.per40)}/min >100 ms ${v(md.per100)}/min; work ${v(md.work)} wait ${v(md.wait)} ms/frame; GPU ${md.gpuMean !== null ? `${md.gpuMean} ms/frame p90 ${v(md.gpuP90)}${md.runMean !== null ? `, draw run ${md.runMean}` : ''}${md.fenceMean !== null ? `, fence backlog ${md.fenceMean}` : ''}` : g.gpuStates.join('/') || '-'}; data waits ${v(md.dataMsPerMin)} ms/min; visible ${md.visible !== null ? Math.round(md.visible * 100) + '%' : '-'}`);
    // (a session with other minutes than play: its play percentiles from its play summaries — a Windows game —, else only
    // bounded by its worst play minute's, and its frames left out of this merge)
    const how = [g.merged.fromSummaries ? `${g.merged.fromSummaries} session(s) from their play summaries` : '', g.merged.bounded ? `${g.merged.bounded} session(s) left out: their percentiles only bounded` : ''].filter(Boolean).join('; ');
    L.push(`  play frames merged${how ? ` (${how})` : ''}: p50 ${v(g.merged.p50)} p90 ${v(g.merged.p90)} p99 ${v(g.merged.p99)} max ${v(g.merged.max)} ms`);
    if (g.pace) L.push(`  all sessions' ${paceText(g.pace)}`);
    if (g.slowShares) L.push(`  slow frames' time by cause (%): ${Object.entries(g.slowShares).map(([k, x]) => `${k} ${x}`).join(', ')}`);
    if (g.extra) L.push(`  other minute fields (mean over the play frames): ${pairs(g.extra)}`);
    for (const w of g.worst) L.push(`  worst play minute: ${w.session} t=${w.t}s ${w.ph ?? '-'} ${w.fps} fps p99 ${v(w.p99)} >40 ms ${w.per40}/min${w.work !== undefined ? ` work ${w.work} wait ${w.wait}` : ''}${w.gpu?.n ? ` gpu ${w.gpu.mean}` : ''}${w.data?.ms ? ` data ${w.data.ms} ms` : ''}${w.slow ? ` slow: ${Object.entries(w.slow).map(([k, x]) => `${k} ${x}`).join(', ')}` : ''}`);
    if (g.probe) L.push(`  host timing: Atomics.wait(1) late p50 ${v(g.probe.atomicsWait1P50)} ms, setTimeout(1) ${v(g.probe.setTimeout1P50)} ms (median of ${g.probe.n}); ${g.probe.onBattery} on battery`);
    for (const s of g.perSession) L.push(`    ${(s.at ?? '').slice(0, 16).replace('T', ' ')} ${s.session} ${s.seconds} s of play${apart(s.windows, 's') ? ` (set apart: ${apart(s.windows, 's')})` : ''}${s.visible !== null && s.visible < 0.99 ? ` (visible ${Math.round(s.visible * 100)}%)` : ''}${s.final ? '' : ' (no end record)'}: ${v(s.fps)} fps p99 ${s.pct === 'bound' ? `≤${v(s.bound.p99)}` : `${v(s.p99)}${s.pct === 'summaries' ? ' (summaries)' : ''}`} >40 ${v(s.per40)}/min work ${v(s.work)} gpu ${s.gpu ? s.gpu.mean : v(s.gpuState)}${s.gpuRun ? ` run ${s.gpuRun.mean}` : ''}${s.gpuFence ? ` fence ${s.gpuFence.mean}` : ''}${s.pace?.jud !== null && s.pace?.jud !== undefined ? ` judder ${s.pace.jud}` : ''}${s.tier ? ` tier ${s.tier}` : ''} | ${s.machine}${s.build ? ` | build ${s.build}` : ''}`);
  }
  return L.join('\n');
}

function main(args) {
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const valued = new Set(['--from', '--to', '--session', '--game', '--gpu', '--min-seconds']);
  const inputs = []; let benchName, suiteRun;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.has(a)) { i++; continue; }
    // (--bench [name]: a name unless the next argument is a flag or an existing path; without one, every bench)
    if (a === '--bench') { const n = args[i + 1]; if (n && !n.startsWith('--') && !fs.existsSync(n)) { benchName = n; i++; } else benchName = true; continue; }
    if (a === '--suite') { const n = args[i + 1]; if (n && !n.startsWith('--') && !fs.existsSync(n)) { suiteRun = n; i++; } else suiteRun = true; continue; }
    if (!a.startsWith('--')) inputs.push(a);
  }
  if (!inputs.length) { console.error('usage: node tools/dev/telemetry-report.mjs <telemetry dir | file.jsonl>... [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--session id] [--game manifest] [--bench [name]] [--suite [run]] [--players] [--compat] [--perf [--gpu name]] [--min-seconds 60] [--json]'); return 2; }
  const range = { from: opt('from', null), to: opt('to', null) };
  if (args.includes('--perf')) {
    const lines = readLines(telemetryFiles([...new Set(inputs)], range)), sel = { ...range, session: opt('session', null), game: opt('game', null) };
    // (a Windows game's page sends its samples as well: they tell its minutes' videos, menus and hidden tab apart)
    // (and its ~20 s summaries: the play windows' exact frame-time histograms)
    const classic = [...buildSessions(lines, sel).values()], samples = new Map(classic.map((s) => [s.id, s.samples])), summaries = new Map(classic.map((s) => [s.id, s.summaries]));
    const groups = perfReport(perfSessions(lines, { ...sel, gpu: opt('gpu', null), players: args.includes('--players') }), { minSeconds: Number(opt('min-seconds', 60)), samples, summaries });
    console.log(args.includes('--json') ? JSON.stringify(groups, null, 1) : formatPerf(groups));
    return 0;
  }
  const sessions = buildSessions(readLines(telemetryFiles([...new Set(inputs)], range)), { ...range, session: opt('session', null), game: opt('game', null) });
  if (args.includes('--compat')) {
    const groups = compatByGame(sessions, { players: args.includes('--players') });
    console.log(args.includes('--json') ? JSON.stringify(groups, null, 1) : formatCompat(groups));
    return 0;
  }
  if (suiteRun !== undefined) {
    const runs = suiteRuns(sessions, suiteRun === true ? null : suiteRun);
    if (args.includes('--json')) console.log(JSON.stringify({ suites: runs }, null, 1));
    else console.log(runs.length ? formatSuites(runs) : 'no bench suite run');
    return 0;
  }
  const reports = report(sessions, { minSeconds: Number(opt('min-seconds', 60)), bench: benchName, players: args.includes('--players') });
  const comparison = benchComparison(reports);
  if (args.includes('--json')) console.log(JSON.stringify({ sessions: reports, benches: comparison }, null, 1));
  else console.log(formatReport(reports, comparison));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
