// Direct3D 8/9 backend on WebGL2. Resources live in guest memory (see win32/d3d8.js and
// win32/d3d9.js); this module mirrors them into GL objects lazily (uploads on Unlock/dirty),
// builds fixed-function or translated shader programs from the device state at draw time, and
// maps render states, texture stage / sampler states, blending, depth/stencil, fog, scissor and
// viewport onto GL. DX8 and DX9 devices share the state model; DX9 adds vertex declarations,
// sampler states, shader objects (SM 1.x–2.x), stream offsets, base vertices, MRT/scissor.
import { FMT, surfacePitch, surfaceBytes } from '../win32/d3d8.js';
import { fvfLayout, declLayout, ffVertexShader, ffFragmentShader, translateVertexShader, translatePixelShader, RS, TSS, TOP, TS_WORLD, TS_VIEW, TS_PROJECTION, TS_TEXTURE0, MAX_STAGES, MAX_LIGHTS } from './d3d8-shaders.js';
import { translateVertexShader9, translatePixelShader9, semName, disasmShader9 } from './d3d9-shaders.js';

const D3D_OK = 0;
const PT = { POINTLIST: 1, LINELIST: 2, LINESTRIP: 3, TRIANGLELIST: 4, TRIANGLESTRIP: 5, TRIANGLEFAN: 6 };
const SAMP = { ADDRESSU: 1, ADDRESSV: 2, ADDRESSW: 3, BORDERCOLOR: 4, MAGFILTER: 5, MINFILTER: 6, MIPFILTER: 7, MIPMAPLODBIAS: 8, MAXMIPLEVEL: 9, MAXANISOTROPY: 10, SRGBTEXTURE: 11 };
const SAMP_TO_TSS = { [SAMP.ADDRESSU]: TSS.ADDRESSU, [SAMP.ADDRESSV]: TSS.ADDRESSV, [SAMP.ADDRESSW]: TSS.ADDRESSW, [SAMP.BORDERCOLOR]: TSS.BORDERCOLOR, [SAMP.MAGFILTER]: TSS.MAGFILTER, [SAMP.MINFILTER]: TSS.MINFILTER, [SAMP.MIPFILTER]: TSS.MIPFILTER, [SAMP.MIPMAPLODBIAS]: TSS.MIPMAPLODBIAS, [SAMP.MAXMIPLEVEL]: TSS.MAXMIPLEVEL, [SAMP.MAXANISOTROPY]: TSS.MAXANISOTROPY };
const RS9 = { SCISSORTESTENABLE: 174, SLOPESCALEDEPTHBIAS: 175, TWOSIDEDSTENCILMODE: 185, CCW_STENCILFAIL: 186, CCW_STENCILZFAIL: 187, CCW_STENCILPASS: 188, CCW_STENCILFUNC: 189, BLENDFACTOR: 193, DEPTHBIAS: 195, SEPARATEALPHABLENDENABLE: 206, SRCBLENDALPHA: 207, DESTBLENDALPHA: 208, BLENDOPALPHA: 209 };
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const asFloat = (v) => { u32[0] = v >>> 0; return f32[0]; };
const colorToVec = (c, out = new Float32Array(4)) => { out[0] = ((c >> 16) & 0xff) / 255; out[1] = ((c >> 8) & 0xff) / 255; out[2] = (c & 0xff) / 255; out[3] = ((c >>> 24) & 0xff) / 255; return out; };
const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** First n floats equal (NaN placeholders never match: fresh caches always upload). */
const byNumber = (a, b) => a - b;
/** Time per Present for uploading textures written but not drawn yet (WebGLDevice.preloadTextures). */
const PRELOAD_MS = 4;
const sameF32 = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
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
  const alphas = new Uint8Array(16), at = new Uint8Array(8);
  const expand = (v, o) => { o[0] = ((v >> 11) & 31) * 255 / 31 | 0; o[1] = ((v >> 5) & 63) * 255 / 63 | 0; o[2] = (v & 31) * 255 / 31 | 0; o[3] = 255; };
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let p = (by * bw + bx) * bs;
    if (fmt !== FMT.DXT1) {
      if (fmt === FMT.DXT2 || fmt === FMT.DXT3) { for (let i = 0; i < 16; i++) { const v = (src[p + (i >> 1)] >> ((i & 1) * 4)) & 15; alphas[i] = v * 17; } }
      else {
        const a0 = src[p], a1 = src[p + 1];
        at[0] = a0; at[1] = a1;
        if (a0 > a1) for (let i = 1; i < 7; i++) at[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0; else { for (let i = 1; i < 5; i++) at[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0; at[6] = 0; at[7] = 255; }
        const lo = src[p + 2] | (src[p + 3] << 8) | (src[p + 4] << 16), hi = src[p + 5] | (src[p + 6] << 8) | (src[p + 7] << 16);
        for (let i = 0; i < 8; i++) alphas[i] = at[(lo >>> (3 * i)) & 7];
        for (let i = 0; i < 8; i++) alphas[8 + i] = at[(hi >>> (3 * i)) & 7];
      }
      p += 8;
    }
    const c0 = src[p] | (src[p + 1] << 8), c1 = src[p + 2] | (src[p + 3] << 8);
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
const TEX_U = { tex: names('u_tex', 16).map((x) => x.replace(/\[(\d+)\]$/, '$1')), cube: names('u_cube', 16).map((x) => x.replace(/\[(\d+)\]$/, '$1')), vol: names('u_vol', 16).map((x) => x.replace(/\[(\d+)\]$/, '$1')) };
let blendOpsCache = null; const BLEND_OPS = (gl) => blendOpsCache ?? (blendOpsCache = [gl.FUNC_ADD, gl.FUNC_ADD, gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT, gl.MIN, gl.MAX]);
/** program signature inputs: render states with the defaults programUncached reads them with (pairs state, default) */
const SIG_RS = [RS.SHADEMODE, 2, RS.LIGHTING, 1, RS.FOGENABLE, 0, RS.FOGTABLEMODE, 0, RS.FOGVERTEXMODE, 0, RS.COLORVERTEX, 1, RS.DIFFUSEMATERIALSOURCE, 1, RS.SPECULARMATERIALSOURCE, 2,
  RS.AMBIENTMATERIALSOURCE, 0, RS.EMISSIVEMATERIALSOURCE, 0, RS.SPECULARENABLE, 0, RS.LOCALVIEWER, 1, RS.NORMALIZENORMALS, 0, RS.RANGEFOGENABLE, 0, RS.VERTEXBLEND, 0,
  RS.ALPHATESTENABLE, 0, RS.ALPHAFUNC, 8];
/** stage states of the signature besides COLOROP / ALPHAOP / TEXCOORDINDEX, whose defaults depend on the stage (pairs state, default) */
const SIG_TSS = [TSS.COLORARG1, 2, TSS.COLORARG2, 1, TSS.COLORARG0, 1, TSS.ALPHAARG1, 2, TSS.ALPHAARG2, 1, TSS.ALPHAARG0, 1, TSS.RESULTARG, 1, TSS.TEXTURETRANSFORMFLAGS, 0];
const U_VC = names('u_vc', 256), U_PC = names('u_pc', 32);
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
    this.pc = opts.programCache ?? null; // (shared by the devices of this GL context, see createWebGLBackend)
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    if (opts.log) opts.log(`d3d-webgl: ${gl.getParameter(gl.RENDERER)} | s3tc ${this.s3tc ? 'yes' : 'no (DXT decoded on the CPU)'} | max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`);
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.uploadUnit = Math.min(gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) || 32, 32) - 1; // (stages and shader samplers use units 0..15; see bindForUpload)
    this.firstVertexConvention();
    this.programs = new Map();
    this.textures = new Map(); // resource id -> { tex, target }
    this.pendingTextures = new Set(); // textures written, not yet uploaded (see surfaceUpdated)
    this.buffers = new Map(); // resource id -> { buf, size }
    this.fbos = new Map(); // surface id -> fbo
    this.samplerPool = new Map(); // parameter combination -> WebGLSampler
    this.invalidateGlState();
    this.upVbo = gl.createBuffer(); this.upIbo = gl.createBuffer();
    this.vao = gl.createVertexArray();
    this.stats = { draws: 0, programs: 0, uploads: 0, errors: 0, vaos: 0 };
    this.tmp = { v4: new Float32Array(4) };
    this.fvfCache = new Map();
    this.frameDraws = 0;
    this.dumpShaders = !!opts.dumpShaders;
    this.noCull = !!opts.noCull;
    this.glValidate = !!globalThis.ORTHROS_GL_VALIDATE; // (debugging: cached GL state checked against GL, see validateGlState)
    if (this.glValidate) this.log('d3d-webgl: GL state cache validation on (first 3000 draws, then every 97th)');
    this.captureAt = opts.captureFrame ?? 0; this.frame = 0; this.capturing = false; // one-frame draw dump (like a mini PIX)
    this.dump = opts.dump ?? null; this.captureDraws = !!opts.captureDraws; this.dumpedTex = new Set(); // capture images: bound textures, target after each draw
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
  /**
   * The WebGL context was lost and restored: every GL object is gone. The records are dropped so that programs,
   * textures, buffers, VAOs and targets are recreated on use and resources re-uploaded from guest memory (render
   * target contents are lost, as with a lost Direct3D device: the game redraws them).
   */
  /** Flat shading takes the first vertex's colors in Direct3D, the last one's in GL unless WEBGL_provoking_vertex says otherwise. */
  firstVertexConvention() {
    const ext = this.gl.getExtension('WEBGL_provoking_vertex');
    if (ext) ext.provokingVertexWEBGL(ext.FIRST_VERTEX_CONVENTION_WEBGL);
  }
  contextRestored() {
    const gl = this.gl;
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc'); this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.firstVertexConvention();
    this.programs.clear(); this.progBySig?.clear(); this.lastProgram = null; this.pc?.ready.clear();
    this.textures.clear(); this.buffers.clear(); this.fbos.clear(); this.samplerPool.clear();
    this.vaos?.clear(); this.vaosByBuf?.clear(); this.curVao = null; this.gamma = null;
    this.upVbo = gl.createBuffer(); this.upIbo = gl.createBuffer(); this.vao = gl.createVertexArray();
    this.invalidateGlState(); gl.bindVertexArray(this.vao);
    this.reset(this.dev);
    this.log('d3d-webgl: context restored, resources recreated on use');
  }
  destroy() { const gl = this.gl; for (const t of this.textures.values()) gl.deleteTexture(t.tex); for (const b of this.buffers.values()) gl.deleteBuffer(b.buf); for (const f of this.fbos.values()) { gl.deleteFramebuffer(f.fbo); if (f.depth) gl.deleteRenderbuffer(f.depth); if (f.color) gl.deleteRenderbuffer(f.color); } for (const p of this.programs.values()) gl.deleteProgram(p.prog); }

  // ---------------------------------------------------------------- resources
  createTexture() {} createBuffer() {} createSurface() {}
  /**
   * A texture level was written (lock, D3DX, copy): a texture not yet on the GPU is remembered, to be uploaded at a
   * later Present within a time budget (see preloadTextures) instead of all at once by the first frame drawing with it —
   * a map load fills hundreds of textures behind a loading screen, then its first frame would upload them all.
   */
  surfaceUpdated(s) { const t = s.owner; if (t && !this.textures.has(t.id)) this.pendingTextures.add(t); }
  volumeUpdated(t) { if (t && !this.textures.has(t.id)) this.pendingTextures.add(t); }
  /**
   * Upload textures written but not yet used, until `budgetMs` is spent: only those whose levels all hold data (a
   * texture still being filled waits), the same uploads a draw would make (a texture changed afterwards is dirty
   * again and uploaded again when drawn).
   */
  preloadTextures(budgetMs) {
    if (!this.pendingTextures.size) return;
    const t0 = performance.now();
    for (const t of this.pendingTextures) {
      if (performance.now() - t0 > budgetMs) break;
      if (this.textures.has(t.id)) { this.pendingTextures.delete(t); continue; } // (drawn meanwhile)
      const levels = t.faces ? t.faces.flat() : t.levels ?? [];
      if (!levels.length || (t.usage & 1) || !levels.every((l) => l.mem)) continue; // (render targets: drawn, not uploaded)
      this.pendingTextures.delete(t);
      this.glTexture(t);
      this.stats.preloaded = (this.stats.preloaded ?? 0) + 1;
    }
    this.stats.preloadMs = (this.stats.preloadMs ?? 0) + performance.now() - t0;
  }
  /** A locked range was written: remember the union of dirty bytes so the upload can be partial. */
  bufferUpdated(b, start = 0, size = b.length) {
    const end = Math.min(b.length, start + size);
    if (!b.dirtyRange) { b.dirtyLo = start; b.dirtyHi = end; b.dirtyRange = true; } else { if (start < b.dirtyLo) b.dirtyLo = start; if (end > b.dirtyHi) b.dirtyHi = end; }
    b.dirty = true;
  }
  destroyResource(r) {
    const gl = this.gl;
    const t = this.textures.get(r.id); if (t) { gl.deleteTexture(t.tex); this.textures.delete(r.id); }
    this.pendingTextures.delete(r);
    const b = this.buffers.get(r.id); if (b) { this.dropVaos(r.id); gl.deleteBuffer(b.buf); this.buffers.delete(r.id); }
    const levels = r.levels ?? (r.faces ? r.faces.flat() : r.type === 1 ? [r] : []);
    for (const l of levels) { const f = this.fbos.get(l.id); if (f) { gl.deleteFramebuffer(f.fbo); if (f.depth) gl.deleteRenderbuffer(f.depth); if (f.color) gl.deleteRenderbuffer(f.color); this.fbos.delete(l.id); } }
  }
  /** GL texture for a texture resource, uploading dirty levels. */
  glTexture(t) {
    const gl = this.gl;
    const cube = !!t.faces, volume = !!t.depth;
    const target = cube ? gl.TEXTURE_CUBE_MAP : volume ? gl.TEXTURE_3D : gl.TEXTURE_2D;
    let g = this.textures.get(t.id), fresh = false;
    if (!g) { fresh = true; g = { tex: gl.createTexture(), target }; this.textures.set(t.id, g); this.bindForUpload(target, g.tex); gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, (cube ? t.faces[0].length : t.levels?.length ?? 1) - 1); }
    if (volume) {
      for (let i = 0; i < t.levels.length; i++) { const l = t.levels[i]; if (l.uploaded && !l.dirty && !fresh) continue; this.bindForUpload(target, g.tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); const data = l.mem ? this.volumeToRgba(t.fmt, l) : null; gl.texImage3D(target, i, gl.RGBA8, l.width, l.height, l.depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, data); l.uploaded = true; l.dirty = false; this.stats.uploads++; }
      return g;
    }
    const faces = cube ? t.faces : [t.levels ?? []];
    let bound = false;
    for (let f = 0; f < faces.length; f++) {
      const lv = faces[f];
      for (let i = 0; i < lv.length; i++) {
        const s = lv[i];
        if (!s.dirty && s.uploaded && !fresh) continue; // (a new GL texture — first use, or after a context loss — takes every level)
        if (!bound) { this.bindForUpload(target, g.tex); bound = true; }
        const t0 = performance.now();
        if (s.uploaded) this.stats.reuploads = (this.stats.reuploads ?? 0) + 1; // (report: levels updated after their first upload)
        this.uploadLevel(cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + f : gl.TEXTURE_2D, i, s, g, f * 32 + i);
        this.stats.texMs = (this.stats.texMs ?? 0) + performance.now() - t0; // (report: texture conversion + upload time)
        s.dirty = false; s.uploaded = true;
      }
    }
    return g;
  }
  /**
   * Bind a texture to upload into it, on a unit no stage samples (the last one): uploads happen while a draw binds
   * its stages (a stage's texture made current, then a later stage's dirty texture uploaded), and an upload through
   * the active unit replaced the binding of the stage bound just before (the cache followed, so the draw sampled the
   * uploaded texture on both units).
   */
  bindForUpload(target, tex) {
    const gl = this.gl, gs = this.gs, u = this.uploadUnit;
    if (gs.active !== u) { gl.activeTexture(gl.TEXTURE0 + u); gs.active = u; }
    gl.bindTexture(target, tex);
    gs.tex[u] = tex;
  }
  volumeToRgba(fmt, l) { const out = new Uint8Array(l.width * l.height * l.depth * 4); for (let z = 0; z < l.depth; z++) out.set(surfaceToRgba(this.mem, fmt, l.mem + z * l.slice, l.width, l.height, l.pitch), z * l.width * l.height * 4); return out; }
  /**
   * Upload a surface into `level` of the bound texture; `g.alloc[slot]` records the levels already specified (GL texture
   * record). A level already specified in the same format whose change is known to be confined to a rectangle
   * (`s.dirtyRect`: the union of the rectangles locked since the last upload) gets only that rectangle, converted and
   * sent alone (DXT: widened to whole 4x4 blocks).
   */
  uploadLevel(target, level, s, g, slot) {
    const gl = this.gl;
    const alloc = g.alloc ?? (g.alloc = []);
    const dxt = isDxt(s.fmt) && this.s3tc;
    const ext = this.s3tc;
    const glf = !dxt ? 'rgba8' : s.fmt === FMT.DXT1 ? ext.COMPRESSED_RGBA_S3TC_DXT1_EXT : s.fmt === FMT.DXT2 || s.fmt === FMT.DXT3 ? ext.COMPRESSED_RGBA_S3TC_DXT3_EXT : ext.COMPRESSED_RGBA_S3TC_DXT5_EXT;
    let x0 = 0, y0 = 0, x1 = s.width, y1 = s.height;
    const d = s.mem && alloc[slot] === glf ? s.dirtyRect : null;
    if (d) {
      if (dxt) { x0 = d[0] & ~3; y0 = d[1] & ~3; x1 = Math.min(s.width, (d[2] + 3) & ~3); y1 = Math.min(s.height, (d[3] + 3) & ~3); }
      else { x0 = d[0]; y0 = d[1]; x1 = d[2]; y1 = d[3]; }
    }
    const w = x1 - x0, h = y1 - y0, whole = w === s.width && h === s.height;
    this.stats.uploads++; this.stats.texLevels = (this.stats.texLevels ?? 0) + 1;
    if (!whole) this.stats.texPartial = (this.stats.texPartial ?? 0) + 1;
    this.stats.uploadBytes = (this.stats.uploadBytes ?? 0) + w * h * 4;
    { const k = `${s.fmt}:${s.width}x${s.height}`, m = this.stats.uploadsBy ?? (this.stats.uploadsBy = new Map()); m.set(k, (m.get(k) ?? 0) + 1); } // (report)
    if (!s.mem) { gl.texImage2D(target, level, gl.RGBA8, s.width, s.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); alloc[slot] = 'rgba8'; return; }
    // a level already specified in the same format is updated in place (no reallocation of GPU storage)
    if (dxt) {
      const bs = s.fmt === FMT.DXT1 ? 8 : 16;
      if (whole) {
        const data = this.mem.bytes(s.mem, surfaceBytes(s.fmt, s.width, s.height));
        if (alloc[slot] === glf) gl.compressedTexSubImage2D(target, level, 0, 0, s.width, s.height, glf, data);
        else gl.compressedTexImage2D(target, level, glf, s.width, s.height, 0, data);
        alloc[slot] = glf;
        return;
      }
      // rows of blocks of the rectangle: one view when they span whole block rows, else packed
      const rows = (h + 3) >> 2, rowBytes = ((w + 3) >> 2) * bs, src = s.mem + (y0 >> 2) * s.pitch + (x0 >> 2) * bs;
      let data;
      if (rowBytes === s.pitch) data = this.mem.bytes(src, rows * rowBytes);
      else { data = new Uint8Array(rows * rowBytes); const u8 = this.mem.u8; for (let y = 0; y < rows; y++) data.set(u8.subarray(src + y * s.pitch, src + y * s.pitch + rowBytes), y * rowBytes); }
      gl.compressedTexSubImage2D(target, level, x0, y0, w, h, glf, data);
      return;
    }
    const tc = performance.now();
    const rgba = surfaceToRgba(this.mem, s.fmt, s.mem + y0 * s.pitch + x0 * (whole ? 0 : surfacePitch(s.fmt, 1)), w, h, s.pitch);
    this.stats.texConvMs = (this.stats.texConvMs ?? 0) + performance.now() - tc; // (report: CPU format conversion)
    // (diagnostic on the pixels just converted — first upload of small textures; DXT levels uploaded compressed are
    // not decoded for it)
    if (level === 0 && !alloc[slot] && s.width * s.height <= 65536 && (this.placeholderLogs ?? 0) < 8) this.checkPlaceholder(s, rgba);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (alloc[slot] === 'rgba8') gl.texSubImage2D(target, level, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    else gl.texImage2D(target, level, gl.RGBA8, s.width, s.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    alloc[slot] = 'rgba8';
  }
  /** Diagnostic: flag textures that look like an engine's "missing texture" placeholder (mostly magenta). */
  checkPlaceholder(s, rgba) {
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
      if (kind === 'ib' && this.curVao) this.curVao.ib = g.buf; // an element array binding is state of the bound VAO
      // (uploads read the guest memory through offsets into its one view: no view object per upload; a length of 0
      // would mean "to the end of the source" to GL)
      if (g.size !== b.length) { if (b.length > 0) gl.bufferData(target, this.mem.u8, b.usage & 0x200 ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW, b.mem >>> 0, b.length); else gl.bufferData(target, 0, gl.STATIC_DRAW); g.size = b.length; }
      else { const s = b.dirtyRange ? b.dirtyLo : 0, e = b.dirtyRange ? b.dirtyHi : b.length; if (e > s) gl.bufferSubData(target, s, this.mem.u8, (b.mem + s) >>> 0, e - s); }
      b.dirty = false; b.dirtyRange = false; this.stats.uploads++;
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
      f = { fbo: gl.createFramebuffer(), w: rt.width, h: rt.height, depth: null, color: null, back, flip: !back };
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo); this.gs.fbo = f.fbo;
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
    } else if (this.gs.fbo !== f.fbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo); this.gs.fbo = f.fbo; } // cached: every draw asks for its target
    return f; // (w, h, flip: read by every draw — the record itself, no object per call)
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
  /**
   * StretchRect between surfaces the GPU holds (render targets, back buffers, texture levels drawn to): a framebuffer
   * blit, filtered when asked (D3DTEXF_LINEAR). Surfaces never rendered to (their contents in guest memory) return null:
   * the device copies them on the CPU.
   */
  stretchRect(src, sr, dst, dr, filter) {
    const gl = this.gl, dev = this.dev, mem = this.mem;
    if (!this.fbos.has(src.id) || (dst.usage & 2)) return null; // (a depth-stencil destination: not a color blit)
    const prev = dev.renderTarget;
    dev.renderTarget = src; const fs = this.bindTarget();
    dev.renderTarget = dst; const fd = this.bindTarget();
    dev.renderTarget = prev;
    const rect = (p, w, h) => (p ? [mem.readS32(p), mem.readS32(p + 4), mem.readS32(p + 8), mem.readS32(p + 12)] : [0, 0, w, h]);
    const [sl, st, srr, sb] = rect(sr, src.width, src.height), [dl, dt, drr, db] = rect(dr, dst.width, dst.height);
    // D3D rows go down; a back buffer's GL rows go up (flip false), a texture target's match D3D (flip true)
    const sy0 = fs.flip ? st : fs.h - st, sy1 = fs.flip ? sb : fs.h - sb, dy0 = fd.flip ? dt : fd.h - dt, dy1 = fd.flip ? db : fd.h - db;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fs.fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fd.fbo);
    const scissor = this.gs.en[gl.SCISSOR_TEST]; if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(sl, sy0, srr, sy1, dl, dy0, drr, dy1, gl.COLOR_BUFFER_BIT, filter === 2 ? gl.LINEAR : gl.NEAREST);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fd.fbo); this.gs.fbo = fd.fbo;
    this.stats.blits = (this.stats.blits ?? 0) + 1;
    return 0;
  }
  readbackFrontBuffer(s) { const b = this.dev.backBuffers[0]; this.readbackSurface(b); if (b.mem && b.fmt === s.fmt) this.mem.copy(s.ensureMem(this.dev.proc), b.mem, Math.min(b.bytes, s.bytes)); }
  copyRects(src, dst, rects, n, points) {
    const mem = this.mem, dev = this.dev;
    if ((src.usage & 1) && !src.mem) this.readbackSurface(src);
    const sb = src.ensureMem(dev.proc), db = dst.ensureMem(dev.proc);
    // DXT surfaces are copied as rows of 4x4 blocks
    const block = isDxt(src.fmt) ? 4 : 1, unit = block === 4 ? (src.fmt === FMT.DXT1 ? 8 : 16) : surfacePitch(src.fmt, 1);
    const copy = (sx, sy, w, h, dx, dy) => { if (w <= 0 || h <= 0) return; const rows = Math.ceil(h / block), cols = Math.ceil(w / block); for (let y = 0; y < rows; y++) mem.copy(db + ((dy / block | 0) + y) * dst.pitch + (dx / block | 0) * unit, sb + ((sy / block | 0) + y) * src.pitch + (sx / block | 0) * unit, cols * unit); };
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
    gl.disable(gl.SCISSOR_TEST); this.gs.en[gl.SCISSOR_TEST] = false;
    if (this.gammaLut) this.presentGamma(w, h);
    else {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.COLOR_BUFFER_BIT, w === gl.drawingBufferWidth && h === gl.drawingBufferHeight ? gl.NEAREST : gl.LINEAR);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); this.gs.fbo = null;
    if (dev.backBuffers.length > 1 && dev.pp.swap !== 3) { // flipping chain: rotate the contents, not the surfaces
      const ids = dev.backBuffers.map((b) => b.id), first = this.fbos.get(ids[0]);
      for (let i = 0; i < ids.length - 1; i++) { const f = this.fbos.get(ids[i + 1]); if (f) this.fbos.set(ids[i], f); else this.fbos.delete(ids[i]); }
      if (first) this.fbos.set(ids[ids.length - 1], first); else this.fbos.delete(ids[ids.length - 1]);
    }
    gl.flush(); this.frame++;
    if (this.pc?.queue.length) this.prewarmStep();
    this.preloadTextures(PRELOAD_MS);
    if (this.capturing) { this.capturing = false; this.log(`d3d-webgl: capture end (${this.frameDraws} draws)${this.glCallCounts ? '; GL calls: ' + this.stopGlCount() : ''}`); }
    if (this.countLeft && --this.countLeft === 0) this.log(`d3d-webgl: GL calls per frame over ${this.countFrames} frames: ${this.stopGlCount(this.countFrames)}`);
    if (this.captureAt && this.frame === this.captureAt) {
      if (this.countFrames) { this.countLeft = this.countFrames; this.startGlCount(); } // (count only: no dump, no per-draw log)
      else { this.capturing = true; this.startGlCount(); this.log(`d3d-webgl: capture frame ${this.frame}`); }
    }
  }
  /** Frame capture: count the WebGL calls of the captured frame per function (instance methods shadow the prototype's). */
  startGlCount() {
    const gl = this.gl, counts = this.glCallCounts = new Map();
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(gl))) {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(gl), k);
      if (typeof d?.value !== 'function' || k === 'constructor') continue;
      const f = d.value;
      gl[k] = function (...a) { counts.set(k, (counts.get(k) ?? 0) + 1); return f.apply(gl, a); };
    }
  }
  /** the counts (per frame over `frames` frames), most frequent first */
  stopGlCount(frames = 1) {
    const gl = this.gl, counts = this.glCallCounts; this.glCallCounts = null;
    for (const k of Object.keys(gl)) if (typeof gl[k] === 'function') delete gl[k];
    let total = 0; for (const v of counts.values()) total += v;
    const draws = frames > 1 ? (counts.get('drawElements') ?? 0) + (counts.get('drawArrays') ?? 0) : this.frameDraws;
    const f = (v) => (frames > 1 ? (v / frames).toFixed(1) : v);
    return `${f(total)} (${(total / Math.max(1, draws)).toFixed(1)}/draw): ` + [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${f(v)}`).join(', ');
  }
  clear(n, rects, flags, color, z, stencil) {
    const gl = this.gl, dev = this.dev;
    if (this.capturing) this.log(`d3d-webgl: [cap] clear flags ${flags} color ${(color >>> 0).toString(16)} z ${z} stencil ${stencil} target ${dev.backBuffers.includes(dev.renderTarget) ? 'screen' : 'FBO'}`);
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
  deleteVertexShader(sh) { this.progBySig?.clear(); for (const [k, p] of this.programs) if (p.vs === sh) { this.dropVaos(undefined, p); this.gl.deleteProgram(p.prog); this.programs.delete(k); if (this.lastProgram?.p === p) this.lastProgram = null; } }
  deletePixelShader(sh) { this.progBySig?.clear(); for (const [k, p] of this.programs) if (p.ps === sh) { this.dropVaos(undefined, p); this.gl.deleteProgram(p.prog); this.programs.delete(k); if (this.lastProgram?.p === p) this.lastProgram = null; } }
  setCursor() {}
  /**
   * Gamma ramp (SetGammaRamp / SetDeviceGammaRamp): 3 x 256 WORDs. An identity ramp disables the pass; otherwise
   * present() maps the back buffer through a 256-entry lookup texture on its way to the screen.
   */
  setGamma(ramp) {
    const u16 = new Uint16Array(ramp.buffer, ramp.byteOffset, 768);
    let identity = true;
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      for (let ch = 0; ch < 3; ch++) { const v = u16[ch * 256 + i] >> 8; lut[i * 4 + ch] = v; if (Math.abs(v - i) > 1) identity = false; }
      lut[i * 4 + 3] = 255;
    }
    this.gammaLut = identity ? null : lut;
    this.gammaDirty = true;
  }
  /** Present through the gamma lookup: back buffer -> intermediate texture -> LUT pass into the default framebuffer. */
  presentGamma(w, h) {
    const gl = this.gl, G = this.gamma ?? (this.gamma = {});
    if (!G.prog) {
      const vs = '#version 300 es\nout vec2 uv; void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
      const fs = '#version 300 es\nprecision highp float; in vec2 uv; uniform sampler2D u_img; uniform sampler2D u_lut; out vec4 o; void main() { vec3 c = texture(u_img, uv).rgb; o = vec4(texture(u_lut, vec2(c.r * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).r, texture(u_lut, vec2(c.g * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).g, texture(u_lut, vec2(c.b * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).b, 1.0); }';
      G.prog = this.compile(vs, fs, 'gamma', []).prog;
      G.lut = gl.createTexture(); G.fbo = gl.createFramebuffer(); G.tex = gl.createTexture(); G.w = 0; G.h = 0;
    }
    if (this.gammaDirty) { gl.bindTexture(gl.TEXTURE_2D, G.lut); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.gammaLut); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); this.gammaDirty = false; }
    if (G.w !== w || G.h !== h) { gl.bindTexture(gl.TEXTURE_2D, G.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, G.fbo); gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, G.tex, 0); G.w = w; G.h = h; }
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, G.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.POLYGON_OFFSET_FILL]) gl.disable(cap);
    gl.colorMask(true, true, true, true);
    gl.useProgram(G.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, G.tex); gl.bindSampler(0, null);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, G.lut); gl.bindSampler(1, null);
    gl.uniform1i(gl.getUniformLocation(G.prog, 'u_img'), 0); gl.uniform1i(gl.getUniformLocation(G.prog, 'u_lut'), 1);
    gl.bindVertexArray(this.vao); // the default VAO has no attribute enabled
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.invalidateGlState();
  }

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
    // nothing that feeds the key changed since the last draw (programVersion: the states of the key only; the
    // stages' texture objects are read from the device at bind time)
    if (this.lastProgram && this.lastProgramVersion === dev.programVersion && this.lastProgramDev === dev) return this.lastProgram;
    // the key inputs as integers: a combination seen before (states toggled back and forth between draws) is found by
    // hash and array comparison, without building the key strings again
    const sig = this.sigBuf ?? (this.sigBuf = new Int32Array(512));
    const n = this.programSignature(sig);
    let h = 0x811c9dc5;
    for (let i = 0; i < n; i++) h = Math.imul(h ^ sig[i], 0x01000193);
    const bySig = this.progBySig ?? (this.progBySig = new Map());
    let list = bySig.get(h), r = null;
    if (list) for (const e of list) { if (e.dev !== dev || e.n !== n) continue; let i = 0; while (i < n && e.sig[i] === sig[i]) i++; if (i === n) { r = e.info; break; } }
    if (!r) {
      r = this.programUncached();
      if (!list) bySig.set(h, (list = []));
      list.push({ dev, n, sig: sig.slice(0, n), info: r });
    }
    this.lastProgram = r; this.lastProgramVersion = dev.programVersion; this.lastProgramDev = dev;
    return r;
  }
  /**
   * Every input of programUncached as integers into `sig` (the same reads, defaults and stage loop; objects by
   * identity): equal signatures give the same program and draw info. Returns the length.
   */
  programSignature(sig) {
    const dev = this.dev;
    let n = 0;
    sig[n++] = dev.api9 ? 1 : 0;
    if (dev.api9) { sig[n++] = this.objId(dev.vertexDecl); sig[n++] = dev.fvf | 0; sig[n++] = this.objId(dev.vsObj); }
    else { sig[n++] = dev.vertexShader | 0; sig[n++] = this.objId(dev.vertexShaders.get(dev.vertexShader)); }
    const ps = dev.api9 ? dev.psObj : dev.pixelShaders.get(dev.pixelShader);
    sig[n++] = this.objId(ps);
    for (let k = 0; k < SIG_RS.length; k += 2) sig[n++] = this.rs(SIG_RS[k], SIG_RS[k + 1]) | 0;
    if (dev.api9 && ps && dev.vsObj) {
      // both stages programmable: of the texture stages only the textures' kinds and the projected flag reach the
      // program (programUncached: the pixel shader key), not the fixed-function operations nor the lights
      for (let i = 0; i < 16; i++) {
        const texPtr = dev.textures[i], tex = texPtr ? this.comImpl(texPtr) : null;
        sig[n++] = (tex ? (tex.faces ? 2 : tex.depth ? 3 : 1) : 0) | (i < MAX_STAGES && (this.tss(i, TSS.TEXTURETRANSFORMFLAGS, 0) & 0x100) ? 4 : 0);
      }
      return n;
    }
    const nStages = ps && dev.api9 ? 16 : MAX_STAGES;
    for (let i = 0; i < nStages; i++) {
      const texPtr = dev.textures[i], tex = texPtr ? this.comImpl(texPtr) : null;
      sig[n++] = tex ? (tex.faces ? 2 : tex.depth ? 3 : 1) : 0;
      const colorOp = i < MAX_STAGES ? this.tss(i, TSS.COLOROP, i === 0 ? TOP.MODULATE : TOP.DISABLE) : TOP.DISABLE;
      sig[n++] = colorOp;
      sig[n++] = this.tss(i, TSS.ALPHAOP, i === 0 ? TOP.SELECTARG1 : TOP.DISABLE);
      sig[n++] = this.tss(i, TSS.TEXCOORDINDEX, i);
      for (let k = 0; k < SIG_TSS.length; k += 2) sig[n++] = this.tss(i, SIG_TSS[k], SIG_TSS[k + 1]) | 0;
      if (!ps && colorOp === TOP.DISABLE) break;
    }
    if (this.rs(RS.LIGHTING, 1) !== 0) { // (the enabled lights' types, in index order)
      const order = this.enabledLights();
      sig[n++] = order.length;
      for (const i of order) { const l = dev.lights.get(i); sig[n++] = l ? (l[0] | 0) : -1; }
    }
    return n;
  }
  /** the enabled light indices in increasing order (sorted again only after a light change) */
  enabledLights() {
    const dev = this.dev;
    if (this.lightOrderVersion !== dev.lightVersion || this.lightOrderDev !== dev) {
      const o = this.lightOrder ??= []; o.length = 0; // (the same array: light data re-sent per object moves the version)
      for (const i of dev.lightEnabled) o.push(i);
      if (o.length > 1) o.sort(byNumber);
      this.lightOrderVersion = dev.lightVersion; this.lightOrderDev = dev;
    }
    return this.lightOrder;
  }
  /** a small integer per object (program signatures compare shaders and declarations by identity) */
  objId(o) {
    if (!o) return 0;
    const ids = this.objIds ?? (this.objIds = new WeakMap());
    let id = ids.get(o);
    if (!id) ids.set(o, (id = (this.nextObjId = (this.nextObjId ?? 0) + 1)));
    return id;
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
    const vsKey = L.code ? `vs${L.dx9 ? 9 : 8}:${L.shader.handle}:${layoutKey}` : `ff:${layoutKey}:${lighting ? 1 : 0}:${lightTypes.join(',')}:${this.rs(RS.COLORVERTEX, 1)}:${this.rs(RS.DIFFUSEMATERIALSOURCE, 1)}:${this.rs(RS.SPECULARMATERIALSOURCE, 2)}:${this.rs(RS.AMBIENTMATERIALSOURCE, 0)}:${this.rs(RS.EMISSIVEMATERIALSOURCE, 0)}:${this.rs(RS.SPECULARENABLE, 0)}:${this.rs(RS.LOCALVIEWER, 1)}:${this.rs(RS.NORMALIZENORMALS, 0)}:${fog === -1 ? vertexMode : 0}:${this.rs(RS.RANGEFOGENABLE, 0)}:${stages.map((s) => `${s.tci}/${s.ttff}`).join(',')}:${this.rs(RS.VERTEXBLEND, 0)}`;
    const alphaTest = this.rs(RS.ALPHATESTENABLE, 0) ? this.rs(RS.ALPHAFUNC, 8) : 0; // applies after pixel shaders too
    const fsKey = ps ? `ps${dev.api9 ? 9 : 8}:${ps.handle}:${stages.map((s) => (s.cube ? 'c' : s.volume ? 'v' : s.projected ? 'p' : 't')).join('')}:${fog}:${alphaTest}` : `ff:${stages.map((s) => `${s.colorOp},${s.colorArg1},${s.colorArg2},${s.colorArg0},${s.alphaOp},${s.alphaArg1},${s.alphaArg2},${s.alphaArg0},${s.resultTemp ? 1 : 0},${s.cube ? 1 : 0},${s.projected ? 1 : 0},${s.bound ? 1 : 0}`).join(';')}:${alphaTest}:${this.rs(RS.SPECULARENABLE, 0)}:${fog}`;
    // D3DSHADE_FLAT: the colors of a triangle's first vertex (flat varyings; the first-vertex convention is set once)
    const flat = this.rs(RS.SHADEMODE, 2) === 1;
    const key = vsKey + '|' + fsKey + (flat ? '|flat' : '');
    let p = this.programs.get(key);
    if (p) return { p, L, stages, lighting, fog, lightTypes, ps };
    let vsSrc, attrNames;
    if (L.code && L.dx9) {
      // (the D3DCOLOR inputs, named as attrSpecs binds them: a declaration's streams, or an FVF's attributes)
      const all = L.layout.streams ? [...L.layout.streams.values()].flatMap((s) => s.attrs) : L.layout.attrs ?? [];
      const t = translateVertexShader9(L.code, new Set(all.filter((a) => a.type === 'color').map((a) => a.sem ?? FVF_SEM[a.name] ?? a.name)));
      vsSrc = t.glsl; attrNames = [...t.inputs.values()].map((n) => 'a_' + n);
    }
    else if (L.code) { vsSrc = translateVertexShader(L.code, L.layout); attrNames = [...new Set([...L.layout.streams.values()].flatMap((s) => s.attrs.map((a) => 'a_v' + a.reg)))]; }
    else {
      vsSrc = ffVertexShader({ layout: L.layout, lighting, lights: lightTypes, colorVertex: this.rs(RS.COLORVERTEX, 1) !== 0, diffuseSrc: this.rs(RS.DIFFUSEMATERIALSOURCE, 1), specularSrc: this.rs(RS.SPECULARMATERIALSOURCE, 2), ambientSrc: this.rs(RS.AMBIENTMATERIALSOURCE, 0), emissiveSrc: this.rs(RS.EMISSIVEMATERIALSOURCE, 0), specularEnable: this.rs(RS.SPECULARENABLE, 0) !== 0, localViewer: this.rs(RS.LOCALVIEWER, 1) !== 0, normalize: this.rs(RS.NORMALIZENORMALS, 0) !== 0, fogVertex: fog === -1 && !rhw ? vertexMode : 0, rangeFog: this.rs(RS.RANGEFOGENABLE, 0) !== 0, stages, rhw, blend: this.rs(RS.VERTEXBLEND, 0) ? (L.layout.blend || 1) + 1 : 0, pointSize: true });
      attrNames = L.layout.attrs.map((a) => 'a_' + a.name);
    }
    const env = { cube: stages.map((s) => s.cube), volume: stages.map((s) => s.volume), projected: stages.map((s) => s.projected), fog, alphaTest };
    let fsSrc = ps ? (dev.api9 ? translatePixelShader9(ps.code, env).glsl : translatePixelShader(ps.code, env)) : ffFragmentShader({ stages, alphaTest, specular: this.rs(RS.SPECULARENABLE, 0) !== 0, fog });
    if (flat) { vsSrc = vsSrc.replace('out vec4 v_color0; out vec4 v_color1;', 'flat out vec4 v_color0; flat out vec4 v_color1;'); fsSrc = fsSrc.replace('in vec4 v_color0; in vec4 v_color1;', 'flat in vec4 v_color0; flat in vec4 v_color1;'); }
    p = this.takePrewarmed(key, vsSrc, fsSrc, attrNames) ?? this.compile(vsSrc, fsSrc, key, attrNames);
    p.vs = L.shader; p.ps = ps;
    if (this.programs.size < 8) this.log(`d3d-webgl: program ${this.programs.size} key=${key.slice(0, 120)} attrs=${attrNames.join(',')}`);
    if (this.dumpShaders && this.programs.size < 64) this.log(`d3d-webgl: program ${this.programs.size} key=${key}${L.code ? `\nD3D VS\n${disasmShader9(L.code)}` : ''}${ps ? `\nD3D PS\n${disasmShader9(ps.code)}` : ''}\nGLSL VS\n${vsSrc}\nGLSL FS\n${fsSrc}`);
    this.programs.set(key, p);
    return { p, L, stages, lighting, fog, lightTypes, ps };
  }
  /**
   * Build a program at its first draw. The build is learned (programCache.learned: the key and sources, sent to the
   * server by the worker) so that later sessions compile it in the background before it is needed (prewarmStep).
   */
  compile(vsSrc, fsSrc, key, attrNames) {
    const t0 = performance.now();
    const p = this.finishProgram(this.startProgram(vsSrc, fsSrc, attrNames), key, attrNames, vsSrc, fsSrc);
    this.stats.programs++;
    { const ms = performance.now() - t0; this.stats.programMs = (this.stats.programMs ?? 0) + ms; this.stats.programMaxMs = Math.max(this.stats.programMaxMs ?? 0, ms); // (report: GL program builds, the frame hitches of first uses)
      if (ms > 100 && (this.slowProgramLogs = (this.slowProgramLogs ?? 0) + 1) <= 10) this.log(`d3d-webgl: program built in ${ms.toFixed(0)} ms: VS ${vsSrc.length} chars, FS ${fsSrc.length} chars, key ${key.slice(0, 160)}`); }
    const pc = this.pc;
    if (pc && pc.learned.length < 4096) pc.learned.push({ key, vs: vsSrc, fs: fsSrc, attrs: attrNames, t: Math.round(performance.now() - pc.t0) });
    return p;
  }
  /** Compile and link a program without waiting for the result (no status query: the GPU process works meanwhile). */
  startProgram(vsSrc, fsSrc, attrNames) {
    const gl = this.gl;
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const prog = gl.createProgram();
    const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    attrNames.forEach((n, i) => gl.bindAttribLocation(prog, i, n));
    gl.linkProgram(prog);
    return { prog, vs, fs };
  }
  /** The program record of a started build: link status (compile logs on failure), uniforms, sampler units. */
  finishProgram(h, key, attrNames, vsSrc, fsSrc) {
    const gl = this.gl, prog = h.prog;
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.stats.errors++;
      for (const [sh, src] of [[h.vs, vsSrc], [h.fs, fsSrc]]) if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) this.log(`d3d-webgl: shader compile error: ${gl.getShaderInfoLog(sh)}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
      this.log(`d3d-webgl: link error: ${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(h.vs); gl.deleteShader(h.fs);
    const loc = Object.create(null); // uniform name -> location (null when absent), filled from the active uniforms then on demand
    const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) { const info = gl.getActiveUniform(prog, i); loc[info.name] = gl.getUniformLocation(prog, info.name); }
    const u = (name) => { let l = loc[name]; if (l === undefined) { l = gl.getUniformLocation(prog, name); loc[name] = l; } return l; };
    // samplers: stage i always reads texture unit i (uniform values persist in the program: set once here)
    gl.useProgram(prog); this.gs.prog = prog;
    for (let i = 0; i < 16; i++) for (const n of [TEX_U.tex[i], TEX_U.cube[i], TEX_U.vol[i]]) { const l = u(n); if (l) gl.uniform1i(l, i); }
    return { prog, u, attrNames, key };
  }
  /**
   * Programs of earlier sessions (programCache.queue, from the server) compiled ahead of their first draw, a few per
   * frame: with KHR_parallel_shader_compile the GPU process builds them on its own threads while the game runs (the
   * loading screens, typically). A draw that needs one takes it when its sources are the ones it would build.
   */
  prewarmStep() {
    const pc = this.pc;
    for (let n = pc.parallel ? 8 : 2; n > 0 && pc.queue.length; n--) {
      const e = pc.queue.shift();
      if (pc.ready.has(e.key) || this.programs.has(e.key) || typeof e.vs !== 'string' || typeof e.fs !== 'string' || !Array.isArray(e.attrs)) continue;
      pc.ready.set(e.key, { ...this.startProgram(e.vs, e.fs, e.attrs), vsSrc: e.vs, fsSrc: e.fs, attrs: e.attrs });
      pc.started++;
    }
  }
  /** A prewarmed build of `key` with these very sources (taken out of the cache), or null. */
  takePrewarmed(key, vsSrc, fsSrc, attrNames) {
    const pc = this.pc, e = pc?.ready.get(key);
    if (!e) return null;
    pc.ready.delete(key);
    if (e.vsSrc === vsSrc && e.fsSrc === fsSrc && e.attrs.length === attrNames.length && e.attrs.every((a, i) => a === attrNames[i])) { pc.hits++; return this.finishProgram(e, key, attrNames, vsSrc, fsSrc); }
    // (built by another version of the translators: dropped, built again from the current sources)
    pc.stale++;
    this.gl.deleteShader(e.vs); this.gl.deleteShader(e.fs); this.gl.deleteProgram(e.prog);
    return null;
  }

  /**
   * Float constant registers into a program's uniform array: compared with the copy this program last received
   * (per program: GL keeps uniform values per program), the changed span uploaded. `slot` 0 vertex, 1 pixel.
   */
  syncConsts(P, slot, src, NAMES) {
    const U = P.u, l0 = U(NAMES[0]);
    if (!l0) return;
    const cs = P.cs ?? (P.cs = [null, null]);
    let c = cs[slot];
    if (!c || c.src !== src) { // (first use, or the device's arrays replaced): everything differs
      c = cs[slot] = { src, srcU: new Uint32Array(src.buffer, src.byteOffset, src.length), seen: new Uint32Array(src.length) };
      this.gl.uniform4fv(l0, src); c.seen.set(c.srcU);
      return;
    }
    const a = c.srcU, b = c.seen, n = a.length;
    let lo = 0; while (lo < n && a[lo] === b[lo]) lo++;
    if (lo === n) return;
    let hi = n - 1; while (a[hi] === b[hi]) hi--;
    const r0 = lo >> 2, r1 = hi >> 2;
    for (let i = r0 * 4, e = r1 * 4 + 4; i < e; i++) b[i] = a[i];
    const l = r0 ? U(NAMES[r0]) : l0; // (null: registers past the ones the program uses)
    if (l) this.gl.uniform4fv(l, src, r0 * 4, (r1 - r0 + 1) * 4);
  }
  /** A transform slot to program uniform `l`, when its version moved since this program last received it (`seen`). */
  uploadTransform(seen, slot, l, tsv, tall) {
    if (!l) return;
    const sv = Math.max(tsv.get(slot) ?? 0, tall);
    if (seen.get(slot) !== sv) { seen.set(slot, sv); this.gl.uniformMatrix4fv(l, false, this.dev.transforms.get(slot) ?? IDENTITY); }
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
    // transforms: a slot is re-uploaded to this program only when its own version moved (one SetTransform per draw
    // must not re-send the view, projection and texture matrices: at 12 k draws/s that was the top GL cost)
    const tsv = dev.transformSlotVersion, tall = dev.transformAllVersion;
    if (pv.t !== dev.transformVersion) {
      pv.t = dev.transformVersion;
      const seen = pv.ts ?? (pv.ts = new Map());
      for (let i = 0; i < 4; i++) this.uploadTransform(seen, TS_WORLD + i, U(U_WORLD[i]), tsv, tall);
      this.uploadTransform(seen, TS_VIEW, U('u_view'), tsv, tall);
      this.uploadTransform(seen, TS_PROJECTION, U('u_proj'), tsv, tall);
      for (let i = 0; i < MAX_STAGES; i++) this.uploadTransform(seen, TS_TEXTURE0 + i, U(U_TEXMAT[i]), tsv, tall);
    }
    if (pv.vp !== dev.viewportVersion) {
      pv.vp = dev.viewportVersion;
      if (U('u_viewport')) gl.uniform4f(U('u_viewport'), v.x, v.y, v.w, v.h);
      if (U('u_depthRange')) gl.uniform2f(U('u_depthRange'), v.minZ, v.maxZ);
    }
    // lights are transformed by the view matrix only: its slot version, not the whole transform group
    const viewVersion = info.lighting ? Math.max(tsv.get(TS_VIEW) ?? 0, tall) : 0;
    if (info.lighting && (pv.l !== dev.lightVersion || pv.lt !== viewVersion || pv.ls !== dev.stateVersion)) {
      pv.l = dev.lightVersion; pv.lt = viewVersion; pv.ls = dev.stateVersion;
      // each block is compared with what this program last received (a light or material re-sent per object is
      // usually the same one): only the slots that really changed reach GL
      const lv = pv.lv ?? (pv.lv = { mat: new Float32Array(20).fill(NaN), amb: -1, n: -1, slots: [], ld: new Float32Array(MAX_LIGHTS * 28) });
      const m = dev.material;
      if (!sameF32(lv.mat, m, 17)) { for (let k = 0; k < 17; k++) lv.mat[k] = m[k]; lv.mat[17] = lv.mat[18] = lv.mat[19] = 0; gl.uniform4fv(U('u_mat[0]'), lv.mat); }
      const amb = this.rs(RS.AMBIENT, 0); if (lv.amb !== amb) { lv.amb = amb; gl.uniform4fv(U('u_ambient'), colorToVec(amb, this.tmp.v4)); }
      let n = 0, dirty = 0;
      const view = dev.transforms.get(TS_VIEW) ?? IDENTITY;
      for (const i of this.enabledLights()) {
        const l = dev.lights.get(i); if (!l || n >= MAX_LIGHTS) continue;
        const slot = lv.slots[n] ?? (lv.slots[n] = { data: new Float32Array(26).fill(NaN), view: -1 });
        if (slot.view !== viewVersion || !sameF32(slot.data, l, 26)) {
          slot.view = viewVersion; for (let k = 0; k < 26; k++) slot.data[k] = l[k];
          // (packed as the shader reads it, see ffVertexShader: position and direction in view space)
          const d = lv.ld, o = n * 28;
          for (let k = 0; k < 12; k++) d[o + k] = l[1 + k];
          const px = l[13], py = l[14], pz = l[15], dx = l[16], dy = l[17], dz = l[18];
          d[o + 12] = view[0] * px + view[4] * py + view[8] * pz + view[12]; d[o + 13] = view[1] * px + view[5] * py + view[9] * pz + view[13]; d[o + 14] = view[2] * px + view[6] * py + view[10] * pz + view[14]; d[o + 15] = l[0] | 0;
          d[o + 16] = view[0] * dx + view[4] * dy + view[8] * dz; d[o + 17] = view[1] * dx + view[5] * dy + view[9] * dz; d[o + 18] = view[2] * dx + view[6] * dy + view[10] * dz; d[o + 19] = l[19];
          d[o + 20] = l[21]; d[o + 21] = l[22]; d[o + 22] = l[23]; d[o + 23] = l[20]; d[o + 24] = l[24]; d[o + 25] = l[25]; d[o + 26] = 0; d[o + 27] = 0;
          dirty = n + 1;
        }
        n++;
      }
      if (dirty) gl.uniform4fv(U('u_ld[0]'), lv.ld, 0, dirty * 28);
      if (lv.n !== n) { lv.n = n; gl.uniform1i(U('u_numLights'), n); }
    }
    if (pv.s !== dev.stateVersion) {
      // any render/stage state change bumps stateVersion: compare the raw state words with what this program last
      // received so an unrelated change (a blend mode, a texture op) does not re-send identical uniforms
      pv.s = dev.stateVersion;
      const sv = pv.sv ?? (pv.sv = {});
      const fs = this.rs(RS.FOGSTART, 0), fe = this.rs(RS.FOGEND, 0), fd = this.rs(RS.FOGDENSITY, 0);
      if (sv.fs !== fs || sv.fe !== fe || sv.fd !== fd) {
        sv.fs = fs; sv.fe = fe; sv.fd = fd;
        if (U('u_fog')) gl.uniform4f(U('u_fog'), asFloat(fs), asFloat(fe), asFloat(fd), 0);
        if (U('u_fogParams')) gl.uniform4f(U('u_fogParams'), asFloat(fs), asFloat(fe), asFloat(fd), 0);
      }
      const fc = this.rs(RS.FOGCOLOR, 0); if (sv.fc !== fc) { sv.fc = fc; if (U('u_fogColor')) gl.uniform4fv(U('u_fogColor'), colorToVec(fc, this.tmp.v4)); }
      const tf = this.rs(RS.TEXTUREFACTOR, 0xffffffff); if (sv.tf !== tf) { sv.tf = tf; if (U('u_tfactor')) gl.uniform4fv(U('u_tfactor'), colorToVec(tf, this.tmp.v4)); }
      const ar = this.rs(RS.ALPHAREF, 0) & 0xff; if (sv.ar !== ar) { sv.ar = ar; if (U('u_alphaRef')) gl.uniform1f(U('u_alphaRef'), ar / 255); }
      const ps = this.rs(RS.POINTSIZE, 0); if (sv.ps !== ps) { sv.ps = ps; if (U('u_pointSize')) gl.uniform1f(U('u_pointSize'), asFloat(ps) || 1); }
      for (let i = 0; i < MAX_STAGES; i++) {
        const l = U(U_BUMPENV[i]); if (!l) continue;
        const a = this.tss(i, TSS.BUMPENVMAT00, 0), b = this.tss(i, TSS.BUMPENVMAT01, 0), c = this.tss(i, TSS.BUMPENVMAT10, 0), d = this.tss(i, TSS.BUMPENVMAT11, 0);
        const prev = sv.bump ?? (sv.bump = new Float64Array(4 * MAX_STAGES).fill(NaN)), o = 4 * i;
        if (prev[o] !== a || prev[o + 1] !== b || prev[o + 2] !== c || prev[o + 3] !== d) { prev[o] = a; prev[o + 1] = b; prev[o + 2] = c; prev[o + 3] = d; gl.uniform4f(l, asFloat(a), asFloat(b), asFloat(c), asFloat(d)); }
      }
    }
    if (pv.c !== dev.constVersion) {
      pv.c = dev.constVersion;
      // shader constants (vertex and pixel constants have distinct uniform names): only the registers that differ
      // from what this program last received (effects change a few per draw; the whole vertex array is 4 KB)
      this.syncConsts(P, 0, dev.vsConst, U_VC);
      this.syncConsts(P, 1, dev.psConst, U_PC);
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
      const tex = this.comImpl(dev.textures[i]); // the texture bound now (the cached program info only knows its kind)
      const g = this.glTexture(tex);
      if (gs.tex[i] !== g.tex) { if (gs.active !== i) { gl.activeTexture(gl.TEXTURE0 + i); gs.active = i; } gl.bindTexture(g.target, g.tex); gs.tex[i] = g.tex; }
      // sampler objects are pooled by parameter combination: switching settings is one bindSampler
      const au = this.samp(i, SAMP.ADDRESSU, 1), av = this.samp(i, SAMP.ADDRESSV, 1), aw = this.samp(i, SAMP.ADDRESSW, 1);
      const mag = this.samp(i, SAMP.MAGFILTER, 1), min = this.samp(i, SAMP.MINFILTER, 1), mip = this.samp(i, SAMP.MIPFILTER, 0);
      const levels = st.cube ? tex.faces[0].length : tex.levels.length;
      if (this.glValidate && (au >= 4 || av >= 4 || aw >= 4 || this.samp(i, SAMP.MIPMAPLODBIAS, 0) !== 0) && (this.approxLogs ??= new Set()).size < 16) { // (--gl-validate: sampler states approximated)
        const k = `${au},${av},${aw},${this.samp(i, SAMP.MIPMAPLODBIAS, 0)}`;
        if (!this.approxLogs.has(k)) { this.approxLogs.add(k); this.log(`d3d-webgl: sampler state approximated: address ${au}/${av}/${aw} (4 border, 5 mirror once: clamped) border color ${(this.samp(i, SAMP.BORDERCOLOR, 0) >>> 0).toString(16)}, LOD bias bits 0x${(this.samp(i, SAMP.MIPMAPLODBIAS, 0) >>> 0).toString(16)} (not applied), texture ${tex.width}x${tex.height}`); }
      }
      const an = this.aniso && (min === 3 || mag === 3) ? Math.max(1, Math.min(16, this.samp(i, SAMP.MAXANISOTROPY, 1))) : 1;
      const maxLod = levels > 1 ? Math.max(0, levels - 1 - this.samp(i, SAMP.MAXMIPLEVEL, 0)) : 0;
      const skey = ((au & 7) | ((av & 7) << 3) | ((aw & 7) << 6) | ((mag & 3) << 9) | ((min & 3) << 11) | ((mip & 3) << 13) | ((levels > 1 ? 1 : 0) << 15) | ((an & 31) << 16)) + maxLod * 0x200000;
      let smp = this.samplerPool.get(skey);
      if (!smp) {
        smp = gl.createSampler(); this.samplerPool.set(skey, smp);
        const wrap = (m) => (m === 2 ? gl.MIRRORED_REPEAT : m === 3 || m === 4 || m === 5 ? gl.CLAMP_TO_EDGE : gl.REPEAT);
        gl.samplerParameteri(smp, gl.TEXTURE_WRAP_S, wrap(au)); gl.samplerParameteri(smp, gl.TEXTURE_WRAP_T, wrap(av)); gl.samplerParameteri(smp, gl.TEXTURE_WRAP_R, wrap(aw));
        gl.samplerParameteri(smp, gl.TEXTURE_MAG_FILTER, mag >= 2 ? gl.LINEAR : gl.NEAREST);
        gl.samplerParameteri(smp, gl.TEXTURE_MIN_FILTER, levels > 1 && mip ? (min >= 2 ? (mip >= 2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST) : (mip >= 2 ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST)) : (min >= 2 ? gl.LINEAR : gl.NEAREST));
        if (this.aniso) gl.samplerParameterf(smp, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, an);
        gl.samplerParameterf(smp, gl.TEXTURE_MAX_LOD, maxLod);
      }
      if (gs.smp[i] !== smp) { gl.bindSampler(i, smp); gs.smp[i] = smp; }
    }
    // depth / stencil
    const zEnable = this.rs(RS.ZENABLE, 1) !== 0;
    this.glEnable(gl.DEPTH_TEST, zEnable);
    if (zEnable) { const f = this.cmp(this.rs(RS.ZFUNC, 4)); if (gs.depthFunc !== f) { gl.depthFunc(f); gs.depthFunc = f; } }
    const zw = this.rs(RS.ZWRITEENABLE, 1) !== 0; if (gs.depthMask !== zw) { gl.depthMask(zw); gs.depthMask = zw; }
    // D3D9 DEPTHBIAS is added to the depth value itself; GL counts units of the smallest resolvable step (2^-24 on our
    // 24-bit depth buffers), same sign. D3D8 ZBIAS 0..16: a higher bias draws in front (toward the viewer).
    const zbias = dev.api9 ? this.rsF(RS9.DEPTHBIAS) * 16777216 : -this.rs(RS.ZBIAS, 0);
    const slope = dev.api9 ? this.rsF(RS9.SLOPESCALEDEPTHBIAS) : 0;
    this.glEnable(gl.POLYGON_OFFSET_FILL, !!(zbias || slope));
    if ((zbias || slope) && (gs.poSlope !== slope || gs.poBias !== zbias)) { gl.polygonOffset(slope, zbias); gs.poSlope = slope; gs.poBias = zbias; }
    const stencil = this.rs(RS.STENCILENABLE, 0) !== 0;
    this.glEnable(gl.STENCIL_TEST, stencil);
    if (stencil) { // cached: some games set up stencil for every draw
      // the reference keeps the bits of the 8-bit stencil buffer, as in Direct3D (GL clamps it instead, as a signed int:
      // a reference of 0x80808080 became 0 — a game's shadow volumes, tested against 0x80, were never counted)
      const ref = this.rs(RS.STENCILREF, 0) & 0xff, mask = this.rs(RS.STENCILMASK, 0xffffffff), wmask = this.rs(RS.STENCILWRITEMASK, 0xffffffff);
      const two = dev.api9 && this.rs(RS9.TWOSIDEDSTENCILMODE, 0);
      const f = this.rs(RS.STENCILFUNC, 8), o1 = this.rs(RS.STENCILFAIL, 1), o2 = this.rs(RS.STENCILZFAIL, 1), o3 = this.rs(RS.STENCILPASS, 1);
      const cf = two ? this.rs(RS9.CCW_STENCILFUNC, 8) : 0, c1 = two ? this.rs(RS9.CCW_STENCILFAIL, 1) : 0, c2 = two ? this.rs(RS9.CCW_STENCILZFAIL, 1) : 0, c3 = two ? this.rs(RS9.CCW_STENCILPASS, 1) : 0;
      // (compared field by field: a key string built per draw was a top source of garbage, hence of GC pauses)
      if (gs.sf !== f || gs.so1 !== o1 || gs.so2 !== o2 || gs.so3 !== o3 || gs.sref !== ref || gs.smask !== mask || gs.swmask !== wmask || gs.scf !== cf || gs.sc1 !== c1 || gs.sc2 !== c2 || gs.sc3 !== c3) {
        gs.sf = f; gs.so1 = o1; gs.so2 = o2; gs.so3 = o3; gs.sref = ref; gs.smask = mask; gs.swmask = wmask; gs.scf = cf; gs.sc1 = c1; gs.sc2 = c2; gs.sc3 = c3;
        if (two) {
          // frontFace (below) makes GL front faces the D3D clockwise ones, so the CCW_* states are GL back
          gl.stencilFuncSeparate(gl.FRONT, this.cmp(f), ref, mask);
          gl.stencilOpSeparate(gl.FRONT, this.stencilOp(o1), this.stencilOp(o2), this.stencilOp(o3));
          gl.stencilFuncSeparate(gl.BACK, this.cmp(cf), ref, mask);
          gl.stencilOpSeparate(gl.BACK, this.stencilOp(c1), this.stencilOp(c2), this.stencilOp(c3));
        } else {
          gl.stencilFunc(this.cmp(f), ref, mask);
          gl.stencilOp(this.stencilOp(o1), this.stencilOp(o2), this.stencilOp(o3));
        }
        gl.stencilMask(wmask);
      }
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
  /**
   * Debugging (--gl-validate): the cached GL state (this.gs) against the real one, queried from GL — a cache that
   * disagrees makes draws skip calls they need (wrong texture, blend or target). Mismatches are logged by kind.
   */
  validateGlState() {
    const gl = this.gl, gs = this.gs, bad = [];
    const check = (what, cached, actual) => { if (cached !== undefined && cached !== actual) bad.push(`${what}: cached ${cached} actual ${actual}`); };
    const name = (o) => (o === null ? 'null' : o === undefined ? 'undef' : (o.__id ??= (this.nextGlId = (this.nextGlId ?? 0) + 1)));
    if (gs.prog) check('program', name(gs.prog), name(gl.getParameter(gl.CURRENT_PROGRAM)));
    if (gs.vao !== undefined) check('vao', name(gs.vao), name(gl.getParameter(gl.VERTEX_ARRAY_BINDING)));
    if (gs.fbo !== undefined) check('framebuffer', name(gs.fbo), name(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)));
    if (gs.active !== undefined) check('active unit', gs.active, gl.getParameter(gl.ACTIVE_TEXTURE) - gl.TEXTURE0);
    const active = gl.getParameter(gl.ACTIVE_TEXTURE);
    for (const i of [...Array(16).keys(), this.uploadUnit]) {
      if (!gs.tex[i] && !gs.smp[i]) continue;
      gl.activeTexture(gl.TEXTURE0 + i); // (the bindings of unit i are queried through the active unit)
      if (gs.tex[i]) {
        const b = [gl.TEXTURE_BINDING_2D, gl.TEXTURE_BINDING_CUBE_MAP, gl.TEXTURE_BINDING_3D].map((q) => gl.getParameter(q));
        if (!b.includes(gs.tex[i])) bad.push(`texture unit ${i}: cached ${name(gs.tex[i])} actual ${b.map(name).join('/')}`);
      }
      if (gs.smp[i]) check(`sampler unit ${i}`, name(gs.smp[i]), name(gl.getParameter(gl.SAMPLER_BINDING)));
    }
    gl.activeTexture(active);
    for (const [cap, on] of Object.entries(gs.en)) check(`enable ${cap}`, on, gl.isEnabled(Number(cap)));
    if (gs.depthFunc !== undefined) check('depth func', gs.depthFunc, gl.getParameter(gl.DEPTH_FUNC));
    if (gs.depthMask !== undefined) check('depth mask', gs.depthMask, gl.getParameter(gl.DEPTH_WRITEMASK));
    if (gs.cw !== undefined) { const m = gl.getParameter(gl.COLOR_WRITEMASK); check('color mask', gs.cw, (m[0] ? 1 : 0) | (m[1] ? 2 : 0) | (m[2] ? 4 : 0) | (m[3] ? 8 : 0)); }
    if (gs.ff !== undefined) check('front face', gs.ff, gl.getParameter(gl.FRONT_FACE));
    if (gs.cf !== undefined) check('cull face', gs.cf, gl.getParameter(gl.CULL_FACE_MODE));
    if (gs.vpw !== undefined) { const v = gl.getParameter(gl.VIEWPORT); check('viewport', `${gs.vpx},${gs.vpy},${gs.vpw},${gs.vph}`, `${v[0]},${v[1]},${v[2]},${v[3]}`); }
    if (gs.bs !== undefined && gl.isEnabled(gl.BLEND)) check('blend src', this.blend(gs.bs), gl.getParameter(gl.BLEND_SRC_RGB));
    for (const b of bad) { this.glValidateLogs = (this.glValidateLogs ?? 0) + 1; if (this.glValidateLogs <= 40) this.log(`d3d-webgl: GL state cache mismatch (draw ${this.stats.draws}): ${b}`); }
  }
  /** enable/disable a GL capability through the state cache */
  glEnable(cap, on) { const gs = this.gs; if (gs.en[cap] === on) return; gs.en[cap] = on; if (on) this.gl.enable(cap); else this.gl.disable(cap); }
  /** forget every cached GL state (after code paths that set state without the cache: reset, clear, present) */
  invalidateGlState() {
    this.gs = { en: {}, tex: new Array(16).fill(null), smp: new Array(16).fill(null), prog: null };
    if (this.vao) { this.gl.bindVertexArray(this.vao); this.gs.vao = this.vao; } // the default VAO (cached ones keep their state)
  }
  captureDraw(P, info, v, flip) {
    const gl = this.gl; void gl;
    // (programmable pipeline: the first constant registers, with the shader listing once per program)
    if (this.dev.api9 && (this.dev.vsObj || this.dev.psObj)) {
      // (every register that is not all zero: shaders read constants anywhere in the 256)
      const regs = (arr, n) => Array.from({ length: n }, (_, r) => r).filter((r) => arr[4 * r] || arr[4 * r + 1] || arr[4 * r + 2] || arr[4 * r + 3]).map((r) => `c${r}=(${Array.from(arr.subarray(4 * r, 4 * r + 4)).map((x) => +x.toPrecision(4)).join(',')})`).join(' ');
      this.log(`d3d-webgl: [cap] constants vs ${regs(this.dev.vsConst, this.dev.vsConst.length >> 2)} | ps ${regs(this.dev.psConst, this.dev.psConst.length >> 2)}`);
      if (!(this.capListed ??= new Set()).has(P.key)) { this.capListed.add(P.key); if (this.dev.vsObj) this.log(`d3d-webgl: [cap] VS\n${disasmShader9(this.dev.vsObj.code)}`); if (this.dev.psObj) this.log(`d3d-webgl: [cap] PS\n${disasmShader9(this.dev.psObj.code)}`); }
    }
    const texStat = (t) => { const l = t.levels?.[0]; if (!l || !l.mem || l.width * l.height > 65536 || surfacePitch(t.fmt, 1) !== 4) return ''; let nz = 0, opaque = 0; const u8 = this.mem.u8; for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) { const a = u8[l.mem + y * l.pitch + x * 4 + 3]; if (a) nz++; if (a === 255) opaque++; } return `,alpha>0:${nz}/opaque:${opaque}`; };
    for (let i = 0; i < info.stages.length; i++) info.stages[i].tex = this.comImpl(this.dev.textures[i]); // (capture: the textures bound now)
    if (this.dump) for (const st of info.stages) if (st.bound && !this.dumpedTex.has(st.tex.id)) { this.dumpedTex.add(st.tex.id); this.dumpTexture(st.tex); }
    const texs = info.stages.map((st, i) => st.bound ? `${i}:#${st.tex.id}:${st.tex.fmt}/${st.tex.width}x${st.tex.height}${st.tex.usage & 1 ? 'RT' : ''}${st.tex.levels?.[0]?.mem ? '' : '(nomem)'}${texStat(st.tex)}` : '').filter(Boolean).join(' ');
    this.log(`d3d-webgl: [cap] ${flip ? 'FBO' : 'back'} vp=${v.x},${v.y},${v.w},${v.h} prog=${P.key.slice(0, 90)} tex=[${texs}] blend=${this.rs(RS.ALPHABLENDENABLE, 0)}:${this.rs(RS.SRCBLEND, 2)}/${this.rs(RS.DESTBLEND, 1)} atest=${this.rs(RS.ALPHATESTENABLE, 0)}:${this.rs(RS.ALPHAFUNC, 8)}/${this.rs(RS.ALPHAREF, 0)} z=${this.rs(RS.ZENABLE, 1)}/${this.rs(RS.ZWRITEENABLE, 1)}/${this.rs(RS.ZFUNC, 4)} zb=${this.dev.api9 ? this.rsF(RS9.DEPTHBIAS) + '/' + this.rsF(RS9.SLOPESCALEDEPTHBIAS) : this.rs(RS.ZBIAS, 0)} st=${this.rs(RS.STENCILENABLE, 0)}${this.rs(RS.STENCILENABLE, 0) ? `[f${this.rs(RS.STENCILFUNC, 8)} ref${this.rs(RS.STENCILREF, 0)} m${(this.rs(RS.STENCILMASK, 0xffffffff) >>> 0).toString(16)} wm${(this.rs(RS.STENCILWRITEMASK, 0xffffffff) >>> 0).toString(16)} ops${this.rs(RS.STENCILFAIL, 1)}/${this.rs(RS.STENCILZFAIL, 1)}/${this.rs(RS.STENCILPASS, 1)}${this.dev.api9 && this.rs(RS9.TWOSIDEDSTENCILMODE, 0) ? ` ccw:f${this.rs(RS9.CCW_STENCILFUNC, 8)} ops${this.rs(RS9.CCW_STENCILFAIL, 1)}/${this.rs(RS9.CCW_STENCILZFAIL, 1)}/${this.rs(RS9.CCW_STENCILPASS, 1)}` : ''}]` : ''} cull=${this.rs(RS.CULLMODE, 3)} cw=${this.rs(RS.COLORWRITEENABLE, 0xf)} tf=${(this.rs(RS.TEXTUREFACTOR, 0xffffffff) >>> 0).toString(16)} fog=${info.fog} vs=${info.L.code ? 'yes' : 'ff'} ps=${info.ps ? 'yes' : 'ff'}`);
  }
  /** Frame capture: a texture's level 0 as a PNG (render-target textures are read back from their FBO). */
  dumpTexture(t) {
    const l = t.levels?.[0] ?? t.faces?.[0]?.[0]; if (!l) return;
    const name = `f${this.frame}-tex${t.id}-${l.width}x${l.height}-fmt${t.fmt}${t.usage & 1 ? '-rt' : ''}`;
    if (l.history?.length) this.log(`d3d-webgl: [cap] texture #${t.id} level 0 history:\n  ${l.historyText().join('\n  ')}`);
    if (l.mem && !(t.usage & 1)) {
      const levels = t.levels ?? [l];
      levels.forEach((m, i) => { if (m.mem && m.width * m.height >= 4) this.dump(name + (i ? `-mip${i}` : ''), m.width, m.height, surfaceToRgba(this.mem, m.fmt ?? t.fmt, m.mem, m.width, m.height, m.pitch)); });
      if (t.levels && !isDxt(t.fmt)) this.checkTextureCoherence(t);
      return;
    }
    const f = this.fbos.get(l.id); if (!f) return;
    const gl = this.gl, rgba = new Uint8Array(f.w * f.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo); this.gs.fbo = f.fbo; gl.readPixels(0, 0, f.w, f.h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    this.bindTarget(); // restore the current target
    this.dump(name, f.w, f.h, rgba); // texture targets are stored with D3D row order already
  }
  /**
   * Frame capture: each level of the GL texture read back (through a framebuffer) and compared with the texels in
   * guest memory — a stale or mis-uploaded level shows here (uncompressed 2D textures, levels up to date only).
   */
  checkTextureCoherence(t) {
    const g = this.textures.get(t.id); if (!g || g.target !== this.gl.TEXTURE_2D) return;
    const gl = this.gl, fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); this.gs.fbo = fbo;
    const report = [];
    t.levels.forEach((m, i) => {
      if (!m.mem || m.dirty || !m.uploaded) return;
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.tex, i);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return;
      const got = new Uint8Array(m.width * m.height * 4); gl.readPixels(0, 0, m.width, m.height, gl.RGBA, gl.UNSIGNED_BYTE, got);
      const want = surfaceToRgba(this.mem, m.fmt ?? t.fmt, m.mem, m.width, m.height, m.pitch);
      let bad = 0, first = -1;
      for (let p = 0; p < got.length; p += 4) if (Math.abs(got[p] - want[p]) > 2 || Math.abs(got[p + 1] - want[p + 1]) > 2 || Math.abs(got[p + 2] - want[p + 2]) > 2 || Math.abs(got[p + 3] - want[p + 3]) > 2) { bad++; if (first < 0) first = p; }
      if (bad) report.push(`level ${i} ${m.width}x${m.height}: ${bad} texels differ (first at ${(first / 4) % m.width},${Math.floor(first / 4 / m.width)}: gl ${got.slice(first, first + 4).join(',')} mem ${want.slice(first, first + 4).join(',')})`);
    });
    gl.deleteFramebuffer(fbo);
    this.bindTarget(); // (restores the framebuffer binding of the current target)
    this.log(`d3d-webgl: [cap] texture #${t.id} GL vs guest memory: ${report.length ? report.join('; ') : 'identical'}`);
  }
  /** Frame capture: the current render target after a draw (`--capture-draws`). */
  dumpTarget(what) {
    if (!this.dump || !this.captureDraws) return;
    const gl = this.gl, { w, h, flip } = this.bindTarget(), rgba = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    if (!flip) { const row = w * 4, tmp = new Uint8Array(row); for (let y = 0; y < h >> 1; y++) { const a = y * row, b = (h - 1 - y) * row; tmp.set(rgba.subarray(a, a + row)); rgba.copyWithin(a, b, b + row); rgba.set(tmp, b); } }
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    this.captureSeq = (this.captureSeq ?? 0) + 1; // (a frame may have several scenes: frameDraws restarts at each)
    this.dump(`f${this.frame}-draw${String(this.captureSeq).padStart(4, '0')}-${what}`, w, h, rgba);
  }
  // (the Direct3D -> GL enum tables are built once per context: these run for every draw)
  cmp(f) { const gl = this.gl; return (this.cmpTable ??= [gl.ALWAYS, gl.NEVER, gl.LESS, gl.EQUAL, gl.LEQUAL, gl.GREATER, gl.NOTEQUAL, gl.GEQUAL, gl.ALWAYS])[f] ?? gl.ALWAYS; }
  stencilOp(o) { const gl = this.gl; return (this.stencilOpTable ??= [gl.KEEP, gl.KEEP, gl.ZERO, gl.REPLACE, gl.INCR, gl.DECR, gl.INVERT, gl.INCR_WRAP, gl.DECR_WRAP])[o] ?? gl.KEEP; }
  blend(b) { const gl = this.gl; return (this.blendTable ??= [gl.ZERO, gl.ZERO, gl.ONE, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR, gl.SRC_ALPHA_SATURATE, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.CONSTANT_COLOR, gl.ONE_MINUS_CONSTANT_COLOR])[b] ?? gl.ONE; }

  /**
   * Bind the vertex attributes of the current layout from the device's streams (or a UP buffer) through a cached
   * vertex array object, so a draw that repeats a known combination costs one bindVertexArray instead of a buffer
   * bind, enable/disable and pointer call per attribute. One stream (the common case): one VAO per (program, buffer,
   * stride), found by numbers, whose attribute offsets are re-pointed when the draw's base offset moves (dynamic
   * buffers filled at a moving position: a VAO per base offset was created for ~2% of all draws, then all of them
   * dropped every 8192). Several streams or a UP draw: one VAO per (program, buffers, strides, base offsets).
   */
  bindAttributes(P, L, upStride = 0, baseVertex = 0) {
    const gl = this.gl, dev = this.dev;
    const vaos = this.vaos ?? (this.vaos = new Map());
    if (P.vid === undefined) { P.vid = this.nextVid = (this.nextVid ?? 0) + 1; P.vaoKeys = []; }
    const streams = L.layout.streamList ?? (L.layout.streamList = L.layout.streams ? [...L.layout.streams] : [[0, { attrs: L.layout.attrs, stride: L.layout.stride }]]);
    if (!upStride && streams.length === 1) {
      const s0 = streams[0], s = dev.streams[s0[0]], vb = s ? this.comImpl(s.vb) : null;
      if (vb) {
        const stride = s.stride || s0[1].stride, base = (s.offset ?? 0) + baseVertex * stride;
        const buf = this.glBuffer(vb, 'vb').buf; // uploads pending data (ARRAY_BUFFER binding is not VAO state)
        const byVb = P.vaoByVb ?? (P.vaoByVb = new Map());
        let m = byVb.get(vb.id), v = m?.get(stride);
        if (v && vaos.get(v.key) !== v) v = null; // (dropped since)
        if (!v) {
          if (vaos.size >= 8192) { this.dropVaos(); m = null; }
          const key = `${P.vid}|${vb.id}:${stride}`;
          v = { vao: gl.createVertexArray(), ib: null, key, bufs: [vb.id], P, base: NaN, specs: this.attrSpecs(P, L, s0[1].attrs) };
          this.stats.vaos++;
          vaos.set(key, v); P.vaoKeys.push(key);
          if (!m) byVb.set(vb.id, (m = new Map()));
          m.set(stride, v);
          let set = (this.vaosByBuf ??= new Map()).get(vb.id); if (!set) this.vaosByBuf.set(vb.id, (set = new Set())); set.add(key);
          gl.bindVertexArray(v.vao); this.gs.vao = v.vao;
          for (let i = 0; i < v.specs.length; i += 5) gl.enableVertexAttribArray(v.specs[i]);
        } else if (this.gs.vao !== v.vao) { gl.bindVertexArray(v.vao); this.gs.vao = v.vao; }
        if (v.base !== base) {
          const sp = v.specs;
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          for (let i = 0; i < sp.length; i += 5) gl.vertexAttribPointer(sp[i], sp[i + 1], sp[i + 2], sp[i + 3] !== 0, stride, base + sp[i + 4]);
          v.base = base;
        }
        this.curVao = v;
        return true;
      }
    }
    // a UP draw (vertices from memory through the shared upVbo): its VAO found by the stride, no key string per draw
    if (upStride && streams.length === 1) {
      const v = P.upVaos?.get(upStride);
      if (v && vaos.get(v.key) === v) { if (this.gs.vao !== v.vao) { gl.bindVertexArray(v.vao); this.gs.vao = v.vao; } this.curVao = v; return true; }
    }
    let key = upStride ? `${P.vid}|up${upStride}` : `${P.vid}`;
    const bound = []; // [n, attrs, stride, base, glBuffer, resource id]
    for (const [n, st] of streams) {
      if (upStride) { bound.push([n, st.attrs, upStride, 0, this.upVbo, -1]); continue; }
      const s = dev.streams[n], vb = this.comImpl(s?.vb);
      if (!vb) continue;
      const stride = s.stride || st.stride, base = (s.offset ?? 0) + baseVertex * stride;
      const buf = this.glBuffer(vb, 'vb').buf; // uploads pending data (ARRAY_BUFFER binding is not VAO state)
      key += `|${vb.id}:${stride}:${base}`;
      bound.push([n, st.attrs, stride, base, buf, vb.id]);
    }
    let v = vaos.get(key);
    if (!v) {
      if (vaos.size >= 8192) this.dropVaos();
      v = { vao: gl.createVertexArray(), ib: null, key, bufs: bound.map((b) => b[5]).filter((x) => x >= 0), P };
      this.stats.vaos++;
      vaos.set(key, v); P.vaoKeys.push(key);
      if (upStride && streams.length === 1) (P.upVaos ??= new Map()).set(upStride, v);
      for (const id of v.bufs) { let set = (this.vaosByBuf ??= new Map()).get(id); if (!set) this.vaosByBuf.set(id, (set = new Set())); set.add(key); }
      gl.bindVertexArray(v.vao); this.gs.vao = v.vao;
      for (const [, attrs, stride, base, buf] of bound) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        const sp = this.attrSpecs(P, L, attrs);
        for (let i = 0; i < sp.length; i += 5) { gl.enableVertexAttribArray(sp[i]); gl.vertexAttribPointer(sp[i], sp[i + 1], sp[i + 2], sp[i + 3] !== 0, stride, base + sp[i + 4]); }
      }
    } else if (this.gs.vao !== v.vao) { gl.bindVertexArray(v.vao); this.gs.vao = v.vao; }
    this.curVao = v;
    return true;
  }
  /**
   * The attribute pointers of `attrs` (one stream's layout) for program P, flat: location, components, GL type,
   * normalized (0/1), offset in the vertex; attributes the program does not read are left out. Cached per program.
   */
  attrSpecs(P, L, attrs) {
    const cache = P.attrSpecs ?? (P.attrSpecs = new Map());
    let sp = cache.get(attrs);
    if (sp) return sp;
    const gl = this.gl, out = [];
    for (const a of attrs) {
      const name = L.code && L.dx9 ? 'a_' + (a.sem ?? FVF_SEM[a.name] ?? a.name) : L.code ? 'a_v' + a.reg : 'a_' + a.name;
      const loc = P.attrNames.indexOf(name);
      if (loc < 0) continue;
      const type = a.type === 'color' || a.type === 'ubyte4' || a.type === 'ubyte4n' ? gl.UNSIGNED_BYTE : a.type === 'short' || a.type === 'shortn' ? gl.SHORT : a.type === 'ushortn' ? gl.UNSIGNED_SHORT : a.type === 'half' ? gl.HALF_FLOAT : gl.FLOAT;
      const norm = a.type === 'color' || a.type === 'ubyte4n' || a.type === 'shortn' || a.type === 'ushortn';
      out.push(loc, a.comps, type, norm ? 1 : 0, a.offset);
    }
    sp = Int32Array.from(out); cache.set(attrs, sp);
    return sp;
  }
  /** Bind an index buffer into the current VAO (element array bindings are VAO state). */
  bindIndices(buf) { if (this.curVao.ib !== buf) { this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, buf); this.curVao.ib = buf; } }
  /** Forget cached VAOs (all, or those of one buffer resource / one program). */
  dropVaos(bufId, P) {
    const keys = bufId !== undefined ? [...(this.vaosByBuf?.get(bufId) ?? [])] : P ? P.vaoKeys ?? [] : [...(this.vaos?.keys() ?? [])];
    for (const k of keys) { const v = this.vaos.get(k); if (!v) continue; if (this.gs.vao === v.vao) { this.gl.bindVertexArray(this.vao); this.gs.vao = this.vao; } this.gl.deleteVertexArray(v.vao); this.vaos.delete(k); if (bufId !== undefined) v.P?.vaoByVb?.delete(bufId); }
    if (bufId !== undefined) this.vaosByBuf?.delete(bufId);
    if (bufId === undefined && !P) this.vaosByBuf?.clear();
  }
  glMode(type) { const gl = this.gl; return (this.modeTable ??= [0, gl.POINTS, gl.LINES, gl.LINE_STRIP, gl.TRIANGLES, gl.TRIANGLE_STRIP, gl.TRIANGLE_FAN])[type] ?? gl.TRIANGLES; }
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
    if (this.glValidate && (this.stats.draws < 3000 || this.stats.draws % 97 === 0)) this.validateGlState();
    gl.drawArrays(this.glMode(type), start, this.vertexCount(type, count));
    this.stats.draws++; this.frameDraws++;
    if (this.capturing) this.dumpTarget('dp');
    if (this.stats.draws <= 64) this.checkErrors(`drawPrimitive(${type}, ${start}, ${count}) program ${P.key.slice(0, 60)} attrs ${P.attrNames.join(',')}`); // (the message is built only while it is checked)
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
    this.bindIndices(this.glBuffer(ib, 'ib').buf);
    const short = ib.fmt === FMT.INDEX16;
    if (this.capturing) {
      const st = dev.streams[0], vb = this.comImpl(st.vb), stride = st.stride || info.L.layout.stride || 0, short = ib.fmt === FMT.INDEX16;
      const idx = (i) => short ? this.mem.read16(ib.mem + 2 * (start + i)) : this.mem.read32(ib.mem + 4 * (start + i));
      const vtx = (i) => { if (!vb) return '?'; const a = vb.mem + (st.offset ?? 0) + (baseVertex + idx(i)) * stride; const L = info.L.layout; const dif = L.attrs?.find((x) => x.name === 'diffuse'); return `i${idx(i)}:` + Array.from({ length: 2 }, (_, k) => this.mem.readF32(a + 4 * k).toFixed(1)).join(',') + (dif ? ' c=' + (this.mem.read32(a + dif.offset) >>> 0).toString(16) : ''); };
      // texture coordinate ranges over the vertices referenced by the draw (flat-looking surfaces: degenerate UVs?)
      const uvr = []; const L = info.L.layout;
      for (const a of (L.attrs ?? []).filter((x) => x.name.startsWith('tex'))) { const sn = [...(L.streams?.entries() ?? [[0, { attrs: L.attrs }]])].find(([, s2]) => s2.attrs.includes(a))?.[0] ?? 0; const s2 = dev.streams[sn], vb2 = this.comImpl(s2?.vb); if (!vb2 || a.type !== 'float') continue; const str = s2.stride || L.stride || 0; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity; const nIdx = Math.min(this.vertexCount(type, count), 30000); for (let i = 0; i < nIdx; i++) { const p = vb2.mem + (s2.offset ?? 0) + (baseVertex + idx(i)) * str + a.offset; const u = this.mem.readF32(p), v = a.comps > 1 ? this.mem.readF32(p + 4) : 0; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; } uvr.push(`${a.name}=[${u0.toFixed(3)}..${u1.toFixed(3)} x ${v0.toFixed(3)}..${v1.toFixed(3)}]`); }
      // full attribute dump of the first vertices (stream 0, float attributes) for offline checks
      let vdump = '';
      if (L.attrs && vb) { const str0 = st.stride || L.stride || 0; for (let i = 0; i < Math.min(6, this.vertexCount(type, count)); i++) { const a0 = vb.mem + (st.offset ?? 0) + (baseVertex + idx(i)) * str0; vdump += ` v${i}(i${idx(i)})=` + L.attrs.map((a) => a.name + ':' + (a.type === 'float' ? Array.from({ length: a.comps }, (_, k) => +this.mem.readF32(a0 + a.offset + 4 * k).toPrecision(6)).join(',') : (this.mem.read32(a0 + a.offset) >>> 0).toString(16))).join(' '); } }
      this.log(`d3d-webgl: [cap] drawIndexedPrimitive type ${type} base ${baseVertex} start ${start} prims ${count} numV ${numV} tri0=[${vtx(0)} ${vtx(1)} ${vtx(2)}] ${uvr.join(' ')} stride=${st.stride} off=${st.offset ?? 0} fvf=${this.dev.fvf}${vdump} tss=${info.stages.map((st, i) => `${i}:${st.colorOp}/${st.colorArg1},${st.colorArg2}|${st.alphaOp}/${st.alphaArg1},${st.alphaArg2} tci${st.tci} ttff${st.ttff}`).join(' ')}${info.stages.map((st, i) => (st.ttff & 0xff) ? ` texmat${i}=[${Array.from(dev.transforms.get(TS_TEXTURE0 + i) ?? IDENTITY).map((x) => +x.toPrecision(4)).join(',')}]` : '').join('')} world=[${Array.from(dev.transforms.get(TS_WORLD) ?? IDENTITY).map((x) => +x.toPrecision(4)).join(',')}] view=[${Array.from(dev.transforms.get(TS_VIEW) ?? IDENTITY).map((x) => +x.toPrecision(4)).join(',')}]`);
    }
    if (this.glValidate && (this.stats.draws < 3000 || this.stats.draws % 97 === 0)) this.validateGlState();
    gl.drawElements(this.glMode(type), this.vertexCount(type, count), short ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, start * (short ? 2 : 4));
    this.stats.draws++; this.frameDraws++;
    if (this.capturing) this.dumpTarget('dip');
    void minIdx;
  }
  /** Upload `n` bytes of guest memory at `addr` into the buffer bound to `target` (the UP draws' shared buffers). */
  streamData(target, addr, n) { if (n > 0) this.gl.bufferData(target, this.mem.u8, this.gl.STREAM_DRAW, addr >>> 0, n); else this.gl.bufferData(target, 0, this.gl.STREAM_DRAW); }
  drawPrimitiveUP(type, count, data, stride) {
    const gl = this.gl;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    const n = this.vertexCount(type, count);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upVbo);
    this.streamData(gl.ARRAY_BUFFER, data, n * stride);
    if (!this.bindAttributes(P, info.L, stride)) return;
    if (this.capturing) this.log(`d3d-webgl: [cap] drawPrimitiveUP type ${type} prims ${count} stride ${stride}`);
    gl.drawArrays(this.glMode(type), 0, n);
    this.stats.draws++; this.frameDraws++;
    if (this.capturing) this.dumpTarget('dpup');
  }
  drawIndexedPrimitiveUP(type, minIdx, numV, count, idx, ifmt, data, stride) {
    const gl = this.gl;
    const info = this.program(); const P = info.p;
    this.applyState(P, info);
    const n = this.vertexCount(type, count);
    const short = ifmt === FMT.INDEX16;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upVbo);
    this.streamData(gl.ARRAY_BUFFER, data, (minIdx + numV) * stride);
    if (!this.bindAttributes(P, info.L, stride)) return;
    this.bindIndices(this.upIbo);
    this.streamData(gl.ELEMENT_ARRAY_BUFFER, idx, n * (short ? 2 : 4));
    if (this.capturing) this.log(`d3d-webgl: [cap] drawIndexedPrimitiveUP type ${type} prims ${count} numV ${numV} stride ${stride}`);
    gl.drawElements(this.glMode(type), n, short ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, 0);
    this.stats.draws++; this.frameDraws++;
    if (this.capturing) this.dumpTarget('dipup');
  }
}

