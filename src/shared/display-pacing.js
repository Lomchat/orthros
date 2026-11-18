// Display pacing: how the game's frames meet the display's refreshes — a meter for the telemetry, every runtime's page —
// and, for a Windows game whose presentation interval waits for the vertical retrace, the frames aligned on the
// refreshes (the page shows them; this module has no DOM: the page hands it its requestAnimationFrame timestamps).
//
// Why the alignment: a game whose own limiter presents every 33.7 ms (BFME's 30 fps loop on timeGetTime) should show
// each frame for two refreshes of a 60 Hz screen, and one in ~45 for three (its limiter being a little slower than 30
// fps): Windows flips at the retrace. The page shows a bitmap from the first refresh after it arrives, so when the
// arrivals come within the game's own jitter (±1.5 ms) of a refresh, consecutive frames fall on either side of it and are
// held 1 and 3 refreshes in turn. The owner's display reports of 2026-11-18 (60 Hz, ANGLE D3D11): Age of the Ring, whose
// arrivals crossed a refresh during the report, 57 frames held 2 refreshes, 2 held 1 and 4 held 3 (1-3-1-3 runs);
// RotWK, whose arrivals stayed between two refreshes, 63 of 64 held 2.
//
// FramePacer, the alignment: each frame has a refresh it is due on — the previous frame's plus the game's cadence (the
// refreshes per frame its recent arrivals are apart: 2 for 33.7 ms on 60 Hz) —; one arriving before it is held until
// then (shown in that refresh's animation frame), one arriving after it is shown at the next refresh (the previous one
// stayed a refresh longer: a game slower than its cadence), one so early that it would wait more than a refresh and
// a margin is due a refresh sooner (a faster one). An arrival's jitter then never moves a frame across a refresh: only
// the drift of the game's rate against the display's does, once per cycle (2-2-...-2-3-2-2). A frame is never shown
// later than one refresh after the one it would have reached without the alignment, and that only when it arrived
// within that margin before that refresh (three times the arrivals' jitter, at most a quarter of a refresh). Frames
// whose interval does not wait for the retrace (IMMEDIATE, a Direct3D 8 windowed device without COPY_VSYNC), the 2D and
// movie layers, a hidden page or one whose animation frames stopped: shown at once, as before. The game's own timing is
// untouched: the emulator's Present does not wait more (no change the machine sees, snapshots included) — aligning
// there instead would park the game's thread up to a refresh (a slower game when its frame's work fills its budget,
// Windows' Present returning at once while the flip waits), and the frame would still cross the render worker and the
// message to the page, whose own jitter moves it across a refresh.
//
// PaceMeter: per frame the refreshes it stayed on the screen, from the animation frames' timestamps (a refresh the page
// missed still counts), as a histogram [dropped (replaced before its refresh), 1, 2, 3, 4, 5+], and the judder: the mean
// change of that count between consecutive frames shown (a still picture or a load, 5+, breaks the chain; a dropped
// frame is counted apart — a game far faster than the display drops most of its frames and shows one each refresh) —
// 0 for a steady 2-2-2, ~0.04 for 2s with a 3 every 45 frames, 2 for 1-3-1-3, 1 for 1-2-1-2.

/** histogram buckets: dropped, 1, 2, 3, 4, 5+ refreshes */
export const HOLD_BUCKETS = 6;
/**
 * The arrival's margin before a refresh within which a frame may be held to the next one to keep its cadence: three
 * times the arrivals' own jitter (from their intervals' spread), between 1 ms and a quarter of a refresh — as wide as
 * the jitter needs, no wider (a frame held there waits a refresh more).
 */
export const TOLERANCE_MIN_MS = 1, TOLERANCE_MAX = 0.25;
/** held frames at most (a burst of arrivals: the oldest are dropped) */
const QUEUE_MAX = 3;

/** The display's refreshes, from requestAnimationFrame timestamps: their period and each one's index. */
export class RefreshClock {
  constructor(period = 1000 / 60) { this.period = period; this.t = null; this.idx = -1; this.dts = []; this.k = 0; }
  /** an animation frame's timestamp: the index of its refresh (refreshes since the first one, missed ones counted) */
  tick(t) {
    if (this.t === null) { this.t = t; this.idx = 0; return 0; }
    const dt = t - this.t;
    if (!(dt > 0)) return this.idx; // (a second callback of the same frame)
    if (dt > 2 && dt < 70) { this.dts[this.k++ % 31] = dt; if (this.k % 8 === 0 && this.dts.length >= 15) this.period = periodOf(this.dts); }
    this.idx += Math.max(1, Math.round(dt / this.period));
    this.t = t;
    return this.idx;
  }
  /** the time of refresh `i` (from the last one seen) */
  at(i) { return this.t + (i - this.idx) * this.period; }
}
/** the refresh period from intervals between animation frames: the cluster of the shortest (a missed refresh doubles one) */
export function periodOf(dts) {
  const v = dts.slice().sort((a, b) => a - b), q = v[v.length >> 2], near = v.filter((d) => d >= 0.75 * q && d <= 1.25 * q);
  return near[near.length >> 1];
}
/** refreshes per frame from the arrivals' median interval in refreshes: the nearest whole number when close, else rounded down */
export function cadenceOf(r) {
  const k = Math.round(r);
  return k >= 1 && Math.abs(r - k) <= 0.2 ? Math.min(k, 4) : Math.min(4, Math.max(1, Math.floor(r)));
}

