// Background play, for every runtime (shell.js creates it; docs/game-frame.md "Another window: the game keeps playing"):
// the player's choice (the game active in the background — the default since D130 — or paused: ?bg=pause, localStorage
// orthros.bg=pause), and the game kept at full speed while its tab is hidden.
//
// Chrome lowers the priority of a renderer process whose pages are all hidden (RenderProcessHostImpl: a "backgrounded"
// process; on Windows a lower priority class and, on Windows 11, EcoQoS — slower cores at a low clock), every thread
// of it: the emulator's worker and the render worker too. Unless a frame of it is audible: the audio service measures
// each output stream's level 15 times a second and calls it audible from -72.25 dBFS (services/audio/output_stream.cc
// kSilenceThresholdDBFS: "…downgrading the tab's priority"), the frame then counts as a media stream that keeps its
// process in the foreground (content/browser/media/audio_stream_monitor.cc, kPlayingAudibleAudioStream).
// The owner's sessions (2026-11-08..18, RTX 4050 laptop, Chrome 157 on Windows): the page hidden and silent ran the
// guest 2.5-4 times slower at once (AotR's boot 1 600-1 900 → 400-750 MIPS, the worker busy all the time; RotWK's
// play, the same scene: 16 → 60 ms of guest work a frame) — and at full speed while hidden with the game's music.
// Checked in Chromium here (Linux: the renderer's nice value, Chrome's own `audible` of the tab): a hidden silent tab's
// renderer goes to nice 5; with a constant offset of -54 or -68 dBFS on an AudioContext the tab is audible and its
// renderer stays at 0; at -74 or -80 dBFS it is not and goes to 5.
//
// So while the page is hidden and its game works (loading or running: the runtime says — `working`), a signal no one
// hears keeps it audible: a constant (DC) offset of AWAKE_LEVEL (-54 dBFS: 18 dB over Chrome's threshold, so that a
// multichannel output where it reaches only 2 channels of 8 still passes; a constant is no sound — a loudspeaker's cone
// moves by 0.2 % of its travel and stays there), faded in and out over AWAKE_FADE_S (no step: the fade is below 2 Hz),
// on an AudioContext of its own (the same for every runtime, whatever its engine's sound), suspended while the page is
// visible. Not when the player chose to pause in the background, nor with ?awake=0 / localStorage orthros.awake=0 (an
// A/B of this mitigation); and not past AWAKE_MAX_HIDDEN_MS of hidden time in one go (an audible tab keeps Windows from
// sleeping: a game forgotten in a hidden tab does not keep the computer awake for ever). Chrome shows the tab as
// playing sound meanwhile. The telemetry says when it was on (Win32 samples `aw`, summaries `awake`, the passive
// records' `aw`): MIPS hidden with and without it, against visible, in tools/dev/telemetry-report.mjs.
import { resumeOnGesture } from './sound.js';

/** the offset's level (full scale = 1): -54.2 dBFS */
export const AWAKE_LEVEL = 1 / 512;
/** Chrome's audibility threshold (dBFS): a stream's power at or over it is audible */
export const CHROME_AUDIBLE_DBFS = -72.24719896;
/** the fades in and out (s) */
export const AWAKE_FADE_S = 0.5;
/** hidden time (ms) in one go after which the signal stops (the page shown again starts the count again) */
export const AWAKE_MAX_HIDDEN_MS = 30 * 60 * 1000;
/** how often the state is checked again (ms): the runtime's work starting or ending, the hidden time's limit */
export const AWAKE_CHECK_MS = 2000;

