// The draw probe (the record and its analysis: src/shared/draw-probe.js): for a few seconds, what each of a frame's
// last draws did to the picture and the values it was drawn with — a frame that looks different under the same
// commands (the owner's RotWK pause menu on his RTX 4050: docs/aotr-play.md "The pause menu's veil") is then the
// game's values, the render worker's replay of them, Orthros' uniform cache or the GPU's work on the same commands.
// The flicker probe (flicker-probe.js) starts it — at a sample that flickered where nothing moved, at a still screen
// that stays (the same commands over two samples: a pause, a menu), or when asked (ORTHROS_DRAW_PROBE=1) — and hands it
// its presents until it is done. It costs nothing otherwise: the backend's draws test one field (WebGLDevice.dprobe,
// set at each present from WebGLDevice.drawProbe: drawHooks).
// Its phases:
// - 'start': the device asked to sign its frames (sigOn: the command signature and values record of each frame,
//   d3d8-webgl.js sigMix / valDraw) and, when a render worker draws, the emulator asked to stamp each draw with the
//   game's own TEXTUREFACTOR (the event { event: 'draw-probe-stamp', on } on `send`: render-worker.js / render-host.js
//   pass it to the recorder, d3d-recorder.js stampDraws; the mirror keeps the last one, d3d-mirror.js OP.PROBE);
// - 'wait': until those stamps arrive (a few frames: the emulator runs ahead), WAIT_FRAMES at most;
// - 'record' (PROBE_MS): the device's draw hooks on (dev.drawProbe): for each of the frame's last LAST_N draws (by the
//   previous frame's draw count), its values taken where the backend reads them (state: before applyState compares the
//   program's cached uniforms; after: once it drew), and its render target copied before and after the draw — one
//   NEAREST blit of the whole target into a GW x GH cell of an atlas (each cell point one native pixel); at the
//   present, the presented back buffer too, then the atlas's used rows read into a pixel buffer behind a fence (no
//   stall: read at a later present once it signaled; no free buffer, the frame's pictures are lost, not waited for);
// - 'control' (CONTROL_MS): the presented frames only (no copy between the draws: a defect they hide shows here);
// - 'read' / 'build': the readbacks awaited, then the record made in slices of a few ms between the page's frames
//   (median picture, odd frames, rectangles, figures, pictures: src/shared/draw-probe.js) and sent once — unless nothing
//   varied (no frame went A-B-A, no value moved; `sent` false: the flicker probe tries again at another still screen) and
//   it was not asked for (`force`).
// No uniform is sent again at its start (a flicker capture's warm-up does that, which could hide a stale one).
import { GW, GH, LAST_N, PROBE_MS, CONTROL_MS, MAX_FRAMES, ODD_PPM, DRAW_PROBE_VERSION, DRAW_PROBE_MAX_BYTES, gridLum, rectSum, fixedRects, medianGrid, gridAway, runOdd, varyingRects, topRects, packSums, packGrid, analyse, fitDrawProbe } from '../shared/draw-probe.js';
import { runSliced, SLICE_MS, counted } from '../shared/flicker-record.js';
import { RS, TS_TEXTURE0, TS_WORLD, TS_VIEW, TS_PROJECTION } from './d3d8-shaders.js';
import { gpuInfo } from '../web/gpu-class.js';

/** atlas cells per row */
const COLS = 16;
/** presents waited for the producer's stamps */
const WAIT_FRAMES = 30;
/** pixel buffers in flight at most (a GPU this far behind loses frames' pictures, never waited for) */
const PBOS = 32;
/** presents after which readbacks not done are given up */
const STALE = 240;
/** distinct draw descriptions / texture matrix sets kept at most */
const TABLE_MAX = 400;
/**
 * ms past its recording's own length after which a probe whose device no longer presents gives up (another device
 * presents meanwhile: its own released, a child process ended) — else it would hold the presents for the session
 */
