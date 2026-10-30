// Passive session performance records (docs/real-machine-bench.md "Passive session records"): every runtime's page —
// the Windows games' (src/host/web/main.js), the browser ports' (GoldSrc, re3, OpenMW) — measures its normal play
// sessions the same way and sends the same compact record (`event: "perf"`): per minute of play (a phase change starts
// a new entry) the frame rate, the frame-time percentiles, the frames over 40 / 100 ms, the work vs the wait per frame,
// the GPU time, the game data's waits; the session's totals — with what its data waits were for (the files, the
// engine's own stops, the announced reads, the background's producers: compactDataSum); the machine; the host timing
// probe once. Hidden time is
// counted apart, its frames left out. This module is the recording and the record's validation (the server's), with
// no DOM: the page's side is src/host/web/perf-page.js.
import { HIST_N, histAddSparse, histBucket, histQuantile, histSparse } from '../core/frame-acct.js';

export const PERF_VERSION = 1;
/** a record every RECORD_MS of the session (and one at its end), one entry per MINUTE_MS */
export const RECORD_MS = 120000, MINUTE_MS = 60000;
/** at most this many records a session (5 hours of play at one per 2 min), entries a record */
export const MAX_RECORDS = 150, MAX_ENTRIES = 12;
/** a phase change closes the current entry once it holds this much time (shorter: it takes the new phase) */
export const MIN_SPLIT_MS = 5000;
/** a record's size limit (the server refuses larger ones; the page trims before) */
export const PERF_MAX_BYTES = 24 * 1024;
/** frames longer than these are counted (ms) */
export const SLOW_A = 40, SLOW_B = 100;
export const RUNTIMES = ['win32', 'goldsrc', 'openmw', 're3'];

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
/** a quantile of a histogram, rounded to 0.1 ms (the open bucket's: its lower bound, 5000) */
const hq = (h, q, max) => { const v = histQuantile(h, q, max); return v === null ? null : v === Infinity ? 5000 : r1(v); };
const addTo = (into, o, k = 1) => { for (const [n, v] of Object.entries(o ?? {})) if (Number.isFinite(v)) into[n] = (into[n] ?? 0) + v * k; };
/** the largest `top` entries of `o` (scaled, rounded to 0.01, those under `min` dropped) */
const topOf = (o, top, scale = 1, min = 0.05) => {
  const e = Object.entries(o).map(([k, v]) => [k, r2(v * scale)]).filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).slice(0, top);
  return e.length ? Object.fromEntries(e) : null;
};
/** a summary's file paths: at most this many characters (their ends kept), this many files */
export const PATH_MAX = 160, TOP_FILES = 3, TOP_BG = 12;
const pathOf = (p) => (p.length > PATH_MAX ? p.slice(-PATH_MAX) : p);
const grow = (a, b) => (b === undefined || b === null ? 0 : a === undefined || a === null || b < a ? b : b - a);

/**
 * A session's data attribution (the page's `data().sum`, perf-page.js portDataSummary), compact for the record's totals:
 * `files` the TOP_FILES files waited for most, [path, ms, waits] (the shared game data's fileWaits, { path: [waits, ms] });
 * `blocked` the engine's own count of its stops for its files when it keeps one ({ count, ms, max, files: ms by path }:
 * { n, ms, max, top: [path, ms] x TOP_FILES }); `want` its waits for its announced reads (wantWaits, wantWaitMs,
 * wantTimeouts: { n, ms, to }); `bg` the background's bytes by producer (NetLink bgBy: { reason: [requests, wire KiB,
 * KiB begun during a load] }, the TOP_BG largest). Parts without anything are left out; null when none is left.
 */
