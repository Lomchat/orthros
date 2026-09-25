// D3DX 9 (d3dx9_24.dll ... d3dx9_43.dll): the helper library of the DirectX SDK that games ship against — math,
// texture loading from image files in memory, shader helpers, buffers and the effect framework (d3dx9-effect.js).
// One implementation answers to every numbered DLL name (the export sets differ only by additions).
import { FMT, surfaceBytes, surfacePitch, readShaderTokens } from './d3d8.js';
import { fvfLayout } from '../gfx/d3d8-shaders.js';
import { defineD3DXMath } from './d3dx9-math.js';
import { parseImage, toRgba, fromRgba, resizeRgba, applyColorKey, isDxt } from './d3dx9-image.js';
import { defineEffects } from './d3dx9-effect.js';
import { assembleShader } from './d3dx9-asm.js';

const D3D_OK = 0, D3DERR_INVALIDCALL = 0x8876086c, D3DXERR_INVALIDDATA = 0x88760b59, E_OUTOFMEMORY = 0x8007000e, E_NOTIMPL = 0x80004001;
const D3DX_DEFAULT = 0xffffffff, D3DX_DEFAULT_NONPOW2 = 0xfffffffe, D3DX_FROM_FILE = 0xfffffffd;
/** D3DX_FILTER: low byte = filter kind (1 NONE, 2 POINT, 3 LINEAR, 4 TRIANGLE, 5 BOX) */
const FILTER_POINT = 2;

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerD3DX9(api, vm) {
  const mem = vm.mem, com = vm.com;
  const X = {};
  defineD3DXMath(X, mem);

  // ---------------------------------------------------------------- ID3DXBuffer
  com.interface('ID3DXBuffer', '8ba5fb08-5195-40e2-ac58-0d989c3a0102', 'IUnknown', [['GetBufferPointer', 0], ['GetBufferSize', 0]]);
  class DxBuffer {
    constructor(proc, n) { this.proc = proc; this.size = n; this.addr = proc.vmem.alloc(Math.max(16, n), 4, 'd3dx:buffer'); }
    GetBufferPointer() { return this.addr; }
    GetBufferSize() { return this.size; }
    destroy() { this.proc.vmem.release(this.addr); }
  }
  /** a new ID3DXBuffer holding `bytes` (Uint8Array) or `n` zero bytes */
  const newBuffer = (c, bytes, n = bytes?.length ?? 0) => { const b = new DxBuffer(c.proc, n); if (bytes) mem.writeBytes(b.addr, bytes); return com.create(c.proc, 'ID3DXBuffer', b); };
  const textBuffer = (c, s) => newBuffer(c, Uint8Array.from(s + '\0', (ch) => ch.charCodeAt(0) & 0xff));
  X.D3DXCreateBuffer = [2, (c) => { if (!c.arg(1)) return D3DERR_INVALIDCALL; mem.write32(c.arg(1), newBuffer(c, null, c.arg(0))); return D3D_OK; }];
  vm.d3dx = { newBuffer, textBuffer };

  // ---------------------------------------------------------------- calling device methods from D3DX
  /** A context for a COM method called by D3DX itself: arguments laid out on a scratch stack in guest memory. */
  const callMethod = (c, thisPtr, method, args) => {
    const impl = com.implAt(thisPtr);
    if (!impl || typeof impl[method] !== 'function') return D3DERR_INVALIDCALL;
    const scratch = c.proc.d3dxScratch ?? (c.proc.d3dxScratch = c.proc.processHeap.alloc(256));
    mem.write32(scratch, c.retAddr); mem.write32(scratch + 4, thisPtr);
    for (let i = 0; i < args.length; i++) mem.write32(scratch + 8 + 4 * i, args[i] >>> 0);
    const cc = Object.create(Object.getPrototypeOf(c)); Object.assign(cc, c); cc.sp = scratch;
    const r = impl[method](cc, com.objectAt(thisPtr));
    return r === undefined ? D3D_OK : r;
  };
  const outSlot = (c) => (c.proc.d3dxOut ??= c.proc.processHeap.alloc(16));

  // ---------------------------------------------------------------- misc
  X.D3DXGetFVFVertexSize = [1, (c) => fvfLayout(c.arg(0)).stride];
  X.D3DXGetDeclVertexSize = [2, (c) => { let size = 0; for (let p = c.arg(0); mem.read16(p) !== 0xff; p += 8) { if (mem.read16(p) !== c.arg(1)) continue; size = Math.max(size, mem.read16(p + 2) + DECLTYPE_SIZE[mem.read8(p + 4)]); } return size; }];
  X.D3DXGetDeclLength = [1, (c) => { let n = 0; for (let p = c.arg(0); mem.read16(p) !== 0xff && n < 64; p += 8) n++; return n; }];
  X.D3DXDeclaratorFromFVF = [2, (c) => { const L = fvfLayout(c.arg(0)), p = c.arg(1); let n = 0; for (const a of L.attrs) { const d = p + 8 * n++; mem.write16(d, 0); mem.write16(d + 2, a.offset); mem.write8(d + 4, a.type === 'color' ? 4 : a.comps - 1); mem.write8(d + 5, 0); const [u, i] = FVF_USAGE(a.name); mem.write8(d + 6, u); mem.write8(d + 7, i); } const e = p + 8 * n; mem.write16(e, 0xff); mem.write16(e + 2, 0); mem.write32(e + 4, 17); return D3D_OK; }];
  // shader bytecode helpers (the token stream of vs/ps 1.x-3.0)
  const shaderTokens = (p) => readShaderTokens(mem, p);
  const semantics = (p, input) => {
    const t = shaderTokens(p), ps = (t[0] >>> 16) === 0xffff, major = (t[0] >> 8) & 0xff, res = [];
    for (let i = 1; i < t.length && t[i] !== 0x0000ffff;) {
      const tok = t[i], op = tok & 0xffff;
      if (op === 0xfffe) { i += 1 + ((tok >>> 16) & 0x7fff); continue; } // comment
      const len = major >= 2 ? (tok >>> 24) & 0x0f : null;
      if (op === 0x1f) { // dcl
        const u = t[i + 1], reg = t[i + 2], rtype = ((reg >> 28) & 7) | ((reg >> 8) & 0x18);
        if ((input && rtype === (ps && major < 3 ? 3 : 1)) || (!input && rtype === 6)) res.push([u & 0x1f, (u >> 16) & 0xf]);
        i += 3; continue;
      }
      if (len !== null) { i += 1 + len; continue; }
      i++; while (i < t.length && (t[i] & 0x80000000) && t[i] !== 0x0000ffff) i++; // (1.x: parameter tokens have bit 31 set)
    }
    return res;
  };
  const getSemantics = (c, input) => { const out = c.arg(1), s = semantics(c.arg(0), input); if (out) s.forEach(([u, i], k) => { mem.write32(out + 8 * k, u); mem.write32(out + 8 * k + 4, i); }); if (c.arg(2)) mem.write32(c.arg(2), s.length); return D3D_OK; };
  X.D3DXGetShaderInputSemantics = [3, (c) => getSemantics(c, true)];
  X.D3DXGetShaderOutputSemantics = [3, (c) => getSemantics(c, false)];
  X.D3DXGetShaderVersion = [1, (c) => (c.arg(0) ? mem.read32(c.arg(0)) : 0)];
  X.D3DXGetShaderSize = [1, (c) => 4 * shaderTokens(c.arg(0)).length];
  X.D3DXGetVertexShaderProfile = [1, () => profileString(vm, 'vs_2_0')];
  X.D3DXGetPixelShaderProfile = [1, () => profileString(vm, 'ps_2_0')];

  // ---------------------------------------------------------------- textures
  /** D3DXIMAGE_INFO: Width, Height, Depth, MipLevels, Format, ResourceType, ImageFileFormat */
  const writeInfo = (p, im) => { if (!p) return; mem.write32(p, im.width); mem.write32(p + 4, im.height); mem.write32(p + 8, im.depth); mem.write32(p + 12, im.mips); mem.write32(p + 16, im.infoFmt ?? im.fmt); mem.write32(p + 20, im.kind === 'cube' ? 5 : im.kind === 'volume' ? 4 : 3); mem.write32(p + 24, im.fileFormat); };
  const imageAt = (c, a, n) => { if (!a || !n) return null; try { return parseImage(mem.bytes(a, n).slice()); } catch (e) { vm.log('gfx', `d3dx: image decode failed: ${e.message}`); return null; } };
  X.D3DXGetImageInfoFromFileInMemory = [3, (c) => { const im = imageAt(c, c.arg(0), c.arg(1)); if (!im) return D3DXERR_INVALIDDATA; writeInfo(c.arg(2), im); return D3D_OK; }];
  const TEXTURE_OK = new Set([FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.A8, FMT.L8, FMT.A8L8, FMT.DXT1, FMT.DXT2, FMT.DXT3, FMT.DXT4, FMT.DXT5, FMT.V8U8, FMT.Q8W8V8U8]);
  /** the texture format D3DX picks for a requested one and the file's: a format the device takes (R8G8B8 -> X8R8G8B8...) */
  const pickFormat = (req, file) => {
    let f = req === 0 || req === D3DX_FROM_FILE ? file : req;
    if (!TEXTURE_OK.has(f)) f = f === FMT.R8G8B8 || f === 33 || f === FMT.P8 ? FMT.X8R8G8B8 : f === FMT.A8B8G8R8 || f === FMT.A2B10G10R10 ? FMT.A8R8G8B8 : f === FMT.X4R4G4B4 ? FMT.A4R4G4B4 : TEXTURE_OK.has(file) ? file : FMT.A8R8G8B8;
    return f;
  };
  const fullChain = (...dims) => { let n = 1, s = Math.max(...dims); while (s > 1) { s >>= 1; n++; } return n; };
  /** level `i` of `im` (face f) converted to `fmt` at w x h x d (null when impossible) */
  const levelData = (im, f, i, fmt, w, h, d, filter, colorKey) => {
    const src = im.images[f][Math.min(i, im.mips - 1)];
    const sw = Math.max(1, im.width >> Math.min(i, im.mips - 1)), sh = Math.max(1, im.height >> Math.min(i, im.mips - 1)), sd = Math.max(1, im.depth >> Math.min(i, im.mips - 1));
    if (i < im.mips && sw === w && sh === h && sd === d && fmt === im.fmt && !colorKey) return src;
    // through RGBA8 (slice by slice for volumes)
    const out = new Uint8Array(surfaceBytes(fmt, w, h) * d);
    for (let z = 0; z < d; z++) {
      const sz = Math.min(sd - 1, Math.floor(z * sd / d)), sliceBytes = surfaceBytes(im.fmt, sw, sh);
      let rgba = toRgba(im.fmt, src.subarray(sz * sliceBytes, (sz + 1) * sliceBytes), sw, sh);
      if (colorKey) rgba = applyColorKey(rgba.slice(), colorKey);
      rgba = resizeRgba(rgba, sw, sh, w, h, (filter & 0xff) === FILTER_POINT);
      const enc = fromRgba(fmt, rgba, w, h);
      if (!enc) return null;
      out.set(enc, z * surfaceBytes(fmt, w, h));
    }
    return out;
  };
  /** write level data into a Direct3D surface / volume level of a created resource and tell the backend */
  const fillSurface = (c, s, data) => { const a = s.ensureMem(c.proc); mem.writeBytes(a, data.subarray(0, Math.min(data.length, s.bytes))); s.dirty = true; s.dev.gfx?.surfaceUpdated?.(s); };
  const fillVolume = (c, t, i, data) => { const l = t.levels[i]; if (!l.mem) l.mem = c.proc.vmem.alloc(Math.max(l.bytes, 16), 4, 'd3d8:volume'); mem.writeBytes(l.mem, data.subarray(0, Math.min(data.length, l.bytes))); t.dev.gfx?.volumeUpdated?.(t, i); };

  /**
   * Create a texture of kind 'tex' | 'cube' | 'volume' from an image in memory (the ...FromFileInMemoryEx family).
   * dims: requested width/height/depth (D3DX_DEFAULT...), levels, usage, fmt, pool, filter, mipFilter, colorKey.
   */
  const createFromImage = (c, kind, dev, im, o) => {
    const fileW = im.width, fileH = im.height, fileD = im.depth;
    const pick = (v, file) => (v === 0 || v === D3DX_DEFAULT || v === D3DX_DEFAULT_NONPOW2 || v === D3DX_FROM_FILE ? file : v);
    const w = pick(o.w, fileW), h = kind === 'cube' ? w : pick(o.h, fileH), d = kind === 'volume' ? pick(o.d, fileD) : 1;
    const levels = o.levels === D3DX_FROM_FILE ? im.mips : o.levels === 0 || o.levels === D3DX_DEFAULT ? fullChain(w, h, d) : Math.min(o.levels, fullChain(w, h, d));
    let fmt = pickFormat(o.fmt, im.fmt);
    const pp = outSlot(c);
    let r;
    if (kind === 'tex') r = callMethod(c, dev, 'CreateTexture', [w, h, levels, o.usage, fmt, o.pool, pp, 0]);
    else if (kind === 'cube') r = callMethod(c, dev, 'CreateCubeTexture', [w, levels, o.usage, fmt, o.pool, pp, 0]);
    else r = callMethod(c, dev, 'CreateVolumeTexture', [w, h, d, levels, o.usage, fmt, o.pool, pp, 0]);
    if (r) return [r, 0];
    const ptr = mem.read32(pp), t = com.implAt(ptr);
    const faces = kind === 'cube' ? 6 : 1;
    for (let f = 0; f < faces; f++) {
      const srcFace = Math.min(f, im.images.length - 1);
      const n = kind === 'cube' ? t.faces[f].length : t.levels.length;
      for (let i = 0; i < n; i++) {
        const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i), ld = Math.max(1, d >> i);
        // levels past the file's are generated from the previous level (D3DX's mip filter), others from the file
        let data = i < im.mips ? levelData(im, srcFace, i, fmt, lw, lh, ld, o.filter, o.colorKey) : null;
        if (!data) {
          const prevW = Math.max(1, w >> (i - 1)), prevH = Math.max(1, h >> (i - 1));
          const prev = kind === 'volume' ? null : kind === 'cube' ? t.faces[f][i - 1] : t.levels[i - 1];
          if (prev && prev.mem) data = fromRgba(fmt, resizeRgba(toRgba(fmt, mem.bytes(prev.mem, prev.bytes), prevW, prevH), prevW, prevH, lw, lh, (o.mipFilter & 0xff) === FILTER_POINT), lw, lh);
          else data = levelData(im, srcFace, Math.min(i, im.mips - 1), fmt, lw, lh, ld, o.filter, o.colorKey);
        }
        if (!data) continue;
        if (kind === 'volume') fillVolume(c, t, i, data);
        else fillSurface(c, kind === 'cube' ? t.faces[f][i] : t.levels[i], data);
      }
    }
    return [D3D_OK, ptr];
  };
  const fromMemoryEx = (kind) => (c) => {
    // tex: (dev, src, size, w, h, levels, usage, fmt, pool, filter, mipFilter, key, info, palette, pp)
    // cube: (dev, src, size, size, levels, usage, fmt, pool, filter, mipFilter, key, info, palette, pp)
    // volume: (dev, src, size, w, h, d, levels, usage, fmt, pool, filter, mipFilter, key, info, palette, pp)
    const a = (i) => c.arg(i);
    const im = imageAt(c, a(1), a(2));
    const outIdx = kind === 'tex' ? 14 : kind === 'cube' ? 13 : 15;
    if (!im) { if (a(outIdx)) mem.write32(a(outIdx), 0); vm.log('gfx', `d3dx: ${kind} from memory: not a supported image (${a(2)} bytes)`); return D3DXERR_INVALIDDATA; }
    const o = kind === 'tex' ? { w: a(3), h: a(4), levels: a(5), usage: a(6), fmt: a(7), pool: a(8), filter: a(9), mipFilter: a(10), colorKey: a(11), info: a(12) }
      : kind === 'cube' ? { w: a(3), h: a(3), levels: a(4), usage: a(5), fmt: a(6), pool: a(7), filter: a(8), mipFilter: a(9), colorKey: a(10), info: a(11) }
        : { w: a(3), h: a(4), d: a(5), levels: a(6), usage: a(7), fmt: a(8), pool: a(9), filter: a(10), mipFilter: a(11), colorKey: a(12), info: a(13) };
    writeInfo(o.info, im);
    const [r, ptr] = createFromImage(c, kind, a(0), im, o);
    if (a(outIdx)) mem.write32(a(outIdx), ptr);
    return r;
  };
  X.D3DXCreateTextureFromFileInMemoryEx = [15, fromMemoryEx('tex')];
  X.D3DXCreateCubeTextureFromFileInMemoryEx = [14, fromMemoryEx('cube')];
  X.D3DXCreateVolumeTextureFromFileInMemoryEx = [16, fromMemoryEx('volume')];
  X.D3DXCreateTextureFromFileInMemory = [4, (c) => { const im = imageAt(c, c.arg(1), c.arg(2)); if (!im) return D3DXERR_INVALIDDATA; const [r, ptr] = createFromImage(c, 'tex', c.arg(0), im, { w: D3DX_DEFAULT, h: D3DX_DEFAULT, levels: D3DX_DEFAULT, usage: 0, fmt: 0, pool: 1, filter: 5, mipFilter: 5, colorKey: 0 }); if (c.arg(3)) mem.write32(c.arg(3), ptr); return r; }];
  X.D3DXCreateCubeTextureFromFileInMemory = [4, (c) => { const im = imageAt(c, c.arg(1), c.arg(2)); if (!im) return D3DXERR_INVALIDDATA; const [r, ptr] = createFromImage(c, 'cube', c.arg(0), im, { w: D3DX_DEFAULT, h: D3DX_DEFAULT, levels: D3DX_DEFAULT, usage: 0, fmt: 0, pool: 1, filter: 5, mipFilter: 5, colorKey: 0 }); if (c.arg(3)) mem.write32(c.arg(3), ptr); return r; }];
  X.D3DXCreateVolumeTextureFromFileInMemory = [4, (c) => { const im = imageAt(c, c.arg(1), c.arg(2)); if (!im) return D3DXERR_INVALIDDATA; const [r, ptr] = createFromImage(c, 'volume', c.arg(0), im, { w: D3DX_DEFAULT, h: D3DX_DEFAULT, d: D3DX_DEFAULT, levels: D3DX_DEFAULT, usage: 0, fmt: 0, pool: 1, filter: 5, mipFilter: 5, colorKey: 0 }); if (c.arg(3)) mem.write32(c.arg(3), ptr); return r; }];
  // from files: read through the VFS, then as from memory
  const readFile = (c, name) => { const st = vm.vfs.stat(c.proc.path(name)); if (!st || st.isDir) return null; const f = vm.vfs.open(c.proc.path(name)); return f ? f.read(0, st.size) : null; };
  const fromFile = (kind, wide, ex) => (c) => {
    const name = wide ? c.wstr(1) : c.str(1), data = name ? readFile(c, name) : null;
    if (!data) { vm.log('gfx', `d3dx: texture file ${name} not found`); return D3DXERR_INVALIDDATA; }
    const im = parseImage(data); if (!im) return D3DXERR_INVALIDDATA;
    const a = (i) => c.arg(i);
    const o = !ex ? { w: D3DX_DEFAULT, h: D3DX_DEFAULT, d: D3DX_DEFAULT, levels: D3DX_DEFAULT, usage: 0, fmt: 0, pool: 1, filter: 5, mipFilter: 5, colorKey: 0 }
      : kind === 'tex' ? { w: a(2), h: a(3), levels: a(4), usage: a(5), fmt: a(6), pool: a(7), filter: a(8), mipFilter: a(9), colorKey: a(10), info: a(11) }
        : kind === 'cube' ? { w: a(2), h: a(2), levels: a(3), usage: a(4), fmt: a(5), pool: a(6), filter: a(7), mipFilter: a(8), colorKey: a(9), info: a(10) }
          : { w: a(2), h: a(3), d: a(4), levels: a(5), usage: a(6), fmt: a(7), pool: a(8), filter: a(9), mipFilter: a(10), colorKey: a(11), info: a(12) };
    writeInfo(o.info, im);
    const [r, ptr] = createFromImage(c, kind, a(0), im, o);
    const outIdx = !ex ? 2 : kind === 'tex' ? 13 : kind === 'cube' ? 12 : 14;
    if (a(outIdx)) mem.write32(a(outIdx), ptr);
    return r;
  };
  for (const [sfx, wide] of [['A', false], ['W', true]]) {
    X['D3DXCreateTextureFromFile' + sfx] = [3, fromFile('tex', wide, false)];
    X['D3DXCreateTextureFromFileEx' + sfx] = [14, fromFile('tex', wide, true)];
    X['D3DXCreateCubeTextureFromFile' + sfx] = [3, fromFile('cube', wide, false)];
    X['D3DXCreateCubeTextureFromFileEx' + sfx] = [13, fromFile('cube', wide, true)];
    X['D3DXCreateVolumeTextureFromFile' + sfx] = [3, fromFile('volume', wide, false)];
    X['D3DXCreateVolumeTextureFromFileEx' + sfx] = [15, fromFile('volume', wide, true)];
    X['D3DXGetImageInfoFromFile' + sfx] = [2, (c) => { const n = wide ? c.wstr(0) : c.str(0), d = n ? readFile(c, n) : null, im = d ? parseImage(d) : null; if (!im) return D3DXERR_INVALIDDATA; writeInfo(c.arg(1), im); return D3D_OK; }];
  }
  // plain creation with D3DX's defaults and checks
  const checkReq = (c, kind) => { // (dev, *w, *h, [*d], *levels, usage, *fmt, pool)
    const a = (i) => c.arg(i), off = kind === 'volume' ? 1 : 0;
    const pw = a(1), ph = kind === 'cube' ? 0 : a(2), pd = kind === 'volume' ? a(3) : 0, pl = a(kind === 'cube' ? 2 : 3 + off), pf = a(kind === 'cube' ? 4 : 5 + off);
    let w = pw ? mem.read32(pw) : 256, h = ph ? mem.read32(ph) : w, d = pd ? mem.read32(pd) : 1;
    if (w === 0 || w === D3DX_DEFAULT) w = 256; if (h === 0 || h === D3DX_DEFAULT) h = w; if (d === 0 || d === D3DX_DEFAULT) d = 1;
    const max = fullChain(w, h, d);
    let l = pl ? mem.read32(pl) : 0; l = l === 0 || l === D3DX_DEFAULT ? max : Math.min(l, max);
    let f = pf ? mem.read32(pf) : FMT.A8R8G8B8; f = pickFormat(f === 0 || f === D3DX_DEFAULT ? FMT.A8R8G8B8 : f, FMT.A8R8G8B8);
    if (pw) mem.write32(pw, w); if (ph) mem.write32(ph, h); if (pd) mem.write32(pd, d); if (pl) mem.write32(pl, l); if (pf) mem.write32(pf, f);
    return { w, h, d, l, f };
  };
  X.D3DXCheckTextureRequirements = [7, (c) => { checkReq(c, 'tex'); return D3D_OK; }];
  X.D3DXCheckCubeTextureRequirements = [6, (c) => { checkReq(c, 'cube'); return D3D_OK; }];
  X.D3DXCheckVolumeTextureRequirements = [8, (c) => { checkReq(c, 'volume'); return D3D_OK; }];
  const norm = (v, dflt) => (v === 0 || v === D3DX_DEFAULT ? dflt : v);
  X.D3DXCreateTexture = [8, (c) => { const a = (i) => c.arg(i), w = norm(a(1), 256), h = norm(a(2), w), l = a(3) === D3DX_DEFAULT ? 0 : a(3); const r = callMethod(c, a(0), 'CreateTexture', [w, h, l, a(4), pickFormat(norm(a(5), FMT.A8R8G8B8), FMT.A8R8G8B8), a(6), a(7), 0]); return r; }];
  X.D3DXCreateCubeTexture = [7, (c) => { const a = (i) => c.arg(i), l = a(2) === D3DX_DEFAULT ? 0 : a(2); return callMethod(c, a(0), 'CreateCubeTexture', [norm(a(1), 256), l, a(3), pickFormat(norm(a(4), FMT.A8R8G8B8), FMT.A8R8G8B8), a(5), a(6), 0]); }];
  X.D3DXCreateVolumeTexture = [9, (c) => { const a = (i) => c.arg(i), l = a(4) === D3DX_DEFAULT ? 0 : a(4); return callMethod(c, a(0), 'CreateVolumeTexture', [norm(a(1), 256), norm(a(2), 256), norm(a(3), 1), l, a(5), pickFormat(norm(a(6), FMT.A8R8G8B8), FMT.A8R8G8B8), a(7), a(8), 0]); }];

  // surfaces / volumes: loading into existing resources
  const surfaceOf = (ptr) => com.implAt(ptr);
  const rectOf = (p, w, h) => (p ? { l: mem.readS32(p), t: mem.readS32(p + 4), r: mem.readS32(p + 8), b: mem.readS32(p + 12) } : { l: 0, t: 0, r: w, b: h });
  /** RGBA8 pixels (rw x rh) into `dst` at rectangle dr (resized to it), converted to its format */
  const blitRgba = (c, dst, dr, rgba, rw, rh, filter, colorKey) => {
    if (colorKey) rgba = applyColorKey(rgba.slice(), colorKey);
    const dw = dr.r - dr.l, dh = dr.b - dr.t;
    if (dw <= 0 || dh <= 0) return D3DERR_INVALIDCALL;
    const px = resizeRgba(rgba, rw, rh, dw, dh, (filter & 0xff) === FILTER_POINT || (filter & 0xff) === 1);
    const base = dst.ensureMem(c.proc);
    const full = dr.l === 0 && dr.t === 0 && dw === dst.width && dh === dst.height;
    const cur = full ? null : toRgba(dst.fmt, mem.bytes(base, dst.bytes), dst.width, dst.height);
    let all = px;
    if (!full) { for (let y = 0; y < dh; y++) cur.set(px.subarray(y * dw * 4, (y + 1) * dw * 4), ((dr.t + y) * dst.width + dr.l) * 4); all = cur; }
    const enc = fromRgba(dst.fmt, all, dst.width, dst.height);
    if (!enc) { vm.log('gfx', `d3dx: surface format ${dst.fmt} not writable`); return D3DERR_INVALIDCALL; }
    fillSurface(c, dst, enc);
    return D3D_OK;
  };
  X.D3DXLoadSurfaceFromFileInMemory = [9, (c) => { // (dst, dstPal, dstRect, src, size, srcRect, filter, key, info)
    const dst = surfaceOf(c.arg(0)), im = imageAt(c, c.arg(3), c.arg(4));
    if (!dst || !im) return im ? D3DERR_INVALIDCALL : D3DXERR_INVALIDDATA;
    writeInfo(c.arg(8), im);
    const sr = rectOf(c.arg(5), im.width, im.height), full = toRgba(im.fmt, im.images[0][0], im.width, im.height);
    const sw = sr.r - sr.l, sh = sr.b - sr.t, sub = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) sub.set(full.subarray(((sr.t + y) * im.width + sr.l) * 4, ((sr.t + y) * im.width + sr.r) * 4), y * sw * 4);
    return blitRgba(c, dst, rectOf(c.arg(2), dst.width, dst.height), sub, sw, sh, c.arg(6), c.arg(7));
  }];
  X.D3DXLoadSurfaceFromMemory = [10, (c) => { // (dst, dstPal, dstRect, src, srcFmt, srcPitch, srcPal, srcRect, filter, key)
    const dst = surfaceOf(c.arg(0)); if (!dst || !c.arg(7)) return D3DERR_INVALIDCALL;
    const fmt = c.arg(4), pitch = c.arg(5), sr = rectOf(c.arg(7), 0, 0), sw = sr.r - sr.l, sh = sr.b - sr.t;
    if (sw <= 0 || sh <= 0) return D3DERR_INVALIDCALL;
    // (same format and size, no key: a straight copy of rows — of 4x4 blocks for compressed formats — keeps the data as is)
    const dr = rectOf(c.arg(2), dst.width, dst.height);
    if (fmt === dst.fmt && !c.arg(9) && dr.r - dr.l === sw && dr.b - dr.t === sh) {
      const base = dst.ensureMem(c.proc), dxt = isDxt(fmt), blk = dxt ? 4 : 1, unit = dxt ? (fmt === FMT.DXT1 ? 8 : 16) : surfacePitch(fmt, 1);
      const rows = Math.ceil(sh / blk), rowBytes = Math.ceil(sw / blk) * unit;
      for (let y = 0; y < rows; y++) mem.copy(base + ((dr.t / blk | 0) + y) * dst.pitch + (dr.l / blk | 0) * unit, c.arg(3) + ((sr.t / blk | 0) + y) * pitch + (sr.l / blk | 0) * unit, rowBytes);
      dst.dirty = true; dst.dev.gfx?.surfaceUpdated?.(dst); return D3D_OK;
    }
    let rgba;
    if (isDxt(fmt)) { const bw = Math.ceil(sw / 4), bh = Math.ceil(sh / 4), unit = fmt === FMT.DXT1 ? 8 : 16, raw = new Uint8Array(bw * bh * unit); for (let y = 0; y < bh; y++) raw.set(mem.bytes(c.arg(3) + ((sr.t >> 2) + y) * pitch + (sr.l >> 2) * unit, bw * unit), y * bw * unit); rgba = toRgba(fmt, raw, sw, sh); }
    else { const bpp = surfacePitch(fmt, 1), raw = new Uint8Array(sw * sh * bpp); for (let y = 0; y < sh; y++) raw.set(mem.bytes(c.arg(3) + (sr.t + y) * pitch + sr.l * bpp, sw * bpp), y * sw * bpp); rgba = toRgba(fmt, raw, sw, sh); }
    return blitRgba(c, dst, dr, rgba, sw, sh, c.arg(8), c.arg(9));
  }];
  X.D3DXLoadSurfaceFromSurface = [8, (c) => { // (dst, dstPal, dstRect, src, srcPal, srcRect, filter, key)
    const dst = surfaceOf(c.arg(0)), src = surfaceOf(c.arg(3)); if (!dst || !src) return D3DERR_INVALIDCALL;
    if (src.usage & 1 && src.dev?.gfx?.readbackSurface) src.dev.gfx.readbackSurface(src); // (a render target: its GPU contents)
    const full = toRgba(src.fmt, mem.bytes(src.ensureMem(c.proc), src.bytes), src.width, src.height), sr = rectOf(c.arg(5), src.width, src.height);
    const sw = sr.r - sr.l, sh = sr.b - sr.t, sub = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) sub.set(full.subarray(((sr.t + y) * src.width + sr.l) * 4, ((sr.t + y) * src.width + sr.r) * 4), y * sw * 4);
    return blitRgba(c, dst, rectOf(c.arg(2), dst.width, dst.height), sub, sw, sh, c.arg(6), c.arg(7));
  }];
  X.D3DXLoadVolumeFromFileInMemory = [9, (c) => { // (dstVolume, pal, dstBox, src, size, srcBox, filter, key, info): volumes are levels here
    const im = imageAt(c, c.arg(3), c.arg(4)); if (!im) return D3DXERR_INVALIDDATA;
    writeInfo(c.arg(8), im);
    vm.log('gfx', 'd3dx: D3DXLoadVolumeFromFileInMemory into a volume object is not supported (volumes are texture levels here)');
    return D3D_OK;
  }];
  X.D3DXFilterTexture = [4, (c) => { // (texture, palette, srcLevel, filter): levels below srcLevel regenerated
    const t = com.implAt(c.arg(0)); if (!t) return D3DERR_INVALIDCALL;
    const src = c.arg(2) === D3DX_DEFAULT ? 0 : c.arg(2), point = (c.arg(3) & 0xff) === FILTER_POINT;
    const chains = t.faces ?? (t.levels && !t.depth ? [t.levels] : null);
    if (!chains) return D3D_OK;
    for (const lv of chains) for (let i = src + 1; i < lv.length; i++) {
      const p = lv[i - 1], s = lv[i];
      if (!p.mem) continue;
      const enc = fromRgba(s.fmt, resizeRgba(toRgba(p.fmt, mem.bytes(p.mem, p.bytes), p.width, p.height), p.width, p.height, s.width, s.height, point), s.width, s.height);
      if (enc) fillSurface(c, s, enc);
    }
    return D3D_OK;
  }];
  X.D3DXSaveTextureToFileA = [4, () => E_NOTIMPL];
  X.D3DXSaveSurfaceToFileA = [5, () => E_NOTIMPL];

  // ---------------------------------------------------------------- shaders and effects (d3dx9-effect.js)
  /** macros of a D3DXMACRO array (Name, Definition pairs, NULL-terminated) */
  const macrosAt = (p) => { const m = new Map(); for (let i = 0; p && i < 256; i++) { const n = mem.read32(p + 8 * i); if (!n) break; const d = mem.read32(p + 8 * i + 4); m.set(mem.readCString(n), { params: null, body: d ? mem.readCString(d) : '' }); } return m; };
  /** #include through the application's ID3DXInclude (Open / Close: a plain vtable, no IUnknown), else the VFS */
  const includer = (c, pInclude, baseDir) => (name) => {
    if (pInclude) {
      const vt = mem.read32(pInclude), outs = c.proc.processHeap.alloc(8), nameA = c.proc.processHeap.alloc(name.length + 1);
      mem.writeCString(nameA, name);
      const r = vm.callGuest(c.thread, mem.read32(vt), [pInclude, 0, nameA, 0, outs, outs + 4]);
      let text = null;
      if (!(r >>> 31)) { const data = mem.read32(outs), n = mem.read32(outs + 4); text = mem.readCStringN(data, n); vm.callGuest(c.thread, mem.read32(vt + 4), [pInclude, data]); }
      c.proc.processHeap.free_(outs); c.proc.processHeap.free_(nameA);
      return text;
    }
    const path = c.proc.path((baseDir ? baseDir + '\\' : '') + name), st = vm.vfs.stat(path);
    return st ? new TextDecoder('latin1').decode(vm.vfs.open(path).read(0, st.size)) : null;
  };
  const assemble = (c, text, pDefines, pInclude, ppShader, ppErrors, baseDir) => {
    if (ppShader) mem.write32(ppShader, 0);
    if (ppErrors) mem.write32(ppErrors, 0);
    try {
      const toks = assembleShader(text, macrosAt(pDefines), includer(c, pInclude, baseDir));
      if (ppShader) mem.write32(ppShader, newBuffer(c, new Uint8Array(toks.buffer)));
      return D3D_OK;
    } catch (e) {
      vm.log('gfx', `d3dx: shader assembly failed: ${e.message}`);
      if (ppErrors) mem.write32(ppErrors, textBuffer(c, `(orthros) ${e.message}`));
      return D3DXERR_INVALIDDATA;
    }
  };
  // (src, len, defines, include, flags, ppShader, ppErrors)
  X.D3DXAssembleShader = [7, (c) => { dumpBlob('asm', c.arg(0), c.arg(1)); return assemble(c, mem.readCStringN(c.arg(0), c.arg(1)), c.arg(2), c.arg(3), c.arg(5), c.arg(6), ''); }];
  const asmFile = (wide) => (c) => { const name = wide ? c.wstr(0) : c.str(0), d = name ? readFile(c, name) : null; if (!d) return D3DXERR_INVALIDDATA; return assemble(c, new TextDecoder('latin1').decode(d), c.arg(1), c.arg(2), c.arg(4), c.arg(5), name.replace(/[\\/][^\\/]*$/, '')); };
  X.D3DXAssembleShaderFromFileA = [6, asmFile(false)];
  X.D3DXAssembleShaderFromFileW = [6, asmFile(true)];
  // (debugging, Node: ORTHROS_DUMP_D3DX=<dir> keeps the effect and shader-assembly inputs as files)
  const dumpBlob = (kind, a, n) => { const dir = globalThis.process?.env?.ORTHROS_DUMP_D3DX; if (!dir || !a) return; const data = mem.bytes(a, n).slice(), k = vm.d3dxDumps = (vm.d3dxDumps ?? 0) + 1; import('node:fs').then((fs) => fs.writeFileSync(`${dir}/${kind}-${String(k).padStart(3, '0')}.bin`, data)); };
  defineEffects(X, vm, { callMethod, textBuffer });
  { const create = X.D3DXCreateEffect[1]; X.D3DXCreateEffect = [9, (c) => { dumpBlob('fx', c.arg(1), c.arg(2)); return create(c); }]; }

  for (let n = 24; n <= 43; n++) api.define(`d3dx9_${n}.dll`, X);
  api.define('d3dx9d.dll', X);
}

/** vertex declaration type sizes by D3DDECLTYPE */
const DECLTYPE_SIZE = [4, 8, 12, 16, 4, 4, 4, 8, 4, 4, 4, 4, 4, 4, 4, 8, 4, 8];
/** D3DDECLUSAGE and index of an FVF attribute name */
const FVF_USAGE = (name) => ({ pos: [0, 0], position: [0, 0], normal: [3, 0], diffuse: [10, 0], specular: [10, 1], psize: [4, 0], rhw: [9, 0] })[name] ?? (/^tex(\d)/.test(name) ? [5, +name.slice(3)] : /^weight/.test(name) ? [1, 0] : [0, 0]);
/** a static profile string in guest memory (D3DXGet*ShaderProfile) */
function profileString(vm, s) {
  vm.d3dxProfiles ??= new Map();
  let a = vm.d3dxProfiles.get(s);
  if (!a) { a = vm.proc.processHeap.alloc(16); vm.mem.writeCString(a, s); vm.d3dxProfiles.set(s, a); }
  return a;
}
