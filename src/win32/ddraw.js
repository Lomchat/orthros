// DirectDraw (ddraw.dll): the device and display queries games make before or beside Direct3D 8/9 (video memory,
// display modes, capabilities, the driver's identity, enumeration of the display devices). Surfaces, clippers and
// palettes are not implemented (DDERR_UNSUPPORTED): a game drawing through DirectDraw itself needs more than this.
import { snapClass } from '../core/snapshot.js';
import { readGuid } from './com.js';

export const IID_IDirectDraw = '6c14db80-a733-11ce-a521-0020af0be560';
export const IID_IDirectDraw2 = 'b3a6f3e0-2b43-11cf-a2de-00aa00b93356';
export const IID_IDirectDraw4 = '9c59509a-39bd-11d1-8c4a-00c04fd930c5';
export const IID_IDirectDraw7 = '15e65ec0-3b9c-11d2-b92f-00609797ea5b';

const DD_OK = 0, DDERR_INVALIDPARAMS = 0x80070057, DDERR_UNSUPPORTED = 0x80004001, DDERR_NOAGGREGATION = 0x80040110;
const DDERR_ALREADYINITIALIZED = 0x88760005;
/** video memory reported (the same as IDirect3DDevice8/9::GetAvailableTextureMem) */
export const VIDEO_MEMORY = 256 * 1024 * 1024;
const MODES = [[640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 720], [1280, 768], [1280, 800], [1280, 960], [1280, 1024], [1360, 768], [1366, 768], [1440, 900], [1600, 900], [1600, 1200], [1680, 1050], [1920, 1080], [1920, 1200], [2560, 1440]];
const BPPS = [16, 32];
const FOURCCS = ['DXT1', 'DXT2', 'DXT3', 'DXT4', 'DXT5'];

// IDirectDraw's methods (in vtable order, after IUnknown's); SetDisplayMode has 3 arguments in IDirectDraw, 5 later
const methods = (setModeArgs) => [['Compact', 0], ['CreateClipper', 3], ['CreatePalette', 4], ['CreateSurface', 3], ['DuplicateSurface', 2], ['EnumDisplayModes', 4], ['EnumSurfaces', 4], ['FlipToGDISurface', 0], ['GetCaps', 2], ['GetDisplayMode', 1], ['GetFourCCCodes', 2], ['GetGDISurface', 1], ['GetMonitorFrequency', 1], ['GetScanLine', 1], ['GetVerticalBlankStatus', 1], ['Initialize', 1], ['RestoreDisplayMode', 0], ['SetCooperativeLevel', 2], ['SetDisplayMode', setModeArgs], ['WaitForVerticalBlank', 2]];

