// d3d9.dll: Direct3D 9 API layer on the shared D3D core (win32/d3d8.js: resources in guest
// memory, device state model) — DX9 vtables, vertex declarations, sampler states, shader objects
// (vs/ps 1.x–2.x), state blocks, swap chain, queries. Rendering goes through the pluggable
// backend (`vm.host.gfx`, see gfx/d3d8-webgl.js).
import { readGuid, writeGuid, S_OK, S_FALSE, E_NOINTERFACE, E_POINTER, E_NOTIMPL, E_OUTOFMEMORY } from './com.js';
import { d3dCore, FMT, D3D_OK, D3DERR_INVALIDCALL, D3DERR_NOTAVAILABLE, D3DERR_NOTFOUND, D3DERR_MOREDATA, surfacePitch, surfaceBytes } from './d3d8.js';
import { declLayout9 } from '../gfx/d3d9-shaders.js';

const IID = {
  IDirect3D9: '81bdcbca-64d4-426d-ae8d-ad0147f4275c', IDirect3DDevice9: 'd0223b96-bf7a-43fd-92bd-a43b0d82b9eb', IDirect3DResource9: '05eec05d-8f7d-4362-b999-d1baf357c704',
  IDirect3DBaseTexture9: '580ca87e-1d3c-4d54-991d-b7d3e3c298ce', IDirect3DTexture9: '85c31227-3de5-4f00-9b3a-f11ac38c18b5', IDirect3DCubeTexture9: 'fff32f81-d953-473a-9223-93d652aba93f', IDirect3DVolumeTexture9: '2033035d-2f7f-4f0e-bd8f-b9c4c7a0c6e7',
  IDirect3DVertexBuffer9: 'b64bb1b5-fd70-4df6-bf91-19d0a12455e3', IDirect3DIndexBuffer9: '7b1e5bf9-0f5a-4d17-9f5d-b1c2a2a6e19f', IDirect3DSurface9: '0cfbaf3a-9ff6-429a-99b3-a2796af8b89b', IDirect3DVolume9: '24f416e6-1f67-4aa7-b88e-d33f6f3128a1',
  IDirect3DVertexDeclaration9: 'dd13c59c-36fa-4098-a8fb-c7ed39dc8546', IDirect3DVertexShader9: 'efc5557e-6265-4613-b5c9-ac9b2ec1a7e1', IDirect3DPixelShader9: '6d3bdbdc-5b02-4415-b852-ce5e8bccb289', IDirect3DStateBlock9: 'b07c4fe5-310d-4ba8-a23c-4f0f206f218b',
  IDirect3DSwapChain9: '794950f2-adfc-458a-905e-10a10b0b503b', IDirect3DQuery9: 'd9771460-a695-4f26-bbd3-27b840b541cc',
};
const RTYPE = { SURFACE: 1, VOLUME: 2, TEXTURE: 3, VOLUMETEXTURE: 4, CUBETEXTURE: 5, VERTEXBUFFER: 6, INDEXBUFFER: 7 };
const POOL = { DEFAULT: 0, MANAGED: 1, SYSTEMMEM: 2, SCRATCH: 3 };
const USAGE_RENDERTARGET = 1, USAGE_DEPTHSTENCIL = 2;
const DISPLAY_FORMATS = new Set([FMT.X8R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A2R10G10B10]);
const BACKBUFFER_FORMATS = new Set([FMT.X8R8G8B8, FMT.A8R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A2R10G10B10]);
const DEPTH_FORMATS = new Set([FMT.D16, FMT.D24S8, FMT.D24X8, FMT.D32, FMT.D16_LOCKABLE, FMT.D15S1, FMT.D24X4S4, 82 /* D24FS8 */]);
const TEXTURE_FORMATS = new Set([FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.R5G6B5, FMT.X1R5G5B5, FMT.A1R5G5B5, FMT.A4R4G4B4, FMT.A8, FMT.L8, FMT.A8L8, FMT.DXT1, FMT.DXT2, FMT.DXT3, FMT.DXT4, FMT.DXT5, FMT.V8U8, FMT.P8, FMT.A4L4, FMT.X4R4G4B4, FMT.A8B8G8R8, FMT.G16R16, FMT.A2B10G10R10, FMT.Q8W8V8U8, FMT.V16U16, FMT.L6V5U5, FMT.X8L8V8U8, 81 /* L16 */]); // no R8G8B8: like every real Direct3D 9 driver, 24-bit textures are not offered (applications keep a conversion path for that)
const MAX_SAMPLERS = 16, MAX_RTS = 4;
const checkedFormats = new Set(), createdFormats = new Set(); // once-per-format diagnostics
const checkTrail = []; // last CheckDeviceFormat calls (args + verdict), kept for the placeholder-texture diagnostic
const fmtName = (f) => (f > 0x20000000 ? String.fromCharCode(f & 0xff, (f >> 8) & 0xff, (f >> 16) & 0xff, f >>> 24) : String(f));

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerDirect3D9(api, vm) {
  const mem = vm.mem, com = vm.com;
  const core = d3dCore(vm);
  const { Surface, Texture, CubeTexture, VolumeTexture, Buffer, Device: Device8, displayMode, writeMode, modes } = core;
  const I = (name, parent, methods) => com.interface(name, IID[name], parent, methods);
  I('IDirect3D9', 'IUnknown', [['RegisterSoftwareDevice', 1], ['GetAdapterCount', 0], ['GetAdapterIdentifier', 3], ['GetAdapterModeCount', 2], ['EnumAdapterModes', 4], ['GetAdapterDisplayMode', 2], ['CheckDeviceType', 5], ['CheckDeviceFormat', 6], ['CheckDeviceMultiSampleType', 6], ['CheckDepthStencilMatch', 5], ['CheckDeviceFormatConversion', 4], ['GetDeviceCaps', 3], ['GetAdapterMonitor', 1], ['CreateDevice', 6]]);
  I('IDirect3DDevice9', 'IUnknown', [['TestCooperativeLevel', 0], ['GetAvailableTextureMem', 0], ['EvictManagedResources', 0], ['GetDirect3D', 1], ['GetDeviceCaps', 1], ['GetDisplayMode', 2], ['GetCreationParameters', 1], ['SetCursorProperties', 3], ['SetCursorPosition', 3], ['ShowCursor', 1], ['CreateAdditionalSwapChain', 2], ['GetSwapChain', 2], ['GetNumberOfSwapChains', 0], ['Reset', 1], ['Present', 4], ['GetBackBuffer', 4], ['GetRasterStatus', 2], ['SetDialogBoxMode', 1], ['SetGammaRamp', 3], ['GetGammaRamp', 2], ['CreateTexture', 8], ['CreateVolumeTexture', 9], ['CreateCubeTexture', 7], ['CreateVertexBuffer', 6], ['CreateIndexBuffer', 6], ['CreateRenderTarget', 8], ['CreateDepthStencilSurface', 8], ['UpdateSurface', 4], ['UpdateTexture', 2], ['GetRenderTargetData', 2], ['GetFrontBufferData', 2], ['StretchRect', 5], ['ColorFill', 3], ['CreateOffscreenPlainSurface', 6], ['SetRenderTarget', 2], ['GetRenderTarget', 2], ['SetDepthStencilSurface', 1], ['GetDepthStencilSurface', 1], ['BeginScene', 0], ['EndScene', 0], ['Clear', 6], ['SetTransform', 2], ['GetTransform', 2], ['MultiplyTransform', 2], ['SetViewport', 1], ['GetViewport', 1], ['SetMaterial', 1], ['GetMaterial', 1], ['SetLight', 2], ['GetLight', 2], ['LightEnable', 2], ['GetLightEnable', 2], ['SetClipPlane', 2], ['GetClipPlane', 2], ['SetRenderState', 2], ['GetRenderState', 2], ['CreateStateBlock', 2], ['BeginStateBlock', 0], ['EndStateBlock', 1], ['SetClipStatus', 1], ['GetClipStatus', 1], ['GetTexture', 2], ['SetTexture', 2], ['GetTextureStageState', 3], ['SetTextureStageState', 3], ['GetSamplerState', 3], ['SetSamplerState', 3], ['ValidateDevice', 1], ['SetPaletteEntries', 2], ['GetPaletteEntries', 2], ['SetCurrentTexturePalette', 1], ['GetCurrentTexturePalette', 1], ['SetScissorRect', 1], ['GetScissorRect', 1], ['SetSoftwareVertexProcessing', 1], ['GetSoftwareVertexProcessing', 0], ['SetNPatchMode', 1], ['GetNPatchMode', 0], ['DrawPrimitive', 3], ['DrawIndexedPrimitive', 6], ['DrawPrimitiveUP', 4], ['DrawIndexedPrimitiveUP', 8], ['ProcessVertices', 6], ['CreateVertexDeclaration', 2], ['SetVertexDeclaration', 1], ['GetVertexDeclaration', 1], ['SetFVF', 1], ['GetFVF', 1], ['CreateVertexShader', 2], ['SetVertexShader', 1], ['GetVertexShader', 1], ['SetVertexShaderConstantF', 3], ['GetVertexShaderConstantF', 3], ['SetVertexShaderConstantI', 3], ['GetVertexShaderConstantI', 3], ['SetVertexShaderConstantB', 3], ['GetVertexShaderConstantB', 3], ['SetStreamSource', 4], ['GetStreamSource', 4], ['SetStreamSourceFreq', 2], ['GetStreamSourceFreq', 2], ['SetIndices', 1], ['GetIndices', 1], ['CreatePixelShader', 2], ['SetPixelShader', 1], ['GetPixelShader', 1], ['SetPixelShaderConstantF', 3], ['GetPixelShaderConstantF', 3], ['SetPixelShaderConstantI', 3], ['GetPixelShaderConstantI', 3], ['SetPixelShaderConstantB', 3], ['GetPixelShaderConstantB', 3], ['DrawRectPatch', 3], ['DrawTriPatch', 3], ['DeletePatch', 1], ['CreateQuery', 2]]);
  const resourceMethods = [['GetDevice', 1], ['SetPrivateData', 4], ['GetPrivateData', 3], ['FreePrivateData', 1], ['SetPriority', 1], ['GetPriority', 0], ['PreLoad', 0], ['GetType', 0]];
  I('IDirect3DResource9', 'IUnknown', resourceMethods);
  I('IDirect3DBaseTexture9', 'IDirect3DResource9', [['SetLOD', 1], ['GetLOD', 0], ['GetLevelCount', 0], ['SetAutoGenFilterType', 1], ['GetAutoGenFilterType', 0], ['GenerateMipSubLevels', 0]]);
  I('IDirect3DTexture9', 'IDirect3DBaseTexture9', [['GetLevelDesc', 2], ['GetSurfaceLevel', 2], ['LockRect', 4], ['UnlockRect', 1], ['AddDirtyRect', 1]]);
  I('IDirect3DCubeTexture9', 'IDirect3DBaseTexture9', [['GetLevelDesc', 2], ['GetCubeMapSurface', 3], ['LockRect', 5], ['UnlockRect', 2], ['AddDirtyRect', 2]]);
  I('IDirect3DVolumeTexture9', 'IDirect3DBaseTexture9', [['GetLevelDesc', 2], ['GetVolumeLevel', 2], ['LockBox', 4], ['UnlockBox', 1], ['AddDirtyBox', 1]]);
  I('IDirect3DVertexBuffer9', 'IDirect3DResource9', [['Lock', 4], ['Unlock', 0], ['GetDesc', 1]]);
  I('IDirect3DIndexBuffer9', 'IDirect3DResource9', [['Lock', 4], ['Unlock', 0], ['GetDesc', 1]]);
  I('IDirect3DSurface9', 'IDirect3DResource9', [['GetContainer', 2], ['GetDesc', 1], ['LockRect', 3], ['UnlockRect', 0], ['GetDC', 1], ['ReleaseDC', 1]]);
  I('IDirect3DVolume9', 'IUnknown', [['GetDevice', 1], ['SetPrivateData', 4], ['GetPrivateData', 3], ['FreePrivateData', 1], ['GetContainer', 2], ['GetDesc', 1], ['LockBox', 3], ['UnlockBox', 0]]);
  I('IDirect3DVertexDeclaration9', 'IUnknown', [['GetDevice', 1], ['GetDeclaration', 2]]);
  I('IDirect3DVertexShader9', 'IUnknown', [['GetDevice', 1], ['GetFunction', 2]]);
  I('IDirect3DPixelShader9', 'IUnknown', [['GetDevice', 1], ['GetFunction', 2]]);
  I('IDirect3DStateBlock9', 'IUnknown', [['GetDevice', 1], ['Capture', 0], ['Apply', 0]]);
  I('IDirect3DSwapChain9', 'IUnknown', [['Present', 5], ['GetFrontBufferData', 1], ['GetBackBuffer', 3], ['GetRasterStatus', 1], ['GetDisplayMode', 1], ['GetDevice', 1], ['GetPresentParameters', 1]]);
  I('IDirect3DQuery9', 'IUnknown', [['GetDevice', 1], ['GetType', 0], ['GetDataSize', 0], ['Issue', 1], ['GetData', 3]]);

  /** D3DCAPS9 (304 bytes) of the generic device: DX9-class with SM 2.0. */
  function writeCaps9(a, adapter, devType) {
    mem.fill(a, 304, 0);
    const w32 = (o, v) => mem.write32(a + o, v >>> 0), wf = (o, v) => mem.writeF32(a + o, v);
    w32(0, devType); w32(4, adapter);
    w32(8, 0x20000); // Caps: READ_SCANLINE
    w32(12, 0x80000 | 0x20000 | 0x20000000 | 0x100000); // Caps2: CANRENDERWINDOWED | FULLSCREENGAMMA | DYNAMICTEXTURES | CANAUTOGENMIPMAP
    w32(16, 0x20 | 0x80 | 0x100); // Caps3: ALPHA_FULLSCREEN_FLIP_OR_DISCARD | COPY_TO_VIDMEM | COPY_TO_SYSTEMMEM
    w32(20, 0x80000000 | 1 | 2 | 4 | 8); // PresentationIntervals
    w32(24, 1); // CursorCaps: COLOR
    w32(28, 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x2000 | 0x8000 | 0x10000 | 0x20000 | 0x80000 | 0x100000); // DevCaps
    w32(32, 0x2 | 0x10 | 0x20 | 0x40 | 0x80 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x8000 | 0x10000 | 0x20000 | 0x40000); // PrimitiveMiscCaps (+ BLENDOP, NULLREFERENCE, INDEPENDENTWRITEMASKS, PERSTAGECONSTANT, FOGANDSPECULARALPHA, SEPARATEALPHABLEND, MRTINDEPENDENTBITDEPTHS, MRTPOSTPIXELSHADERBLENDING)
    w32(36, 0x1 | 0x10 | 0x80 | 0x100 | 0x2000 | 0x4000 | 0x10000 | 0x20000 | 0x100000 | 0x200000 | 0x400000 | 0x800000 | 0x1000000); // RasterCaps (+ SCISSORTEST, SLOPESCALEDEPTHBIAS, DEPTHBIAS)
    w32(40, 0xff); w32(52, 0xff);
    w32(44, 0x1fff | 0x2000); w32(48, 0x1fff | 0x2000); // Src/DestBlendCaps (+ BLENDFACTOR)
    w32(56, 0x8 | 0x200 | 0x4000 | 0x80000);
    w32(60, 0x1 | 0x4 | 0x400 | 0x800 | 0x4000 | 0x10000 | 0x2000 | 0x20000 | 0x40000); // TextureCaps
    const filt = 0x100 | 0x200 | 0x400 | 0x10000 | 0x20000 | 0x1000000 | 0x2000000 | 0x4000000;
    w32(64, filt); w32(68, filt); w32(72, filt);
    w32(76, 0x3f); w32(80, 0x3f);
    w32(84, 0x1f | 0x20); // LineCaps (+ ANTIALIAS)
    w32(88, 4096); w32(92, 4096); w32(96, 256);
    w32(100, 8192); w32(104, 4096); w32(108, 16);
    wf(112, 1e10); wf(116, -32768); wf(120, -32768); wf(124, 32768); wf(128, 32768); wf(132, 0);
    w32(136, 0xff | 0x100); // StencilCaps (+ TWOSIDED)
    w32(140, 8 | 0x100000);
    w32(144, 0x3ffffff);
    w32(148, 8); w32(152, 8);
    w32(156, 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x40 | 0x100); // VertexProcessingCaps (+ TEXGEN_SPHEREMAP)
    w32(160, 8); w32(164, 6); w32(168, 4); w32(172, 255);
    wf(176, 64);
    w32(180, 0xfffff); w32(184, 0xfffff); w32(188, 16); w32(192, 1024);
    w32(196, 0xfffe0200); w32(200, 256); // VertexShaderVersion 2.0, MaxVertexShaderConst
    w32(204, 0xffff0200); wf(208, 8); // PixelShaderVersion 2.0, PixelShader1xMaxValue
    w32(212, 0x1 | 0x2 | 0x10 | 0x20 | 0x40); // DevCaps2: STREAMOFFSET | DMAPNPATCH | VERTEXELEMENTSCANSHARESTREAMOFFSET | PRESAMPLEDDMAPNPATCH | ADAPTIVETESSRTPATCH
    wf(216, 1); w32(220, 0); w32(224, 0); w32(228, 0); w32(232, 1);
    w32(236, 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200); // DeclTypes: UBYTE4 | UBYTE4N | SHORT2N | SHORT4N | USHORT2N | USHORT4N | UDEC3 | DEC3N | FLOAT16_2 | FLOAT16_4
    w32(240, 4); // NumSimultaneousRTs
    w32(244, 0x1000000 | 0x2000000 | 0x100 | 0x200); // StretchRectFilterCaps
    w32(248, 0x1 | 0x2 | 0x4 | 0x8); w32(252, 24); w32(256, 32); w32(260, 4); // VS20Caps
    w32(264, 0x1 | 0x2 | 0x4 | 0x8 | 0x10); w32(268, 24); w32(272, 32); w32(276, 4); w32(280, 512); // PS20Caps
    w32(284, 0x100 | 0x200 | 0x1000000 | 0x2000000); // VertexTextureFilterCaps
    w32(288, 65535); w32(292, 65535); w32(296, 0); w32(300, 0);
  }

  const readPP9 = (p) => ({ width: mem.read32(p), height: mem.read32(p + 4), format: mem.read32(p + 8), count: Math.max(1, mem.read32(p + 12)), msaa: mem.read32(p + 16), msq: mem.read32(p + 20), swap: mem.read32(p + 24), hwnd: mem.read32(p + 28), windowed: mem.read32(p + 32) !== 0, autoDepth: mem.read32(p + 36) !== 0, depthFormat: mem.read32(p + 40), flags: mem.read32(p + 44), refresh: mem.read32(p + 48), interval: mem.read32(p + 52) });
  const writePP9 = (p, pp) => { mem.write32(p, pp.width); mem.write32(p + 4, pp.height); mem.write32(p + 8, pp.format); mem.write32(p + 12, pp.count); mem.write32(p + 16, pp.msaa); mem.write32(p + 20, pp.msq ?? 0); mem.write32(p + 24, pp.swap); mem.write32(p + 28, pp.hwnd); mem.write32(p + 32, pp.windowed ? 1 : 0); mem.write32(p + 36, pp.autoDepth ? 1 : 0); mem.write32(p + 40, pp.depthFormat); mem.write32(p + 44, pp.flags); mem.write32(p + 48, pp.refresh); mem.write32(p + 52, pp.interval); };
  const SAMP_DEFAULTS = { 1: 1, 2: 1, 3: 1, 4: 0, 5: 1, 6: 1, 7: 0, 8: 0, 9: 0, 10: 1, 11: 0, 12: 0, 13: 0 };

  /** D3D9 surface desc: Format, Type, Usage, Pool, MultiSampleType, MultiSampleQuality, Width, Height */
  const writeSurfDesc9 = (p, s) => { mem.write32(p, s.fmt); mem.write32(p + 4, RTYPE.SURFACE); mem.write32(p + 8, s.usage); mem.write32(p + 12, s.pool); mem.write32(p + 16, 0); mem.write32(p + 20, 0); mem.write32(p + 24, s.width); mem.write32(p + 28, s.height); };
  const surfaceOf = (ptr) => { const s = com.implAt(ptr); return s instanceof Surface ? s : null; };

  class Device9 extends Device8 {
    constructor(c, d3d, adapter, devType, hFocus, behavior, pp) {
      super(c, d3d, adapter, devType, hFocus, behavior, pp);
      this.api9 = true;
      this.iids = [IID.IDirect3DDevice9];
    }
    readPresentParams(pp) {
      this.pp = readPP9(pp);
      const wm = vm.wm;
      if (this.pp.windowed && (!this.pp.width || !this.pp.height)) { const w = wm?.windows.get(this.pp.hwnd || this.hFocus); if (w) { this.pp.width = this.pp.width || (w.client.r - w.client.l); this.pp.height = this.pp.height || (w.client.b - w.client.t); } }
      if (!this.pp.width) this.pp.width = displayMode().width;
      if (!this.pp.height) this.pp.height = displayMode().height;
      if (!this.pp.format || this.pp.format === FMT.UNKNOWN) this.pp.format = FMT.X8R8G8B8;
      this.applyDisplayMode();
    }
    resetState() {
      super.resetState();
      this.samplers = Array.from({ length: MAX_SAMPLERS + 4 }, () => new Map(Object.entries(SAMP_DEFAULTS).map(([k, v]) => [+k, v])));
      this.fvf = 0; this.vertexDecl = null; this.vsObj = null; this.psObj = null;
      this.vsConst = new Float32Array(256 * 4); this.psConst = new Float32Array(32 * 4);
      this.vsConstI = new Int32Array(16 * 4); this.psConstI = new Int32Array(16 * 4); this.vsConstB = new Uint8Array(16); this.psConstB = new Uint8Array(16);
      this.streams = Array.from({ length: 16 }, () => ({ vb: 0, offset: 0, stride: 0, freq: 1 }));
      this.renderTargets = [null, null, null, null];
      this.scissor = null; this.softwareVP = false; this.npatch = 0;
      this.textures = new Array(MAX_SAMPLERS + 4).fill(0);
    }
    createBackBuffers(c) { super.createBackBuffers(c); this.renderTargets = [this.renderTarget, null, null, null]; for (const b of this.backBuffers) b.iids = [IID.IDirect3DSurface9, IID.IDirect3DResource9]; if (this.depthStencil) this.depthStencil.iids = [IID.IDirect3DSurface9, IID.IDirect3DResource9]; }
    // ---- housekeeping (DX9 signatures)
    EvictManagedResources() { return D3D_OK; }
    GetDeviceCaps(c) { if (!c.arg(1)) return D3DERR_INVALIDCALL; writeCaps9(c.arg(1), this.adapter, this.devType); return D3D_OK; }
    GetDisplayMode(c) { const p = c.arg(2); if (!p) return D3DERR_INVALIDCALL; writeMode(p, this.pp.windowed ? displayMode() : { width: this.pp.width, height: this.pp.height, refresh: 60, format: this.pp.format === FMT.A8R8G8B8 ? FMT.X8R8G8B8 : this.pp.format }); return D3D_OK; }
    GetSwapChain(c) { const pp = c.arg(2); if (c.arg(1) !== 0 || !pp) return D3DERR_INVALIDCALL; if (!this.swapChainPtr || !com.objectAt(this.swapChainPtr)) this.swapChainPtr = com.create(c.proc, 'IDirect3DSwapChain9', new SwapChain(this)); else com.addRef(com.objectAt(this.swapChainPtr)); mem.write32(pp, this.swapChainPtr); return D3D_OK; }
    GetNumberOfSwapChains() { return 1; }
    GetBackBuffer(c) { const b = this.backBuffers[c.arg(2)], pp = c.arg(4); if (c.arg(1) !== 0 || !b || !pp) return D3DERR_INVALIDCALL; mem.write32(pp, b.ptrOf(c)); return D3D_OK; }
    GetRasterStatus(c) { const p = c.arg(2); if (!p) return D3DERR_INVALIDCALL; const t = vm.clock.now() % (1000 / 60); mem.write32(p, t < 1 ? 1 : 0); mem.write32(p + 4, Math.floor(t / (1000 / 60) * this.pp.height)); return D3D_OK; }
    SetDialogBoxMode() { return D3D_OK; }
    SetGammaRamp(c) { this.gamma = mem.bytes(c.arg(3), 1536).slice(); this.gfx?.setGamma?.(this.gamma); return; }
    GetGammaRamp(c) { const p = c.arg(2); if (this.gamma) mem.writeBytes(p, this.gamma); else for (let i = 0; i < 256; i++) { const v = i * 257; mem.write16(p + 2 * i, v); mem.write16(p + 512 + 2 * i, v); mem.write16(p + 1024 + 2 * i, v); } return; }
    // ---- resources
    CreateTexture(c) {
      const w = c.arg(1), h = c.arg(2), levels = c.arg(3), usage = c.arg(4), fmt = c.arg(5), pool = c.arg(6), pp = c.arg(7);
      if (!pp || !w || !h) return D3DERR_INVALIDCALL;
      if (!TEXTURE_FORMATS.has(fmt) && !DEPTH_FORMATS.has(fmt) && !BACKBUFFER_FORMATS.has(fmt)) { mem.write32(pp, 0); vm.log('gfx', `d3d9: CreateTexture unsupported format ${fmt}`); return D3DERR_INVALIDCALL; }
      const t = new Texture(this, w, h, usage & 0x400 /* AUTOGENMIPMAP */ ? 1 : levels, usage, fmt, pool);
      vm.log('tex', `CreateTexture #${t.id} ${w}x${h} ${fmtName(fmt)} levels ${levels} usage 0x${usage.toString(16)} pool ${pool} [t${c.thread.id}] from ${c.proc.symbolize(c.retAddr)}`);
      if (!createdFormats.has(fmt)) { createdFormats.add(fmt); vm.log('gfx', `d3d9: first texture in format ${fmtName(fmt)} (${w}x${h}, ${levels} levels, usage 0x${usage.toString(16)}, pool ${pool})`); }
      t.origin = c.proc.symbolize(c.retAddr);
      if (w * h <= 16) t.apiTrail = [...checkTrail, ...vm.recentApiCalls(120, c.thread.id)]; // tiny textures are often an engine's stand-in for a failed load: keep this thread's context
      t.iids = [IID.IDirect3DResource9, IID.IDirect3DBaseTexture9];
      for (const l of t.levels) l.iids = [IID.IDirect3DSurface9, IID.IDirect3DResource9];
      mem.write32(pp, t.ptr = com.create(c.proc, 'IDirect3DTexture9', t));
      this.gfx?.createTexture?.(t);
      return D3D_OK;
    }
    CreateVolumeTexture(c) { const pp = c.arg(8); if (!pp) return D3DERR_INVALIDCALL; const t = new VolumeTexture(this, c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5), c.arg(6), c.arg(7)); t.iids = [IID.IDirect3DResource9, IID.IDirect3DBaseTexture9]; mem.write32(pp, t.ptr = com.create(c.proc, 'IDirect3DVolumeTexture9', t)); return D3D_OK; }
    CreateCubeTexture(c) { const pp = c.arg(6); if (!pp) return D3DERR_INVALIDCALL; const t = new CubeTexture(this, c.arg(1), c.arg(2), c.arg(3), c.arg(4), c.arg(5)); t.iids = [IID.IDirect3DResource9, IID.IDirect3DBaseTexture9]; for (const f of t.faces) for (const l of f) l.iids = [IID.IDirect3DSurface9, IID.IDirect3DResource9]; mem.write32(pp, t.ptr = com.create(c.proc, 'IDirect3DCubeTexture9', t)); return D3D_OK; }
    CreateVertexBuffer(c) { const pp = c.arg(5); if (!pp || !c.arg(1)) return D3DERR_INVALIDCALL; const b = new Buffer(this, RTYPE.VERTEXBUFFER, c.arg(1), c.arg(2), c.arg(3), c.arg(4)); if (!b.mem) return E_OUTOFMEMORY; b.iids = [IID.IDirect3DResource9]; mem.write32(pp, b.ptr = com.create(c.proc, 'IDirect3DVertexBuffer9', b)); return D3D_OK; }
    CreateIndexBuffer(c) { const pp = c.arg(5); if (!pp || !c.arg(1)) return D3DERR_INVALIDCALL; const b = new Buffer(this, RTYPE.INDEXBUFFER, c.arg(1), c.arg(2), c.arg(3), c.arg(4)); if (!b.mem) return E_OUTOFMEMORY; b.iids = [IID.IDirect3DResource9]; mem.write32(pp, b.ptr = com.create(c.proc, 'IDirect3DIndexBuffer9', b)); return D3D_OK; }
    CreateRenderTarget(c) { const pp = c.arg(7); if (!pp) return D3DERR_INVALIDCALL; const s = new Surface(this, null, c.arg(3), c.arg(1), c.arg(2), USAGE_RENDERTARGET, POOL.DEFAULT); s.lockable = c.arg(6) !== 0; s.iids = [IID.IDirect3DSurface9, IID.IDirect3DResource9]; mem.write32(pp, s.ptrOf(c)); return D3D_OK; }
    CreateDepthStencilSurface(c) { const pp = c.arg(7); if (!pp) return D3DERR_INVALIDCALL; const s = new Surface(this, null, c.arg(3), c.arg(1), c.arg(2), USAGE_DEPTHSTENCIL, POOL.DEFAULT); s.iids = [IID.IDirect3DSurface9, IID.IDirect3DResource9]; mem.write32(pp, s.ptrOf(c)); return D3D_OK; }
    CreateOffscreenPlainSurface(c) { const pp = c.arg(5); if (!pp) return D3DERR_INVALIDCALL; const s = new Surface(this, null, c.arg(3), c.arg(1), c.arg(2), 0, c.arg(4)); s.lockable = true; s.iids = [IID.IDirect3DSurface9, IID.IDirect3DResource9]; mem.write32(pp, s.ptrOf(c)); return D3D_OK; }
    UpdateSurface(c) {
      const src = surfaceOf(c.arg(1)), rect = c.arg(2), dst = surfaceOf(c.arg(3)), pt = c.arg(4);
      if (!src || !dst || src.fmt !== dst.fmt) return D3DERR_INVALIDCALL;
      const sb = src.ensureMem(c.proc), db = dst.ensureMem(c.proc);
      const bpp = surfacePitch(src.fmt, 1);
      const l = rect ? mem.readS32(rect) : 0, t = rect ? mem.readS32(rect + 4) : 0, r = rect ? mem.readS32(rect + 8) : src.width, b = rect ? mem.readS32(rect + 12) : src.height;
      const dx = pt ? mem.readS32(pt) : 0, dy = pt ? mem.readS32(pt + 4) : 0;
      const w = Math.min(r - l, dst.width - dx), h = Math.min(b - t, dst.height - dy);
      for (let y = 0; y < h; y++) mem.copy(db + (dy + y) * dst.pitch + dx * bpp, sb + (t + y) * src.pitch + l * bpp, w * bpp);
      dst.dirty = true; this.gfx?.surfaceUpdated?.(dst);
      return D3D_OK;
    }
    GetRenderTargetData(c) { const rt = surfaceOf(c.arg(1)), dst = surfaceOf(c.arg(2)); if (!rt || !dst || rt.fmt !== dst.fmt) return D3DERR_INVALIDCALL; if (this.gfx?.readbackSurface) this.gfx.readbackSurface(rt); if (rt.mem) mem.copy(dst.ensureMem(c.proc), rt.mem, Math.min(rt.bytes, dst.bytes)); return D3D_OK; }
    GetFrontBufferData(c) { const s = surfaceOf(c.arg(2)); if (!s) return D3DERR_INVALIDCALL; return this.GetFrontBuffer({ arg: (i) => (i === 1 ? c.arg(2) : 0), proc: c.proc }); }
    StretchRect(c) {
      const src = surfaceOf(c.arg(1)), sr = c.arg(2), dst = surfaceOf(c.arg(3)), dr = c.arg(4);
      if (!src || !dst) return D3DERR_INVALIDCALL;
      if (this.gfx?.stretchRect) return this.gfx.stretchRect(src, sr, dst, dr, c.arg(5));
      // CPU path: nearest-neighbour copy between same-format surfaces
      if (src.fmt !== dst.fmt) return D3DERR_INVALIDCALL;
      const sb = src.ensureMem(c.proc), db = dst.ensureMem(c.proc);
      const bpp = surfacePitch(src.fmt, 1);
      const s = sr ? { l: mem.readS32(sr), t: mem.readS32(sr + 4), r: mem.readS32(sr + 8), b: mem.readS32(sr + 12) } : { l: 0, t: 0, r: src.width, b: src.height };
      const d = dr ? { l: mem.readS32(dr), t: mem.readS32(dr + 4), r: mem.readS32(dr + 8), b: mem.readS32(dr + 12) } : { l: 0, t: 0, r: dst.width, b: dst.height };
      const sw = s.r - s.l, sh = s.b - s.t, dw = d.r - d.l, dh = d.b - d.t;
      for (let y = 0; y < dh; y++) { const sy = s.t + Math.floor(y * sh / dh); for (let x = 0; x < dw; x++) { const sx = s.l + Math.floor(x * sw / dw); mem.copy(db + (d.t + y) * dst.pitch + (d.l + x) * bpp, sb + sy * src.pitch + sx * bpp, bpp); } }
      dst.dirty = true; this.gfx?.surfaceUpdated?.(dst);
      return D3D_OK;
    }
    ColorFill(c) {
      const s = surfaceOf(c.arg(1)), rect = c.arg(2), color = c.arg(3);
      if (!s) return D3DERR_INVALIDCALL;
      if (this.gfx?.colorFill) return this.gfx.colorFill(s, rect, color);
      const base = s.ensureMem(c.proc);
      const l = rect ? mem.readS32(rect) : 0, t = rect ? mem.readS32(rect + 4) : 0, r = rect ? mem.readS32(rect + 8) : s.width, b = rect ? mem.readS32(rect + 12) : s.height;
      const bpp = surfacePitch(s.fmt, 1);
      for (let y = t; y < b; y++) for (let x = l; x < r; x++) { const p = base + y * s.pitch + x * bpp; if (bpp === 4) mem.write32(p, color); else if (bpp === 2) mem.write16(p, ((color >> 8) & 0xf800) | ((color >> 5) & 0x7e0) | ((color >> 3) & 0x1f)); else mem.u8[p] = color & 0xff; }
      s.dirty = true; this.gfx?.surfaceUpdated?.(s);
      return D3D_OK;
    }
    SetRenderTarget(c) {
      const idx = c.arg(1), ptr = c.arg(2);
      if (idx >= MAX_RTS) return D3DERR_INVALIDCALL;
      const rt = ptr ? surfaceOf(ptr) : null;
      if (ptr && !rt) return D3DERR_INVALIDCALL;
      if (idx === 0 && !rt) return D3DERR_INVALIDCALL;
      this.renderTargets[idx] = rt;
      if (idx === 0) { this.renderTarget = rt; this.viewport = { x: 0, y: 0, w: rt.width, h: rt.height, minZ: 0, maxZ: 1 }; this.scissor = null; }
      this.gfx?.setRenderTarget?.(this.renderTarget, this.depthTarget, idx, rt);
      return D3D_OK;
    }
    GetRenderTarget(c) { const idx = c.arg(1), pp = c.arg(2); if (idx >= MAX_RTS || !pp) return D3DERR_INVALIDCALL; const rt = this.renderTargets[idx]; if (!rt) { mem.write32(pp, 0); return D3DERR_NOTFOUND; } mem.write32(pp, rt.ptrOf(c)); return D3D_OK; }
    SetDepthStencilSurface(c) { const ptr = c.arg(1); const ds = ptr ? surfaceOf(ptr) : null; if (ptr && !ds) return D3DERR_INVALIDCALL; this.depthTarget = ds; this.gfx?.setRenderTarget?.(this.renderTarget, this.depthTarget, 0, this.renderTarget); return D3D_OK; }
    // ---- state
    CreateStateBlock(c) { const type = c.arg(1), pp = c.arg(2); if (!pp) return D3DERR_INVALIDCALL; const r = super.CreateStateBlock({ ...c, arg: (i) => (i === 1 ? type : i === 2 ? 0 : c.arg(i)) }); if (r !== D3D_OK) return r; const id = this.nextSB - 1; mem.write32(pp, com.create(c.proc, 'IDirect3DStateBlock9', new StateBlock(this, id))); return D3D_OK; }
    EndStateBlock(c) { const pp = c.arg(1); if (!pp) return D3DERR_INVALIDCALL; const r = super.EndStateBlock({ ...c, out32: () => {} }); if (r !== D3D_OK) return r; const id = this.nextSB - 1; mem.write32(pp, com.create(c.proc, 'IDirect3DStateBlock9', new StateBlock(this, id))); return D3D_OK; }
    GetSamplerState(c) { const s = c.arg(1) === 0x10 ? 16 : c.arg(1); if (s >= this.samplers.length) return D3DERR_INVALIDCALL; c.out32(3, this.samplers[s].get(c.arg(2)) ?? 0); return D3D_OK; }
    SetSamplerState(c) { const s = c.arg(1) === 0x10 ? 16 : c.arg(1), type = c.arg(2), v = c.arg(3); if (s >= this.samplers.length) return D3DERR_INVALIDCALL; if (this.recording) { (this.recording.samp ??= new Map()).set(`${s}:${type}`, v); return D3D_OK; } this.samplers[s].set(type, v); this.gfx?.setSamplerState?.(s, type, v); return D3D_OK; }
    GetTexture(c) { const st = c.arg(1) === 0x10 ? 16 : c.arg(1), pp = c.arg(2); if (st >= this.textures.length || !pp) return D3DERR_INVALIDCALL; const t = this.textures[st]; mem.write32(pp, t); if (t) com.addRef(com.objectAt(t)); return D3D_OK; }
    SetTexture(c) { this.stateVersion++; const st = c.arg(1) === 0x10 ? 16 : c.arg(1), t = c.arg(2); if (st >= this.textures.length) return D3DERR_INVALIDCALL; if (t && !com.implAt(t)) return D3DERR_INVALIDCALL; if (this.recording) { this.recording.textures.set(st, t); return D3D_OK; } if (this.textures[st] !== t) { if (t) com.addRef(com.objectAt(t)); if (this.textures[st]) com.release(com.objectAt(this.textures[st])); this.textures[st] = t; } this.gfx?.setTexture?.(st, t ? com.implAt(t) : null); return D3D_OK; }
    SetScissorRect(c) { this.viewportVersion++; const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; this.scissor = { l: mem.readS32(p), t: mem.readS32(p + 4), r: mem.readS32(p + 8), b: mem.readS32(p + 12) }; return D3D_OK; }
    GetScissorRect(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; const s = this.scissor ?? { l: 0, t: 0, r: this.renderTarget.width, b: this.renderTarget.height }; mem.write32(p, s.l); mem.write32(p + 4, s.t); mem.write32(p + 8, s.r); mem.write32(p + 12, s.b); return D3D_OK; }
    SetSoftwareVertexProcessing(c) { this.softwareVP = c.arg(1) !== 0; return D3D_OK; }
    GetSoftwareVertexProcessing() { return this.softwareVP ? 1 : 0; }
    SetNPatchMode(c) { this.npatch = c.argF32(1); return D3D_OK; }
    GetNPatchMode() { return 0; }
    // ---- drawing (DX9 signatures)
    DrawIndexedPrimitive(c) { const type = c.arg(1), base = c.sarg(2), minIdx = c.arg(3), numV = c.arg(4), start = c.arg(5), count = c.arg(6); this.draws++; this.indices.base = base; this.gfx?.drawIndexedPrimitive?.(type, minIdx, numV, start, count, base); return D3D_OK; }
    ProcessVertices() { return D3DERR_INVALIDCALL; }
    CreateVertexDeclaration(c) {
      const elems = c.arg(1), pp = c.arg(2);
      if (!elems || !pp) return D3DERR_INVALIDCALL;
      const layout = declLayout9(mem, elems);
      const decl = new VertexDecl(this, layout, mem.bytes(elems, layout.elements.length * 8).slice());
      mem.write32(pp, decl.ptr = com.create(c.proc, 'IDirect3DVertexDeclaration9', decl));
      return D3D_OK;
    }
    SetVertexDeclaration(c) { this.stateVersion++; const ptr = c.arg(1); const d = ptr ? com.implAt(ptr) : null; if (ptr && !(d instanceof VertexDecl)) return D3DERR_INVALIDCALL; if (this.recording) { this.recording.decl = d; return D3D_OK; } this.vertexDecl = d; if (d) this.fvf = 0; return D3D_OK; }
    GetVertexDeclaration(c) { const pp = c.arg(1); if (!pp) return D3DERR_INVALIDCALL; if (this.vertexDecl) { com.addRef(com.objectAt(this.vertexDecl.ptr)); mem.write32(pp, this.vertexDecl.ptr); } else mem.write32(pp, 0); return D3D_OK; }
    SetFVF(c) { this.stateVersion++; const fvf = c.arg(1); if (this.recording) { this.recording.fvf = fvf; return D3D_OK; } this.fvf = fvf; if (fvf) this.vertexDecl = null; return D3D_OK; }
    GetFVF(c) { c.out32(1, this.fvf); return D3D_OK; }
    CreateVertexShader(c) {
      const fn = c.arg(1), pp = c.arg(2);
      if (!fn || !pp) return D3DERR_INVALIDCALL;
      const code = []; for (let p = fn; ; p += 4) { const t = mem.read32(p); code.push(t); if (t === 0x0000ffff || code.length > 8192) break; }
      const sh = new Shader(this, 'vs', Uint32Array.from(code));
      mem.write32(pp, sh.ptr = com.create(c.proc, 'IDirect3DVertexShader9', sh));
      this.gfx?.createVertexShader?.(sh);
      return D3D_OK;
    }
    SetVertexShader(c) { this.stateVersion++; const ptr = c.arg(1); const sh = ptr ? com.implAt(ptr) : null; if (ptr && !(sh instanceof Shader)) return D3DERR_INVALIDCALL; if (this.recording) { this.recording.vs = sh; return D3D_OK; } this.vsObj = sh; this.vertexShader = sh ? sh.handle : 0; this.gfx?.setVertexShader?.(this.vertexShader, sh); return D3D_OK; }
    GetVertexShader(c) { c.out32(1, this.vsObj ? this.vsObj.ptr : 0); if (this.vsObj) com.addRef(com.objectAt(this.vsObj.ptr)); return D3D_OK; }
    SetVertexShaderConstantF(c) { this.constVersion++; const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 256) return D3DERR_INVALIDCALL; for (let i = 0; i < n * 4; i++) this.vsConst[reg * 4 + i] = mem.readF32(p + 4 * i); this.gfx?.setVertexShaderConstant?.(reg, n, this.vsConst); return D3D_OK; }
    GetVertexShaderConstantF(c) { const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 256) return D3DERR_INVALIDCALL; for (let i = 0; i < n * 4; i++) mem.writeF32(p + 4 * i, this.vsConst[reg * 4 + i]); return D3D_OK; }
    SetVertexShaderConstantI(c) { this.constVersion++; const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 16) return D3DERR_INVALIDCALL; for (let i = 0; i < n * 4; i++) this.vsConstI[reg * 4 + i] = mem.readS32(p + 4 * i); return D3D_OK; }
    GetVertexShaderConstantI(c) { const reg = c.arg(1), p = c.arg(2), n = c.arg(3); for (let i = 0; i < n * 4; i++) mem.write32(p + 4 * i, this.vsConstI[reg * 4 + i]); return D3D_OK; }
    SetVertexShaderConstantB(c) { this.constVersion++; const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 16) return D3DERR_INVALIDCALL; for (let i = 0; i < n; i++) this.vsConstB[reg + i] = mem.read32(p + 4 * i) ? 1 : 0; return D3D_OK; }
    GetVertexShaderConstantB(c) { const reg = c.arg(1), p = c.arg(2), n = c.arg(3); for (let i = 0; i < n; i++) mem.write32(p + 4 * i, this.vsConstB[reg + i]); return D3D_OK; }
    SetStreamSource(c) { const n = c.arg(1), vb = c.arg(2), offset = c.arg(3), stride = c.arg(4); if (n >= 16) return D3DERR_INVALIDCALL; const s = this.streams[n]; if (s.vb !== vb) { if (vb) com.addRef(com.objectAt(vb)); if (s.vb) com.release(com.objectAt(s.vb)); s.vb = vb; } s.offset = offset; s.stride = stride; this.gfx?.setStreamSource?.(n, vb ? com.implAt(vb) : null, stride, offset); return D3D_OK; }
    GetStreamSource(c) { const n = c.arg(1); if (n >= 16) return D3DERR_INVALIDCALL; const s = this.streams[n]; c.out32(2, s.vb); if (s.vb) com.addRef(com.objectAt(s.vb)); c.out32(3, s.offset); c.out32(4, s.stride); return D3D_OK; }
    SetStreamSourceFreq(c) { const n = c.arg(1); if (n >= 16) return D3DERR_INVALIDCALL; this.streams[n].freq = c.arg(2); return D3D_OK; }
    GetStreamSourceFreq(c) { const n = c.arg(1); if (n >= 16) return D3DERR_INVALIDCALL; c.out32(2, this.streams[n].freq); return D3D_OK; }
    SetIndices(c) { const ib = c.arg(1); if (ib && !com.implAt(ib)) return D3DERR_INVALIDCALL; if (this.indices.ib !== ib) { if (ib) com.addRef(com.objectAt(ib)); if (this.indices.ib) com.release(com.objectAt(this.indices.ib)); this.indices.ib = ib; } this.gfx?.setIndices?.(ib ? com.implAt(ib) : null, 0); return D3D_OK; }
    GetIndices(c) { c.out32(1, this.indices.ib); if (this.indices.ib) com.addRef(com.objectAt(this.indices.ib)); return D3D_OK; }
    CreatePixelShader(c) {
      const fn = c.arg(1), pp = c.arg(2);
      if (!fn || !pp) return D3DERR_INVALIDCALL;
      const code = []; for (let p = fn; ; p += 4) { const t = mem.read32(p); code.push(t); if (t === 0x0000ffff || code.length > 8192) break; }
      const sh = new Shader(this, 'ps', Uint32Array.from(code));
      mem.write32(pp, sh.ptr = com.create(c.proc, 'IDirect3DPixelShader9', sh));
      this.gfx?.createPixelShader?.(sh);
      return D3D_OK;
    }
    SetPixelShader(c) { this.stateVersion++; const ptr = c.arg(1); const sh = ptr ? com.implAt(ptr) : null; if (ptr && !(sh instanceof Shader)) return D3DERR_INVALIDCALL; if (this.recording) { this.recording.ps = sh; return D3D_OK; } this.psObj = sh; this.pixelShader = sh ? sh.handle : 0; this.gfx?.setPixelShader?.(this.pixelShader, sh); return D3D_OK; }
    GetPixelShader(c) { c.out32(1, this.psObj ? this.psObj.ptr : 0); if (this.psObj) com.addRef(com.objectAt(this.psObj.ptr)); return D3D_OK; }
    SetPixelShaderConstantF(c) { this.constVersion++; const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 32) return D3DERR_INVALIDCALL; for (let i = 0; i < n * 4; i++) this.psConst[reg * 4 + i] = mem.readF32(p + 4 * i); this.gfx?.setPixelShaderConstant?.(reg, n, this.psConst); return D3D_OK; }
    GetPixelShaderConstantF(c) { const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 32) return D3DERR_INVALIDCALL; for (let i = 0; i < n * 4; i++) mem.writeF32(p + 4 * i, this.psConst[reg * 4 + i]); return D3D_OK; }
    SetPixelShaderConstantI(c) { this.constVersion++; const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 16) return D3DERR_INVALIDCALL; for (let i = 0; i < n * 4; i++) this.psConstI[reg * 4 + i] = mem.readS32(p + 4 * i); return D3D_OK; }
    GetPixelShaderConstantI(c) { const reg = c.arg(1), p = c.arg(2), n = c.arg(3); for (let i = 0; i < n * 4; i++) mem.write32(p + 4 * i, this.psConstI[reg * 4 + i]); return D3D_OK; }
    SetPixelShaderConstantB(c) { this.constVersion++; const reg = c.arg(1), p = c.arg(2), n = c.arg(3); if (reg + n > 16) return D3DERR_INVALIDCALL; for (let i = 0; i < n; i++) this.psConstB[reg + i] = mem.read32(p + 4 * i) ? 1 : 0; return D3D_OK; }
    GetPixelShaderConstantB(c) { const reg = c.arg(1), p = c.arg(2), n = c.arg(3); for (let i = 0; i < n; i++) mem.write32(p + 4 * i, this.psConstB[reg + i]); return D3D_OK; }
    CreateQuery(c) {
      const type = c.arg(1), pp = c.arg(2);
      // D3DQUERYTYPE_EVENT 8, OCCLUSION 9, VCACHE 4 ... supported: EVENT and OCCLUSION (always "done")
      if (type !== 8 && type !== 9 && type !== 4 && type !== 5) return D3DERR_NOTAVAILABLE;
      if (!pp) return D3D_OK; // capability check
      mem.write32(pp, com.create(c.proc, 'IDirect3DQuery9', new Query(this, type)));
      return D3D_OK;
    }
    // apply DX9-only parts of state blocks
    ApplyStateBlock(c) {
      const sb = this.stateBlocks.get(c.arg(1)); if (!sb) return D3DERR_INVALIDCALL;
      const r = super.ApplyStateBlock(c);
      if (sb.samp) for (const [k, v] of sb.samp) { const [s, t] = k.split(':').map(Number); this.samplers[s].set(t, v); }
      if (sb.decl !== undefined) { this.vertexDecl = sb.decl; if (sb.decl) this.fvf = 0; }
      if (sb.fvf !== undefined) { this.fvf = sb.fvf; if (sb.fvf) this.vertexDecl = null; }
      if (sb.vs !== undefined) { this.vsObj = sb.vs; this.vertexShader = sb.vs ? sb.vs.handle : 0; }
      if (sb.ps !== undefined) { this.psObj = sb.ps; this.pixelShader = sb.ps ? sb.ps.handle : 0; }
      return r;
    }
    CaptureStateBlock(c) {
      const sb = this.stateBlocks.get(c.arg(1)); if (!sb) return D3DERR_INVALIDCALL;
      const r = super.CaptureStateBlock(c);
      if (sb.samp) for (const k of sb.samp.keys()) { const [s, t] = k.split(':').map(Number); sb.samp.set(k, this.samplers[s].get(t) ?? 0); }
      if (sb.decl !== undefined) sb.decl = this.vertexDecl;
      if (sb.fvf !== undefined) sb.fvf = this.fvf;
      if (sb.vs !== undefined) sb.vs = this.vsObj;
      if (sb.ps !== undefined) sb.ps = this.psObj;
      return r;
    }
  }

  let nextShader = 1;
  class Shader {
    constructor(dev, kind, code) { this.dev = dev; this.kind = kind; this.code = code; this.handle = nextShader++; this.iids = [kind === 'vs' ? IID.IDirect3DVertexShader9 : IID.IDirect3DPixelShader9]; this.version = code[0] >>> 0; }
    GetDevice(c) { c.out32(1, this.dev.ptr); com.addRef(com.objectAt(this.dev.ptr)); return D3D_OK; }
    GetFunction(c) { const p = c.arg(1), ps = c.arg(2); const size = mem.read32(ps); mem.write32(ps, this.code.length * 4); if (!p) return D3D_OK; if (size < this.code.length * 4) return D3DERR_MOREDATA; for (let i = 0; i < this.code.length; i++) mem.write32(p + 4 * i, this.code[i]); return D3D_OK; }
    destroy() { if (this.dev.vsObj === this) { this.dev.vsObj = null; this.dev.vertexShader = 0; } if (this.dev.psObj === this) { this.dev.psObj = null; this.dev.pixelShader = 0; } this.dev.gfx?.[this.kind === 'vs' ? 'deleteVertexShader' : 'deletePixelShader']?.(this); }
  }
  class VertexDecl {
    constructor(dev, layout, bytes) { this.dev = dev; this.layout = layout; this.bytes = bytes; this.iids = [IID.IDirect3DVertexDeclaration9]; }
    GetDevice(c) { c.out32(1, this.dev.ptr); com.addRef(com.objectAt(this.dev.ptr)); return D3D_OK; }
    GetDeclaration(c) { const p = c.arg(1), pn = c.arg(2); const n = this.bytes.length / 8; mem.write32(pn, n); if (p) mem.writeBytes(p, this.bytes); return D3D_OK; }
    destroy() { if (this.dev.vertexDecl === this) this.dev.vertexDecl = null; }
  }
  class StateBlock {
    constructor(dev, id) { this.dev = dev; this.id = id; this.iids = [IID.IDirect3DStateBlock9]; }
    GetDevice(c) { c.out32(1, this.dev.ptr); com.addRef(com.objectAt(this.dev.ptr)); return D3D_OK; }
    Capture(c) { return this.dev.CaptureStateBlock({ ...c, arg: (i) => (i === 1 ? this.id : 0) }); }
    Apply(c) { this.dev.stateVersion++; this.dev.transformVersion++; this.dev.lightVersion++; this.dev.viewportVersion++; this.dev.constVersion++; return this.dev.ApplyStateBlock({ ...c, arg: (i) => (i === 1 ? this.id : 0) }); }
    destroy() { this.dev.stateBlocks.delete(this.id); }
  }
  class SwapChain {
    constructor(dev) { this.dev = dev; this.iids = [IID.IDirect3DSwapChain9]; }
    Present(c) { return this.dev.Present({ ...c, arg: (i) => c.arg(i) }); }
    GetFrontBufferData(c) { return this.dev.GetFrontBufferData({ ...c, arg: (i) => (i === 2 ? c.arg(1) : c.arg(i)) }); }
    GetBackBuffer(c) { return this.dev.GetBackBuffer({ ...c, arg: (i) => (i === 1 ? 0 : i === 2 ? c.arg(1) : i === 3 ? c.arg(2) : i === 4 ? c.arg(3) : c.arg(i)) }); }
    GetRasterStatus(c) { return this.dev.GetRasterStatus({ ...c, arg: (i) => (i === 2 ? c.arg(1) : c.arg(i)) }); }
    GetDisplayMode(c) { return this.dev.GetDisplayMode({ ...c, arg: (i) => (i === 2 ? c.arg(1) : c.arg(i)) }); }
    GetDevice(c) { c.out32(1, this.dev.ptr); com.addRef(com.objectAt(this.dev.ptr)); return D3D_OK; }
    GetPresentParameters(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; writePP9(p, this.dev.pp); return D3D_OK; }
  }
  class Query {
    constructor(dev, type) { this.dev = dev; this.type = type; this.issued = false; this.iids = [IID.IDirect3DQuery9]; this.drawsAtIssue = 0; }
    GetDevice(c) { c.out32(1, this.dev.ptr); com.addRef(com.objectAt(this.dev.ptr)); return D3D_OK; }
    GetType() { return this.type; }
    GetDataSize() { return this.type === 8 ? 4 : this.type === 9 ? 4 : 32; }
    Issue(c) { const flags = c.arg(1); if (flags & 1) this.drawsAtIssue = this.dev.draws; this.issued = true; return D3D_OK; }
    GetData(c) { const p = c.arg(1), size = c.arg(2); if (!this.issued) return D3DERR_INVALIDCALL; if (p && size >= 4) mem.write32(p, this.type === 9 ? Math.max(1, this.dev.draws - this.drawsAtIssue) : 1); return S_OK; }
  }

  class Direct3D9 {
    constructor(sdk) { this.sdk = sdk; this.iids = [IID.IDirect3D9]; }
    RegisterSoftwareDevice() { return D3D_OK; }
    GetAdapterCount() { return 1; }
    GetAdapterIdentifier(c) {
      const adapter = c.arg(1), p = c.arg(3);
      if (adapter !== 0 || !p) return D3DERR_INVALIDCALL;
      mem.fill(p, 1100, 0);
      mem.writeCString(p, 'orthros.dll', 512); mem.writeCString(p + 512, 'Orthros WebGL2 Display Adapter', 512); mem.writeCString(p + 1024, '\\\\.\\DISPLAY1', 32);
      mem.write32(p + 1056, 0x00010000); mem.write32(p + 1060, 0x00060000); // DriverVersion 6.0.1.0
      mem.write32(p + 1064, 0x1002); mem.write32(p + 1068, 0x4e44); mem.write32(p + 1072, 0); mem.write32(p + 1076, 0);
      writeGuid(mem, p + 1080, 'd7b71ee2-0000-11cf-0000-000000000000');
      mem.write32(p + 1096, 0);
      return D3D_OK;
    }
    GetAdapterModeCount(c) { const fmt = c.arg(2); return c.arg(1) === 0 ? modes().filter((m) => m.format === fmt).length : 0; }
    EnumAdapterModes(c) { const fmt = c.arg(2), list = modes().filter((m) => m.format === fmt); const m = list[c.arg(3)], p = c.arg(4); if (c.arg(1) !== 0 || !m || !p) return D3DERR_INVALIDCALL; writeMode(p, m); return D3D_OK; }
    GetAdapterDisplayMode(c) { const p = c.arg(2); if (c.arg(1) !== 0 || !p) return D3DERR_INVALIDCALL; writeMode(p, displayMode()); return D3D_OK; }
    CheckDeviceType(c) { const adapter = c.arg(1), devType = c.arg(2), disp = c.arg(3), bb = c.arg(4); if (adapter !== 0) return D3DERR_INVALIDCALL; if (devType !== 1 && devType !== 2 && devType !== 4) return D3DERR_NOTAVAILABLE; if (!DISPLAY_FORMATS.has(disp)) return D3DERR_NOTAVAILABLE; if (bb !== FMT.UNKNOWN && !BACKBUFFER_FORMATS.has(bb)) return D3DERR_NOTAVAILABLE; return D3D_OK; }
    CheckDeviceFormat(c) {
      const adapter = c.arg(1), usage = c.arg(4), rtype = c.arg(5), fmt = c.arg(6);
      if (adapter !== 0) return D3DERR_INVALIDCALL;
      const hr = (usage & USAGE_DEPTHSTENCIL) ? (DEPTH_FORMATS.has(fmt) ? D3D_OK : D3DERR_NOTAVAILABLE)
        : (usage & USAGE_RENDERTARGET) ? (BACKBUFFER_FORMATS.has(fmt) || fmt === FMT.A8R8G8B8 ? D3D_OK : D3DERR_NOTAVAILABLE)
        : (usage & 0x400 /* AUTOGENMIPMAP */) ? (TEXTURE_FORMATS.has(fmt) ? S_OK : D3DERR_NOTAVAILABLE)
        : (rtype === RTYPE.TEXTURE || rtype === RTYPE.CUBETEXTURE || rtype === RTYPE.VOLUMETEXTURE) ? (TEXTURE_FORMATS.has(fmt) ? D3D_OK : D3DERR_NOTAVAILABLE)
        : (rtype === RTYPE.SURFACE) ? (TEXTURE_FORMATS.has(fmt) || BACKBUFFER_FORMATS.has(fmt) || DEPTH_FORMATS.has(fmt) ? D3D_OK : D3DERR_NOTAVAILABLE) : undefined;
      if (hr !== undefined) {
        checkTrail.push(`CheckDeviceFormat(adapterFmt ${fmtName(c.arg(3))}, usage 0x${usage.toString(16)}, rtype ${rtype}, fmt ${fmtName(fmt)}) -> ${hr === D3D_OK || hr === S_OK ? 'ok' : 'not available'}`); if (checkTrail.length > 8) checkTrail.shift();
        if (hr !== D3D_OK && hr !== S_OK) { const k = `${usage}/${rtype}/${fmt}`; if (!checkedFormats.has(k)) { checkedFormats.add(k); vm.log('gfx', `d3d9: CheckDeviceFormat usage 0x${usage.toString(16)} rtype ${rtype} fmt ${fmtName(fmt)} -> not available`); } }
        return hr;
      }
      return TEXTURE_FORMATS.has(fmt) || fmt === FMT.VERTEXDATA || fmt === FMT.INDEX16 || fmt === FMT.INDEX32 ? D3D_OK : D3DERR_NOTAVAILABLE;
    }
    CheckDeviceMultiSampleType(c) { const ms = c.arg(5), pq = c.arg(6); if (pq) mem.write32(pq, ms <= 1 ? 1 : 0); return ms <= 1 ? D3D_OK : D3DERR_NOTAVAILABLE; }
    CheckDepthStencilMatch(c) { return DEPTH_FORMATS.has(c.arg(5)) ? D3D_OK : D3DERR_NOTAVAILABLE; }
    CheckDeviceFormatConversion() { return D3D_OK; }
    GetDeviceCaps(c) { const p = c.arg(3); if (c.arg(1) !== 0 || !p) return D3DERR_INVALIDCALL; writeCaps9(p, 0, c.arg(2)); return D3D_OK; }
    GetAdapterMonitor(c) { return c.arg(1) === 0 ? 0x10001 : 0; }
    CreateDevice(c) {
      const adapter = c.arg(1), devType = c.arg(2), hFocus = c.arg(3), behavior = c.arg(4), pp = c.arg(5), out = c.arg(6);
      if (adapter !== 0 || !pp || !out) return D3DERR_INVALIDCALL;
      const dev = new Device9(c, this, adapter, devType, hFocus, behavior, pp);
      dev.ptr = com.create(c.proc, 'IDirect3DDevice9', dev);
      mem.write32(out, dev.ptr);
      vm.d3dDevice = dev;
      vm.log('gfx', `d3d9: CreateDevice ${dev.pp.width}x${dev.pp.height} fmt ${dev.pp.format} ${dev.pp.windowed ? 'windowed' : 'fullscreen'} depth ${dev.pp.autoDepth ? dev.pp.depthFormat : 'none'} behavior 0x${behavior.toString(16)} backend ${dev.gfx ? 'yes' : 'none'}`);
      return D3D_OK;
    }
  }

  api.define('d3d9.dll', {
    Direct3DCreate9: [1, (c) => {
      const sdk = c.arg(0);
      vm.firstD3DCall ??= { name: 'Direct3DCreate9', from: c.proc.symbolize(c.retAddr), apiCalls: vm.apiCalls };
      vm.log('gfx', `Direct3DCreate9(sdk ${sdk}) from ${c.proc.symbolize(c.retAddr)}`);
      const d = new Direct3D9(sdk);
      return d.ptr = com.create(c.proc, 'IDirect3D9', d);
    }],
    D3DPERF_BeginEvent: [2, () => 0], D3DPERF_EndEvent: [0, () => 0], D3DPERF_SetMarker: [2, () => {}], D3DPERF_SetRegion: [2, () => {}], D3DPERF_QueryRepeatFrame: [0, () => 0], D3DPERF_SetOptions: [1, () => {}], D3DPERF_GetStatus: [0, () => 0],
    Direct3DShaderValidatorCreate9: [0, () => 0], PSGPError: [3, () => {}], PSGPSampleTexture: [5, () => {}], DebugSetMute: [0, () => 0], DebugSetLevel: [1, () => 0],
  });
  void readGuid; void S_FALSE; void E_NOINTERFACE; void E_POINTER; void E_NOTIMPL; void surfaceBytes; void writeSurfDesc9; void POOL;
}
