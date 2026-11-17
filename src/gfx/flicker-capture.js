// A look at a player's flicker, once per session (the owner's AotR frames alternate on his GPU only, 2026-11-17 — 72 %
// of a frame with ?glworker=0, an oval of 13 % with the render worker —, never on SwiftShader): the first time a
// flicker-probe sample (flicker-probe.js) finds strong flicker (still A-B-A >= CAPTURE_STILL), the probe hands its next
// presents to a capture that
// - records the GL work of the following frames: the context's methods wrapped on its prototype for those frames only
//   (no cost before or after: nothing is wrapped until a capture starts, and the prototype gets its own methods back),
//   one warm-up frame (the programs' uniforms sent again by the backend — WebGLDevice.flickerResend — so that their
//   values are known) and FRAMES frames kept. Per frame: its passes in order (the work drawn into one framebuffer,
//   `fb`), each pass's draws, clears, blits, readbacks, copies, the GL error once at the pass's end (one getError: a
//   round trip to the GPU process, a few per frame, capture frames only; once per frame on a software rasterizer, where
//   it waits for the queued work) and the framebuffer's status when incomplete;
//   per draw (DRAW_FIELDS, src/shared/flicker-record.js) its program, the textures bound on units 0-15 with their
//   sampler (marked '+n' when a pass of this frame drew into them before, '!' when attached to the framebuffer drawn
//   into: a feedback loop, '~h' their contents uploaded in this frame — a hash of the frame's uploads into it, so that
//   contents going X, Y, X show as an alternation —, '^h' their parameters set during the capture), its raster state (an index into
//   `states`: blend, color mask, depth, stencil, cull, polygon offset...), viewport and scissor, vertex array (its
//   attribute setup's hash when set during the capture), element buffer, the call, a hash of the program's uniform
//   values (per element: the backend's location names) and of the vertex data streamed for it;
// - copies each kept frame's back buffer at the present, downscaled to at most IMG_W x IMG_H (a filtered blit, read back
//   through a pixel buffer and a fence: no stall), then encodes them as JPEG;
// - sends one record (`send`): the trigger sample, the WebGL context (renderer, attributes, extensions, limits,
//   precisions), the images, the A-B-A share of the downscaled frames, the frames' signatures, the GL objects they name
//   (the backend's description: guest resource, Direct3D format and size, render scale...), and the comparison of the
//   frames (src/shared/flicker-record.js diffRecord: an A-B-A pass shows in 1-2 and 2-3, not in 1-3), cut to
//   CAPTURE_MAX_BYTES — all of it made after the present that read the last picture, in tasks of a few ms each between
//   the page's frames (finish: no present waits for it). tools/dev/flicker-capture.mjs turns it into PNGs and a readable diff.
// ORTHROS_FLICKER_CAPTURE (debug global): 0 never, 1 a capture at the next present (whatever the probe saw).
import { DRAW_FIELDS, FLICKER_RECORD_VERSION, CAPTURE_MAX_BYTES, PAGE_LCS_CELLS, SLICE_MS, fitRecord, diffRecordSteps, alternationSteps, runSliced, counted } from '../shared/flicker-record.js';
import { gpuInfo } from '../web/gpu-class.js';

/** a probe sample whose still A-B-A share reaches this (ppm of the frame: 2 %) starts the session's capture */
export const CAPTURE_STILL = 20000;
/** frames kept (after the warm-up frame) */
export const FRAMES = 3;
const IMG_W = 640, IMG_H = 360;
/** texture units the backend's stages sample (its uploads use the last unit, left out) */
const UNITS = 16;
/** presents after which readbacks not done are given up */
const STALE = 240;
/** GL calls of one frame at most: past them recording stops (frames that no longer reach the probe's present — the GL null mode switched on meanwhile) */
const MAX_CALLS = 400000;
/** a frame's uploads and attachment changes listed at most (past them only counted: nUps, nAtt) */
const LIST_MAX = 1000;
const tick = () => new Promise((r) => setTimeout(r, 0));
const TEX_KINDS = ['t2d', 'cube', 't3d', 'arr'];
const MODES = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP', 'TRIANGLES', 'TRIANGLE_STRIP', 'TRIANGLE_FAN'];
/** components per element of the vector uniform setters */
const ELEM = { uniform1fv: 1, uniform2fv: 2, uniform3fv: 3, uniform4fv: 4, uniform1iv: 1, uniform2iv: 2, uniform3iv: 3, uniform4iv: 4, uniform1uiv: 1, uniform2uiv: 2, uniform3uiv: 3, uniform4uiv: 4,
  uniformMatrix2fv: 4, uniformMatrix3fv: 9, uniformMatrix4fv: 16, uniformMatrix2x3fv: 6, uniformMatrix3x2fv: 6, uniformMatrix2x4fv: 8, uniformMatrix4x2fv: 8, uniformMatrix3x4fv: 12, uniformMatrix4x3fv: 12 };
