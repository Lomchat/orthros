// Replay side of the render worker (docs/render-worker.md section 5, D063): a mirror of each Direct3D device — the
// fields the WebGL backend reads, kept equal to the emulator's device at every draw by the recorded state changes —
// and mirror resources with the same ids, sizes, guest memory addresses and dirty state. The backend (WebGLDevice,
// unchanged) runs on the mirror exactly as it runs on the emulator's device in the in-thread path. Used by the render
// worker (src/gfx/render-worker.js) and, on the emulator's own thread, by ?glworker=inline and the tests.
import { OP, VERSION_FIELDS, CONST_FIELDS, RingReader } from './cmd-ring.js';
import { surfacePitch, surfaceBytes } from '../win32/d3d8.js';
import { StateTable } from '../win32/state-table.js';
import { declLayout9 } from './d3d9-shaders.js';

/** One 2D level (or cube face level) or standalone surface: the fields of win32/d3d8.js Surface the backend reads. */
export class MSurface {
  constructor(id, owner, fmt, w, h, usage, pool, level, face, mem) {
    this.id = id; this.owner = owner; this.fmt = fmt; this.width = w; this.height = h; this.usage = usage; this.pool = pool; this.level = level; this.face = face;
    this.pitch = surfacePitch(fmt, w); this.bytes = surfaceBytes(fmt, w, h);
    this.mem = mem; this._dirty = false; this.dirtyRect = null; this.type = 1;
  }
  get dirty() { return this._dirty; }
  set dirty(v) { this._dirty = v; this.dirtyRect = null; if (v && this.owner) this.owner.levelsClean = false; }
  /** the same union of locked rectangles as Surface.markLocked, against this mirror's own upload state */
  markLocked(r) {
    const d = this.dirtyRect, partial = r && (!this._dirty || d);
    this._dirty = true; if (this.owner) this.owner.levelsClean = false;
    this.dirtyRect = !partial ? null : !d ? [r[0], r[1], r[2], r[3]] : [Math.min(d[0], r[0]), Math.min(d[1], r[1]), Math.max(d[2], r[2]), Math.max(d[3], r[3])];
  }
  /** (a readback's memory, allocated by the recorder, is the surface's once the pixels are read: as in the backend) */
  ensureMem() { if (!this.mem && this.pendingMem) { this.mem = this.pendingMem; this.pendingMem = 0; } return this.mem; }
}
/** A texture (2D, cube or volume) with its levels; `slot` / `gen`: acknowledgement of uploaded contents. */
export class MTexture {
  constructor(id, kind, fmt, w, h, d, usage, pool, slot, gen) {
    this.id = id; this.fmt = fmt; this.width = w; this.height = h; if (kind === 3) this.depth = d; this.usage = usage; this.pool = pool;
    this.slot = slot; this.gen = gen; this.acked = -1; this.type = kind === 1 ? 3 : kind === 2 ? 5 : 4;
  }
}
export class MBuffer {
  constructor(id, type, length, usage, fmt, mem, slot, gen) {
    this.id = id; this.type = type; this.length = length; this.usage = usage; this.fmt = fmt; this.mem = mem;
    this.dirty = false; this.dirtyRange = false; this.dirtyLo = 0; this.dirtyHi = 0; this.slot = slot; this.gen = gen; this.acked = -1;
    /** the buffer's own copy of its contents once they travel in the ring (BUF_DATA): uploads read it, not guest memory */
    this.shadow = null;
  }
}

