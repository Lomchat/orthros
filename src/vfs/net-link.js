// The player's connection to the server, as the game file downloads share it (docs/slow-network.md): the
// bandwidth it delivers (measured from the transfers themselves), the game's own reads in flight, and the turns of the
// background downloads (prefetch, read-ahead, block fill, offline copy). One per page: the game's folder and the games
// it requires share it.
//
// Rules (generic: they depend on the measured link only):
// - the game's reads (demand) come first: on a thin link (below THIN_BPS) a background download starts only while no
//   demand read is in flight and the link has been quiet for the download's own delay; between thin and fast it goes
//   beside them, the bytes in flight (the game's and the background's) within about BG_SECONDS of the link; a fast
//   link (FAST_BPS and more) keeps the local-network policies. The background requests in flight carry at most about
//   BG_SECONDS of the link together (several small ones at once — a latency-bound run of small files fills the link —
//   or one larger one), and at most maxBackground() of them;
// - a background request carries at most backgroundBytes() (about BG_SECONDS of the link): a demand read that comes
//   while it is on its way waits for it at most that long, and nothing needs to be aborted (an abort throws away what
//   the request had already received);
// - a demand read asks for what the game reads plus at most demandExtra() bytes past it (DEMAND_SECONDS of the
//   link): a thin link fetches what the game needs, a fast one rounds up generously (fewer round trips).

/** a background request carries about this much of the link's time (s) */
export const BG_SECONDS = 0.35;
/** a demand read rounds up by at most this much of the link's time (s) */
export const DEMAND_SECONDS = 0.25;
/** at or above this rate (bytes/s, measured) the link is "fast": the earlier policies (whole blocks, block fill, aborts) apply — measured at 5 MB/s with a 50 ms round trip, they reach the menu and the game sooner there (round trips cost more than bytes) */
export const FAST_BPS = 3 << 20;
/** below this rate (bytes/s) the link is "thin": no speculative whole blocks in the background (see thin()) */
export const THIN_BPS = 384 << 10;
const MIN_BG = 64 << 10, MAX_BG = 4 << 20;
/** request size bound while the link is not measured yet */
const UNKNOWN_BG = 256 << 10;
/** answers at most this large (wire bytes) time the round trip */
const RTT_BYTES = 16 << 10;

export class NetLink {
  /**
   * @param {{ now?: () => number, bw?: number, fixed?: boolean, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} [opts]
   *   bw: the rate measured on this link last time (bytes/s), the estimate until this session measures its own
   */
  constructor(opts = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    /** bandwidth estimate (bytes/s on the wire), null until measured (nor given) */
    this.bw = Number.isFinite(opts.bw) && opts.bw > 0 ? opts.bw : null;
    /** fixed: never measured (the estimate stays as given: null keeps the local-network policies) */
    this.fixed = !!opts.fixed;
    this.measured = false;
    /** shortest request seen (ms): the round trip, about */
    this.rtt = null;
    this.inflight = { demand: 0, bg: 0 };
    this.lastDemandEnd = -1e9;
    /** totals: wire bytes received, requests, ms the game's reads were on their way */
    this.totals = { demandBytes: 0, demandRequests: 0, demandMs: 0, bgBytes: 0, bgRequests: 0, abortedRequests: 0, rawBytes: 0 };
    // bandwidth window: bytes received and link busy time since the last sample
    // (bandwidth window: the transfer intervals of the answers that ended in it — from their first byte, else from their
    // start plus a round trip, to their end — and their wire bytes; see sample)
    this.winStart = this.now(); this.winIntervals = []; this.winBytes = 0;
    /** background downloads waiting for their turn: { prio, quietMs, resolve, urgent } */
    this.waiters = []; this.timer = null;
    /** background requests in flight: Set of { bytes, t0, abort } */
    this.bgFlights = new Set();
    /** turns given to background downloads that have not begun their request yet (times given) */
    this.reserved = [];
    /** the game's reads in flight (their tokens) */
    this.demandFlights = new Set();
  }
  /** background requests in flight or about to be (turns given within the last 500 ms) */
  bgCount() { const now = this.now(); while (this.reserved.length && now - this.reserved[0].t > 500) this.reserved.shift(); return this.inflight.bg + this.reserved.length; }
  /** file bytes of the game's reads in flight */
  demandBytes() { let n = 0; for (const t of this.demandFlights) n += t.bytes; return n; }
  /** file bytes of the background requests in flight or about to be */
  bgBytes() { let n = 0; for (const t of this.bgFlights) n += t.bytes; for (const r of this.reserved) n += r.bytes; return n; }

