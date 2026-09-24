// d3d8.dll: Direct3D 8 API layer. Adapter/mode/caps enumeration of a generic DX8-class device
// (what WebGL2 can render), device object tracking the whole pipeline state (render states,
// texture stages, transforms, lights, streams, shaders), resources (textures, surfaces, vertex/
// index buffers) stored in guest memory with Lock/Unlock, and a pluggable backend
// (`vm.host.gfx`) that receives state changes and draw calls. Without a backend (headless Node)
// everything is tracked and counted so traces and tests can observe the game's rendering.
import { readGuid, writeGuid, S_OK, S_FALSE, E_NOINTERFACE, E_POINTER, E_INVALIDARG, E_OUTOFMEMORY, E_NOTIMPL } from './com.js';
import { Surface as GdiSurface } from '../gfx/gdi/surface.js';
import { makeDC } from './gdi32.js';
import { PROGRAM_RS, PROGRAM_TSS } from '../gfx/d3d8-shaders.js';
import { StateTable } from './state-table.js';

export const D3D_OK = 0, D3DERR_INVALIDCALL = 0x8876086c, D3DERR_NOTAVAILABLE = 0x8876086a, D3DERR_OUTOFVIDEOMEMORY = 0x8876017c, D3DERR_DEVICELOST = 0x88760868, D3DERR_DEVICENOTRESET = 0x88760869, D3DERR_NOTFOUND = 0x88760866, D3DERR_MOREDATA = 0x88760867, D3DERR_INVALIDDEVICE = 0x8876086b, D3DERR_UNSUPPORTEDTEXTUREFILTER = 0x88760876, D3DERR_WRONGTEXTUREFORMAT = 0x88760872;
const IID_IDirect3D8 = '1dd9e8da-1c77-4d40-b0cf-98fefdff9512', IID_IDirect3DDevice8 = '7385e5df-8fe8-41d5-86b6-d7b48547b6cf', IID_IDirect3DResource8 = '1b36bb7b-09b7-410a-b445-7d1430d7b33f', IID_IDirect3DBaseTexture8 = 'b4211cfa-51b9-4a9f-ab78-db99b2bb678e', IID_IDirect3DTexture8 = 'e4cdd575-2866-4f01-b12e-7eece1ec9358', IID_IDirect3DCubeTexture8 = '3ee5b968-2aca-4c34-8bb5-7e0c3d19b750', IID_IDirect3DVolumeTexture8 = '4b8aaafa-140f-42ba-9131-597eafaa2ead', IID_IDirect3DVertexBuffer8 = '8aeeeac7-05f9-44d4-b591-000b0df1cb95', IID_IDirect3DIndexBuffer8 = '0e689c9a-053d-44a0-9d92-db0e3d750f86', IID_IDirect3DSurface8 = 'b96eebca-b326-4ea5-882f-2ff5bae021dd', IID_IDirect3DVolume8 = 'bd7349f5-14f1-42e4-9c79-972380db40c0', IID_IDirect3DSwapChain8 = '928c088b-76b9-4c6b-a536-a590853876cd';

export const FMT = { UNKNOWN: 0, R8G8B8: 20, A8R8G8B8: 21, X8R8G8B8: 22, R5G6B5: 23, X1R5G5B5: 24, A1R5G5B5: 25, A4R4G4B4: 26, R3G3B2: 27, A8: 28, A8R3G3B2: 29, X4R4G4B4: 30, A2B10G10R10: 31, A8B8G8R8: 32, X8B8G8R8: 33, G16R16: 34, A2R10G10B10: 35, A16B16G16R16: 36, A8P8: 40, P8: 41, L8: 50, A8L8: 51, A4L4: 52, V8U8: 60, L6V5U5: 61, X8L8V8U8: 62, Q8W8V8U8: 63, V16U16: 64, L16: 81, W11V11U10: 65, UYVY: 0x59565955, YUY2: 0x32595559, DXT1: 0x31545844, DXT2: 0x32545844, DXT3: 0x33545844, DXT4: 0x34545844, DXT5: 0x35545844, D16_LOCKABLE: 70, D32: 71, D15S1: 73, D24S8: 75, D16: 80, D24X8: 77, D24X4S4: 79, VERTEXDATA: 100, INDEX16: 101, INDEX32: 102 };
const RTYPE = { SURFACE: 1, VOLUME: 2, TEXTURE: 3, VOLUMETEXTURE: 4, CUBETEXTURE: 5, VERTEXBUFFER: 6, INDEXBUFFER: 7 };
const POOL = { DEFAULT: 0, MANAGED: 1, SYSTEMMEM: 2, SCRATCH: 3 };
const USAGE_RENDERTARGET = 1, USAGE_DEPTHSTENCIL = 2, USAGE_DYNAMIC = 0x200;
const MODES = [[640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 720], [1280, 768], [1280, 800], [1280, 960], [1280, 1024], [1360, 768], [1366, 768], [1440, 900], [1600, 900], [1600, 1200], [1680, 1050], [1920, 1080], [1920, 1200], [2560, 1440]];
const MODE_FORMATS = [FMT.X8R8G8B8, FMT.R5G6B5];
const DISPLAY_FORMATS = new Set([FMT.X8R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5]);
const BACKBUFFER_FORMATS = new Set([FMT.X8R8G8B8, FMT.A8R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5]);
const DEPTH_FORMATS = new Set([FMT.D16, FMT.D24S8, FMT.D24X8, FMT.D32, FMT.D16_LOCKABLE, FMT.D15S1, FMT.D24X4S4]);
const TEXTURE_FORMATS = new Set([FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.A8, FMT.L8, FMT.A8L8, FMT.DXT1, FMT.DXT2, FMT.DXT3, FMT.DXT4, FMT.DXT5, FMT.V8U8, FMT.A4L4, FMT.X4R4G4B4]); // no R8G8B8 nor palettized P8/A8P8: like every real Direct3D 9 driver, those textures are not offered (applications keep a conversion path)

/** bytes of one row / total bytes for a surface of this format */
/** Distinct values each render / stage state took (end-of-run report: which pipeline features a game uses). */
export function noteState(dev, group, s, v) {
  const m = dev.stateUse ??= new Map(); const k = `${group}:${s}`;
  let set = m.get(k); if (!set) m.set(k, (set = new Set()));
  if (set.size < 12) set.add(v >>> 0);
}
/** Readable summary of noteState: "rs:<state>=v1,v2 ..." sorted by state. */
export function stateUseReport(dev) {
  if (!dev?.stateUse) return '';
  return [...dev.stateUse].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true })).map(([k, set]) => `${k}=${[...set].map((v) => (v > 0xffff ? '0x' + v.toString(16) : v)).join(',')}`).join('\n  ');
}
const f32b = new Float32Array(1), u32b = new Uint32Array(f32b.buffer);
/** Bit pattern of a float32 (exact comparison of matrices: -0 vs 0 and NaN payloads count as changes). */
function f32bits(v) { f32b[0] = v; return u32b[0]; }

export function surfacePitch(fmt, w) {
  switch (fmt) {
    case FMT.DXT1: return Math.max(1, (w + 3) >> 2) * 8;
    case FMT.DXT2: case FMT.DXT3: case FMT.DXT4: case FMT.DXT5: return Math.max(1, (w + 3) >> 2) * 16;
    case FMT.R8G8B8: return w * 3;
    case FMT.A8: case FMT.L8: case FMT.P8: case FMT.A4L4: case FMT.R3G3B2: return w;
    case FMT.A16B16G16R16: return w * 8;
    case FMT.L16: case FMT.R5G6B5: case FMT.X1R5G5B5: case FMT.A1R5G5B5: case FMT.A4R4G4B4: case FMT.A8L8: case FMT.D16: case FMT.D16_LOCKABLE: case FMT.D15S1: case FMT.V8U8: case FMT.L6V5U5: case FMT.A8R3G3B2: case FMT.X4R4G4B4: case FMT.INDEX16: case FMT.UYVY: case FMT.YUY2: return w * 2;
    default: return w * 4;
  }
}
export function surfaceBytes(fmt, w, h) {
  const rows = fmt === FMT.DXT1 || fmt === FMT.DXT2 || fmt === FMT.DXT3 || fmt === FMT.DXT4 || fmt === FMT.DXT5 ? Math.max(1, (h + 3) >> 2) : h;
  return surfacePitch(fmt, w) * rows;
}

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
/**
 * Shared Direct3D core (resources in guest memory, device state model, adapter helpers) used by
 * the D3D8 and D3D9 API layers. One per VM.
 */
