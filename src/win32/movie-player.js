// The playback engine behind the Windows media APIs (DirectShow's filter graph manager in quartz.js, MCI's digital
// video and wave devices in mci.js): a media file of the virtual file system (src/media) played on the VM clock — its
// pictures shown on the host display's video layer in a rectangle the API's window state gives, its sound through the
// DirectSound mixer, the end reported to the API. vm.media (MediaClock) advances the playing ones from the scheduler.
import { openMedia, MediaError } from '../media/open.js';
import { yuv420ToRgba } from '../media/yuv.js';

export const STOPPED = 0, PAUSED = 1, RUNNING = 2;
const AUDIO_LEAD = 0.25; // seconds of sound written ahead of the play cursor

/** The playing players, advanced by the scheduler (sched.js: wakeBlocked calls tick, nextWake asks for the next due time). */
export class MediaClock {
  constructor(vm) { this.vm = vm; this.players = new Set(); this.due = Infinity; }
  tick(now) {
    if (now < this.due) return;
    if (!this.players.size) { this.due = Infinity; return; } // (nothing playing: the scheduler no longer calls in)
    let due = Infinity;
    for (const p of [...this.players]) {
      try { due = Math.min(due, p.tick(now)); } catch (e) { this.vm.warn(`media: playback of ${p.path} failed: ${e.stack ?? e}`); p.fail(); }
    }
    this.due = due;
  }
  nextWake() { return this.players.size ? this.due : Infinity; }
  /** a player started or moved: advanced at the next pass */
  wake() { this.due = 0; this.tick(this.vm.clock.now()); }
}

/**
 * @typedef {{
 *   log?: (msg: string) => void,
 *   onComplete?: () => void,   every stream ended (or the stop position reached) while running
 *   onError?: () => void,      the file could not be read on
 *   rect: () => { x: number, y: number, w: number, h: number },   where the pictures go (screen coordinates)
 *   source?: () => ({ l: number, t: number, w: number, h: number } | null),   the part of the picture shown (null: all)
 *   visible: () => boolean,
 * }} PlayerHooks
 */
export class MoviePlayer {
  /** @param {any} vm @param {any} proc @param {PlayerHooks} hooks */
  constructor(vm, proc, hooks) {
    this.vm = vm; this.proc = proc; this.hooks = hooks; this.log = hooks.log ?? (() => {});
    this.src = null; this.path = null; this.state = STOPPED; this.completed = false; this.failed = false;
    this.pos = 0; // stream position (seconds) while not running; at a run: the position it started from
    this.runAt = 0; // VM clock (ms) when the current run started
    this.stopPos = null; // stop position (seconds; null: the end)
    this.volume = 0; this.balance = 0; // (1/100 dB)
    this.voice = null; this.pending = []; this.rgba = null; this.shown = false; this.due = 0;
    this.presented = 0; this.presentMs = 0; this.closed = null;
  }
  /**
   * Open a file (a guest path): { ok: true, left: null | 'video' | 'audio' (a stream without a decoder, left out) } or
   * { ok: false, code: 'not-found' | 'unknown' | 'unsupported' | 'corrupt', message }.
   */
  open(path) {
    const vm = this.vm, st = vm.vfs.stat(path);
    if (!st || st.isDir) { this.log(`open ${path}: not found`); return { ok: false, code: 'not-found', message: 'not found' }; }
    const f = vm.vfs.open(path, {});
    if (!f) return { ok: false, code: 'not-found', message: 'not found' };
    try { this.src = openMedia(f, { log: this.log }); } catch (e) {
      f.close();
      const code = !(e instanceof MediaError) || e.code === 'corrupt' ? 'corrupt' : /layer III|MPEG-2|AVI (video|audio)|format tag/.test(e.message) ? 'unsupported' : 'unknown';
      return { ok: false, code, message: e.message };
    }
    this.path = path;
    const s = this.src;
    this.log(`${path}: ${s.kind}${s.video ? `, video ${s.width}x${s.height} ${s.fps.toFixed(2)} fps` : ''}${s.audio ? `, audio ${s.audioRate} Hz ${s.audioChannels} ch` : ''}, ${s.duration.toFixed(2)} s`);
    return { ok: true, left: s.videoUnsupported ? 'video' : (s.audioLayer === 3 || s.audioUnsupported) && !s.audio ? 'audio' : null };
  }
  get hasVideo() { return !!this.src?.video; }
  get hasAudio() { return !!this.src?.audio; }
  get width() { return this.src?.width ?? 0; }
  get height() { return this.src?.height ?? 0; }
  get duration() { return this.src?.duration ?? 0; }
  /** where playback ends (seconds): the stop position, else the duration (unknown: no end before the streams') */
  get stopTime() { return this.stopPos ?? (this.duration || Infinity); }
  /** the stream position now (seconds) */
  position(now = this.vm.clock.now()) {
    if (this.state !== RUNNING) return this.pos;
    return Math.min(this.pos + (now - this.runAt) / 1000, Math.max(this.stopTime, this.pos));
  }

