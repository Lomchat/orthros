// The page's sound output, kept playing under the browser's autoplay rules, and what a session's telemetry says about
// it. Chrome creates an AudioContext suspended unless the page has had a user activation (a click, a key), and
// suspends or interrupts one for reasons of its own (output device change, system audio session): the context is
// resumed at every gesture while it is not running, the page shows a "click to enable sound" button meanwhile, and
// the telemetry summaries carry the context state, the worklet's progress, the mixer's level and the game's sound
// buffers — a player's "no sound" can then be told apart: context suspended, worklet stalled, or a silent mix.

/** user activation events (the ones that let a page start audio) */
export const GESTURES = ['pointerdown', 'mousedown', 'keydown', 'touchend', 'click'];

/**
 * Resume `ctx` at each user gesture on `target` while it is not running. Capture phase on the window: no handler of
 * the page (the game's input, a bench swallowing the player's input) can stop it. `onTry` is told before each
 * attempt. Returns a function removing the listeners.
 * @param {{ state: string, resume: () => Promise<void> }} ctx
 * @param {EventTarget} target
 */
export function resumeOnGesture(ctx, target, onTry) {
  const h = () => {
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    onTry?.();
    ctx.resume().catch(() => { /* not allowed yet: the next gesture tries again */ });
  };
  for (const t of GESTURES) target.addEventListener(t, h, { capture: true });
  return () => { for (const t of GESTURES) target.removeEventListener(t, h, { capture: true }); };
}

/**
 * Whether the page shows the "click to enable sound" button: the game runs, sound is set up, and the context is not
 * running (suspended by the autoplay policy, interrupted by the system) for `graceMs` (a context resuming takes a
 * moment after a click).
 */
export function soundHintNeeded({ status, ctxState, notRunningSince, now, graceMs = 1500 }) {
  if (status !== 'running' && status !== 'starting') return false;
  if (!ctxState || ctxState === 'running' || ctxState === 'closed') return false;
  return notRunningSince !== null && now - notRunningSince >= graceMs;
}

/**
 * The audio part of a telemetry summary, accumulated over the summary's window (~20 s of stats messages). Bounded:
 * a dozen scalars per summary.
 */
export class AudioStats {
  constructor() {
    this.resumes = 0; this.changes = 0; this.error = null; this.lastFrames = null; this.lastAt = null;
    this.reset();
  }
  reset() { this.n = 0; this.running = 0; this.peak = 0; this.playing = 0; this.buffers = 0; this.frames = 0; this.seconds = 0; }
  /** the context changed state (statechange) */
  noteChange() { this.changes++; }
  /** a resume attempted at a gesture */
  noteResume() { this.resumes++; }
  /** setting up the output failed */
  noteError(msg) { if (!this.error) this.error = String(msg).slice(0, 200); }
  /**
   * One worker stats message `m` (audioPeak, audioBuffers, audioPlaying, audioDecodeFailures), with the context
   * (`ctx`: state, sampleRate, outputLatency, baseLatency; null: no output set up) and the output's frame counter
   * (`frames`: frames the AudioWorklet has played so far, null when unknown; `src`: which counter — a change of
   * counter starts the count again) at time `t` (ms).
   */
  add(m, ctx, frames, t, src = null) {
    this.n++;
    if (ctx?.state === 'running') this.running++;
    this.peak = Math.max(this.peak, m.audioPeak ?? 0);
    this.playing = Math.max(this.playing, m.audioPlaying ?? 0);
    this.buffers = Math.max(this.buffers, m.audioBuffers ?? 0);
    this.decodeFailures = m.audioDecodeFailures ?? 0;
    this.mix = m.audioMix ?? null;
    if (ctx) { this.ctx = ctx.state; this.rate = ctx.sampleRate; this.latency = Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000); }
    if (src !== this.src) { this.src = src; this.lastFrames = null; }
    if (frames !== null && frames !== undefined) {
      if (this.lastFrames !== null && t > this.lastAt) { this.frames += (frames - this.lastFrames) | 0; this.seconds += (t - this.lastAt) / 1000; }
      this.lastFrames = frames; this.lastAt = t;
    }
  }
  /** The window's record (null when nothing was added), and a new window. */
  take() {
    if (!this.n) return null;
    const r = {
      ctx: this.ctx ?? 'none', rate: this.rate ?? null, lat: this.latency ?? null,
      run: Math.round((this.running / this.n) * 100) / 100, // (share of the window with the context running)
      out: this.seconds > 0 ? Math.round(this.frames / this.seconds) : null, // (frames/s the worklet played: ~rate when it runs, 0 stalled)
      mix: this.mix ?? null, peak: Math.round(this.peak * 1000) / 1000, play: this.playing, bufs: this.buffers,
      dec: this.decodeFailures ?? 0, resumes: this.resumes, changes: this.changes,
      ...(this.error ? { err: this.error } : {}),
    };
    this.reset();
    return r;
  }
}

/**
 * What a session's audio records (AudioStats.take() of its summaries, oldest first) say, for tools/telemetry-report:
 * { verdict, ...figures }. verdict: 'none' (no record: an older build, or no game ran), 'error' (the output failed),
 * 'suspended' (the context never ran: the player did not click the page), 'stalled' (running, but the worklet played
 * nothing), 'silent' (the game's buffers played but the mix stayed at zero), 'quiet' (no buffer played: no sound
 * from the game so far), 'ok' (sound reached the output).
 */
export function audioVerdict(records) {
  const rs = records.filter(Boolean);
  if (!rs.length) return { verdict: 'none' };
  const max = (k) => Math.max(...rs.map((r) => r[k] ?? 0));
  const ran = rs.filter((r) => (r.run ?? 0) > 0), out = ran.map((r) => r.out).filter((x) => x !== null && x !== undefined);
  const f = {
    states: [...new Set(rs.map((r) => r.ctx))].join('/'), rate: rs.findLast((r) => r.rate)?.rate ?? null,
    run: Math.round((rs.reduce((a, r) => a + (r.run ?? 0), 0) / rs.length) * 100) / 100,
    out: out.length ? Math.round(out.reduce((a, b) => a + b, 0) / out.length) : null,
    peak: max('peak'), play: max('play'), bufs: max('bufs'), dec: max('dec'), resumes: max('resumes'), changes: max('changes'),
    err: rs.find((r) => r.err)?.err ?? null, mix: rs.findLast((r) => r.mix)?.mix ?? null,
  };
  // (the level while the context ran: the worker mixes into the ring before the first click too — a peak then was never heard)
  const heard = Math.max(0, ...ran.map((r) => r.peak ?? 0));
  const verdict = f.err && !ran.length ? 'error' : !ran.length ? 'suspended' : f.out !== null && f.out < 1000 ? 'stalled' : heard > 0 ? 'ok' : f.play > 0 ? 'silent' : 'quiet';
  return { verdict, ...f };
}

/** one line on a session's sound (audioVerdict) */
export const audioText = (a) => `sound: ${a.verdict.toUpperCase()} — context ${a.states}${a.rate ? ` @${a.rate} Hz` : ''}, running ${Math.round(a.run * 100)}% of the time, output ${a.out ?? '?'} frames/s (${a.mix ?? '?'} mix), mix peak ${a.peak}, buffers playing ≤ ${a.play} of ${a.bufs}${a.dec ? `, ${a.dec} audio decoder failure(s)` : ''}, ${a.resumes} resume(s) at gestures, ${a.changes} state change(s)${a.err ? `; error: ${a.err}` : ''}`;
