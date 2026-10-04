// Browser host (runs inside the worker): display over worker-owned OffscreenCanvases (2D layer for
// GDI surfaces, WebGL2 layer for Direct3D) whose complete frames are handed to the page as
// ImageBitmaps, input from the page through a SharedArrayBuffer ring, audio through a float ring
// consumed by an AudioWorklet, cooperative waits (the worker returns to its event loop between
// slices). Frames are explicit on purpose: a placeholder canvas committed automatically at the end
// of a worker task showed half-drawn or missing frames under load.
import { acct, C as ACCT, FrameStats } from '../core/frame-acct.js';
import { encodePng } from '../gfx/codecs/png.js';

export const CTL = { IN_HEAD: 0, IN_TAIL: 1, WAKE: 2, STOP: 3, AUDIO_WRITE: 4, AUDIO_READ: 5, AUDIO_UNDERRUNS: 6, POINTER_LOCK: 7, FOCUS: 8, SIZE: 64 };
export const IN_RING = 4096; // int32 slots (4 per event)
export const EV = { MOUSEMOVE: 1, MOUSEDOWN: 2, MOUSEUP: 3, WHEEL: 4, KEYDOWN: 5, KEYUP: 6, CHAR: 7, FOCUS: 8 };
export const AUDIO_RING_FRAMES = 16384; // stereo frames
export const AUDIO_RATE = 44100;