export function compactDataSum(sum) {
  if (!sum || typeof sum !== 'object') return null;
  const out = {}, ms = (v) => Math.round(Number(v) || 0), top = (o, f) => Object.entries(o ?? {}).map(f).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, TOP_FILES);
  const files = top(sum.files, ([k, v]) => [pathOf(k), ms(v?.[1]), Math.round(Number(v?.[0]) || 0)]);
  if (files.length) out.files = files;
  const b = sum.blocked;
  if (b && b.count > 0) out.blocked = { n: Math.round(b.count), ms: ms(b.ms), max: ms(b.max), top: top(b.files, ([k, v]) => [pathOf(k), ms(v)]) };
  if (sum.wantWaits > 0) out.want = { n: Math.round(sum.wantWaits), ms: ms(sum.wantWaitMs), to: Math.round(sum.wantTimeouts ?? 0) };
  const bg = Object.entries(sum.bgBy ?? {}).filter(([k, v]) => KEY.test(k) && v && v.wire > 0).sort((x, y) => y[1].wire - x[1].wire).slice(0, TOP_BG)
    .map(([k, v]) => [k, [Math.round(v.requests ?? 0), Math.round(v.wire / 1024), Math.round((v.inLoad ?? 0) / 1024)]]);
  if (bg.length) out.bg = Object.fromEntries(bg);
  return Object.keys(out).length ? out : null;
}

/** Frames and time of one stretch (an entry, or the session's totals). */
class Acc {
  constructor(t0 = 0, ph = null) {
    this.t0 = t0; this.ph = ph; this.vis = 0; this.hid = 0; this.n = 0; this.h = new Array(HIST_N).fill(0); this.max = 0; this.fa = 0; this.fb = 0;
    this.dtSum = 0; this.workSum = 0; this.workN = 0; this.workDt = 0; this.cats = {}; this.catN = 0; this.slow = {};
    this.gpu = null; this.data = null; // (the cumulative counters at the start: differences at the end)
  }
  frame(dt, work) {
    this.n++; this.h[histBucket(dt)]++; this.dtSum += dt; if (dt > this.max) this.max = dt;
    if (dt > SLOW_A) this.fa++; if (dt > SLOW_B) this.fb++;
    if (work !== null && work !== undefined && work >= 0) { this.workSum += Math.min(work, dt); this.workN++; this.workDt += dt; }
  }
  interval(a, dtMs) {
    const n = a.frames ?? 0; if (!n) return;
    this.n += n; this.dtSum += dtMs;
    if (a.h) histAddSparse(this.h, a.h); else this.h[histBucket(dtMs / n)] += n;
    if ((a.max ?? 0) > this.max) this.max = a.max;
    this.fa += a.s40 ?? 0; this.fb += a.s100 ?? 0;
    if (Number.isFinite(a.w)) { this.workSum += a.w * n; this.workN += n; this.workDt += dtMs; }
    if (a.c) { addTo(this.cats, a.c, n); this.catN += n; }
    addTo(this.slow, a.sc);
  }
}

/**
 * The recording of one session. The page calls `clock(now, visible, phase)` about every second (time, visibility,
 * phase), and either `frame(dtMs, workMs, dataMs)` for each frame shown (the ports: their frame meters) or
 * `interval(acct, dtMs)` for each stats interval (Win32: frame-acct.js FrameStats.takeInterval, ~0.5 s), and
 * `counters({ gpu, data })` with the cumulative GPU timer (gpu-probe.js stats.gpu) and game data waits ({ waits, ms },
 * and `sum` the session's attribution so far: compactDataSum, in the totals).
 * `take(now, final)` gives the record when one is due (or at the end).
 */
