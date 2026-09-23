// Browser host (runs inside the worker): display over worker-owned OffscreenCanvases (2D layer for
// GDI surfaces, WebGL2 layer for Direct3D) whose complete frames are handed to the page as
// ImageBitmaps, input from the page through a SharedArrayBuffer ring, audio through a float ring
// consumed by an AudioWorklet, cooperative waits (the worker returns to its event loop between
// slices). Frames are explicit on purpose: a placeholder canvas committed automatically at the end
// of a worker task showed half-drawn or missing frames under load.
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
    this.resize(width, height);
  }
  resize(w, h) {
    this.width = w; this.height = h;
    if (this.canvas2d.width !== w || this.canvas2d.height !== h) { this.canvas2d.width = w; this.canvas2d.height = h; }
    if (this.canvasGl.width !== w || this.canvasGl.height !== h) { this.canvasGl.width = w; this.canvasGl.height = h; }
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
    let bitmap;
    try { bitmap = this.canvasGl.transferToImageBitmap(); } catch { return; } // (WebGL context lost: no frame until it is restored)
    this.host.post({ type: 'frame', layer: 'gl', bitmap }, [bitmap]);
    if (!this.glActive) { this.glActive = true; this.host.post({ type: 'gl', active: true }); }
  }
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
    const enc = image.frames.map((f) => { const c = new OffscreenCanvas(f.w, f.h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.rgba.buffer, f.rgba.byteOffset, f.w * f.h * 4), f.w, f.h), 0, 0); return c.convertToBlob({ type: 'image/png' }).then((b) => b.arrayBuffer()); });
    Promise.all(enc).then((pngs) => {
      this.host.post({ type: 'cursor-def', id: key, frames: image.frames.map((f, i) => ({ png: pngs[i], hotX: f.hotX, hotY: f.hotY })), steps: image.steps });
      if (this.cursorKey === key) this.host.post({ type: 'cursor-set', id: key });
    }).catch(() => {});
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
    this.frameTimes = []; // rolling window for the live stats
    this.frameLog = []; // every frame since start as (presented at ms, frame time ms) pairs — whole-run percentiles
    this.gfx = null; // Direct3D backend factory, installed by the worker when WebGL2 is available
    this.frameHook = () => { const t0 = performance.now(); this.display.presentGl(); this.presentMs += performance.now() - t0; this.framePresented(); };
    this.presentMs = 0;
    // slow-frame diagnostics: the worker installs `frameProbe()` (counters snapshot) and `onSlowFrame(dt, deltas)`
    this.frameProbe = null; this.onSlowFrame = null; this.lastProbe = null; this.slowFrameLogs = 0; this.slowFrameFrom = 0;
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
        case EV.MOUSEDOWN: this.inputQueue.push({ type: 'mousedown', button: a, x: b, y: c }); break;
        case EV.MOUSEUP: this.inputQueue.push({ type: 'mouseup', button: a, x: b, y: c }); break;
        case EV.WHEEL: this.inputQueue.push({ type: 'wheel', delta: a / 120, x: b, y: c }); break;
        case EV.KEYDOWN: this.inputQueue.push({ type: 'keydown', vk: a, scan: b & 0xff, extended: (b & 0x100) !== 0, repeat: c }); break;
        case EV.KEYUP: this.inputQueue.push({ type: 'keyup', vk: a, scan: b & 0xff, extended: (b & 0x100) !== 0 }); break;
        case EV.CHAR: this.inputQueue.push({ type: 'char', code: a }); break;
        case EV.FOCUS: this.inputQueue.push({ type: 'focus', focused: a !== 0 }); break;
      }
    }
    Atomics.store(ctl, CTL.IN_TAIL, tail);
  }
  nextWake() { return undefined; }
  /** Nested waits (inside callbacks) block the worker briefly; woken early by input. */
  waitEvent(ms) {
    const t = Math.min(ms, 50);
    this.audioHook?.(); // (the audio ring filled before blocking: a nested wait must not starve the output)
    Atomics.wait(this.ctl, CTL.WAKE, 0, t);
    this.pump();
  }
  pollInput() { this.pump(); return this.inputQueue.length ? this.inputQueue.splice(0) : null; }
  onExit(code) { this.exitCode = code; this.post({ type: 'exit', code }); }
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
    const now = performance.now();
    if (this.lastFrameAt) { const dt = now - this.lastFrameAt; this.frameTimes.push(dt); if (this.frameTimes.length > 600) this.frameTimes.shift(); this.frameLog.push(now, dt); this.probeFrame(dt); }
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
