// Simulated player connection for the test server (--net <ms>:<Mbit/s>): every answer waits a round trip, then its bytes
// cross ONE link whose rate the answers in transfer share equally (as TCP flows sharing a player's access link do). A
// model where each answer had the whole rate to itself would make parallel downloads look free and hide the one thing
// that matters over a real connection: a background download slows the game's own reads down while both are in flight.

export class SimLink {
  /**
   * @param {{ delayMs: number, bytesPerSec: number }} net
   * @param {{ now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} [clock]
   *   (a fake clock for the tests)
   */
  constructor(net, clock = {}) {
    this.delayMs = net.delayMs; this.rate = net.bytesPerSec / 1000; // bytes per ms
    this.now = clock.now ?? (() => performance.now());
    this.setTimer = clock.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clock.clearTimer ?? ((t) => clearTimeout(t));
    /** transfers on the link: { left (bytes), go } */
    this.active = [];
    this.last = this.now();
    this.timer = null;
  }

  /**
   * Send an answer of `bytes` bytes: `go()` runs when its last byte has crossed the link (a round trip, then its share
   * of the link). Returns a cancel function (the client went away: the transfer leaves the link).
   */
  send(bytes, go) {
    const t = { left: Math.max(1, bytes), go, cancelled: false };
    const startTimer = this.setTimer(() => { if (t.cancelled) return; this.advance(); this.active.push(t); this.schedule(); }, this.delayMs);
    return () => {
      if (t.cancelled) return;
      t.cancelled = true; this.clearTimer(startTimer);
      const i = this.active.indexOf(t);
      if (i >= 0) { this.advance(); this.active.splice(i, 1); this.schedule(); }
    };
  }

  /** Bytes moved since the last event, shared equally by the transfers in flight. */
  advance() {
    const now = this.now(), n = this.active.length;
    if (n) { const share = (now - this.last) * this.rate / n; for (const t of this.active) t.left -= share; }
    this.last = now;
  }

  /** Finish the transfers done, then wake up when the next one will be. */
  schedule() {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    const done = this.active.filter((t) => t.left <= 0.5);
    if (done.length) this.active = this.active.filter((t) => t.left > 0.5);
    for (const t of done) { t.cancelled = true; t.go(); }
    if (!this.active.length) return;
    const min = Math.min(...this.active.map((t) => t.left));
    this.timer = this.setTimer(() => { this.timer = null; this.advance(); this.schedule(); }, Math.max(0, min * this.active.length / this.rate));
  }
}