const LIMITS = ['MAX_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VIEWPORT_DIMS', 'MAX_SAMPLES', 'MAX_DRAW_BUFFERS', 'MAX_COLOR_ATTACHMENTS', 'MAX_TEXTURE_IMAGE_UNITS',
  'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_VERTEX_ATTRIBS',
  'MAX_3D_TEXTURE_SIZE', 'MAX_ARRAY_TEXTURE_LAYERS', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_UNIFORM_BLOCK_SIZE', 'ALIASED_POINT_SIZE_RANGE', 'ALIASED_LINE_WIDTH_RANGE', 'SUBPIXEL_BITS'];

// ---------------------------------------------------------------- hashes (32-bit, FNV-style)
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer); // snapshot: scratch of the hashes, host-side
const mix = (h, v) => Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');
const numBits = (x) => { if (Number.isInteger(x) && x >= -0x80000000 && x <= 0xffffffff) return x | 0; F32[0] = x; return U32[0] ^ 0x5bd1e995; };
function strHash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i)); return h; }
/** bytes [start, start + n) of an ArrayBuffer (or a shared one: the guest memory) */
function hashBytes(buf, start, n) {
  let h = mix(0x811c9dc5, n), i = 0;
  if ((start & 3) === 0 && n >= 4) { const w = new Int32Array(buf, start, n >> 2); for (; i < w.length; i++) h = mix(h, w[i]); i <<= 2; }
  const b = new Uint8Array(buf, start + i, n - i); for (let k = 0; k < b.length; k++) h = mix(h, b[k]);
  return h;
}
/** a view's elements [off, off + len) (len 0: to its end), an array's numbers, or what else it is (a size, an image) */
function hashData(v, off = 0, len = 0) {
  if (ArrayBuffer.isView(v)) {
    const bpe = v.BYTES_PER_ELEMENT ?? 1, o = Math.max(0, off | 0), n = Math.max(0, (len > 0 ? len : (v.byteLength / bpe) - o) * bpe);
    return hashBytes(v.buffer, v.byteOffset + o * bpe, Math.min(n, v.byteLength - o * bpe));
  }
  if (Array.isArray(v)) { let h = 0x2545f491; const e = len > 0 ? off + len : v.length; for (let i = off | 0; i < e; i++) h = mix(h, numBits(+v[i])); return h; }
  if (typeof v === 'number') return mix(0x9e3779b9, v);
  return v ? mix(0x51ed270b, (v.width | 0) * 65536 + (v.height | 0)) : 0;
}
const hashNums = (a, from) => { let h = 0x7feb352d; for (let i = from; i < a.length; i++) h = mix(h, numBits(+a[i])); return h; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const arr = (v) => (v && typeof v === 'object' && typeof v.length === 'number' ? Array.from(v) : v);

/**
 * The GL calls of a context, recorded while `on` (between start() and stop(): the context's prototype methods wrapped,
 * for this receiver only — several contexts share a prototype) into per-frame signatures. Its own GL calls (state
 * queries at the start, getError) go to methods it does not wrap.
 */
export class GlRecorder {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl; this.on = false; this.wrapped = null; this.notes = [];
    this.ids = new Map(); this.counts = {}; this.locIds = new Map(); this.locName = new Map(); this.desc = new Map(); this.enumNames = null;
    this.draws = []; this.drawIdx = new Map(); this.states = []; this.stateIdx = new Map();
    this.uni = new Map(); this.vattr = new Map(); this.cattr = new Map(); this.vaoEbo = new Map(); this.fbAtt = new Map(); this.fbBufs = new Map();
    // (`ver`: per texture, its contents uploaded in this frame — a hash of them, in order: a texture whose contents go
    // X, Y, X in three frames shows ~X, ~Y, ~X, an A-B-A the comparison finds; `texPar` / `smpPar`: the parameters set
    // during the capture, by name — their current values hashed, so values that go back show as they were)
    this.ver = new Map(); this.texPar = new Map(); this.smpPar = new Map(); this.store = new Map(); this.checked = new Set();
    this.data = 0; this.cur = null; this.frame = this.newFrame(); this.wr = new Map(); this.passErrors = true;
  }
  newFrame() { return { calls: 0, draws: 0, passes: [], ups: [], att: [], errs: [] }; }
  /** a GL object's id in the record (its kind's letter and a number), null for none */
  id(o, kind) {
    if (!o) return null;
    let v = this.ids.get(o);
    if (!v) { const k = kind ?? this.desc.get(o)?.kind?.[0]?.toUpperCase() ?? 'X'; this.counts[k] = (this.counts[k] ?? 0) + 1; v = k + this.counts[k]; this.ids.set(o, v); }
    return v;
  }
  fbId(fb) { return fb ? this.id(fb, 'F') : 'F0'; }
  name(v) {
    if (typeof v !== 'number') return v;
    if (!this.enumNames) { this.enumNames = new Map(); for (const k in this.gl) { if (!/^[A-Z][A-Z0-9_]+$/.test(k)) continue; const x = this.gl[k]; if (typeof x === 'number' && !this.enumNames.has(x)) this.enumNames.set(x, k); } }
    return this.enumNames.get(v) ?? `0x${v.toString(16)}`;
  }
  /**
   * Recording starts: the GL state read once (bindings, capabilities, blend / depth / stencil / raster state), the
   * backend's description of its objects taken (`describe`: Map object -> { kind, ... }, uniform locations as kind
   * 'loc' with their names), the methods wrapped.
   */
  start(describe) {
    const gl = this.gl;
    if (describe) for (const [o, d] of describe) { if (d.kind === 'loc') this.locName.set(o, d.name); else this.desc.set(o, d); }
    this.snapshot();
    const proto = Object.getPrototypeOf(gl), self = this, H = handlers(), orig = new Map();
    if (!proto || proto === Object.prototype) { this.notes.push('GL calls not recorded (no prototype to wrap)'); return; }
    for (const k of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, k), h = H[k] ?? (/^uniform(Matrix)?\d/.test(k) ? H.$uniform : null);
      if (!h || typeof d?.value !== 'function' || !d.writable) continue;
      const f = d.value; orig.set(k, f);
      proto[k] = function () {
        if (this === gl && self.on) {
          if (++self.frame.calls > MAX_CALLS) { self.stop(); self.notes.push(`over ${MAX_CALLS} GL calls in a frame: recording stopped`); return f.apply(this, arguments); }
          try { h.call(self, arguments, k); } catch (e) { if (self.notes.length < 8) self.notes.push(`${k}: ${e?.message ?? e}`); }
        }
        return f.apply(this, arguments);
      };
    }
    // (the names of the uniform locations the backend asks for meanwhile: its uniforms recorded by element)
    const gul = proto.getUniformLocation;
    if (typeof gul === 'function') { orig.set('getUniformLocation', gul); proto.getUniformLocation = function (p, n) { const l = gul.apply(this, arguments); if (this === gl && l) self.locName.set(l, n); return l; }; }
    this.wrapped = { proto, orig }; this.on = true;
  }
  /** The prototype's own methods back. */
  stop() {
    this.on = false;
    if (!this.wrapped) return;
    for (const [k, f] of this.wrapped.orig) this.wrapped.proto[k] = f;
    this.wrapped = null;
  }
  snapshot() {
    const gl = this.gl, P = (k) => { try { return arr(gl.getParameter(gl[k])); } catch { return null; } }, A = (k, d) => { const v = P(k); return Array.isArray(v) ? v : d; };
    const en = {};
    for (const c of ['BLEND', 'CULL_FACE', 'DEPTH_TEST', 'DITHER', 'POLYGON_OFFSET_FILL', 'SAMPLE_ALPHA_TO_COVERAGE', 'SAMPLE_COVERAGE', 'SCISSOR_TEST', 'STENCIL_TEST', 'RASTERIZER_DISCARD']) en[gl[c]] = !!gl.isEnabled(gl[c]);
    const cm = A('COLOR_WRITEMASK', [true, true, true, true]);
    const s = this.s = {
      draw: P('DRAW_FRAMEBUFFER_BINDING') || null, read: P('READ_FRAMEBUFFER_BINDING') || null, prog: P('CURRENT_PROGRAM') || null, vao: P('VERTEX_ARRAY_BINDING') || null,
      abuf: P('ARRAY_BUFFER_BINDING') || null, rb: P('RENDERBUFFER_BINDING') || null, active: Math.max(0, (P('ACTIVE_TEXTURE') || gl.TEXTURE0) - gl.TEXTURE0), units: [], en,
      blend: [P('BLEND_SRC_RGB'), P('BLEND_DST_RGB'), P('BLEND_SRC_ALPHA'), P('BLEND_DST_ALPHA')], beq: [P('BLEND_EQUATION_RGB'), P('BLEND_EQUATION_ALPHA')], bcol: A('BLEND_COLOR', [0, 0, 0, 0]),
      cmask: (cm[0] ? 1 : 0) | (cm[1] ? 2 : 0) | (cm[2] ? 4 : 0) | (cm[3] ? 8 : 0), dfunc: P('DEPTH_FUNC'), dmask: !!P('DEPTH_WRITEMASK'), drange: A('DEPTH_RANGE', [0, 1]),
      sf: [P('STENCIL_FUNC'), P('STENCIL_REF'), P('STENCIL_VALUE_MASK')], sb: [P('STENCIL_BACK_FUNC'), P('STENCIL_BACK_REF'), P('STENCIL_BACK_VALUE_MASK')],
      sof: [P('STENCIL_FAIL'), P('STENCIL_PASS_DEPTH_FAIL'), P('STENCIL_PASS_DEPTH_PASS')], sob: [P('STENCIL_BACK_FAIL'), P('STENCIL_BACK_PASS_DEPTH_FAIL'), P('STENCIL_BACK_PASS_DEPTH_PASS')],
      swf: P('STENCIL_WRITEMASK'), swb: P('STENCIL_BACK_WRITEMASK'), cull: P('CULL_FACE_MODE'), front: P('FRONT_FACE'), poly: [P('POLYGON_OFFSET_FACTOR'), P('POLYGON_OFFSET_UNITS')],
      vp: A('VIEWPORT', [0, 0, 0, 0]), sc: A('SCISSOR_BOX', [0, 0, 0, 0]), ccol: A('COLOR_CLEAR_VALUE', [0, 0, 0, 0]), cdepth: P('DEPTH_CLEAR_VALUE'), cst: P('STENCIL_CLEAR_VALUE'),
    };
    // (the units' bindings, read through the active unit, which is put back)
    for (let u = 0; u < UNITS; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      s.units[u] = { t2d: P('TEXTURE_BINDING_2D') || null, cube: P('TEXTURE_BINDING_CUBE_MAP') || null, t3d: P('TEXTURE_BINDING_3D') || null, arr: P('TEXTURE_BINDING_2D_ARRAY') || null, smp: P('SAMPLER_BINDING') || null };
    }
    gl.activeTexture(gl.TEXTURE0 + s.active);
    this.vaoEbo.set(s.vao, P('ELEMENT_ARRAY_BUFFER_BINDING') || null);
    // (what the backend set up before: each framebuffer's attachments, each cached vertex array's element buffer)
    for (const [o, d] of this.desc) {
      if (d.kind === 'fb') { const m = new Map(); if (d.color) m.set('c0', d.color); if (d.depth) m.set('ds', d.depth); this.fbAtt.set(o, m); }
      else if (d.kind === 'vao' && d.ib && o !== s.vao) this.vaoEbo.set(o, d.ib);
    }
  }
  /** the current pass (the draw framebuffer's), opened at its first event */
  pass() {
    const fb = this.s.draw || null;
    let p = this.cur;
    if (!p || p.fbo !== fb) {
      p = this.cur = { fb: this.fbId(fb), ev: [], fbo: fb, marked: false };
      this.frame.passes.push(p);
      if (fb && !this.checked.has(fb)) { this.checked.add(fb); const st = this.gl.checkFramebufferStatus(this.gl.DRAW_FRAMEBUFFER); if (st !== this.gl.FRAMEBUFFER_COMPLETE) p.ev.push(['status', this.name(st)]); }
    }
    return p;
  }
  /** a pass draws into its framebuffer: the textures attached to it count as drawn this frame (once per pass) */
  wrote(p) {
    if (p.marked) return; p.marked = true;
    for (const o of this.fbAtt.get(p.fbo)?.values() ?? []) this.wr.set(o, (this.wr.get(o) ?? 0) + 1);
  }
  /** the pass ends (another framebuffer bound, the frame presented): its GL error, read once */
  endPass() {
    const p = this.cur; if (!p) return;
    this.cur = null;
    if (!this.passErrors) return; // (a software rasterizer: that round trip can wait for seconds of queued work — once per frame then)
    const e = this.gl.getError();
    if (e) p.ev.push(['err', this.name(e)]);
  }
  setDraw(fb) { if ((fb || null) !== (this.s.draw || null)) { this.endPass(); this.s.draw = fb || null; } }
  bound(target) {
    const gl = this.gl, u = this.s.units[this.s.active];
    if (!u) return null;
    if (target === gl.TEXTURE_2D) return u.t2d;
    if (target === gl.TEXTURE_3D) return u.t3d;
    if (target === gl.TEXTURE_2D_ARRAY) return u.arr;
    return u.cube; // (TEXTURE_CUBE_MAP and its faces)
  }
  texKind(target) { const gl = this.gl; return target === gl.TEXTURE_2D ? 't2d' : target === gl.TEXTURE_3D ? 't3d' : target === gl.TEXTURE_2D_ARRAY ? 'arr' : 'cube'; }
  texRef(t) {
    const w = this.wr.get(t), v = this.ver.get(t), q = this.texPar.get(t)?.h;
    let fb = false; for (const o of this.fbAtt.get(this.s.draw || null)?.values() ?? []) if (o === t) fb = true;
    return `${this.id(t, 'T')}${w ? '+' + w : ''}${fb ? '!' : ''}${v ? '~' + hex(v).slice(0, 6) : ''}${q ? '^' + hex(q).slice(0, 4) : ''}`;
  }
  stateIndex() {
    const s = this.s, gl = this.gl, on = (c) => !!s.en[gl[c]], n = (v) => this.name(v), bf = (v) => (v === 0 ? 'ZERO' : v === 1 ? 'ONE' : n(v));
    const o = {
      blend: on('BLEND') ? [...s.blend.map(bf), ...s.beq.map(n), ...arr(s.bcol).map(r3)] : 0,
      cmask: s.cmask,
      depth: on('DEPTH_TEST') ? [n(s.dfunc), s.dmask ? 1 : 0, ...arr(s.drange).map(r3)] : 0,
      stencil: on('STENCIL_TEST') ? [n(s.sf[0]), s.sf[1], s.sf[2], ...s.sof.map(n), s.swf, n(s.sb[0]), s.sb[1], s.sb[2], ...s.sob.map(n), s.swb] : 0,
      cull: on('CULL_FACE') ? [n(s.cull), n(s.front)] : 0,
      poly: on('POLYGON_OFFSET_FILL') ? s.poly.map(r3) : 0,
      a2c: on('SAMPLE_ALPHA_TO_COVERAGE') ? 1 : 0, cov: on('SAMPLE_COVERAGE') ? 1 : 0, dither: on('DITHER') ? 1 : 0, discard: on('RASTERIZER_DISCARD') ? 1 : 0,
      bufs: this.fbBufs.get(s.draw || null) ?? null,
    };
    const k = JSON.stringify(o);
    let i = this.stateIdx.get(k);
    if (i === undefined) { i = this.states.length; this.states.push(o); this.stateIdx.set(k, i); }
    return i;
  }
  vaoKey() {
    const v = this.s.vao || null, a = this.vattr.get(v);
    let h = 0;
    if (a) for (const [i, x] of [...a].sort((p, q) => p[0] - q[0])) h = mix(mix(h, i), strHash(x));
    for (const [i, x] of this.cattr) h = mix(mix(h, 100 + i), x);
    return `${v ? this.id(v, 'V') : 'V0'}${h ? '#' + hex(h).slice(0, 6) : ''}`;
  }
  draw(fn, mode, count, type, off, inst) {
    const s = this.s, p = this.pass();
    let tex = '';
    for (let u = 0; u < UNITS; u++) {
      const U = s.units[u]; if (!U) continue;
      let t = ''; for (const k of TEX_KINDS) if (U[k]) t += (t ? ',' : '') + this.texRef(U[k]);
      const sp = U.smp ? this.smpPar.get(U.smp)?.h : 0; // (a sampler's parameters set during the capture)
      if (t) tex += `${tex ? ' ' : ''}${u}:${t}${U.smp ? '/' + this.id(U.smp, 'S') + (sp ? '^' + hex(sp).slice(0, 4) : '') : ''}`;
    }
    const vp = `${arr(s.vp).join(',')}${s.en[this.gl.SCISSOR_TEST] ? ' sc ' + arr(s.sc).join(',') : ''}`;
    const ebo = type != null ? (this.id(this.vaoEbo.get(s.vao || null), 'B') ?? '?') : '';
    const call = `${fn} ${MODES[mode] ?? this.name(mode)} ${count}${type != null ? ' ' + this.name(type) : ''} @${off}${inst ? ' x' + inst : ''}`;
    const d = [s.prog ? this.id(s.prog, 'P') : null, tex, this.stateIndex(), vp, this.vaoKey(), ebo, call, hex(this.uni.get(s.prog || null)?.h ?? 0), this.data ? hex(this.data) : ''];
    this.data = 0;
    const k = d.join('|');
    let i = this.drawIdx.get(k);
    if (i === undefined) { i = this.draws.length; this.draws.push(d); this.drawIdx.set(k, i); }
    p.ev.push(i); this.frame.draws++;
    this.wrote(p);
  }
  attach(target, att, desc, obj) {
    const gl = this.gl, fb = (target === gl.READ_FRAMEBUFFER ? this.s.read : this.s.draw) || null, a = this.name(att);
    const key = a === 'COLOR_ATTACHMENT0' ? 'c0' : a === 'DEPTH_STENCIL_ATTACHMENT' ? 'ds' : a.toLowerCase();
    let m = this.fbAtt.get(fb); if (!m) this.fbAtt.set(fb, m = new Map());
    if (obj) m.set(key, obj); else m.delete(key);
    const f = this.frame; if (f.att.length < LIST_MAX) f.att.push([this.fbId(fb), key, desc]); else f.nAtt = (f.nAtt ?? f.att.length) + 1;
  }
  /** a texture upload into the texture bound to `target`: listed, folded into the texture's uploads of this frame (`ver`) */
  upload(fn, target, level, nums, data) {
    const t = this.bound(target), h = data, f = this.frame;
    if (f.ups.length < LIST_MAX) f.ups.push([fn, t ? this.id(t, 'T') : null, level, ...nums.slice(0, 6), hex(h)]); else f.nUps = (f.nUps ?? f.ups.length) + 1;
    if (t) this.ver.set(t, mix(mix(this.ver.get(t) ?? 0x3c6ef372, strHash(nums.join(','))), h));
  }
  /** a uniform setter of the program in use: per element (the backend's location names), its value's hash folded into the program's */
  uniform(fn, a) {
    const loc = a[0], p = this.s.prog || null;
    if (!loc) return;
    let u = this.uni.get(p); if (!u) this.uni.set(p, u = { m: new Map(), h: 0 });
    const set = (key, h) => { const old = u.m.get(key); if (old === h) return; const kh = strHash(key); if (old !== undefined) u.h ^= mix(kh, old); u.h ^= mix(kh, h); u.m.set(key, h); };
    let name = this.locName.get(loc);
    if (name === undefined) { let n = this.locIds.get(loc); if (n === undefined) this.locIds.set(loc, n = this.locIds.size + 1); name = `#${n}`; }
    let vi = -1; for (let i = 1; i < a.length; i++) if (ArrayBuffer.isView(a[i]) || Array.isArray(a[i])) { vi = i; break; }
    if (vi < 0) { set(name, mix(hashNums(a, 1), strHash(fn))); return; }
    const v = a[vi], off = a[vi + 1] | 0, len = a[vi + 2] | 0, n = len > 0 ? len : v.length - off, es = ELEM[fn] ?? n;
    const m = /^(.*)\[(\d+)\]$/.exec(name);
    if (!m || n <= es) { set(name, hashData(v, off, n)); return; }
    for (let k = 0, i0 = +m[2]; k * es < n; k++) set(`${m[1]}[${i0 + k}]`, hashData(v, off + k * es, Math.min(es, n - k * es)));
  }
  /** the frame is presented: its record (the pass in progress closed); the next one starts */
  endFrame() {
    this.endPass();
    const f = this.frame;
    const e = this.gl.getError(); if (e) f.errs.push(this.name(e));
    this.frame = this.newFrame(); this.wr.clear(); this.ver.clear();
    f.passes = f.passes.map((p) => ({ fb: p.fb, ev: p.ev }));
    return f;
  }
  /** the warm-up frame's draws and states forgotten (what it taught kept: uniforms, attributes, attachments) */
  forget() { this.draws = []; this.drawIdx.clear(); this.states = []; this.stateIdx.clear(); }
  /** the objects the record names, described: the backend's description (its objects as ids) and what the capture saw */
  objects(w, h) {
    const out = {}, conv = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (this.ids.has(v) || this.desc.has(v) ? this.id(v) : null) : v);
    out.F0 = { kind: 'canvas', size: `${this.gl.drawingBufferWidth}x${this.gl.drawingBufferHeight}`, frame: `${w}x${h}` };
    for (const [o, id] of this.ids) { // (ids added while describing are visited too)
      const d = this.desc.get(o), x = {};
      if (d) for (const [k, v] of Object.entries(d)) x[k] = conv(v);
      const st = this.store.get(o); if (st) x.storage = st;
      const att = this.fbAtt.get(o); if (att?.size) x.att = Object.fromEntries([...att].map(([k, v]) => [k, this.id(v)]));
      const smp = this.smpPar.get(o)?.h; if (smp) x.params = hex(smp);
      out[id] = x;
    }
    return out;
  }
}