const GONE_MS = 10000;
const tick = () => new Promise((r) => setTimeout(r, 0));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export class DrawProbe {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ send: (rec: object) => void, trigger?: object, now?: () => number, ms?: number, controlMs?: number, lastN?: number, force?: boolean }} o
   * `force`: sent whatever it finds (asked for: ORTHROS_DRAW_PROBE=1)
   */
  constructor(gl, o) {
    this.gl = gl; this.send = o.send; this.trigger = o.trigger ?? null; this.now = o.now ?? (() => performance.now());
    this.ms = o.ms ?? PROBE_MS; this.controlMs = o.controlMs ?? CONTROL_MS; this.lastN = o.lastN ?? LAST_N; this.force = !!o.force;
    this.phase = 'start'; this.sent = false; this.frames = []; this.notes = []; this.shots = []; this.free = []; this.waited = 0;
    this.objIds = new WeakMap(); this.nObj = 0;
    this.metas = []; this.metaIdx = new Map(); this.vals = []; this.valIdx = new Map(); this.tms = []; this.tmIdx = new Map(); this.xfs = []; this.xfIdx = new Map();
    this.k = 0; this.prevN = -1; this.slot = 0; this.cur = null; this.entries = []; this.dev = null; this.atlas = null; this.lostFrames = 0;
    this.maxSlots = 2 * this.lastN + 1; this.rows = Math.ceil(this.maxSlots / COLS);
  }
  /** it takes the presents (no flicker sample, capture or display report meanwhile) */
  get active() { return this.phase === 'start' || this.phase === 'wait' || this.phase === 'record' || this.phase === 'control'; }
  get done() { return this.phase === 'done'; }
  /** a small id per GL object (the record names them) */
  id(o) { if (!o) return 0; let v = this.objIds.get(o); if (!v) this.objIds.set(o, v = ++this.nObj); return v; }

  /**
   * A frame is about to be shown (FlickerProbe.present's arguments: `fbo` its back buffer's framebuffer, bound, of GL
   * size w x h; `dev` the device presenting; `sig` its command signature). Leaves `fbo` bound to FRAMEBUFFER; true
   * when it changed other GL state the device caches (its objects made).
   */
  present(fbo, w, h, dev, sig) {
    const now = this.now();
    if (this.phase !== 'start' && this.active && dev !== this.dev && now - this.t0 > this.ms + this.controlMs + GONE_MS) { this.abort('its device stopped presenting'); return false; }
    if (this.phase === 'start') {
      if (!dev?.dev) { this.notes.push('no device'); this.phase = 'done'; return false; }
      this.dev = dev; this.w = w; this.h = h; this.t0 = now; this.path = dev.dev.mirror ? 'worker' : 'thread';
      if (dev.sigOn === false) { dev.sigOn = true; this.signed = dev; }
      if (dev.dev.mirror) { dev.dev.probeTf = undefined; this.send({ event: 'draw-probe-stamp', on: 1 }); this.stamping = true; }
      this.phase = 'wait';
      return false;
    }
    if (this.phase === 'wait') {
      if (dev !== this.dev) return false; // (another device's present)
      if (this.path === 'worker' && dev.dev.probeTf === undefined && ++this.waited < WAIT_FRAMES) return false;
      if (this.path === 'worker' && dev.dev.probeTf === undefined) this.notes.push(`no producer stamp within ${WAIT_FRAMES} frames: the producer's TEXTUREFACTOR unknown`);
      this.stamps = this.path === 'thread' || dev.dev.probeTf !== undefined;
      this.makeAtlas();
      this.prevN = dev.valFrame?.draws ?? -1; this.k = 0; this.slot = 0; this.entries = []; this.tRec = now; this.tFirst = now;
      this.phase = 'record'; dev.drawProbe = this; // (its hooks from the next frame: dev.drawHooks at the end of this present)
      gl0(this.gl, fbo);
      return true;
    }
    let changed = false;
    if (this.phase === 'record' || this.phase === 'control') {
      if (dev !== this.dev) return false;
      if (w !== this.w || h !== this.h) { this.notes.push(`frame size changed to ${w}x${h}: recording stopped`); this.stop(); }
      else {
        this.endFrame(fbo, w, h, dev, sig, now);
        if (this.phase === 'record' && now - this.tRec >= this.ms) { this.phase = 'control'; this.tCtl = now; dev.drawProbe = null; this.cur = null; }
        else if (this.phase === 'control' && now - this.tCtl >= this.controlMs) this.stop();
        if (this.frames.length >= MAX_FRAMES) this.stop();
      }
    }
    this.poll();
    return changed;
  }
  /** recording over: the device's hooks and signatures off, the producer's stamps off */
  stop() {
    if (this.dev?.drawProbe === this) this.dev.drawProbe = null;
    if (this.signed) { this.signed.sigOn = false; this.signed = null; }
    if (this.stamping) { this.send({ event: 'draw-probe-stamp', on: 0 }); this.stamping = false; }
    this.cur = null; this.phase = 'read'; this.waited = 0;
  }
  /** The context was lost (or the probe switched off): nothing sent. */
  abort(why) {
    if (this.phase === 'done') return;
    if (this.dev?.drawProbe === this) this.dev.drawProbe = null;
    if (this.dev?.dprobe === this) this.dev.dprobe = null; // (no draw reaches it before the next present)
    if (this.signed) { this.signed.sigOn = false; this.signed = null; }
    if (this.stamping) { try { this.send({ event: 'draw-probe-stamp', on: 0 }); } catch { /* gone */ } this.stamping = false; }
    this.notes.push(why); this.drop(); this.phase = 'done';
  }
  makeAtlas() {
    const gl = this.gl, rb = gl.createRenderbuffer(), fb = gl.createFramebuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, COLS * GW, this.rows * GH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    this.atlas = { rb, fb };
  }

  // ---------------------------------------------------------------- the device's hooks (WebGLDevice.dprobe: drawHooks)
  /**
   * applyState of a draw, its target bound, before it looks at the program's cached values (WebGLDevice.applyState,
   * while the frame is signed). Every draw of the frame comes here: the last LAST_N are probed.
   */
  state(d, P, info, tgt) {
    if (this.phase !== 'record') { this.cur = null; return; } // (hooks left until the next present after it ended)
    const k = this.k++;
    if (d !== this.dev || k < this.prevN - this.lastN || this.slot + 3 > this.maxSlots) { this.cur = null; return; }
    const dev = d.dev, pv = P.v, tsv = dev.transformSlotVersion, tall = dev.transformAllVersion;
    const tfM = d.rs(RS.TEXTUREFACTOR, 0xffffffff) >>> 0;
    // (the stages' texture matrices: their values, and whether this program had seen their version)
    let tm = null;
    for (let i = 0; i < info.stages.length; i++) {
      const ttff = info.stages[i].ttff >>> 0; if (!(ttff & 0xff)) continue;
      const slot = TS_TEXTURE0 + i, m = dev.transforms.get(slot), ver = Math.max(tsv.get(slot) ?? 0, tall), seen = pv?.ts?.get(slot) === ver ? 1 : 0;
      (tm ??= []).push(m ? [i, ttff, seen, r4(m[0]), r4(m[1]), r4(m[4]), r4(m[5]), r4(m[8]), r4(m[9]), r4(m[12]), r4(m[13])] : [i, ttff, seen]);
    }
    this.cur = { k, d, P, tgt, tm, tfM, xh: xfHash(dev.transforms), tfP: this.path === 'thread' ? tfM : dev.probeTf, pvS: pv ? pv.s === dev.stateVersion : false, pvT: pv ? pv.t === dev.transformVersion : false,
      svB: pv?.sv?.tf, up0: d.stats.uploads, bs: -1, as: -1, mode: 0, start: 0, count: 0 };
  }
  /** right before the draw's GL call: its target copied */
  before(d, P, mode, start, count) {
    const c = this.cur; if (c === null || c.d !== d) return;
    c.mode = mode; c.start = start; c.count = count; c.bs = this.slot++;
    this.snap(c.bs, c.tgt, d.gs);
  }
  /** right after it: its target copied again, the values it was drawn with kept */
  after(d, P) {
    const c = this.cur; if (c === null || c.d !== d || c.bs < 0) return;
    this.cur = null;
    c.as = this.slot++;
    this.snap(c.as, c.tgt, d.gs);
    this.entries.push(this.describe(c));
  }
  /** a target's GW x GH grid into atlas cell `slot` (scissor and color mask out of the way, the target bound again) */
  snap(slot, tgt, gs) {
    const gl = this.gl, x = (slot % COLS) * GW, y = Math.floor(slot / COLS) * GH, sc = gs.en[gl.SCISSOR_TEST], cw = gs.cw;
    if (sc !== false) gl.disable(gl.SCISSOR_TEST);
    if (cw !== undefined && cw !== 15) gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tgt.fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.atlas.fb);
    gl.blitFramebuffer(0, 0, tgt.w, tgt.h, x, y, x + GW, y + GH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
    if (sc === true) gl.enable(gl.SCISSOR_TEST); else if (sc === undefined) gs.en[gl.SCISSOR_TEST] = false;
    if (cw !== undefined && cw !== 15) gl.colorMask((cw & 1) !== 0, (cw & 2) !== 0, (cw & 4) !== 0, (cw & 8) !== 0);
  }
  /** a probed draw's entry: [draw index, description, values, texture matrices, start, count, vertex base, uploads] */
  describe(c) {
    const d = c.d, dev = d.dev, P = c.P, pv = P.v, tgt = c.tgt, gs = d.gs, gl = this.gl, id = (o) => this.id(o);
    const hasU = !!P.u('u_tfactor'), svA = pv?.sv?.tf;
    const flags = (hasU ? 1 : 0) | (c.pvS ? 2 : 0) | (hasU && svA !== c.svB ? 4 : 0) | (c.pvT ? 8 : 0) | (c.tfP !== undefined ? 16 : 0);
    const vals = [c.tfP === undefined ? null : c.tfP >>> 0, c.tfM, c.svB === undefined ? null : c.svB >>> 0, svA === undefined ? null : svA >>> 0, P.tfSent === undefined ? null : P.tfSent >>> 0, flags];
    const rt = dev.renderTarget ?? dev.backBuffers[0], v = d.curVao, s0 = dev.streams?.[0], vb = s0 ? d.comImpl(s0.vb) : null, ib = d.comImpl(dev.indices?.ib);
    const en = (cap) => (gs.en[cap] ? 1 : 0);
    const meta = `prog ${id(P.prog)} sig ${P.sid ?? '-'} key ${keyHash(P.key)}${hasU ? ' tf' : ''} | target fb ${id(tgt.fbo)} color ${id(tgt.color)} depth ${id(tgt.depth)} surface ${rt?.id ?? '-'} ds ${dev.depthTarget?.id ?? '-'} ${tgt.w}x${tgt.h}${tgt.flip ? ' flipped' : ''}`
      + ` | vao ${id(v?.vao)} ebo ${id(v?.ib)} vb ${vb?.id ?? '-'} buf ${id(vb ? d.buffers.get(vb.id)?.buf : null)} stride ${s0?.stride ?? '-'} off ${s0?.offset ?? 0} ib ${ib?.id ?? '-'} | mode ${c.mode}`
      + ` | blend ${en(gl.BLEND)} ${gs.bs ?? '-'}/${gs.bd ?? '-'} op ${gs.bop ?? '-'} cw ${gs.cw ?? '-'} depth ${en(gl.DEPTH_TEST)} ${gs.depthFunc ?? '-'} zw ${gs.depthMask ? 1 : 0} stencil ${en(gl.STENCIL_TEST)} cull ${en(gl.CULL_FACE)} scissor ${en(gl.SCISSOR_TEST)} vp ${gs.vpx},${gs.vpy},${gs.vpw},${gs.vph}`;
    return [c.k, intern(this.metas, this.metaIdx, meta, meta), intern(this.vals, this.valIdx, vals.join(','), vals), c.tm ? intern(this.tms, this.tmIdx, JSON.stringify(c.tm), c.tm) : -1, c.start, c.count, v?.base ?? null, d.stats.uploads - c.up0, c.bs, c.as, intern(this.xfs, this.xfIdx, String(c.xh), c.xh)];
  }

  // ---------------------------------------------------------------- frames, readbacks
  /** the presented back buffer copied, the frame's cells read back into a pixel buffer behind a fence */
  endFrame(fbo, w, h, dev, sig, now) {
    const gl = this.gl, ps = Math.min(this.slot, this.maxSlots - 1);
    this.snap(ps, { fbo, w, h }, dev.gs);
    const rows = Math.floor(ps / COLS) + 1, v = dev.valFrame;
    const fr = { f: dev.frame, t: Math.round((now - this.tFirst) * 10) / 10, n: this.phase === 'record' ? this.k : v?.draws ?? null, sig: sig === undefined ? null : (sig >>> 0).toString(16),
      vsig: v ? (v.vsig >>> 0).toString(16) : null, tf: v?.tf?.length ? v.tf.map(([i, a, b]) => [i, (a >>> 0).toString(16), (b >>> 0).toString(16)]) : undefined, fb: this.id(fbo), ctl: this.phase === 'control' ? 1 : 0,
      d: this.phase === 'record' ? this.entries.map((e) => e.slice(0, 8)) : [], cells: this.phase === 'record' ? this.entries.map((e) => [e[8], e[9]]) : [], ps, grids: null };
    if (this.phase === 'record') { this.prevN = this.k; this.k = 0; this.slot = 0; this.entries = []; this.cur = null; }
    let buf = this.free.pop();
    if (!buf && this.shots.length < PBOS) { buf = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, COLS * GW * this.rows * GH * 4, gl.STREAM_READ); }
    else if (buf) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    if (buf) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.atlas.fb);
      gl.readPixels(0, 0, COLS * GW, rows * GH, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.shots.push({ buf, sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), fr, rows, at: this.frames.length });
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    } else this.lostFrames++; // (the GPU is behind: this frame's pictures given up, never waited for)
    this.frames.push(fr);
  }
  /** the readbacks whose fence signaled read, in order: each cell as a luminance grid; all read: the record made */
  poll() {
    const gl = this.gl;
    try {
      while (this.shots.length) {
        const s = this.shots[0];
        if (gl.getSyncParameter(s.sync, gl.SYNC_STATUS) !== gl.SIGNALED) break;
        this.shots.shift(); gl.deleteSync(s.sync);
        const px = new Uint8Array(COLS * GW * s.rows * GH * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px, 0, px.length); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.free.push(s.buf);
        const fr = s.fr, cell = (slot, upright) => gridLum(px, COLS * GW, (slot % COLS) * GW, Math.floor(slot / COLS) * GH, upright);
        fr.grids = { present: cell(fr.ps, true), cells: fr.cells.map(([b, a], j) => { const up = !fr.d[j] || !this.flipOf(fr.d[j][1]); return [cell(b, up), cell(a, up)]; }) };
      }
    } catch (e) { this.notes.push(`readback failed: ${e?.message ?? e}`); this.shots.length = 0; }
    if (this.phase !== 'read') return;
    if (this.shots.length && ++this.waited < STALE) return;
    if (this.shots.length) this.notes.push(`${this.shots.length} frames not read back in time`);
    this.phase = 'build';
    this.drop();
    this.finish().catch((e) => { this.notes.push(`record failed: ${e?.message ?? e}`); }).finally(() => { this.phase = 'done'; });
  }
  /** whether the draw described by meta index `m` drew into a y-flipped (texture) target */
  flipOf(m) { return / flipped \|/.test(this.metas[m] ?? ''); }
  drop() {
    const gl = this.gl;
    try {
      for (const s of this.shots) { gl.deleteSync(s.sync); gl.deleteBuffer(s.buf); }
      this.shots.length = 0;
      for (const b of this.free) gl.deleteBuffer(b);
      this.free.length = 0;
      if (this.atlas) { gl.deleteFramebuffer(this.atlas.fb); gl.deleteRenderbuffer(this.atlas.rb); this.atlas = null; }
    } catch { /* context lost */ }
  }

  // ---------------------------------------------------------------- the record
  /** The record made in slices (the page's frames go on between them), then sent unless nothing varied on a still screen. */
  async finish() {
    const t0 = performance.now(), work = { slices: 0, longest: 0, busy: 0, over8: 0 };
    const step = async (f) => { await tick(); const t = performance.now(), v = f(); counted(work, performance.now() - t); return v; };
    const frames = this.frames.filter((f) => f.grids);
    this.result = { frames: this.frames.length, probed: 0, odd: 0, path: this.path, stamps: !!this.stamps };
    if (!frames.length) { this.notes.push('no frame read back'); return; }
    const presents = frames.map((f) => f.grids.present);
    const ref = await step(() => medianGrid(presents));
    // (odd: a frame that went A-B-A between its neighbours, or in a run of up to MAX_RUN frames of one other picture
    // between two equal ones — A-B-B-A —: runOdd; `away`: its share away from the median picture; the
    // rectangles where the odd frames differed most — without odd frames, where the frames varied most)
    const vmap = new Uint8Array(GW * GH);
    await step(() => {
      const P = this.frames.map((f) => f.grids?.present ?? null);
      // (a run's frames are odd only away from the median picture: in A-A-B-A-A-B the A-As are a run between Bs too, but
      // the usual picture; in runs of 3 and 3 the median takes one of the two pictures, the other one is odd)
      this.frames.forEach((f, k) => { if (!f.grids) return; const a = gridAway(f.grids.present, ref), r = runOdd(P, k, vmap); f.away = a.ppm; f.mad = a.mad; f.odd = r === null || a.ppm >= ODD_PPM ? r : Math.min(r, ODD_PPM - 1); });
    });
    const anyOdd = frames.some((f) => f.odd >= ODD_PPM);
    const varR = await step(() => (anyOdd ? topRects(vmap) : varyingRects(presents, ref))), fix = fixedRects().filter((r) => !varR.some((v) => Math.abs(v[0] - r[0]) < 4 && Math.abs(v[1] - r[1]) < 4));
    const rects = [...varR, ...fix], kinds = [...varR.map(() => 'var'), ...fix.map(() => 'fix')];
    await runSliced((function* () {
      for (const f of frames) {
        const sums = [];
        if (!f.ctl) for (const [b, a] of f.grids.cells) { for (const r of rects) sums.push(rectSum(b, r)); for (const r of rects) sums.push(rectSum(a, r)); }
        for (const r of rects) sums.push(rectSum(f.grids.present, r));
        f.p = packSums(sums);
        yield;
      }
    })(), SLICE_MS, work);
    // (pictures: the reference frame's and the oddest frames' presented pictures; for the oddest probed frame and the
    // reference one, before and after the draws whose effect differed most between them)
    const pics = [], probed = frames.filter((f) => !f.ctl && f.grids.cells.length);
    const refF = probed.length ? probed.reduce((m, f) => (f.odd < m.odd ? f : m)) : frames[0];
    pics.push({ frame: this.frames.indexOf(refF), what: 'present (reference)', img: packGrid(refF.grids.present) });
    const oddest = frames.filter((f) => f.odd >= ODD_PPM).sort((a, b) => b.odd - a.odd);
    for (const f of oddest.slice(0, 3)) pics.push({ frame: this.frames.indexOf(f), what: 'present (odd)', img: packGrid(f.grids.present) });
    const oddP = oddest.find((f) => !f.ctl && f.grids.cells.length);
    if (oddP && refF && oddP !== refF) {
      await step(() => {
        const effect = (f, j) => { const [b, a] = f.grids.cells[j]; let s = 0; for (let p = 0; p < GW * GH; p++) s += a[p] - b[p]; return s / (GW * GH); };
        const byPos = (f) => new Map(f.d.map((e, j) => [f.n - e[0], j]));
        const pr = byPos(refF), po = byPos(oddP), diffs = [];
        for (const [pos, j] of po) { const i = pr.get(pos); if (i !== undefined) diffs.push([Math.abs(effect(oddP, j) - effect(refF, i)), pos, j, i]); }
        diffs.sort((a, b) => b[0] - a[0]);
        for (const [, pos, j, i] of diffs.slice(0, 2)) {
          pics.push({ frame: this.frames.indexOf(refF), what: `before draw ${pos} from the end (reference)`, img: packGrid(refF.grids.cells[i][0]) }, { frame: this.frames.indexOf(refF), what: `after draw ${pos} from the end (reference)`, img: packGrid(refF.grids.cells[i][1]) });
          pics.push({ frame: this.frames.indexOf(oddP), what: `before draw ${pos} from the end (odd)`, img: packGrid(oddP.grids.cells[j][0]) }, { frame: this.frames.indexOf(oddP), what: `after draw ${pos} from the end (odd)`, img: packGrid(oddP.grids.cells[j][1]) });
        }
      });
    }
    const gl = this.gl;
    const rec = {
      event: 'draw-probe', v: DRAW_PROBE_VERSION, trigger: this.trigger, gl: { renderer: gpuInfo(gl).renderer, drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight] },
      size: [this.w, this.h], mode: `${this.dev.dev.pp?.width}x${this.dev.dev.pp?.height}`, path: this.path, stamps: !!this.stamps, grid: [GW, GH], lastN: this.lastN,
      rects, rectKinds: kinds,
      frames: this.frames.map((f) => ({ f: f.f, t: f.t, n: f.n, sig: f.sig, vsig: f.vsig, tf: f.tf, fb: f.fb, ctl: f.ctl, odd: f.odd ?? null, away: f.away ?? null, mad: f.mad ?? null, d: f.d, p: f.p ?? null })),
      metas: this.metas, vals: this.vals, tms: this.tms, xfs: this.xfs, pics, summary: null, cut: [], notes: this.notes.slice(), took: null,
    };
    if (this.lostFrames) rec.notes.push(`${this.lostFrames} frames' pictures given up (no free pixel buffer: the GPU behind)`);
    const sum = await step(() => analyse(rec));
    rec.summary = { frames: sum.frames, probed: sum.probed, control: sum.control, odd: sum.odd, oddProbed: sum.oddProbed, oddControl: sum.oddControl, moved: sum.moved, verdict: sum.verdict };
    // (nothing varied — no frame came back A-B-A, no value moved —: not sent, the flicker probe tries at another screen)
    const valuesMoved = sum.draws.some((d) => d.tfP.length > 1 || d.tfM.length > 1); // (values past the bounded tables are unknown, never 'moved')
    // (odd frames whose culprit is a layer with moving texture matrices: an animation going back and forth — a menu's,
    // the pause menu's swirl —, not the session's one record: tried again at another screen)
    const culprit = sum.draws.find((d) => d.pos === sum.moved[0]), animated = !valuesMoved && (culprit?.tms ?? 0) > 1;
    if (animated) this.notes.push(`odd frames from an animated layer (draw ${culprit.pos} from the end: its texture matrices moved)`);
    const interesting = (sum.odd >= 2 && !animated) || valuesMoved;
    this.result = { frames: sum.frames, probed: sum.probed, odd: sum.odd, path: this.path, stamps: !!this.stamps };
    if (!this.force && !interesting) { this.notes.push('nothing varied'); return; }
    await step(() => fitDrawProbe(rec, DRAW_PROBE_MAX_BYTES - 200));
    rec.took = { ms: Math.round(performance.now() - t0), slices: work.slices, busy: Math.round(work.busy), longest: Math.round(work.longest * 10) / 10, over8: work.over8 };
    if (this.phase === 'done') return; // (aborted while it was made: context lost, probe switched off — not sent)
    this.sent = true;
    this.send(rec);
  }
}
/** FRAMEBUFFER bound to `fbo` (what present expects back) */
function gl0(gl, fbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); }
/** a value's index in a table of distinct ones (TABLE_MAX at most: -1 past it) */
function intern(list, idx, key, value) {
  let i = idx.get(key);
  if (i === undefined) { if (list.length >= TABLE_MAX) return -1; i = list.length; list.push(value); idx.set(key, i); }
  return i;
}
function keyHash(s) { let h = 0x811c9dc5; const t = String(s ?? ''); for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16); }
/** a hash of the world, view and projection matrices as the backend's device has them at the draw (their bits) */
function xfHash(transforms) {
  let h = 0x811c9dc5;
  for (const slot of [TS_WORLD, TS_VIEW, TS_PROJECTION]) {
    const m = transforms?.get(slot);
    if (!m) { h = Math.imul(h ^ slot, 0x01000193); continue; }
    const w = new Int32Array(m.buffer, m.byteOffset, 16);
    for (let i = 0; i < 16; i++) h = Math.imul(h ^ w[i], 0x01000193);
  }
  return h >>> 0;
}