export function d3dCore(vm) {
  if (vm.d3dCore) return vm.d3dCore;
  const mem = vm.mem, com = vm.com;
  const displayMode = () => { const d = vm.host?.display; return { width: d?.width ?? 1024, height: d?.height ?? 768, refresh: 60, format: FMT.X8R8G8B8 }; };
  const writeMode = (a, m) => { mem.write32(a, m.width); mem.write32(a + 4, m.height); mem.write32(a + 8, m.refresh); mem.write32(a + 12, m.format); };
  const modes = () => { const list = []; const d = displayMode(); for (const f of MODE_FORMATS) { const seen = new Set(); for (const [w, h] of [...MODES, [d.width, d.height]]) { const k = w * 100000 + h; if (seen.has(k)) continue; seen.add(k); list.push({ width: w, height: h, refresh: 60, format: f }); } } return list; };

  /** D3DCAPS8 of the generic device. */
  function writeCaps(a, adapter, devType) {
    mem.fill(a, 212, 0);
    const w32 = (o, v) => mem.write32(a + o, v >>> 0), wf = (o, v) => mem.writeF32(a + o, v);
    w32(0, devType); w32(4, adapter);
    w32(8, 0x20000); // Caps: READ_SCANLINE
    w32(12, 0x80000 | 0x20000 | 0x20000000); // Caps2: CANRENDERWINDOWED | FULLSCREENGAMMA | DYNAMICTEXTURES
    w32(16, 0); w32(20, 0x80000000 | 1 | 2); // PresentationIntervals: IMMEDIATE | ONE | TWO
    w32(24, 1); // CursorCaps: COLOR
    w32(28, 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x2000 | 0x8000 | 0x10000 | 0x20000 | 0x80000 | 0x100000); // DevCaps
    w32(32, 0x2 | 0x10 | 0x20 | 0x40 | 0x80 | 0x200 | 0x400 | 0x800); // PrimitiveMiscCaps
    w32(36, 0x1 | 0x10 | 0x80 | 0x100 | 0x2000 | 0x4000 | 0x10000 | 0x20000 | 0x100000 | 0x200000 | 0x400000); // RasterCaps
    w32(40, 0xff); w32(52, 0xff); // ZCmpCaps, AlphaCmpCaps
    w32(44, 0x1fff); w32(48, 0x1fff); // Src/DestBlendCaps
    w32(56, 0x8 | 0x200 | 0x4000 | 0x80000); // ShadeCaps
    w32(60, 0x1 | 0x4 | 0x400 | 0x800 | 0x4000 | 0x10000 | 0x2000 | 0x20000 | 0x40000); // TextureCaps: PERSPECTIVE|ALPHA|PROJECTED|CUBEMAP|MIPMAP|MIPCUBEMAP|VOLUMEMAP|MIPVOLUMEMAP
    const filt = 0x100 | 0x200 | 0x400 | 0x10000 | 0x20000 | 0x1000000 | 0x2000000 | 0x4000000;
    w32(64, filt); w32(68, filt); w32(72, filt); // TextureFilterCaps, Cube, Volume
    w32(76, 0x3f); w32(80, 0x3f); // TextureAddressCaps, Volume
    w32(84, 0x1f); // LineCaps
    w32(88, 4096); w32(92, 4096); w32(96, 256); // MaxTextureWidth/Height, MaxVolumeExtent
    w32(100, 8192); w32(104, 4096); w32(108, 16); // MaxTextureRepeat, AspectRatio, Anisotropy
    wf(112, 1e10); wf(116, -32768); wf(120, -32768); wf(124, 32768); wf(128, 32768); wf(132, 0); // MaxVertexW, guard band, ExtentsAdjust
    w32(136, 0xff); // StencilCaps
    w32(140, 8 | 0x100000); // FVFCaps: 8 texcoords | PSIZE
    w32(144, 0x3ffffff); // TextureOpCaps
    w32(148, 8); w32(152, 8); // MaxTextureBlendStages, MaxSimultaneousTextures
    w32(156, 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x40); // VertexProcessingCaps
    w32(160, 8); w32(164, 6); w32(168, 4); w32(172, 255); // MaxActiveLights, UserClipPlanes, VertexBlendMatrices, MatrixIndex
    wf(176, 64); // MaxPointSize
    w32(180, 0xfffff); w32(184, 0xfffff); w32(188, 16); w32(192, 1024); // MaxPrimitiveCount, MaxVertexIndex, MaxStreams, MaxStreamStride
    w32(196, 0xfffe0101); w32(200, 96); // VertexShaderVersion 1.1, MaxVertexShaderConst
    w32(204, 0xffff0104); wf(208, 8); // PixelShaderVersion 1.4, MaxPixelShaderValue
  }

  // ---------------------------------------------------------------- resources
  let nextResId = 1;
  class Resource {
    constructor(dev, type, pool, usage, fmt) { this.dev = dev; this.type = type; this.pool = pool; this.usage = usage; this.fmt = fmt; this.id = nextResId++; this.priority = 0; this.privateData = new Map(); this.iids = [IID_IDirect3DResource8]; }
    GetDevice(c) { c.out32(1, this.dev.ptr); com.addRef(com.objectAt(this.dev.ptr)); return D3D_OK; }
    SetPrivateData(c) { const g = readGuid(mem, c.arg(1)), p = c.arg(2), n = c.arg(3), flags = c.arg(4); this.privateData.set(g, flags & 1 ? { iunknown: mem.read32(p) } : { data: mem.bytes(p, n).slice() }); return D3D_OK; }
    GetPrivateData(c) { const g = readGuid(mem, c.arg(1)), p = c.arg(2), ps = c.arg(3); const d = this.privateData.get(g); if (!d) return D3DERR_NOTFOUND; const bytes = d.data ?? new Uint8Array(4); const size = mem.read32(ps); mem.write32(ps, bytes.length); if (size < bytes.length) return D3DERR_MOREDATA; if (d.data) mem.writeBytes(p, d.data); else mem.write32(p, d.iunknown); return D3D_OK; }
    FreePrivateData(c) { return this.privateData.delete(readGuid(mem, c.arg(1))) ? D3D_OK : D3DERR_NOTFOUND; }
    SetPriority(c) { const p = this.priority; this.priority = c.arg(1); return p; }
    GetPriority() { return this.priority; }
    PreLoad() { return D3D_OK; }
    GetType() { return this.type; }
    destroy() { this.dev.gfx?.destroyResource?.(this); this.free?.(); }
  }
  /** one 2D level (or cube face level): guest memory backing */
  class Surface {
    constructor(dev, owner, fmt, w, h, usage, pool, level = 0, face = 0) {
      this.dev = dev; this.owner = owner; this.fmt = fmt; this.width = w; this.height = h; this.usage = usage; this.pool = pool; this.level = level; this.face = face;
      this.pitch = surfacePitch(fmt, w); this.bytes = surfaceBytes(fmt, w, h);
      this.mem = 0; this.locked = false; this.dirty = false; this.id = nextResId++; this.privateData = new Map(); this.type = RTYPE.SURFACE;
      this.iids = [IID_IDirect3DSurface8];
    }
    ensureMem(proc) { if (!this.mem) { this.mem = proc.vmem.alloc(Math.max(this.bytes, 16), 4, 'd3d8:surface'); mem.fill(this.mem, this.bytes, 0); } return this.mem; }
    /** Recent write operations on this surface (frame capture shows them next to the dumped textures). */
    trace(c, what) { const h = this.history ??= []; h.push({ what, site: c.retAddr }); if (h.length > 24) h.shift(); }
    historyText() { return (this.history ?? []).map((e) => `${e.what} from ${this.dev.proc.symbolize(e.site)}`); }
    free() { if (this.mem) { this.dev.proc.vmem.release(this.mem); this.mem = 0; } }
    ptrOf(c) { if (!this.ptr || !com.objectAt(this.ptr)) { this.ptr = com.create(c.proc, this.dev.api9 ? 'IDirect3DSurface9' : 'IDirect3DSurface8', this); } else com.addRef(com.objectAt(this.ptr)); return this.ptr; }
    destroy() { this.ptr = 0; if (!this.owner) { this.dev.gfx?.destroyResource?.(this); this.free(); } }
    GetDevice(c) { return Resource.prototype.GetDevice.call(this, c); }
    SetPrivateData(c) { return Resource.prototype.SetPrivateData.call(this, c); }
    GetPrivateData(c) { return Resource.prototype.GetPrivateData.call(this, c); }
    FreePrivateData(c) { return Resource.prototype.FreePrivateData.call(this, c); }
    GetContainer(c) { const iid = readGuid(mem, c.arg(1)); const pp = c.arg(2); if (!pp) return E_POINTER; const owner = this.owner ?? this.dev; const o = com.objectAt(owner.ptr); if (!o || !com.supports(o, iid)) { mem.write32(pp, 0); return E_NOINTERFACE; } com.addRef(o); mem.write32(pp, owner.ptr); return D3D_OK; }
    GetDesc(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; mem.write32(p, this.fmt); mem.write32(p + 4, RTYPE.SURFACE); mem.write32(p + 8, this.usage); mem.write32(p + 12, this.pool); mem.write32(p + 16, this.dev.api9 ? 0 : this.bytes); mem.write32(p + 20, 0); mem.write32(p + 24, this.width); mem.write32(p + 28, this.height); return D3D_OK; } // DX8: Size at +16; DX9: MultiSampleType/Quality at +16/+20
    LockRect(c) { return this.lock(c, c.arg(1), c.arg(2), c.arg(3)); }
    UnlockRect() { return this.unlock(); }
    /**
     * IDirect3DSurface9::GetDC: a GDI device context drawing straight into the surface memory (the formats D3D9
     * allows: X8R8G8B8/A8R8G8B8, R5G6B5, X1R5G5B5/A1R5G5B5); the surface counts as locked until ReleaseDC.
     */
    GetDC(c) {
      const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL;
      mem.write32(p, 0);
      const bpp = this.fmt === FMT.X8R8G8B8 || this.fmt === FMT.A8R8G8B8 ? 32 : this.fmt === FMT.R5G6B5 || this.fmt === FMT.X1R5G5B5 || this.fmt === FMT.A1R5G5B5 ? 16 : 0;
      if (!bpp || this.locked) return D3DERR_INVALIDCALL;
      if ((this.usage & USAGE_RENDERTARGET) || this.dev.backBuffers?.includes(this)) this.dev.gfx?.readbackSurface?.(this);
      const base = this.ensureMem(c.proc);
      const surf = new GdiSurface(mem, base, this.width, this.height, this.pitch, bpp, { masks: this.fmt === FMT.R5G6B5 ? [0xf800, 0x7e0, 0x1f] : undefined });
      this.gdiDC = makeDC(c.proc, surf, { memory: true });
      this.locked = true; this.lockFlags = 0;
      this.trace(c, 'GetDC');
      mem.write32(p, this.gdiDC.handle);
      return D3D_OK;
    }
    ReleaseDC(c) {
      if (!this.gdiDC || c.arg(1) !== this.gdiDC.handle) return D3DERR_INVALIDCALL;
      c.proc.handles.map.delete(this.gdiDC.handle); this.gdiDC = null;
      return this.unlock();
    }
    SetPriority() { return 0; }
    GetPriority() { return 0; }
    PreLoad() {}
    GetType() { return RTYPE.SURFACE; }
    lock(c, pLocked, pRect, flags) {
      if (!pLocked) return D3DERR_INVALIDCALL;
      if (this.locked) return D3DERR_INVALIDCALL;
      if ((this.usage & (USAGE_RENDERTARGET | USAGE_DEPTHSTENCIL)) && this.pool === POOL.DEFAULT && !this.lockable) { this.dev.gfx?.readbackSurface?.(this); }
      const base = this.ensureMem(c.proc);
      let off = 0;
      if (pRect) {
        const l = mem.readS32(pRect), t = mem.readS32(pRect + 4);
        const blocky = this.fmt === FMT.DXT1 || this.fmt === FMT.DXT2 || this.fmt === FMT.DXT3 || this.fmt === FMT.DXT4 || this.fmt === FMT.DXT5;
        off = blocky ? (t >> 2) * this.pitch + (l >> 2) * (this.fmt === FMT.DXT1 ? 8 : 16) : t * this.pitch + l * (this.pitch / Math.max(1, this.width));
      }
      mem.write32(pLocked, this.pitch); mem.write32(pLocked + 4, base + (off | 0));
      this.locked = true; this.lockFlags = flags;
      this.trace(c, `LockRect ${pRect ? [0, 4, 8, 12].map((k) => mem.readS32(pRect + k)).join(',') : 'all'} flags 0x${flags.toString(16)}`);
      // --watch-tex <fmt>:<w>x<h>: report the code writing into such surfaces while they are locked for writing
      if (globalThis.ORTHROS_WATCH_TEX === `${this.fmt}:${this.width}x${this.height}` && !(flags & 0x10) && vm.jit && (vm.watchReports ?? 0) < (globalThis.ORTHROS_WATCH_MAX ?? 400)) { this.watchKey = `#${this.owner?.id ?? this.id}`; vm.jit.watchWrites(base, surfaceBytes(this.fmt, this.width, this.height), this.watchKey, 4096); }
      if (globalThis.ORTHROS_LOCK_LOG && (flags & 0x10)) vm.log('lock', `#${this.owner?.id ?? this.id}${this.owner ? ' L' + this.level : ''} ${this.width}x${this.height} fmt ${this.fmt} flags 0x${flags.toString(16)} rect ${pRect ? [0, 4, 8, 12].map((k) => mem.readS32(pRect + k)).join(',') : 'all'} from ${c.proc.symbolize(c.retAddr)}`);
      return D3D_OK;
    }
    unlock() {
      if (this.watchKey) { const sites = vm.jit.unwatch(this.watchKey); vm.watchReports = (vm.watchReports ?? 0) + 1; vm.log('warn', `watch ${this.watchKey} ${this.width}x${this.height} fmt ${this.fmt} (unlock by t${vm.current?.id}): ${sites.length ? sites.map(([k, n]) => { const [tid, rest] = typeof k === 'number' ? ['', k.toString(16)] : k.split(':'); return `${tid} ${rest.split('/').map((h) => vm.proc.symbolize(parseInt(h, 16))).join(' < ')} x${n}`; }).join(', ') : 'no translated writer'}`); this.watchKey = null; }
      if (!this.locked) return D3DERR_INVALIDCALL; this.locked = false; if (!(this.lockFlags & 0x10)) { this.dirty = true; this.dev.gfx?.surfaceUpdated?.(this); } return D3D_OK; }
  }
  class Texture extends Resource {
    constructor(dev, w, h, levels, usage, fmt, pool) {
      super(dev, RTYPE.TEXTURE, pool, usage, fmt);
      this.width = w; this.height = h; this.lod = 0;
      if (!levels) { levels = 1; let s = Math.max(w, h); while (s > 1) { s >>= 1; levels++; } }
      this.levels = [];
      for (let i = 0, lw = w, lh = h; i < levels; i++, lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)) this.levels.push(new Surface(dev, this, fmt, lw, lh, usage, pool, i));
      this.iids = [IID_IDirect3DResource8, IID_IDirect3DBaseTexture8];
    }
    free() { for (const l of this.levels) l.free(); }
    SetLOD(c) { const p = this.lod; this.lod = c.arg(1); return p; }
    GetLOD() { return this.lod; }
    GetLevelCount() { return this.levels.length; }
    GetLevelDesc(c) { const l = this.levels[c.arg(1)]; if (!l) return D3DERR_INVALIDCALL; return l.GetDesc({ arg: (i) => (i === 1 ? c.arg(2) : 0) }); }
    GetSurfaceLevel(c) { const l = this.levels[c.arg(1)]; const pp = c.arg(2); if (!l || !pp) return D3DERR_INVALIDCALL; mem.write32(pp, l.ptrOf(c)); return D3D_OK; }
    LockRect(c) { const l = this.levels[c.arg(1)]; if (!l) return D3DERR_INVALIDCALL; this.lockCount = (this.lockCount ?? 0) + 1; return l.lock(c, c.arg(2), c.arg(3), c.arg(4)); }
    UnlockRect(c) { const l = this.levels[c.arg(1)]; if (!l) return D3DERR_INVALIDCALL; return l.unlock(); }
    AddDirtyRect() { this.levels[0].dirty = true; return D3D_OK; }
    SetAutoGenFilterType() { return D3D_OK; }
    GetAutoGenFilterType() { return 2; }
    GenerateMipSubLevels() { return; }
  }
  class CubeTexture extends Resource {
    constructor(dev, size, levels, usage, fmt, pool) {
      super(dev, RTYPE.CUBETEXTURE, pool, usage, fmt);
      this.width = this.height = size; this.lod = 0;
      if (!levels) { levels = 1; let s = size; while (s > 1) { s >>= 1; levels++; } }
      this.faces = [];
      for (let f = 0; f < 6; f++) { const lv = []; for (let i = 0, s = size; i < levels; i++, s = Math.max(1, s >> 1)) lv.push(new Surface(dev, this, fmt, s, s, usage, pool, i, f)); this.faces.push(lv); }
      this.iids = [IID_IDirect3DResource8, IID_IDirect3DBaseTexture8];
    }
    free() { for (const f of this.faces) for (const l of f) l.free(); }
    SetLOD(c) { const p = this.lod; this.lod = c.arg(1); return p; }
    GetLOD() { return this.lod; }
    GetLevelCount() { return this.faces[0].length; }
    GetLevelDesc(c) { const l = this.faces[0][c.arg(1)]; if (!l) return D3DERR_INVALIDCALL; return l.GetDesc({ arg: (i) => (i === 1 ? c.arg(2) : 0) }); }
    GetCubeMapSurface(c) { const l = this.faces[c.arg(1)]?.[c.arg(2)]; const pp = c.arg(3); if (!l || !pp) return D3DERR_INVALIDCALL; mem.write32(pp, l.ptrOf(c)); return D3D_OK; }
    LockRect(c) { const l = this.faces[c.arg(1)]?.[c.arg(2)]; if (!l) return D3DERR_INVALIDCALL; return l.lock(c, c.arg(3), c.arg(4), c.arg(5)); }
    UnlockRect(c) { const l = this.faces[c.arg(1)]?.[c.arg(2)]; if (!l) return D3DERR_INVALIDCALL; return l.unlock(); }
    AddDirtyRect() { return D3D_OK; }
    SetAutoGenFilterType() { return D3D_OK; }
    GetAutoGenFilterType() { return 2; }
    GenerateMipSubLevels() { return; }
  }
  class VolumeTexture extends Resource {
    constructor(dev, w, h, d, levels, usage, fmt, pool) {
      super(dev, RTYPE.VOLUMETEXTURE, pool, usage, fmt);
      this.width = w; this.height = h; this.depth = d; this.lod = 0;
      if (!levels) { levels = 1; let s = Math.max(w, h, d); while (s > 1) { s >>= 1; levels++; } }
      this.levels = [];
      for (let i = 0, lw = w, lh = h, ld = d; i < levels; i++, lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1), ld = Math.max(1, ld >> 1)) this.levels.push({ width: lw, height: lh, depth: ld, pitch: surfacePitch(fmt, lw), slice: surfaceBytes(fmt, lw, lh), bytes: surfaceBytes(fmt, lw, lh) * ld, mem: 0, locked: false });
      this.iids = [IID_IDirect3DResource8, IID_IDirect3DBaseTexture8];
    }
    free() { for (const l of this.levels) if (l.mem) { this.dev.proc.vmem.release(l.mem); l.mem = 0; } }
    SetLOD(c) { const p = this.lod; this.lod = c.arg(1); return p; }
    GetLOD() { return this.lod; }
    GetLevelCount() { return this.levels.length; }
    GetLevelDesc(c) { const l = this.levels[c.arg(1)], p = c.arg(2); if (!l || !p) return D3DERR_INVALIDCALL; mem.write32(p, this.fmt); mem.write32(p + 4, RTYPE.VOLUME); mem.write32(p + 8, this.usage); mem.write32(p + 12, this.pool); if (this.dev.api9) { mem.write32(p + 16, l.width); mem.write32(p + 20, l.height); mem.write32(p + 24, l.depth); } else { mem.write32(p + 16, l.bytes); mem.write32(p + 20, l.width); mem.write32(p + 24, l.height); mem.write32(p + 28, l.depth); } return D3D_OK; }
    GetVolumeLevel(c) { c.out32(2, 0); return E_NOTIMPL; }
    LockBox(c) { const l = this.levels[c.arg(1)], p = c.arg(2); if (!l || !p || l.locked) return D3DERR_INVALIDCALL; if (!l.mem) { l.mem = c.proc.vmem.alloc(Math.max(l.bytes, 16), 4, 'd3d8:volume'); mem.fill(l.mem, l.bytes, 0); } mem.write32(p, l.pitch); mem.write32(p + 4, l.slice); mem.write32(p + 8, l.mem); l.locked = true; return D3D_OK; }
    UnlockBox(c) { const l = this.levels[c.arg(1)]; if (!l || !l.locked) return D3DERR_INVALIDCALL; l.locked = false; this.dev.gfx?.volumeUpdated?.(this, c.arg(1)); return D3D_OK; }
    AddDirtyBox() { return D3D_OK; }
    SetAutoGenFilterType() { return D3D_OK; }
    GetAutoGenFilterType() { return 2; }
    GenerateMipSubLevels() { return; }
  }
  class Buffer extends Resource {
    constructor(dev, type, length, usage, fvfOrFmt, pool) {
      super(dev, type, pool, usage, type === RTYPE.INDEXBUFFER ? fvfOrFmt : FMT.VERTEXDATA);
      this.length = length; this.fvf = type === RTYPE.VERTEXBUFFER ? fvfOrFmt : 0;
      this.mem = dev.proc.vmem.alloc(Math.max(length, 16), 4, type === RTYPE.VERTEXBUFFER ? 'd3d8:vb' : 'd3d8:ib');
      this.locked = false; this.dirty = false;
    }
    free() { if (this.mem) { this.dev.proc.vmem.release(this.mem); this.mem = 0; } }
    Lock(c) { const off = c.arg(1), size = c.arg(2), pp = c.arg(3), flags = c.arg(4); if (!pp || this.locked || off > this.length) return D3DERR_INVALIDCALL; mem.write32(pp, this.mem + off); this.locked = true; this.lockRange = [off, size ? Math.min(size, this.length - off) : this.length - off]; this.lockFlags = flags; return D3D_OK; }
    Unlock() { if (!this.locked) return D3DERR_INVALIDCALL; this.locked = false; if (!(this.lockFlags & 0x10)) { this.dirty = true; this.dev.gfx?.bufferUpdated?.(this, this.lockRange[0], this.lockRange[1]); } return D3D_OK; }
    GetDesc(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; mem.write32(p, this.fmt); mem.write32(p + 4, this.type); mem.write32(p + 8, this.usage); mem.write32(p + 12, this.pool); mem.write32(p + 16, this.length); if (this.type === RTYPE.VERTEXBUFFER) mem.write32(p + 20, this.fvf); return D3D_OK; }
  }

  // ---------------------------------------------------------------- device
  const MAX_STAGES = 8, MAX_STREAMS = 16, MAX_LIGHTS = 8;
  // D3DRS_* defaults (public documentation): floats stored as their bit patterns
  const F1 = 0x3f800000, F64 = 0x42800000;
  const RS_DEFAULTS = { 7: 1 /* ZENABLE */, 8: 3 /* FILLMODE SOLID */, 9: 2 /* SHADEMODE GOURAUD */, 14: 1 /* ZWRITEENABLE */, 15: 0, 16: 1 /* LASTPIXEL */, 19: 2 /* SRCBLEND ONE */, 20: 1 /* DESTBLEND ZERO */, 22: 3 /* CULLMODE CCW */, 23: 4 /* ZFUNC LESSEQUAL */, 24: 0, 25: 8 /* ALPHAFUNC ALWAYS */, 26: 0, 27: 0, 28: 0 /* FOGENABLE */, 29: 0 /* SPECULARENABLE */, 34: 0, 35: 0, 36: 0, 37: F1, 38: F1, 47: 0, 48: 0, 52: 0, 53: 1, 54: 1, 55: 1, 56: 8, 57: 0, 58: 0xffffffff, 59: 0xffffffff, 60: 0xffffffff, 128: 0, 129: 0, 130: 0, 131: 0, 132: 0, 133: 0, 134: 0, 135: 0, 136: 1 /* CLIPPING */, 137: 1 /* LIGHTING */, 139: 0, 140: 0, 141: 1 /* COLORVERTEX */, 142: 1 /* LOCALVIEWER */, 143: 0, 145: 1, 146: 2, 147: 0, 148: 0, 151: 0, 152: 0, 154: F1, 155: F1, 156: 0, 157: 0, 161: 1, 162: 0xffffffff, 165: 0, 166: F64, 167: 0, 168: 0xf /* COLORWRITEENABLE */, 170: 0, 171: 1 /* BLENDOP ADD */, 174: 0, 175: 0, 176: 0, 185: 0, 186: 1, 187: 1, 188: 1, 189: 8, 190: 0xf, 191: 0xf, 192: 0xf, 193: 0xffffffff, 194: 0, 195: 0, 206: 0, 207: 2, 208: 1, 209: 1 };
  const TSS_DEFAULTS = (stage) => ({ 1: stage === 0 ? 4 : 1 /* COLOROP MODULATE / DISABLE */, 2: 2 /* COLORARG1 TEXTURE */, 3: 1 /* COLORARG2 CURRENT */, 4: stage === 0 ? 2 : 1 /* ALPHAOP SELECTARG1 / DISABLE */, 5: 2, 6: 1, 7: 0, 8: 0, 9: 0, 10: 0, 11: stage, 13: 1 /* ADDRESSU WRAP */, 14: 1, 15: 0, 16: 1 /* MAGFILTER POINT */, 17: 1, 18: 0, 19: 0, 20: 0, 21: 1, 22: 0, 23: 0, 24: 0, 25: 1, 26: 1, 27: 1, 28: 1 });
  class Device {
    constructor(c, d3d, adapter, devType, hFocus, behavior, pp) {
      this.proc = c.proc; this.d3d = d3d; this.adapter = adapter; this.devType = devType; this.hFocus = hFocus; this.behavior = behavior; this.com = com; this.vm = vm;
      this.readPresentParams(pp);
      this.gfx = null;
      this.resetState();
      this.frames = 0; this.draws = 0; this.lastPresent = 0;
      this.stateBlocks = new Map(); this.nextSB = 1;
      this.vertexShaders = new Map(); this.pixelShaders = new Map(); this.nextShader = 1;
      this.cursor = { visible: false, x: 0, y: 0, hot: [0, 0], surface: null };
      this.gamma = null;
      this.iids = [IID_IDirect3DDevice8];
      this.createBackBuffers(c);
      this.gfx = vm.host?.gfx?.createDevice?.(this) ?? null;
      if (vm.gammaRamp) this.gfx?.setGamma?.(vm.gammaRamp); // SetDeviceGammaRamp before the device existed
    }
    readPresentParams(pp) {
      const p = pp;
      this.pp = { width: mem.read32(p), height: mem.read32(p + 4), format: mem.read32(p + 8), count: Math.max(1, mem.read32(p + 12)), msaa: mem.read32(p + 16), swap: mem.read32(p + 20), hwnd: mem.read32(p + 24), windowed: mem.read32(p + 28) !== 0, autoDepth: mem.read32(p + 32) !== 0, depthFormat: mem.read32(p + 36), flags: mem.read32(p + 40), refresh: mem.read32(p + 44), interval: mem.read32(p + 48) };
      const wm = vm.wm;
      if (this.pp.windowed && (!this.pp.width || !this.pp.height)) { const w = wm?.windows.get(this.pp.hwnd || this.hFocus); if (w) { this.pp.width = this.pp.width || (w.client.r - w.client.l); this.pp.height = this.pp.height || (w.client.b - w.client.t); } }
      if (!this.pp.width) this.pp.width = displayMode().width;
      if (!this.pp.height) this.pp.height = displayMode().height;
      if (!this.pp.format || this.pp.format === FMT.UNKNOWN) this.pp.format = FMT.X8R8G8B8;
      this.applyDisplayMode();
    }
    /** A fullscreen device owns the display mode: switch to the back buffer size, restore when leaving fullscreen. */
    applyDisplayMode() {
      const wm = vm.wm;
      if (!wm?.setDisplayMode) return;
      if (!this.pp.windowed) {
        wm.setDisplayMode(this.pp.width, this.pp.height, this.pp.format === FMT.R5G6B5 ? 16 : 32, true); this.modeOwned = true;
        // like the runtime, cover the screen with the device window (its client area receives the mouse in screen coordinates)
        const w = wm.windows.get(this.pp.hwnd || this.hFocus);
        if (w && !w.desktop && (w.rect.l !== 0 || w.rect.t !== 0 || w.rect.r - w.rect.l !== this.pp.width || w.rect.b - w.rect.t !== this.pp.height)) wm.setWindowPos(w, 0, 0, this.pp.width, this.pp.height, 0x10 /* SWP_NOACTIVATE */);
      }
      else if (this.modeOwned) { wm.setDisplayMode(0, 0, 32, false); this.modeOwned = false; }
    }
    createBackBuffers(c) {
      this.backBuffers = [];
      for (let i = 0; i < this.pp.count; i++) this.backBuffers.push(new Surface(this, null, this.pp.format, this.pp.width, this.pp.height, USAGE_RENDERTARGET, POOL.DEFAULT));
      this.depthStencil = this.pp.autoDepth ? new Surface(this, null, this.pp.depthFormat, this.pp.width, this.pp.height, USAGE_DEPTHSTENCIL, POOL.DEFAULT) : null;
      this.renderTarget = this.backBuffers[0]; this.depthTarget = this.depthStencil;
      this.viewport = { x: 0, y: 0, w: this.pp.width, h: this.pp.height, minZ: 0, maxZ: 1 };
      void c;
    }
    resetState() {
      this.stateVersion = (this.stateVersion ?? 0) + 1; // bumped by every state setter
      this.programVersion = (this.programVersion ?? 0) + 1; // only by what the backend's program key depends on
      // uniform-group versions: the backend re-uploads a group only when its version moved (see WebGLDevice.applyState)
      this.transformVersion = (this.transformVersion ?? 0) + 1; this.lightVersion = (this.lightVersion ?? 0) + 1; this.viewportVersion = (this.viewportVersion ?? 0) + 1; this.constVersion = (this.constVersion ?? 0) + 1;
      // per-slot transform versions (the backend re-uploads only the matrices that moved); transformAllVersion marks a
      // wholesale change (reset, state block) that dirties every slot
      this.transformSlotVersion = new Map(); this.transformAllVersion = this.transformVersion;
      this.rs = new StateTable(256, Object.entries(RS_DEFAULTS).map(([k, v]) => [+k, v]));
      this.tss = Array.from({ length: MAX_STAGES }, (_, i) => new StateTable(40, Object.entries(TSS_DEFAULTS(i)).map(([k, v]) => [+k, v])));
      this.textures = new Array(MAX_STAGES).fill(0);
      this.transforms = new Map(); // state -> Float32Array(16)
      this.lights = new Map(); this.lightEnabled = new Set();
      this.material = new Float32Array(17); this.clipPlanes = new Map();
      this.streams = Array.from({ length: MAX_STREAMS }, () => ({ vb: 0, stride: 0 }));
      this.indices = { ib: 0, base: 0 };
      this.vertexShader = 0; this.pixelShader = 0;
      this.vsConst = new Float32Array(96 * 4); this.psConst = new Float32Array(8 * 4);
      this.palettes = new Map(); this.currentPalette = 0;
      this.sceneDepth = 0;
    }
    destroy() { this.gfx?.destroy?.(); for (const b of this.backBuffers) b.free(); this.depthStencil?.free(); if (this.modeOwned) { this.modeOwned = false; vm.wm?.setDisplayMode?.(0, 0, 32, false); } }
    // ---- housekeeping
    TestCooperativeLevel() { return D3D_OK; }
    GetAvailableTextureMem() { return 256 * 1024 * 1024; }
    ResourceManagerDiscardBytes() { return D3D_OK; }
    GetDirect3D(c) { c.out32(1, this.d3d.ptr); com.addRef(com.objectAt(this.d3d.ptr)); return D3D_OK; }
    GetDeviceCaps(c) { if (!c.arg(1)) return D3DERR_INVALIDCALL; writeCaps(c.arg(1), this.adapter, this.devType); return D3D_OK; }
    GetDisplayMode(c) { if (!c.arg(1)) return D3DERR_INVALIDCALL; writeMode(c.arg(1), this.pp.windowed ? displayMode() : { width: this.pp.width, height: this.pp.height, refresh: 60, format: this.pp.format === FMT.A8R8G8B8 ? FMT.X8R8G8B8 : this.pp.format }); return D3D_OK; }
    GetCreationParameters(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; mem.write32(p, this.adapter); mem.write32(p + 4, this.devType); mem.write32(p + 8, this.hFocus); mem.write32(p + 12, this.behavior); return D3D_OK; }
    SetCursorProperties(c) { const s = com.implAt(c.arg(3)); this.cursor.hot = [c.arg(1), c.arg(2)]; this.cursor.surface = s instanceof Surface ? s : null; this.gfx?.setCursor?.(this.cursor); return D3D_OK; }
    SetCursorPosition(c) { this.cursor.x = c.sarg(1); this.cursor.y = c.sarg(2); if (vm.wm) vm.wm.cursor = { x: this.cursor.x, y: this.cursor.y }; return D3D_OK; }
    ShowCursor(c) { const was = this.cursor.visible; this.cursor.visible = c.arg(1) !== 0; return was ? 1 : 0; }
    CreateAdditionalSwapChain(c) { c.out32(2, 0); return D3DERR_NOTAVAILABLE; }
    Reset(c) {
      const pp = c.arg(1); if (!pp) return D3DERR_INVALIDCALL;
      for (const b of this.backBuffers) b.free(); this.depthStencil?.free();
      this.readPresentParams(pp);
      this.createBackBuffers(c);
      this.resetState();
      this.gfx?.reset?.(this);
      vm.log('gfx', `d3d8: Reset ${this.pp.width}x${this.pp.height} fmt ${this.pp.format} ${this.pp.windowed ? 'windowed' : 'fullscreen'}`);
      return D3D_OK;
    }
    Present(c) {
      this.frames++;
      this.lastPresent = vm.clock.now();
      if (this.gfx) this.gfx.present(this, c.arg(1), c.arg(2), c.arg(3));
      else vm.host?.onPresent?.(this);
      if (vm.host?.frameHook) vm.host.frameHook(this);
      if (this.pp.interval !== 0x80000000 && this.pp.interval !== 0 && vm.host?.vsyncWait) vm.host.vsyncWait();
      // back buffer surfaces keep their identity across Present (GetBackBuffer(0) stays the render target);
      // a flipping chain rotates the contents, which the backend does on its side
      return D3D_OK;
    }
    GetBackBuffer(c) { const b = this.backBuffers[c.arg(1)], pp = c.arg(3); if (!b || !pp) return D3DERR_INVALIDCALL; mem.write32(pp, b.ptrOf(c)); return D3D_OK; }
    GetRasterStatus(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; const t = vm.clock.now() % (1000 / 60); mem.write32(p, t < 1 ? 1 : 0); mem.write32(p + 4, Math.floor(t / (1000 / 60) * this.pp.height)); return D3D_OK; }
    SetGammaRamp(c) { this.gamma = mem.bytes(c.arg(2), 1536).slice(); this.gfx?.setGamma?.(this.gamma); return; }
    GetGammaRamp(c) { const p = c.arg(1); if (this.gamma) mem.writeBytes(p, this.gamma); else for (let i = 0; i < 256; i++) { const v = i * 257; mem.write16(p + 2 * i, v); mem.write16(p + 512 + 2 * i, v); mem.write16(p + 1024 + 2 * i, v); } return; }
    // ---- resource creation
    CreateTexture(c) {
      const w = c.arg(1), h = c.arg(2), levels = c.arg(3), usage = c.arg(4), fmt = c.arg(5), pool = c.arg(6), pp = c.arg(7);
      if (!pp || !w || !h) return D3DERR_INVALIDCALL;
      if (!TEXTURE_FORMATS.has(fmt) && !DEPTH_FORMATS.has(fmt)) { mem.write32(pp, 0); vm.log('gfx', `d3d8: CreateTexture unsupported format ${fmt}`); return D3DERR_INVALIDCALL; }
      const t = new Texture(this, w, h, levels, usage, fmt, pool);
      mem.write32(pp, t.ptr = com.create(c.proc, 'IDirect3DTexture8', t));
      this.gfx?.createTexture?.(t);
      return D3D_OK;
    }
    CreateVolumeTexture(c) { const pp = c.arg(8); if (!pp) return D3DERR_INVALIDCALL; const t = new VolumeTexture(this, c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5), c.arg(6), c.arg(7)); mem.write32(pp, t.ptr = com.create(c.proc, 'IDirect3DVolumeTexture8', t)); this.gfx?.createTexture?.(t); return D3D_OK; }
    CreateCubeTexture(c) { const pp = c.arg(6); if (!pp) return D3DERR_INVALIDCALL; const t = new CubeTexture(this, c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5)); mem.write32(pp, t.ptr = com.create(c.proc, 'IDirect3DCubeTexture8', t)); this.gfx?.createTexture?.(t); return D3D_OK; }
    CreateVertexBuffer(c) { const pp = c.arg(5); if (!pp || !c.arg(1)) return D3DERR_INVALIDCALL; const b = new Buffer(this, RTYPE.VERTEXBUFFER, c.arg(1), c.arg(2), c.arg(3), c.arg(4)); if (!b.mem) return E_OUTOFMEMORY; mem.write32(pp, b.ptr = com.create(c.proc, 'IDirect3DVertexBuffer8', b)); this.gfx?.createBuffer?.(b); return D3D_OK; }
    CreateIndexBuffer(c) { const pp = c.arg(5); if (!pp || !c.arg(1)) return D3DERR_INVALIDCALL; const b = new Buffer(this, RTYPE.INDEXBUFFER, c.arg(1), c.arg(2), c.arg(3), c.arg(4)); if (!b.mem) return E_OUTOFMEMORY; mem.write32(pp, b.ptr = com.create(c.proc, 'IDirect3DIndexBuffer8', b)); this.gfx?.createBuffer?.(b); return D3D_OK; }
    CreateRenderTarget(c) { const pp = c.arg(6); if (!pp) return D3DERR_INVALIDCALL; const s = new Surface(this, null, c.arg(3), c.arg(1), c.arg(2), USAGE_RENDERTARGET, POOL.DEFAULT); s.lockable = c.arg(5) !== 0; mem.write32(pp, s.ptrOf(c)); this.gfx?.createSurface?.(s); return D3D_OK; }
    CreateDepthStencilSurface(c) { const pp = c.arg(4); if (!pp) return D3DERR_INVALIDCALL; const s = new Surface(this, null, c.arg(3), c.arg(1), c.arg(2), USAGE_DEPTHSTENCIL, POOL.DEFAULT); mem.write32(pp, s.ptrOf(c)); this.gfx?.createSurface?.(s); return D3D_OK; }
    CreateImageSurface(c) { const pp = c.arg(4); if (!pp) return D3DERR_INVALIDCALL; const s = new Surface(this, null, c.arg(3), c.arg(1), c.arg(2), 0, POOL.SYSTEMMEM); s.lockable = true; mem.write32(pp, s.ptrOf(c)); return D3D_OK; }
    CopyRects(c) {
      const src = com.implAt(c.arg(1)), rects = c.arg(2), n = c.arg(3), dst = com.implAt(c.arg(4)), points = c.arg(5);
      if (!(src instanceof Surface) || !(dst instanceof Surface)) return D3DERR_INVALIDCALL;
      if (src.fmt !== dst.fmt) return D3DERR_INVALIDCALL;
      if (this.gfx?.copyRects) return this.gfx.copyRects(src, dst, rects, n, points);
      const sb = src.ensureMem(c.proc), db = dst.ensureMem(c.proc);
      const bpp = surfacePitch(src.fmt, 1);
      const copy = (sx, sy, w, h, dx, dy) => { for (let y = 0; y < h; y++) mem.copy(db + (dy + y) * dst.pitch + dx * bpp, sb + (sy + y) * src.pitch + sx * bpp, w * bpp); };
      if (!rects || !n) copy(0, 0, Math.min(src.width, dst.width), Math.min(src.height, dst.height), 0, 0);
      else for (let i = 0; i < n; i++) { const r = rects + 16 * i; const l = mem.readS32(r), t = mem.readS32(r + 4), rr = mem.readS32(r + 8), b = mem.readS32(r + 12); const dx = points ? mem.readS32(points + 8 * i) : 0, dy = points ? mem.readS32(points + 8 * i + 4) : 0; copy(l, t, Math.min(rr - l, dst.width - dx), Math.min(b - t, dst.height - dy), dx, dy); }
      dst.dirty = true;
      return D3D_OK;
    }
    UpdateTexture(c) { const s = com.implAt(c.arg(1)), d = com.implAt(c.arg(2)); if (!s || !d || s.type !== d.type) return D3DERR_INVALIDCALL; if (s instanceof Texture && d instanceof Texture) { for (let i = 0; i < Math.min(s.levels.length, d.levels.length); i++) { const a = s.levels[i], b = d.levels[i]; if (a.mem && a.width === b.width && a.height === b.height) { mem.copy(b.ensureMem(c.proc), a.mem, a.bytes); b.dirty = true; this.gfx?.surfaceUpdated?.(b); } } d.updatedFrom = s; } return D3D_OK; }
    GetFrontBuffer(c) { const s = com.implAt(c.arg(1)); if (!(s instanceof Surface)) return D3DERR_INVALIDCALL; if (this.gfx?.readbackFrontBuffer) this.gfx.readbackFrontBuffer(s); else { const b = this.backBuffers[0]; if (b.mem && b.fmt === s.fmt) mem.copy(s.ensureMem(c.proc), b.mem, Math.min(b.bytes, s.bytes)); } return D3D_OK; }
    SetRenderTarget(c) { const rt = c.arg(1) ? com.implAt(c.arg(1)) : null, ds = c.arg(2) ? com.implAt(c.arg(2)) : null; if (c.arg(1) && !(rt instanceof Surface)) return D3DERR_INVALIDCALL; if (rt) { this.renderTarget = rt; this.viewport = { x: 0, y: 0, w: rt.width, h: rt.height, minZ: 0, maxZ: 1 }; } this.depthTarget = c.arg(2) ? ds : null; this.gfx?.setRenderTarget?.(this.renderTarget, this.depthTarget); return D3D_OK; }
    GetRenderTarget(c) { const pp = c.arg(1); if (!pp) return D3DERR_INVALIDCALL; mem.write32(pp, this.renderTarget.ptrOf(c)); return D3D_OK; }
    GetDepthStencilSurface(c) { const pp = c.arg(1); if (!pp) return D3DERR_INVALIDCALL; if (!this.depthTarget) { mem.write32(pp, 0); return D3DERR_NOTFOUND; } mem.write32(pp, this.depthTarget.ptrOf(c)); return D3D_OK; }
    // ---- scene
    BeginScene() { if (this.sceneDepth) return D3DERR_INVALIDCALL; this.sceneDepth = 1; this.gfx?.beginScene?.(); return D3D_OK; }
    EndScene() { if (!this.sceneDepth) return D3DERR_INVALIDCALL; this.sceneDepth = 0; this.gfx?.endScene?.(); return D3D_OK; }
    Clear(c) { const n = c.arg(1), rects = c.arg(2), flags = c.arg(3), color = c.arg(4), z = c.argF32(5), stencil = c.arg(6); this.gfx?.clear?.(n, rects, flags, color, z, stencil); if (!this.gfx) this.clears = (this.clears ?? 0) + 1; return D3D_OK; }
    touchTransform(st) { this.transformSlotVersion.set(st, ++this.transformVersion); }
    touchAllTransforms() { this.transformAllVersion = ++this.transformVersion; }
    SetTransform(c) {
      const st = c.arg(1), p = c.arg(2);
      if (!p) return D3DERR_INVALIDCALL;
      // games re-send the same view/projection before every object: an identical matrix changes nothing
      const cur = this.transforms.get(st);
      if (cur) { let same = true; for (let i = 0; i < 16; i++) if ((mem.read32(p + 4 * i) >>> 0) !== f32bits(cur[i])) { same = false; break; } if (same) return D3D_OK; }
      this.touchTransform(st);
      const m = new Float32Array(16); for (let i = 0; i < 16; i++) m[i] = mem.readF32(p + 4 * i);
      this.transforms.set(st, m); this.gfx?.setTransform?.(st, m); return D3D_OK;
    }
    GetTransform(c) { const m = this.transforms.get(c.arg(1)), p = c.arg(2); if (!p) return D3DERR_INVALIDCALL; for (let i = 0; i < 16; i++) mem.writeF32(p + 4 * i, m ? m[i] : (i % 5 === 0 ? 1 : 0)); return D3D_OK; }
    MultiplyTransform(c) { const st = c.arg(1), p = c.arg(2); this.touchTransform(st); const a = this.transforms.get(st) ?? Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); const b = new Float32Array(16); for (let i = 0; i < 16; i++) b[i] = mem.readF32(p + 4 * i); const r = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += b[i * 4 + k] * a[k * 4 + j]; r[i * 4 + j] = s; } this.transforms.set(st, r); this.gfx?.setTransform?.(st, r); return D3D_OK; }
    SetViewport(c) { this.viewportVersion++; const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; this.viewport = { x: mem.read32(p), y: mem.read32(p + 4), w: mem.read32(p + 8), h: mem.read32(p + 12), minZ: mem.readF32(p + 16), maxZ: mem.readF32(p + 20) }; this.gfx?.setViewport?.(this.viewport); return D3D_OK; }
    GetViewport(c) { const p = c.arg(1), v = this.viewport; if (!p) return D3DERR_INVALIDCALL; mem.write32(p, v.x); mem.write32(p + 4, v.y); mem.write32(p + 8, v.w); mem.write32(p + 12, v.h); mem.writeF32(p + 16, v.minZ); mem.writeF32(p + 20, v.maxZ); return D3D_OK; }
    SetMaterial(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; let same = true; for (let i = 0; i < 17; i++) { const v = mem.readF32(p + 4 * i); if (v !== this.material[i]) { same = false; this.material[i] = v; } } if (same) return D3D_OK; this.lightVersion++; this.gfx?.setMaterial?.(this.material); return D3D_OK; }
    GetMaterial(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; for (let i = 0; i < 17; i++) mem.writeF32(p + 4 * i, this.material[i]); return D3D_OK; }
    SetLight(c) {
      const i = c.arg(1), p = c.arg(2); if (!p) return D3DERR_INVALIDCALL;
      // games re-send the same lights before every object: an unchanged light must not re-upload the light block
      const old = this.lights.get(i);
      const l = old ?? new Float32Array(26);
      let same = !!old;
      for (let k = 1; k < 26; k++) { const v = mem.readF32(p + 4 * k); if (v !== l[k]) { same = false; l[k] = v; } }
      const type = mem.read32(p); if (type !== l[0]) { same = false; if (this.lightEnabled.has(i)) { this.stateVersion++; this.programVersion++; } /* the program key holds the types of the enabled lights */ l[0] = type; }
      if (same) return D3D_OK;
      this.lightVersion++; this.lights.set(i, l); this.gfx?.setLight?.(i, l); return D3D_OK; }
    GetLight(c) { const l = this.lights.get(c.arg(1)), p = c.arg(2); if (!l || !p) return D3DERR_INVALIDCALL; for (let k = 0; k < 26; k++) mem.writeF32(p + 4 * k, l[k]); mem.write32(p, l[0]); return D3D_OK; }
    LightEnable(c) { const i = c.arg(1), want = c.arg(2) !== 0; if (this.lightEnabled.has(i) !== want) { this.lightVersion++; this.stateVersion++; this.programVersion++; } if (want) this.lightEnabled.add(i); else this.lightEnabled.delete(i); if (!this.lights.has(i)) { const l = new Float32Array(26); l[0] = 3; l[1] = l[2] = l[3] = l[4] = 1; l[19] = 1; this.lights.set(i, l); } this.gfx?.lightEnable?.(i, c.arg(2) !== 0); return D3D_OK; }
    GetLightEnable(c) { c.out32(2, this.lightEnabled.has(c.arg(1)) ? 1 : 0); return D3D_OK; }
    SetClipPlane(c) { const p = c.arg(2); const v = new Float32Array(4); for (let i = 0; i < 4; i++) v[i] = mem.readF32(p + 4 * i); this.clipPlanes.set(c.arg(1), v); this.gfx?.setClipPlane?.(c.arg(1), v); return D3D_OK; }
    GetClipPlane(c) { const v = this.clipPlanes.get(c.arg(1)), p = c.arg(2); for (let i = 0; i < 4; i++) mem.writeF32(p + 4 * i, v ? v[i] : 0); return D3D_OK; }
    // redundant state sets (same value) are the common case in engines: they must not invalidate the program memo
    // nor re-upload the state uniforms
    SetRenderState(c) { const s = c.arg(1), v = c.arg(2); if (this.recording) { this.recording.rs.set(s, v); return D3D_OK; } if (this.rs.get(s) === v) return D3D_OK; this.stateVersion++; if (PROGRAM_RS.has(s)) this.programVersion++; this.rs.set(s, v); noteState(this, 'rs', s, v); this.gfx?.setRenderState?.(s, v); return D3D_OK; }
    GetRenderState(c) { c.out32(2, this.rs.get(c.arg(1)) ?? 0); return D3D_OK; }
    BeginStateBlock() { if (this.recording) return D3DERR_INVALIDCALL; this.recording = { rs: new Map(), tss: new Map(), textures: new Map(), transforms: new Map(), vs: undefined, ps: undefined }; return D3D_OK; }
    EndStateBlock(c) { if (!this.recording) return D3DERR_INVALIDCALL; const id = this.nextSB++; this.stateBlocks.set(id, this.recording); this.recording = null; c.out32(1, id); return D3D_OK; }
    ApplyStateBlock(c) { this.stateVersion++; this.programVersion++; this.touchAllTransforms(); this.lightVersion++; this.viewportVersion++; this.constVersion++; const sb = this.stateBlocks.get(c.arg(1)); if (!sb) return D3DERR_INVALIDCALL; for (const [s, v] of sb.rs) { this.rs.set(s, v); this.gfx?.setRenderState?.(s, v); } for (const [k, v] of sb.tss) { const [st, ty] = k.split(':').map(Number); this.tss[st].set(ty, v); this.gfx?.setTextureStageState?.(st, ty, v); } for (const [st, t] of sb.textures) { this.textures[st] = t; this.gfx?.setTexture?.(st, t ? com.implAt(t) : null); } for (const [st, m] of sb.transforms) { this.transforms.set(st, m); this.gfx?.setTransform?.(st, m); } if (sb.vs !== undefined) { this.vertexShader = sb.vs; this.gfx?.setVertexShader?.(sb.vs, this.vertexShaders.get(sb.vs)); } if (sb.ps !== undefined) { this.pixelShader = sb.ps; this.gfx?.setPixelShader?.(sb.ps, this.pixelShaders.get(sb.ps)); } return D3D_OK; }
    CaptureStateBlock(c) { const sb = this.stateBlocks.get(c.arg(1)); if (!sb) return D3DERR_INVALIDCALL; for (const s of sb.rs.keys()) sb.rs.set(s, this.rs.get(s) ?? 0); for (const k of sb.tss.keys()) { const [st, ty] = k.split(':').map(Number); sb.tss.set(k, this.tss[st].get(ty) ?? 0); } for (const st of sb.textures.keys()) sb.textures.set(st, this.textures[st]); for (const st of sb.transforms.keys()) sb.transforms.set(st, this.transforms.get(st)); if (sb.vs !== undefined) sb.vs = this.vertexShader; if (sb.ps !== undefined) sb.ps = this.pixelShader; return D3D_OK; }
    DeleteStateBlock(c) { return this.stateBlocks.delete(c.arg(1)) ? D3D_OK : D3DERR_INVALIDCALL; }
    CreateStateBlock(c) { const type = c.arg(1), pp = c.arg(2); if (!pp) return D3DERR_INVALIDCALL; const sb = { rs: new Map(), tss: new Map(), textures: new Map(), transforms: new Map(), vs: undefined, ps: undefined }; if (type === 1 || type === 3) { for (const [s, v] of this.rs) sb.rs.set(s, v); for (let st = 0; st < MAX_STAGES; st++) for (const [ty, v] of this.tss[st]) sb.tss.set(`${st}:${ty}`, v); sb.ps = this.pixelShader; } if (type === 2 || type === 3) { for (const [s, m] of this.transforms) sb.transforms.set(s, m); sb.vs = this.vertexShader; } if (type === 3) for (let st = 0; st < MAX_STAGES; st++) sb.textures.set(st, this.textures[st]); const id = this.nextSB++; this.stateBlocks.set(id, sb); mem.write32(pp, id); return D3D_OK; }
    SetClipStatus() { return D3D_OK; }
    GetClipStatus(c) { const p = c.arg(1); if (p) { mem.write32(p, 0); mem.write32(p + 4, 0); } return D3D_OK; }
    GetTexture(c) { const st = c.arg(1), pp = c.arg(2); if (st >= MAX_STAGES || !pp) return D3DERR_INVALIDCALL; const t = this.textures[st]; mem.write32(pp, t); if (t) com.addRef(com.objectAt(t)); return D3D_OK; }
    /** kind of a bound texture for the backend's program key: 0 none, 1 2D, 2 cube, 3 volume */
    texKind(ptr) { const t = ptr ? com.implAt(ptr) : null; return !t ? 0 : t.faces ? 2 : t.depth ? 3 : 1; }
    SetTexture(c) { const st = c.arg(1), t = c.arg(2); if (st >= MAX_STAGES) return D3DERR_INVALIDCALL; if (t && !com.implAt(t)) return D3DERR_INVALIDCALL; if (this.recording) { this.recording.textures.set(st, t); return D3D_OK; } if (this.textures[st] !== t) { this.stateVersion++; if (this.texKind(this.textures[st]) !== this.texKind(t)) this.programVersion++; if (t) com.addRef(com.objectAt(t)); if (this.textures[st]) com.release(com.objectAt(this.textures[st])); this.textures[st] = t; } this.gfx?.setTexture?.(st, t ? com.implAt(t) : null); return D3D_OK; }
    GetTextureStageState(c) { const st = c.arg(1); if (st >= MAX_STAGES) return D3DERR_INVALIDCALL; c.out32(3, this.tss[st].get(c.arg(2)) ?? 0); return D3D_OK; }
    SetTextureStageState(c) { const st = c.arg(1), ty = c.arg(2), v = c.arg(3); if (st >= MAX_STAGES) return D3DERR_INVALIDCALL; if (this.recording) { this.recording.tss.set(`${st}:${ty}`, v); return D3D_OK; } if (this.tss[st].get(ty) === v) return D3D_OK; this.stateVersion++; if (PROGRAM_TSS.has(ty)) this.programVersion++; noteState(this, 'tss' + st, ty, v); this.tss[st].set(ty, v); this.gfx?.setTextureStageState?.(st, ty, v); return D3D_OK; }
    ValidateDevice(c) { c.out32(1, 1); return D3D_OK; }
    GetInfo() { return S_FALSE; }
    SetPaletteEntries(c) { const n = c.arg(1), p = c.arg(2); const pal = new Uint32Array(256); for (let i = 0; i < 256; i++) pal[i] = mem.read32(p + 4 * i); this.palettes.set(n, pal); return D3D_OK; }
    GetPaletteEntries(c) { const pal = this.palettes.get(c.arg(1)), p = c.arg(2); if (!pal) return D3DERR_INVALIDCALL; for (let i = 0; i < 256; i++) mem.write32(p + 4 * i, pal[i]); return D3D_OK; }
    SetCurrentTexturePalette(c) { this.currentPalette = c.arg(1); return D3D_OK; }
    GetCurrentTexturePalette(c) { c.out32(1, this.currentPalette); return D3D_OK; }
    // ---- drawing
    DrawPrimitive(c) { const type = c.arg(1), start = c.arg(2), count = c.arg(3); this.draws++; this.gfx?.drawPrimitive?.(type, start, count); return D3D_OK; }
    DrawIndexedPrimitive(c) { const type = c.arg(1), minIdx = c.arg(2), numV = c.arg(3), start = c.arg(4), count = c.arg(5); this.draws++; this.gfx?.drawIndexedPrimitive?.(type, minIdx, numV, start, count); return D3D_OK; }
    DrawPrimitiveUP(c) { const type = c.arg(1), count = c.arg(2), data = c.arg(3), stride = c.arg(4); this.draws++; this.gfx?.drawPrimitiveUP?.(type, count, data, stride); return D3D_OK; }
    DrawIndexedPrimitiveUP(c) { const type = c.arg(1), minIdx = c.arg(2), numV = c.arg(3), count = c.arg(4), idx = c.arg(5), ifmt = c.arg(6), data = c.arg(7), stride = c.arg(8); this.draws++; this.gfx?.drawIndexedPrimitiveUP?.(type, minIdx, numV, count, idx, ifmt, data, stride); return D3D_OK; }
    ProcessVertices() { return D3DERR_INVALIDCALL; }
    CreateVertexShader(c) {
      const decl = c.arg(1), fn = c.arg(2), pp = c.arg(3), usage = c.arg(4);
      if (!decl || !pp) return D3DERR_INVALIDCALL;
      const tokens = []; for (let p = decl; ; p += 4) { const t = mem.read32(p); tokens.push(t); if (t === 0xffffffff || tokens.length > 256) break; }
      let code = null; if (fn) { code = []; for (let p = fn; ; p += 4) { const t = mem.read32(p); code.push(t); if (t === 0x0000ffff || code.length > 4096) break; } }
      const h = (this.nextShader++ << 1) | 0; // even handles: shaders; odd/small values with FVF bits would be FVF codes
      const sh = { handle: h, decl: Uint32Array.from(tokens), code: code ? Uint32Array.from(code) : null, usage };
      this.vertexShaders.set(h, sh);
      mem.write32(pp, h);
      this.gfx?.createVertexShader?.(sh);
      return D3D_OK;
    }
    SetVertexShader(c) { this.stateVersion++; this.programVersion++; const h = c.arg(1); if (this.recording) { this.recording.vs = h; return D3D_OK; } this.vertexShader = h; this.gfx?.setVertexShader?.(h, this.vertexShaders.get(h)); return D3D_OK; }
    GetVertexShader(c) { c.out32(1, this.vertexShader); return D3D_OK; }
    DeleteVertexShader(c) { const sh = this.vertexShaders.get(c.arg(1)); if (!sh) return D3DERR_INVALIDCALL; this.vertexShaders.delete(c.arg(1)); this.programVersion++; this.gfx?.deleteVertexShader?.(sh); return D3D_OK; }
    SetVertexShaderConstant(c) { this.constVersion++; const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 96) return D3DERR_INVALIDCALL; for (let i = 0; i < n * 4; i++) this.vsConst[reg * 4 + i] = mem.readF32(p + 4 * i); this.gfx?.setVertexShaderConstant?.(reg, n, this.vsConst); return D3D_OK; }
    GetVertexShaderConstant(c) { const reg = c.arg(1), p = c.arg(2), n = c.arg(3); for (let i = 0; i < n * 4; i++) mem.writeF32(p + 4 * i, this.vsConst[reg * 4 + i]); return D3D_OK; }
    GetVertexShaderDeclaration(c) { const sh = this.vertexShaders.get(c.arg(1)), p = c.arg(2), ps = c.arg(3); if (!sh) return D3DERR_INVALIDCALL; const size = mem.read32(ps); mem.write32(ps, sh.decl.length * 4); if (!p) return D3D_OK; if (size < sh.decl.length * 4) return D3DERR_MOREDATA; for (let i = 0; i < sh.decl.length; i++) mem.write32(p + 4 * i, sh.decl[i]); return D3D_OK; }
    GetVertexShaderFunction(c) { const sh = this.vertexShaders.get(c.arg(1)), p = c.arg(2), ps = c.arg(3); if (!sh) return D3DERR_INVALIDCALL; const code = sh.code ?? new Uint32Array(0); const size = mem.read32(ps); mem.write32(ps, code.length * 4); if (!p) return D3D_OK; if (size < code.length * 4) return D3DERR_MOREDATA; for (let i = 0; i < code.length; i++) mem.write32(p + 4 * i, code[i]); return D3D_OK; }
    SetStreamSource(c) { const n = c.arg(1), vb = c.arg(2), stride = c.arg(3); if (n >= MAX_STREAMS) return D3DERR_INVALIDCALL; const s = this.streams[n]; if (s.vb !== vb) { if (vb) com.addRef(com.objectAt(vb)); if (s.vb) com.release(com.objectAt(s.vb)); s.vb = vb; } s.stride = stride; this.gfx?.setStreamSource?.(n, vb ? com.implAt(vb) : null, stride); return D3D_OK; }
    GetStreamSource(c) { const n = c.arg(1); if (n >= MAX_STREAMS) return D3DERR_INVALIDCALL; const s = this.streams[n]; c.out32(2, s.vb); if (s.vb) com.addRef(com.objectAt(s.vb)); c.out32(3, s.stride); return D3D_OK; }
    SetIndices(c) { const ib = c.arg(1), base = c.arg(2); if (this.indices.ib !== ib) { if (ib) com.addRef(com.objectAt(ib)); if (this.indices.ib) com.release(com.objectAt(this.indices.ib)); this.indices.ib = ib; } this.indices.base = base; this.gfx?.setIndices?.(ib ? com.implAt(ib) : null, base); return D3D_OK; }
    GetIndices(c) { c.out32(1, this.indices.ib); if (this.indices.ib) com.addRef(com.objectAt(this.indices.ib)); c.out32(2, this.indices.base); return D3D_OK; }
    CreatePixelShader(c) { const fn = c.arg(1), pp = c.arg(2); if (!fn || !pp) return D3DERR_INVALIDCALL; const code = []; for (let p = fn; ; p += 4) { const t = mem.read32(p); code.push(t); if (t === 0x0000ffff || code.length > 4096) break; } const h = this.nextShader++; const sh = { handle: h, code: Uint32Array.from(code) }; this.pixelShaders.set(h, sh); mem.write32(pp, h); this.gfx?.createPixelShader?.(sh); return D3D_OK; }
    SetPixelShader(c) { this.stateVersion++; this.programVersion++; const h = c.arg(1); if (this.recording) { this.recording.ps = h; return D3D_OK; } this.pixelShader = h; this.gfx?.setPixelShader?.(h, this.pixelShaders.get(h)); return D3D_OK; }
    GetPixelShader(c) { c.out32(1, this.pixelShader); return D3D_OK; }
    DeletePixelShader(c) { const sh = this.pixelShaders.get(c.arg(1)); if (!sh) return D3DERR_INVALIDCALL; this.pixelShaders.delete(c.arg(1)); this.programVersion++; this.gfx?.deletePixelShader?.(sh); return D3D_OK; }
    SetPixelShaderConstant(c) { this.constVersion++; const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 8) return D3DERR_INVALIDCALL; for (let i = 0; i < n * 4; i++) this.psConst[reg * 4 + i] = mem.readF32(p + 4 * i); this.gfx?.setPixelShaderConstant?.(reg, n, this.psConst); return D3D_OK; }
    GetPixelShaderConstant(c) { const reg = c.arg(1), p = c.arg(2), n = c.arg(3); for (let i = 0; i < n * 4; i++) mem.writeF32(p + 4 * i, this.psConst[reg * 4 + i]); return D3D_OK; }
    GetPixelShaderFunction(c) { const sh = this.pixelShaders.get(c.arg(1)), p = c.arg(2), ps = c.arg(3); if (!sh) return D3DERR_INVALIDCALL; const size = mem.read32(ps); mem.write32(ps, sh.code.length * 4); if (!p) return D3D_OK; if (size < sh.code.length * 4) return D3DERR_MOREDATA; for (let i = 0; i < sh.code.length; i++) mem.write32(p + 4 * i, sh.code[i]); return D3D_OK; }
    DrawRectPatch() { return D3DERR_INVALIDCALL; }
    DrawTriPatch() { return D3DERR_INVALIDCALL; }
    DeletePatch() { return D3DERR_INVALIDCALL; }
  }

  vm.d3dCore = { Resource, Surface, Texture, CubeTexture, VolumeTexture, Buffer, Device, writeCaps, displayMode, writeMode, modes, RS_DEFAULTS, TSS_DEFAULTS, MAX_STAGES, MAX_STREAMS, allocResId: () => nextResId++ };
  return vm.d3dCore;
}