/** the recorder's handlers by GL method (this: the recorder, a: the call's arguments) */
function handlers() {
  const H = {
    bindFramebuffer(a) { const gl = this.gl, t = a[0]; if (t === gl.FRAMEBUFFER || t === gl.DRAW_FRAMEBUFFER) this.setDraw(a[1]); if (t === gl.FRAMEBUFFER || t === gl.READ_FRAMEBUFFER) this.s.read = a[1] || null; },
    framebufferTexture2D(a) { const gl = this.gl, face = a[2] >= gl.TEXTURE_CUBE_MAP_POSITIVE_X && a[2] <= gl.TEXTURE_CUBE_MAP_NEGATIVE_Z ? ` face ${a[2] - gl.TEXTURE_CUBE_MAP_POSITIVE_X}` : ''; this.attach(a[0], a[1], a[3] ? `${this.id(a[3], 'T')} level ${a[4]}${face}` : null, a[3]); },
    framebufferRenderbuffer(a) { this.attach(a[0], a[1], a[3] ? this.id(a[3], 'R') : null, a[3]); },
    framebufferTextureLayer(a) { this.attach(a[0], a[1], a[2] ? `${this.id(a[2], 'T')} level ${a[3]} layer ${a[4]}` : null, a[2]); },
    drawBuffers(a) { this.fbBufs.set(this.s.draw || null, Array.from(a[0], (b) => this.name(b)).join(',')); },
    clear(a) {
      const gl = this.gl, s = this.s, m = a[0], p = this.pass();
      const C = m & gl.COLOR_BUFFER_BIT, D = m & gl.DEPTH_BUFFER_BIT, S = m & gl.STENCIL_BUFFER_BIT; // (each buffer cleared with its value and write mask)
      p.ev.push(['clear', (C ? 'C' : '') + (D ? 'D' : '') + (S ? 'S' : ''), C ? arr(s.ccol).map(r3) : null, D ? s.cdepth : null, S ? s.cst : null, C ? s.cmask : null, D ? (s.dmask ? 1 : 0) : null, S ? s.swf & 0xff : null, s.en[gl.SCISSOR_TEST] ? arr(s.sc) : null]);
      this.wrote(p);
    },
    clearBufferfv(a) { const p = this.pass(); p.ev.push(['clearbuf', this.name(a[0]), a[1], Array.from(a[2]).slice(a[3] | 0, (a[3] | 0) + 4).map(r3), this.s.cmask]); this.wrote(p); },
    clearBufferfi(a) { const p = this.pass(); p.ev.push(['clearbuf', this.name(a[0]), a[1], [r3(a[2]), a[3]]]); this.wrote(p); },
    blitFramebuffer(a) { const p = this.pass(); p.ev.push(['blit', this.fbId(this.s.read), [a[0], a[1], a[2], a[3]], [a[4], a[5], a[6], a[7]], a[8], this.name(a[9])]); this.wrote(p); },
    readPixels(a) { this.pass().ev.push(['read', this.fbId(this.s.read), a[0], a[1], a[2], a[3], this.name(a[5])]); },
    copyTexSubImage2D(a) { const t = this.bound(a[0]); this.pass().ev.push(['copytex', this.fbId(this.s.read), t ? this.id(t, 'T') : null, a[1], Array.prototype.slice.call(a, 2, 8)]); if (t) this.wr.set(t, (this.wr.get(t) ?? 0) + 1); },
    copyTexImage2D(a) { const t = this.bound(a[0]); this.pass().ev.push(['copytex', this.fbId(this.s.read), t ? this.id(t, 'T') : null, a[1], Array.prototype.slice.call(a, 3, 7)]); if (t) this.wr.set(t, (this.wr.get(t) ?? 0) + 1); },
    invalidateFramebuffer(a) { this.pass().ev.push(['inval', Array.from(a[1], (x) => this.name(x)).join(',')]); },
    drawArrays(a) { this.draw('a', a[0], a[2], null, a[1], 0); },
    drawElements(a) { this.draw('e', a[0], a[1], a[2], a[3], 0); },
    drawArraysInstanced(a) { this.draw('ai', a[0], a[2], null, a[1], a[3]); },
    drawElementsInstanced(a) { this.draw('ei', a[0], a[1], a[2], a[3], a[4]); },
    drawRangeElements(a) { this.draw('er', a[0], a[3], a[4], a[5], 0); },
    useProgram(a) { this.s.prog = a[0] || null; },
    activeTexture(a) { this.s.active = a[0] - this.gl.TEXTURE0; },
    bindTexture(a) { const u = this.s.units[this.s.active]; if (u) u[this.texKind(a[0])] = a[1] || null; },
    bindSampler(a) { const u = this.s.units[a[0]]; if (u) u.smp = a[1] || null; },
    bindVertexArray(a) { this.s.vao = a[0] || null; },
    bindBuffer(a) { const gl = this.gl; if (a[0] === gl.ARRAY_BUFFER) this.s.abuf = a[1] || null; else if (a[0] === gl.ELEMENT_ARRAY_BUFFER) this.vaoEbo.set(this.s.vao || null, a[1] || null); },
    bindRenderbuffer(a) { this.s.rb = a[1] || null; },
    renderbufferStorage(a) { if (this.s.rb) this.store.set(this.s.rb, `${this.name(a[1])} ${a[2]}x${a[3]}`); },
    renderbufferStorageMultisample(a) { if (this.s.rb) this.store.set(this.s.rb, `${this.name(a[2])} ${a[3]}x${a[4]} x${a[1]}`); },
    enable(a) { this.s.en[a[0]] = true; },
    disable(a) { this.s.en[a[0]] = false; },
    blendFunc(a) { this.s.blend = [a[0], a[1], a[0], a[1]]; },
    blendFuncSeparate(a) { this.s.blend = [a[0], a[1], a[2], a[3]]; },
    blendEquation(a) { this.s.beq = [a[0], a[0]]; },
    blendEquationSeparate(a) { this.s.beq = [a[0], a[1]]; },
    blendColor(a) { this.s.bcol = [a[0], a[1], a[2], a[3]]; },
    colorMask(a) { this.s.cmask = (a[0] ? 1 : 0) | (a[1] ? 2 : 0) | (a[2] ? 4 : 0) | (a[3] ? 8 : 0); },
    depthFunc(a) { this.s.dfunc = a[0]; },
    depthMask(a) { this.s.dmask = !!a[0]; },
    depthRange(a) { this.s.drange = [a[0], a[1]]; },
    stencilFunc(a) { this.s.sf = [a[0], a[1], a[2]]; this.s.sb = [a[0], a[1], a[2]]; },
    stencilFuncSeparate(a) { const gl = this.gl, v = [a[1], a[2], a[3]]; if (a[0] !== gl.BACK) this.s.sf = v; if (a[0] !== gl.FRONT) this.s.sb = v; },
    stencilOp(a) { this.s.sof = [a[0], a[1], a[2]]; this.s.sob = [a[0], a[1], a[2]]; },
    stencilOpSeparate(a) { const gl = this.gl, v = [a[1], a[2], a[3]]; if (a[0] !== gl.BACK) this.s.sof = v; if (a[0] !== gl.FRONT) this.s.sob = v; },
    stencilMask(a) { this.s.swf = a[0]; this.s.swb = a[0]; },
    stencilMaskSeparate(a) { const gl = this.gl; if (a[0] !== gl.BACK) this.s.swf = a[1]; if (a[0] !== gl.FRONT) this.s.swb = a[1]; },
    cullFace(a) { this.s.cull = a[0]; },
    frontFace(a) { this.s.front = a[0]; },
    polygonOffset(a) { this.s.poly = [a[0], a[1]]; },
    viewport(a) { this.s.vp = [a[0], a[1], a[2], a[3]]; },
    scissor(a) { this.s.sc = [a[0], a[1], a[2], a[3]]; },
    clearColor(a) { this.s.ccol = [a[0], a[1], a[2], a[3]]; },
    clearDepth(a) { this.s.cdepth = a[0]; },
    clearStencil(a) { this.s.cst = a[0]; },
    // uploads: (target, level, ...) with the data among the arguments (a view, then its element offset)
    texImage2D(a, k) { upload(this, k, a); },
    texSubImage2D(a, k) { upload(this, k, a); },
    texImage3D(a, k) { upload(this, k, a); },
    texSubImage3D(a, k) { upload(this, k, a); },
    compressedTexImage2D(a, k) { upload(this, k, a); },
    compressedTexSubImage2D(a, k) { upload(this, k, a); },
    texStorage2D(a, k) { const t = this.bound(a[0]); if (t) this.store.set(t, `${this.name(a[2])} ${a[3]}x${a[4]} levels ${a[1]}`); this.upload(k, a[0], 0, [a[1], a[3], a[4]], 0); },
    texStorage3D(a, k) { const t = this.bound(a[0]); if (t) this.store.set(t, `${this.name(a[2])} ${a[3]}x${a[4]}x${a[5]} levels ${a[1]}`); this.upload(k, a[0], 0, [a[1], a[3], a[4], a[5]], 0); },
    generateMipmap(a) { this.upload('generateMipmap', a[0], 0, [], 0); },
    texParameteri(a) { const t = this.bound(a[0]); if (t) param(this.texPar, t, a[1], a[2]); },
    texParameterf(a) { H.texParameteri.call(this, a); },
    samplerParameteri(a) { if (a[0]) param(this.smpPar, a[0], a[1], a[2]); },
    samplerParameterf(a) { H.samplerParameteri.call(this, a); },
    // vertex data: what the next draw reads, hashed (bufferData(target, data|size, usage, srcOffset, length), bufferSubData(target, dstOffset, data, srcOffset, length))
    bufferData(a) { this.data = mix(mix(this.data, a[0]), hashData(a[1], a[3], a[4])); },
    bufferSubData(a) { this.data = mix(mix(this.data, a[0]), hashData(a[2], a[3], a[4])); }, // (the contents, not where they go: a dynamic buffer's position moves every frame)
    vertexAttribPointer(a) { attr(this, a[0], `${a[1]} ${this.name(a[2])}${a[3] ? ' norm' : ''} ${a[4]} @${a[5]} ${this.id(this.s.abuf, 'B')}`); },
    vertexAttribIPointer(a) { attr(this, a[0], `${a[1]} ${this.name(a[2])} int ${a[3]} @${a[4]} ${this.id(this.s.abuf, 'B')}`); },
    enableVertexAttribArray(a) { attr(this, 100 + a[0], 'on'); },
    disableVertexAttribArray(a) { attr(this, 100 + a[0], 'off'); },
    vertexAttribDivisor(a) { attr(this, 200 + a[0], String(a[1])); },
    $uniform(a, k) { this.uniform(k, a); },
  };
  for (const k of ['clearBufferiv', 'clearBufferuiv']) H[k] = H.clearBufferfv;
  for (const k of ['vertexAttrib1f', 'vertexAttrib2f', 'vertexAttrib3f', 'vertexAttrib4f', 'vertexAttrib1fv', 'vertexAttrib2fv', 'vertexAttrib3fv', 'vertexAttrib4fv', 'vertexAttribI4i', 'vertexAttribI4ui', 'vertexAttribI4iv', 'vertexAttribI4uiv']) H[k] = function (a) { this.cattr.set(a[0], Array.isArray(a[1]) || ArrayBuffer.isView(a[1]) ? hashData(a[1]) : hashNums(a, 1)); };
  return H;
}
function attr(r, i, x) { const v = r.s.vao || null; let m = r.vattr.get(v); if (!m) r.vattr.set(v, m = new Map()); m.set(i, x); }
/** a texture's or sampler's parameter set: its value by name, `h` the hash of the current values (a value set back: the hash as before) */
function param(map, o, pname, v) {
  let p = map.get(o); if (!p) map.set(o, p = { m: new Map(), h: 0 });
  const nv = numBits(v), old = p.m.get(pname);
  if (old === nv) return;
  if (old !== undefined) p.h ^= mix(mix(0x27d4eb2f, pname), old);
  p.h ^= mix(mix(0x27d4eb2f, pname), nv); p.m.set(pname, nv);
}
/** a texture upload call (any of its overloads): its numeric arguments and the hash of its data */
function upload(r, k, a) {
  const nums = []; let data = null, di = -1;
  for (let i = 2; i < a.length; i++) { if (typeof a[i] === 'number') { if (di < 0) nums.push(a[i]); } else if (di < 0) { data = a[i]; di = i; } }
  const off = di >= 0 && typeof a[di + 1] === 'number' ? a[di + 1] : 0;
  r.upload(k, a[0], a[1], nums, data === null && nums.length ? mix(0x1b873593, nums[nums.length - 1]) : hashData(data, off)); // (no data: a pixel-unpack-buffer offset or storage only)
}