/** Host-side factory: `host.gfx = createWebGLBackend(canvas, log)`. */
export function createWebGLBackend(canvas, log, dump) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: true, stencil: true, preserveDrawingBuffer: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  // benchmark mode (--gl-discard): every GL call is still issued but nothing is rasterized, so a software GPU
  // (headless SwiftShader) no longer bounds the frame rate and CPU-side changes become measurable
  if (globalThis.ORTHROS_GL_DISCARD) gl.enable(gl.RASTERIZER_DISCARD);
  // a lost context (GPU reset, driver update, memory pressure) is restored by the browser when allowed
  // (preventDefault); the device then recreates its GL objects
  canvas.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); log('d3d-webgl: WebGL context lost'); });
  canvas.addEventListener?.('webglcontextrestored', () => { if (globalThis.ORTHROS_GL_DISCARD) gl.enable(gl.RASTERIZER_DISCARD); backend.device?.contextRestored(); });
  // programs learned by earlier sessions, compiled ahead (queue: from the server; ready: started builds by key) and the
  // programs this session had to build at a draw (learned: sent to the server by the worker)
  const programCache = { queue: [], ready: new Map(), learned: [], t0: performance.now(), parallel: !!gl.getExtension('KHR_parallel_shader_compile'), started: 0, hits: 0, stale: 0 };
  const backend = { gl, device: null, programCache, createDevice(dev) { return this.device = new WebGLDevice(gl, dev, { log, dumpShaders: globalThis.ORTHROS_DUMP_SHADERS, captureFrame: globalThis.ORTHROS_CAPTURE_FRAME, captureDraws: globalThis.ORTHROS_CAPTURE_DRAWS, dump, noCull: globalThis.ORTHROS_NO_CULL, programCache }); } };
  return backend;
}
