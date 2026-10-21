// When a game whose page cannot tell it is playable reaches that point (a Windows game: the page knows nothing of its
// menus): the launch set's mark (GameData.mark('playable') for the engines that run in the page; launch-set.js), the
// same for every Windows game — no per-game rule. The game is taken as playable at the end of its first stretch of
// `quietMs` that looks like a menu or a game in play, not like a loading or a movie:
//   - it presents frames, at least `minFps` a second (a loading that blocks on its reads presents few or none);
//   - none of its reads waited for the network (a loading over a slow link, its frames drawn by another thread);
//   - it read little of its files, `maxReadBps` at most on average (a loading from this browser's copy reads megabytes a
//     second; music streamed from an archive tens of KB a second), and nothing of a movie (an intro playing);
//   - it waits part of the time, `maxBusy` of it running at most (a menu waits for its next frame; a loading that
//     computes draws its splash screen between steps of work).
// Seen on BFME's first start (headless, 2026-10-21): with 5 s at 10 fps it marked its splash screen (69 MB read, two
// minutes of computation before its menu): a splash fading at 10-23 fps, idle half the time, for 5-10 s — hence 10 s at
// 20 fps; its menu draws at 30 fps, idle three quarters of the time.
// ReadLog keeps what the game reads, by 64 KiB pieces, as the server learns reads (`[path, start, end, t]`, t: ms from
// the session's first read): reported every so often, as the engines that run in the page do (data-worker.js) — the
// server sees only the reads that reach the network, not those this browser's copy or the learned prefetch answered —,
// the reads before the mark with it: the server flags them (server.js learnMark).
import { CHUNK } from './http-backend.js';

export class PlayableWatch {
  /** @param {{ quietMs?: number, minFps?: number, maxReadBps?: number, maxBusy?: number }} [o] */
  constructor({ quietMs = 10000, minFps = 20, maxReadBps = 96 * 1024, maxBusy = 0.8 } = {}) {
    this.quietMs = quietMs; this.minFps = minFps; this.maxReadBps = maxReadBps; this.maxBusy = maxBusy;
    this.samples = []; // ({ at, frames, bytes, videoBytes, requests, busyMs }: the last quietMs of steps)
    this.done = false;
  }
  /**
   * Each step of the page (every few hundred ms): true once, when the game is playable. `s`: { frames (presented so
   * far), bytes (read of its files so far), videoBytes (of movies), requests (reads that went to the network so far),
   * busyMs (ms the game ran so far: its threads not all waiting) }.
   */
  step(now, s) {
    if (this.done) return false;
    // (the last `quietMs`, sliding: its first sample the latest at least that old)
    const w = this.samples; w.push({ at: now, ...s });
    while (w.length > 1 && w[1].at <= now - this.quietMs) w.shift();
    const a = w[0], b = w.at(-1);
    if (now - a.at < this.quietMs || s.bytes === 0) return false;
    // (each half too: a stretch that only averages out — the end of a loading, then a menu — is not one yet)
    const mid = w.find((x) => x.at >= a.at + (now - a.at) / 2) ?? b;
    if (!this.quiet(a, b) || !this.quiet(a, mid) || !this.quiet(mid, b)) return false;
    this.done = true; this.samples = [];
    return true;
  }
  /** From sample `a` to `b`: frames at minFps, no read waited for the network, no movie, few bytes read, waits. */
  quiet(a, b) {
    const ms = b.at - a.at; if (ms <= 0) return true;
    return b.requests === a.requests && b.videoBytes === a.videoBytes && b.bytes - a.bytes <= (ms / 1000) * this.maxReadBps
      && b.frames - a.frames >= (ms / 1000) * this.minFps && (b.busyMs ?? 0) - (a.busyMs ?? 0) <= ms * this.maxBusy;
  }
}

/**
 * The reads of a session's game, per version: by 64 KiB pieces, the first time each was read (whatever answered it:
 * this browser's copy, memory, the network — the server sees only the last), taken by the reports to the server.
 */
export class ReadLog {
  constructor(max = 200000) { this.max = max; this.t0 = null; this.parts = new Map(); this.count = 0; }
  /** A read of [start, end) of `path` in version `name`. */
  add(name, path, start, end, now) {
    if (this.count >= this.max || end <= start) return;
    this.t0 ??= now;
    let v = this.parts.get(name); if (!v) this.parts.set(name, v = { seen: new Map(), reads: [] });
    let s = v.seen.get(path); if (!s) v.seen.set(path, s = new Set());
    const t = Math.round(now - this.t0);
    for (let c = Math.floor(start / CHUNK), e = Math.floor((end - 1) / CHUNK); c <= e; c++) {
      if (s.has(c)) continue;
      if (++this.count > this.max) return;
      s.add(c);
      // (pieces of one file in sequence: one range, at its first piece's time)
      const last = v.reads.at(-1), a = c * CHUNK;
      if (last && last[0] === path && last[2] === a) { last[2] = a + CHUNK; continue; }
      v.reads.push([path, a, a + CHUNK, t]);
    }
  }
  /** The reads of version `name` not taken yet, at most `n`: [path, start, end, t], ends within `size(path)`. */
  take(name, size, n = 40000) {
    const v = this.parts.get(name);
    return v ? v.reads.splice(0, n).map(([p, a, b, t]) => [p, a, Math.min(b, size(p) ?? b), t]).filter((r) => r[2] > r[1]) : [];
  }
  get names() { return [...this.parts.keys()]; }
}