export function registerDirect3D8(api, vm) {
  const mem = vm.mem, com = vm.com;
  const I = (name, iid, parent, methods) => com.interface(name, iid, parent, methods);
  I('IDirect3D8', IID_IDirect3D8, 'IUnknown', [['RegisterSoftwareDevice', 1], ['GetAdapterCount', 0], ['GetAdapterIdentifier', 3], ['GetAdapterModeCount', 1], ['EnumAdapterModes', 3], ['GetAdapterDisplayMode', 2], ['CheckDeviceType', 5], ['CheckDeviceFormat', 6], ['CheckDeviceMultiSampleType', 5], ['CheckDepthStencilMatch', 5], ['GetDeviceCaps', 3], ['GetAdapterMonitor', 1], ['CreateDevice', 6]]);
  I('IDirect3DDevice8', IID_IDirect3DDevice8, 'IUnknown', [['TestCooperativeLevel', 0], ['GetAvailableTextureMem', 0], ['ResourceManagerDiscardBytes', 1], ['GetDirect3D', 1], ['GetDeviceCaps', 1], ['GetDisplayMode', 1], ['GetCreationParameters', 1], ['SetCursorProperties', 3], ['SetCursorPosition', 3], ['ShowCursor', 1], ['CreateAdditionalSwapChain', 2], ['Reset', 1], ['Present', 4], ['GetBackBuffer', 3], ['GetRasterStatus', 1], ['SetGammaRamp', 2], ['GetGammaRamp', 1], ['CreateTexture', 7], ['CreateVolumeTexture', 8], ['CreateCubeTexture', 6], ['CreateVertexBuffer', 5], ['CreateIndexBuffer', 5], ['CreateRenderTarget', 6], ['CreateDepthStencilSurface', 4], ['CreateImageSurface', 4], ['CopyRects', 5], ['UpdateTexture', 2], ['GetFrontBuffer', 1], ['SetRenderTarget', 2], ['GetRenderTarget', 1], ['GetDepthStencilSurface', 1], ['BeginScene', 0], ['EndScene', 0], ['Clear', 6], ['SetTransform', 2], ['GetTransform', 2], ['MultiplyTransform', 2], ['SetViewport', 1], ['GetViewport', 1], ['SetMaterial', 1], ['GetMaterial', 1], ['SetLight', 2], ['GetLight', 2], ['LightEnable', 2], ['GetLightEnable', 2], ['SetClipPlane', 2], ['GetClipPlane', 2], ['SetRenderState', 2], ['GetRenderState', 2], ['BeginStateBlock', 0], ['EndStateBlock', 1], ['ApplyStateBlock', 1], ['CaptureStateBlock', 1], ['DeleteStateBlock', 1], ['CreateStateBlock', 2], ['SetClipStatus', 1], ['GetClipStatus', 1], ['GetTexture', 2], ['SetTexture', 2], ['GetTextureStageState', 3], ['SetTextureStageState', 3], ['ValidateDevice', 1], ['GetInfo', 3], ['SetPaletteEntries', 2], ['GetPaletteEntries', 2], ['SetCurrentTexturePalette', 1], ['GetCurrentTexturePalette', 1], ['DrawPrimitive', 3], ['DrawIndexedPrimitive', 5], ['DrawPrimitiveUP', 4], ['DrawIndexedPrimitiveUP', 8], ['ProcessVertices', 5], ['CreateVertexShader', 4], ['SetVertexShader', 1], ['GetVertexShader', 1], ['DeleteVertexShader', 1], ['SetVertexShaderConstant', 3], ['GetVertexShaderConstant', 3], ['GetVertexShaderDeclaration', 3], ['GetVertexShaderFunction', 3], ['SetStreamSource', 3], ['GetStreamSource', 3], ['SetIndices', 2], ['GetIndices', 2], ['CreatePixelShader', 2], ['SetPixelShader', 1], ['GetPixelShader', 1], ['DeletePixelShader', 1], ['SetPixelShaderConstant', 3], ['GetPixelShaderConstant', 3], ['GetPixelShaderFunction', 3], ['DrawRectPatch', 3], ['DrawTriPatch', 3], ['DeletePatch', 1]]);
  const resourceMethods = [['GetDevice', 1], ['SetPrivateData', 4], ['GetPrivateData', 3], ['FreePrivateData', 1], ['SetPriority', 1], ['GetPriority', 0], ['PreLoad', 0], ['GetType', 0]];
  I('IDirect3DResource8', IID_IDirect3DResource8, 'IUnknown', resourceMethods);
  I('IDirect3DBaseTexture8', IID_IDirect3DBaseTexture8, 'IDirect3DResource8', [['SetLOD', 1], ['GetLOD', 0], ['GetLevelCount', 0]]);
  I('IDirect3DTexture8', IID_IDirect3DTexture8, 'IDirect3DBaseTexture8', [['GetLevelDesc', 2], ['GetSurfaceLevel', 2], ['LockRect', 4], ['UnlockRect', 1], ['AddDirtyRect', 1]]);
  I('IDirect3DCubeTexture8', IID_IDirect3DCubeTexture8, 'IDirect3DBaseTexture8', [['GetLevelDesc', 2], ['GetCubeMapSurface', 3], ['LockRect', 5], ['UnlockRect', 2], ['AddDirtyRect', 2]]);
  I('IDirect3DVolumeTexture8', IID_IDirect3DVolumeTexture8, 'IDirect3DBaseTexture8', [['GetLevelDesc', 2], ['GetVolumeLevel', 2], ['LockBox', 4], ['UnlockBox', 1], ['AddDirtyBox', 1]]);
  I('IDirect3DVertexBuffer8', IID_IDirect3DVertexBuffer8, 'IDirect3DResource8', [['Lock', 4], ['Unlock', 0], ['GetDesc', 1]]);
  I('IDirect3DIndexBuffer8', IID_IDirect3DIndexBuffer8, 'IDirect3DResource8', [['Lock', 4], ['Unlock', 0], ['GetDesc', 1]]);
  I('IDirect3DSurface8', IID_IDirect3DSurface8, 'IUnknown', [['GetDevice', 1], ['SetPrivateData', 4], ['GetPrivateData', 3], ['FreePrivateData', 1], ['GetContainer', 2], ['GetDesc', 1], ['LockRect', 3], ['UnlockRect', 0]]);
  I('IDirect3DVolume8', IID_IDirect3DVolume8, 'IUnknown', [['GetDevice', 1], ['SetPrivateData', 4], ['GetPrivateData', 3], ['FreePrivateData', 1], ['GetContainer', 2], ['GetDesc', 1], ['LockBox', 3], ['UnlockBox', 0]]);
  I('IDirect3DSwapChain8', IID_IDirect3DSwapChain8, 'IUnknown', [['Present', 4], ['GetBackBuffer', 3]]);

  const { Resource, Surface, Texture, CubeTexture, VolumeTexture, Buffer, Device, writeCaps, displayMode, writeMode, modes } = d3dCore(vm);
  void Resource; void Texture; void CubeTexture; void VolumeTexture; void Buffer;
  // ---------------------------------------------------------------- IDirect3D8
  class Direct3D {
    constructor(sdk) { this.sdk = sdk; this.iids = [IID_IDirect3D8]; }
    RegisterSoftwareDevice() { return D3D_OK; }
    GetAdapterCount() { return 1; }
    GetAdapterIdentifier(c) {
      const adapter = c.arg(1), p = c.arg(3);
      if (adapter !== 0 || !p) return D3DERR_INVALIDCALL;
      mem.fill(p, 1068, 0);
      mem.writeCString(p, 'orthros.dll', 512); mem.writeCString(p + 512, 'Orthros WebGL2 Display Adapter', 512);
      mem.write32(p + 1024, 0x00010000); mem.write32(p + 1028, 0x00060000); // DriverVersion 6.0.1.0
      mem.write32(p + 1032, 0x1002); mem.write32(p + 1036, 0x4e44); mem.write32(p + 1040, 0); mem.write32(p + 1044, 0); // VendorId (ATI-like, generic), DeviceId
      writeGuid(mem, p + 1048, 'd7b71ee2-0000-11cf-0000-000000000000');
      mem.write32(p + 1064, 0);
      return D3D_OK;
    }
    GetAdapterModeCount(c) { return c.arg(1) === 0 ? modes().length : 0; }
    EnumAdapterModes(c) { const m = modes()[c.arg(2)], p = c.arg(3); if (c.arg(1) !== 0 || !m || !p) return D3DERR_INVALIDCALL; writeMode(p, m); return D3D_OK; }
    GetAdapterDisplayMode(c) { const p = c.arg(2); if (c.arg(1) !== 0 || !p) return D3DERR_INVALIDCALL; writeMode(p, displayMode()); return D3D_OK; }
    CheckDeviceType(c) { const adapter = c.arg(1), devType = c.arg(2), disp = c.arg(3), bb = c.arg(4), windowed = c.arg(5); if (adapter !== 0) return D3DERR_INVALIDCALL; if (devType !== 1 && devType !== 2) return D3DERR_NOTAVAILABLE; if (!DISPLAY_FORMATS.has(disp)) return D3DERR_NOTAVAILABLE; if (bb !== FMT.UNKNOWN && !BACKBUFFER_FORMATS.has(bb)) return D3DERR_NOTAVAILABLE; void windowed; return D3D_OK; }
    CheckDeviceFormat(c) {
      const adapter = c.arg(1), adapterFmt = c.arg(3), usage = c.arg(4), rtype = c.arg(5), fmt = c.arg(6);
      if (adapter !== 0) return D3DERR_INVALIDCALL;
      void adapterFmt;
      if (rtype === RTYPE.SURFACE && (usage & USAGE_DEPTHSTENCIL)) return DEPTH_FORMATS.has(fmt) ? D3D_OK : D3DERR_NOTAVAILABLE;
      if (usage & USAGE_RENDERTARGET) return BACKBUFFER_FORMATS.has(fmt) ? D3D_OK : D3DERR_NOTAVAILABLE;
      if (rtype === RTYPE.TEXTURE || rtype === RTYPE.CUBETEXTURE || rtype === RTYPE.VOLUMETEXTURE || rtype === RTYPE.SURFACE) return TEXTURE_FORMATS.has(fmt) || (rtype === RTYPE.SURFACE && (BACKBUFFER_FORMATS.has(fmt) || DEPTH_FORMATS.has(fmt))) ? D3D_OK : D3DERR_NOTAVAILABLE;
      return D3D_OK;
    }
    CheckDeviceMultiSampleType(c) { return c.arg(5) <= 1 ? D3D_OK : D3DERR_NOTAVAILABLE; }
    CheckDepthStencilMatch(c) { return DEPTH_FORMATS.has(c.arg(5)) ? D3D_OK : D3DERR_NOTAVAILABLE; }
    GetDeviceCaps(c) { const p = c.arg(3); if (c.arg(1) !== 0 || !p) return D3DERR_INVALIDCALL; writeCaps(p, 0, c.arg(2)); return D3D_OK; }
    GetAdapterMonitor(c) { return c.arg(1) === 0 ? 0x10001 : 0; }
    CreateDevice(c) {
      const adapter = c.arg(1), devType = c.arg(2), hFocus = c.arg(3), behavior = c.arg(4), pp = c.arg(5), out = c.arg(6);
      if (adapter !== 0 || !pp || !out) return D3DERR_INVALIDCALL;
      const dev = new Device(c, this, adapter, devType, hFocus, behavior, pp);
      dev.ptr = com.create(c.proc, 'IDirect3DDevice8', dev);
      mem.write32(out, dev.ptr);
      vm.d3dDevice = dev;
      vm.log('gfx', `d3d8: CreateDevice ${dev.pp.width}x${dev.pp.height} fmt ${dev.pp.format} ${dev.pp.windowed ? 'windowed' : 'fullscreen'} depth ${dev.pp.autoDepth ? dev.pp.depthFormat : 'none'} behavior 0x${behavior.toString(16)} backend ${dev.gfx ? 'yes' : 'none'}`);
      return D3D_OK;
    }
  }

  api.define('d3d8.dll', {
    Direct3DCreate8: [1, (c) => {
      const sdk = c.arg(0);
      vm.firstD3DCall ??= { name: 'Direct3DCreate8', from: c.proc.symbolize(c.retAddr), apiCalls: vm.apiCalls };
      vm.log('gfx', `Direct3DCreate8(sdk ${sdk}) from ${c.proc.symbolize(c.retAddr)}`);
      const d = new Direct3D(sdk);
      return d.ptr = com.create(c.proc, 'IDirect3D8', d);
    }],
    ValidatePixelShader: [4, () => 0], ValidateVertexShader: [4, () => 0],
    DebugSetMute: [0, () => 0],
  });
  void S_OK; void E_INVALIDARG; void USAGE_DYNAMIC; void D3DERR_DEVICELOST; void D3DERR_DEVICENOTRESET; void D3DERR_OUTOFVIDEOMEMORY; void D3DERR_INVALIDDEVICE; void D3DERR_UNSUPPORTEDTEXTUREFILTER; void D3DERR_WRONGTEXTUREFORMAT;
}