  // ---- states
  run() {
    if (this.state === RUNNING || !this.src) { this.state = RUNNING; return; }
    if (this.state === STOPPED) this.completed = false;
    this.state = RUNNING; this.runAt = this.vm.clock.now();
    this.vm.media.players.add(this);
    this.startAudio();
    this.vm.media.wake();
  }
  pause() {
    if (this.state === RUNNING) this.pos = this.position();
    this.halt(); this.state = PAUSED;
    if (this.src) this.showPosition();
  }
  stop() {
    if (this.state === RUNNING) this.pos = this.position();
    this.halt(); this.state = STOPPED;
  }
  halt() { this.voice?.stop(); this.vm.media.players.delete(this); }
  fail() { this.failed = true; this.halt(); this.hooks.onError?.(); }
  close() {
    this.halt(); this.hideVideo();
    this.voice?.destroy(); this.voice = null;
    this.src?.close(); this.closed = this.src; this.src = null;
  }

  /** move to stream position `t` (seconds): decoders restarted at the beginning and run forward when going back */
  seek(t) {
    const s = this.src; if (!s) return;
    t = Math.max(0, Math.min(t, this.duration || t));
    const running = this.state === RUNNING;
    if (running) this.voice?.stop();
    if (t < this.position()) s.reset();
    // (forward: decode to the position without showing; the sound before it is dropped; not lateness)
    s.load(t, Infinity);
    if (s.video) { const late = s.stats.late; s.pictureAt(t); s.stats.late = late; }
    s.audioUntil(t, () => {});
    this.pending = []; // (decoded before the seek: another part of the stream)
    this.pos = t; this.completed = false;
    if (running) { this.runAt = this.vm.clock.now(); this.startAudio(); this.vm.media.wake(); }
    else this.showPosition();
  }
  setVolume(v) { this.volume = v; this.voice?.setVolume(v); }
  setBalance(v) { this.balance = v; this.voice?.setPan(v); }

  // ---- playback (vm.media.tick)
  tick(now) {
    const s = this.src;
    if (!s || this.state !== RUNNING) return Infinity;
    const t = this.position(now);
    s.load(t);
    if (s.loadError && !this.failed) { this.vm.warn(`media: ${this.path}: read failed (${s.loadError.message ?? s.loadError})`); this.fail(); return Infinity; }
    if (s.video) { const p = s.pictureAt(t); if (p) this.present(p); }
    if (this.voice) this.feedAudio(now);
    if (!this.completed && (s.ended(t) || t >= this.stopTime)) {
      this.completed = true;
      this.log(`complete at ${t.toFixed(2)} s: ${this.report()}`);
      this.voice?.stop();
      this.hooks.onComplete?.();
    }
    // the next wake-up: the next picture, or the next sound refill
    let next = Infinity;
    if (s.video && !s.videoDone) next = this.runAt + (s.frameTime(s.frameIndex) - this.pos) * 1000;
    if (this.voice && !this.completed) next = Math.min(next, now + 40);
    if (!this.completed && next === Infinity) next = now + 20; // (waiting for data or for the end)
    return this.due = Math.max(next, now + 1);
  }
  /** playback statistics (the 'video' log) */
  report(s = this.src ?? this.closed) {
    if (!s) return '';
    const st = s.stats, n = st.decoded + st.skipped;
    return `${s.frameIndex} pictures (${this.presented} shown, ${st.overtaken} decoded and overtaken, ${st.skipped} B skipped${s.vdec?.errors ? `, ${s.vdec.errors} damaged` : ''}), decoding ${n ? (st.decodeMs / Math.max(1, st.decoded)).toFixed(1) : 0} ms per picture, showing ${(this.presentMs / Math.max(1, this.presented)).toFixed(1)} ms, lateness up to ${(st.late * 1000).toFixed(0)} ms; ${(s.audioPos / (s.audioRate || 1)).toFixed(2)} s of sound`;
  }

