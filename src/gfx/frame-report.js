// A player's display report, the renderer's half (src/shared/display-report.js: the record; the page's half, what the
// screen showed, is src/web/screen-report.js). The page asks for it through the worker debug global
// ORTHROS_FLICKER_REPORT=<id> — the emulator worker's `dbg` message, which it forwards to the render worker: no new
// message type through src/web/worker.js, one of the sources a snapshot depends on —; the flicker probe
// (flicker-probe.js), which sees every present of the context, starts a FrameReport at its next present and hands it
// the presents while it records (no probe sample, no flicker capture meanwhile):
// - the present that starts it asks the device to sign its frames' commands (d3d8-webgl.js sigOn / sigMix: the next
//   frames are signed whole);
// - for REPORT_MS from there (BB_MAX_FRAMES at most), each presented back buffer is downscaled on the GPU — a chain of
//   halving LINEAR blits (2 x 2 boxes: a small object that alternates still shows, which one filtered blit of a
//   2560-wide frame would mostly skip) then one blit to at most REPORT_IMG_W x REPORT_IMG_H — and read back through a
//   pixel buffer behind a fence (no stall: read at a later present once the fence signaled, the buffer used again),
//   with its device frame, its present time (performance.timeOrigin + now(): the page's clock), the framebuffer blitted
//   to the canvas (an id per GL object: a flipping chain's rotation shows), the back-buffer surface, the gamma pass,
//   the frame's command signature and its values record (vsig: a hash of the color values its draws read — TEXTUREFACTOR,
//   material...; tf: the draws whose TEXTUREFACTOR changed since the previous frame; csig: a hash of the shader
//   constants its draws' shaders read, cn: how many draws read other constants than the previous frame's draw of the
//   same index, cd: the first of them — d3d8-webgl.js valDraw);
// - the pictures read back are kept once each (equal pixels share one: a still scene costs one picture), and once all
//   are read the strip is made after the presents, in slices of a few ms (stripSteps' analysis, the JPEG encodes
//   asynchronous, cut to STRIP_MAX_BYTES: fitStrip) and sent on the backend's log channel as an object
//   { event: 'display-report-bb', id, strip } (src/web/main.js takes it apart, as the flicker capture's) — and when its
//   window starts, { event, id, started } (a busy emulator thread passes the page's request on late: the page then
//   records the screen until this window's end too).
// Readbacks still waiting when the presents stop (a game that froze) are polled from a timer: only the pixel-pack
// binding is touched there, given back as the backend leaves it (none).
import { REPORT_MS, REPORT_IMG_W, REPORT_IMG_H, BB_MAX_FRAMES, STRIP_MAX_BYTES, pictureSet, lumOf, stripSteps, fitStrip } from '../shared/display-report.js';
import { runSliced, SLICE_MS, counted } from '../shared/flicker-record.js';
import { encodeJpegs, upright } from './flicker-capture.js';
import { gpuInfo } from '../web/gpu-class.js';

/** presents (or timer ticks) after which readbacks not done are given up */
const STALE = 240;
const epochNow = () => performance.timeOrigin + performance.now();
const tick = () => new Promise((r) => setTimeout(r, 0));
const r1 = (x) => Math.round(x * 10) / 10;

