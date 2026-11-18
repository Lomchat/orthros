// A player's display report, the page's half (src/shared/display-report.js: the record; the renderer's half, the back
// buffers presented, is src/gfx/frame-report.js): what the screen showed. For REPORT_MS from the click (SCREEN_MAX_FRAMES
// at most), at every requestAnimationFrame:
// - the game's canvases' state: per canvas its size, its box on the page, z-index, visibility, display, opacity, image
//   rendering, and the transform of the element that scales them (each distinct state kept once, `layers`; a frame
//   names its state by index) — which canvas is visible, which is on top;
// - what they hold: the visible ones drawn bottom to top (their opacity applied) into a tile of a small atlas, a GPU
//   canvas — no readback during the recording (the tiles are read once it ends, a row at a time between the page's
//   frames). What a canvas holds is what the page hands the compositor: a fault of the compositor or of the display
//   itself after that is not seen here (no screen capture: it would ask the player for a permission);
// - the frames the page received meanwhile (`arrivals`: time, layer, bitmap size, the device frame when the render
//   worker names it — main.js calls arrived()) and the page's events (`events`: resize, visibility, focus, full screen,
//   pointer lock, the overlays' changes, the runtime's own — note()).
// Then the strip: the tiles read back, each distinct picture kept once, analysed (stripSteps) and encoded (fitStrip),
// in slices of a few ms.
import { REPORT_MS, REPORT_IMG_W, REPORT_IMG_H, SCREEN_MAX_FRAMES, STRIP_MAX_BYTES, pictureSet, lumOf, stripSteps, fitStrip } from '../shared/display-report.js';
import { runSliced, SLICE_MS, counted } from '../shared/flicker-record.js';
import { encodeJpegs } from '../gfx/flicker-capture.js';

const epochNow = () => performance.timeOrigin + performance.now();
const tick = () => new Promise((r) => setTimeout(r, 0));
const r1 = (x) => Math.round(x * 10) / 10;
/** tiles per atlas row and column */
const COLS = 8, ROWS = 8;
/** list lengths at most */
const MAX_EVENTS = 400, MAX_ARRIVALS = 1200;
/** the recording's length at most, as a multiple of its window (extendTo) */
const MAX_SPAN = 3;

/** what an element shows, in short: its class, shown or hidden, its transform */
function look(el) {
  let shown = null, tf = '';
  try { const cs = getComputedStyle(el); shown = cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0; tf = cs.transform; } catch { /* gone */ }
  return `${String(el.className || '').slice(0, 60)}${shown === null ? '' : shown ? ' shown' : ' hidden'}${tf && tf !== 'none' ? ` ${tf}` : ''}`;
}