/** A display mode as a DDSURFACEDESC(2) (the fields both versions share; dwSize is the caller's). */
export function writeModeDesc(mem, a, w, h, bpp, refresh) {
  const size = mem.read32(a) === 124 ? 124 : 108;
  mem.fill(a, size, 0);
  mem.write32(a, size);
  mem.write32(a + 4, 0x2 | 0x4 | 0x8 | 0x1000 | 0x40000); // DDSD_HEIGHT | WIDTH | PITCH | PIXELFORMAT | REFRESHRATE
  mem.write32(a + 8, h); mem.write32(a + 12, w); mem.write32(a + 16, w * (bpp / 8)); mem.write32(a + 24, refresh);
  const pf = a + 72; // DDPIXELFORMAT
  mem.write32(pf, 32); mem.write32(pf + 4, 0x40); mem.write32(pf + 12, bpp); // DDPF_RGB
  if (bpp === 16) { mem.write32(pf + 16, 0xf800); mem.write32(pf + 20, 0x07e0); mem.write32(pf + 24, 0x001f); }
  else { mem.write32(pf + 16, 0xff0000); mem.write32(pf + 20, 0xff00); mem.write32(pf + 24, 0xff); }
}

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerDirectDraw(api, vm) {
  const mem = vm.mem, com = vm.com;
  com.interface('IDirectDraw', IID_IDirectDraw, 'IUnknown', methods(3));
  com.interface('IDirectDraw2', IID_IDirectDraw2, 'IUnknown', [...methods(5), ['GetAvailableVidMem', 3]]);
  com.interface('IDirectDraw4', IID_IDirectDraw4, 'IDirectDraw2', [['GetSurfaceFromDC', 2], ['RestoreAllSurfaces', 0], ['TestCooperativeLevel', 0], ['GetDeviceIdentifier', 2]]);
  com.interface('IDirectDraw7', IID_IDirectDraw7, 'IDirectDraw4', [['StartModeTest', 3], ['EvaluateMode', 2]]);
  const VERSIONS = new Map([[IID_IDirectDraw, 'IDirectDraw'], [IID_IDirectDraw2, 'IDirectDraw2'], [IID_IDirectDraw4, 'IDirectDraw4'], [IID_IDirectDraw7, 'IDirectDraw7']]);

  const display = () => { const d = vm.host?.display; return { width: d?.width ?? 1024, height: d?.height ?? 768, bpp: 32, refresh: 60 }; };
  const modeList = () => { const d = display(), list = []; for (const bpp of BPPS) { const seen = new Set(); for (const [w, h] of [...MODES, [d.width, d.height]]) { if (seen.has(w * 100000 + h)) continue; seen.add(w * 100000 + h); list.push([w, h, bpp]); } } return list; };

  /** One DirectDraw object: an interface object per version asked for (QueryInterface), all sharing this state. */
  class DirectDraw {
    constructor() { this.views = new Map(); this.coop = 0; }
    view(c, name) {
      let p = this.views.get(name);
      if (p && com.objectAt(p)) { com.addRef(com.objectAt(p)); return p; }
      p = com.create(c.proc, name, new DirectDrawView(this, name));
      this.views.set(name, p);
      return p;
    }
  }
  class DirectDrawView {
    constructor(dd, name) { this.dd = dd; this.name = name; this.notImpl = DDERR_UNSUPPORTED; }
    queryInterface(c, iid) { const name = VERSIONS.get(iid); return name ? this.dd.view(c, name) : 0; }
    Compact() { return DD_OK; }
    GetCaps(c) {
      for (const p of [c.arg(1), c.arg(2)]) {
        if (!p) continue;
        const size = Math.min(mem.read32(p) || 380, 380);
        mem.fill(p + 4, size - 4, 0);
        mem.write32(p + 4, 0x1 | 0x40 | 0x200 | 0x04000000); // DDCAPS_3D | BLT | BLTSTRETCH | BLTCOLORFILL
        mem.write32(p + 8, 0x80000 | 0x20000); // DDCAPS2_CANRENDERWINDOWED | DDCAPS2_PRIMARYGAMMA
        mem.write32(p + 56, 0x400 | 0x200 | 0x100); // dwZBufferBitDepths: DDBD_16 | DDBD_24 | DDBD_32
        if (p === c.arg(1)) { mem.write32(p + 60, VIDEO_MEMORY); mem.write32(p + 64, VIDEO_MEMORY); }
      }
      return DD_OK;
    }
    GetAvailableVidMem(c) {
      if (c.arg(2)) mem.write32(c.arg(2), VIDEO_MEMORY);
      if (c.arg(3)) mem.write32(c.arg(3), VIDEO_MEMORY);
      return DD_OK;
    }
    GetDisplayMode(c) { const p = c.arg(1); if (!p) return DDERR_INVALIDPARAMS; const d = display(); writeModeDesc(mem, p, d.width, d.height, d.bpp, d.refresh); return DD_OK; }
    EnumDisplayModes(c) {
      const filter = c.arg(2), ref = c.arg(3), cb = c.arg(4);
      if (!cb) return DDERR_INVALIDPARAMS;
      // (the filter: its width, height, refresh rate and bit depth when its flags say so)
      const ff = filter ? mem.read32(filter + 4) : 0;
      const buf = c.proc.processHeap.alloc(124);
      try {
        for (const [w, h, bpp] of modeList()) {
          if ((ff & 0x4) && mem.read32(filter + 12) !== w) continue;
          if ((ff & 0x2) && mem.read32(filter + 8) !== h) continue;
          if ((ff & 0x1000) && mem.read32(filter + 84) !== bpp) continue;
          mem.write32(buf, this.name === 'IDirectDraw7' || this.name === 'IDirectDraw4' ? 124 : 108);
          writeModeDesc(mem, buf, w, h, bpp, 60);
          if (vm.callGuest(c.thread, cb, [buf, ref]) === 0) break; // DDENUMRET_CANCEL
        }
      } finally { c.proc.processHeap.free_(buf); }
      return DD_OK;
    }
    GetFourCCCodes(c) {
      const pn = c.arg(1), codes = c.arg(2);
      if (!pn) return DDERR_INVALIDPARAMS;
      if (codes) FOURCCS.slice(0, mem.read32(pn)).forEach((s, i) => mem.write32(codes + 4 * i, s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)));
      mem.write32(pn, FOURCCS.length);
      return DD_OK;
    }
    GetMonitorFrequency(c) { if (c.arg(1)) mem.write32(c.arg(1), display().refresh); return DD_OK; }
    GetScanLine(c) { if (c.arg(1)) mem.write32(c.arg(1), 0); return DD_OK; }
    GetVerticalBlankStatus(c) { if (c.arg(1)) mem.write32(c.arg(1), 0); return DD_OK; }
    Initialize() { return DDERR_ALREADYINITIALIZED; }
    RestoreDisplayMode() { return DD_OK; }
    SetCooperativeLevel(c) { this.dd.coop = c.arg(2); return DD_OK; }
    SetDisplayMode() { return DD_OK; } // (the page's canvas follows the Direct3D device's back buffer, not this)
    WaitForVerticalBlank() { return DD_OK; }
    RestoreAllSurfaces() { return DD_OK; }
    TestCooperativeLevel() { return DD_OK; }
    GetDeviceIdentifier(c) {
      const p = c.arg(1);
      if (!p) return DDERR_INVALIDPARAMS;
      mem.fill(p, this.name === 'IDirectDraw7' ? 1068 : 1064, 0);
      mem.writeCString(p, 'orthros.dll', 512); mem.writeCString(p + 512, 'Orthros WebGL2 Display Adapter', 512);
      mem.write32(p + 1024, 0x00010000); mem.write32(p + 1028, 0x00060000); // driver version 6.0.1.0
      return DD_OK;
    }
  }
  for (const C of [DirectDraw, DirectDrawView]) snapClass(vm, C, { name: `ddraw.${C.name}` }); // (snapshots: core/vm-snapshot.js)

  const create = (c, pp, iid, outer) => {
    vm.firstD3DCall ??= { name: 'DirectDrawCreate', from: c.proc.symbolize(c.retAddr), apiCalls: vm.apiCalls };
    if (!pp) return DDERR_INVALIDPARAMS;
    mem.write32(pp, 0);
    if (outer) return DDERR_NOAGGREGATION;
    const name = VERSIONS.get(iid);
    if (!name) return DDERR_INVALIDPARAMS;
    mem.write32(pp, new DirectDraw().view(c, name));
    return DD_OK;
  };
  // (enumeration: the primary display driver, NULL GUID)
  const enumerate = (c, ex, wide) => {
    const cb = c.arg(0), ref = c.arg(1);
    if (!cb) return DDERR_INVALIDPARAMS;
    const heap = c.proc.processHeap, desc = 'Primary Display Driver', name = 'display';
    const s1 = heap.alloc(64), s2 = heap.alloc(32);
    try {
      if (wide) { mem.writeWString(s1, desc, 32); mem.writeWString(s2, name, 16); } else { mem.writeCString(s1, desc, 64); mem.writeCString(s2, name, 32); }
      vm.callGuest(c.thread, cb, ex ? [0, s1, s2, ref, 0] : [0, s1, s2, ref]);
    } finally { heap.free_(s1); heap.free_(s2); }
    return DD_OK;
  };
  api.define('ddraw.dll', {
    DirectDrawCreate: [3, (c) => create(c, c.arg(1), IID_IDirectDraw, c.arg(2))],
    DirectDrawCreateEx: [4, (c) => { const iid = c.arg(2) ? readGuid(mem, c.arg(2)) : ''; return create(c, c.arg(1), iid === IID_IDirectDraw7 ? iid : '', c.arg(3)); }],
    DirectDrawEnumerateA: [2, (c) => enumerate(c, false, false)],
    DirectDrawEnumerateW: [2, (c) => enumerate(c, false, true)],
    DirectDrawEnumerateExA: [3, (c) => enumerate(c, true, false)],
    DirectDrawEnumerateExW: [3, (c) => enumerate(c, true, true)],
  });
}
