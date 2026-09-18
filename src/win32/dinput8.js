// dinput8.dll / dinput.dll: DirectInput 8 (and 7 via the same objects) over the window manager's
// raw input stream. System keyboard (256 DIK states from scan codes) and system mouse (relative
// axes, buttons, wheel), immediate and buffered data, cooperative levels, enumeration.
import { Com, readGuid, writeGuid, S_OK, S_FALSE, E_NOTIMPL, E_POINTER, E_INVALIDARG } from './com.js';
import { wmOf } from './user32.js';

const DI_OK = 0, DI_NOTATTACHED = 1, DI_BUFFEROVERFLOW = 1, DIERR_INPUTLOST = 0x8007001e, DIERR_NOTACQUIRED = 0x8007000c, DIERR_NOTINITIALIZED = 0x80070015, DIERR_INVALIDPARAM = 0x80070057, DIERR_DEVICENOTREG = 0x80040154, DIERR_UNSUPPORTED = 0x80004001, DIERR_ACQUIRED = 0x800700aa, DIERR_OTHERAPPHASPRIO = 0x80070005;
const GUID_SysKeyboard = '6f1d2b61-d5a0-11cf-bfc7-444553540000', GUID_SysMouse = '6f1d2b60-d5a0-11cf-bfc7-444553540000';
const GUID_XAxis = 'a36d02e0-c9f3-11cf-bfc7-444553540000', GUID_YAxis = 'a36d02e1-c9f3-11cf-bfc7-444553540000', GUID_ZAxis = 'a36d02e2-c9f3-11cf-bfc7-444553540000', GUID_Button = 'a36d02f0-c9f3-11cf-bfc7-444553540000', GUID_Key = '55728220-d33c-11cf-bfc7-444553540000';
const IID_IDirectInput8A = 'bf798030-483a-4da2-aa99-5d64ed369700', IID_IDirectInput8W = 'bf798031-483a-4da2-aa99-5d64ed369700';
const IID_IDirectInputDevice8A = '54d41080-dc15-4833-a41b-748f73a38179', IID_IDirectInputDevice8W = '54d41081-dc15-4833-a41b-748f73a38179';
const IID_IDirectInput7A = '9a4cb684-236d-11d3-8e9d-00c04f6844ae', IID_IDirectInputDevice7A = '57d7c6bc-2356-11d3-8e9d-00c04f6844ae', IID_IDirectInputDevice2A = '5944e682-c92e-11cf-bfc7-444553540000', IID_IDirectInputDeviceA = '5944e680-c92e-11cf-bfc7-444553540000';
const DI8DEVTYPE_MOUSE = 0x12, DI8DEVTYPE_KEYBOARD = 0x13, DIDEVTYPE_MOUSE = 2, DIDEVTYPE_KEYBOARD = 3;
const DIDFT_AXIS = 3, DIDFT_PSHBUTTON = 4, DIDFT_RELAXIS = 1;
const DISCL_EXCLUSIVE = 1, DISCL_NONEXCLUSIVE = 2, DISCL_FOREGROUND = 4, DISCL_BACKGROUND = 8;
const DIPROP_BUFFERSIZE = 1, DIPROP_AXISMODE = 2, DIPROP_GRANULARITY = 3, DIPROP_RANGE = 4, DIPROP_DEADZONE = 5, DIPROP_SATURATION = 6, DIPROP_FFGAIN = 7, DIPROP_FFLOAD = 8, DIPROP_AUTOCENTER = 9, DIPROP_CALIBRATIONMODE = 10, DIPROP_CALIBRATION = 11, DIPROP_GUIDANDPATH = 12, DIPROP_INSTANCENAME = 13, DIPROP_PRODUCTNAME = 14;
const DIPROPAXISMODE_ABS = 0, DIPROPAXISMODE_REL = 1;