/** The backend-visible state of one Direct3D device (see WebGLDevice: everything it reads from `this.dev`). */
export class DeviceMirror {
  constructor(id, api9, pp, mem, replayer) {
    this.id = id; this.api9 = !!api9; this.pp = pp; this.proc = { mem }; this.mirror = true;
    this.com = { implAt: (rid) => replayer.res.get(rid) ?? null };
    this.rs = new StateTable(256); this.tss = []; if (api9) this.samplers = [];
    this.textures = []; this.streams = []; this.indices = { ib: 0, base: 0 };
    this.viewport = { x: 0, y: 0, w: pp.width, h: pp.height, minZ: 0, maxZ: 1 };
    this.vertexShader = 0; this.pixelShader = 0; this.vertexShaders = new Map(); this.pixelShaders = new Map();
    if (api9) { this.scissor = null; this.fvf = 0; this.vertexDecl = null; this.vsObj = null; this.psObj = null; }
    this.transforms = new Map(); this.transformSlotVersion = new Map();
    this.transformWords = new Map(); this.constWords = [null, null]; this.lightWords = new Map(); // (word views of the matrices, float constants and lights: Replayer.applyFast)
    for (const f of VERSION_FIELDS) this[f] = 0;
    this.lights = new Map(); this.lightEnabled = new Set(); this.material = new Float32Array(17); this.materialWords = new Int32Array(this.material.buffer);
    this.renderTarget = null; this.backBuffers = [];
    this.gfx = null;
  }
}

const memOfBytes = (b) => ({ u8: b, read16: (p) => b[p] | (b[p + 1] << 8) });
const copyBits = (dst, words) => { new Int32Array(dst.buffer, dst.byteOffset, dst.length).set(words); return dst; };

/**
 * Applies recorded commands to device mirrors and their backends. `opts`: mem (guest memory), createBackend(mirror)
 * → a WebGLDevice-like object or null (state only), ack (Int32Array acknowledgement table) or null, onPresent(mirror,
 * frame), onReadback(ticket), onCanvas(w, h), log.
 */