export class BrowserDisplay {
  constructor(host, canvas2d, canvasGl, width, height) {
    this.host = host;
    this.canvas2d = canvas2d; this.canvasGl = canvasGl;
    this.width = width; this.height = height; this.bpp = 32; this.fullscreen = false;
    this.frames = 0; this.title = ''; this.cursorVisible = true;
    this.modes = [[640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 720], [1280, 800], [1280, 960], [1280, 1024], [1366, 768], [1440, 900], [1600, 900], [1600, 1200], [1680, 1050], [1920, 1080], [1920, 1200]];
    this.ctx = canvas2d.getContext('2d', { alpha: false });
    this.desk = null; this.row = null; // full desktop image on the 2D layer (transferToImageBitmap blanks the canvas)
    this.glActive = false;
    this.videoFrame = null; this.videoFrameCtx = null; this.videoLayer = null; this.videoLayerCtx = null; this.videoShown = false; this.videoFrames = 0; this.videoYuv = null; this.videoYuvFailed = false; // (the video layer: presentVideo)
    this.resize(width, height);
  }
  resize(w, h) {
    this.width = w; this.height = h;
    if (this.canvas2d.width !== w || this.canvas2d.height !== h) { this.canvas2d.width = w; this.canvas2d.height = h; }
    // (recorded Direct3D work: the canvas resized in order with the recorded presents, where they are replayed)
    if (this.host.gfx?.canvasResized) this.host.gfx.canvasResized(w, h);
    else if (this.canvasGl.width !== w || this.canvasGl.height !== h) { this.canvasGl.width = w; this.canvasGl.height = h; }
    this.ctx = this.canvas2d.getContext('2d', { alpha: false });
    this.desk = new ImageData(w, h); new Uint32Array(this.desk.data.buffer).fill(0xff000000);
    this.row = new Uint32Array(w);
    this.host.post({ type: 'mode', width: w, height: h, fullscreen: this.fullscreen });
  }
  /** Present a GDI surface region at (x, y) on the 2D layer: update the desktop image, hand a frame to the page. */
  present(surface, x, y, w = surface.width, h = surface.height) {
    const W = this.width, H = this.height;
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
    if (x1 <= x0 || y1 <= y0) return;
    const ap = acct.enter(ACCT.present);
    try { this.present2d(surface, x, y, x0, y0, x1, y1); } finally { acct.leave(ap); }
  }
  present2d(surface, x, y, x0, y0, x1, y1) {
    const W = this.width;
    const px = new Uint32Array(this.desk.data.buffer);
    const row = this.row, cw = x1 - x0;
    for (let yy = y0; yy < y1; yy++) {
      surface.readRow(yy - y, x0 - x, cw, row);
      const o = yy * W + x0;
      for (let i = 0; i < cw; i++) { const c = row[i]; px[o + i] = 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff); } // 0x00RRGGBB -> ABGR bytes R,G,B,A
    }
    this.ctx.putImageData(this.desk, 0, 0);
    const bitmap = this.canvas2d.transferToImageBitmap();
    this.host.post({ type: 'frame', layer: '2d', bitmap }, [bitmap]);
    this.frames++;
    this.host.framePresented();
  }
  /** Hand the Direct3D frame just presented (blitted into the GL canvas) to the page. */
  presentGl() {
    if (this.host.remoteGl) { if (!this.glActive) { this.glActive = true; this.host.post({ type: 'gl', active: true }); } return; } // (a render worker posts the frames)
    let bitmap;
    try { bitmap = this.canvasGl.transferToImageBitmap(); } catch { return; } // (WebGL context lost: no frame until it is restored)
    this.host.post({ type: 'frame', layer: 'gl', bitmap }, [bitmap]);
    if (!this.glActive) { this.glActive = true; this.host.post({ type: 'gl', active: true }); }
  }
  /** the display-sized video layer, cleared, and its context */
  videoCanvas() {
    if (!this.videoLayer || this.videoLayer.width !== this.width || this.videoLayer.height !== this.height) { this.videoLayer = new OffscreenCanvas(this.width, this.height); this.videoLayerCtx = this.videoLayer.getContext('2d'); }
    const ctx = this.videoLayerCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = true;
    return ctx;
  }
  videoDone() {
    const bitmap = this.videoLayer.transferToImageBitmap();
    this.host.post({ type: 'frame', layer: 'video', bitmap }, [bitmap]);
    // (shown after its new picture is in place: not the previous movie's last one for a page frame)
    if (!this.videoShown) { this.videoShown = true; this.host.post({ type: 'video', visible: true }); }
    this.videoFrames++;
  }
  /**
   * A movie picture (RGBA, w x h; its part `crop`) shown on the video layer, above the GDI and Direct3D layers, stretched
   * to `rect` in screen coordinates (DirectShow's video window, quartz.js). The layer is display-sized and transparent
   * around it.
   */
  presentVideo(rgba, w, h, rect, crop = null) {
    const ap = acct.enter(ACCT.present);
    try {
      if (!this.videoFrame || this.videoFrame.width !== w || this.videoFrame.height !== h) { this.videoFrame = new OffscreenCanvas(w, h); this.videoFrameCtx = this.videoFrame.getContext('2d'); }
      this.videoFrameCtx.putImageData(new ImageData(rgba, w, h), 0, 0);
      const c = crop ?? { x: 0, y: 0, w, h };
      this.videoCanvas().drawImage(this.videoFrame, c.x, c.y, c.w, c.h, rect.x, rect.y, rect.w, rect.h);
      this.videoDone();
    } finally { acct.leave(ap); }
  }
  /**
   * The same from the decoded 4:2:0 planes ({ y, cb, cr, stride, cstride }; `crop`: the visible part, even origin): a
   * WebCodecs VideoFrame drawn on the layer — the color conversion and scaling are the canvas's (the GPU's), not this
   * thread's. False when VideoFrame is unavailable (the caller converts to RGBA). (?dbg=ORTHROS_VIDEO_RGBA=1: always
   * false, for comparisons.)
   */
  presentVideoYuv(p, crop, rect) {
    if (typeof VideoFrame === 'undefined' || globalThis.ORTHROS_VIDEO_RGBA || this.videoYuvFailed) return false;
    const ap = acct.enter(ACCT.present);
    let vf = null;
    try {
      const ch = (p.y.length / p.stride) | 0, ys = p.stride * ch, cs = p.cstride * (ch >> 1);
      if (!this.videoYuv || this.videoYuv.length !== ys + 2 * cs) this.videoYuv = new Uint8Array(ys + 2 * cs);
      const buf = this.videoYuv;
      buf.set(p.y.subarray(0, ys), 0); buf.set(p.cb.subarray(0, cs), ys); buf.set(p.cr.subarray(0, cs), ys + cs);
      vf = new VideoFrame(buf, {
        format: 'I420', codedWidth: p.stride, codedHeight: ch, timestamp: 0,
        visibleRect: { x: crop.x, y: crop.y, width: crop.w, height: crop.h },
        layout: [{ offset: 0, stride: p.stride }, { offset: ys, stride: p.cstride }, { offset: ys + cs, stride: p.cstride }],
        colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false },
      });
      this.videoCanvas().drawImage(vf, rect.x, rect.y, rect.w, rect.h);
      this.videoDone();
      return true;
    } catch (e) {
      this.videoYuvFailed = true; // (from now on the RGBA path)
      this.host.post({ type: 'log', kind: 'warn', msg: `video layer: VideoFrame path unavailable (${e.message}), RGBA conversion instead` });
      return false;
    } finally { vf?.close(); acct.leave(ap); }
  }
  hideVideo() { if (this.videoShown) { this.videoShown = false; this.host.post({ type: 'video', visible: false }); } }
  setMode(width, height, bpp, fullscreen) {
    this.fullscreen = fullscreen; this.bpp = bpp || 32;
    this.resize(width, height);
    return true;
  }
  setTitle(t) { this.title = t; this.host.post({ type: 'title', title: t }); }
  showCursor(v) { if (this.cursorVisible !== v) { this.cursorVisible = v; this.host.post({ type: 'cursor', visible: v }); } }
  /**
   * The guest's current cursor (SetCursor): a system cursor id (IDC_*) or an image cursor (frames + animation
   * steps, see gfx/gdi/cursor.js). Image frames are encoded once per cursor as PNG and defined on the page, which
   * shows them as an animated CSS cursor.
   */
  setCursor(key, image, systemId) {
    if (this.cursorKey === key) return;
    this.cursorKey = key;
    if (!image) { this.host.post({ type: 'cursor-set', system: systemId ?? 32512 }); return; }
    this.cursorDefs ??= new Map();
    if (this.cursorDefs.has(key)) { this.host.post({ type: 'cursor-set', id: key }); return; }
    this.cursorDefs.set(key, true);
    // (encoded here, on the CPU: a 2D canvas is drawn by the GPU process — behind a GPU backlog, creating one waited
    // for all of it, a 7 s frame when a game switched to an animated cursor)
    const pngs = image.frames.map((f) => { const png = encodePng(f.rgba, f.w, f.h); return png.buffer; });
    this.host.post({ type: 'cursor-def', id: key, frames: image.frames.map((f, i) => ({ png: pngs[i], hotX: f.hotX, hotY: f.hotY })), steps: image.steps }, pngs);
    this.host.post({ type: 'cursor-set', id: key });
  }
}