const storageGet = (storage, key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
/**
 * The player's choice: `active` — the game stays active when the page loses the focus or is hidden (default; ?bg=pause
 * or localStorage orthros.bg=pause: deactivated as before D130) —, `awake` — the signal kept while hidden (default;
 * ?awake=0 or localStorage orthros.awake=0: not). The URL wins over the stored choice.
 */
export function backgroundChoice(search = globalThis.location?.search ?? '', storage = (() => { try { return globalThis.localStorage; } catch { return null; } })()) {
  const p = new URLSearchParams(search);
  const active = p.has('bg') ? p.get('bg') !== 'pause' : storageGet(storage, 'orthros.bg') !== 'pause';
  const awake = p.has('awake') ? p.get('awake') !== '0' : storageGet(storage, 'orthros.awake') !== '0';
  return { active, awake };
}

/**
 * What the signal should be: 'on', or why not — 'visible', 'pause' (the game paused in the background: the player's
 * choice), 'optout' (?awake=0), 'idle' (the game does not work: not started, ended), 'capped' (hidden too long).
 */
export function awakeDecision({ hidden, active, awake, working, hiddenMs = 0, maxHiddenMs = AWAKE_MAX_HIDDEN_MS }) {
  if (!hidden) return 'visible';
  if (!active) return 'pause';
  if (!awake) return 'optout';
  if (!working) return 'idle';
  if (hiddenMs >= maxHiddenMs) return 'capped';
  return 'on';
}

export class KeepAwake {
  /**
   * @param {{ win?: any, choice?: { active: boolean, awake: boolean }, working?: () => boolean, createContext?: () => any,
   *   now?: () => number, maxHiddenMs?: number, checkMs?: number }} [o]
   * `working()`: the game loads or runs (the runtime's own state); `createContext()`: the AudioContext (tests: a fake)
   */
  constructor(o = {}) {
    this.win = o.win ?? globalThis; this.choice = o.choice ?? backgroundChoice(this.win.location?.search ?? '');
    this.working = o.working ?? (() => true); this.now = o.now ?? (() => performance.now());
    this.createContext = o.createContext ?? (() => new this.win.AudioContext({ latencyHint: 'playback' }));
    this.maxHiddenMs = o.maxHiddenMs ?? AWAKE_MAX_HIDDEN_MS;
    this.ctx = null; this.node = null; this.wanted = false; this.state = 'visible'; this.error = null; this.offGesture = null; this.suspendTimer = null;
    this.hiddenSince = null; this.last = this.now();
    this.cur = { hid: 0, on: 0 }; // (the telemetry window's hidden time and the signal's, ms)
    this.onVis = () => this.update();
    this.win.document?.addEventListener?.('visibilitychange', this.onVis);
    this.timer = o.checkMs === 0 ? null : setInterval(() => this.update(), o.checkMs ?? AWAKE_CHECK_MS);
    this.update();
  }
  hidden() { return this.win.document?.visibilityState === 'hidden'; }
  /** The signal is heard by Chrome: wanted, and its context running. */
  get sounding() { return this.wanted && this.ctx?.state === 'running'; }
  /** The time since the last look goes to the hidden time, and to the signal's when it sounded. */
  account(now = this.now()) {
    const el = Math.max(0, now - this.last); this.last = now;
    if (this.hiddenSince !== null) this.cur.hid += el;
    if (this.sounding) this.cur.on += el;
  }
  /** Looks again: the page's visibility, the player's choice, the game's work, the hidden time. */
  update() {
    const now = this.now();
    this.account(now);
    const hidden = this.hidden();
    if (hidden && this.hiddenSince === null) this.hiddenSince = now;
    if (!hidden) this.hiddenSince = null;
    let working = false; try { working = !!this.working(); } catch { /* the runtime's state unreadable: not working */ }
    this.state = awakeDecision({ hidden, active: this.choice.active, awake: this.choice.awake, working, hiddenMs: hidden ? now - this.hiddenSince : 0, maxHiddenMs: this.maxHiddenMs });
    if (this.state === 'on' && this.error) this.state = 'unsupported'; // (no Web Audio here: not tried again)
    this.set(this.state === 'on');
    return this.state;
  }
  /** The signal faded in or out (its context made, resumed, suspended after the fade out). */
  set(on) {
    if (!on && !this.wanted) return;
    // (on already: its context taken back when something else stopped it — the system's audio session)
    if (on && this.wanted && this.ctx) { if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') this.ctx.resume?.().catch(() => {}); return; }
    if (on && !this.ctx) {
      try {
        this.ctx = this.createContext();
        this.node = new this.win.ConstantSourceNode(this.ctx, { offset: 0 });
        this.node.connect(this.ctx.destination); this.node.start();
        // (not allowed to start yet — no user activation in this page —: at the player's next gesture)
        this.offGesture = resumeOnGesture(this.ctx, this.win);
      } catch (e) { this.error = String(e?.message ?? e).slice(0, 120); this.ctx = null; this.node = null; this.state = 'unsupported'; return; }
    }
    if (!this.ctx) return;
    this.wanted = on;
    clearTimeout(this.suspendTimer); this.suspendTimer = null;
    if (on && this.ctx.state !== 'running') this.ctx.resume?.().catch(() => { /* refused: resumed at a gesture */ });
    const p = this.node.offset, t = this.ctx.currentTime;
    p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(on ? AWAKE_LEVEL : 0, t + AWAKE_FADE_S);
    // (off: the context suspended once faded out — no audio thread running for nothing while the page is visible)
    if (!on) this.suspendTimer = setTimeout(() => { this.suspendTimer = null; if (!this.wanted && this.ctx?.state === 'running') this.ctx.suspend?.().catch(() => {}); }, AWAKE_FADE_S * 1000 + 200);
  }
  /** For a ~0.5 s telemetry sample: 1 the signal sounds, 0 hidden without it, undefined visible. */
  sample() { this.account(); return this.hidden() ? (this.sounding ? 1 : 0) : undefined; }
  /** The telemetry summary's part (~20 s window): null when the page was not hidden in it; then a new window. */
  take() {
    this.account();
    const w = this.cur; this.cur = { hid: 0, on: 0 };
    if (!(w.hid > 0)) return null;
    return { hid: Math.round(w.hid / 100) / 10, on: Math.round(w.on / 100) / 10, st: this.state, ...(this.ctx ? { ctx: this.ctx.state } : {}), ...(this.error ? { err: this.error } : {}) };
  }
  dispose() {
    clearInterval(this.timer); clearTimeout(this.suspendTimer); this.offGesture?.();
    this.win.document?.removeEventListener?.('visibilitychange', this.onVis);
    try { this.node?.stop(); this.ctx?.close?.(); } catch { /* gone */ }
    this.ctx = null; this.node = null; this.wanted = false;
  }
}
