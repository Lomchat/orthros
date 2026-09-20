// Direct3D 8/9 backend on WebGL2. Resources live in guest memory (see win32/d3d8.js and
// win32/d3d9.js); this module mirrors them into GL objects lazily (uploads on Unlock/dirty),
// builds fixed-function or translated shader programs from the device state at draw time, and
// maps render states, texture stage / sampler states, blending, depth/stencil, fog, scissor and
// viewport onto GL. DX8 and DX9 devices share the state model; DX9 adds vertex declarations,
// sampler states, shader objects (SM 1.x–2.x), stream offsets, base vertices, MRT/scissor.
import { FMT, surfacePitch, surfaceBytes } from '../win32/d3d8.js';
import { fvfLayout, declLayout, ffVertexShader, ffFragmentShader, translateVertexShader, translatePixelShader, RS, TSS, TOP, TS_WORLD, TS_VIEW, TS_PROJECTION, TS_TEXTURE0, MAX_STAGES, MAX_LIGHTS } from './d3d8-shaders.js';
import { translateVertexShader9, translatePixelShader9, semName } from './d3d9-shaders.js';

const D3D_OK = 0;
const PT = { POINTLIST: 1, LINELIST: 2, LINESTRIP: 3, TRIANGLELIST: 4, TRIANGLESTRIP: 5, TRIANGLEFAN: 6 };
const SAMP = { ADDRESSU: 1, ADDRESSV: 2, ADDRESSW: 3, BORDERCOLOR: 4, MAGFILTER: 5, MINFILTER: 6, MIPFILTER: 7, MIPMAPLODBIAS: 8, MAXMIPLEVEL: 9, MAXANISOTROPY: 10, SRGBTEXTURE: 11 };
const SAMP_TO_TSS = { [SAMP.ADDRESSU]: TSS.ADDRESSU, [SAMP.ADDRESSV]: TSS.ADDRESSV, [SAMP.ADDRESSW]: TSS.ADDRESSW, [SAMP.BORDERCOLOR]: TSS.BORDERCOLOR, [SAMP.MAGFILTER]: TSS.MAGFILTER, [SAMP.MINFILTER]: TSS.MINFILTER, [SAMP.MIPFILTER]: TSS.MIPFILTER, [SAMP.MIPMAPLODBIAS]: TSS.MIPMAPLODBIAS, [SAMP.MAXMIPLEVEL]: TSS.MAXMIPLEVEL, [SAMP.MAXANISOTROPY]: TSS.MAXANISOTROPY };
const RS9 = { SCISSORTESTENABLE: 174, SLOPESCALEDEPTHBIAS: 175, TWOSIDEDSTENCILMODE: 185, CCW_STENCILFAIL: 186, CCW_STENCILZFAIL: 187, CCW_STENCILPASS: 188, CCW_STENCILFUNC: 189, BLENDFACTOR: 193, DEPTHBIAS: 195, SEPARATEALPHABLENDENABLE: 206, SRCBLENDALPHA: 207, DESTBLENDALPHA: 208, BLENDOPALPHA: 209 };
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const asFloat = (v) => { u32[0] = v >>> 0; return f32[0]; };
const colorToVec = (c, out = new Float32Array(4)) => { out[0] = ((c >> 16) & 0xff) / 255; out[1] = ((c >> 8) & 0xff) / 255; out[2] = (c & 0xff) / 255; out[3] = ((c >>> 24) & 0xff) / 255; return out; };
const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const isDxt = (f) => f === FMT.DXT1 || f === FMT.DXT2 || f === FMT.DXT3 || f === FMT.DXT4 || f === FMT.DXT5;
/** FVF attribute name -> DX9 semantic name (shaders used together with SetFVF) */
const FVF_SEM = { pos: semName(0, 0), blendweight: semName(1, 0), blendindices: semName(2, 0), normal: semName(3, 0), psize: semName(4, 0), diffuse: semName(10, 0), specular: semName(10, 1) };
for (let i = 0; i < 8; i++) FVF_SEM['tex' + i] = semName(5, i);

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
        const lo = src[p + 2] | (src[p + 3] << 8) | (src[p + 4] << 16), hi = src[p + 5] | (src[p + 6] << 8) | (src[p + 7] << 16);
        for (let i = 0; i < 8; i++) alphas[i] = at[(lo >>> (3 * i)) & 7];
        for (let i = 0; i < 8; i++) alphas[8 + i] = at[(hi >>> (3 * i)) & 7];
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
  let out32 = null;
  for (let y = 0; y < h; y++) {
    let s = addr + y * pitch, o = y * w * 4;
    switch (fmt) {
      case FMT.A8R8G8B8: case FMT.X8R8G8B8: {
        if ((s & 3) === 0) { // whole-pixel swizzle B,G,R,A -> R,G,B,A on 32-bit lanes
          const src = mem.u32, dst = out32 ?? (out32 = new Uint32Array(out.buffer)); const alpha = fmt === FMT.X8R8G8B8 ? 0xff000000 : 0;
          for (let x = 0, si = s >> 2, oi = o >> 2; x < w; x++, si++, oi++) { const p = src[si]; dst[oi] = ((p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff) | alpha) >>> 0; }
        } else for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = fmt === FMT.X8R8G8B8 ? 255 : u8[s + 3]; }
        break;
      }
      case FMT.A8B8G8R8: case 33: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s + 2]; out[o + 3] = fmt === 33 ? 255 : u8[s + 3]; } break;
      case FMT.R8G8B8: for (let x = 0; x < w; x++, s += 3, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; } break;
      case FMT.R5G6B5: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 11) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 63) * 255 / 63 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = 255; } break;
      case FMT.X1R5G5B5: case FMT.A1R5G5B5: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 10) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 31) * 255 / 31 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = fmt === FMT.A1R5G5B5 ? (v & 0x8000 ? 255 : 0) : 255; } break;
      case FMT.A4R4G4B4: case FMT.X4R4G4B4: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 8) & 15) * 17; out[o + 1] = ((v >> 4) & 15) * 17; out[o + 2] = (v & 15) * 17; out[o + 3] = fmt === FMT.A4R4G4B4 ? ((v >> 12) & 15) * 17 : 255; } break;
      case FMT.A8: for (let x = 0; x < w; x++, s++, o += 4) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = u8[s]; } break;
      case FMT.L8: case FMT.P8: for (let x = 0; x < w; x++, s++, o += 4) { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = 255; } break;
      case 81: for (let x = 0; x < w; x++, s += 2, o += 4) { out[o] = out[o + 1] = out[o + 2] = u8[s + 1]; out[o + 3] = 255; } break; // L16
      case FMT.A8L8: for (let x = 0; x < w; x++, s += 2, o += 4) { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = u8[s + 1]; } break;
      case FMT.A4L4: for (let x = 0; x < w; x++, s++, o += 4) { const l = (u8[s] & 15) * 17; out[o] = out[o + 1] = out[o + 2] = l; out[o + 3] = (u8[s] >> 4) * 17; } break;
      case FMT.V8U8: for (let x = 0; x < w; x++, s += 2, o += 4) { out[o] = (u8[s] + 128) & 0xff; out[o + 1] = (u8[s + 1] + 128) & 0xff; out[o + 2] = 255; out[o + 3] = 255; } break;
      case FMT.Q8W8V8U8: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = (u8[s] + 128) & 0xff; out[o + 1] = (u8[s + 1] + 128) & 0xff; out[o + 2] = (u8[s + 2] + 128) & 0xff; out[o + 3] = (u8[s + 3] + 128) & 0xff; } break;
      case FMT.V16U16: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = (u8[s + 1] + 128) & 0xff; out[o + 1] = (u8[s + 3] + 128) & 0xff; out[o + 2] = 255; out[o + 3] = 255; } break;
      case FMT.G16R16: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s + 1]; out[o + 1] = u8[s + 3]; out[o + 2] = 0; out[o + 3] = 255; } break;
      case FMT.A2B10G10R10: case FMT.A2R10G10B10: for (let x = 0; x < w; x++, s += 4, o += 4) { const v = u8[s] | (u8[s + 1] << 8) | (u8[s + 2] << 16) | (u8[s + 3] << 24); const r = (v & 1023) >> 2, g = ((v >> 10) & 1023) >> 2, b = ((v >> 20) & 1023) >> 2, a = ((v >>> 30) & 3) * 85; if (fmt === FMT.A2B10G10R10) { out[o] = r; out[o + 2] = b; } else { out[o] = b; out[o + 2] = r; } out[o + 1] = g; out[o + 3] = a; } break;
      default: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; }
    }
  }
  return out;
}

