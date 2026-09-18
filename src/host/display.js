// Host abstraction seen by the VM/window manager: a display to present surfaces on, an input
// event source, and scheduler hooks. HeadlessHost is used by Node tests and the CLI runner;
// the browser worker host lives in src/host/web/.

export class HeadlessHost {
  /**
   * @param {{ clock: any, width?: number, height?: number }} opts
   */
  constructor(opts) {
    this.clock = opts.clock;
    this.display = new HeadlessDisplay(opts.width ?? 1024, opts.height ?? 768);
    /** pending input events (see user32 input handling for the event shapes) */
    this.inputQueue = [];
    /** scripted events: [{ at: ms, ev }] delivered when the clock passes `at` */
    this.script = [];
    this.exitCode = null;
    this.onFrame = null;
  }

  /** Called by the scheduler when idle: move due scripted events into the input queue. */
  pump() {
    const now = this.clock.now();
    while (this.script.length && this.script[0].at <= now) this.inputQueue.push(this.script.shift().ev);
  }

  /** Earliest time an external event is known to arrive (for the scheduler). */
  nextWake() { return this.script.length ? this.script[0].at : undefined; }

  /** Block up to ms waiting for an event (virtual clock: just advance). */
  waitEvent(ms) {
    const next = this.nextWake();
    const target = Math.min(this.clock.now() + ms, next ?? Infinity);
    this.clock.sleepUntil(target);
    this.pump();
  }

  pollInput() { this.pump(); return this.inputQueue.length ? this.inputQueue.splice(0) : null; }

  onExit(code) { this.exitCode = code; }

  /** Queue an input event to be delivered at virtual time `at` (ms). */
  at(ms, ev) { this.script.push({ at: ms, ev }); this.script.sort((a, b) => a.at - b.at); }
}

export class HeadlessDisplay {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.bpp = 32;
    this.fullscreen = false;
    this.frames = 0;
    /** last presented frame: { x, y, width, height, pixels: Uint32Array (0x00RRGGBB) } */
    this.last = null;
    this.title = '';
    this.cursorVisible = true;
    this.modes = [[640, 480], [800, 600], [1024, 768], [1280, 720], [1280, 1024], [1600, 1200], [1920, 1080]];
  }

  /** Present a surface region at screen position (x, y). Copies the pixels (headless). */
  present(surface, x, y, w = surface.width, h = surface.height) {
    const pixels = new Uint32Array(w * h);
    const row = new Uint32Array(w);
    for (let yy = 0; yy < h; yy++) { surface.readRow(yy, 0, w, row); pixels.set(row, yy * w); }
    this.last = { x, y, width: w, height: h, pixels };
    this.frames++;
  }

  pixelAt(x, y) {
    const f = this.last;
    if (!f || x < f.x || y < f.y || x >= f.x + f.width || y >= f.y + f.height) return -1;
    return f.pixels[(y - f.y) * f.width + (x - f.x)];
  }

  setMode(width, height, bpp, fullscreen) {
    this.width = width; this.height = height; this.bpp = bpp || 32; this.fullscreen = fullscreen;
    return true;
  }

  setTitle(t) { this.title = t; }
  showCursor(v) { this.cursorVisible = v; }
}
