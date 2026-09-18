// Direct3D 8 backend on WebGL2. Resources live in guest memory (see win32/d3d8.js); this module
// mirrors them into GL objects lazily (uploads on Unlock/dirty), builds fixed-function or
// translated shader programs from the device state at draw time, and maps render states,
// texture stage/sampler states, blending, depth/stencil, fog and viewport onto GL.
import { FMT, surfacePitch, surfaceBytes } from '../win32/d3d8.js';
import { fvfLayout, declLayout, ffVertexShader, ffFragmentShader, translateVertexShader, translatePixelShader, RS, TSS, TOP, TS_WORLD, TS_VIEW, TS_PROJECTION, TS_TEXTURE0, MAX_STAGES, MAX_LIGHTS } from './d3d8-shaders.js';

const D3D_OK = 0;
const PT = { POINTLIST: 1, LINELIST: 2, LINESTRIP: 3, TRIANGLELIST: 4, TRIANGLESTRIP: 5, TRIANGLEFAN: 6 };
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const asFloat = (v) => { u32[0] = v >>> 0; return f32[0]; };
const colorToVec = (c, out = new Float32Array(4)) => { out[0] = ((c >> 16) & 0xff) / 255; out[1] = ((c >> 8) & 0xff) / 255; out[2] = (c & 0xff) / 255; out[3] = ((c >>> 24) & 0xff) / 255; return out; };
const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const isDxt = (f) => f === FMT.DXT1 || f === FMT.DXT2 || f === FMT.DXT3 || f === FMT.DXT4 || f === FMT.DXT5;

/** Decode one DXT1/3/5 surface to RGBA8. */
export function decodeDxt(fmt, src, w, h) {
  const out = new Uint8Array(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const bs = fmt === FMT.DXT1 ? 8 : 16;
  const c = [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)];
  const alphas = new Uint8Array(16);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let p = (by * bw + bx) * bs;
    if (fmt !== FMT.DXT1) {
      if (fmt === FMT.DXT2 || fmt === FMT.DXT3) { for (let i = 0; i < 16; i++) { const v = (src[p + (i >> 1)] >> ((i & 1) * 4)) & 15; alphas[i] = v * 17; } }
      else {
        const a0 = src[p], a1 = src[p + 1];
        const at = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) at.push(((7 - i) * a0 + i * a1) / 7 | 0); else { for (let i = 1; i < 5; i++) at.push(((5 - i) * a0 + i * a1) / 5 | 0); at.push(0, 255); }
        let bits = 0n; for (let i = 0; i < 6; i++) bits |= BigInt(src[p + 2 + i]) << BigInt(8 * i);
        for (let i = 0; i < 16; i++) alphas[i] = at[Number((bits >> BigInt(3 * i)) & 7n)];
      }
      p += 8;
    }
    const c0 = src[p] | (src[p + 1] << 8), c1 = src[p + 2] | (src[p + 3] << 8);
    const expand = (v, o) => { o[0] = ((v >> 11) & 31) * 255 / 31 | 0; o[1] = ((v >> 5) & 63) * 255 / 63 | 0; o[2] = (v & 31) * 255 / 31 | 0; o[3] = 255; };
    expand(c0, c[0]); expand(c1, c[1]);
    if (fmt !== FMT.DXT1 || c0 > c1) { for (let i = 0; i < 3; i++) { c[2][i] = (2 * c[0][i] + c[1][i]) / 3 | 0; c[3][i] = (c[0][i] + 2 * c[1][i]) / 3 | 0; } c[2][3] = c[3][3] = 255; }
    else { for (let i = 0; i < 3; i++) { c[2][i] = (c[0][i] + c[1][i]) >> 1; c[3][i] = 0; } c[2][3] = 255; c[3][3] = 0; }
    const idx = src[p + 4] | (src[p + 5] << 8) | (src[p + 6] << 16) | (src[p + 7] << 24);
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const col = c[(idx >>> (2 * i)) & 3];
      const o = (y * w + x) * 4;
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2];
      out[o + 3] = fmt === FMT.DXT1 ? col[3] : alphas[i];
    }
  }
  return out;
}