  /** wire bytes per file byte so far (compressed ranges: below 1), 1 until known */
  ratio() { const t = this.totals; return t.rawBytes >= 256 << 10 ? Math.max(0.15, Math.min(1, (t.demandBytes + t.bgBytes) / t.rawBytes)) : 1; }
  /** seconds the link takes to carry `bytes` of file (0 when unknown: no limit) */
  secondsFor(bytes) { return this.bw ? bytes * this.ratio() / this.bw : 0; }
  /** the link is fast enough for the local-network policies (or not measured yet and nothing says otherwise) */
  // (not measured yet: careful until the first answers measure it — a thin link's first seconds are when a 2 MiB
  // background block hurts most; a fixed link without a measure keeps the local-network policies, as tests expect)
  fast() { return this.bw === null ? this.fixed : this.bw >= FAST_BPS; }
  /** a thin link (measured below THIN_BPS): the background downloads keep to what the game is known to need */
  thin() { return this.bw !== null && this.bw < THIN_BPS; }
  /** file bytes a background request may carry (a multiple of 64 KiB) */
  backgroundBytes() {
    if (this.bw === null) return this.fixed ? MAX_BG : UNKNOWN_BG;
    return Math.max(MIN_BG, Math.min(MAX_BG, Math.floor(this.bw * BG_SECONDS / this.ratio() / MIN_BG) * MIN_BG));
  }
  /** background requests at once at most (within the bytes of backgroundBytes(), see mayStart) */
  maxBackground() { return this.bw === null && !this.fixed ? 2 : 8; }
  /** bytes a demand read may fetch past what the game asked for (`cap`: the caller's own limit) */
  demandExtra(cap) { return this.bw === null ? (this.fixed ? cap : Math.min(cap, UNKNOWN_BG)) : Math.min(cap, Math.floor(this.bw * DEMAND_SECONDS / this.ratio())); }

  /** A request starts: `kind` 'demand' (the game waits for it) or 'bg'. Returns its token for end(). */
  begin(kind, bytes = 0, abort = null, range = null) {
    const t = { kind, t0: this.now(), bytes, abort, range, tx: null };
    this.inflight[kind]++;
    if (kind === 'bg') { this.reserved.shift(); this.bgFlights.add(t); } else this.demandFlights.add(t);
    return t;
  }
  /** The answer of request `t` began to arrive (its headers): its time to the first byte, the round trip (about). */
  firstByte(t) {
    const now = this.now(), ms = now - t.t0;
    if (t.tx === null) t.tx = now;
    if (ms >= 0) this.rtt = this.rtt === null ? ms : Math.min(this.rtt, ms);
  }
  /**
   * A request ended: `wire` bytes received (the encoded body), `raw` the bytes they decode to; ok false: failed or
   * aborted (its bytes are not counted).
   */
  end(t, wire, raw = wire, ok = true) {
    if (t.ended) return; t.ended = true;
    const now = this.now(), ms = now - t.t0;
    this.inflight[t.kind]--;
    if (t.kind === 'bg') this.bgFlights.delete(t); else this.demandFlights.delete(t);
    if (t.kind === 'demand') { this.lastDemandEnd = now; this.totals.demandMs += ms; }
    if (ok) {
      if (t.kind === 'demand') { this.totals.demandBytes += wire; this.totals.demandRequests++; } else { this.totals.bgBytes += wire; this.totals.bgRequests++; }
      this.totals.rawBytes += raw;
      // (the round trip from small answers only: a large one's time is mostly its transfer)
      if (wire <= RTT_BYTES) this.rtt = this.rtt === null ? ms : Math.min(this.rtt, ms);
      this.winBytes += wire;
      this.winIntervals.push([t.tx ?? Math.min(now, t.t0 + (this.rtt ?? 0)), now]);
      this.sample(now);
    } else if (t.kind === 'bg') this.totals.abortedRequests++;
    this.kick();
  }
  /**
   * A bandwidth sample once the window holds enough: its answers' wire bytes over the time bytes were arriving (the
   * union of their transfer intervals: concurrent answers count once, the waits for a first byte not at all).
   */
  sample(now) {
    if (this.fixed) return;
    const iv = this.winIntervals.sort((a, b) => a[0] - b[0]);
    let busy = 0, cs = -Infinity, ce = -Infinity;
    for (const [a0, b] of iv) {
      const a = Math.max(a0, this.winStart - 60000); // (a long answer that began well before: its recent part only)
      if (a > ce) { if (ce > cs) busy += ce - cs; cs = a; ce = b; } else if (b > ce) ce = b;
    }
    if (ce > cs) busy += ce - cs;
    // (when nothing else is on its way — an answer ending now would count without its bytes — or the window is long)
    const idle = this.inflight.demand + this.inflight.bg === 0;
    const enough = busy >= 2000 || (idle && (busy >= 400 || (!this.measured && this.winBytes >= 48 << 10 && busy >= 20)));
    if (!enough) return;
    const s = this.winBytes / Math.max(1, busy) * 1000;
    this.bw = this.measured && this.bw ? this.bw * 0.6 + s * 0.4 : s;
    this.measured = true;
    this.winBytes = 0; this.winIntervals = []; this.winStart = now;
  }