export class FrameReport {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ id: number, send: (rec: object) => void, now?: () => number, encode?: Function, ms?: number, maxFrames?: number, timers?: boolean }} o
   * `now`: epoch ms (the page's clock); `encode`: the pictures' encoder (tests); `timers`: poll from a timer when presents stop
   */
  constructor(gl, o) {
    this.gl = gl; this.id = o.id; this.send = o.send; this.now = o.now ?? epochNow; this.encode = o.encode ?? encodeJpegs;
    this.ms = o.ms ?? REPORT_MS; this.max = o.maxFrames ?? BB_MAX_FRAMES; this.timers = o.timers ?? true;
    this.phase = 'arm'; this.shots = []; this.frames = []; this.notes = []; this.free = []; this.fbIds = new Map(); this.chain = null; this.waited = 0;
    this.pics = pictureSet(); this.lastPresent = 0; this.timer = null; this.lastDb = '';
  }
  /** it takes the presents (the probe's samples wait) */
  get active() { return this.phase === 'arm' || this.phase === 'record'; }
  /**
   * A frame is about to be shown (as FlickerProbe.present: `fbo` bound, its GL size w x h, `dev` the device presenting,
   * `sig` its command signature). Leaves `fbo` bound to FRAMEBUFFER; true when it changed other GL state (objects made:
   * the renderbuffer binding).
   */
  present(fbo, w, h, dev, sig) {
    const now = this.now();
    this.lastPresent = now;
    if (this.phase === 'arm') {
      this.t0 = now; this.fw = w; this.fh = h;
      if (dev && dev.sigOn === false) { dev.sigOn = true; this.signed = dev; }
      this.info = dev?.flickerInfo?.() ?? null;
      const gl = this.gl;
      let attrs = null; try { attrs = gl.getContextAttributes?.() ?? null; } catch { attrs = null; }
      this.glInfo = { renderer: gpuInfo(gl).renderer, drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], canvas: [gl.canvas?.width ?? null, gl.canvas?.height ?? null], colorSpace: gl.drawingBufferColorSpace ?? null, attrs };
      this.phase = 'record';
      if (this.timers) this.timer = setInterval(() => this.idle(), 100);
      this.send({ event: 'display-report-bb', id: this.id, started: this.t0 }); // (the page records the screen until this window's end too)
      return false;
    }
    let changed = false;
    if (this.phase === 'record') {
      if (now - this.t0 > this.ms || this.frames.length >= this.max) this.stopRecording();
      else if (w !== this.fw || h !== this.fh) { this.notes.push(`frame size changed to ${w}x${h} at ${r1(now - this.t0)} ms: recording stopped`); this.stopRecording(); }
      else changed = this.shoot(fbo, w, h, dev, sig, now);
    }
    this.poll();
    return changed;
  }
  /** the timer: the window ended without a present (recording stopped), readbacks polled while presents stopped */
  idle() {
    const now = this.now();
    if (now - this.lastPresent < 150) return;
    if (this.phase === 'record' && now - this.t0 > this.ms) this.stopRecording();
    if (this.phase === 'read') this.poll();
  }
  stopRecording() {
    this.phase = 'read';
    if (this.signed) { this.signed.sigOn = false; this.signed = null; }
  }
  /** the halving chain from w x h down to the picture's size: per level a renderbuffer and its framebuffer */
  makeChain(w, h) {
    const gl = this.gl, k = Math.min(1, REPORT_IMG_W / w, REPORT_IMG_H / h), tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k)), sizes = [];
    let cw = w, ch = h;
    while (cw > 2 * tw || ch > 2 * th) { cw = Math.max(tw, Math.ceil(cw / 2)); ch = Math.max(th, Math.ceil(ch / 2)); sizes.push([cw, ch]); }
    if (!sizes.length || sizes[sizes.length - 1][0] !== tw || sizes[sizes.length - 1][1] !== th) sizes.push([tw, th]);
    const levels = sizes.map(([lw, lh]) => {
      const rb = gl.createRenderbuffer(), fb = gl.createFramebuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, lw, lh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      return { rb, fb, w: lw, h: lh };
    });
    return { w, h, tw, th, levels };
  }
  /** the back buffer downscaled through the chain, read back into a pixel buffer behind a fence; its frame noted */
  shoot(fbo, w, h, dev, sig, now) {
    const gl = this.gl;
    let made = false;
    if (!this.chain) { this.chain = this.makeChain(w, h); made = true; }
    const c = this.chain;
    let src = fbo, sw = w, sh = h;
    for (const L of c.levels) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, L.fb);
      gl.blitFramebuffer(0, 0, sw, sh, 0, 0, L.w, L.h, gl.COLOR_BUFFER_BIT, sw === L.w && sh === L.h ? gl.NEAREST : gl.LINEAR);
      src = L.fb; sw = L.w; sh = L.h;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    let buf = this.free.pop();
    if (!buf) { buf = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, c.tw * c.th * 4, gl.STREAM_READ); }
    else gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.readPixels(0, 0, c.tw, c.th, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    // (the frame: its device frame, present time, the framebuffer blitted to the canvas, the back-buffer surface, the
    // gamma pass, its command signature; the drawing buffer's size when it changed)
    let fb = this.fbIds.get(fbo); if (!fb) this.fbIds.set(fbo, fb = `F${this.fbIds.size + 1}`);
    const f = { f: dev?.frame ?? null, t: r1(now - this.t0), img: -1, fb, bb: dev?.dev?.backBuffers?.[0]?.id ?? null, sig: sig === undefined ? null : (sig >>> 0).toString(16) };
    if (dev?.gammaLut) f.gamma = 1;
    // (the values its draws read beside the commands: their hash, and the draws whose TEXTUREFACTOR changed since the
    // previous frame — d3d8-webgl.js valDraw)
    const v = sig === undefined ? null : dev?.valFrame;
    if (v) { f.vsig = (v.vsig >>> 0).toString(16); if (v.tf.length) f.tf = v.tf.map(([i, a, b]) => [i, (a >>> 0).toString(16), (b >>> 0).toString(16)]); f.csig = (v.csig >>> 0).toString(16); if (v.cn) { f.cn = v.cn; f.cd = v.cd; } }
    const db = `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`; if (db !== this.lastDb) { f.db = db; this.lastDb = db; }
    this.frames.push(f);
    this.shots.push({ buf, sync, frame: f });
    return made;
  }
  /** the readbacks whose fence signaled read (in order), each picture kept once; all read (or given up): the strip made */
  poll() {
    const gl = this.gl, c = this.chain;
    try {
      while (this.shots.length) {
        const s = this.shots[0];
        if (gl.getSyncParameter(s.sync, gl.SYNC_STATUS) !== gl.SIGNALED) break;
        this.shots.shift();
        gl.deleteSync(s.sync);
        const px = new Uint8Array(c.tw * c.th * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.free.push(s.buf);
        s.frame.img = this.pics.add(upright(px, c.tw, c.th));
      }
    } catch (e) { this.notes.push(`readback failed: ${e?.message ?? e}`); this.shots.length = 0; }
    if (this.phase !== 'read') return;
    if (this.shots.length && ++this.waited < STALE) return;
    if (this.shots.length) this.notes.push(`${this.shots.length} pictures not read back in time`);
    this.phase = 'encode';
    clearInterval(this.timer); this.timer = null;
    this.drop();
    this.finish().catch((e) => { this.notes.push(`report failed: ${e?.message ?? e}`); this.send({ event: 'display-report-bb', id: this.id, strip: null, notes: this.notes }); }).finally(() => { this.phase = 'done'; });
  }
  /** the report's GL objects deleted (GL keeps them alive for the commands queued) */
  drop() {
    const gl = this.gl;
    try {
      for (const s of this.shots) { gl.deleteSync(s.sync); gl.deleteBuffer(s.buf); }
      this.shots.length = 0;
      for (const b of this.free) gl.deleteBuffer(b);
      this.free.length = 0;
      for (const L of this.chain?.levels ?? []) { gl.deleteFramebuffer(L.fb); gl.deleteRenderbuffer(L.rb); }
      if (this.chain) this.chain.levels = [];
    } catch { /* context lost */ }
  }
  /** The context was lost: nothing more to read; the page told why. */
  abort(why) {
    if (this.phase === 'done' || this.phase === 'encode') return;
    clearInterval(this.timer); this.timer = null;
    if (this.signed) { this.signed.sigOn = false; this.signed = null; }
    this.drop(); this.phase = 'done';
    this.send({ event: 'display-report-bb', id: this.id, strip: null, notes: [...this.notes, why] });
  }
  /** The strip made from the task after the last readback on, in slices (the page's frames go on between them), and sent. */
  async finish() {
    const t0 = performance.now(), work = { slices: 0, longest: 0, busy: 0, over8: 0 }, c = this.chain;
    if (!c || !this.frames.length) { // (no present in the window: a game that froze, or presents seconds apart)
      this.send({ event: 'display-report-bb', id: this.id, strip: { t0: this.t0, size: [this.fw, this.fh], img: null, q: null, frames: [], images: [], analysis: null, gl: this.glInfo, info: this.info, cut: [], notes: [...this.notes, `no frame presented in the ${this.ms} ms after the request`], took: null } });
      return;
    }
    const pics = this.pics.list, lums = [];
    for (const p of pics) { await tick(); const t = performance.now(); lums.push(lumOf(p, c.tw, c.th)); counted(work, performance.now() - t); }
    const analysis = await runSliced(stripSteps(lums, this.frames.map((f) => f.img), c.tw, c.th), SLICE_MS, work);
    const strip = { t0: this.t0, size: [this.fw, this.fh], img: [c.tw, c.th], q: null, frames: this.frames, images: [], analysis, gl: this.glInfo, info: this.info, cut: [], notes: this.notes, took: null };
    await fitStrip(strip, pics, c.tw, c.th, this.encode, STRIP_MAX_BYTES - 200);
    strip.took = { ms: Math.round(performance.now() - t0), slices: work.slices, busy: Math.round(work.busy), longest: r1(work.longest), over8: work.over8 };
    this.send({ event: 'display-report-bb', id: this.id, strip });
  }
}