/** The WebGL context, once: renderer, attributes, drawing buffer, extensions, limits, shader precisions. */
export function contextInfo(gl) {
  const P = (k) => { try { return arr(gl.getParameter(gl[k])); } catch { return null; } };
  const prec = (sh, p) => { try { const f = gl.getShaderPrecisionFormat(gl[sh], gl[p]); return f ? [f.rangeMin, f.rangeMax, f.precision] : null; } catch { return null; } };
  const g = gpuInfo(gl);
  let attrs = null; try { attrs = gl.getContextAttributes?.() ?? null; } catch { attrs = null; }
  return {
    renderer: g.renderer, vendor: g.vendor, glRenderer: P('RENDERER'), glVendor: P('VENDOR'), version: P('VERSION'), glsl: P('SHADING_LANGUAGE_VERSION'), attrs,
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], canvas: [gl.canvas?.width ?? null, gl.canvas?.height ?? null], colorSpace: gl.drawingBufferColorSpace ?? null,
    ext: (() => { try { return gl.getSupportedExtensions?.() ?? []; } catch { return []; } })(), limits: Object.fromEntries(LIMITS.map((k) => [k, P(k)])),
    prec: { vsHigh: prec('VERTEX_SHADER', 'HIGH_FLOAT'), fsHigh: prec('FRAGMENT_SHADER', 'HIGH_FLOAT'), fsMedium: prec('FRAGMENT_SHADER', 'MEDIUM_FLOAT'), fsHighInt: prec('FRAGMENT_SHADER', 'HIGH_INT') },
  };
}