export class BrowserHost {
  /**
   * @param {{ clock: any, ctl: Int32Array, inputRing: Int32Array, audioRing: Float32Array, canvas2d: OffscreenCanvas, canvasGl: OffscreenCanvas, width: number, height: number, post: (m: any) => void }} o
   */
  constructor(o) {
    this.clock = o.clock;
    this.ctl = o.ctl; this.inputRing = o.inputRing; this.audioRing = o.audioRing;
    this.post = o.post;
    this.cooperative = true; // vm.runFor hands long waits back to the event loop
    this.display = new BrowserDisplay(this, o.canvas2d, o.canvasGl, o.width, o.height);
    this.inputQueue = [];
    this.exitCode = null;
    this.framesPresented = 0;
    this.lastFrameAt = 0;
    this.frameTimes = []; this.frameTimesAt = []; // rolling window for the live stats (durations, presentation times)
    this.frameLog = []; // every frame since start as (presented at ms, frame time ms) pairs — whole-run percentiles
    this.gfx = null; // Direct3D backend factory, installed by the worker when WebGL2 is available
    this.frameHook = () => { const t0 = performance.now(); this.display.presentGl(); this.presentMs += performance.now() - t0; this.framePresented(); };
    this.presentMs = 0;
    // slow-frame diagnostics: the worker installs `frameProbe()` (counters snapshot) and `onSlowFrame(dt, deltas)`
    this.frameProbe = null; this.onSlowFrame = null; this.lastProbe = null; this.slowFrameLogs = 0; this.slowFrameFrom = 0;
    // per-frame time accounting (frame-acct.js): every frame's categories, by interval and by phase
    this.frameAcct = new FrameStats();
    this.lastCats = null; // (the categories of the last frame: the slow-frame diagnostics)
    // (fields the worker and the audio path set later, declared here: one hidden class, see Vm's constructor)
    this.dxtPool = null; this.wake = null; this.onUserInput = null; // (a click / a printable character, before the guest sees it: profile-seed.js)
    this.audioHook = null; this.interval = null; this.waitMs = 0;
    this.audioPeak = 0; this.audioMs = 0; this.audioFrames = 0; this.audioDiag = 0; this.chunk = null;
    this.audioLead = undefined; this.audioUnderSeen = 0; this.audioCalmSince = 0;
  }
  /** Drain the shared input ring into the local queue. */
  pump() {
    const ring = this.inputRing, ctl = this.ctl;
    const head = Atomics.load(ctl, CTL.IN_HEAD);
    let tail = Atomics.load(ctl, CTL.IN_TAIL);
    while (tail !== head) {
      const i = (tail % (IN_RING / 4)) * 4;
      const type = ring[i], a = ring[i + 1], b = ring[i + 2], c = ring[i + 3];
      tail = (tail + 1) | 0;
      switch (type) {
        case EV.MOUSEMOVE: this.inputQueue.push({ type: 'mousemove', x: a, y: b, dx: (c << 16) >> 16, dy: c >> 16 }); break;
        case EV.MOUSEDOWN: this.inputQueue.push({ type: 'mousedown', button: a, x: b, y: c }); this.onUserInput?.(false); break;
        case EV.MOUSEUP: this.inputQueue.push({ type: 'mouseup', button: a, x: b, y: c }); break;
        case EV.WHEEL: this.inputQueue.push({ type: 'wheel', delta: a / 120, x: b, y: c }); break;
        case EV.KEYDOWN: this.inputQueue.push({ type: 'keydown', vk: a, scan: b & 0xff, extended: (b & 0x100) !== 0, repeat: c }); break;
        case EV.KEYUP: this.inputQueue.push({ type: 'keyup', vk: a, scan: b & 0xff, extended: (b & 0x100) !== 0 }); break;
        case EV.CHAR: this.inputQueue.push({ type: 'char', code: a }); if (a >= 0x20) this.onUserInput?.(true); break;
        case EV.FOCUS: this.inputQueue.push({ type: 'focus', focused: a !== 0 }); break;
      }
    }
    Atomics.store(ctl, CTL.IN_TAIL, tail);
  }
  nextWake() { return undefined; }
  /**
   * Nested waits (inside callbacks) block the worker briefly; woken early by input. `io`: the guest thread waits for a
   * file read (frame accounting: `ioWait`, else `wait` — the game's pacing).
   */
  waitEvent(ms, io = false) {
    const t = Math.min(ms, 50);
    this.audioHook?.(); // (the audio ring filled before blocking: a nested wait must not starve the output)
    const ap = acct.enter(io ? ACCT.ioWait : ACCT.wait);
    const t0 = acct.stamp();
    Atomics.wait(this.ctl, CTL.WAKE, 0, t);
    acct.leave(ap);
    this.waitMs = (this.waitMs ?? 0) + acct.stamp() - t0;
    this.pump();
  }
  pollInput() { this.pump(); return this.inputQueue.length ? this.inputQueue.splice(0) : null; }
  onExit(code) { this.exitCode = code; } // (the worker posts the exit, with the failure report)
  /** Frame-time percentiles over the frames presented after `fromMs` (performance.now() based). */
  frameStats(fromMs = 0) {
    const dts = [];
    for (let i = 0; i < this.frameLog.length; i += 2) if (this.frameLog[i] >= fromMs) dts.push(this.frameLog[i + 1]);
    if (!dts.length) return null;
    dts.sort((a, b) => a - b);
    const q = (x) => dts[Math.min(dts.length - 1, Math.floor(x * dts.length))];
    const over33 = dts.filter((d) => d > 33).length;
    const span = (this.frameLog[this.frameLog.length - 2] - fromMs) / 1000;
    return { frames: dts.length, seconds: span, fps: dts.length / span, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: dts[dts.length - 1], over33, over50: dts.filter((d) => d > 50).length };
  }
  framePresented() {
    this.framesPresented++;
    const cats = acct.frame(), now = acct.stamp(); // (the clock read of the frame boundary, unless the accounting's clock is off)
    this.lastCats = cats;
    if (this.lastFrameAt) {
      const dt = now - this.lastFrameAt; this.frameTimes.push(dt); this.frameTimesAt.push(now);
      this.frameAcct.add(dt, cats, now, acct.lastReads);
      // (the last 10 s of frames, at most 600: a loading phase's long frames leave the live percentiles once it is over)
      while (this.frameTimes.length > 600 || (this.frameTimesAt.length && now - this.frameTimesAt[0] > 10000)) { this.frameTimes.shift(); this.frameTimesAt.shift(); } this.frameLog.push(now, dt); this.probeFrame(dt);
      const iv = this.interval ??= { max: 0, slow33: 0, slow50: 0 }; // (per stats interval: the live frame-rate display)
      if (dt > iv.max) iv.max = dt; if (dt > 33.4) iv.slow33++; if (dt > 50) iv.slow50++;
    }
    else this.probeFrame(0);
    this.lastFrameAt = now;
  }
  /** Snapshot the probe counters every frame; report the deltas of a frame longer than 33 ms (at most 300 reports). */
  probeFrame(dt) {
    if (!this.frameProbe) return;
    const p = this.frameProbe(); p.presentMs = this.presentMs;
    const prev = this.lastProbe; this.lastProbe = p;
    if (!prev || dt <= 33 || !this.onSlowFrame || this.slowFrameLogs >= 5000 || performance.now() < (this.slowFrameFrom ?? 0)) return;
    this.slowFrameLogs++;
    const d = {}; for (const k of Object.keys(p)) d[k] = typeof p[k] === 'number' ? Math.round((p[k] - (prev[k] ?? 0)) * 100) / 100 : p[k];
    this.onSlowFrame(dt, d);
  }
  /**
   * Fill the audio ring ahead of the output using the VM mixer. The lead adapts: every new underrun (the worker was
   * busy longer than the lead: a translation burst, a loading stall) adds 1024 frames up to 12288 (~280 ms: the ring holds 16384, filled in chunks of 512), and 30 s
   * without one takes 1024 back down to 4096 (~93 ms).
   */
  renderAudio(vm) {
    const audio = vm.audio; if (!audio) return;
    if (audio.worklet) { // (the AudioWorklet mixes from guest memory: only the play cursors to advance and publish)
      audio.tick();
      const pk = audio.voicesF[1]; if (pk > (this.audioPeak ?? 0)) this.audioPeak = pk; audio.voicesF[1] = 0;
      return;
    }
    const ctl = this.ctl;
    const now = performance.now(), under = Atomics.load(ctl, CTL.AUDIO_UNDERRUNS);
    if (this.audioLead === undefined) { this.audioLead = 4096; this.audioUnderSeen = under; this.audioCalmSince = now; }
    if (under !== this.audioUnderSeen) { this.audioUnderSeen = under; this.audioLead = Math.min(12288, this.audioLead + 1024); this.audioCalmSince = now; }
    else if (now - this.audioCalmSince > 30000 && this.audioLead > 4096) { this.audioLead -= 1024; this.audioCalmSince = now; }
    const aheadFrames = this.audioLead;
    const cap = AUDIO_RING_FRAMES;
    let w = Atomics.load(ctl, CTL.AUDIO_WRITE); const r = Atomics.load(ctl, CTL.AUDIO_READ);
    let avail = (w - r) | 0; // frames queued
    if (avail < 0) avail = 0;
    if (!this.chunk) this.chunk = new Float32Array(512 * 2);
    let peak = this.audioPeak ?? 0;
    const t0 = performance.now(); let rendered = 0;
    while (avail < aheadFrames) {
      rendered += 512;
      audio.render(this.chunk, 512, AUDIO_RATE);
      for (let i = 0; i < 512; i++) { const idx = ((w + i) % cap) * 2; const l = this.chunk[2 * i], r = this.chunk[2 * i + 1]; this.audioRing[idx] = l; this.audioRing[idx + 1] = r; const a = Math.max(Math.abs(l), Math.abs(r)); if (a > peak) peak = a; }
      w = (w + 512) | 0; avail += 512;
      Atomics.store(ctl, CTL.AUDIO_WRITE, w);
    }
    this.audioPeak = peak; // highest sample level since the last stats report (proves the mixer produces sound)
    if (rendered) { this.audioMs = (this.audioMs ?? 0) + (performance.now() - t0); this.audioFrames = (this.audioFrames ?? 0) + rendered; }
    if ((this.audioDiag = (this.audioDiag ?? 0) + 1) % 500 === 1 && [...audio.buffers].some((b) => b.playing && !b.primary)) vm.log('audio', `mixer: peak ${peak.toFixed(3)} queued ${avail} frames; buffers ${[...audio.buffers].map((b) => `${b.primary ? 'P' : 'S'}:${b.playing ? 'play' : 'stop'}/${b.looping ? 'loop' : 'once'} pos ${b.pos}/${b.size} vol ${b.volume} freq ${b.freq}`).join(' | ')}`);
  }
}