/** Refreshes per displayed frame (cumulative counters). */
export class PaceMeter {
  constructor() { this.n = 0; this.h = new Array(HOLD_BUCKETS).fill(0); this.jud = 0; this.jn = 0; this.cur = null; this.prev = -1; }
  /** a new picture is on the screen from refresh `v` */
  visible(v) {
    if (this.cur !== null) { if (v <= this.cur) this.dropped(); else this.held(v - this.cur); }
    this.cur = v;
  }
  held(k) {
    this.n++; this.h[Math.min(k, HOLD_BUCKETS - 1)]++;
    if (k >= HOLD_BUCKETS - 1) { this.prev = -1; return; }
    if (this.prev >= 0) { this.jud += Math.abs(k - this.prev); this.jn++; }
    this.prev = k;
  }
  /** a frame that never reached the screen (replaced before its refresh) */
  dropped() { this.n++; this.h[0]++; }
  /** the page hidden: the hold in progress is not counted */
  pause() { this.cur = null; this.prev = -1; }
  counters() { return { n: this.n, h: this.h.slice(), jud: this.jud, jn: this.jn }; }
}

/**
 * The frames of a Windows game, shown at once or held for their refresh (see above). `show(frame)` puts a frame on the
 * screen, `discard(frame)` frees one that will not be; `now()` the clock of the animation frames' timestamps.
 */
export class FramePacer {
  /** @param {{ show: (f: any) => void, discard?: (f: any) => void, now?: () => number, on?: boolean, tolerance?: number, setTimeout?: Function }} o */
  constructor(o) {
    this.show = o.show; this.discard = o.discard ?? (() => {}); this.now = o.now ?? (() => performance.now());
    this.setTimeout = o.setTimeout ?? ((f, ms) => setTimeout(f, ms));
    this.on = o.on ?? true; // (the alignment: off, every frame is shown at once — the meter still counts)
    this.tolerance = o.tolerance ?? null; // (a fixed margin, in refreshes: measurements; else from the jitter)
    this.margin = 0; // (the margin in use, ms)
    this.clock = new RefreshClock(); this.meter = new PaceMeter();
    this.queue = []; this.layer = null; this.last = null; this.lastAt = null; this.gaps = []; this.cadence = 1; this.jitter = null;
    this.since = 0; this.hidden = false; this.guard = false;
    this.aligned = 0; this.extra = 0; // (frames held for their refresh; of them, shown a refresh after their arrival's next one)
  }
  /** A frame of `layer`; `align`: its presentation interval waits for the retrace. */
  arrive(frame, layer, align) {
    const a = this.now(), c = this.clock;
    if (!align || !this.on || this.hidden || c.t === null || a - c.t > 4 * c.period) {
      if (layer === this.layer) { this.drop(); this.layer = null; this.last = null; this.lastAt = null; this.gaps.length = 0; }
      this.show(frame); this.since++;
      return;
    }
    if (layer !== this.layer) { this.flush(); this.layer = layer; this.last = null; this.lastAt = null; this.gaps.length = 0; }
    const P = c.period, n = c.idx + 1;
    if (this.lastAt !== null) {
      const g = a - this.lastAt;
      if (g > 0 && g < 250) { this.gaps.push(g); if (this.gaps.length > 15) this.gaps.shift(); }
      if (this.gaps.length >= 3) {
        const s = this.gaps.slice().sort((x, y) => x - y), med = s[s.length >> 1];
        this.cadence = cadenceOf(med / P);
        // (an arrival's jitter: the intervals' median absolute deviation as a standard deviation, over sqrt(2) — two arrivals each)
        const dev = s.map((g) => Math.abs(g - med)).sort((x, y) => x - y), sigma = 1.4826 * dev[dev.length >> 1] / Math.SQRT2;
        this.jitter = sigma;
      }
    }
    const tol = this.tolerance !== null ? this.tolerance * P : Math.min(TOLERANCE_MAX * P, Math.max(TOLERANCE_MIN_MS, 3 * (this.jitter ?? Infinity)));
    this.margin = tol;
    this.lastAt = a;
    // (due: the previous frame's refresh and the cadence; late — shown at the next refresh; too early — a refresh sooner)
    let due = this.last === null ? n : this.last + this.cadence;
    if (due < n) due = n;
    else if (c.at(due) - a > P + tol) { due = Math.max(n, due - 1); if (c.at(due) - a > P + tol) due = n; }
    this.last = due; this.aligned++; if (due > n) this.extra++;
    // (a frame due no later than frames held before it: those would come after a newer one — never shown)
    while (this.queue.length && this.queue[this.queue.length - 1].due >= due) { this.discard(this.queue.pop().frame); this.meter.dropped(); }
    this.queue.push({ frame, due });
    while (this.queue.length > QUEUE_MAX) { this.discard(this.queue.shift().frame); this.meter.dropped(); }
    if (!this.guard) { this.guard = true; this.setTimeout(() => this.check(), 100); }
  }
  /** an animation frame: the frames due shown (the latest of them), the meter told what this refresh shows */
  tick(t) {
    const idx = this.clock.tick(t);
    if (this.hidden) return;
    // (frames shown at once since the last refresh: on the screen from this one — all but the last never were)
    if (this.since) { for (let i = 1; i < this.since; i++) this.meter.dropped(); this.meter.visible(idx); this.since = 0; }
    let due = null;
    while (this.queue.length && this.queue[0].due <= idx) { const q = this.queue.shift(); if (due) { this.discard(due.frame); this.meter.dropped(); } due = q; }
    if (due) { this.show(due.frame); this.meter.visible(idx); }
  }
  /** the held frames: the latest shown now, the others dropped */
  flush() { if (!this.queue.length) return; const q = this.queue.pop(); this.drop(); this.show(q.frame); this.since++; }
  /** the held frames dropped */
  drop() { for (const q of this.queue.splice(0)) { this.discard(q.frame); this.meter.dropped(); } }
  /** the page hidden or shown again: frames shown at once while hidden, nothing counted */
  setHidden(h) {
    this.hidden = h; this.since = 0; this.meter.pause(); this.last = null;
    const q = h ? this.queue.splice(0) : []; // (shown, not counted)
    for (let i = 0; i < q.length - 1; i++) this.discard(q[i].frame);
    if (q.length) this.show(q[q.length - 1].frame);
  }
  /** held frames whose animation frames stopped coming (a throttled page): shown */
  check() { this.guard = false; if (!this.queue.length) return; if (this.clock.t === null || this.now() - this.clock.t > 3 * this.clock.period) this.flush(); else { this.guard = true; this.setTimeout(() => this.check(), 100); } }
  /** the cumulative counters for the telemetry (paceWindow) */
  counters() { return { ...this.meter.counters(), hz: this.clock.t === null ? null : 1000 / this.clock.period, al: this.aligned, ex: this.extra }; }
}