  /**
   * Background requests in flight whose rest would hold a demand read up longer than BG_SECONDS (sized before the link
   * was measured, or the link slowed down) are aborted; the others finish (their bytes are not thrown away).
   */
  abortLong() {
    if (!this.bw) return;
    const now = this.now();
    for (const t of this.bgFlights) {
      if (!t.abort || !t.bytes || t.keep) continue;
      const left = this.secondsFor(t.bytes) - (now - t.t0) / 1000;
      if (left > BG_SECONDS * 1.5) { this.bgFlights.delete(t); t.abort(); }
    }
  }

  /**
   * A synchronous read of [start, end) of `key` (a file) is about to fetch it: background requests in flight for bytes
   * of that range are aborted (the worker cannot receive their answers while it waits: they would carry the same bytes
   * twice over the link at the same time).
   */
  abortOverlap(key, start, end) {
    for (const t of this.bgFlights) {
      const r = t.range;
      if (!t.abort || !r || r.key !== key || r.end <= start || r.start >= end) continue;
      this.bgFlights.delete(t); t.abort();
    }
  }

  /** True when a background download of priority `quietMs` may start now. */
  mayStart(quietMs, urgent = false, bytes = 0) {
    if (urgent) return true;
    const n = this.bgCount();
    if (n >= this.maxBackground()) return false;
    // (together the background requests carry about BG_SECONDS of the link: one at least)
    if (n > 0 && !this.fast() && this.bgBytes() + bytes > this.backgroundBytes()) return false;
    if (this.fast()) return quietMs <= 0 || this.inflight.demand === 0 && this.now() - this.lastDemandEnd >= quietMs;
    // (a thin link: the game's reads alone on it, then a quiet time; between thin and fast: beside them, the bytes in
    // flight — the game's and the background's — within about BG_SECONDS of the link: a game read waits at most that
    // long more, and the round trips of a run of small reads no longer leave the link idle)
    if (this.thin()) return this.inflight.demand === 0 && this.now() - this.lastDemandEnd >= quietMs;
    return n + this.inflight.demand === 0 || this.bgBytes() + this.demandBytes() + bytes <= this.backgroundBytes();
  }
  /**
   * Wait for a background download's turn: `prio` orders the waiting ones (lower first), `quietMs` the time since the
   * game's last read it waits for (0 on a fast link: no wait). `w.urgent` set meanwhile (a parked read waits for this
   * download) lets it start at once. Resolves to true, or false once `stop()` holds.
   */
  turn(prio, quietMs, stop = () => false, w = {}, bytes = 0) {
    w.bytes = bytes;
    if (this.tryTurn(quietMs, w)) return Promise.resolve(true);
    return new Promise((resolve) => {
      Object.assign(w, { prio, quietMs, resolve, stop });
      this.waiters.push(w);
      this.waiters.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || a.prio - b.prio);
      this.kick();
    });
  }
  /** The turn of a background download that may start now (none waits before it): taken, true; else false. */
  tryTurn(quietMs, w = {}, bytes = w.bytes ?? 0) {
    if (this.waiters.length || !this.mayStart(quietMs, w.urgent, bytes)) return false;
    this.reserved.push({ t: this.now(), bytes });
    return true;
  }
  /** Let the waiting downloads whose turn has come start (in priority order); wake up again when a quiet delay ends. */
  kick() {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    // (the stopped ones go first, wherever they wait)
    for (let i = 0; i < this.waiters.length; i++) { const w = this.waiters[i]; if (w.stop?.()) { this.waiters.splice(i--, 1); w.resolve(false); } }
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      // (the request starts after this resolves: counted as in flight now so the next ones see it)
      if (this.mayStart(w.quietMs, w.urgent, w.bytes ?? 0)) { this.waiters.splice(i--, 1); this.reserved.push({ t: this.now(), bytes: w.bytes ?? 0 }); w.resolve(true); continue; }
      if (!w.urgent) break; // (strict priority: a later one does not pass one that waits)
    }
    if (this.waiters.length) {
      const w = this.waiters[0];
      const due = Math.max(20, w.quietMs - (this.now() - this.lastDemandEnd));
      this.timer = this.setTimer(() => { this.timer = null; this.kick(); }, Math.min(due, 250));
    }
  }
  /** The waiting download `w` (see turn) is now waited for by the game: it goes first. */
  promote(w) {
    if (!w || w.urgent) return;
    w.urgent = true;
    if (this.waiters.includes(w)) { this.waiters.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || a.prio - b.prio); this.kick(); }
  }
  /** A snapshot for the page and the reports. */
  snapshot() {
    return { bw: this.bw === null ? null : Math.round(this.bw), measured: this.measured, rtt: this.rtt === null ? null : Math.round(this.rtt), demandInFlight: this.inflight.demand, bgInFlight: this.inflight.bg, waiting: this.waiters.length, ...this.totals };
  }
}
