// When a game whose page cannot tell it is playable reaches that point (a Windows game: the page knows nothing of its
// menus): the launch set's mark (GameData.mark('playable') for the engines that run in the page; launch-set.js), the
// same for every Windows game — no per-game rule. The game is taken as playable at the end of its first stretch of
// `quietMs` that looks like a menu or a game in play, not like a loading or a movie:
//   - it presents frames, at least `minFps` a second (a loading that blocks on its reads presents few or none);
//   - none of its reads waited for the network (a loading over a slow link, its frames drawn by another thread);
//   - it read little of its files, `maxReadBps` at most on average (a loading from this browser's copy reads megabytes a
//     second; music streamed from an archive tens of KB a second), and nothing of a movie (an intro playing);
//   - it paces itself, `minPacing` of the time at least (its threads waiting for their timers — frame-acct.js `wait`
//     and `sleep`: a menu waits for its next frame; a loading that computes draws its splash screen between steps of
//     work without waiting).
// Seen on BFME's first start (headless, 2026-10-21): with 5 s at 10 fps it marked its splash screen (69 MB read, two
// minutes of computation before its menu): a splash fading at 10-23 fps, idle half the time, for 5-10 s — hence 10 s at
// 20 fps; its menu draws at 30 fps, waiting 50-80 % of each frame (the worker's pump itself is busy all along: not a
// measure of it).
// ReadLog keeps what the game reads, by 64 KiB pieces, as the server learns reads (`[path, start, end, t]`, t: ms from
// the session's first read): reported every so often, as the engines that run in the page do (data-worker.js) — the
// server sees only the reads that reach the network, not those this browser's copy or the learned prefetch answered —,
// the reads before the mark with it: the server flags them (server.js learnMark).
import { CHUNK } from './http-backend.js';

export class PlayableWatch {
  /** @param {{ quietMs?: number, minFps?: number, maxReadBps?: number, minPacing?: number }} [o] */
  constructor({ quietMs = 10000, minFps = 20, maxReadBps = 96 * 1024, minPacing = 0.2 } = {}) {
    this.quietMs = quietMs; this.minFps = minFps; this.maxReadBps = maxReadBps; this.minPacing = minPacing;
    this.samples = []; // ({ at, frames, bytes, videoBytes, requests, pacingMs }: the last quietMs of steps)
    this.done = false;
  }
  /**
   * Each step of the page (every few hundred ms): true once, when the game is playable. `s`: { frames (presented so
   * far), bytes (read of its files so far), videoBytes (of movies), requests (reads that went to the network so far),
   * pacingMs (ms the game spent pacing itself so far: its threads waiting for their timers) }.
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
  /** From sample `a` to `b`: frames at minFps, no read waited for the network, no movie, few bytes read, pacing. */
  quiet(a, b) {
    const ms = b.at - a.at; if (ms <= 0) return true;
    return b.requests === a.requests && b.videoBytes === a.videoBytes && b.bytes - a.bytes <= (ms / 1000) * this.maxReadBps
      && b.frames - a.frames >= (ms / 1000) * this.minFps && (b.pacingMs ?? ms) - (a.pacingMs ?? 0) >= ms * this.minPacing;
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

/** Chrome refuses a keepalive request once the keepalive bodies in flight pass 64 KiB (the page's, all requests). */
export const KEEPALIVE_BYTES = 60000;
/** reads in one body of a final report (~50 bytes each: a body well under KEEPALIVE_BYTES) */
export const FINAL_PIECE = 1000;

/**
 * The reports of a page's reads to the server's learned order (POST /api/prefetch/<version> { session, reads, mark? }),
 * the same for the Windows worker and the data worker of the engines that run in the page:
 *   - in order: each waits for the earlier ones to be answered — a playable mark is never handled before the reads that
 *     came before it (server.js learnMark flags what the session had read by then);
 *   - a final one (the page leaving) at once, keepalive so that it outlives the page — split into bodies of FINAL_PIECE
 *     reads, keepalive only while the keepalive bodies in flight stay under KEEPALIVE_BYTES (over it Chrome fails the
 *     request at once and the reads, taken from the log, are lost), the rest as plain requests (they complete when the
 *     worker lives on, after a stop).
 */
export class ReadReports {
  constructor(o = {}) {
    this.fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.chain = Promise.resolve();
    this.keepaliveBytes = 0; // (keepalive bodies in flight)
    this.enc = new TextEncoder();
  }
  /**
   * Send `reads` (and `mark`) of version `name` for `session` — and the session's `phases` so far ([name, t], every
   * report: GameData.phase); the promise of the chain (tests).
   */
  send(name, session, reads, mark = null, final = false, phases = null) {
    const ph = phases?.length ? { phases } : {};
    const url = `/api/prefetch/${encodeURIComponent(name)}`;
    const init = (body, keepalive) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive, body });
    if (!final) {
      const body = JSON.stringify({ session, reads, ...(mark ? { mark } : {}), ...ph });
      this.chain = this.chain.then(() => this.fetch(url, init(body, false))).catch(() => {}).then(() => {});
      return this.chain;
    }
    const sent = [];
    for (let i = 0; i === 0 || i < reads.length; i += FINAL_PIECE) {
      const last = i + FINAL_PIECE >= reads.length;
      const body = JSON.stringify({ session, reads: reads.slice(i, i + FINAL_PIECE), ...(mark && last ? { mark } : {}), ...(last ? ph : {}) });
      const bytes = this.enc.encode(body).length, keepalive = this.keepaliveBytes + bytes <= KEEPALIVE_BYTES;
      if (keepalive) this.keepaliveBytes += bytes;
      let r; try { r = Promise.resolve(this.fetch(url, init(body, keepalive))); } catch (e) { r = Promise.reject(e); }
      sent.push(r.catch(() => {}).then(() => { if (keepalive) this.keepaliveBytes -= bytes; }));
    }
    return Promise.all(sent).then(() => {});
  }
}