  // ---- pictures
  present(p) {
    const disp = this.vm.host?.display;
    this.shown = true;
    if (!this.hooks.visible() || !disp?.presentVideo) return;
    const s = this.src, r = this.hooks.source?.() ?? { l: 0, t: 0, w: s.width, h: s.height };
    const x = r.l & ~1, y = r.t & ~1, sw = Math.max(1, Math.min(r.w, s.width - x)), sh = Math.max(1, Math.min(r.h, s.height - y));
    const rect = this.hooks.rect(), t0 = performance.now();
    // (an RGBA picture — AVI codecs — as it is; 4:2:0 planes as they are when the host converts them itself — WebCodecs
    // in the browser; else converted to RGBA here)
    if (p.rgba) disp.presentVideo(p.rgba, p.width, p.height, rect, { x: r.l, y: r.t, w: Math.min(r.w, s.width - r.l), h: Math.min(r.h, s.height - r.t) });
    else if (!disp.presentVideoYuv?.(p, { x, y, w: sw, h: sh }, rect)) {
      const n = sw * sh * 4;
      if (!this.rgba || this.rgba.length !== n) this.rgba = new Uint8ClampedArray(n);
      yuv420ToRgba(p, x, y, sw, sh, this.rgba);
      disp.presentVideo(this.rgba, sw, sh, rect);
    }
    this.presented++; this.presentMs += performance.now() - t0;
  }
  /**
   * The picture at the current position (paused, or after a seek): decoded now — or the next one when none is due yet
   * (a paused renderer shows the first picture it receives).
   */
  showPosition() {
    const s = this.src;
    if (!s?.video) return;
    let p = s.pictureAt(this.pos) ?? s.picture;
    if (!p && !s.videoDone) { s.load(s.frameTime(s.frameIndex)); p = s.pictureAt(s.frameTime(s.frameIndex)); }
    if (p) this.present(p);
  }
  hideVideo() { if (this.shown) { this.shown = false; this.vm.host?.display?.hideVideo?.(); } }
  /** the window moved, was shown or hidden: the current picture again, or the layer hidden */
  refresh() {
    if (!this.hooks.visible()) this.hideVideo();
    else if (this.src?.picture) this.present(this.src.picture);
  }

  // ---- sound: decoded samples written ahead of the DirectSound play cursor
  startAudio() {
    const s = this.src, vm = this.vm;
    if (!s?.audio || !vm.createAudioStream) return;
    if (!this.voice) {
      // (a stream format no sound device takes — a damaged header: played without sound rather than failing the API call)
      if (!(s.audioRate >= 1 && s.audioRate <= 1000000 && s.audioChannels >= 1 && s.audioChannels <= 32)) { if (!this.noSound) { this.noSound = true; vm.warn(`media: ${this.path}: sound ${s.audioRate} Hz ${s.audioChannels} ch not played`); } return; }
      this.voice = vm.createAudioStream(this.proc, s.audioRate, s.audioChannels, 1);
    }
    this.ringView().fill(0);
    this.voice.setVolume(this.volume); this.voice.setPan(this.balance);
    this.voiceAt = vm.clock.now(); this.voiceFrom = this.pos; this.written = 0;
    this.pending = this.pending.filter((b) => b.start + b.samples[0].length / s.audioRate > this.pos);
    this.voice.start();
  }
  /** the sound ring: 16-bit samples in guest memory */
  ringView() { return new Int16Array(this.vm.mem.u8.buffer, this.voice.addr, this.voice.frames * this.src.audioChannels); }
  feedAudio(now) {
    const s = this.src, rate = s.audioRate, ch = s.audioChannels, ring = this.ringView(), frames = this.voice.frames;
    const played = Math.floor((now - this.voiceAt) / 1000 * rate);
    if (this.written < played) this.written = played; // (fell behind: the part already played is lost)
    const target = Math.min(played + Math.floor(AUDIO_LEAD * rate), played + frames - 1);
    s.audioUntil(this.voiceFrom + target / rate, (samples, start) => this.pending.push({ samples, start }));
    const pend = this.pending;
    while (this.written < target) {
      const b = pend[0];
      const f0 = b ? Math.round((b.start - this.voiceFrom) * rate) : Infinity;
      if (f0 > this.written) { // a gap (no sound decoded for it yet, or the stream over): silence
        const end = Math.min(f0, target);
        for (let f = this.written; f < end; f++) { const o = (f % frames) * ch; ring[o] = 0; if (ch > 1) ring[o + 1] = 0; }
        this.written = end;
        if (!b) break;
        continue;
      }
      const n = b.samples[0].length, from = this.written - f0, end = Math.min(n, target - f0);
      const L = b.samples[0], R = b.samples[ch > 1 ? 1 : 0];
      for (let i = from; i < end; i++) {
        const o = ((f0 + i) % frames) * ch;
        const l = L[i] * 32768, r = R[i] * 32768;
        ring[o] = l > 32767 ? 32767 : l < -32768 ? -32768 : l;
        if (ch > 1) ring[o + 1] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
      }
      this.written = f0 + Math.max(from, end);
      if (end >= n) pend.shift();
    }
  }
}