// constant uniform names (template strings built per draw would defeat the location cache)
const names = (p, n) => Array.from({ length: n }, (_, i) => `${p}[${i}]`);
const LIGHT_U = Array.from({ length: 8 }, (_, n) => Object.fromEntries(['type', 'diffuse', 'specular', 'ambient', 'position', 'direction', 'range', 'falloff', 'atten', 'theta', 'phi'].map((k) => [k, `u_lights[${n}].${k}`])));
const TEX_U = { tex: names('u_tex', 16).map((x) => x.replace(/\[(\d+)\]$/, '$1')), cube: names('u_cube', 16).map((x) => x.replace(/\[(\d+)\]$/, '$1')), vol: names('u_vol', 16).map((x) => x.replace(/\[(\d+)\]$/, '$1')) };
let blendOpsCache = null; const BLEND_OPS = (gl) => blendOpsCache ?? (blendOpsCache = [gl.FUNC_ADD, gl.FUNC_ADD, gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT, gl.MIN, gl.MAX]);
const U_WORLD = names('u_world', 4), U_TEXMAT = names('u_texmat', 8), U_VCB = names('u_vcb', 16), U_PCB = names('u_pcb', 16), U_BUMPENV = names('u_bumpEnv', 8);

export class WebGLDevice {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {any} dev the d3d8.js / d3d9.js Device
   * @param {{ log?: (m: string) => void }} [opts]
   */
  constructor(gl, dev, opts = {}) {
    this.gl = gl; this.dev = dev; this.mem = dev.proc.mem;
    this.log = opts.log ?? (() => {});
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    if (opts.log) opts.log(`d3d-webgl: ${gl.getParameter(gl.RENDERER)} | s3tc ${this.s3tc ? 'yes' : 'no (DXT decoded on the CPU)'} | max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`);
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.programs = new Map();
    this.textures = new Map(); // resource id -> { tex, target }
    this.buffers = new Map(); // resource id -> { buf, size }
    this.fbos = new Map(); // surface id -> fbo
    this.samplers = []; for (let i = 0; i < 20; i++) this.samplers.push(gl.createSampler());
    this.samplerState = Array.from({ length: 20 }, () => ({})); // last parameters applied to each sampler object
    this.invalidateGlState();
    this.upVbo = gl.createBuffer(); this.upIbo = gl.createBuffer();
    this.vao = gl.createVertexArray();
    this.stats = { draws: 0, programs: 0, uploads: 0, errors: 0 };
    this.tmp = { v4: new Float32Array(4) };
    this.fvfCache = new Map();
    this.frameDraws = 0;
    this.dumpShaders = !!opts.dumpShaders;
    this.noCull = !!opts.noCull;
    this.captureAt = opts.captureFrame ?? 0; this.frame = 0; this.capturing = false; // one-frame draw dump (like a mini PIX)
    gl.bindVertexArray(this.vao);
    this.reset(dev);
  }
  reset(dev) {
    const gl = this.gl;
    this.dev = dev;
    const c = gl.canvas;
    if (c.width !== dev.pp.width || c.height !== dev.pp.height) { c.width = dev.pp.width; c.height = dev.pp.height; }
    for (const f of this.fbos.values()) { gl.deleteFramebuffer(f.fbo); if (f.depth) gl.deleteRenderbuffer(f.depth); if (f.color) gl.deleteRenderbuffer(f.color); }
    this.fbos.clear();
    this.invalidateGlState();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, dev.pp.width, dev.pp.height);
    gl.colorMask(true, true, true, true); gl.depthMask(true); gl.stencilMask(0xff);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }
  destroy() { const gl = this.gl; for (const t of this.textures.values()) gl.deleteTexture(t.tex); for (const b of this.buffers.values()) gl.deleteBuffer(b.buf); for (const f of this.fbos.values()) { gl.deleteFramebuffer(f.fbo); if (f.depth) gl.deleteRenderbuffer(f.depth); if (f.color) gl.deleteRenderbuffer(f.color); } for (const p of this.programs.values()) gl.deleteProgram(p.prog); }

  // ---------------------------------------------------------------- resources
  createTexture() {} createBuffer() {} createSurface() {} surfaceUpdated() {} volumeUpdated() {}
  /** A locked range was written: remember the union of dirty bytes so the upload can be partial. */
  bufferUpdated(b, start = 0, size = b.length) {
    const end = Math.min(b.length, start + size);
    if (!b.dirtyRange) b.dirtyRange = [start, end]; else { if (start < b.dirtyRange[0]) b.dirtyRange[0] = start; if (end > b.dirtyRange[1]) b.dirtyRange[1] = end; }
    b.dirty = true;
  }
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
    const cube = !!t.faces, volume = !!t.depth;
    const target = cube ? gl.TEXTURE_CUBE_MAP : volume ? gl.TEXTURE_3D : gl.TEXTURE_2D;
    let g = this.textures.get(t.id);
    if (!g) { g = { tex: gl.createTexture(), target }; this.textures.set(t.id, g); gl.bindTexture(target, g.tex); gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, (cube ? t.faces[0].length : t.levels?.length ?? 1) - 1); }
    if (volume) {
      for (let i = 0; i < t.levels.length; i++) { const l = t.levels[i]; if (l.uploaded && !l.dirty) continue; gl.bindTexture(target, g.tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); const data = l.mem ? this.volumeToRgba(t.fmt, l) : null; gl.texImage3D(target, i, gl.RGBA8, l.width, l.height, l.depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, data); l.uploaded = true; l.dirty = false; this.stats.uploads++; }
      return g;
    }
    const faces = cube ? t.faces : [t.levels ?? []];
    let bound = false;
    for (let f = 0; f < faces.length; f++) {
      const lv = faces[f];
      for (let i = 0; i < lv.length; i++) {
        const s = lv[i];
        if (!s.dirty && s.uploaded) continue;
        if (!bound) { gl.bindTexture(target, g.tex); bound = true; }
        this.uploadLevel(cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + f : gl.TEXTURE_2D, i, s);
        s.dirty = false; s.uploaded = true;
      }
    }
    return g;
  }
  volumeToRgba(fmt, l) { const out = new Uint8Array(l.width * l.height * l.depth * 4); for (let z = 0; z < l.depth; z++) out.set(surfaceToRgba(this.mem, fmt, l.mem + z * l.slice, l.width, l.height, l.pitch), z * l.width * l.height * 4); return out; }
  uploadLevel(target, level, s) {
    const gl = this.gl;
    this.stats.uploads++;
    if (!s.mem) { gl.texImage2D(target, level, gl.RGBA8, s.width, s.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); return; }
    if (level === 0 && s.width * s.height <= 65536 && (this.placeholderLogs ?? 0) < 8) this.checkPlaceholder(s);
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
  /** Diagnostic: flag textures that look like an engine's "missing texture" placeholder (mostly magenta). */
  checkPlaceholder(s) {
    const rgba = surfaceToRgba(this.mem, s.fmt, s.mem, s.width, s.height, s.pitch);
    let magenta = 0; const n = s.width * s.height;
    for (let i = 0; i < n * 4; i += 4) if (rgba[i] > 200 && rgba[i + 1] < 80 && rgba[i + 2] > 200) magenta++;
    if (magenta < n * 0.3) return;
    this.placeholderLogs = (this.placeholderLogs ?? 0) + 1;
    const t = s.owner;
    this.log(`d3d-webgl: placeholder-looking texture #${t?.id ?? s.id} ${s.width}x${s.height} fmt ${s.fmt} (${Math.round(magenta * 100 / n)}% magenta) levels ${t?.levels?.length} usage 0x${(t?.usage ?? 0).toString(16)} pool ${t?.pool} locks ${t?.lockCount ?? 0} updated ${t?.updatedFrom ? 'yes' : 'no'} created at ${t?.origin ?? '?'}${t?.apiTrail ? '\n  API calls before creation:\n  ' + t.apiTrail.join('\n  ') : ''}`);
  }
  glBuffer(b, kind) {
    const gl = this.gl;
    let g = this.buffers.get(b.id);
    const target = kind === 'ib' ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    if (!g) { g = { buf: gl.createBuffer(), size: 0 }; this.buffers.set(b.id, g); b.dirty = true; }
    if (b.dirty) {
      gl.bindBuffer(target, g.buf);
      if (g.size !== b.length) { gl.bufferData(target, this.mem.bytes(b.mem, b.length), b.usage & 0x200 ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW); g.size = b.length; }
      else { const [s, e] = b.dirtyRange ?? [0, b.length]; if (e > s) gl.bufferSubData(target, s, this.mem.bytes(b.mem + s, e - s)); }
      b.dirty = false; b.dirtyRange = null; this.stats.uploads++;
    }
    return g;
  }

  // ---------------------------------------------------------------- render targets
  /**
   * Bind the current render target. Every target is a framebuffer object, including the back buffers: the
   * default framebuffer only ever receives complete frames (blitted by present), so a worker yield in the
   * middle of a frame never shows a partially drawn picture. Back buffers keep the screen orientation
   * (GL rows bottom-up); texture targets are rendered y-flipped (`flip`) so their rows match D3D order.
   */
  bindTarget() {
    const gl = this.gl, dev = this.dev;
    const rt = dev.renderTarget ?? dev.backBuffers[0];
    const back = dev.backBuffers.includes(rt);
    let f = this.fbos.get(rt.id);
    if (!f) {
      f = { fbo: gl.createFramebuffer(), w: rt.width, h: rt.height, depth: null, color: null, back };
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      if (rt.owner && (rt.owner.levels || rt.owner.faces)) {
        const g = this.glTexture(rt.owner);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, rt.owner.faces ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + rt.face : gl.TEXTURE_2D, g.tex, rt.level);
      } else {
        f.color = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, f.color); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, rt.width, rt.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, f.color);
      }
      f.depth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, f.depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, rt.width, rt.height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, f.depth);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) this.log(`d3d-webgl: render target FBO incomplete (${status})`);
      if (this.fbos.size < 4) this.log(`d3d-webgl: render target ${rt.width}x${rt.height} fmt ${rt.fmt} ${back ? 'back buffer' : rt.owner ? 'texture level ' + rt.level : 'surface'}`);
      this.fbos.set(rt.id, f);
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    return { w: f.w, h: f.h, flip: !back };
  }
  setRenderTarget() {}
  readbackSurface(s) {
    const gl = this.gl, dev = this.dev;
    const prev = dev.renderTarget; dev.renderTarget = s;
    const { w, h, flip } = this.bindTarget();
    const rgba = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    dev.renderTarget = prev;
    const base = s.ensureMem(dev.proc), u8 = this.mem.u8;
    for (let y = 0; y < h; y++) { const src = (flip ? y : h - 1 - y) * w * 4; /* texture targets are rendered y-flipped (rows match D3D); back buffers are bottom-up */ let o = base + y * s.pitch; for (let x = 0; x < w; x++, o += 4) { const i = src + x * 4; u8[o] = rgba[i + 2]; u8[o + 1] = rgba[i + 1]; u8[o + 2] = rgba[i]; u8[o + 3] = rgba[i + 3]; } }
  }
  readbackFrontBuffer(s) { const b = this.dev.backBuffers[0]; this.readbackSurface(b); if (b.mem && b.fmt === s.fmt) this.mem.copy(s.ensureMem(this.dev.proc), b.mem, Math.min(b.bytes, s.bytes)); }
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
  present() {
    const gl = this.gl, dev = this.dev;
    const prev = dev.renderTarget; dev.renderTarget = dev.backBuffers[0];
    const { w, h } = this.bindTarget();
    dev.renderTarget = prev;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST); this.gs.en[gl.SCISSOR_TEST] = false;
    gl.blitFramebuffer(0, 0, w, h, 0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.COLOR_BUFFER_BIT, w === gl.drawingBufferWidth && h === gl.drawingBufferHeight ? gl.NEAREST : gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (dev.backBuffers.length > 1 && dev.pp.swap !== 3) { // flipping chain: rotate the contents, not the surfaces
      const ids = dev.backBuffers.map((b) => b.id), first = this.fbos.get(ids[0]);
      for (let i = 0; i < ids.length - 1; i++) { const f = this.fbos.get(ids[i + 1]); if (f) this.fbos.set(ids[i], f); else this.fbos.delete(ids[i]); }
      if (first) this.fbos.set(ids[ids.length - 1], first); else this.fbos.delete(ids[ids.length - 1]);
    }
    gl.flush(); this.frame++; if (this.capturing) { this.capturing = false; this.log(`d3d-webgl: capture end (${this.frameDraws} draws)`); } if (this.captureAt && this.frame === this.captureAt) { this.capturing = true; this.log(`d3d-webgl: capture frame ${this.frame}`); } }
  clear(n, rects, flags, color, z, stencil) {
    const gl = this.gl, dev = this.dev;
    if (this.capturing) this.log(`d3d-webgl: [cap] clear flags ${flags} color ${(color >>> 0).toString(16)} z ${z} target ${dev.backBuffers.includes(dev.renderTarget) ? 'screen' : 'FBO'}`);
    const { h, flip } = this.bindTarget();
    const v = dev.viewport;
    const gy = (y, hh) => (flip ? y : h - y - hh);
    this.invalidateGlState(); // masks/scissor are set directly below
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(v.x, gy(v.y, v.h), v.w, v.h);
    let mask = 0;
    if (flags & 1) { const c = colorToVec(color, this.tmp.v4); gl.colorMask(true, true, true, true); gl.clearColor(c[0], c[1], c[2], c[3]); mask |= gl.COLOR_BUFFER_BIT; }
    if (flags & 2) { gl.depthMask(true); gl.clearDepth(z); mask |= gl.DEPTH_BUFFER_BIT; }
    if (flags & 4) { gl.stencilMask(0xff); gl.clearStencil(stencil); mask |= gl.STENCIL_BUFFER_BIT; }
    if (n && rects) { const mem = this.mem; for (let i = 0; i < n; i++) { const r = rects + 16 * i; const l = mem.readS32(r), t = mem.readS32(r + 4), rr = mem.readS32(r + 8), b = mem.readS32(r + 12); gl.scissor(l, gy(t, b - t), rr - l, b - t); gl.clear(mask); } }
    else gl.clear(mask);
    gl.disable(gl.SCISSOR_TEST);
  }
  setTransform() {} setViewport() {} setMaterial() {} setLight() {} lightEnable() {} setClipPlane() {} setRenderState() {} setTexture() {} setTextureStageState() {} setSamplerState() {}
  createVertexShader() {} setVertexShader() {} setVertexShaderConstant() {} setStreamSource() {} setIndices() {} createPixelShader() {} setPixelShader() {} setPixelShaderConstant() {}
  deleteVertexShader(sh) { for (const [k, p] of this.programs) if (p.vs === sh) { this.gl.deleteProgram(p.prog); this.programs.delete(k); } }
  deletePixelShader(sh) { for (const [k, p] of this.programs) if (p.ps === sh) { this.gl.deleteProgram(p.prog); this.programs.delete(k); } }
  setCursor() {} setGamma() {}

  // ---------------------------------------------------------------- state access
  rsF(s) { return asFloat(this.dev.rs.get(s) ?? 0); }
  rs(s, d = 0) { return this.dev.rs.get(s) ?? d; }
  tss(st, t, d = 0) { return this.dev.tss[st]?.get(t) ?? d; }
  /** sampler state: DX9 sampler states, or the DX8 texture stage equivalents */
  samp(i, type, d = 0) { if (this.dev.api9) return this.dev.samplers[i]?.get(type) ?? d; const t = SAMP_TO_TSS[type]; return t !== undefined ? this.tss(i, t, d) : d; }
  comImpl(ptr) { return ptr ? this.dev.com.implAt(ptr) : null; }
  /** current vertex layout + programmable vertex shader (if any) */
  currentLayout() {
    const dev = this.dev;
    if (dev.api9) {
      const layout = dev.vertexDecl?.layout ?? this.fvf(dev.fvf);
      return { layout, code: dev.vsObj ? dev.vsObj.code : null, shader: dev.vsObj, dx9: true };
    }
    const sh = dev.vertexShaders.get(dev.vertexShader);
    if (sh) { if (!sh.layout) sh.layout = declLayout(sh.decl); return { layout: sh.layout, code: sh.code, shader: sh, dx9: false }; }
    return { layout: this.fvf(dev.vertexShader), code: null, shader: null, dx9: false };
  }
  fvf(f) { let l = this.fvfCache.get(f); if (!l) { l = fvfLayout(f); this.fvfCache.set(f, l); } return l; }
  stageInfo(i) {
    const dev = this.dev, texPtr = dev.textures[i];
    const tex = texPtr ? this.comImpl(texPtr) : null;
    return { tex, cube: !!tex?.faces, volume: !!tex?.depth, bound: !!tex, tci: this.tss(i, TSS.TEXCOORDINDEX, i), ttff: this.tss(i, TSS.TEXTURETRANSFORMFLAGS, 0) };
  }

  // ---------------------------------------------------------------- programs
  program() {
    const dev = this.dev;
    if (this.lastProgram && this.lastProgramVersion === dev.stateVersion && this.lastProgramDev === dev) return this.lastProgram; // nothing that feeds the key changed since the last draw
    const r = this.programUncached();
    this.lastProgram = r; this.lastProgramVersion = dev.stateVersion; this.lastProgramDev = dev;
    return r;
  }
  programUncached() {
    const dev = this.dev;
    const L = this.currentLayout();
    const rhw = !!L.layout.rhw;
    const lighting = this.rs(RS.LIGHTING, 1) !== 0 && !rhw && !L.code;
    const fogEnable = this.rs(RS.FOGENABLE, 0) !== 0;
    const tableMode = this.rs(RS.FOGTABLEMODE, 0), vertexMode = this.rs(RS.FOGVERTEXMODE, 0);
    const fog = !fogEnable ? 0 : tableMode ? tableMode : vertexMode || rhw || L.code ? -1 : 0;
    const ps = dev.api9 ? dev.psObj : dev.pixelShaders.get(dev.pixelShader);
    const stages = [];
    const nStages = ps && dev.api9 ? 16 : MAX_STAGES;
    for (let i = 0; i < nStages; i++) {
      const info = this.stageInfo(i);
      const colorOp = i < MAX_STAGES ? this.tss(i, TSS.COLOROP, i === 0 ? TOP.MODULATE : TOP.DISABLE) : TOP.DISABLE;
      stages.push({ colorOp, colorArg1: this.tss(i, TSS.COLORARG1, 2), colorArg2: this.tss(i, TSS.COLORARG2, 1), colorArg0: this.tss(i, TSS.COLORARG0, 1), alphaOp: this.tss(i, TSS.ALPHAOP, i === 0 ? TOP.SELECTARG1 : TOP.DISABLE), alphaArg1: this.tss(i, TSS.ALPHAARG1, 2), alphaArg2: this.tss(i, TSS.ALPHAARG2, 1), alphaArg0: this.tss(i, TSS.ALPHAARG0, 1), resultTemp: this.tss(i, TSS.RESULTARG, 1) === 5, cube: info.cube, volume: info.volume, projected: (info.ttff & 0x100) !== 0, bound: info.bound, tex: info.tex, tci: info.tci, ttff: info.ttff });
      if (!ps && colorOp === TOP.DISABLE) break;
    }
    const lightTypes = [];
    if (lighting) for (const i of [...dev.lightEnabled].sort((a, b) => a - b)) { const l = dev.lights.get(i); if (l) lightTypes.push(l[0] | 0); }
    const layoutKey = L.layout.dx9 ? 'd' + [...L.layout.streams.entries()].map(([n, s]) => n + ':' + s.attrs.map((a) => a.name + '@' + a.offset + a.type + a.comps).join(',')).join('|') : 'f' + (dev.api9 ? dev.fvf : dev.vertexShader);
    const vsKey = L.code ? `vs${L.dx9 ? 9 : 8}:${L.shader.handle}:${layoutKey}` : `ff:${layoutKey}:${lighting ? 1 : 0}:${lightTypes.join(',')}:${this.rs(RS.COLORVERTEX, 1)}:${this.rs(RS.DIFFUSEMATERIALSOURCE, 1)}:${this.rs(RS.SPECULARMATERIALSOURCE, 2)}:${this.rs(RS.AMBIENTMATERIALSOURCE, 0)}:${this.rs(RS.EMISSIVEMATERIALSOURCE, 0)}:${this.rs(RS.SPECULARENABLE, 0)}:${this.rs(RS.LOCALVIEWER, 1)}:${fog === -1 ? vertexMode : 0}:${this.rs(RS.RANGEFOGENABLE, 0)}:${stages.map((s) => `${s.tci}/${s.ttff}`).join(',')}:${this.rs(RS.VERTEXBLEND, 0)}`;
    const fsKey = ps ? `ps${dev.api9 ? 9 : 8}:${ps.handle}:${stages.map((s) => (s.cube ? 'c' : s.volume ? 'v' : s.projected ? 'p' : 't')).join('')}:${fog}` : `ff:${stages.map((s) => `${s.colorOp},${s.colorArg1},${s.colorArg2},${s.colorArg0},${s.alphaOp},${s.alphaArg1},${s.alphaArg2},${s.alphaArg0},${s.resultTemp ? 1 : 0},${s.cube ? 1 : 0},${s.projected ? 1 : 0},${s.bound ? 1 : 0}`).join(';')}:${this.rs(RS.ALPHATESTENABLE, 0) ? this.rs(RS.ALPHAFUNC, 8) : 0}:${this.rs(RS.SPECULARENABLE, 0)}:${fog}`;
    const key = vsKey + '|' + fsKey;
    let p = this.programs.get(key);
    if (p) return { p, L, stages, lighting, fog, lightTypes, ps };
    let vsSrc, attrNames;
    if (L.code && L.dx9) { const t = translateVertexShader9(L.code); vsSrc = t.glsl; attrNames = [...t.inputs.values()].map((n) => 'a_' + n); }
    else if (L.code) { vsSrc = translateVertexShader(L.code, L.layout); attrNames = [...new Set([...L.layout.streams.values()].flatMap((s) => s.attrs.map((a) => 'a_v' + a.reg)))]; }
    else {
      vsSrc = ffVertexShader({ layout: L.layout, lighting, lights: lightTypes, colorVertex: this.rs(RS.COLORVERTEX, 1) !== 0, diffuseSrc: this.rs(RS.DIFFUSEMATERIALSOURCE, 1), specularSrc: this.rs(RS.SPECULARMATERIALSOURCE, 2), ambientSrc: this.rs(RS.AMBIENTMATERIALSOURCE, 0), emissiveSrc: this.rs(RS.EMISSIVEMATERIALSOURCE, 0), specularEnable: this.rs(RS.SPECULARENABLE, 0) !== 0, localViewer: this.rs(RS.LOCALVIEWER, 1) !== 0, normalize: this.rs(RS.NORMALIZENORMALS, 0) !== 0, fogVertex: fog === -1 && !rhw ? vertexMode : 0, rangeFog: this.rs(RS.RANGEFOGENABLE, 0) !== 0, stages, rhw, blend: this.rs(RS.VERTEXBLEND, 0) ? (L.layout.blend || 1) + 1 : 0, pointSize: true });
      attrNames = L.layout.attrs.map((a) => 'a_' + a.name);
    }
    const env = { cube: stages.map((s) => s.cube), volume: stages.map((s) => s.volume), projected: stages.map((s) => s.projected), fog };
    const fsSrc = ps ? (dev.api9 ? translatePixelShader9(ps.code, env).glsl : translatePixelShader(ps.code, env)) : ffFragmentShader({ stages, alphaTest: this.rs(RS.ALPHATESTENABLE, 0) ? this.rs(RS.ALPHAFUNC, 8) : 0, specular: this.rs(RS.SPECULARENABLE, 0) !== 0, fog });
    p = this.compile(vsSrc, fsSrc, key, attrNames);
    p.vs = L.shader; p.ps = ps;
    if (this.programs.size < 8) this.log(`d3d-webgl: program ${this.programs.size} key=${key.slice(0, 120)} attrs=${attrNames.join(',')}`);
    if (this.dumpShaders && this.programs.size < 64) this.log(`d3d-webgl: program ${this.programs.size} GLSL\nVS\n${vsSrc}\nFS\n${fsSrc}`);
    this.programs.set(key, p);
    return { p, L, stages, lighting, fog, lightTypes, ps };
  }
  compile(vsSrc, fsSrc, key, attrNames) {
    const gl = this.gl;
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { this.stats.errors++; this.log(`d3d-webgl: shader compile error: ${gl.getShaderInfoLog(s)}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`); } return s; };
    const prog = gl.createProgram();
    const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    attrNames.forEach((n, i) => gl.bindAttribLocation(prog, i, n));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.stats.errors++; this.log(`d3d-webgl: link error: ${gl.getProgramInfoLog(prog)}`); }
    gl.deleteShader(vs); gl.deleteShader(fs);
    this.stats.programs++;
    const loc = Object.create(null); // uniform name -> location (null when absent), filled from the active uniforms then on demand
    const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) { const info = gl.getActiveUniform(prog, i); loc[info.name] = gl.getUniformLocation(prog, info.name); }
    const u = (name) => { let l = loc[name]; if (l === undefined) { l = gl.getUniformLocation(prog, name); loc[name] = l; } return l; };
    return { prog, u, attrNames, key };
  }

  // ---------------------------------------------------------------- state application
  applyState(P, info) {
    const gl = this.gl, dev = this.dev;
    const { h, flip } = this.bindTarget();
    const v = dev.viewport, gs = this.gs;
    const vy = flip ? v.y : h - v.y - v.h;
    if (gs.vpx !== v.x || gs.vpy !== vy || gs.vpw !== v.w || gs.vph !== v.h) { gl.viewport(v.x, vy, v.w, v.h); gs.vpx = v.x; gs.vpy = vy; gs.vpw = v.w; gs.vph = v.h; }
    if (gs.dzn !== v.minZ || gs.dzf !== v.maxZ) { gl.depthRange(v.minZ, v.maxZ); gs.dzn = v.minZ; gs.dzf = v.maxZ; }
    if (dev.api9 && this.rs(RS9.SCISSORTESTENABLE, 0) && dev.scissor) {
      const sc = dev.scissor, sx = sc.l, sy = flip ? sc.t : h - sc.b, sw = Math.max(0, sc.r - sc.l), sh = Math.max(0, sc.b - sc.t);
      this.glEnable(gl.SCISSOR_TEST, true);
      if (gs.scx !== sx || gs.scy !== sy || gs.scw !== sw || gs.sch !== sh) { gl.scissor(sx, sy, sw, sh); gs.scx = sx; gs.scy = sy; gs.scw = sw; gs.sch = sh; }
    } else this.glEnable(gl.SCISSOR_TEST, false);
    if (gs.prog !== P.prog) { gl.useProgram(P.prog); gs.prog = P.prog; }
    const U = P.u;
    const pv = P.v ?? (P.v = { flip: undefined, t: -1, vp: -1, l: -1, lt: -1, ls: -1, s: -1, c: -1 });
    if (pv.flip !== flip) { pv.flip = flip; if (U('u_flipY')) gl.uniform1f(U('u_flipY'), flip ? -1 : 1); }
    if (this.capturing) this.captureDraw(P, info, v, flip);
    // uniform groups, uploaded only when their source changed since this program last saw it
    if (pv.t !== dev.transformVersion) {
      pv.t = dev.transformVersion;
      for (let i = 0; i < 4; i++) { const l = U(U_WORLD[i]); if (l) gl.uniformMatrix4fv(l, false, dev.transforms.get(TS_WORLD + i) ?? IDENTITY); }
      if (U('u_view')) gl.uniformMatrix4fv(U('u_view'), false, dev.transforms.get(TS_VIEW) ?? IDENTITY);
      if (U('u_proj')) gl.uniformMatrix4fv(U('u_proj'), false, dev.transforms.get(TS_PROJECTION) ?? IDENTITY);
      for (let i = 0; i < MAX_STAGES; i++) { const l = U(U_TEXMAT[i]); if (l) gl.uniformMatrix4fv(l, false, dev.transforms.get(TS_TEXTURE0 + i) ?? IDENTITY); }
    }
    if (pv.vp !== dev.viewportVersion) {
      pv.vp = dev.viewportVersion;
      if (U('u_viewport')) gl.uniform4f(U('u_viewport'), v.x, v.y, v.w, v.h);
      if (U('u_depthRange')) gl.uniform2f(U('u_depthRange'), v.minZ, v.maxZ);
    }
    if (info.lighting && (pv.l !== dev.lightVersion || pv.lt !== dev.transformVersion || pv.ls !== dev.stateVersion)) {
      pv.l = dev.lightVersion; pv.lt = dev.transformVersion; pv.ls = dev.stateVersion;
      const m = dev.material;
      gl.uniform4fv(U('u_matDiffuse'), m.subarray(0, 4)); gl.uniform4fv(U('u_matAmbient'), m.subarray(4, 8)); gl.uniform4fv(U('u_matSpecular'), m.subarray(8, 12)); gl.uniform4fv(U('u_matEmissive'), m.subarray(12, 16)); gl.uniform1f(U('u_matPower'), m[16]);
      gl.uniform4fv(U('u_ambient'), colorToVec(this.rs(RS.AMBIENT, 0), this.tmp.v4));
      let n = 0;
      const view = dev.transforms.get(TS_VIEW) ?? IDENTITY;
      if (this.lightOrderVersion !== dev.lightVersion) { this.lightOrder = [...dev.lightEnabled].sort((a, b) => a - b); this.lightOrderVersion = dev.lightVersion; }
      for (const i of this.lightOrder) {
        const l = dev.lights.get(i); if (!l || n >= MAX_LIGHTS) continue;
        const LU = LIGHT_U[n];
        gl.uniform1i(U(LU.type), l[0] | 0);
        gl.uniform4fv(U(LU.diffuse), l.subarray(1, 5)); gl.uniform4fv(U(LU.specular), l.subarray(5, 9)); gl.uniform4fv(U(LU.ambient), l.subarray(9, 13));
        const px = l[13], py = l[14], pz = l[15];
        gl.uniform3f(U(LU.position), view[0] * px + view[4] * py + view[8] * pz + view[12], view[1] * px + view[5] * py + view[9] * pz + view[13], view[2] * px + view[6] * py + view[10] * pz + view[14]);
        const dx = l[16], dy = l[17], dz = l[18];
        gl.uniform3f(U(LU.direction), view[0] * dx + view[4] * dy + view[8] * dz, view[1] * dx + view[5] * dy + view[9] * dz, view[2] * dx + view[6] * dy + view[10] * dz);
        gl.uniform1f(U(LU.range), l[19]); gl.uniform1f(U(LU.falloff), l[20]);
        gl.uniform3f(U(LU.atten), l[21], l[22], l[23]); gl.uniform1f(U(LU.theta), l[24]); gl.uniform1f(U(LU.phi), l[25]);
        n++;
      }
      gl.uniform1i(U('u_numLights'), n);
    }
    if (pv.s !== dev.stateVersion) {
      pv.s = dev.stateVersion;
      if (U('u_fog')) gl.uniform4f(U('u_fog'), this.rsF(RS.FOGSTART), this.rsF(RS.FOGEND), this.rsF(RS.FOGDENSITY), 0);
      if (U('u_fogParams')) gl.uniform4f(U('u_fogParams'), this.rsF(RS.FOGSTART), this.rsF(RS.FOGEND), this.rsF(RS.FOGDENSITY), 0);
      if (U('u_fogColor')) gl.uniform4fv(U('u_fogColor'), colorToVec(this.rs(RS.FOGCOLOR, 0), this.tmp.v4));
      if (U('u_tfactor')) gl.uniform4fv(U('u_tfactor'), colorToVec(this.rs(RS.TEXTUREFACTOR, 0xffffffff), this.tmp.v4));
      if (U('u_alphaRef')) gl.uniform1f(U('u_alphaRef'), (this.rs(RS.ALPHAREF, 0) & 0xff) / 255);
      if (U('u_pointSize')) gl.uniform1f(U('u_pointSize'), this.rsF(RS.POINTSIZE) || 1);
      for (let i = 0; i < MAX_STAGES; i++) { const l = U(U_BUMPENV[i]); if (l) gl.uniform4f(l, asFloat(this.tss(i, TSS.BUMPENVMAT00, 0)), asFloat(this.tss(i, TSS.BUMPENVMAT01, 0)), asFloat(this.tss(i, TSS.BUMPENVMAT10, 0)), asFloat(this.tss(i, TSS.BUMPENVMAT11, 0))); }
    }
    if (pv.c !== dev.constVersion) {
      pv.c = dev.constVersion;
      // shader constants (vertex and pixel constants have distinct uniform names)
      if (U('u_vc[0]')) gl.uniform4fv(U('u_vc[0]'), dev.vsConst);
      if (U('u_pc[0]')) gl.uniform4fv(U('u_pc[0]'), dev.psConst);
      if (dev.api9) {
        if (U('u_vci[0]')) gl.uniform4iv(U('u_vci[0]'), dev.vsConstI);
        if (U('u_pci[0]')) gl.uniform4iv(U('u_pci[0]'), dev.psConstI);
        for (let i = 0; i < 16; i++) { const a = U(U_VCB[i]); if (a) gl.uniform1i(a, dev.vsConstB[i]); const b = U(U_PCB[i]); if (b) gl.uniform1i(b, dev.psConstB[i]); }
      }
    }
    // textures + samplers
    for (let i = 0; i < info.stages.length; i++) {
      const st = info.stages[i];
      if (!st.bound) continue;
      const l = U(st.cube ? TEX_U.cube[i] : st.volume ? TEX_U.vol[i] : TEX_U.tex[i]);
      if (!l) continue;
      const g = this.glTexture(st.tex);
      if (gs.tex[i] !== g.tex) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(g.target, g.tex); gs.tex[i] = g.tex; }
      if (gs.texUnit[i] !== P.prog) { gl.uniform1i(l, i); gs.texUnit[i] = P.prog; }
      const smp = this.samplers[i], ss = this.samplerState[i];
      const wrap = (m) => (m === 2 ? gl.MIRRORED_REPEAT : m === 3 || m === 4 || m === 5 ? gl.CLAMP_TO_EDGE : gl.REPEAT);
      const ws = wrap(this.samp(i, SAMP.ADDRESSU, 1)), wt = wrap(this.samp(i, SAMP.ADDRESSV, 1)), wr = wrap(this.samp(i, SAMP.ADDRESSW, 1));
      if (ss.ws !== ws) { gl.samplerParameteri(smp, gl.TEXTURE_WRAP_S, ws); ss.ws = ws; }
      if (ss.wt !== wt) { gl.samplerParameteri(smp, gl.TEXTURE_WRAP_T, wt); ss.wt = wt; }
      if (ss.wr !== wr) { gl.samplerParameteri(smp, gl.TEXTURE_WRAP_R, wr); ss.wr = wr; }
      const mag = this.samp(i, SAMP.MAGFILTER, 1), min = this.samp(i, SAMP.MINFILTER, 1), mip = this.samp(i, SAMP.MIPFILTER, 0);
      const levels = st.cube ? st.tex.faces[0].length : st.tex.levels.length;
      const magF = mag >= 2 ? gl.LINEAR : gl.NEAREST;
      if (ss.mag !== magF) { gl.samplerParameteri(smp, gl.TEXTURE_MAG_FILTER, magF); ss.mag = magF; }
      const minF = levels > 1 && mip ? (min >= 2 ? (mip >= 2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST) : (mip >= 2 ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST)) : (min >= 2 ? gl.LINEAR : gl.NEAREST);
      if (ss.min !== minF) { gl.samplerParameteri(smp, gl.TEXTURE_MIN_FILTER, minF); ss.min = minF; }
      if (this.aniso) { const an = min === 3 || mag === 3 ? Math.max(1, Math.min(16, this.samp(i, SAMP.MAXANISOTROPY, 1))) : 1; if (ss.aniso !== an) { gl.samplerParameterf(smp, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, an); ss.aniso = an; } }
      const maxLod = levels > 1 ? Math.max(0, levels - 1 - this.samp(i, SAMP.MAXMIPLEVEL, 0)) : 0;
      if (ss.maxLod !== maxLod) { gl.samplerParameterf(smp, gl.TEXTURE_MAX_LOD, maxLod); ss.maxLod = maxLod; }
      if (gs.smp[i] !== smp) { gl.bindSampler(i, smp); gs.smp[i] = smp; }
    }
    // depth / stencil
    const zEnable = this.rs(RS.ZENABLE, 1) !== 0;
    this.glEnable(gl.DEPTH_TEST, zEnable);
    if (zEnable) { const f = this.cmp(this.rs(RS.ZFUNC, 4)); if (gs.depthFunc !== f) { gl.depthFunc(f); gs.depthFunc = f; } }
    const zw = this.rs(RS.ZWRITEENABLE, 1) !== 0; if (gs.depthMask !== zw) { gl.depthMask(zw); gs.depthMask = zw; }
    const zbias = dev.api9 ? -this.rsF(RS9.DEPTHBIAS) * 2e6 : -this.rs(RS.ZBIAS, 0);
    const slope = dev.api9 ? this.rsF(RS9.SLOPESCALEDEPTHBIAS) : 0;
    this.glEnable(gl.POLYGON_OFFSET_FILL, !!(zbias || slope));
    if ((zbias || slope) && (gs.poSlope !== slope || gs.poBias !== zbias)) { gl.polygonOffset(slope, zbias); gs.poSlope = slope; gs.poBias = zbias; }
    const stencil = this.rs(RS.STENCILENABLE, 0) !== 0;
    this.glEnable(gl.STENCIL_TEST, stencil);
    if (stencil) { // rare: not cached
      const ref = this.rs(RS.STENCILREF, 0), mask = this.rs(RS.STENCILMASK, 0xffffffff);
      if (dev.api9 && this.rs(RS9.TWOSIDEDSTENCILMODE, 0)) {
        // frontFace (below) makes GL front faces the D3D clockwise ones, so the CCW_* states are GL back
        gl.stencilFuncSeparate(gl.FRONT, this.cmp(this.rs(RS.STENCILFUNC, 8)), ref, mask);
        gl.stencilOpSeparate(gl.FRONT, this.stencilOp(this.rs(RS.STENCILFAIL, 1)), this.stencilOp(this.rs(RS.STENCILZFAIL, 1)), this.stencilOp(this.rs(RS.STENCILPASS, 1)));
        gl.stencilFuncSeparate(gl.BACK, this.cmp(this.rs(RS9.CCW_STENCILFUNC, 8)), ref, mask);
        gl.stencilOpSeparate(gl.BACK, this.stencilOp(this.rs(RS9.CCW_STENCILFAIL, 1)), this.stencilOp(this.rs(RS9.CCW_STENCILZFAIL, 1)), this.stencilOp(this.rs(RS9.CCW_STENCILPASS, 1)));
      } else {
        gl.stencilFunc(this.cmp(this.rs(RS.STENCILFUNC, 8)), ref, mask);
        gl.stencilOp(this.stencilOp(this.rs(RS.STENCILFAIL, 1)), this.stencilOp(this.rs(RS.STENCILZFAIL, 1)), this.stencilOp(this.rs(RS.STENCILPASS, 1)));
      }
      gl.stencilMask(this.rs(RS.STENCILWRITEMASK, 0xffffffff)); gs.stencilMask = undefined;
    }
    // blending
    const blend = this.rs(RS.ALPHABLENDENABLE, 0) !== 0;
    this.glEnable(gl.BLEND, blend);
    if (blend) {
      let src = this.rs(RS.SRCBLEND, 2), dst = this.rs(RS.DESTBLEND, 1);
      if (src === 12) { src = 5; dst = 6; } else if (src === 13) { src = 6; dst = 5; }
      const sep = dev.api9 && this.rs(RS9.SEPARATEALPHABLENDENABLE, 0) !== 0;
      const sa = sep ? this.rs(RS9.SRCBLENDALPHA, 2) : src, da = sep ? this.rs(RS9.DESTBLENDALPHA, 1) : dst;
      const bop = this.rs(RS.BLENDOP, 1), bopA = sep ? this.rs(RS9.BLENDOPALPHA, 1) : bop;
      if (gs.bs !== src || gs.bd !== dst || gs.bsa !== sa || gs.bda !== da) { gl.blendFuncSeparate(this.blend(src), this.blend(dst), this.blend(sa), this.blend(da)); gs.bs = src; gs.bd = dst; gs.bsa = sa; gs.bda = da; }
      if (gs.bop !== bop || gs.bopA !== bopA) { gl.blendEquationSeparate(BLEND_OPS(gl)[bop] ?? gl.FUNC_ADD, BLEND_OPS(gl)[bopA] ?? gl.FUNC_ADD); gs.bop = bop; gs.bopA = bopA; }
      if (dev.api9) { const bf = this.rs(RS9.BLENDFACTOR, 0xffffffff); if (gs.bf !== bf) { const c = colorToVec(bf, this.tmp.v4); gl.blendColor(c[0], c[1], c[2], c[3]); gs.bf = bf; } }
    }
    const cw = this.rs(RS.COLORWRITEENABLE, 0xf) & 0xf;
    if (gs.cw !== cw) { gl.colorMask((cw & 1) !== 0, (cw & 2) !== 0, (cw & 4) !== 0, (cw & 8) !== 0); gs.cw = cw; }
    // Winding: a D3D front face is clockwise as seen on the screen. Clip space is shared, so GL window
    // space keeps that visual orientation on the screen (D3D front = GL clockwise) and mirrors it on
    // y-flipped texture targets. With frontFace set that way, D3DCULL_CCW culls GL back faces.
    const ff = flip ? gl.CCW : gl.CW; if (gs.ff !== ff) { gl.frontFace(ff); gs.ff = ff; }
    const cull = this.rs(RS.CULLMODE, 3);
    const cullOn = !(cull === 1 || this.noCull);
    this.glEnable(gl.CULL_FACE, cullOn);
    if (cullOn) { const cf = cull === 3 ? gl.BACK : gl.FRONT; if (gs.cf !== cf) { gl.cullFace(cf); gs.cf = cf; } }
  }
  /** enable/disable a GL capability through the state cache */
  glEnable(cap, on) { const gs = this.gs; if (gs.en[cap] === on) return; gs.en[cap] = on; if (on) this.gl.enable(cap); else this.gl.disable(cap); }
  /** forget every cached GL state (after code paths that set state without the cache: reset, clear, present) */
  invalidateGlState() {
    this.gs = { en: {}, tex: new Array(16).fill(null), texUnit: new Array(16).fill(null), smp: new Array(16).fill(null), prog: null };
    for (const ss of this.samplerState) for (const k in ss) ss[k] = undefined;
    for (let i = 0; i < 16; i++) this.gl.disableVertexAttribArray(i); // known state: nothing enabled
    this.attribMask = 0;
  }
  captureDraw(P, info, v, flip) {
    const gl = this.gl; void gl;
    const texStat = (t) => { const l = t.levels?.[0]; if (!l || !l.mem || l.width * l.height > 65536 || surfacePitch(t.fmt, 1) !== 4) return ''; let nz = 0, opaque = 0; const u8 = this.mem.u8; for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) { const a = u8[l.mem + y * l.pitch + x * 4 + 3]; if (a) nz++; if (a === 255) opaque++; } return `,alpha>0:${nz}/opaque:${opaque}`; };
    const texs = info.stages.map((st, i) => st.bound ? `${i}:#${st.tex.id}:${st.tex.fmt}/${st.tex.width}x${st.tex.height}${st.tex.usage & 1 ? 'RT' : ''}${st.tex.levels?.[0]?.mem ? '' : '(nomem)'}${texStat(st.tex)}` : '').filter(Boolean).join(' ');
    this.log(`d3d-webgl: [cap] ${flip ? 'FBO' : 'back'} vp=${v.x},${v.y},${v.w},${v.h} prog=${P.key.slice(0, 90)} tex=[${texs}] blend=${this.rs(RS.ALPHABLENDENABLE, 0)}:${this.rs(RS.SRCBLEND, 2)}/${this.rs(RS.DESTBLEND, 1)} atest=${this.rs(RS.ALPHATESTENABLE, 0)}:${this.rs(RS.ALPHAFUNC, 8)}/${this.rs(RS.ALPHAREF, 0)} z=${this.rs(RS.ZENABLE, 1)}/${this.rs(RS.ZWRITEENABLE, 1)} cull=${this.rs(RS.CULLMODE, 3)} cw=${this.rs(RS.COLORWRITEENABLE, 0xf)} tf=${(this.rs(RS.TEXTUREFACTOR, 0xffffffff) >>> 0).toString(16)} fog=${info.fog} vs=${info.L.code ? 'yes' : 'ff'} ps=${info.ps ? 'yes' : 'ff'}`);
  }
  cmp(f) { const gl = this.gl; return [gl.ALWAYS, gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS][f] ?? gl.ALWAYS; }
  stencilOp(o) { const gl = this.gl; return [gl.KEEP, gl.KEEP, gl.ZERO, gl.REPLACE, gl.INCR, gl.DECR, gl.INVERT, gl.INCR_WRAP, gl.DECR_WRAP][o] ?? gl.KEEP; }
  blend(b) { const gl = this.gl; return [gl.ZERO, gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA_SATURATE, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.CONSTANT_COLOR, gl.ONE_MINUS_CONSTANT_COLOR][b] ?? gl.ONE; }

  /** Bind vertex attributes for the current layout from the device's streams (or a UP buffer). */
  bindAttributes(P, L, up = null, baseVertex = 0) {
    const gl = this.gl, dev = this.dev;
    const attrType = (a) => (a.type === 'color' || a.type === 'ubyte4' || a.type === 'ubyte4n' ? gl.UNSIGNED_BYTE : a.type === 'short' || a.type === 'shortn' ? gl.SHORT : a.type === 'ushortn' ? gl.UNSIGNED_SHORT : a.type === 'half' ? gl.HALF_FLOAT : gl.FLOAT);
    const normalized = (a) => a.type === 'color' || a.type === 'ubyte4n' || a.type === 'shortn' || a.type === 'ushortn';
    const nameOf = (a) => (L.code && L.dx9 ? 'a_' + (a.sem ?? FVF_SEM[a.name] ?? a.name) : L.code ? 'a_v' + a.reg : 'a_' + a.name);
    let used = 0; // bitmask of attribute locations bound by this draw
    const bindStream = (n, attrs, declStride) => {
      const s = up ?? dev.streams[n];
      let stride, base;
      if (up) { gl.bindBuffer(gl.ARRAY_BUFFER, this.upVbo); stride = up.stride; base = 0; }
      else { const vb = this.comImpl(s.vb); if (!vb) return; gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer(vb, 'vb').buf); stride = s.stride || declStride; base = s.offset ?? 0; }
      for (const a of attrs) {
        const loc = P.attrNames.indexOf(nameOf(a));
        if (loc < 0) continue;
        if (!(this.attribMask & (1 << loc))) gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, a.comps, attrType(a), normalized(a), stride, base + a.offset + baseVertex * stride);
        used |= 1 << loc;
      }
    };
    if (L.layout.streams) { for (const [n, st] of L.layout.streams) bindStream(n, st.attrs, st.stride); }
    else bindStream(0, L.layout.attrs, L.layout.stride);
    const stale = this.attribMask & ~used; // previously enabled attributes not used by this draw
    if (stale) for (let i = 0; i < 16; i++) if (stale & (1 << i)) gl.disableVertexAttribArray(i);
    this.attribMask = used;
    return true;
  }
  glMode(type) { const gl = this.gl; return [0, gl.POINTS, gl.LINES, gl.LINE_STRIP, gl.TRIANGLES, gl.TRIANGLE_STRIP, gl.TRIANGLE_FAN][type] ?? gl.TRIANGLES; }
  vertexCount(type, prims) { switch (type) { case PT.POINTLIST: return prims; case PT.LINELIST: return prims * 2; case PT.LINESTRIP: return prims + 1; case PT.TRIANGLELIST: return prims * 3; default: return prims + 2; } }

  /** GL error check after the first draws (diagnostics for the log) */
  checkErrors(where) {
    if (this.stats.draws > 64) return;
    const e = this.gl.getError();
    if (e) { this.stats.errors++; this.log(`d3d-webgl: GL error 0x${e.toString(16)} after ${where} (draw ${this.stats.draws})`); }
  }
  drawPrimitive(type, start, count) {
    const gl = this.gl;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    if (!this.bindAttributes(P, info.L)) return;
    if (this.capturing) {
      const st = this.dev.streams[0], vb = this.comImpl(st.vb);
      const stride = st.stride || info.L.layout.stride || 0;
      const vtx = (i) => { if (!vb) return '?'; const a = vb.mem + (st.offset ?? 0) + (start + i) * stride; const L = info.L.layout; const dif = L.attrs?.find((x) => x.name === 'diffuse'), t0 = L.attrs?.find((x) => x.name === 'tex0'); return Array.from({ length: 3 }, (_, k) => this.mem.readF32(a + 4 * k).toFixed(1)).join(',') + (dif ? ' c=' + (this.mem.read32(a + dif.offset) >>> 0).toString(16) : '') + (t0 ? ' uv=' + this.mem.readF32(a + t0.offset).toFixed(3) + ',' + this.mem.readF32(a + t0.offset + 4).toFixed(3) : ''); };
      const nv = Math.min(12, this.vertexCount(type, count));
      this.log(`d3d-webgl: [cap] drawPrimitive type ${type} start ${start} prims ${count} ${Array.from({ length: nv }, (_, i) => `v${i}=(${vtx(i)})`).join(' ')} world=${Array.from(this.dev.transforms.get(TS_WORLD) ?? IDENTITY).map((x) => +x.toPrecision(3)).join(',')} view=${Array.from(this.dev.transforms.get(TS_VIEW) ?? IDENTITY).map((x) => +x.toPrecision(3)).join(',')}`);
    }
    gl.drawArrays(this.glMode(type), start, this.vertexCount(type, count));
    this.stats.draws++; this.frameDraws++;
    this.checkErrors(`drawPrimitive(${type}, ${start}, ${count}) program ${P.key.slice(0, 60)} attrs ${P.attrNames.join(',')}`);
    if (this.stats.draws <= 2) this.debugDraw(P, info);
  }
  /** first-draws diagnostics: viewport, attribute setup, vertex 0, a pixel after the draw */
  debugDraw(P, info) {
    const gl = this.gl, dev = this.dev, mem = this.mem;
    const s = dev.streams[0], vb = this.comImpl(s.vb);
    const v0 = vb ? Array.from({ length: 7 }, (_, i) => mem.readF32(vb.mem + (s.offset ?? 0) + 4 * i).toFixed(2)).join(',') : '-';
    const attrs = P.attrNames.map((n, i) => `${n}:${gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_ENABLED) ? gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_SIZE) + '/' + gl.getVertexAttrib(i, gl.VERTEX_ATTRIB_ARRAY_STRIDE) : 'off'}`).join(' ');
    const px = new Uint8Array(4); gl.readPixels(60, gl.drawingBufferHeight - 61, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const vp = gl.getParameter(gl.VIEWPORT);
    const px2 = new Uint8Array(4); gl.readPixels(20, 20, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px2);
    this.log(`d3d-webgl: state depth=${gl.getParameter(gl.DEPTH_TEST)}/${gl.getParameter(gl.DEPTH_FUNC)} mask=${gl.getParameter(gl.DEPTH_WRITEMASK)} cull=${gl.getParameter(gl.CULL_FACE)} blend=${gl.getParameter(gl.BLEND)} scissor=${gl.getParameter(gl.SCISSOR_TEST)} cmask=${gl.getParameter(gl.COLOR_WRITEMASK)} range=${gl.getParameter(gl.DEPTH_RANGE)} fb=${gl.getParameter(gl.FRAMEBUFFER_BINDING)} prog=${gl.getParameter(gl.CURRENT_PROGRAM) === P.prog} vao=${gl.getParameter(gl.VERTEX_ARRAY_BINDING) === this.vao} pixel(20,20gl)=${Array.from(px2).join(',')} v1=[${Array.from({ length: 4 }, (_, i) => mem.readF32(vb.mem + 28 + 4 * i).toFixed(1)).join(',')}] v2=[${Array.from({ length: 4 }, (_, i) => mem.readF32(vb.mem + 56 + 4 * i).toFixed(1)).join(',')}]`);
    this.log(`d3d-webgl: draw ${this.stats.draws}: viewport ${Array.from(vp).join(',')} buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight} attrs ${attrs} v0=[${v0}] stride=${s.stride} pixel(60,60)=${Array.from(px).join(',')} active=${gl.getProgramParameter(P.prog, gl.ACTIVE_ATTRIBUTES)} err=${gl.getError()}`);
    void info;
  }
  drawIndexedPrimitive(type, minIdx, numV, start, count, baseVertex = this.dev.indices.base) {
    const gl = this.gl, dev = this.dev;
    const ib = this.comImpl(dev.indices.ib); if (!ib) return;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    if (!this.bindAttributes(P, info.L, null, baseVertex | 0)) return;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.glBuffer(ib, 'ib').buf);
    const short = ib.fmt === FMT.INDEX16;
    if (this.capturing) {
      const st = dev.streams[0], vb = this.comImpl(st.vb), stride = st.stride || info.L.layout.stride || 0, short = ib.fmt === FMT.INDEX16;
      const idx = (i) => short ? this.mem.read16(ib.mem + 2 * (start + i)) : this.mem.read32(ib.mem + 4 * (start + i));
      const vtx = (i) => { if (!vb) return '?'; const a = vb.mem + (st.offset ?? 0) + (baseVertex + idx(i)) * stride; const L = info.L.layout; const dif = L.attrs?.find((x) => x.name === 'diffuse'); return `i${idx(i)}:` + Array.from({ length: 2 }, (_, k) => this.mem.readF32(a + 4 * k).toFixed(1)).join(',') + (dif ? ' c=' + (this.mem.read32(a + dif.offset) >>> 0).toString(16) : ''); };
      this.log(`d3d-webgl: [cap] drawIndexedPrimitive type ${type} base ${baseVertex} start ${start} prims ${count} numV ${numV} tri0=[${vtx(0)} ${vtx(1)} ${vtx(2)}]`);
    }
    gl.drawElements(this.glMode(type), this.vertexCount(type, count), short ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, start * (short ? 2 : 4));
    this.stats.draws++; this.frameDraws++;
    void minIdx;
  }
  drawPrimitiveUP(type, count, data, stride) {
    const gl = this.gl;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    const n = this.vertexCount(type, count);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.mem.bytes(data, n * stride), gl.STREAM_DRAW);
    if (!this.bindAttributes(P, info.L, { stride })) return;
    if (this.capturing) this.log(`d3d-webgl: [cap] drawPrimitiveUP type ${type} prims ${count} stride ${stride}`);
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
    if (this.capturing) this.log(`d3d-webgl: [cap] drawIndexedPrimitiveUP type ${type} prims ${count} numV ${numV} stride ${stride}`);
    gl.drawElements(this.glMode(type), n, short ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, 0);
    this.stats.draws++; this.frameDraws++;
  }
}

/** Host-side factory: `host.gfx = createWebGLBackend(canvas, log)`. */
export function createWebGLBackend(canvas, log) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, stencil: true, preserveDrawingBuffer: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  return { gl, createDevice(dev) { return new WebGLDevice(gl, dev, { log, dumpShaders: globalThis.ORTHROS_DUMP_SHADERS, captureFrame: globalThis.ORTHROS_CAPTURE_FRAME, noCull: globalThis.ORTHROS_NO_CULL }); } };
}