/** Convert a guest surface to RGBA8 bytes. */
export function surfaceToRgba(mem, fmt, addr, w, h, pitch) {
  if (isDxt(fmt)) return decodeDxt(fmt, mem.bytes(addr, surfaceBytes(fmt, w, h)), w, h);
  const out = new Uint8Array(w * h * 4);
  const u8 = mem.u8;
  for (let y = 0; y < h; y++) {
    let s = addr + y * pitch, o = y * w * 4;
    switch (fmt) {
      case FMT.A8R8G8B8: case FMT.X8R8G8B8: case FMT.A8B8G8R8: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = fmt === FMT.X8R8G8B8 ? 255 : u8[s + 3]; } break;
      case FMT.R8G8B8: for (let x = 0; x < w; x++, s += 3, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; } break;
      case FMT.R5G6B5: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 11) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 63) * 255 / 63 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = 255; } break;
      case FMT.X1R5G5B5: case FMT.A1R5G5B5: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 10) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 31) * 255 / 31 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = fmt === FMT.A1R5G5B5 ? (v & 0x8000 ? 255 : 0) : 255; } break;
      case FMT.A4R4G4B4: case FMT.X4R4G4B4: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 8) & 15) * 17; out[o + 1] = ((v >> 4) & 15) * 17; out[o + 2] = (v & 15) * 17; out[o + 3] = fmt === FMT.A4R4G4B4 ? ((v >> 12) & 15) * 17 : 255; } break;
      case FMT.A8: for (let x = 0; x < w; x++, s++, o += 4) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = u8[s]; } break;
      case FMT.L8: case FMT.P8: for (let x = 0; x < w; x++, s++, o += 4) { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = 255; } break;
      case FMT.A8L8: for (let x = 0; x < w; x++, s += 2, o += 4) { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = u8[s + 1]; } break;
      case FMT.A4L4: for (let x = 0; x < w; x++, s++, o += 4) { const l = (u8[s] & 15) * 17; out[o] = out[o + 1] = out[o + 2] = l; out[o + 3] = (u8[s] >> 4) * 17; } break;
      case FMT.V8U8: for (let x = 0; x < w; x++, s += 2, o += 4) { out[o] = (u8[s] + 128) & 0xff; out[o + 1] = (u8[s + 1] + 128) & 0xff; out[o + 2] = 255; out[o + 3] = 255; } break;
      default: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; }
    }
  }
  return out;
}

export class WebGLDevice {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {any} dev the d3d8.js Device
   * @param {{ log?: (m: string) => void }} [opts]
   */
  constructor(gl, dev, opts = {}) {
    this.gl = gl; this.dev = dev; this.mem = dev.proc.mem;
    this.log = opts.log ?? (() => {});
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.programs = new Map();
    this.textures = new Map(); // resource id -> { tex, target, levels }
    this.buffers = new Map(); // resource id -> { buf }
    this.fbos = new Map(); // surface id -> fbo
    this.samplers = []; for (let i = 0; i < MAX_STAGES; i++) this.samplers.push(gl.createSampler());
    this.upVbo = gl.createBuffer(); this.upIbo = gl.createBuffer();
    this.vao = gl.createVertexArray();
    this.stats = { draws: 0, programs: 0, uploads: 0 };
    this.tmp = { v4: new Float32Array(4), m4: new Float32Array(16) };
    this.frameDraws = 0;
    gl.bindVertexArray(this.vao);
    this.reset(dev);
  }
  reset(dev) {
    const gl = this.gl;
    this.dev = dev;
    const c = gl.canvas;
    if (c.width !== dev.pp.width || c.height !== dev.pp.height) { c.width = dev.pp.width; c.height = dev.pp.height; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, dev.pp.width, dev.pp.height);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }
  destroy() { const gl = this.gl; for (const t of this.textures.values()) gl.deleteTexture(t.tex); for (const b of this.buffers.values()) gl.deleteBuffer(b.buf); for (const f of this.fbos.values()) { gl.deleteFramebuffer(f.fbo); if (f.depth) gl.deleteRenderbuffer(f.depth); if (f.color) gl.deleteRenderbuffer(f.color); } }

  // ---------------------------------------------------------------- resources
  createTexture() {}
  createBuffer() {}
  createSurface() {}
  surfaceUpdated() {}
  volumeUpdated() {}
  bufferUpdated(b) { b.dirty = true; }
  destroyResource(r) {
    const gl = this.gl;
    const t = this.textures.get(r.id); if (t) { gl.deleteTexture(t.tex); this.textures.delete(r.id); }
    const b = this.buffers.get(r.id); if (b) { gl.deleteBuffer(b.buf); this.buffers.delete(r.id); }
    const levels = r.levels ?? (r.faces ? r.faces.flat() : r.type === 1 ? [r] : []);
    for (const l of levels) { const f = this.fbos.get(l.id); if (f) { gl.deleteFramebuffer(f.fbo); if (f.depth) gl.deleteRenderbuffer(f.depth); if (f.color) gl.deleteRenderbuffer(f.color); this.fbos.delete(l.id); } }
  }