/** the captured frames' A-B-A over the downscaled pictures (percent of their pixels; the probe's thresholds, no still rule) */
export function smallShares(imgs, w, h) {
  if (imgs.length < 3 || imgs.some((p) => !p)) return null;
  const L = (p, i) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2], n = w * h;
  let aba = 0, c12 = 0, c23 = 0, c13 = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const a = L(imgs[0], i), b = L(imgs[1], i), c = L(imgs[2], i);
    const ab = Math.abs(a - b) > 24, bc = Math.abs(b - c) > 24, ac = Math.abs(a - c);
    if (ab) c12++; if (bc) c23++; if (ac > 24) c13++;
    if (ab && bc && ac < 8) aba++;
  }
  const pc = (x) => Math.round(x / n * 1e6) / 1e4;
  return { aba: pc(aba), chg12: pc(c12), chg23: pc(c23), chg13: pc(c13) };
}

/** RGBA pictures (top-down rows) as JPEG, base64 — OffscreenCanvas in the page's workers; none elsewhere */
export async function encodeJpegs(imgs, w, h, q) {
  if (typeof OffscreenCanvas === 'undefined') return [];
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d'), out = [];
  for (const px of imgs) {
    if (!px) { out.push(''); continue; }
    g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4), w, h), 0, 0);
    const u8 = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: q })).arrayBuffer());
    let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    out.push(btoa(bin));
  }
  return out;
}