export class PerfRecorder {
  /** @param {{ header?: object, recordMs?: number, minuteMs?: number }} [o] */
  constructor(o = {}) {
    this.header = o.header ?? {}; this.recordMs = o.recordMs ?? RECORD_MS; this.minuteMs = o.minuteMs ?? MINUTE_MS;
    this.t0 = null; this.last = null; this.visible = true; this.phase = null;
    this.cur = null; this.done = []; this.dropped = 0; this.tot = new Acc(0); this.seq = 0; this.lastRecord = null; this.ended = false;
    this.gpuNow = null; this.dataNow = null; this.dataSum = null; this.dataSumSrc = null; this.probe = null; this.probeSent = false;
    this.slowFrames = {}; // (the ports' slow frames by cause, summed ms: added to the entry's `slow`)
  }
  /** The time since the last clock goes to the visible or the hidden time; entries close at minutes and phase changes. */
  clock(now, visible = true, phase = this.phase) {
    if (this.t0 === null) { this.t0 = now; this.last = now; this.lastRecord = now; }
    const el = Math.max(0, now - this.last); this.last = now;
    this.cur ??= this.open(now);
    if (this.visible) { this.cur.vis += el; this.tot.vis += el; } else { this.cur.hid += el; this.tot.hid += el; }
    this.visible = visible;
    if (phase !== this.phase) {
      this.phase = phase;
      if (this.cur.vis + this.cur.hid >= MIN_SPLIT_MS) this.close(now); else this.cur.ph = phase;
    }
    if (this.cur && now - (this.t0 + this.cur.t0) >= this.minuteMs) this.close(now);
  }
  open(now) { const a = new Acc(now - this.t0, this.phase); a.gpu = this.gpuNow; a.data = this.dataNow; return a; }
  close(now) {
    const c = this.cur; this.cur = this.open(now);
    if (!c || (!c.n && c.vis < 1000)) return; // (hidden, or nothing shown: no entry — the totals keep its time)
    this.done.push(this.entry(c));
    if (this.done.length > MAX_ENTRIES) { this.done.shift(); this.dropped++; }
  }
  /** One shown frame (dt: since the previous one; work: the engine's part, null unknown; data: its waits for the game data). */
  frame(dtMs, workMs = null, dataMs = 0) {
    if (!this.visible || !(dtMs > 0) || this.t0 === null) return;
    this.cur ??= this.open(this.last);
    this.cur.frame(dtMs, workMs); this.tot.frame(dtMs, workMs);
    if (dtMs > SLOW_A) {
      // (a slow frame's time by cause: the game data waited for, the engine's other work, the rest — the browser,
      // the GPU, the compositor)
      const data = Math.min(dtMs, Math.max(0, dataMs || 0)), work = workMs === null || workMs === undefined ? null : Math.max(0, Math.min(dtMs, workMs) - data);
      const s = { data, ...(work === null ? { unknown: dtMs - data } : { work, other: Math.max(0, dtMs - data - work) }) };
      addTo(this.cur.slow, s); addTo(this.tot.slow, s);
    }
  }
  /** One stats interval of the frame accounting (frames, h, s40, s100, max, w, c, sc). */
  interval(a, dtMs) {
    if (!this.visible || !a || this.t0 === null) return;
    this.cur ??= this.open(this.last);
    this.cur.interval(a, dtMs); this.tot.interval(a, dtMs);
  }
  /** The cumulative counters now (GPU timer, game data waits). */
  counters({ gpu, data } = {}) {
    if (gpu !== undefined) this.gpuNow = gpu ? { state: gpu.state ?? null, frames: gpu.frames ?? 0, ms: gpu.ms ?? 0, lost: gpu.lost ?? 0, hist: gpu.hist ? Array.from(gpu.hist) : null } : null;
    if (data !== undefined) this.dataNow = data ? { waits: data.waits ?? 0, ms: data.ms ?? 0 } : null;
    // (what the waits were for: the source kept, compacted only when a record takes it — take() follows counters() in the
    // same task, so the same values; compacting every clock tick sorted every file waited for once a second)
    if (data && 'sum' in data) this.dataSumSrc = data;
    else if (data !== undefined) this.takeDataSum(); // (the source gone: what it said last kept, as when compacted at each tick)
    if (this.tot.gpu === null && this.gpuNow) this.tot.gpu = { state: this.gpuNow.state, frames: 0, ms: 0, hist: this.gpuNow.hist ? new Array(this.gpuNow.hist.length).fill(0) : null };
    if (this.tot.data === null && this.dataNow) this.tot.data = { waits: 0, ms: 0 };
  }
  /** The host timing probe's results (timing-probe.js runTimingProbe), sent once. */
  setProbe(p) { this.probe = compactProbe(p); }
  /** A stretch as a record's entry (or the totals: `total`). */
  entry(c, total = false) {
    const n = c.n, out = { t: Math.round(c.t0 / 1000), ph: c.ph ?? null, s: r1(c.vis / 1000), hid: r1(c.hid / 1000), n,
      fps: c.vis > 0 ? r1(n / (c.vis / 1000)) : 0 };
    if (n) {
      Object.assign(out, { p50: hq(c.h, 0.5, c.max), p90: hq(c.h, 0.9, c.max), p99: hq(c.h, 0.99, c.max), max: Math.round(c.max), f40: c.fa, f100: c.fb });
      if (c.workN) { out.work = r2(c.workSum / c.workN); out.wait = r2(Math.max(0, (c.workDt - c.workSum) / c.workN)); }
      if (c.catN) out.cats = topOf(c.cats, 8, 1 / c.catN);
      const slow = topOf(c.slow, 6, 1, 1); if (slow) out.slow = Object.fromEntries(Object.entries(slow).map(([k, v]) => [k, Math.round(v)]));
    }
    // GPU time per frame over the stretch (the timer's sampled windows)
    const g0 = c.gpu, g1 = this.gpuNow;
    if (g1 && g1.state === 'on') {
      const f = total ? c.gpu?.frames ?? 0 : grow(g0?.frames, g1.frames), ms = total ? c.gpu?.ms ?? 0 : grow(g0?.ms, g1.ms);
      const h = total ? c.gpu?.hist : g1.hist ? g1.hist.map((v, i) => grow(g0?.hist?.[i], v)) : null;
      out.gpu = f > 0 ? { n: f, mean: r2(ms / f), p50: h ? hq(h, 0.5, Infinity) : null, p90: h ? hq(h, 0.9, Infinity) : null, p99: h ? hq(h, 0.99, Infinity) : null } : { n: 0 };
      if (!total) { const lost = grow(g0?.lost, g1.lost); if (lost) out.gpu.lost = lost; } // (queries whose result never came)
    } else if (g1) out.gpu = { state: g1.state ?? 'none' };
    // the game data's waits (reads the engine waited for)
    const d0 = c.data, d1 = this.dataNow;
    if (d1) out.data = total ? { n: c.data?.waits ?? 0, ms: Math.round(c.data?.ms ?? 0) } : { n: grow(d0?.waits, d1.waits), ms: Math.round(grow(d0?.ms, d1.ms)) };
    if (total && this.dataSum) out.data = { ...(out.data ?? { n: 0, ms: 0 }), ...this.dataSum }; // (what the session's waits were for)
    if (total) out.h = histSparse(c.h);
    return out;
  }
  /** The totals' GPU and data parts follow the counters (added at each record). */
  syncTotals() {
    const t = this.tot, g = this.gpuNow, d = this.dataNow;
    if (g && t.gpu) { t.gpu.frames += grow(t.gpuBase?.frames, g.frames); t.gpu.ms += grow(t.gpuBase?.ms, g.ms); if (g.hist && t.gpu.hist) g.hist.forEach((v, i) => { t.gpu.hist[i] += grow(t.gpuBase?.hist?.[i], v); }); t.gpu.state = g.state; }
    if (d && t.data) { t.data.waits += grow(t.dataBase?.waits, d.waits); t.data.ms += grow(t.dataBase?.ms, d.ms); }
    t.gpuBase = g; t.dataBase = d;
  }
  /** The kept source's attribution compacted into `dataSum` (the last one known kept: the session's so far). */
  takeDataSum() {
    if (!this.dataSumSrc) return;
    const sum = this.dataSumSrc.sum; this.dataSumSrc = null;
    if (sum !== undefined) this.dataSum = compactDataSum(sum);
  }
  /** A record is due (RECORD_MS since the last one). */
  due(now) { return !this.ended && this.t0 !== null && this.seq < MAX_RECORDS && now - this.lastRecord >= this.recordMs; }
  /**
   * The record of the entries since the last one, with the session's totals so far; null when none is due (`final`:
   * the session's end — the current entry closed, then no more).
   */
  take(now, final = false) {
    if (this.ended || this.t0 === null) return null;
    if (!final && !this.due(now)) return null;
    if (final) { this.clock(now, this.visible, this.phase); this.close(now); this.ended = true; }
    if (final && !this.seq && !this.tot.n && !this.done.length) return null; // (a page that never showed a frame: nothing to send)
    else if (!this.done.length) { this.lastRecord = now; return null; } // (nothing new to say: a hidden tab sends nothing)
    this.lastRecord = now; this.syncTotals();
    this.takeDataSum();
    const rec = { event: 'perf', v: PERF_VERSION, ...this.header, seq: this.seq++, final: !!final,
      len: Math.round((now - this.t0) / 1000), vis: r1(this.tot.vis / 1000), hid: r1(this.tot.hid / 1000),
      mins: this.done.splice(0), tot: this.entry(this.tot, true) };
    if (this.dropped) { rec.dropped = this.dropped; this.dropped = 0; }
    if (this.probe && (!this.probeSent || final)) { rec.probe = this.probe; this.probeSent = true; }
    return fitRecord(rec);
  }
}

