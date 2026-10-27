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
// - a load (docs/slow-network.md "Silence during a load"): while the game is blocked in a dense run of reads it really
//   waits for (wait/waitEnd: a parked read, a synchronous one — not a read fetched ahead that nothing waits for), a link
//   that is not fast carries only what that load needs: the turns promoted by a parked read (urgent) and those flagged
//   forLoad; the others stay queued until the load is over (loading()), and an allowed one is small (requestBytes()).

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
/** the rate is measured over the answers that ended within this much time (ms, see sample) */
const HORIZON_MS = 20000;
/**
 * A load (see loading): at least LOAD_WAITS reads the game waited for began within LOAD_WINDOW_MS, the last of them
 * ended less than loadGap() ago (LOAD_GAP_MS at least, LOAD_GAP_RTTS round trips) — one wait in play alone silences
 * nothing past its own end
 */
export const LOAD_WAITS = 3, LOAD_WINDOW_MS = 4000, LOAD_GAP_MS = 500, LOAD_GAP_RTTS = 4;
/**
 * a run of waits that has lasted LOAD_LONG_MS (a load, not a few reads in play) ends only after a pause of LOAD_HOLD_MS:
 * its engine's own work between two reads (a save parsed, a scene built) can last longer than loadGap()'s few round
 * trips, and each such pause released every queued download, whole blocks too, into the load's next reads
 */
export const LOAD_LONG_MS = 4000, LOAD_HOLD_MS = 2000;
/** while loading, a background request carries at most this many round trips of the link (see requestBytes) */
const LOAD_REQUEST_RTTS = 2;
/** requests a browser runs at once to an HTTP/1.x origin (Chrome: six connections per host; see h1) */
export const H1_CONNECTIONS = 6;

