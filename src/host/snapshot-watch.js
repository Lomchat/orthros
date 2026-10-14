// When a session takes its automatic snapshot (docs/snapshot.md, stage 2): once the game has settled on a screen — it
// opened no file for a while as it went on presenting frames: a loading step is over — at the next quiet point of the
// machine. Again at each later settled stretch after more files were opened (an intro that streams its video settles
// too: the menu after it is a later point, more start-up work skipped), until the player's first click or key: the
// state from there holds their choices. A capture refused (a movie playing, a kind of state not supported yet) is tried
// again after the next settled stretch, a few times. A snapshot is kept once the session went on running after it (not
// the state of a launch about to fail) — if the profile is still as its machine saw it (the game may have written its
// settings just after); else dropped, and taken again later. A session restored from a snapshot goes on the same way.

export class SnapshotWatch {
  /**
   * @param {{ quietMs?: number, minFps?: number, tries?: number, keepMs?: number, keepFrames?: number }} [o]
   *   quietMs: no file opened for that long, with at least minFps frames per second meanwhile; keepMs / keepFrames: how
   *   long the session must go on after the capture for the snapshot to be kept
   */
  constructor({ quietMs = 4000, minFps = 5, tries = 4, keepMs = 20000, keepFrames = 100, opens = 0 } = {}) {
    this.quietMs = quietMs; this.minFps = minFps; this.left = tries; this.keepMs = keepMs; this.keepFrames = keepFrames;
    this.opens = -1; this.since = 0; this.frames = 0;
    this.base = opens; // (files opened when the machine was last as a snapshot has it: taken, or restored from)
    this.taken = null; // ({ at, frames, opens }: a capture waiting to be kept)
    this.last = false; // (the player acted: the capture waiting is the last one)
    this.done = false;
  }
  /** Each pump: true when a capture should be tried now (`opens`: files the game opened so far; `frames`: presented). */
  due(now, frames, opens) {
    if (this.done || this.last || this.taken) return false;
    if (opens !== this.opens) { this.opens = opens; this.since = now; this.frames = frames; return false; }
    return opens !== this.base && now - this.since >= this.quietMs && frames - this.frames >= (this.quietMs / 1000) * this.minFps;
  }
  /** The capture was tried: taken, or refused (another settled stretch first, while tries are left). */
  tried(ok, now, frames) {
    if (ok) { this.taken = { at: now, frames, opens: this.opens }; return; }
    if (--this.left <= 0) this.done = true;
    this.since = now; this.frames = frames;
  }
  /** Each pump after a capture: true when the session went on long enough for the snapshot to be kept (then kept / dropped). */
  ripe(now, frames) { return !!this.taken && !this.done && now - this.taken.at >= this.keepMs && frames - this.taken.frames >= this.keepFrames; }
  /** Kept: another one at a later settled stretch, after more files were opened. */
  kept() { this.base = this.taken.opens; this.taken = null; if (this.last) this.done = true; }
  /** Not kept (the profile changed meanwhile): another settled stretch, while tries are left. */
  dropped(now, frames) { this.taken = null; this.tried(false, now, frames); if (this.last) this.done = true; }
  /** The player clicked or pressed a key: no capture from now on (the one waiting may still be kept). */
  stop() { this.last = true; if (!this.taken) this.done = true; }
}