/** A record within PERF_MAX_BYTES: the totals' histogram dropped first, then the oldest entries. */
export function fitRecord(rec, max = PERF_MAX_BYTES - 2048) { // (room for the machine, added after)
  const size = () => JSON.stringify(rec).length;
  if (size() <= max) return rec;
  if (rec.tot) delete rec.tot.h;
  while (rec.mins.length && size() > max) { rec.mins.shift(); rec.dropped = (rec.dropped ?? 0) + 1; }
  return rec;
}

const PROBE_KINDS = ['atomicsWait1', 'atomicsWait1Timer', 'setTimeout0', 'setTimeout1', 'messageHop'];
/** The timing probe's results, compact: { kind: [p50, p90, max] }, the battery. */
export function compactProbe(p) {
  if (!p) return null;
  const out = {};
  for (const k of PROBE_KINDS) if (p[k]) out[k] = [p[k].p50, p[k].p90, p[k].max];
  if (p.battery) out.battery = { charging: !!p.battery.charging, level: p.battery.level };
  if (p.injected) out.injected = p.injected;
  return out;
}

// ---------------------------------------------------------------- the server's validation
const num = (v, max = 1e9) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
const int = (v, max = 1e9) => (Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
/** an object of numbers (categories): at most 24 keys */
const numMap = (o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const e = Object.entries(o).filter(([k, v]) => KEY.test(k) && num(v) !== undefined).slice(0, 24);
  return e.length ? Object.fromEntries(e) : undefined;
};
const pick = (o, spec) => {
  const out = {};
  for (const [k, f] of Object.entries(spec)) { const v = f(o?.[k]); if (v !== undefined) out[k] = v; }
  return out;
};
const nullable = (f) => (v) => (v === null ? null : f(v));
const gpuPart = (g) => {
  if (!g || typeof g !== 'object') return undefined;
  if (typeof g.state === 'string') return { state: g.state.slice(0, 16) };
  return pick(g, { n: (v) => int(v), lost: (v) => int(v), mean: (v) => num(v, 1e5), p50: nullable((v) => num(v, 1e5)), p90: nullable((v) => num(v, 1e5)), p99: nullable((v) => num(v, 1e5)) });
};
const hist = (h) => (Array.isArray(h) && h.length <= 2 * HIST_N && h.every((x) => Number.isInteger(x) && x >= 0 && x < 1e9) ? h : undefined);
const ENTRY = {
  t: (v) => int(v, 1e7), ph: nullable((v) => str(v, 24)), s: (v) => num(v, 1e7), hid: (v) => num(v, 1e7), n: (v) => int(v), fps: (v) => num(v, 1e4),
  p50: nullable((v) => num(v, 1e6)), p90: nullable((v) => num(v, 1e6)), p99: nullable((v) => num(v, 1e6)), max: (v) => num(v, 1e7), f40: (v) => int(v), f100: (v) => int(v),
  work: (v) => num(v, 1e6), wait: (v) => num(v, 1e6), cats: numMap, slow: numMap, gpu: gpuPart,
  data: (d) => (d && typeof d === 'object' ? pick(d, { n: (v) => int(v), ms: (v) => num(v) }) : undefined),
};
const path = (v) => (typeof v === 'string' && v ? pathOf(v) : undefined);
/** [path, ms] or [path, ms, waits] lists, TOP_FILES at most */
const fileList = (n) => (v) => {
  if (!Array.isArray(v)) return undefined;
  const e = v.slice(0, TOP_FILES).filter((x) => Array.isArray(x) && x.length === n && path(x[0]) && x.slice(1).every((y) => int(y) !== undefined)).map((x) => [path(x[0]), ...x.slice(1)]);
  return e.length ? e : undefined;
};
/** the totals' data: an entry's, with the session's attribution (compactDataSum) */
const TOT_DATA = { n: (v) => int(v), ms: (v) => num(v), files: fileList(3),
  blocked: (b) => (b && typeof b === 'object' ? pick(b, { n: (v) => int(v), ms: (v) => int(v), max: (v) => int(v), top: fileList(2) }) : undefined),
  want: (w) => (w && typeof w === 'object' ? pick(w, { n: (v) => int(v), ms: (v) => int(v), to: (v) => int(v) }) : undefined),
  bg: (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const e = Object.entries(o).filter(([k, v]) => KEY.test(k) && Array.isArray(v) && v.length === 3 && v.every((y) => int(y) !== undefined)).slice(0, TOP_BG);
    return e.length ? Object.fromEntries(e) : undefined;
  } };
const TIMES = (v) => (Array.isArray(v) && v.length === 3 && v.every((x) => num(x, 1e6) !== undefined) ? v : undefined);
const PROBE = Object.fromEntries([...PROBE_KINDS.map((k) => [k, TIMES]), ['battery', (b) => (b && typeof b === 'object' ? { charging: !!b.charging, level: num(b.level, 1) ?? null } : undefined)], ['injected', (v) => num(v, 1000)]]);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
/** the browser's storage (src/host/web/storage-persist.js: persisted, its usage and quota in MiB, persist() asked) */
const STORAGE = { persisted: nullable(bool), usageMB: nullable((v) => int(v, 1 << 30)), quotaMB: nullable((v) => int(v, 1 << 30)), asked: bool };
const ENV = { gpu: (v) => str(v, 200), gpuVendor: (v) => str(v, 120), gpuClass: (v) => str(v, 16), cores: (v) => int(v, 4096), memGB: (v) => num(v, 4096), ua: (v) => str(v, 400), screen: (v) => str(v, 40),
  storage: (v) => (v && typeof v === 'object' ? pick(v, STORAGE) : undefined) };

/**
 * A perf record as received (the page's JSON), checked and rebuilt from its known fields only (unknown ones dropped,
 * strings cut, numbers bounded): { ok: true, rec } or { ok: false, error }.
 */
export function sanitizePerfRecord(r) {
  if (!r || typeof r !== 'object' || r.event !== 'perf') return { ok: false, error: 'not a perf record' };
  if (r.v !== PERF_VERSION) return { ok: false, error: 'unknown version' };
  if (typeof r.session !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(r.session)) return { ok: false, error: 'bad session' };
  if (!RUNTIMES.includes(r.runtime)) return { ok: false, error: 'bad runtime' };
  const seq = int(r.seq, MAX_RECORDS); if (seq === undefined) return { ok: false, error: 'bad seq' };
  if (!Array.isArray(r.mins) || r.mins.length > MAX_ENTRIES) return { ok: false, error: 'bad entries' };
  if (!r.tot || typeof r.tot !== 'object') return { ok: false, error: 'no totals' };
  const rec = {
    event: 'perf', v: PERF_VERSION, session: r.session, game: typeof r.game === 'string' ? r.game.slice(0, 120) : null, runtime: r.runtime,
    ...pick(r, { version: nullable((v) => str(v, 80)), build: nullable((v) => str(v, 80)), tier: nullable((v) => str(v, 16)), bench: nullable((v) => str(v, 60)) }),
    seq, final: r.final === true, ...pick(r, { len: (v) => num(v, 1e7), vis: (v) => num(v, 1e7), hid: (v) => num(v, 1e7), dropped: (v) => int(v) }),
    mins: r.mins.map((e) => pick(e, ENTRY)),
    tot: { ...pick(r.tot, ENTRY), ...(r.tot.data && typeof r.tot.data === 'object' ? { data: pick(r.tot.data, TOT_DATA) } : {}), ...(hist(r.tot.h) ? { h: r.tot.h } : {}) },
  };
  if (r.env && typeof r.env === 'object') rec.env = pick(r.env, ENV);
  if (r.probe && typeof r.probe === 'object') rec.probe = pick(r.probe, PROBE);
  return { ok: true, rec };
}