/**
 * The frames' pacing over a window, from two counters (FramePacer.counters, PaceMeter.counters with `hz`): { hz, n, h,
 * jud (mean change of the refreshes held between consecutive frames, 2 decimals; null without two such frames), jn
 * (their pairs), al, ex }; null when no frame was counted in it. `a` null: from the start.
 */
export function paceWindow(a, b) {
  if (!b) return null;
  const d = (k) => Math.max(0, (b[k] ?? 0) - (a?.[k] ?? 0)), n = d('n');
  if (!n) return null;
  const jn = d('jn'), out = { hz: Number.isFinite(b.hz) ? Math.round(b.hz * 10) / 10 : null, n, h: b.h.map((v, i) => Math.max(0, v - (a?.h?.[i] ?? 0))), jud: jn ? Math.round(d('jud') / jn * 100) / 100 : null, jn };
  if (b.al !== undefined) { out.al = d('al'); out.ex = d('ex'); }
  return out;
}
/** Windows merged (a stretch of summaries, a session's minutes): the same form. */
export function paceMerge(list) {
  const ws = list.filter((w) => w?.n > 0);
  if (!ws.length) return null;
  const out = { hz: ws[ws.length - 1].hz ?? null, n: 0, h: new Array(HOLD_BUCKETS).fill(0), jud: null, jn: 0 };
  let j = 0;
  for (const w of ws) { out.n += w.n; w.h.forEach((v, i) => { if (i < HOLD_BUCKETS) out.h[i] += v; }); if (w.jn) { j += (w.jud ?? 0) * w.jn; out.jn += w.jn; } if (w.al !== undefined) { out.al = (out.al ?? 0) + w.al; out.ex = (out.ex ?? 0) + (w.ex ?? 0); } }
  out.jud = out.jn ? Math.round(j / out.jn * 100) / 100 : null;
  return out;
}
/** A window in words: refreshes per frame (shares), the judder, the frames aligned. */
export function paceText(w) {
  if (!w?.n) return null;
  const pct = (v) => Math.round(v / w.n * 1000) / 10, names = ['dropped', '1', '2', '3', '4', '5+'];
  return `refreshes per frame${w.hz ? ` (${w.hz} Hz)` : ''}: ${w.h.map((v, i) => (v ? `${names[i]} ${pct(v)}%` : null)).filter(Boolean).join(', ')} of ${w.n}; judder ${w.jud ?? '-'}${w.al !== undefined ? `; aligned ${w.al}${w.ex ? ` (${w.ex} a refresh later)` : ''}` : ''}`;
}
