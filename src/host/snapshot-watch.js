// When a session takes its automatic snapshot (docs/snapshot.md, stage 2): once the game has settled on a screen — it
// opened no file for a while as it went on presenting frames: its loading is over, it waits for the player — at the
// next quiet point of the machine. A capture refused (a movie playing, a kind of state not supported yet) is tried
// again after the next settled stretch, a few times. The snapshot is kept once the session went on running after it
// (not the state of a launch about to fail) — if the profile is still as its machine saw it (the game may have written
// its settings just after: a screen before its menu); else dropped, and taken again later.

export class SnapshotWatch {
  /**
   * @param {{ quietMs?: number, minFps?: number, tries?: number, keepMs?: number, keepFrames?: number }} [o]
   *   quietMs: no file opened for that long, with at least minFps frames per second meanwhile; keepMs / keepFrames: how
   *   long the session must go on after the capture for the snapshot to be kept
   */
  constructor({ quietMs = 4000, minFps = 5, tries = 4, keepMs = 20000, keepFrames = 100 } = {}) {
    this.quietMs = quietMs; this.minFps = minFps; this.left = tries; this.keepMs = keepMs; this.keepFrames = keepFrames;
    this.opens = -1; this.since = 0; this.frames = 0;
    this.taken = null; // ({ at, frames }: a capture waiting to be kept)
    this.done = false;
  }
  /** Each pump: true when a capture should be tried now (`opens`: files the game opened so far; `frames`: presented). */
  due(now, frames, opens) {
    if (this.done || this.taken) return false;
    if (opens !== this.opens) { this.opens = opens; this.since = now; this.frames = frames; return false; }
    return now - this.since >= this.quietMs && frames - this.frames >= (this.quietMs / 1000) * this.minFps;
  }
  /** The capture was tried: taken, or refused (another settled stretch first, while tries are left). */
  tried(ok, now, frames) {
    if (ok) { this.taken = { at: now, frames }; return; }
    if (--this.left <= 0) this.done = true;
    this.since = now; this.frames = frames;
  }
  /** Each pump after a capture: true when the session went on long enough for the snapshot to be kept (then kept / dropped). */
  ripe(now, frames) { return !!this.taken && !this.done && now - this.taken.at >= this.keepMs && frames - this.taken.frames >= this.keepFrames; }
  kept() { this.done = true; }
  /** Not kept (the profile changed meanwhile): another settled stretch, while tries are left. */
  dropped(now, frames) { this.taken = null; this.tried(false, now, frames); }
}