  /** GL texture for a texture resource, uploading dirty levels. */
  glTexture(t) {
    const gl = this.gl;
    const cube = !!t.faces;
    const target = cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    let g = this.textures.get(t.id);
    if (!g) { g = { tex: gl.createTexture(), target, levels: 0 }; this.textures.set(t.id, g); gl.bindTexture(target, g.tex); gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, (cube ? t.faces[0].length : t.levels?.length ?? 1) - 1); }
    const faces = cube ? t.faces : [t.levels ?? []];
    let bound = false;
    for (let f = 0; f < faces.length; f++) {
      const lv = faces[f];
      for (let i = 0; i < lv.length; i++) {
        const s = lv[i];
        if (!s.dirty && s.uploaded) continue;
        if (!bound) { gl.bindTexture(target, g.tex); bound = true; }
        const tgt = cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + f : gl.TEXTURE_2D;
        this.uploadLevel(tgt, i, s);
        s.dirty = false; s.uploaded = true;
      }
    }
    return g;
  }
  uploadLevel(target, level, s) {
    const gl = this.gl;
    this.stats.uploads++;
    if (!s.mem) { gl.texImage2D(target, level, gl.RGBA8, s.width, s.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); return; }
    if (isDxt(s.fmt) && this.s3tc) {
      const ext = this.s3tc;
      const glf = s.fmt === FMT.DXT1 ? ext.COMPRESSED_RGBA_S3TC_DXT1_EXT : s.fmt === FMT.DXT2 || s.fmt === FMT.DXT3 ? ext.COMPRESSED_RGBA_S3TC_DXT3_EXT : ext.COMPRESSED_RGBA_S3TC_DXT5_EXT;
      gl.compressedTexImage2D(target, level, glf, s.width, s.height, 0, this.mem.bytes(s.mem, surfaceBytes(s.fmt, s.width, s.height)));
      return;
    }
    const rgba = surfaceToRgba(this.mem, s.fmt, s.mem, s.width, s.height, s.pitch);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(target, level, gl.RGBA8, s.width, s.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }
  glBuffer(b, kind) {
    const gl = this.gl;
    let g = this.buffers.get(b.id);
    const target = kind === 'ib' ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    if (!g) { g = { buf: gl.createBuffer(), size: 0 }; this.buffers.set(b.id, g); b.dirty = true; }
    if (b.dirty) {
      gl.bindBuffer(target, g.buf);
      const data = this.mem.bytes(b.mem, b.length);
      if (g.size !== b.length) { gl.bufferData(target, data, b.usage & 0x200 ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW); g.size = b.length; }
      else gl.bufferSubData(target, 0, data);
      b.dirty = false; this.stats.uploads++;
    }
    return g;
  }

  // ---------------------------------------------------------------- render targets
  bindTarget() {
    const gl = this.gl, dev = this.dev;
    const rt = dev.renderTarget;
    if (!rt || dev.backBuffers.includes(rt)) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { w: dev.pp.width, h: dev.pp.height }; }
    let f = this.fbos.get(rt.id);
    if (!f) {
      f = { fbo: gl.createFramebuffer(), w: rt.width, h: rt.height, depth: null, color: null };
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      if (rt.owner && (rt.owner.levels || rt.owner.faces)) {
        const g = this.glTexture(rt.owner);
        const tgt = rt.owner.faces ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + rt.face : gl.TEXTURE_2D;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tgt, g.tex, rt.level);
      } else {
        f.color = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, f.color); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, rt.width, rt.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, f.color);
      }
      f.depth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, f.depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, rt.width, rt.height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, f.depth);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) this.log(`d3d8-webgl: render target FBO incomplete (${status})`);
      this.fbos.set(rt.id, f);
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    return { w: f.w, h: f.h };
  }
  setRenderTarget() {}
  readbackSurface(s) {
    const gl = this.gl, dev = this.dev;
    const prev = dev.renderTarget; dev.renderTarget = s;
    const { w, h } = this.bindTarget();
    const rgba = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    dev.renderTarget = prev;
    const base = s.ensureMem(dev.proc), u8 = this.mem.u8;
    // GL rows are bottom-up; D3D surfaces are top-down
    for (let y = 0; y < h; y++) { const src = (h - 1 - y) * w * 4; let o = base + y * s.pitch; for (let x = 0; x < w; x++, o += 4) { const i = src + x * 4; u8[o] = rgba[i + 2]; u8[o + 1] = rgba[i + 1]; u8[o + 2] = rgba[i]; u8[o + 3] = rgba[i + 3]; } }
  }
  readbackFrontBuffer(s) { this.readbackSurface(this.dev.backBuffers[0]); const b = this.dev.backBuffers[0]; if (b.mem && b.fmt === s.fmt) this.mem.copy(s.ensureMem(this.dev.proc), b.mem, Math.min(b.bytes, s.bytes)); }
  copyRects(src, dst, rects, n, points) {
    const mem = this.mem, dev = this.dev;
    if ((src.usage & 1) && !src.mem) this.readbackSurface(src);
    const sb = src.ensureMem(dev.proc), db = dst.ensureMem(dev.proc);
    const bpp = surfacePitch(src.fmt, 1);
    const copy = (sx, sy, w, h, dx, dy) => { for (let y = 0; y < h; y++) mem.copy(db + (dy + y) * dst.pitch + dx * bpp, sb + (sy + y) * src.pitch + sx * bpp, w * bpp); };
    if (!rects || !n) copy(0, 0, Math.min(src.width, dst.width), Math.min(src.height, dst.height), 0, 0);
    else for (let i = 0; i < n; i++) { const r = rects + 16 * i; const l = mem.readS32(r), t = mem.readS32(r + 4), rr = mem.readS32(r + 8), b = mem.readS32(r + 12); const dx = points ? mem.readS32(points + 8 * i) : 0, dy = points ? mem.readS32(points + 8 * i + 4) : 0; copy(l, t, Math.min(rr - l, dst.width - dx), Math.min(b - t, dst.height - dy), dx, dy); }
    dst.dirty = true;
    return D3D_OK;
  }

  // ---------------------------------------------------------------- frame
  beginScene() { this.frameDraws = 0; }
  endScene() {}
  present() { this.gl.flush(); }
  clear(n, rects, flags, color, z, stencil) {
    const gl = this.gl, dev = this.dev;
    const { h } = this.bindTarget();
    const v = dev.viewport;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(v.x, h - v.y - v.h, v.w, v.h);
    let mask = 0;
    if (flags & 1) { const c = colorToVec(color, this.tmp.v4); gl.colorMask(true, true, true, true); gl.clearColor(c[0], c[1], c[2], c[3]); mask |= gl.COLOR_BUFFER_BIT; }
    if (flags & 2) { gl.depthMask(true); gl.clearDepth(z); mask |= gl.DEPTH_BUFFER_BIT; }
    if (flags & 4) { gl.stencilMask(0xff); gl.clearStencil(stencil); mask |= gl.STENCIL_BUFFER_BIT; }
    if (n && rects) { const mem = this.mem; for (let i = 0; i < n; i++) { const r = rects + 16 * i; const l = mem.readS32(r), t = mem.readS32(r + 4), rr = mem.readS32(r + 8), b = mem.readS32(r + 12); gl.scissor(l, h - b, rr - l, b - t); gl.clear(mask); } }
    else gl.clear(mask);
    gl.disable(gl.SCISSOR_TEST);
  }
  setTransform() {} setViewport() {} setMaterial() {} setLight() {} lightEnable() {} setClipPlane() {} setRenderState() {} setTexture() {} setTextureStageState() {}
  createVertexShader() {} setVertexShader() {} deleteVertexShader() {} setVertexShaderConstant() {} setStreamSource() {} setIndices() {} createPixelShader() {} setPixelShader() {} deletePixelShader() {} setPixelShaderConstant() {}
  setCursor() {} setGamma() {}

  // ---------------------------------------------------------------- programs
  currentLayout() {
    const dev = this.dev, h = dev.vertexShader;
    const sh = dev.vertexShaders.get(h);
    if (sh) { if (!sh.layout) sh.layout = declLayout(sh.decl); return { decl: sh, layout: sh.layout, code: sh.code }; }
    if (!this.fvfCache) this.fvfCache = new Map();
    let l = this.fvfCache.get(h); if (!l) { l = fvfLayout(h); this.fvfCache.set(h, l); }
    return { decl: null, layout: l, code: null };
  }
  rsF(s) { return asFloat(this.dev.rs.get(s) ?? 0); }
  rs(s, d = 0) { return this.dev.rs.get(s) ?? d; }
  tss(st, t, d = 0) { return this.dev.tss[st].get(t) ?? d; }

  stageInfo(i) {
    const dev = this.dev, texPtr = dev.textures[i];
    const tex = texPtr ? dev.proc && this.comImpl(texPtr) : null;
    return { tex, cube: !!tex?.faces, bound: !!tex, tci: this.tss(i, TSS.TEXCOORDINDEX, i), ttff: this.tss(i, TSS.TEXTURETRANSFORMFLAGS, 0) };
  }
  comImpl(ptr) { return this.dev.com ? this.dev.com.implAt(ptr) : null; }

  program() {
    const gl = this.gl, dev = this.dev;
    const L = this.currentLayout();
    const lighting = this.rs(RS.LIGHTING, 1) !== 0 && !L.layout.rhw && !L.code;
    const fogEnable = this.rs(RS.FOGENABLE, 0) !== 0;
    const tableMode = this.rs(RS.FOGTABLEMODE, 0), vertexMode = this.rs(RS.FOGVERTEXMODE, 0);
    const fog = !fogEnable ? 0 : tableMode ? tableMode : vertexMode || L.layout.rhw ? -1 : 0;
    const stages = [];
    for (let i = 0; i < MAX_STAGES; i++) {
      const colorOp = this.tss(i, TSS.COLOROP, i === 0 ? TOP.MODULATE : TOP.DISABLE);
      const info = this.stageInfo(i);
      stages.push({ colorOp, colorArg1: this.tss(i, TSS.COLORARG1, 2), colorArg2: this.tss(i, TSS.COLORARG2, 1), colorArg0: this.tss(i, TSS.COLORARG0, 1), alphaOp: this.tss(i, TSS.ALPHAOP, i === 0 ? TOP.SELECTARG1 : TOP.DISABLE), alphaArg1: this.tss(i, TSS.ALPHAARG1, 2), alphaArg2: this.tss(i, TSS.ALPHAARG2, 1), alphaArg0: this.tss(i, TSS.ALPHAARG0, 1), resultTemp: this.tss(i, TSS.RESULTARG, 1) === 5, cube: info.cube, projected: (info.ttff & 0x100) !== 0, bound: info.bound, tci: info.tci, ttff: info.ttff });
      if (colorOp === TOP.DISABLE) break;
    }
    const ps = dev.pixelShaders.get(dev.pixelShader);
    const lightTypes = [];
    if (lighting) for (const i of [...dev.lightEnabled].sort((a, b) => a - b)) { const l = dev.lights.get(i); if (l) lightTypes.push(l[0] | 0); }
    const vsKey = L.code ? `vs:${L.decl.handle}` : `ff:${L.decl ? 'd' + L.decl.handle : 'f' + dev.vertexShader}:${lighting ? 1 : 0}:${lightTypes.join(',')}:${this.rs(RS.COLORVERTEX, 1)}:${this.rs(RS.DIFFUSEMATERIALSOURCE, 1)}:${this.rs(RS.SPECULARMATERIALSOURCE, 2)}:${this.rs(RS.AMBIENTMATERIALSOURCE, 0)}:${this.rs(RS.EMISSIVEMATERIALSOURCE, 0)}:${this.rs(RS.SPECULARENABLE, 0)}:${this.rs(RS.LOCALVIEWER, 1)}:${fog === -1 ? vertexMode : 0}:${this.rs(RS.RANGEFOGENABLE, 0)}:${stages.map((s) => `${s.tci}/${s.ttff}`).join(',')}:${this.rs(RS.VERTEXBLEND, 0)}`;
    const fsKey = ps ? `ps:${dev.pixelShader}:${stages.map((s) => (s.cube ? 'c' : s.projected ? 'p' : 't')).join('')}:${fog}` : `ff:${stages.map((s) => `${s.colorOp},${s.colorArg1},${s.colorArg2},${s.colorArg0},${s.alphaOp},${s.alphaArg1},${s.alphaArg2},${s.alphaArg0},${s.resultTemp ? 1 : 0},${s.cube ? 1 : 0},${s.projected ? 1 : 0},${s.bound ? 1 : 0}`).join(';')}:${this.rs(RS.ALPHATESTENABLE, 0) ? this.rs(RS.ALPHAFUNC, 8) : 0}:${this.rs(RS.SPECULARENABLE, 0)}:${fog}`;
    const key = vsKey + '|' + fsKey;
    let p = this.programs.get(key);
    if (p) return { p, L, stages, lighting, fog, lightTypes };
    const vsSrc = L.code ? translateVertexShader(L.code, L.layout) : ffVertexShader({ layout: L.layout, lighting, lights: lightTypes, colorVertex: this.rs(RS.COLORVERTEX, 1) !== 0, diffuseSrc: this.rs(RS.DIFFUSEMATERIALSOURCE, 1), specularSrc: this.rs(RS.SPECULARMATERIALSOURCE, 2), ambientSrc: this.rs(RS.AMBIENTMATERIALSOURCE, 0), emissiveSrc: this.rs(RS.EMISSIVEMATERIALSOURCE, 0), specularEnable: this.rs(RS.SPECULARENABLE, 0) !== 0, localViewer: this.rs(RS.LOCALVIEWER, 1) !== 0, normalize: this.rs(RS.NORMALIZENORMALS, 0) !== 0, fogVertex: fog === -1 && !L.layout.rhw ? vertexMode : 0, rangeFog: this.rs(RS.RANGEFOGENABLE, 0) !== 0, stages, rhw: L.layout.rhw, blend: this.rs(RS.VERTEXBLEND, 0) ? L.layout.blend + 1 : 0, pointSize: true });
    const fsSrc = ps ? translatePixelShader(ps.code, { cube: stages.map((s) => s.cube), projected: stages.map((s) => s.projected), fog }) : ffFragmentShader({ stages, alphaTest: this.rs(RS.ALPHATESTENABLE, 0) ? this.rs(RS.ALPHAFUNC, 8) : 0, specular: this.rs(RS.SPECULARENABLE, 0) !== 0, fog });
    p = this.compile(vsSrc, fsSrc, key, L);
    this.programs.set(key, p);
    return { p, L, stages, lighting, fog, lightTypes };
  }
  compile(vsSrc, fsSrc, key, L) {
    const gl = this.gl;
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { this.log(`d3d8-webgl: shader compile error: ${gl.getShaderInfoLog(s)}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`); } return s; };
    const prog = gl.createProgram();
    const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    // stable attribute locations by name
    const attrNames = L.code ? [...new Set([...L.layout.streams.values()].flatMap((s) => s.attrs.map((a) => 'a_v' + a.reg)))] : L.layout.attrs ? L.layout.attrs.map((a) => 'a_' + a.name) : [...L.layout.streams.values()].flatMap((s) => s.attrs.map((a) => 'a_' + a.name));
    attrNames.forEach((n, i) => gl.bindAttribLocation(prog, i, n));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) this.log(`d3d8-webgl: link error: ${gl.getProgramInfoLog(prog)}`);
    gl.deleteShader(vs); gl.deleteShader(fs);
    this.stats.programs++;
    const uniforms = new Map();
    const u = (name) => { let l = uniforms.get(name); if (l === undefined) { l = gl.getUniformLocation(prog, name); uniforms.set(name, l); } return l; };
    return { prog, u, attrNames, key };
  }

  // ---------------------------------------------------------------- state application
  applyState(P, info) {
    const gl = this.gl, dev = this.dev;
    const { w, h } = this.bindTarget();
    const v = dev.viewport;
    gl.viewport(v.x, h - v.y - v.h, v.w, v.h);
    gl.depthRange(v.minZ, v.maxZ);
    gl.useProgram(P.prog);
    const U = P.u;
    // matrices
    for (let i = 0; i < 4; i++) { const l = U(`u_world[${i}]`); if (l) gl.uniformMatrix4fv(l, false, dev.transforms.get(TS_WORLD + i) ?? IDENTITY); }
    if (U('u_view')) gl.uniformMatrix4fv(U('u_view'), false, dev.transforms.get(TS_VIEW) ?? IDENTITY);
    if (U('u_proj')) gl.uniformMatrix4fv(U('u_proj'), false, dev.transforms.get(TS_PROJECTION) ?? IDENTITY);
    for (let i = 0; i < MAX_STAGES; i++) { const l = U(`u_texmat[${i}]`); if (l) gl.uniformMatrix4fv(l, false, dev.transforms.get(TS_TEXTURE0 + i) ?? IDENTITY); }
    if (U('u_viewport')) gl.uniform4f(U('u_viewport'), v.x, v.y, v.w, v.h);
    if (U('u_depthRange')) gl.uniform2f(U('u_depthRange'), v.minZ, v.maxZ);
    // material & lights
    if (info.lighting) {
      const m = dev.material;
      gl.uniform4fv(U('u_matDiffuse'), m.subarray(0, 4)); gl.uniform4fv(U('u_matAmbient'), m.subarray(4, 8)); gl.uniform4fv(U('u_matSpecular'), m.subarray(8, 12)); gl.uniform4fv(U('u_matEmissive'), m.subarray(12, 16)); gl.uniform1f(U('u_matPower'), m[16]);
      gl.uniform4fv(U('u_ambient'), colorToVec(this.rs(RS.AMBIENT, 0), this.tmp.v4));
      let n = 0;
      for (const i of [...dev.lightEnabled].sort((a, b) => a - b)) {
        const l = dev.lights.get(i); if (!l || n >= MAX_LIGHTS) continue;
        const pre = `u_lights[${n}]`;
        gl.uniform1i(U(pre + '.type'), l[0] | 0);
        gl.uniform4fv(U(pre + '.diffuse'), l.subarray(1, 5)); gl.uniform4fv(U(pre + '.specular'), l.subarray(5, 9)); gl.uniform4fv(U(pre + '.ambient'), l.subarray(9, 13));
        // light position/direction are in world space: bring them to view space
        const view = dev.transforms.get(TS_VIEW) ?? IDENTITY;
        const px = l[13], py = l[14], pz = l[15];
        gl.uniform3f(U(pre + '.position'), view[0] * px + view[4] * py + view[8] * pz + view[12], view[1] * px + view[5] * py + view[9] * pz + view[13], view[2] * px + view[6] * py + view[10] * pz + view[14]);
        const dx = l[16], dy = l[17], dz = l[18];
        gl.uniform3f(U(pre + '.direction'), view[0] * dx + view[4] * dy + view[8] * dz, view[1] * dx + view[5] * dy + view[9] * dz, view[2] * dx + view[6] * dy + view[10] * dz);
        gl.uniform1f(U(pre + '.range'), l[19]); gl.uniform1f(U(pre + '.falloff'), l[20]);
        gl.uniform3f(U(pre + '.atten'), l[21], l[22], l[23]); gl.uniform1f(U(pre + '.theta'), l[24]); gl.uniform1f(U(pre + '.phi'), l[25]);
        n++;
      }
      gl.uniform1i(U('u_numLights'), n);
    }
    // fog / misc
    if (U('u_fog')) gl.uniform4f(U('u_fog'), this.rsF(RS.FOGSTART), this.rsF(RS.FOGEND), this.rsF(RS.FOGDENSITY), 0);
    if (U('u_fogParams')) gl.uniform4f(U('u_fogParams'), this.rsF(RS.FOGSTART), this.rsF(RS.FOGEND), this.rsF(RS.FOGDENSITY), 0);
    if (U('u_fogColor')) gl.uniform4fv(U('u_fogColor'), colorToVec(this.rs(RS.FOGCOLOR, 0), this.tmp.v4));
    if (U('u_tfactor')) gl.uniform4fv(U('u_tfactor'), colorToVec(this.rs(RS.TEXTUREFACTOR, 0xffffffff), this.tmp.v4));
    if (U('u_alphaRef')) gl.uniform1f(U('u_alphaRef'), (this.rs(RS.ALPHAREF, 0) & 0xff) / 255);
    if (U('u_pointSize')) gl.uniform1f(U('u_pointSize'), this.rsF(RS.POINTSIZE) || 1);
    if (U('u_c[0]')) gl.uniform4fv(U('u_c[0]'), info.L.code ? dev.vsConst : dev.psConst);
    if (info.L.code && dev.pixelShaders.get(dev.pixelShader) && U('u_c[0]')) { /* vs and ps both use u_c: vs consts set above; ps consts below */ }
    for (let i = 0; i < MAX_STAGES; i++) { const l = U(`u_bumpEnv[${i}]`); if (l) gl.uniform4f(l, asFloat(this.tss(i, TSS.BUMPENVMAT00, 0)), asFloat(this.tss(i, TSS.BUMPENVMAT01, 0)), asFloat(this.tss(i, TSS.BUMPENVMAT10, 0)), asFloat(this.tss(i, TSS.BUMPENVMAT11, 0))); }
    // textures + samplers
    for (let i = 0; i < info.stages.length; i++) {
      const st = info.stages[i];
      if (!st.bound) continue;
      const g = this.glTexture(st.tex);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(g.target, g.tex);
      const l = U(st.cube ? `u_cube${i}` : `u_tex${i}`); if (l) gl.uniform1i(l, i);
      const smp = this.samplers[i];
      const wrap = (m) => (m === 2 ? gl.MIRRORED_REPEAT : m === 3 || m === 4 || m === 5 ? gl.CLAMP_TO_EDGE : gl.REPEAT);
      gl.samplerParameteri(smp, gl.TEXTURE_WRAP_S, wrap(this.tss(i, TSS.ADDRESSU, 1)));
      gl.samplerParameteri(smp, gl.TEXTURE_WRAP_T, wrap(this.tss(i, TSS.ADDRESSV, 1)));
      gl.samplerParameteri(smp, gl.TEXTURE_WRAP_R, wrap(this.tss(i, TSS.ADDRESSW, 1)));
      const mag = this.tss(i, TSS.MAGFILTER, 1), min = this.tss(i, TSS.MINFILTER, 1), mip = this.tss(i, TSS.MIPFILTER, 0);
      const levels = st.cube ? st.tex.faces[0].length : st.tex.levels.length;
      gl.samplerParameteri(smp, gl.TEXTURE_MAG_FILTER, mag >= 2 ? gl.LINEAR : gl.NEAREST);
      const minF = levels > 1 && mip ? (min >= 2 ? (mip >= 2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST) : (mip >= 2 ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST)) : (min >= 2 ? gl.LINEAR : gl.NEAREST);
      gl.samplerParameteri(smp, gl.TEXTURE_MIN_FILTER, minF);
      if (this.aniso) gl.samplerParameterf(smp, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, min === 3 || mag === 3 ? Math.max(1, Math.min(16, this.tss(i, TSS.MAXANISOTROPY, 1))) : 1);
      gl.samplerParameterf(smp, gl.TEXTURE_MAX_LOD, levels > 1 ? Math.max(0, levels - 1 - this.tss(i, TSS.MAXMIPLEVEL, 0)) : 0);
      gl.bindSampler(i, smp);
    }
    // depth / stencil
    const zenable = this.rs(RS.ZENABLE, 1);
    if (zenable) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(this.cmp(this.rs(RS.ZFUNC, 4))); } else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(this.rs(RS.ZWRITEENABLE, 1) !== 0);
    const zbias = this.rs(RS.ZBIAS, 0);
    if (zbias) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(0, -zbias); } else gl.disable(gl.POLYGON_OFFSET_FILL);
    if (this.rs(RS.STENCILENABLE, 0)) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(this.cmp(this.rs(RS.STENCILFUNC, 8)), this.rs(RS.STENCILREF, 0), this.rs(RS.STENCILMASK, 0xffffffff));
      gl.stencilOp(this.stencilOp(this.rs(RS.STENCILFAIL, 1)), this.stencilOp(this.rs(RS.STENCILZFAIL, 1)), this.stencilOp(this.rs(RS.STENCILPASS, 1)));
      gl.stencilMask(this.rs(RS.STENCILWRITEMASK, 0xffffffff));
    } else gl.disable(gl.STENCIL_TEST);
    // blending
    if (this.rs(RS.ALPHABLENDENABLE, 0)) {
      gl.enable(gl.BLEND);
      let src = this.rs(RS.SRCBLEND, 2), dst = this.rs(RS.DESTBLEND, 1);
      if (src === 12) { src = 5; dst = 6; } else if (src === 13) { src = 6; dst = 5; }
      gl.blendFunc(this.blend(src), this.blend(dst));
      gl.blendEquation([gl.FUNC_ADD, gl.FUNC_ADD, gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT, gl.MIN, gl.MAX][this.rs(RS.BLENDOP, 1)] ?? gl.FUNC_ADD);
    } else gl.disable(gl.BLEND);
    const cw = this.rs(RS.COLORWRITEENABLE, 0xf);
    gl.colorMask((cw & 1) !== 0, (cw & 2) !== 0, (cw & 4) !== 0, (cw & 8) !== 0);
    // culling (the y flip in the shaders mirrors the winding)
    const cull = this.rs(RS.CULLMODE, 3);
    if (cull === 1 || info.L.layout.rhw && false) gl.disable(gl.CULL_FACE);
    else { gl.enable(gl.CULL_FACE); gl.frontFace(gl.CCW); gl.cullFace(cull === 2 ? gl.FRONT : gl.BACK); }
    void w;
  }
  cmp(f) { const gl = this.gl; return [gl.ALWAYS, gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS][f] ?? gl.ALWAYS; }
  stencilOp(o) { const gl = this.gl; return [gl.KEEP, gl.KEEP, gl.ZERO, gl.REPLACE, gl.INCR, gl.DECR, gl.INVERT, gl.INCR_WRAP, gl.DECR_WRAP][o] ?? gl.KEEP; }
  blend(b) { const gl = this.gl; return [gl.ZERO, gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA_SATURATE][b] ?? gl.ONE; }

  /** Bind vertex attributes for the current layout from the device's streams (or a UP buffer). */
  bindAttributes(P, L, up = null, baseVertex = 0) {
    const gl = this.gl, dev = this.dev;
    const attrType = (a) => (a.type === 'color' ? gl.UNSIGNED_BYTE : a.type === 'ubyte4' ? gl.UNSIGNED_BYTE : a.type === 'short' ? gl.SHORT : gl.FLOAT);
    const enable = (loc, a, stride, offset) => { if (loc < 0) return; gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, a.comps, attrType(a), a.type === 'color', stride, offset); };
    const used = new Set();
    if (L.layout.attrs) { // FVF
      const s = up ?? dev.streams[0];
      const stride = up ? up.stride : (s.stride || L.layout.stride);
      if (!up) { const vb = this.comImpl(s.vb); if (!vb) return false; gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer(vb, 'vb').buf); }
      else gl.bindBuffer(gl.ARRAY_BUFFER, this.upVbo);
      L.layout.attrs.forEach((a) => { const loc = P.attrNames.indexOf('a_' + a.name); enable(loc, a, stride, a.offset + baseVertex * stride); used.add(loc); });
    } else {
      for (const [n, st] of L.layout.streams) {
        const s = up ?? dev.streams[n];
        if (!up) { const vb = this.comImpl(s.vb); if (!vb) continue; gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer(vb, 'vb').buf); }
        else gl.bindBuffer(gl.ARRAY_BUFFER, this.upVbo);
        const stride = up ? up.stride : (s.stride || st.stride);
        st.attrs.forEach((a) => { const loc = P.attrNames.indexOf(L.code ? 'a_v' + a.reg : 'a_' + a.name); enable(loc, a, stride, a.offset + baseVertex * stride); used.add(loc); });
      }
    }
    for (let i = 0; i < 16; i++) if (!used.has(i)) gl.disableVertexAttribArray(i);
    return true;
  }
  glMode(type) { const gl = this.gl; return [0, gl.POINTS, gl.LINES, gl.LINE_STRIP, gl.TRIANGLES, gl.TRIANGLE_STRIP, gl.TRIANGLE_FAN][type] ?? gl.TRIANGLES; }
  vertexCount(type, prims) { switch (type) { case PT.POINTLIST: return prims; case PT.LINELIST: return prims * 2; case PT.LINESTRIP: return prims + 1; case PT.TRIANGLELIST: return prims * 3; default: return prims + 2; } }

  drawPrimitive(type, start, count) {
    const gl = this.gl;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    if (!this.bindAttributes(P, info.L)) return;
    gl.drawArrays(this.glMode(type), start, this.vertexCount(type, count));
    this.stats.draws++; this.frameDraws++;
  }
  drawIndexedPrimitive(type, minIdx, numV, start, count) {
    const gl = this.gl, dev = this.dev;
    const ib = this.comImpl(dev.indices.ib); if (!ib) return;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    if (!this.bindAttributes(P, info.L, null, dev.indices.base)) return;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.glBuffer(ib, 'ib').buf);
    const short = ib.fmt === FMT.INDEX16;
    gl.drawElements(this.glMode(type), this.vertexCount(type, count), short ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, start * (short ? 2 : 4));
    this.stats.draws++; this.frameDraws++;
    void minIdx; void numV;
  }
  drawPrimitiveUP(type, count, data, stride) {
    const gl = this.gl;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    const n = this.vertexCount(type, count);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.mem.bytes(data, n * stride), gl.STREAM_DRAW);
    if (!this.bindAttributes(P, info.L, { stride })) return;
    gl.drawArrays(this.glMode(type), 0, n);
    this.stats.draws++; this.frameDraws++;
  }
  drawIndexedPrimitiveUP(type, minIdx, numV, count, idx, ifmt, data, stride) {
    const gl = this.gl;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    const n = this.vertexCount(type, count);
    const short = ifmt === FMT.INDEX16;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.mem.bytes(data, (minIdx + numV) * stride), gl.STREAM_DRAW);
    if (!this.bindAttributes(P, info.L, { stride })) return;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.upIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mem.bytes(idx, n * (short ? 2 : 4)), gl.STREAM_DRAW);
    gl.drawElements(this.glMode(type), n, short ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, 0);
    this.stats.draws++; this.frameDraws++;
  }
}

/** Host-side factory: `host.gfx = createWebGLBackend(canvas, log)`. */
export function createWebGLBackend(canvas, log) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, stencil: true, preserveDrawingBuffer: true, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  return {
    gl,
    createDevice(dev) { dev.com = dev.proc?.vm?.com ?? dev.com; return new WebGLDevice(gl, dev, { log }); },
  };
}