/**
 * One capture (FlickerProbe starts it and hands it its presents until `phase` is 'done'): phases 'start' (the next
 * present begins the recording), 'record' (the warm-up frame, then FRAMES frames recorded and their pictures copied),
 * 'read' (the pictures' readbacks awaited at later presents), 'encode' (the record built, encoded and sent: async),
 * 'done'.
 */
export class FlickerCapture {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ send: (rec: object) => void, trigger?: object, now?: () => number, encode?: Function, frames?: number, errors?: boolean }} opts
   * `errors`: the GL error read at each pass's end (else at each frame's only: a software rasterizer)
   */
  constructor(gl, opts) {
    this.gl = gl; this.send = opts.send; this.trigger = opts.trigger ?? null; this.now = opts.now ?? (() => performance.now()); this.encode = opts.encode ?? encodeJpegs;
    this.n = opts.frames ?? FRAMES; this.phase = 'start'; this.k = 0; this.shots = []; this.frames = []; this.notes = []; this.rec = new GlRecorder(gl); this.t = 0;
    this.rec.passErrors = opts.errors ?? true;
  }
  get recording() { return this.phase === 'record'; }
  /**
   * A frame is about to be shown (`fbo`: its back buffer's framebuffer, bound, of GL size w x h; `dev`: the backend's
   * device — its description of its GL objects and frame figures). Leaves `fbo` bound to FRAMEBUFFER; returns true
   * when it changed other GL state (the caller's cache is then stale).
   */
  present(fbo, w, h, dev) {
    const rec = this.rec, now = this.now();
    rec.on = false; // (its own calls are not the frame's)
    if (this.phase === 'start') {
      this.ctx = contextInfo(this.gl); this.w = w; this.h = h; this.t = now;
      dev?.flickerResend?.(); // (the warm-up frame sends every uniform again: their values known to the recorder)
      rec.start(dev?.flickerDescribe?.() ?? null);
      this.notes.push(...rec.notes.splice(0));
      if (!rec.wrapped) { this.phase = 'done'; return true; }
      this.phase = 'record';
      return true;
    }
    if (this.phase === 'record') {
      if (!rec.wrapped) { this.notes.push(...rec.notes.splice(0)); this.drop(); this.phase = 'done'; return false; } // (recording stopped on its own: nothing sent)
      if (w !== this.w || h !== this.h) { rec.stop(); this.notes.push(`frame size changed to ${w}x${h} during the capture`); this.drop(); this.phase = 'done'; return false; }
      const f = rec.endFrame();
      f.ms = Math.round((now - this.t) * 10) / 10; this.t = now; f.info = dev?.flickerInfo?.() ?? null;
      let changed = false;
      if (this.k === 0) rec.forget();
      else { this.frames.push(f); changed = this.shoot(fbo, w, h); }
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fbo); rec.s.draw = fbo || null; rec.s.read = fbo || null; // (the bindings the copy changed, as the recorder knows them)
      if (++this.k > this.n) {
        rec.stop(); this.phase = 'read'; this.waited = 0;
        for (const [o, d] of dev?.flickerDescribe?.() ?? []) if (d.kind !== 'loc' && !rec.desc.has(o)) rec.desc.set(o, d); // (objects made during the capture)
      } else rec.on = true;
      return changed;
    }
    if (this.phase === 'read') this.poll();
    return false;
  }
  /** the back buffer downscaled into a small target, read back into a pixel buffer behind a fence; true the first time (objects made) */
  shoot(fbo, w, h) {
    const gl = this.gl;
    let made = false;
    if (!this.small) {
      const k = Math.min(1, IMG_W / w, IMG_H / h), sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k));
      const rb = gl.createRenderbuffer(), fb = gl.createFramebuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, sw, sh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      this.small = { rb, fb, sw, sh }; made = true;
    }
    const { fb, sw, sh } = this.small;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, sw, sh, gl.COLOR_BUFFER_BIT, sw === w && sh === h ? gl.NEAREST : gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, sw * sh * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.shots.push({ buf, sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), px: null });
    return made;
  }
  /** the readbacks whose fence signaled read; all read (or given up): the record made */
  poll() {
    const gl = this.gl;
    for (const s of this.shots) {
      if (s.px || !s.sync) continue;
      if (gl.getSyncParameter(s.sync, gl.SYNC_STATUS) !== gl.SIGNALED) continue;
      gl.deleteSync(s.sync); s.sync = null;
      const px = new Uint8Array(this.small.sw * this.small.sh * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(s.buf); s.buf = null; s.px = px;
    }
    if (this.shots.some((s) => s.sync) && ++this.waited < STALE) return;
    if (this.shots.some((s) => s.sync)) this.notes.push('pictures not read back in time');
    this.phase = 'encode';
    const raws = this.shots.map((s) => s.px), { sw, sh } = this.small;
    this.drop();
    this.finish(raws, sw, sh).catch((e) => { this.notes.push(`record failed: ${e?.message ?? e}`); }).finally(() => { this.phase = 'done'; });
  }
  /** GL objects of the capture deleted (the context's: GL keeps them alive for the commands queued) */
  drop() {
    const gl = this.gl;
    try {
      for (const s of this.shots) { if (s.sync) gl.deleteSync(s.sync); if (s.buf) gl.deleteBuffer(s.buf); s.sync = null; s.buf = null; }
      if (this.small) { gl.deleteFramebuffer(this.small.fb); gl.deleteRenderbuffer(this.small.rb); this.small = { sw: this.small.sw, sh: this.small.sh }; }
    } catch { /* context lost */ }
  }
  /** The context was lost, or the probe switched off: recording stopped, nothing sent. */
  abort() { this.rec.stop(); this.drop(); this.phase = 'done'; }
  /**
   * The record made and sent, from the task after the present that read the last picture on: every part in tasks of
   * its own, a few ms each (the page's frames go on between them) — the pictures turned upright and compared, the
   * frames' comparison in slices (runSliced; lcsPairs' work capped at PAGE_LCS_CELLS a call), the cuts one step a task,
   * the JPEG encodes asynchronous. `took`: its time from the first task to the send (ms), its slices, their sum
   * (busy), the longest and those over 8 ms — wall times: a busy machine's other threads lengthen them.
   */
  async finish(raws, sw, sh) {
    const t0 = performance.now(), work = { slices: 0, longest: 0, busy: 0, over8: 0 };
    const step = async (f) => { await tick(); const t = performance.now(), v = f(); counted(work, performance.now() - t); return v; };
    const imgs = await step(() => raws.map((px) => (px ? upright(px, sw, sh) : null)));
    const small = await step(() => smallShares(imgs, sw, sh)), r = this.rec, objs = await step(() => r.objects(this.w, this.h));
    const rec = {
      event: 'flicker-capture', v: FLICKER_RECORD_VERSION, trigger: this.trigger, gl: this.ctx, size: [this.w, this.h], img: [sw, sh], q: null, images: [],
      small, frames: this.frames, objs, states: r.states, draws: r.draws, drawFields: DRAW_FIELDS, diff: null, alt: null, cut: [], notes: [...this.notes, ...r.notes], took: null,
    };
    rec.diff = await runSliced(diffRecordSteps(rec, 24, PAGE_LCS_CELLS), SLICE_MS, work);
    rec.alt = await runSliced(alternationSteps(rec, 40, PAGE_LCS_CELLS), SLICE_MS, work);
    await fitRecord(rec, (q) => this.encode(imgs, sw, sh, q), CAPTURE_MAX_BYTES - 100, work); // (room for `took`)
    const r1 = (x) => Math.round(x * 10) / 10;
    rec.took = { ms: Math.round(performance.now() - t0), slices: work.slices, busy: Math.round(work.busy), longest: r1(work.longest), over8: work.over8 };
    this.send(rec);
  }
}
/** GL rows (bottom-up) as picture rows, opaque */
function upright(px, w, h) {
  const out = new Uint8Array(px.length), row = w * 4;
  for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}