export class NetLink {
  /**
   * @param {{ now?: () => number, bw?: number, fixed?: boolean, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void, protocol?: string }} [opts]
   *   bw: the rate measured on this link last time (bytes/s), the estimate until this session measures its own;
   *   protocol: the origin's HTTP version, as nextHopProtocol says it (else found by h1)
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
    this.totals = { demandBytes: 0, demandRequests: 0, demandMs: 0, bgBytes: 0, bgRequests: 0, abortedRequests: 0, rawBytes: 0, waits: 0, waitMs: 0 };
    // bandwidth window: bytes received and link busy time since the last sample
    // (bandwidth window: the transfer intervals of the answers that ended in it — from their first byte, else from their
    // start plus a round trip, to their end — and their wire bytes; see sample)
    this.winStart = this.now(); this.winIntervals = []; this.winBytes = 0;
    /** the answers ended within HORIZON_MS: [transfer start, end, wire bytes] (see sample) */
    this.hist = [];
    /** background downloads waiting for their turn: { prio, quietMs, resolve, urgent } */
    this.waiters = []; this.timer = null;
    /** background requests in flight: Set of { bytes, t0, abort } */
    this.bgFlights = new Set();
    /** turns given to background downloads that have not begun their request yet (times given) */
    this.reserved = [];
    /** the game's reads in flight (their tokens) */
    this.demandFlights = new Set();
    /** the reads the game waits for now (wait's tokens), the times the latest ones began, when the last one ended */
    this.waitsNow = new Set(); this.waitStarts = []; this.lastWaitEnd = -1e9;
    /** when the current run of waits began (its first wait after a pause of loadGap(): see loadGap) */
    this.runT0 = -1e9;
    /**
     * the background bytes by producer (begin's `reason`: pf1/pf2 learned pieces / rest of their blocks, pf whole learned
     * blocks, ahead, readAhead, mediaAhead, miss, want, near, later, upgrade, offline): { requests, wire, raw, inLoad —
     * wire bytes of the requests begun during a load }
     */
    this.bgBy = {};
    /**
     * the origin's HTTP version as the browser negotiated it (PerformanceResourceTiming.nextHopProtocol: 'http/1.1', 'h2',
     * 'h3'), null until one of its answers tells it (see h1); `protocol` given: fixed (tests)
     */
    this.protocol = typeof opts.protocol === 'string' ? opts.protocol : null;
  }

  /**
   * The origin speaks HTTP/1.x (a local server, `make serve`; the production front speaks HTTP/2): the browser runs
   * H1_CONNECTIONS requests to it at once, the others queued in the order they came — not the link's priorities: a
   * request beyond them waits behind every one started before it, the game's reads too. Known from the first answer the
   * browser's resource timing lists (this context's own requests); false until then.
   */
  h1() {
    if (this.protocol === null && typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      for (const e of performance.getEntriesByType('resource')) if (e.nextHopProtocol) { this.protocol = e.nextHopProtocol; break; }
    }
    return /^http\/1/i.test(this.protocol ?? '');
  }

  /**
   * The game is blocked on a read (a parked read, a synchronous one, a page's read its engine waits for): its token for
   * waitEnd. Not a request: what feeds loading() — a read fetched ahead that nothing waits for is no wait.
   */
  wait() {
    const t = { t0: this.now() };
    // (the first wait after a pause: a new run)
    if (!this.waitsNow.size && t.t0 - this.lastWaitEnd >= this.loadGap()) this.runT0 = t.t0;
    this.waitsNow.add(t); this.waitStarts.push(t.t0); this.totals.waits++;
    if (this.waitStarts.length > 64) this.waitStarts.shift();
    return t;
  }
  /** The read of wait token `t` is here (or failed): the game goes on. */
  waitEnd(t) {
    if (!t || !this.waitsNow.delete(t)) return;
    this.lastWaitEnd = this.now(); this.totals.waitMs += this.lastWaitEnd - t.t0;
    this.kick();
  }
  /**
   * after a dense run of waits, a pause this long (ms) ends the load: a few round trips, LOAD_GAP_MS at least —
   * LOAD_HOLD_MS once the run has lasted LOAD_LONG_MS
   */
  loadGap() {
    const g = Math.max(LOAD_GAP_MS, LOAD_GAP_RTTS * (this.rtt ?? 0));
    return this.lastWaitEnd - this.runT0 >= LOAD_LONG_MS ? Math.max(g, LOAD_HOLD_MS) : g;
  }
  /**
   * The game is loading: a read it waits for is in flight, or a dense run of them (LOAD_WAITS within LOAD_WINDOW_MS)
   * ended less than loadGap() ago — the engine's work between two reads of a load is no pause.
   */
  loading() {
    if (this.waitsNow.size) return true;
    const now = this.now();
    if (now - this.lastWaitEnd >= this.loadGap()) return false;
    let n = 0; for (let i = this.waitStarts.length - 1; i >= 0 && now - this.waitStarts[i] < LOAD_WINDOW_MS; i--) n++;
    return n >= LOAD_WAITS;
  }
  /** The background keeps to the load's own needs now: a load on a link that is not fast (a fast one keeps its policies). */
  silenced() { return !this.fast() && this.loading(); }
  /**
   * File bytes one background request may carry now: backgroundBytes(), and while silenced() at most LOAD_REQUEST_RTTS
   * round trips of the link — a parked read that waits for a request on its way waits about that long, not a block's time.
   */
  requestBytes() {
    const b = this.backgroundBytes();
    if (!this.bw || !this.silenced()) return b;
    return Math.max(MIN_BG, Math.min(b, Math.floor(this.bw * LOAD_REQUEST_RTTS * (this.rtt ?? 0) / 1000 / this.ratio() / MIN_BG) * MIN_BG));
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
  maxBackground() { return this.bw === null && !this.fixed ? 2 : this.fast() ? 64 : 8; }
  /** bytes a demand read may fetch past what the game asked for (`cap`: the caller's own limit) */
  demandExtra(cap) { return this.bw === null ? (this.fixed ? cap : Math.min(cap, UNKNOWN_BG)) : Math.min(cap, Math.floor(this.bw * DEMAND_SECONDS / this.ratio())); }

  /**
   * A request starts: `kind` 'demand' (the game waits for it) or 'bg' — `reason` the background producer's (counted in
   * bgBy: which of them carried what). Returns its token for end().
   */
  begin(kind, bytes = 0, abort = null, range = null, reason = 'other') {
    const t = { kind, t0: this.now(), bytes, abort, range, tx: null, reason };
    this.inflight[kind]++;
    if (kind === 'bg' && this.loading()) t.inLoad = true; // (started during a load: see bgBy's inLoad)
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
      if (t.kind === 'demand') { this.totals.demandBytes += wire; this.totals.demandRequests++; } else {
        this.totals.bgBytes += wire; this.totals.bgRequests++;
        const r = (this.bgBy[t.reason] ??= { requests: 0, wire: 0, raw: 0, inLoad: 0 });
        r.requests++; r.wire += wire; r.raw += raw; if (t.inLoad) r.inLoad += wire;
      }
      this.totals.rawBytes += raw;
      // (the round trip from small answers only: a large one's time is mostly its transfer)
      if (wire <= RTT_BYTES) this.rtt = this.rtt === null ? ms : Math.min(this.rtt, ms);
      this.winBytes += wire;
      const a = t.tx ?? Math.min(now, t.t0 + (this.rtt ?? 0));
      this.winIntervals.push([a, now]);
      this.hist.push([a, now, wire]);
      this.sample(now);
    } else if (t.kind === 'bg') this.totals.abortedRequests++;
    this.kick();
  }
  /**
   * A bandwidth sample once the window (the answers ended since the last sample) holds enough: the wire bytes of the
   * answers ended within HORIZON_MS over the time bytes were arriving (the union of their transfer intervals: concurrent
   * answers count once, the waits for a first byte not at all). The time since the first answer still on its way began
   * to arrive is left out, and an answer that began before the horizon counts with its part inside it only (its bytes
   * pro rata): an answer still arriving shares the link without its bytes counted yet, and a long one that ends brings
   * its whole time back — either way the rate of a thin link carrying a long game read beside small background answers
   * read 4 times too low (85 KB/s measured as 20-35).
   */
  sample(now) {
    if (this.fixed) return;
    const busyOf = (iv) => {
      iv.sort((a, b) => a[0] - b[0]);
      let busy = 0, cs = -Infinity, ce = -Infinity;
      for (const [a, b] of iv) { if (a > ce) { if (ce > cs) busy += ce - cs; cs = a; ce = b; } else if (b > ce) ce = b; }
      if (ce > cs) busy += ce - cs;
      return busy;
    };
    const busy = busyOf(this.winIntervals.map(([a, b]) => [Math.max(a, this.winStart), b]));
    // (when nothing else is on its way — an answer ending now would count without its bytes — or the window is long)
    const idle = this.inflight.demand + this.inflight.bg === 0;
    const enough = busy >= 2000 || (idle && (busy >= 400 || (!this.measured && this.winBytes >= 48 << 10 && busy >= 20)));
    if (!enough) return;
    this.winBytes = 0; this.winIntervals = []; this.winStart = now;
    const lo = now - HORIZON_MS;
    while (this.hist.length && this.hist[0][1] <= lo) this.hist.shift();
    let hi = now;
    for (const set of [this.demandFlights, this.bgFlights]) for (const t of set) if (!t.ended) hi = Math.min(hi, t.tx ?? t.t0 + (this.rtt ?? 0));
    let bytes = 0; const iv = [];
    for (const [a, b, w] of this.hist) {
      const ca = Math.max(a, lo), cb = Math.min(b, hi);
      if (cb <= ca) continue;
      bytes += b > a ? w * (cb - ca) / (b - a) : w;
      iv.push([ca, cb]);
    }
    const span = busyOf(iv);
    if (span < (this.measured ? 300 : 20) || bytes <= 0) return;
    const s = bytes / span * 1000;
    this.bw = this.measured && this.bw ? this.bw * 0.6 + s * 0.4 : s;
    this.measured = true;
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

  /**
   * True when a background download of priority `quietMs` may start now: `urgent` (a parked read waits for it) at once;
   * while silenced() (a load) only one `forLoad` (what the load needs), by the same rules as outside a load.
   */
  mayStart(quietMs, urgent = false, bytes = 0, forLoad = false) {
    if (urgent) return true;
    const quiet = this.silenced();
    if (quiet && !forLoad) return false;
    const n = this.bgCount();
    if (n >= this.maxBackground()) return false;
    // (together the background requests carry about BG_SECONDS of the link: one at least)
    if (n > 0 && !this.fast() && this.bgBytes() + bytes > this.backgroundBytes()) return false;
    if (this.fast()) return quietMs <= 0 || this.inflight.demand === 0 && this.now() - this.lastDemandEnd >= quietMs;
    // (a thin link: the game's reads alone on it, then a quiet time; between thin and fast: beside them, the bytes in
    // flight — the game's and the background's — within about BG_SECONDS of the link: a game read waits at most that
    // long more, and the round trips of a run of small reads no longer leave the link idle)
    if (this.thin()) return this.inflight.demand === 0 && this.now() - this.lastDemandEnd >= quietMs;
    // (a load's own download larger than the bytes rule — queued before the load, at the size of a link then free —
    // goes when nothing else is on the link, or it would wait for the load to end, the load's next pieces behind it;
    // those queued during a load are small: requestBytes)
    return n + this.inflight.demand === 0 || this.bgBytes() + this.demandBytes() + bytes <= this.backgroundBytes();
  }
  /**
   * Wait for a background download's turn: `prio` orders the waiting ones (lower first), `quietMs` the time since the
   * game's last read it waits for (0 on a fast link: no wait). `w.urgent` set meanwhile (a parked read waits for this
   * download) lets it start at once. Resolves to true, or false once `stop()` holds.
   */
  // (`w.forLoad`: the download is what a load under way needs — it may start during the load, see mayStart)
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
    if (this.waiters.length || !this.mayStart(quietMs, w.urgent, bytes, w.forLoad)) return false;
    this.reserved.push({ t: this.now(), bytes });
    return true;
  }
  /** Let the waiting downloads whose turn has come start (in priority order); wake up again when a quiet delay ends. */
  kick() {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    // (the stopped ones go first, wherever they wait)
    for (let i = 0; i < this.waiters.length; i++) { const w = this.waiters[i]; if (w.stop?.()) { this.waiters.splice(i--, 1); w.resolve(false); } }
    const quiet = this.silenced();
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      // (a load: the ones it does not need stay queued, out of the priority order meanwhile — the timer looks again)
      if (quiet && !w.urgent && !w.forLoad) continue;
      // (the request starts after this resolves: counted as in flight now so the next ones see it)
      if (this.mayStart(w.quietMs, w.urgent, w.bytes ?? 0, w.forLoad)) { this.waiters.splice(i--, 1); this.reserved.push({ t: this.now(), bytes: w.bytes ?? 0 }); w.resolve(true); continue; }
      if (!w.urgent) break; // (strict priority: a later one does not pass one that waits)
    }
    if (this.waiters.length) {
      const w = this.waiters[0];
      const due = Math.max(20, w.quietMs - (this.now() - this.lastDemandEnd));
      this.timer = this.setTimer(() => { this.timer = null; this.kick(); }, Math.min(due, 250));
    }
  }
  /**
   * The download `w` (see turn) is now what a load under way needs (an announced list names a predicted place's): it may
   * pass the load's silence and ranks at `prio` among the waiting ones — by the count and bytes rules still (mayStart),
   * not urgent as promote's.
   */
  forLoad(w, prio) {
    if (!w || w.forLoad) return;
    w.forLoad = true;
    if (this.waiters.includes(w)) { if (Number.isFinite(prio)) w.prio = Math.min(w.prio, prio); this.waiters.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || a.prio - b.prio); this.kick(); }
  }
  /** The waiting download `w` (see turn) is now waited for by the game: it goes first. */
  promote(w) {
    if (!w || w.urgent) return;
    w.urgent = true;
    if (this.waiters.includes(w)) { this.waiters.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || a.prio - b.prio); this.kick(); }
  }
  /** A snapshot for the page and the reports. */
  snapshot() {
    return { bw: this.bw === null ? null : Math.round(this.bw), measured: this.measured, rtt: this.rtt === null ? null : Math.round(this.rtt), demandInFlight: this.inflight.demand, bgInFlight: this.inflight.bg, waiting: this.waiters.length, loading: this.loading(), ...this.totals, bgBy: Object.fromEntries(Object.entries(this.bgBy).map(([k, v]) => [k, { ...v }])) };
  }
}
