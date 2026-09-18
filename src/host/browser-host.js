// Browser host (runs inside the worker): display over OffscreenCanvas (2D layer for GDI
// surfaces, WebGL2 layer for Direct3D), input from the page through a SharedArrayBuffer ring,
// audio through a float ring consumed by an AudioWorklet, cooperative waits (the worker returns
// to its event loop between slices so the canvases get presented).
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
    this.image = null; this.row = null;
    this.glActive = false;
    this.resize(width, height);
  }
  resize(w, h) {
    this.width = w; this.height = h;
    if (this.canvas2d.width !== w || this.canvas2d.height !== h) { this.canvas2d.width = w; this.canvas2d.height = h; }
    if (this.canvasGl.width !== w || this.canvasGl.height !== h) { this.canvasGl.width = w; this.canvasGl.height = h; }
    this.ctx = this.canvas2d.getContext('2d', { alpha: false });
    this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, w, h);
    this.host.post({ type: 'mode', width: w, height: h, fullscreen: this.fullscreen });
  }
  /** Present a GDI surface region at (x, y) on the 2D layer. */
  present(surface, x, y, w = surface.width, h = surface.height) {
    if (w <= 0 || h <= 0) return;
    if (!this.image || this.image.width !== w || this.image.height !== h) { this.image = new ImageData(w, h); this.row = new Uint32Array(w); }
    const px = new Uint32Array(this.image.data.buffer);
    const row = this.row;
    for (let yy = 0; yy < h; yy++) {
      surface.readRow(yy, 0, w, row);
      const o = yy * w;
      for (let i = 0; i < w; i++) { const c = row[i]; px[o + i] = 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff); } // 0x00RRGGBB -> ABGR bytes R,G,B,A
    }
    this.ctx.putImageData(this.image, x, y);
    this.frames++;
    this.host.framePresented();
  }
  setMode(width, height, bpp, fullscreen) {
    this.fullscreen = fullscreen; this.bpp = bpp || 32;
    this.resize(width, height);
    return true;
  }
  setTitle(t) { this.title = t; this.host.post({ type: 'title', title: t }); }
  showCursor(v) { if (this.cursorVisible !== v) { this.cursorVisible = v; this.host.post({ type: 'cursor', visible: v }); } }
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
    this.frameTimes = [];
    this.gfx = null; // Direct3D backend factory, installed by the worker when WebGL2 is available
    this.frameHook = () => { if (!this.display.glActive) { this.display.glActive = true; this.post({ type: 'gl', active: true }); } this.framePresented(); };
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
    Atomics.wait(this.ctl, CTL.WAKE, 0, t);
    this.pump();
  }
  pollInput() { this.pump(); return this.inputQueue.length ? this.inputQueue.splice(0) : null; }
  onExit(code) { this.exitCode = code; this.post({ type: 'exit', code }); }
  framePresented() {
    this.framesPresented++;
    const now = performance.now();
    if (this.lastFrameAt) { this.frameTimes.push(now - this.lastFrameAt); if (this.frameTimes.length > 600) this.frameTimes.shift(); }
    this.lastFrameAt = now;
  }
  /** Fill the audio ring up to `aheadFrames` using the VM mixer. */
  renderAudio(vm, aheadFrames = 4096) {
    const audio = vm.audio; if (!audio) return;
    const ctl = this.ctl;
    const cap = AUDIO_RING_FRAMES;
    let w = Atomics.load(ctl, CTL.AUDIO_WRITE); const r = Atomics.load(ctl, CTL.AUDIO_READ);
    let avail = (w - r) | 0; // frames queued
    if (avail < 0) avail = 0;
    if (!this.chunk) this.chunk = new Float32Array(512 * 2);
    while (avail < aheadFrames) {
      audio.render(this.chunk, 512, AUDIO_RATE);
      for (let i = 0; i < 512; i++) { const idx = ((w + i) % cap) * 2; this.audioRing[idx] = this.chunk[2 * i]; this.audioRing[idx + 1] = this.chunk[2 * i + 1]; }
      w = (w + 512) | 0; avail += 512;
      Atomics.store(ctl, CTL.AUDIO_WRITE, w);
    }
  }
}