export class ScreenRecorder {
  /**
   * @param {{ layers: HTMLCanvasElement[], names?: string[], frame?: HTMLElement|null, overlays?: HTMLElement[], ms?: number, maxFrames?: number, encode?: Function }} o
   * `layers`: the game's canvases in DOM order; `names`: the layer name arrived() gives each (default: its id); `frame`:
   * the element whose transform scales them; `overlays`: elements over the game whose changes are noted
   */
  constructor(o) {
    this.names = (o.names ?? o.layers.map((el) => el?.id)).filter((_, i) => o.layers[i]);
    this.layers = o.layers.filter(Boolean); this.frameEl = o.frame ?? null; this.overlays = (o.overlays ?? []).filter(Boolean);
    this.ms = o.ms ?? REPORT_MS; this.max = o.maxFrames ?? SCREEN_MAX_FRAMES; this.encode = o.encode ?? encodeJpegs;
    this.on = false; this.frames = []; this.states = []; this.stateIdx = new Map(); this.events = []; this.arrivals = []; this.notes = [];
    this.atlases = []; this.since = 0; this.tw = 0; this.th = 0; this.seen = new Map(); this.df = {};
  }
  /**
   * The renderer's window started at `t` (epoch ms; frame-report.js): the screen recorded until its end too — a busy
   * emulator thread passes the request on late —, MAX_SPAN windows from the start at most.
   */
  extendTo(t) { if (this.on) this.until = Math.max(this.until, Math.min(t + this.ms + 150, this.t0 + MAX_SPAN * this.ms)); }
  /** A frame's bitmap reached the page (before it is shown): its layer, size, the device frame it shows (or null). */
  arrived(layer, w, h, dframe = null) {
    if (!this.on) return;
    this.since++; this.df[layer] = dframe ?? null;
    if (this.arrivals.length < MAX_ARRIVALS) this.arrivals.push([r1(epochNow() - this.t0), layer, w, h, dframe ?? null]);
  }
  /** Something the runtime saw happen (its layers switched, a mode change...). */
  note(type, detail = null) {
    if (this.on && this.events.length < MAX_EVENTS) this.events.push([r1(epochNow() - this.t0), type, detail]);
  }
  /** Records, then makes the strip: resolves to it (its pictures encoded, cut to STRIP_MAX_BYTES). */
  async run() {
    this.t0 = epochNow(); this.until = this.t0 + this.ms; this.on = true;
    this.page = this.pageState();
    const off = this.listen();
    try {
      await new Promise((resolve) => {
        const step = () => { let go = false; try { go = this.capture(); } catch (e) { this.notes.push(`capture failed: ${e?.message ?? e}`); } if (go) requestAnimationFrame(step); else resolve(); };
        requestAnimationFrame(step);
      });
    } finally { this.on = false; off(); }
    if (this.frames.length >= this.max) this.notes.push(`${this.max} frames reached at ${this.frames[this.frames.length - 1].t} ms: the recording stopped there`);
    return this.make();
  }
  pageState() {
    return { dpr: globalThis.devicePixelRatio ?? null, window: [innerWidth, innerHeight], screen: [screen.width, screen.height], fullscreen: !!document.fullscreenElement, visible: document.visibilityState, focus: document.hasFocus(), pointerLock: !!document.pointerLockElement };
  }
  /** the page's events and the overlays' changes noted while it records; returns what removes the listeners */
  listen() {
    const add = [], on = (target, type, f) => { target.addEventListener(type, f); add.push([target, type, f]); };
    on(window, 'resize', () => this.note('resize', `${innerWidth}x${innerHeight}@${devicePixelRatio}`));
    on(window, 'focus', () => this.note('focus')); on(window, 'blur', () => this.note('blur'));
    on(document, 'visibilitychange', () => this.note('visibility', document.visibilityState));
    on(document, 'fullscreenchange', () => this.note('fullscreen', !!document.fullscreenElement));
    on(document, 'pointerlockchange', () => this.note('pointerlock', !!document.pointerLockElement));
    let mo = null;
    if (typeof MutationObserver === 'function') {
      mo = new MutationObserver((list) => {
        // (noted when what it shows changed: shown or not, its class, its transform — not its cursor, which an animated
        // guest cursor changes every few frames)
        for (const m of list) {
          const el = m.target, sig = look(el);
          if (this.seen.get(el) === sig) continue;
          this.seen.set(el, sig); this.note('overlay', `${el.id || el.tagName}: ${sig}`);
        }
      });
      for (const el of [...this.overlays, ...(this.frameEl ? [this.frameEl] : [])]) {
        this.seen.set(el, look(el));
        mo.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      }
    }
    return () => { for (const [t, type, f] of add) t.removeEventListener(type, f); mo?.disconnect(); };
  }
  /** one requestAnimationFrame: the canvases' state, what the visible ones hold drawn into a tile; false once done */
  capture() {
    const now = epochNow(), t = now - this.t0;
    if (now > this.until || this.frames.length >= this.max) return false;
    const st = this.layers.map((el) => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { id: el.id, w: el.width, h: el.height, box: [r1(r.left), r1(r.top), r1(r.width), r1(r.height)], z: cs.zIndex, vis: cs.visibility, disp: cs.display, op: cs.opacity, ir: cs.imageRendering };
    });
    const tf = this.frameEl ? getComputedStyle(this.frameEl).transform : null, key = JSON.stringify([st, tf]);
    let ls = this.stateIdx.get(key);
    if (ls === undefined) { ls = this.states.length; this.states.push({ canvases: st, transform: tf }); this.stateIdx.set(key, ls); }
    // (the visible canvases, bottom to top: z-index, then the page's order)
    const vis = st.map((s, i) => ({ s, i })).filter((x) => x.s.disp !== 'none' && x.s.vis !== 'hidden' && +x.s.op > 0 && x.s.w > 0 && x.s.h > 0)
      .sort((a, b) => ((parseInt(a.s.z, 10) || 0) - (parseInt(b.s.z, 10) || 0)) || a.i - b.i);
    if (!this.tw) { const s = vis[vis.length - 1]?.s ?? st[0], k = Math.min(1, REPORT_IMG_W / s.w, REPORT_IMG_H / s.h); this.tw = Math.max(1, Math.round(s.w * k)); this.th = Math.max(1, Math.round(s.h * k)); this.size = [s.w, s.h]; }
    const n = this.frames.length, a = Math.floor(n / (COLS * ROWS)), i = n % (COLS * ROWS), x = (i % COLS) * this.tw, y = Math.floor(i / COLS) * this.th;
    if (!this.atlases[a]) {
      const W = COLS * this.tw, H = ROWS * this.th, c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
      const g = c.getContext('2d', { alpha: false }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      this.atlases[a] = { c, g };
    }
    const g = this.atlases[a].g;
    g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(x, y, this.tw, this.th);
    for (const { s, i: li } of vis) { g.globalAlpha = Math.min(1, +s.op); g.drawImage(this.layers[li], 0, 0, s.w, s.h, x, y, this.tw, this.th); }
    g.globalAlpha = 1;
    // (the frame: its time, its tile, the canvases' state, the one on top, the bitmaps received since the previous one,
    // the device frame the top canvas holds when the renderer named it)
    const top = vis[vis.length - 1], df = top ? this.df[this.names[top.i]] : null;
    this.frames.push({ t: r1(t), img: n, ls, top: top?.s.id ?? null, a: this.since, ...(Number.isFinite(df) ? { df } : {}) });
    this.since = 0;
    return true;
  }
  /** the tiles read back (a row of the atlas at a time), the distinct pictures kept once, analysed and encoded */
  async make() {
    const t0 = performance.now(), work = { slices: 0, longest: 0, busy: 0, over8: 0 }, tw = this.tw, th = this.th, n = this.frames.length;
    const pics = pictureSet(), map = new Array(n).fill(-1);
    for (let a = 0; a < this.atlases.length; a++) {
      const { c, g } = this.atlases[a];
      for (let r = 0; r < ROWS; r++) {
        const first = a * COLS * ROWS + r * COLS;
        if (first >= n) break;
        await tick();
        const t = performance.now(), row = g.getImageData(0, r * th, COLS * tw, th).data;
        for (let col = 0; col < COLS && first + col < n; col++) {
          const px = new Uint8Array(tw * th * 4);
          for (let y = 0; y < th; y++) px.set(row.subarray((y * COLS * tw + col * tw) * 4, (y * COLS * tw + col * tw + tw) * 4), y * tw * 4);
          for (let k = 3; k < px.length; k += 4) px[k] = 255;
          map[first + col] = pics.add(px);
        }
        counted(work, performance.now() - t);
      }
      c.width = 1; c.height = 1; // (its memory given back now)
    }
    this.atlases = [];
    for (const f of this.frames) f.img = map[f.img] ?? -1;
    const lums = [];
    for (const p of pics.list) { await tick(); const t = performance.now(); lums.push(lumOf(p, tw, th)); counted(work, performance.now() - t); }
    const analysis = await runSliced(stripSteps(lums, this.frames.map((f) => f.img), tw, th), SLICE_MS, work);
    const strip = { t0: this.t0, size: this.size ?? null, img: [tw, th], q: null, frames: this.frames, images: [], analysis, layers: this.states, events: this.events, arrivals: this.arrivals, page: this.page, cut: [], notes: this.notes, took: null };
    if (n) await fitStrip(strip, pics.list, tw, th, this.encode, STRIP_MAX_BYTES - 200);
    strip.took = { ms: Math.round(performance.now() - t0), slices: work.slices, busy: Math.round(work.busy), longest: r1(work.longest), over8: work.over8 };
    return strip;
  }
}