export class Replayer {
  constructor(words, opts) {
    this.reader = new RingReader(words);
    this.mem = opts.mem; this.opts = opts;
    this.devices = new Map(); this.cur = null;
    this.res = new Map(); // resource id -> mirror resource (textures, their levels, surfaces, buffers)
    this.shaders = new Map(); this.decls = new Map();
    this.ack = opts.ack ?? null;
    this.commands = 0;
  }
  /** replay the commands available up to `available` (a word count): returns the number replayed */
  run(available, limit = Infinity) {
    const r = this.reader;
    let n = 0;
    while (r.consumed < available && n < limit) {
      if (!r.next()) continue; // (WRAP)
      this.apply(r);
      n++;
    }
    this.commands += n;
    return n;
  }
  /** a backend device whose uploads acknowledge the contents they read (glTexture / glBuffer) */
  attach(m) {
    const g = this.opts.createBackend?.(m) ?? null;
    m.gfx = g;
    if (g && this.ack) {
      const ack = this.ack, proto = Object.getPrototypeOf(g);
      g.glTexture = function (t) { const r = proto.glTexture.call(this, t); if (t.acked !== t.gen) { t.acked = t.gen; if (t.slot >= 0) ack[t.slot] = t.gen; } return r; };
      g.glBuffer = function (b, kind) { const r = proto.glBuffer.call(this, b, kind); if (b.acked !== b.gen) { b.acked = b.gen; if (b.slot >= 0) ack[b.slot] = b.gen; } return r; };
    }
    return g;
  }
  table(m, t) { return t === 0 ? m.rs : t <= m.tss.length ? m.tss[t - 1] : m.samplers[t - 1 - m.tss.length]; }
  /**
   * The commands of every draw read straight from the ring words (no decoded argument list, no views allocated); the
   * same effects as their general cases below. Returns false for the others (and for uncommon encodings).
   */
  applyFast(r) {
    const I = r.I, p = r.p, m = this.cur;
    switch (r.op) {
      case OP.TSETS: { const e = p + 1 + I[p]; for (let i = p + 1; i < e; i += 3) this.table(m, I[i]).set(I[i + 1], I[i + 2] >>> 0); return true; }
      case OP.VERSION: { const t = I[p + 1]; if (t > 1) return false; m[VERSION_FIELDS[I[p]]] = t === 0 ? I[p + 2] >>> 0 : I[p + 2]; return true; }
      case OP.TEXTURE: m.textures[I[p] >>> 0] = I[p + 1] >>> 0; return true;
      case OP.STREAM: { // stream, id, stride (n), offset (n): the common uint32 encodings
        if (I[p + 2] !== 0 || (I[p + 4] !== 0 && I[p + 4] !== 3)) return false;
        const s = m.streams[I[p] >>> 0]; s.vb = I[p + 1] >>> 0; s.stride = I[p + 3] >>> 0;
        if (I[p + 4] === 0) s.offset = I[p + 5] >>> 0; else if ('offset' in s) s.offset = undefined;
        return true;
      }
      case OP.INDICES: { const t = I[p + 1]; if (t > 1) return false; m.indices.ib = I[p] >>> 0; m.indices.base = t === 0 ? I[p + 2] >>> 0 : I[p + 2]; return true; }
      case OP.CONST: {
        const k = I[p] >>> 0, lo = I[p + 1] >>> 0, n = I[p + 2], dst = m[CONST_FIELDS[k]];
        if (n < 0) return false;
        if (k < 2) { // (floats as their bits: through the array's word view, kept while the array is the same)
          let w = m.constWords[k]; if (w === null || w.buffer !== dst.buffer || w.byteOffset !== dst.byteOffset) w = m.constWords[k] = new Int32Array(dst.buffer, dst.byteOffset, dst.length);
          for (let i = 0; i < n; i++) w[lo + i] = I[p + 3 + i];
        } else for (let i = 0; i < n; i++) dst[lo + i] = I[p + 3 + i];
        m.gfx?.constTouched?.(k, lo, lo + n);
        return true;
      }
      case OP.XFORM: { // slot, version (uint32), 16 words: the common case
        if (I[p + 1] !== 0 || I[p + 3] !== 16) return false;
        const slot = I[p] >>> 0;
        let x = m.transforms.get(slot), w = m.transformWords.get(slot);
        if (!x) { m.transforms.set(slot, (x = new Float32Array(16))); w = undefined; }
        if (w === undefined || w.buffer !== x.buffer) m.transformWords.set(slot, (w = new Int32Array(x.buffer, x.byteOffset, 16)));
        for (let i = 0; i < 16; i++) w[i] = I[p + 4 + i];
        m.transformSlotVersion.set(slot, I[p + 2] >>> 0);
        return true;
      }
      case OP.MATERIAL: { // (the material array is kept: its word view too)
        const n = I[p]; if (n < 0 || n > m.material.length) return false;
        const w = m.materialWords.buffer === m.material.buffer ? m.materialWords : (m.materialWords = new Int32Array(m.material.buffer, m.material.byteOffset, m.material.length));
        for (let i = 0; i < n; i++) w[i] = I[p + 1 + i];
        return true;
      }
      case OP.LIGHT: {
        const i = I[p] >>> 0, n = I[p + 1]; if (n < 0 || n > 26) return false;
        let l = m.lights.get(i), w = m.lightWords.get(i);
        if (!l) { m.lights.set(i, (l = new Float32Array(26))); w = undefined; }
        if (w === undefined || w.buffer !== l.buffer) m.lightWords.set(i, (w = new Int32Array(l.buffer, l.byteOffset, 26)));
        for (let k = 0; k < n; k++) w[k] = I[p + 2 + k];
        return true;
      }
      case OP.DRAW: m.gfx?.drawPrimitive(I[p] >>> 0, I[p + 1] >>> 0, I[p + 2] >>> 0); return true;
      case OP.DRAW_INDEXED: { const t = I[p + 5]; if (t > 1) return false; m.gfx?.drawIndexedPrimitive(I[p] >>> 0, I[p + 1] >>> 0, I[p + 2] >>> 0, I[p + 3] >>> 0, I[p + 4] >>> 0, t === 0 ? I[p + 6] >>> 0 : I[p + 6]); return true; }
      default: return false;
    }
  }
  apply(r) {
    if (this.cur !== null && this.applyFast(r)) return;
    const a = r.decode(), m = this.cur, g = m?.gfx;
    switch (r.op) {
      case OP.DEVICE: { const d = new DeviceMirror(a[0], a[1], { width: a[2], height: a[3], swap: a[4], count: 1 }, this.mem, this); this.devices.set(a[0], d); this.cur = d; this.attach(d); break; }
      case OP.SELECT: this.cur = this.devices.get(a[0]) ?? null; break;
      case OP.DEVICE_DESTROY: { const d = this.devices.get(a[0]); d?.gfx?.destroy?.(); this.devices.delete(a[0]); if (this.cur === d) this.cur = null; break; }
      case OP.PP: m.pp = { width: a[0], height: a[1], swap: a[2], count: a[3] }; break;
      case OP.RESET: g?.reset(m); break;
      case OP.API9: m.api9 = !!a[0]; if (m.api9 && m.samplers === undefined) { m.samplers = []; m.scissor = null; m.fvf = 0; m.vertexDecl = null; m.vsObj = null; m.psObj = null; } break;
      case OP.TABLES: m.rs = new StateTable(256); m.tss = Array.from({ length: a[0] }, () => new StateTable(40)); m.samplers = a[1] ? Array.from({ length: a[1] }, () => new StateTable(16)) : undefined; break;
      case OP.TSET: this.table(m, a[0]).set(a[1], a[2]); break;
      case OP.TSETS: { const w = a[0]; for (let i = 0; i < w.length; i += 3) this.table(m, w[i]).set(w[i + 1], w[i + 2] >>> 0); break; }
      case OP.VIEWPORT: m.viewport = { x: a[0], y: a[1], w: a[2], h: a[3], minZ: a[4], maxZ: a[5] }; break;
      case OP.SCISSOR: m.scissor = a[0] ? { l: a[1], t: a[2], r: a[3], b: a[4] } : null; break;
      case OP.FVF: m.fvf = a[0]; break;
      case OP.DECL: m.vertexDecl = a[0] ? this.decls.get(a[0]) ?? null : null; break;
      case OP.VS9: { const s = a[0] ? this.shaders.get(a[0]) ?? null : null; m.vsObj = s; m.vertexShader = s ? s.handle : 0; break; }
      case OP.PS9: { const s = a[0] ? this.shaders.get(a[0]) ?? null : null; m.psObj = s; m.pixelShader = s ? s.handle : 0; break; }
      case OP.VS8: m.vertexShader = a[0]; if (a[1]) m.vertexShaders.set(a[0], this.shaders.get(a[1])); else m.vertexShaders.delete(a[0]); break;
      case OP.PS8: m.pixelShader = a[0]; if (a[1]) m.pixelShaders.set(a[0], this.shaders.get(a[1])); else m.pixelShaders.delete(a[0]); break;
      case OP.STREAMS: m.streams = Array.from({ length: a[0] }, () => (m.api9 ? { vb: 0, offset: 0, stride: 0 } : { vb: 0, stride: 0 })); break;
      case OP.STREAM: { const s = m.streams[a[0]]; s.vb = a[1]; s.stride = a[2]; if (a[3] !== undefined || 'offset' in s) s.offset = a[3]; break; }
      case OP.INDICES: m.indices.ib = a[0]; m.indices.base = a[1]; break;
      case OP.TEXTURES: m.textures = new Array(a[0]).fill(0); break;
      case OP.TEXTURE: m.textures[a[0]] = a[1]; break;
      case OP.RT: m.renderTarget = this.res.get(a[0]) ?? null; break;
      case OP.BACKBUFFERS: m.backBuffers = Array.from(a[0], (id) => this.res.get(id)); break;
      case OP.VERSION: m[VERSION_FIELDS[a[0]]] = a[1]; break;
      case OP.XFORMS: m.transforms = new Map(); m.transformSlotVersion = new Map(); m.transformWords = new Map(); break;
      case OP.XFORM: {
        if (a[2]) { let x = m.transforms.get(a[0]); if (!x) m.transforms.set(a[0], (x = new Float32Array(16))); copyBits(x, a[2]); } else m.transforms.delete(a[0]);
        if (a[1] === undefined) m.transformSlotVersion.delete(a[0]); else m.transformSlotVersion.set(a[0], a[1]);
        break;
      }
      case OP.LIGHTS: m.lights = new Map(); m.lightEnabled = new Set(); m.lightWords = new Map(); break;
      case OP.LIGHT: { let l = m.lights.get(a[0]); if (!l) m.lights.set(a[0], (l = new Float32Array(26))); copyBits(l, a[1]); break; }
      case OP.LIGHTS_ON: m.lightEnabled = new Set(a[0]); break;
      case OP.MATERIAL: copyBits(m.material, a[0]); break;
      case OP.CONSTS: {
        m.vsConst = new Float32Array(a[0]); m.psConst = new Float32Array(a[1]);
        if (a[2] || a[3] || a[4] || a[5]) { m.vsConstI = new Int32Array(a[2]); m.psConstI = new Int32Array(a[3]); m.vsConstB = new Uint8Array(a[4]); m.psConstB = new Uint8Array(a[5]); }
        break;
      }
      case OP.CONST: {
        const k = a[0], dst = m[CONST_FIELDS[k]], w = a[2];
        if (k < 2) new Int32Array(dst.buffer, dst.byteOffset, dst.length).set(w, a[1]);
        else if (k < 4) dst.set(w, a[1]);
        else for (let i = 0; i < w.length; i++) dst[a[1] + i] = w[i];
        g?.constTouched?.(k, a[1], a[1] + w.length); // (the backend compares only what was written, see WebGLDevice.constTouched)
        break;
      }
      // resources
      case OP.TEX: {
        const [id, kind, fmt, w, h, d, usage, pool, slot, gen, lv] = a;
        const t = new MTexture(id, kind, fmt, w, h, d, usage, pool, slot | 0, gen | 0);
        const n = lv.length / 5;
        const mk = (i, level, face) => new MSurface(lv[5 * i], t, fmt, lv[5 * i + 1], lv[5 * i + 2], usage, pool, level, face, lv[5 * i + 4] >>> 0);
        if (kind === 2) { const per = n / 6; t.faces = []; for (let f = 0; f < 6; f++) { const face = []; for (let i = 0; i < per; i++) { const s = mk(f * per + i, i, f); face.push(s); this.res.set(s.id, s); } t.faces.push(face); } }
        else if (kind === 3) { t.levels = []; for (let i = 0; i < n; i++) { const lw = lv[5 * i + 1], lh = lv[5 * i + 2], ld = lv[5 * i + 3]; t.levels.push({ width: lw, height: lh, depth: ld, pitch: surfacePitch(fmt, lw), slice: surfaceBytes(fmt, lw, lh), bytes: surfaceBytes(fmt, lw, lh) * ld, mem: lv[5 * i + 4] >>> 0, locked: false }); } }
        else { t.levels = []; for (let i = 0; i < n; i++) { const s = mk(i, i, 0); t.levels.push(s); this.res.set(s.id, s); } }
        this.res.set(id, t);
        break;
      }
      case OP.SURF: { const s = new MSurface(a[0], null, a[1], a[2], a[3], a[4], a[5], 0, 0, a[6]); if (a[7]) s.lockable = true; this.res.set(a[0], s); break; }
      case OP.BUF: this.res.set(a[0], new MBuffer(a[0], a[1], a[2], a[3], a[4], a[5], a[6] | 0, a[7] | 0)); break;
      case OP.DESTROY: {
        const x = this.res.get(a[0]); if (!x) break;
        g?.destroyResource(x);
        this.res.delete(a[0]);
        // (the emulator frees the memory right after: a mirror object still referenced — a render target the
        // Direct3D layer does not reference-count — sees it gone, as the device's own object does)
        x.mem = 0;
        for (const l of x.levels ?? []) { l.mem = 0; if (l.id !== undefined) this.res.delete(l.id); }
        for (const f of x.faces ?? []) for (const l of f) { l.mem = 0; this.res.delete(l.id); }
        break;
      }
      case OP.SURF_MEM: { const s = this.res.get(a[0]); if (s) s.mem = a[1]; break; }
      case OP.SURF_DIRTY: { const s = this.res.get(a[0]); if (!s) break; if (a[2]) s.markLocked(a[2]); else s.dirty = true; if (s.owner) s.owner.gen = a[1] | 0; break; }
      case OP.BUF_DIRTY: { const b = this.res.get(a[0]); if (!b) break; b.mem = a[4]; b.gen = a[1] | 0; b.dirty = true; g?.bufferUpdated(b, a[2], a[3]); break; }
      case OP.BUF_DATA: {
        const b = this.res.get(a[0]); if (!b) break;
        const bytes = a[3], sh = b.shadow ??= new Uint8Array(b.length);
        sh.set(bytes, a[1]);
        if (a[2] === 0) { b.dirty = true; g?.bufferUpdated(b, a[1], bytes.length); }
        break;
      }
      case OP.TEX_LOD: { const t = this.res.get(a[0]); if (t) t.lod = a[1]; break; }
      case OP.VOL_MEM: { const t = this.res.get(a[0]); const l = t?.levels?.[a[1]]; if (l) { l.mem = a[2]; l.dirty = true; t.gen = a[3] | 0; } break; } // (its memory, or new contents: uploaded at the next use, its generation acknowledged then)
      case OP.SHADER9: { const code = Uint32Array.from(a[3]); this.shaders.set(a[0], { kind: a[1] ? 'ps' : 'vs', code, handle: a[2], version: code[0] >>> 0 }); break; }
      case OP.SHADER8: this.shaders.set(a[0], a[1] ? { handle: a[2], code: Uint32Array.from(a[5]) } : { handle: a[2], decl: Uint32Array.from(a[4]), code: a[5] ? Uint32Array.from(a[5]) : null, usage: a[3] }); break;
      case OP.SHADER_DELETE: { const s = this.shaders.get(a[0]); if (!s) break; this.shaders.delete(a[0]); if (s.decl || s.kind === 'vs') g?.deleteVertexShader(s); else g?.deletePixelShader(s); break; }
      case OP.DECL_DELETE: this.decls.delete(a[0]); break;
      case OP.FORGET: this.res.delete(a[0]); break;
      case OP.DECL_CREATE: { const bytes = a[1].slice(); this.decls.set(a[0], { layout: declLayout9(memOfBytes(bytes), 0), bytes }); break; }
      // work
      case OP.BEGIN_SCENE: g?.beginScene(); break;
      case OP.CLEAR: g?.clear(a[0], a[5] ?? 0, a[1], a[2], a[3], a[4]); break;
      case OP.DRAW: g?.drawPrimitive(a[0], a[1], a[2]); break;
      case OP.DRAW_INDEXED: g?.drawIndexedPrimitive(a[0], a[1], a[2], a[3], a[4], a[5]); break;
      case OP.DRAW_UP: g?.drawPrimitiveUP(a[0], a[1], a[3], a[2]); break;
      case OP.DRAW_INDEXED_UP: g?.drawIndexedPrimitiveUP(a[0], a[1], a[2], a[3], a[7], a[4], a[6], a[5]); break;
      // (the emulator waits for these two: answered even if the work throws)
      case OP.PRESENT: { const f = a[0]; try { this.opts.beforePresent?.(m, f); g?.present(); } finally { this.opts.onPresent?.(m, f); } break; }
      case OP.READBACK: { const t = a[1]; try { const s = this.res.get(a[0]); if (s) { s.pendingMem = a[2]; if (g) g.readbackSurface(s); s.ensureMem(); } } finally { this.opts.onReadback?.(t); } break; }
      case OP.STRETCH: { const s = this.res.get(a[0]), d = this.res.get(a[1]); if (s && d && g) g.stretchRect(s, a[3] ? Array.from(a[3]) : 0, d, a[4] ? Array.from(a[4]) : 0, a[2]); break; }
      case OP.GAMMA: g?.setGamma(a[0]); break;
      case OP.CANVAS: this.opts.onCanvas?.(a[0], a[1]); break;
      default: throw new Error(`render command ${r.op} unknown`);
    }
  }
}