/** virtual key -> scan code for events that carry only a VK (PC AT set 1) */
const VK_TO_SCAN = (() => {
  const t = new Uint8Array(256);
  const row1 = '1234567890'; for (let i = 0; i < 10; i++) t[0x30 + i] = 0x02 + i; t[0x30] = 0x0b;
  const q = 'QWERTYUIOP'; for (let i = 0; i < q.length; i++) t[q.charCodeAt(i)] = 0x10 + i;
  const a = 'ASDFGHJKL'; for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = 0x1e + i;
  const z = 'ZXCVBNM'; for (let i = 0; i < z.length; i++) t[z.charCodeAt(i)] = 0x2c + i;
  Object.assign(t, { 0x1b: 0x01, 0x08: 0x0e, 0x09: 0x0f, 0x0d: 0x1c, 0x11: 0x1d, 0x10: 0x2a, 0x12: 0x38, 0x20: 0x39, 0x14: 0x3a, 0x70: 0x3b, 0x71: 0x3c, 0x72: 0x3d, 0x73: 0x3e, 0x74: 0x3f, 0x75: 0x40, 0x76: 0x41, 0x77: 0x42, 0x78: 0x43, 0x79: 0x44, 0x7a: 0x57, 0x7b: 0x58, 0x90: 0x45, 0x91: 0x46, 0x26: 0xc8, 0x28: 0xd0, 0x25: 0xcb, 0x27: 0xcd, 0x24: 0xc7, 0x23: 0xcf, 0x21: 0xc9, 0x22: 0xd1, 0x2d: 0xd2, 0x2e: 0xd3, 0xbd: 0x0c, 0xbb: 0x0d, 0xdb: 0x1a, 0xdd: 0x1b, 0xba: 0x27, 0xde: 0x28, 0xc0: 0x29, 0xdc: 0x2b, 0xbc: 0x33, 0xbe: 0x34, 0xbf: 0x35, 0xa0: 0x2a, 0xa1: 0x36, 0xa2: 0x1d, 0xa3: 0x9d, 0xa4: 0x38, 0xa5: 0xb8, 0x60: 0x52, 0x61: 0x4f, 0x62: 0x50, 0x63: 0x51, 0x64: 0x4b, 0x65: 0x4c, 0x66: 0x4d, 0x67: 0x47, 0x68: 0x48, 0x69: 0x49, 0x6a: 0x37, 0x6b: 0x4e, 0x6d: 0x4a, 0x6e: 0x53, 0x6f: 0xb5, 0x5b: 0xdb, 0x5c: 0xdc, 0x5d: 0xdd, 0x13: 0xc5, 0x2c: 0xb7 });
  void row1;
  return t;
})();

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerDirectInput(api, vm) {
  const mem = vm.mem, com = vm.com;
  // ---- interfaces (vtable order from dinput.h)
  com.interface('IDirectInput8A', IID_IDirectInput8A, 'IUnknown', [['CreateDevice', 3], ['EnumDevices', 4], ['GetDeviceStatus', 1], ['RunControlPanel', 2], ['Initialize', 2], ['FindDevice', 3], ['EnumDevicesBySemantics', 5], ['ConfigureDevices', 4]]);
  com.interface('IDirectInput7A', IID_IDirectInput7A, 'IUnknown', [['CreateDevice', 3], ['EnumDevices', 4], ['GetDeviceStatus', 1], ['RunControlPanel', 2], ['Initialize', 2], ['FindDevice', 3], ['CreateDeviceEx', 4]]);
  const devMethods = [['GetCapabilities', 1], ['EnumObjects', 3], ['GetProperty', 2], ['SetProperty', 2], ['Acquire', 0], ['Unacquire', 0], ['GetDeviceState', 2], ['GetDeviceData', 4], ['SetDataFormat', 1], ['SetEventNotification', 1], ['SetCooperativeLevel', 2], ['GetObjectInfo', 3], ['GetDeviceInfo', 1], ['RunControlPanel', 2], ['Initialize', 3], ['CreateEffect', 4], ['EnumEffects', 3], ['GetEffectInfo', 2], ['GetForceFeedbackState', 1], ['SendForceFeedbackCommand', 1], ['EnumCreatedEffectObjects', 3], ['Escape', 1], ['Poll', 0], ['SendDeviceData', 4], ['EnumEffectsInFile', 4], ['WriteEffectToFile', 4], ['BuildActionMap', 3], ['SetActionMap', 3], ['GetImageInfo', 1]];
  com.interface('IDirectInputDevice8A', IID_IDirectInputDevice8A, 'IUnknown', devMethods);
  com.interface('IDirectInputDevice7A', IID_IDirectInputDevice7A, 'IUnknown', devMethods.slice(0, 26));

  const wide = (iid) => iid === IID_IDirectInput8W || iid === IID_IDirectInputDevice8W;
  const writeStr = (a, s, max, w) => (w ? mem.writeWString(a, s, max) : mem.writeCString(a, s, max));

  /** One DirectInput device (keyboard or mouse). Events arrive from the window manager's raw stream. */
  class Device {
    constructor(proc, kind, w) {
      this.proc = proc; this.kind = kind; this.wide = w;
      this.acquired = false; this.coop = DISCL_NONEXCLUSIVE | DISCL_FOREGROUND; this.hwnd = 0;
      this.format = null; // { size, kind: 'keyboard'|'mouse'|'mouse2'|'custom', axisMode }
      this.bufferSize = 0; this.queue = []; this.seq = 1; this.overflow = false;
      this.axisMode = DIPROPAXISMODE_REL;
      this.keys = new Uint8Array(256); // DIK state (0x80 = down)
      this.mouse = { x: 0, y: 0, z: 0, buttons: new Uint8Array(8), absX: 0, absY: 0 }; // accumulated relative motion since the last GetDeviceState
      this.event = 0;
      this.listener = (ev) => this.onRaw(ev);
      wmOf(vm).rawListeners.push(this.listener);
    }
    destroy() { const l = wmOf(vm).rawListeners; const i = l.indexOf(this.listener); if (i >= 0) l.splice(i, 1); }
    push(ofs, data) {
      if (!this.bufferSize) return;
      if (this.queue.length >= this.bufferSize) { this.overflow = true; this.queue.shift(); }
      this.queue.push({ ofs, data: data >>> 0, time: Math.floor(vm.clock.now()) >>> 0, seq: this.seq++ });
      if (this.event) { const o = vm.proc.handles.getAs(this.event, 'event'); if (o) o.signaled = true; };
    }
    onRaw(ev) {
      if (this.kind === 'keyboard') {
        if (ev.type !== 'keydown' && ev.type !== 'keyup') return;
        let scan = ev.scan ?? VK_TO_SCAN[ev.vk & 0xff]; if (ev.extended && scan < 0x80) scan |= 0x80;
        scan &= 0xff; if (!scan) return;
        const down = ev.type === 'keydown';
        if (down && this.keys[scan]) return; // key repeat: no new DirectInput event
        this.keys[scan] = down ? 0x80 : 0;
        if (this.acquired) this.push(scan, down ? 0x80 : 0);
        return;
      }
      switch (ev.type) {
        case 'mousemove': {
          const dx = ev.dx | 0, dy = ev.dy | 0;
          this.mouse.absX = ev.x; this.mouse.absY = ev.y;
          if (dx) { this.mouse.x += dx; if (this.acquired) this.push(0, this.axisMode === DIPROPAXISMODE_ABS ? ev.x : dx); }
          if (dy) { this.mouse.y += dy; if (this.acquired) this.push(4, this.axisMode === DIPROPAXISMODE_ABS ? ev.y : dy); }
          break;
        }
        case 'wheel': { const d = (ev.delta * 120) | 0; this.mouse.z += d; if (this.acquired) this.push(8, d); break; }
        case 'mousedown': case 'mouseup': {
          const b = Math.min(7, ev.button | 0); const down = ev.type === 'mousedown';
          this.mouse.buttons[b] = down ? 0x80 : 0;
          if (this.acquired) this.push(12 + b, down ? 0x80 : 0);
          break;
        }
      }
    }
    // ---- IDirectInputDevice8
    GetCapabilities(c) {
      const p = c.arg(1); const size = mem.read32(p);
      if (size < 24) return DIERR_INVALIDPARAM;
      mem.fill(p + 4, size - 4, 0);
      mem.write32(p + 4, 0x3); // DIDC_ATTACHED | DIDC_POLLEDDEVICE? no: ATTACHED(1) | EMULATED(4)? keep ATTACHED only
      mem.write32(p + 4, 1);
      mem.write32(p + 8, this.kind === 'keyboard' ? (DI8DEVTYPE_KEYBOARD | (4 << 8)) : (DI8DEVTYPE_MOUSE | (2 << 8)));
      mem.write32(p + 12, this.kind === 'keyboard' ? 0 : 3); // axes
      mem.write32(p + 16, this.kind === 'keyboard' ? 128 : 8); // buttons
      mem.write32(p + 20, 0); // POVs
      return DI_OK;
    }
    EnumObjects(c) {
      const cb = c.arg(1), ref = c.arg(2), flags = c.arg(3);
      const objs = this.kind === 'keyboard'
        ? Array.from({ length: 128 }, (_, i) => ({ guid: GUID_Key, ofs: i, type: DIDFT_PSHBUTTON | (i << 8), name: `Key ${i}` }))
        : [{ guid: GUID_XAxis, ofs: 0, type: DIDFT_RELAXIS | (0 << 8), name: 'X-axis' }, { guid: GUID_YAxis, ofs: 4, type: DIDFT_RELAXIS | (1 << 8), name: 'Y-axis' }, { guid: GUID_ZAxis, ofs: 8, type: DIDFT_RELAXIS | (2 << 8), name: 'Wheel' }, ...Array.from({ length: 8 }, (_, i) => ({ guid: GUID_Button, ofs: 12 + i, type: DIDFT_PSHBUTTON | ((3 + i) << 8), name: `Button ${i}` }))];
      const want = (t) => flags === 0 || flags === 0xff || ((flags & DIDFT_AXIS) && (t & 0xff) === DIDFT_RELAXIS) || ((flags & 0xc) && (t & 0xff) === DIDFT_PSHBUTTON);
      const size = this.wide ? 0x2c8 : 0x18c; // DIDEVICEOBJECTINSTANCE(A/W)
      const buf = c.proc.processHeap.alloc(size);
      try {
        for (const o of objs) {
          if (!want(o.type)) continue;
          mem.fill(buf, size, 0);
          mem.write32(buf, size); writeGuid(mem, buf + 4, o.guid); mem.write32(buf + 20, o.ofs); mem.write32(buf + 24, o.type); mem.write32(buf + 28, 0);
          writeStr(buf + 32, o.name, 260, this.wide);
          const r = vm.callGuest(c.thread, cb, [buf, ref]);
          if (r === 0) break; // DIENUM_STOP
        }
      } finally { c.proc.processHeap.free_(buf); }
      return DI_OK;
    }
    GetProperty(c) {
      const guid = c.arg(1), hdr = c.arg(2);
      const id = guid < 0x10000 ? guid : -1; // predefined properties are small integers cast to REFGUID
      if (!hdr) return DIERR_INVALIDPARAM;
      switch (id) {
        case DIPROP_BUFFERSIZE: mem.write32(hdr + 16, this.bufferSize); return DI_OK;
        case DIPROP_AXISMODE: mem.write32(hdr + 16, this.axisMode); return DI_OK;
        case DIPROP_GRANULARITY: mem.write32(hdr + 16, 1); return DI_OK;
        case DIPROP_RANGE: mem.write32(hdr + 16, 0x80000000 | 0); mem.write32(hdr + 20, 0x7fffffff); return DI_OK;
        case DIPROP_DEADZONE: case DIPROP_SATURATION: case DIPROP_FFGAIN: mem.write32(hdr + 16, 0); return DI_OK;
        case DIPROP_INSTANCENAME: case DIPROP_PRODUCTNAME: mem.writeWString(hdr + 16, this.kind === 'keyboard' ? 'Keyboard' : 'Mouse', 260); return DI_OK;
      }
      return DIERR_UNSUPPORTED;
    }
    SetProperty(c) {
      const guid = c.arg(1), hdr = c.arg(2);
      const id = guid < 0x10000 ? guid : -1;
      if (!hdr) return DIERR_INVALIDPARAM;
      switch (id) {
        case DIPROP_BUFFERSIZE: this.bufferSize = mem.read32(hdr + 16); this.queue.length = Math.min(this.queue.length, this.bufferSize); return DI_OK;
        case DIPROP_AXISMODE: this.axisMode = mem.read32(hdr + 16); return DI_OK;
        case DIPROP_RANGE: case DIPROP_DEADZONE: case DIPROP_SATURATION: case DIPROP_FFGAIN: case DIPROP_AUTOCENTER: case DIPROP_CALIBRATIONMODE: return DI_OK;
      }
      return DIERR_UNSUPPORTED;
    }
    Acquire() {
      if (!this.format) return DIERR_INVALIDPARAM;
      if (this.acquired) return S_FALSE;
      this.acquired = true; this.queue.length = 0; this.overflow = false;
      this.mouse.x = this.mouse.y = this.mouse.z = 0;
      vm.log('input', `dinput: ${this.kind} acquired (coop ${this.coop.toString(16)})`);
      return DI_OK;
    }
    Unacquire() { const was = this.acquired; this.acquired = false; return was ? DI_OK : DI_NOTATTACHED; }
    GetDeviceState(c) {
      const size = c.arg(1), p = c.arg(2);
      if (!this.format) return DIERR_INVALIDPARAM;
      if (!this.acquired) return DIERR_NOTACQUIRED;
      if (!p || size < this.format.size) return DIERR_INVALIDPARAM;
      mem.fill(p, size, 0);
      if (this.kind === 'keyboard') { mem.writeBytes(p, this.keys.subarray(0, Math.min(256, size))); return DI_OK; }
      const m = this.mouse;
      if (this.axisMode === DIPROPAXISMODE_ABS) { mem.write32(p, m.absX); mem.write32(p + 4, m.absY); mem.write32(p + 8, m.z); }
      else { mem.write32(p, m.x); mem.write32(p + 4, m.y); mem.write32(p + 8, m.z); m.x = m.y = m.z = 0; }
      const nb = this.format.kind === 'mouse2' ? 8 : 4;
      for (let i = 0; i < nb && 12 + i < size; i++) mem.write8(p + 12 + i, m.buttons[i]);
      return DI_OK;
    }
    GetDeviceData(c) {
      const cbData = c.arg(1), rgdod = c.arg(2), pInOut = c.arg(3), flags = c.arg(4);
      if (!this.format) return DIERR_INVALIDPARAM;
      if (!this.acquired) return DIERR_NOTACQUIRED;
      if (!this.bufferSize) return DIERR_NOTINITIALIZED;
      if (cbData !== 16 && cbData !== 20) return DIERR_INVALIDPARAM;
      const max = mem.read32(pInOut);
      const n = Math.min(max, this.queue.length);
      const peek = (flags & 1) !== 0; // DIGDD_PEEK
      for (let i = 0; i < n && rgdod; i++) {
        const e = this.queue[i], a = rgdod + i * cbData;
        mem.write32(a, e.ofs); mem.write32(a + 4, e.data); mem.write32(a + 8, e.time); mem.write32(a + 12, e.seq);
        if (cbData === 20) mem.write32(a + 16, 0);
      }
      if (!peek) this.queue.splice(0, rgdod ? n : this.queue.length);
      mem.write32(pInOut, rgdod ? n : this.queue.length);
      const ov = this.overflow; if (!peek) this.overflow = false;
      return ov ? DI_BUFFEROVERFLOW : DI_OK;
    }
    SetDataFormat(c) {
      const p = c.arg(1);
      if (!p) return DIERR_INVALIDPARAM;
      const size = mem.read32(p), flags = mem.read32(p + 8), dataSize = mem.read32(p + 12), nobj = mem.read32(p + 16);
      void size; void nobj;
      if (this.acquired) return DIERR_ACQUIRED;
      const kind = this.kind === 'keyboard' ? 'keyboard' : dataSize >= 20 ? 'mouse2' : 'mouse';
      this.format = { size: dataSize, kind, abs: (flags & 2) !== 0 };
      if (this.kind === 'mouse') this.axisMode = flags & 2 ? DIPROPAXISMODE_ABS : DIPROPAXISMODE_REL;
      return DI_OK;
    }
    SetEventNotification(c) { this.event = c.arg(1); return DI_OK; }
    SetCooperativeLevel(c) { this.hwnd = c.arg(1); this.coop = c.arg(2); return DI_OK; }
    GetObjectInfo(c) {
      const p = c.arg(1), obj = c.arg(2), how = c.arg(3);
      if (!p) return DIERR_INVALIDPARAM;
      const size = mem.read32(p);
      mem.fill(p + 4, size - 4, 0);
      let ofs = obj;
      if (how === 1) ofs = this.kind === 'keyboard' ? (obj >> 8) & 0xff : [0, 4, 8, 12, 13, 14, 15, 16, 17, 18, 19][(obj >> 8) & 0xff] ?? 0; // DIPH_BYID
      writeGuid(mem, p + 4, this.kind === 'keyboard' ? GUID_Key : ofs < 12 ? [GUID_XAxis, GUID_YAxis, GUID_ZAxis][ofs >> 2] : GUID_Button);
      mem.write32(p + 20, ofs);
      mem.write32(p + 24, this.kind === 'keyboard' ? DIDFT_PSHBUTTON | (ofs << 8) : ofs < 12 ? DIDFT_RELAXIS | ((ofs >> 2) << 8) : DIDFT_PSHBUTTON | ((3 + ofs - 12) << 8));
      writeStr(p + 32, this.kind === 'keyboard' ? `Key ${ofs}` : ofs < 12 ? ['X-axis', 'Y-axis', 'Wheel'][ofs >> 2] : `Button ${ofs - 12}`, 260, this.wide);
      return DI_OK;
    }
    GetDeviceInfo(c) {
      const p = c.arg(1);
      if (!p) return DIERR_INVALIDPARAM;
      const size = mem.read32(p);
      mem.fill(p + 4, size - 4, 0);
      writeGuid(mem, p + 4, this.kind === 'keyboard' ? GUID_SysKeyboard : GUID_SysMouse);
      writeGuid(mem, p + 20, this.kind === 'keyboard' ? GUID_SysKeyboard : GUID_SysMouse);
      mem.write32(p + 36, this.kind === 'keyboard' ? (DI8DEVTYPE_KEYBOARD | (4 << 8)) : (DI8DEVTYPE_MOUSE | (2 << 8)));
      writeStr(p + 40, this.kind === 'keyboard' ? 'Keyboard' : 'Mouse', 260, this.wide);
      writeStr(p + 40 + (this.wide ? 520 : 260), this.kind === 'keyboard' ? 'Keyboard' : 'Mouse', 260, this.wide);
      return DI_OK;
    }
    RunControlPanel() { return DI_OK; }
    Initialize() { return DI_OK; }
    CreateEffect(c) { c.out32(3, 0); return DIERR_DEVICENOTREG; }
    EnumEffects() { return DI_OK; }
    GetEffectInfo() { return DIERR_DEVICENOTREG; }
    GetForceFeedbackState(c) { c.out32(1, 0); return DIERR_UNSUPPORTED; }
    SendForceFeedbackCommand() { return DIERR_UNSUPPORTED; }
    EnumCreatedEffectObjects() { return DI_OK; }
    Escape() { return DIERR_UNSUPPORTED; }
    Poll() { return this.acquired ? DI_OK : DIERR_NOTACQUIRED; }
    SendDeviceData() { return DIERR_UNSUPPORTED; }
    BuildActionMap() { return DI_OK; }
    SetActionMap() { return DI_OK; }
    GetImageInfo() { return DIERR_UNSUPPORTED; }
  }

  class DirectInput {
    constructor(w, v8) { this.wide = w; this.v8 = v8; this.iids = [IID_IDirectInput8A, IID_IDirectInput8W, IID_IDirectInput7A]; }
    CreateDevice(c) {
      const guid = readGuid(mem, c.arg(1)), pp = c.arg(2);
      if (!pp) return E_POINTER;
      const kind = guid === GUID_SysKeyboard ? 'keyboard' : guid === GUID_SysMouse ? 'mouse' : null;
      if (!kind) { mem.write32(pp, 0); vm.log('input', `dinput: CreateDevice(${guid}) -> no such device`); return DIERR_DEVICENOTREG; }
      const dev = new Device(c.proc, kind, this.wide);
      dev.iids = [IID_IDirectInputDevice8A, IID_IDirectInputDevice8W, IID_IDirectInputDevice7A, IID_IDirectInputDevice2A, IID_IDirectInputDeviceA];
      mem.write32(pp, com.create(c.proc, this.v8 ? 'IDirectInputDevice8A' : 'IDirectInputDevice7A', dev));
      vm.log('input', `dinput: CreateDevice(${kind})`);
      return DI_OK;
    }
    CreateDeviceEx(c) { return this.CreateDevice({ ...c, arg: (i) => c.arg(i === 2 ? 3 : i) }); }
    EnumDevices(c) {
      const type = c.arg(1), cb = c.arg(2), ref = c.arg(3);
      const size = this.wide ? 0x2f4 : 0x244; // DIDEVICEINSTANCE(A/W) with DI8 fields
      const list = [];
      const kbType = this.v8 ? DI8DEVTYPE_KEYBOARD | (4 << 8) : DIDEVTYPE_KEYBOARD | (4 << 8), msType = this.v8 ? DI8DEVTYPE_MOUSE | (2 << 8) : DIDEVTYPE_MOUSE | (2 << 8);
      const want = (t) => type === 0 || type === (t & 0xff) || (this.v8 && type === 4 && (t & 0xff) === DI8DEVTYPE_KEYBOARD) || (this.v8 && type === 2 && (t & 0xff) === DI8DEVTYPE_MOUSE) || (this.v8 && type === 1 && (t & 0xff) <= 0x13);
      if (want(kbType)) list.push({ guid: GUID_SysKeyboard, type: kbType, name: 'Keyboard' });
      if (want(msType)) list.push({ guid: GUID_SysMouse, type: msType, name: 'Mouse' });
      const buf = c.proc.processHeap.alloc(size);
      try {
        for (const d of list) {
          mem.fill(buf, size, 0);
          mem.write32(buf, size); writeGuid(mem, buf + 4, d.guid); writeGuid(mem, buf + 20, d.guid); mem.write32(buf + 36, d.type);
          writeStr(buf + 40, d.name, 260, this.wide); writeStr(buf + 40 + (this.wide ? 520 : 260), d.name, 260, this.wide);
          if (vm.callGuest(c.thread, cb, [buf, ref]) === 0) break;
        }
      } finally { c.proc.processHeap.free_(buf); }
      return DI_OK;
    }
    GetDeviceStatus(c) { const g = readGuid(mem, c.arg(1)); return g === GUID_SysKeyboard || g === GUID_SysMouse ? DI_OK : DIERR_DEVICENOTREG; }
    RunControlPanel() { return DI_OK; }
    Initialize() { return DI_OK; }
    FindDevice() { return DIERR_DEVICENOTREG; }
    EnumDevicesBySemantics() { return DI_OK; }
    ConfigureDevices() { return DI_OK; }
  }

  const create = (c, iidArg, outArg, version) => {
    const iid = iidArg >= 0 ? readGuid(mem, c.arg(iidArg)) : IID_IDirectInput7A;
    const pp = c.arg(outArg);
    if (!pp) return E_POINTER;
    const v8 = iid === IID_IDirectInput8A || iid === IID_IDirectInput8W;
    const w = wide(iid);
    if (!v8 && iid !== IID_IDirectInput7A && iidArg >= 0) { mem.write32(pp, 0); return 0x80004002; }
    const obj = new DirectInput(w, v8 || iidArg < 0);
    mem.write32(pp, com.create(c.proc, v8 ? 'IDirectInput8A' : 'IDirectInput7A', obj));
    vm.firstD3DCall ??= { name: v8 ? 'DirectInput8Create' : 'DirectInputCreate', from: c.proc.symbolize(c.retAddr), apiCalls: vm.apiCalls };
    vm.log('input', `DirectInput${v8 ? '8' : ''}Create(version 0x${(version >>> 0).toString(16)}) -> ${v8 ? 'IDirectInput8' : 'IDirectInput7'}${w ? 'W' : 'A'}`);
    return DI_OK;
  };
  api.define('dinput8.dll', { DirectInput8Create: [5, (c) => create(c, 2, 3, c.arg(1))] });
  api.define('dinput.dll', { DirectInputCreateA: [4, (c) => create(c, -1, 2, c.arg(1))], DirectInputCreateW: [4, (c) => create(c, -1, 2, c.arg(1))], DirectInputCreateEx: [5, (c) => create(c, 2, 3, c.arg(1))] });
  void E_NOTIMPL; void E_INVALIDARG; void S_OK; void DISCL_EXCLUSIVE; void DISCL_BACKGROUND; void DIERR_INPUTLOST; void DIERR_OTHERAPPHASPRIO; void DIPROP_FFLOAD; void DIPROP_CALIBRATION; void DIPROP_GUIDANDPATH; void Com;
}