/**
 * The backend-visible differences between an emulator device and its mirror (debugging, ?glworker=check, tests):
 * descriptions of the fields that differ, empty when the mirror is exact.
 */
export function compareDevice(d, m, max = 20) {
  const out = [], bad = (what) => { if (out.length < max) out.push(what); };
  const idOf = (ptr) => (ptr ? d.com.implAt(ptr)?.id ?? -1 : 0);
  const sameBits = (a, b) => { if (!a || !b) return a === b || (!a && !b); if (a.length !== b.length) return false; const x = new Int32Array(a.buffer, a.byteOffset, a.length * a.BYTES_PER_ELEMENT >> 2), y = new Int32Array(b.buffer, b.byteOffset, b.length * b.BYTES_PER_ELEMENT >> 2); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };
  const sameArr = (a, b) => { if (!a || !b) return !a === !b; if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  if (!!d.api9 !== m.api9) bad(`api9 ${d.api9} / ${m.api9}`);
  for (const k of ['width', 'height', 'swap']) if (d.pp[k] !== m.pp[k]) bad(`pp.${k} ${d.pp[k]} / ${m.pp[k]}`);
  const tables = (name, A, B) => {
    if ((A?.length ?? -1) !== (B?.length ?? -1)) { bad(`${name}: ${A?.length} tables / ${B?.length}`); return; }
    (A ?? []).forEach((t, i) => { const u = B[i]; if (t.size !== u.size) bad(`${name}[${i}] size ${t.size} / ${u.size}`); for (const [k, v] of t) if (!Object.is(u.get(k), v)) bad(`${name}[${i}].${k} ${v} / ${u.get(k)}`); });
  };
  tables('rs', [d.rs], [m.rs]); tables('tss', d.tss, m.tss); tables('samplers', d.samplers, m.samplers);
  if (d.textures.length !== m.textures.length) bad(`textures.length ${d.textures.length} / ${m.textures.length}`);
  d.textures.forEach((p, i) => { if (idOf(p) !== (m.textures[i] || 0)) bad(`textures[${i}] #${idOf(p)} / #${m.textures[i]}`); });
  d.textures.forEach((p, i) => { const t = p ? d.com.implAt(p) : null, mt = m.textures[i] ? m.com.implAt(m.textures[i]) : null; if (t && mt && (t.lod ?? 0) !== (mt.lod ?? 0)) bad(`texture #${t.id} LOD ${t.lod} / ${mt.lod}`); });
  if (d.streams.length !== m.streams.length) bad(`streams.length ${d.streams.length} / ${m.streams.length}`);
  d.streams.forEach((s, i) => { const t = m.streams[i]; if (!t || idOf(s.vb) !== (t.vb || 0) || s.stride !== t.stride || (s.offset ?? 0) !== (t.offset ?? 0)) bad(`streams[${i}] #${idOf(s.vb)}/${s.stride}/${s.offset} / #${t?.vb}/${t?.stride}/${t?.offset}`); });
  if (idOf(d.indices.ib) !== (m.indices.ib || 0) || d.indices.base !== m.indices.base) bad(`indices #${idOf(d.indices.ib)}/${d.indices.base} / #${m.indices.ib}/${m.indices.base}`);
  for (const k of ['x', 'y', 'w', 'h', 'minZ', 'maxZ']) if (!Object.is(d.viewport[k], m.viewport[k])) bad(`viewport.${k} ${d.viewport[k]} / ${m.viewport[k]}`);
  if (d.api9) {
    if (!d.scissor !== !m.scissor || (d.scissor && ['l', 't', 'r', 'b'].some((k) => d.scissor[k] !== m.scissor[k]))) bad(`scissor ${JSON.stringify(d.scissor)} / ${JSON.stringify(m.scissor)}`);
    if (d.fvf !== m.fvf) bad(`fvf ${d.fvf} / ${m.fvf}`);
    if (!d.vertexDecl !== !m.vertexDecl || (d.vertexDecl && !sameArr(d.vertexDecl.bytes, m.vertexDecl.bytes))) bad('vertexDecl');
    for (const k of ['vsObj', 'psObj']) if (!d[k] !== !m[k] || (d[k] && (d[k].handle !== m[k].handle || !sameArr(d[k].code, m[k].code)))) bad(k);
  } else {
    const vs = d.vertexShaders.get(d.vertexShader), mv = m.vertexShaders.get(m.vertexShader), ps = d.pixelShaders.get(d.pixelShader), mp = m.pixelShaders.get(m.pixelShader);
    if (!vs !== !mv || (vs && (!sameArr(vs.decl, mv.decl) || !sameArr(vs.code, mv.code)))) bad('current vertex shader');
    if (!ps !== !mp || (ps && !sameArr(ps.code, mp.code))) bad('current pixel shader');
  }
  if (d.vertexShader !== m.vertexShader) bad(`vertexShader ${d.vertexShader} / ${m.vertexShader}`);
  if (d.pixelShader !== m.pixelShader) bad(`pixelShader ${d.pixelShader} / ${m.pixelShader}`);
  for (const f of VERSION_FIELDS) if (d[f] !== m[f]) bad(`${f} ${d[f]} / ${m[f]}`);
  if (d.transforms.size !== m.transforms.size) bad(`transforms.size ${d.transforms.size} / ${m.transforms.size}`);
  for (const [k, x] of d.transforms) if (!sameBits(x, m.transforms.get(k))) bad(`transforms[${k}]`);
  if (d.transformSlotVersion.size !== m.transformSlotVersion.size) bad(`transformSlotVersion.size ${d.transformSlotVersion.size} / ${m.transformSlotVersion.size}`);
  for (const [k, v] of d.transformSlotVersion) if (m.transformSlotVersion.get(k) !== v) bad(`transformSlotVersion[${k}] ${v} / ${m.transformSlotVersion.get(k)}`);
  for (const [k, x] of d.lights) if (!sameBits(x, m.lights.get(k))) bad(`lights[${k}]`);
  if (d.lightEnabled.size !== m.lightEnabled.size || [...d.lightEnabled].some((i) => !m.lightEnabled.has(i))) bad(`lightEnabled ${[...d.lightEnabled]} / ${[...m.lightEnabled]}`);
  if (!sameBits(d.material, m.material)) bad('material');
  for (const f of CONST_FIELDS) if (d[f] instanceof Uint8Array ? !sameArr(d[f], m[f]) : !sameBits(d[f], m[f])) bad(f);
  if ((d.renderTarget?.id ?? 0) !== (m.renderTarget?.id ?? 0)) bad(`renderTarget #${d.renderTarget?.id} / #${m.renderTarget?.id}`);
  if (!sameArr(d.backBuffers.map((b) => b.id), m.backBuffers.map((b) => b?.id))) bad('backBuffers');
  return out;
}
