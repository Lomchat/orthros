// user32.dll: window classes and windows, message queues, painting, timers, input, display
// modes, and the DefWindowProc behaviour games rely on. Rendering goes through the software GDI
// (src/gfx/gdi) onto per-window client surfaces which are presented by the host display.
import { E } from './errors.js';
import { INFINITE, WAIT_OBJECT_0, WAIT_TIMEOUT, WAIT_FAILED } from '../core/sched.js';
import { makeDC, gdiOf, crToRgb, parseBitmapInfo, dibSurface, fillRect, blit, dcFont } from './gdi32.js';
import { allocSurface, freeSurface } from '../gfx/gdi/surface.js';
import { clipRect, rectEmpty } from '../gfx/gdi/raster.js';
import { parseCursorFile } from '../gfx/gdi/cursor.js';
import { caseMap, decodeBytes, encodeString } from './strings.js';
import { formatPrintf } from './wsprintf.js';
import { findResource } from '../loader/pe.js';
import { isSignaled, consumeSignal, waitObject, allocString } from './kernel32.js';
import { CC_CDECL } from './api.js';
import { TS } from './process.js';

export const WM = Object.freeze({
  CREATE: 1, DESTROY: 2, MOVE: 3, SIZE: 5, ACTIVATE: 6, SETFOCUS: 7, KILLFOCUS: 8, ENABLE: 0xa, SETREDRAW: 0xb, SETTEXT: 0xc, GETTEXT: 0xd,
  GETTEXTLENGTH: 0xe, PAINT: 0xf, CLOSE: 0x10, QUIT: 0x12, ERASEBKGND: 0x14, SHOWWINDOW: 0x18, ACTIVATEAPP: 0x1c, SETCURSOR: 0x20,
  MOUSEACTIVATE: 0x21, GETMINMAXINFO: 0x24, WINDOWPOSCHANGING: 0x46, WINDOWPOSCHANGED: 0x47, DISPLAYCHANGE: 0x7e, NCCREATE: 0x81, NCDESTROY: 0x82,
  NCCALCSIZE: 0x83, NCHITTEST: 0x84, NCPAINT: 0x85, NCACTIVATE: 0x86, GETDLGCODE: 0x87, KEYDOWN: 0x100, KEYUP: 0x101, CHAR: 0x102, DEADCHAR: 0x103,
  SYSKEYDOWN: 0x104, SYSKEYUP: 0x105, SYSCHAR: 0x106, COMMAND: 0x111, SYSCOMMAND: 0x112, TIMER: 0x113, MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201,
  LBUTTONUP: 0x202, LBUTTONDBLCLK: 0x203, RBUTTONDOWN: 0x204, RBUTTONUP: 0x205, RBUTTONDBLCLK: 0x206, MBUTTONDOWN: 0x207, MBUTTONUP: 0x208,
  MBUTTONDBLCLK: 0x209, MOUSEWHEEL: 0x20a, XBUTTONDOWN: 0x20b, XBUTTONUP: 0x20c, SIZING: 0x214, CAPTURECHANGED: 0x215, ENTERSIZEMOVE: 0x231,
  EXITSIZEMOVE: 0x232, MOUSELEAVE: 0x2a3, USER: 0x400, APP: 0x8000,
});

const WS_CHILD = 0x40000000, WS_VISIBLE = 0x10000000, WS_DISABLED = 0x08000000, WS_POPUP = 0x80000000, WS_MINIMIZE = 0x20000000, WS_MAXIMIZE = 0x01000000;
const WS_CAPTION = 0x00c00000, WS_BORDER = 0x00800000, WS_DLGFRAME = 0x00400000, WS_THICKFRAME = 0x00040000, WS_SYSMENU = 0x00080000;
const WS_EX_TOOLWINDOW = 0x80, WS_EX_DLGMODALFRAME = 1, WS_EX_CLIENTEDGE = 0x200, WS_EX_TOPMOST = 8;
const CW_USEDEFAULT = 0x80000000;
const PM_REMOVE = 1;
const VK = { LBUTTON: 1, RBUTTON: 2, MBUTTON: 4, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, CAPITAL: 0x14, LSHIFT: 0xa0, RSHIFT: 0xa1, LCONTROL: 0xa2, RCONTROL: 0xa3, LMENU: 0xa4, RMENU: 0xa5 };
const CAPTION_H = 19, FRAME_THICK = 4, FRAME_THIN = 1, FRAME_DLG = 3, MENU_H = 19;

let nextClassAtom = 0xc100;

/** Window manager: one per process. */
export class WindowManager {
  /** @param {import('../core/vm.js').Vm} vm */
  constructor(vm) {
    this.vm = vm;
    this.proc = vm.proc;
    this.mem = vm.mem;
    this.host = vm.host;
    const d = vm.host?.display;
    this.screen = { width: d?.width ?? 1024, height: d?.height ?? 768, bpp: d?.bpp ?? 32 };
    /** @type {Map<number, any>} hwnd -> window */
    this.windows = new Map();
    /** @type {Map<string, any>} class name (lower) -> class */
    this.classes = new Map();
    this.classByAtom = new Map();
    this.zorder = []; // top-level windows, front first
    this.focus = 0; this.active = 0; this.capture = 0; this.foreground = 0;
    this.cursor = { x: this.screen.width >> 1, y: this.screen.height >> 1 };
    this.keyState = new Uint8Array(256);
    /** @type {((ev: any) => void)[]} */
    this.rawListeners = [];
    this.showCursorCount = 0;
    this.dirty = false;
    this.lastPresent = -1;
    this.presentInterval = 8;
    this.cursorHandle = 0;
    this.clipboard = null;
    this.hooks = [];
    this.nextTimerId = 0x100;
    this.desktop = this.makeWindow({ cls: null, style: WS_VISIBLE, exStyle: 0, x: 0, y: 0, w: this.screen.width, h: this.screen.height, parent: null, title: '', desktop: true });
    this.registerBuiltinClasses();
    this.presentedOnce = false;
  }

  registerBuiltinClasses() {
    for (const name of ['BUTTON', 'STATIC', 'EDIT', 'LISTBOX', 'COMBOBOX', 'SCROLLBAR', '#32770', 'MDICLIENT', 'MSCTLS_TRACKBAR32', 'RICHEDIT']) {
      this.classes.set(name.toLowerCase(), { name, wndProc: 'builtin', style: 0, cbClsExtra: 0, cbWndExtra: 4, hInstance: 0, hIcon: 0, hCursor: 0, hbrBackground: 0, menuName: 0, atom: nextClassAtom++, extra: new Uint8Array(0), builtin: true });
    }
  }

  // ------------------------------------------------------------------ geometry
  ncSizes(style, exStyle) {
    let l = 0, t = 0;
    if ((style & WS_CAPTION) === WS_CAPTION) { l = (style & WS_THICKFRAME) ? FRAME_THICK : FRAME_DLG; t = l + CAPTION_H; }
    else if (style & WS_THICKFRAME) { l = FRAME_THICK; t = FRAME_THICK; }
    else if (style & WS_DLGFRAME) { l = FRAME_DLG; t = FRAME_DLG; }
    else if (style & WS_BORDER) { l = FRAME_THIN; t = FRAME_THIN; }
    if (exStyle & WS_EX_DLGMODALFRAME) { l += FRAME_DLG; t += FRAME_DLG; }
    if (exStyle & WS_EX_CLIENTEDGE) { l += 2; t += 2; }
    return { l, t, r: l, b: l };
  }

  makeWindow(o) {
    const w = {
      type: 'window', hwnd: 0, cls: o.cls, style: o.style >>> 0, exStyle: o.exStyle >>> 0, parent: o.parent, owner: o.owner ?? null, children: [],
      rect: { l: o.x, t: o.y, r: o.x + o.w, b: o.y + o.h }, client: null, title: o.title ?? '', wndProc: o.cls?.wndProc ?? 'builtin',
      userData: 0, id: o.id ?? 0, hInstance: o.hInstance ?? 0, extra: new DataView(new ArrayBuffer(Math.max(o.cls?.cbWndExtra ?? 0, 4))),
      visible: (o.style & WS_VISIBLE) !== 0, enabled: (o.style & WS_DISABLED) === 0, surface: null, invalid: null, eraseBkgnd: true,
      thread: this.vm.current, timers: new Map(), props: new Map(), desktop: !!o.desktop, minimized: false, maximized: false, destroyed: false,
      hasMenu: !!o.menu, menu: o.menu ?? 0, paintDC: null,
    };
    w.hwnd = this.proc.handles.create(w);
    this.windows.set(w.hwnd, w);
    this.layout(w);
    return w;
  }

  /** Compute client rect (screen coords) and (re)allocate the client surface for top-level windows. */
  layout(w) {
    const nc = w.desktop || (w.style & WS_CHILD) ? { l: 0, t: 0, r: 0, b: 0 } : this.ncSizes(w.style, w.exStyle);
    if (w.hasMenu && !(w.style & WS_CHILD)) nc.t += MENU_H;
    w.client = { l: w.rect.l + nc.l, t: w.rect.t + nc.t, r: Math.max(w.rect.r - nc.r, w.rect.l + nc.l), b: Math.max(w.rect.b - nc.b, w.rect.t + nc.t) };
    if (w.desktop || w.style & WS_CHILD) return;
    const cw = Math.max(1, w.client.r - w.client.l), ch = Math.max(1, w.client.b - w.client.t);
    if (!w.surface || w.surface.width !== cw || w.surface.height !== ch) {
      const old = w.surface;
      w.surface = allocSurface(this.proc, cw, ch, 'window');
      if (old) { blit(w.surface, { l: 0, t: 0, r: cw, b: ch }, 0, 0, Math.min(cw, old.width), Math.min(ch, old.height), old, 0, 0); freeSurface(this.proc, old); }
    }
  }

  topLevel(w) { while (w && w.style & WS_CHILD && w.parent && !w.parent.desktop) w = w.parent; return w; }
  clientW(w) { return w.client.r - w.client.l; }
  clientH(w) { return w.client.b - w.client.t; }

  /** DC for a window's client area (child windows draw into their top-level's surface). */
  windowDC(c, w, clipToInvalid = false) {
    const top = this.topLevel(w);
    if (!top.surface) return makeDC(this.proc, allocSurface(this.proc, 1, 1, 'nodc'), { hwnd: w.hwnd, window: w });
    const ox = w.client.l - top.client.l, oy = w.client.t - top.client.t;
    let clip = { l: ox, t: oy, r: ox + this.clientW(w), b: oy + this.clientH(w) };
    clip = clipRect(clip, { l: 0, t: 0, r: top.surface.width, b: top.surface.height });
    if (clipToInvalid && w.invalid) clip = clipRect(clip, { l: w.invalid.l + ox, t: w.invalid.t + oy, r: w.invalid.r + ox, b: w.invalid.b + oy });
    const dc = makeDC(this.proc, top.surface, { hwnd: w.hwnd, window: w, ox, oy, clip });
    dc.baseClip = { ...clip };
    return dc;
  }

  touch(w) { this.dirty = true; }

  /** Present the front-most visible top-level window (rate limited unless forced). */
  present(force = false) {
    if (!this.dirty && !force) return;
    const now = this.vm.clock.now();
    if (!force && this.presentedOnce && now - this.lastPresent < this.presentInterval) return;
    const d = this.host?.display;
    if (!d) { this.dirty = false; return; }
    const top = this.zorder.find((w) => w.visible && !w.minimized && w.surface);
    if (top) { d.present(top.surface, top.client.l, top.client.t); this.presentedOnce = true; }
    this.lastPresent = now;
    this.dirty = false;
  }

  // ------------------------------------------------------------------ messages
  queueOf(thread) { return thread.msgQueue ?? (thread.msgQueue = { msgs: [], quit: null, thread }); }

  send(w, msg, wParam, lParam) {
    if (!w || w.destroyed && msg !== WM.NCDESTROY) return 0;
    const proc = w.wndProc;
    if (typeof proc === 'number') return this.vm.callGuest(this.vm.current, proc, [w.hwnd, msg, wParam >>> 0, lParam >>> 0]) >>> 0;
    return this.defWindowProc(w, msg, wParam >>> 0, lParam >>> 0) >>> 0;
  }

  post(w, msg, wParam, lParam, thread = null) {
    const q = this.queueOf(thread ?? w?.thread ?? this.proc.threads[0]);
    q.msgs.push({ hwnd: w ? w.hwnd : 0, msg, wParam: wParam >>> 0, lParam: lParam >>> 0, time: this.tick(), pt: { ...this.cursor } });
  }

  tick() { return (0x1000000 + Math.floor(this.vm.clock.now())) >>> 0; }

  writeMsg(addr, m) {
    const mem = this.mem;
    mem.write32(addr, m.hwnd); mem.write32(addr + 4, m.msg); mem.write32(addr + 8, m.wParam); mem.write32(addr + 12, m.lParam);
    mem.write32(addr + 16, m.time); mem.write32(addr + 20, m.pt.x); mem.write32(addr + 24, m.pt.y);
  }

  matches(m, hwndFilter, min, max) {
    if (hwndFilter && m.hwnd !== hwndFilter) {
      // child windows of the filter also match
      let w = this.windows.get(m.hwnd); let ok = false;
      while (w) { if (w.hwnd === hwndFilter) { ok = true; break; } w = w.parent; }
      if (!ok) return false;
    }
    if (max && (m.msg < min || m.msg > max)) return false;
    if (!max && min && m.msg < min) return false;
    return true;
  }

  /** Convert host input into posted messages. */
  pump() {
    const evs = this.host?.pollInput?.();
    if (!evs) return;
    for (const ev of evs) this.inputEvent(ev);
  }

  windowAt(x, y) {
    for (const w of this.zorder) {
      if (!w.visible || w.minimized) continue;
      if (x >= w.rect.l && x < w.rect.r && y >= w.rect.t && y < w.rect.b) {
        // descend into visible children
        let cur = w;
        let found = true;
        while (found) {
          found = false;
          for (const ch of cur.children) if (ch.visible && x >= ch.client.l && x < ch.client.r && y >= ch.client.t && y < ch.client.b) { cur = ch; found = true; break; }
        }
        return cur;
      }
    }
    return null;
  }

  /**
   * Switch the display mode (ChangeDisplaySettings, or a fullscreen Direct3D device): resizes the host
   * display and the desktop window, then broadcasts WM_DISPLAYCHANGE. Zero sizes restore the default.
   */
  setDisplayMode(w, h, bpp = 32, fullscreen = false) {
    const d = this.host?.display;
    if (d && d.defaultWidth === undefined) { d.defaultWidth = d.width; d.defaultHeight = d.height; }
    if (!w || !h) { w = d?.defaultWidth ?? this.screen.width; h = d?.defaultHeight ?? this.screen.height; }
    if (d) d.setMode(w, h, bpp, fullscreen);
    this.screen = { width: w, height: h, bpp };
    this.desktop.rect = { l: 0, t: 0, r: w, b: h }; this.desktop.client = { l: 0, t: 0, r: w, b: h };
    this.vm.log('win', `display mode ${w}x${h}x${bpp}${fullscreen ? ' fullscreen' : ''}`);
    for (const x of this.zorder) this.post(x, WM.DISPLAYCHANGE, bpp, (h << 16) | w);
  }

  mkFlags() {
    let f = 0;
    if (this.keyState[VK.LBUTTON] & 0x80) f |= 1; if (this.keyState[VK.RBUTTON] & 0x80) f |= 2; if (this.keyState[VK.SHIFT] & 0x80) f |= 4;
    if (this.keyState[VK.CONTROL] & 0x80) f |= 8; if (this.keyState[VK.MBUTTON] & 0x80) f |= 0x10;
    return f;
  }

  inputEvent(ev) {
    if (ev.type === 'mousemove' && ev.dx === undefined) { ev.dx = ev.x - this.cursor.x; ev.dy = ev.y - this.cursor.y; }
    for (const l of this.rawListeners) l(ev); // raw input consumers (DirectInput devices)
    switch (ev.type) {
      case 'mousemove': {
        this.cursor = { x: ev.x, y: ev.y };
        const w = this.capture ? this.windows.get(this.capture) : this.windowAt(ev.x, ev.y);
        if (w && !w.desktop) this.post(w, WM.MOUSEMOVE, this.mkFlags(), ((ev.y - w.client.t) & 0xffff) << 16 | ((ev.x - w.client.l) & 0xffff));
        break;
      }
      case 'mousedown': case 'mouseup': {
        this.cursor = { x: ev.x, y: ev.y };
        const vk = [VK.LBUTTON, VK.RBUTTON, VK.MBUTTON][ev.button] ?? VK.LBUTTON;
        this.keyState[vk] = ev.type === 'mousedown' ? 0x80 : 0;
        const w = this.capture ? this.windows.get(this.capture) : this.windowAt(ev.x, ev.y);
        if (!w || w.desktop) break;
        if (ev.type === 'mousedown') this.activate(this.topLevel(w), true);
        const base = [WM.LBUTTONDOWN, WM.RBUTTONDOWN, WM.MBUTTONDOWN][ev.button] ?? WM.LBUTTONDOWN;
        const msg = ev.type === 'mousedown' ? (ev.dbl ? base + 2 : base) : base + 1;
        this.vm.log('input', `mouse ${ev.type} button ${ev.button} at ${ev.x},${ev.y} -> hwnd=${w.hwnd.toString(16)} msg=${msg.toString(16)} client ${ev.x - w.client.l},${ev.y - w.client.t}${this.capture ? ' (captured)' : ''}`);
        this.post(w, msg, this.mkFlags(), ((ev.y - w.client.t) & 0xffff) << 16 | ((ev.x - w.client.l) & 0xffff));
        break;
      }
      case 'wheel': {
        const w = this.windows.get(this.focus) ?? this.windowAt(ev.x ?? this.cursor.x, ev.y ?? this.cursor.y);
        if (w && !w.desktop) this.post(w, WM.MOUSEWHEEL, ((ev.delta * 120) & 0xffff) << 16 | this.mkFlags(), ((ev.y ?? this.cursor.y) & 0xffff) << 16 | ((ev.x ?? this.cursor.x) & 0xffff));
        break;
      }
      case 'keydown': case 'keyup': {
        const down = ev.type === 'keydown';
        const vk = ev.vk & 0xff;
        if (down) this.lastKeyVk = vk;
        const wasDown = (this.keyState[vk] & 0x80) !== 0;
        if (down) { if (!wasDown) this.keyState[vk] ^= 1; this.keyState[vk] |= 0x80; } else this.keyState[vk] &= 1;
        // generic modifier state
        if (vk === VK.LSHIFT || vk === VK.RSHIFT) this.keyState[VK.SHIFT] = (this.keyState[VK.LSHIFT] | this.keyState[VK.RSHIFT]) & 0x80;
        if (vk === VK.LCONTROL || vk === VK.RCONTROL) this.keyState[VK.CONTROL] = (this.keyState[VK.LCONTROL] | this.keyState[VK.RCONTROL]) & 0x80;
        if (vk === VK.LMENU || vk === VK.RMENU) this.keyState[VK.MENU] = (this.keyState[VK.LMENU] | this.keyState[VK.RMENU]) & 0x80;
        const w = this.windows.get(this.focus) ?? this.windows.get(this.active);
        if (!w) break;
        const alt = (this.keyState[VK.MENU] & 0x80) !== 0;
        const sys = alt || vk === VK.MENU || vk === VK.LMENU || vk === VK.RMENU || vk === 0x79;
        const msg = down ? (sys ? WM.SYSKEYDOWN : WM.KEYDOWN) : (sys ? WM.SYSKEYUP : WM.KEYUP);
        const scan = (ev.scan ?? 0) & 0xff, ext = ev.extended ? 1 : 0;
        const lParam = (ev.repeat ?? 1) | (scan << 16) | (ext << 24) | (sys && alt ? 1 << 29 : 0) | (wasDown ? 1 << 30 : 0) | (down ? 0 : 1 << 31);
        this.post(w, msg, vk, lParam >>> 0);
        break;
      }
      case 'char': {
        // The host knows the character the key produced (layout aware). Like Windows, WM_CHAR only comes out of
        // TranslateMessage: attach the character to the pending WM_KEYDOWN instead of posting a second message.
        if (this.lastKeyVk === undefined) break;
        this.pendingChars ??= [];
        this.pendingChars.push({ vk: this.lastKeyVk, code: ev.code });
        if (this.pendingChars.length > 64) this.pendingChars.shift();
        break;
      }
      case 'focus': {
        const w = this.windows.get(this.active);
        if (w) this.send(w, WM.ACTIVATEAPP, ev.focused ? 1 : 0, 0);
        if (!ev.focused) this.keyState.fill(0);
        break;
      }
      case 'close': {
        const w = this.zorder.find((x) => x.visible);
        if (w) this.post(w, WM.CLOSE, 0, 0);
        break;
      }
      case 'resize': break;
    }
  }

  /** Windows owned by a thread with pending paint. */
  paintPending(thread, hwndFilter) {
    for (const w of this.windows.values()) {
      if (w.destroyed || !w.visible || w.minimized || !w.invalid || rectEmpty(w.invalid)) continue;
      if (w.thread !== thread) continue;
      if (hwndFilter && w.hwnd !== hwndFilter) continue;
      // ancestors must be visible
      let p = w.parent, ok = true; while (p && !p.desktop) { if (!p.visible) { ok = false; break; } p = p.parent; }
      if (ok) return w;
    }
    return null;
  }

  dueTimer(thread, hwndFilter) {
    const now = this.vm.clock.now();
    for (const t of this.proc.timers) {
      if (t.kind !== 'wm' || t.thread !== thread) continue;
      if (hwndFilter && t.hwnd !== hwndFilter) continue;
      if (t.due <= now) return t;
    }
    return null;
  }

  /**
   * PeekMessage core. Returns a message object or null.
   */
  peek(thread, hwndFilter, min, max, remove) {
    this.pump();
    const q = this.queueOf(thread);
    for (let i = 0; i < q.msgs.length; i++) {
      const m = q.msgs[i];
      if (!this.matches(m, hwndFilter, min, max)) continue;
      if (remove) q.msgs.splice(i, 1);
      return m;
    }
    if (q.quit !== null && (!max || (WM.QUIT >= min && WM.QUIT <= max))) {
      const m = { hwnd: 0, msg: WM.QUIT, wParam: q.quit >>> 0, lParam: 0, time: this.tick(), pt: { ...this.cursor } };
      if (remove) q.quit = null;
      return m;
    }
    const inRange = (msg) => !max ? (!min || msg >= min) : msg >= min && msg <= max;
    if (inRange(WM.TIMER)) {
      const t = this.dueTimer(thread, hwndFilter);
      if (t) {
        if (remove) { const now = this.vm.clock.now(); t.due += t.elapse; if (t.due < now) t.due = now + t.elapse; }
        return { hwnd: t.hwnd, msg: WM.TIMER, wParam: t.id, lParam: t.proc, time: this.tick(), pt: { ...this.cursor } };
      }
    }
    if (inRange(WM.PAINT)) {
      const w = this.paintPending(thread, hwndFilter);
      if (w) return { hwnd: w.hwnd, msg: WM.PAINT, wParam: 0, lParam: 0, time: this.tick(), pt: { ...this.cursor } };
    }
    return null;
  }

  hasMessage(thread, hwndFilter, min, max) { return this.peek(thread, hwndFilter, min, max, false) !== null; }

  /** WM_QUIT handling and dispatch of a retrieved message. */
  dispatch(m) {
    if (m.msg === WM.TIMER && m.lParam) {
      return this.vm.callGuest(this.vm.current, m.lParam, [m.hwnd, WM.TIMER, m.wParam, this.tick()]);
    }
    const w = this.windows.get(m.hwnd);
    if (!w) return 0;
    if (m.msg === WM.PAINT) { const r = this.send(w, WM.PAINT, 0, 0); if (w.invalid && !rectEmpty(w.invalid)) { w.invalid = null; } this.present(); return r; }
    return this.send(w, m.msg, m.wParam, m.lParam);
  }

  // ------------------------------------------------------------------ window lifecycle
  findClass(nameOrAtom, wide) {
    if (typeof nameOrAtom === 'number') {
      if (nameOrAtom < 0x10000) return this.classByAtom.get(nameOrAtom) ?? null;
      nameOrAtom = wide ? this.mem.readWString(nameOrAtom) : this.mem.readCString(nameOrAtom);
    }
    return this.classes.get(nameOrAtom.toLowerCase()) ?? null;
  }

  registerClass(cls) {
    const key = cls.name.toLowerCase();
    if (this.classes.has(key) && !this.classes.get(key).builtin) return 0;
    cls.atom = nextClassAtom++;
    this.classes.set(key, cls);
    this.classByAtom.set(cls.atom, cls);
    return cls.atom;
  }

  createWindow(c, p) {
    const cls = this.findClass(p.className, p.wide);
    if (!cls) { c.setLastError(E.CANNOT_FIND_WND_CLASS); this.vm.warn(`CreateWindowEx: unknown class ${typeof p.className === 'number' && p.className < 0x10000 ? '#' + p.className : p.className}`); return 0; }
    const style = p.style >>> 0, exStyle = p.exStyle >>> 0;
    const isChild = (style & WS_CHILD) !== 0;
    let parent = p.parent ? this.windows.get(p.parent) ?? null : null;
    if (isChild && !parent) { c.setLastError(E.INVALID_PARAMETER); return 0; }
    let x = p.x | 0, y = p.y | 0, w = p.w | 0, h = p.h | 0;
    if ((p.x >>> 0) === CW_USEDEFAULT) { x = 0; y = 0; }
    if ((p.w >>> 0) === CW_USEDEFAULT) { const nc = this.ncSizes(style, exStyle); w = 640 + nc.l + nc.r; h = 480 + nc.t + nc.b; }
    if (isChild) { x += parent.client.l; y += parent.client.t; }
    const win = this.makeWindow({ cls, style, exStyle, x, y, w, h, parent: isChild ? parent : this.desktop, owner: !isChild && parent ? parent : null, title: p.title ?? '', id: isChild ? p.menu : 0, menu: isChild ? 0 : p.menu, hInstance: p.hInstance });
    win.visible = false; // becomes visible via ShowWindow below
    if (isChild) parent.children.push(win); else this.zorder.unshift(win);
    // CREATESTRUCT
    const cs = this.proc.processHeap.alloc(48, true);
    const mem = this.mem;
    const nameStr = p.titleAddr ?? 0, classStr = p.classAddr ?? 0;
    mem.write32(cs, p.lpParam); mem.write32(cs + 4, p.hInstance); mem.write32(cs + 8, p.menu); mem.write32(cs + 12, p.parent);
    mem.write32(cs + 16, h); mem.write32(cs + 20, w); mem.write32(cs + 24, p.y); mem.write32(cs + 28, p.x); mem.write32(cs + 32, style);
    mem.write32(cs + 36, nameStr); mem.write32(cs + 40, classStr); mem.write32(cs + 44, exStyle);
    // WM_GETMINMAXINFO, WM_NCCREATE, WM_NCCALCSIZE, WM_CREATE
    const mmi = this.proc.processHeap.alloc(40, true);
    mem.write32(mmi + 8, this.screen.width); mem.write32(mmi + 12, this.screen.height); mem.write32(mmi + 24, 112); mem.write32(mmi + 28, 27);
    mem.write32(mmi + 32, this.screen.width + 12); mem.write32(mmi + 36, this.screen.height + 12);
    if (!isChild) this.send(win, WM.GETMINMAXINFO, 0, mmi);
    this.proc.processHeap.free_(mmi);
    if (!this.send(win, WM.NCCREATE, 0, cs)) { this.destroyWindow(win, true); this.proc.processHeap.free_(cs); return 0; }
    const rc = this.proc.processHeap.alloc(16, true);
    mem.write32(rc, win.rect.l); mem.write32(rc + 4, win.rect.t); mem.write32(rc + 8, win.rect.r); mem.write32(rc + 12, win.rect.b);
    this.send(win, WM.NCCALCSIZE, 0, rc);
    this.proc.processHeap.free_(rc);
    const r = this.send(win, WM.CREATE, 0, cs);
    this.proc.processHeap.free_(cs);
    if ((r | 0) === -1) { this.destroyWindow(win, true); return 0; }
    this.send(win, WM.SIZE, 0, (this.clientH(win) << 16) | (this.clientW(win) & 0xffff));
    this.send(win, WM.MOVE, 0, (((win.client.t - (isChild ? parent.client.t : 0)) & 0xffff) << 16) | ((win.client.l - (isChild ? parent.client.l : 0)) & 0xffff));
    if (style & WS_VISIBLE) this.showWindow(win, style & WS_MAXIMIZE ? 3 : style & WS_MINIMIZE ? 2 : 5);
    this.vm.log('win', `CreateWindow "${cls.name}" "${win.title}" hwnd=${win.hwnd.toString(16)} ${w}x${h} client ${this.clientW(win)}x${this.clientH(win)} style=${style.toString(16)}`);
    return win.hwnd;
  }

  showWindow(w, cmd) {
    const was = w.visible;
    let show;
    switch (cmd) {
      case 0: show = false; break;
      case 2: case 6: case 7: show = true; w.minimized = true; break;
      case 3: show = true; w.maximized = true; if (!(w.style & WS_CHILD)) { this.setWindowPos(w, 0, 0, this.screen.width, this.screen.height, 0); } break;
      case 9: show = true; w.minimized = false; break;
      default: show = true; break;
    }
    if (show !== was) {
      w.visible = show;
      if (show) w.style |= WS_VISIBLE; else w.style &= ~WS_VISIBLE;
      this.send(w, WM.SHOWWINDOW, show ? 1 : 0, 0);
    }
    if (show && !(w.style & WS_CHILD) && cmd !== 4 && cmd !== 7 && cmd !== 8 && !w.minimized) this.activate(w, true);
    if (show) this.invalidate(w, null, true);
    if (show) this.send(w, WM.SIZE, w.minimized ? 1 : w.maximized ? 2 : 0, (this.clientH(w) << 16) | (this.clientW(w) & 0xffff));
    return was ? 1 : 0;
  }

  activate(w, setFocus) {
    if (!w || w.desktop) return;
    const prev = this.windows.get(this.active);
    if (prev === w) { if (setFocus && this.focus !== w.hwnd) this.setFocus(w); return; }
    if (prev && !prev.destroyed) { this.send(prev, WM.NCACTIVATE, 0, 0); this.send(prev, WM.ACTIVATE, 0, w.hwnd); }
    this.active = w.hwnd; this.foreground = w.hwnd;
    // bring to front
    const i = this.zorder.indexOf(w); if (i > 0) { this.zorder.splice(i, 1); this.zorder.unshift(w); }
    if (!prev) this.send(w, WM.ACTIVATEAPP, 1, 0);
    this.send(w, WM.NCACTIVATE, 1, 0);
    this.send(w, WM.ACTIVATE, 1, prev ? prev.hwnd : 0);
    if (setFocus) this.setFocus(w);
    this.dirty = true;
  }

  setFocus(w) {
    const prev = this.windows.get(this.focus);
    if (prev === w) return prev ? prev.hwnd : 0;
    this.focus = w ? w.hwnd : 0;
    if (prev && !prev.destroyed) this.send(prev, WM.KILLFOCUS, w ? w.hwnd : 0, 0);
    if (w) this.send(w, WM.SETFOCUS, prev ? prev.hwnd : 0, 0);
    return prev ? prev.hwnd : 0;
  }

  invalidate(w, rect, erase) {
    if (!w || w.destroyed) return;
    const full = { l: 0, t: 0, r: this.clientW(w), b: this.clientH(w) };
    const r = rect ? clipRect(rect, full) : full;
    if (rectEmpty(r) && rect) return;
    w.invalid = w.invalid ? { l: Math.min(w.invalid.l, r.l), t: Math.min(w.invalid.t, r.t), r: Math.max(w.invalid.r, r.r), b: Math.max(w.invalid.b, r.b) } : r;
    if (erase) w.eraseBkgnd = true;
  }

  validate(w, rect) {
    if (!w.invalid) return;
    if (!rect) { w.invalid = null; return; }
    // approximate: if the rect covers the invalid area, clear it
    const i = w.invalid;
    if (rect.l <= i.l && rect.t <= i.t && rect.r >= i.r && rect.b >= i.b) w.invalid = null;
  }

  setWindowPos(w, x, y, cx, cy, flags) {
    const SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80, SWP_FRAMECHANGED = 0x20;
    const isChild = (w.style & WS_CHILD) !== 0;
    const base = isChild ? w.parent.client : { l: 0, t: 0 };
    const oldRect = { ...w.rect }, oldClient = { ...w.client };
    let nl = flags & SWP_NOMOVE ? w.rect.l : base.l + x, nt = flags & SWP_NOMOVE ? w.rect.t : base.t + y;
    let nw = flags & SWP_NOSIZE ? w.rect.r - w.rect.l : cx, nh = flags & SWP_NOSIZE ? w.rect.b - w.rect.t : cy;
    // WINDOWPOS struct for WINDOWPOSCHANGING/CHANGED
    const wp = this.proc.processHeap.alloc(28, true);
    const mem = this.mem;
    mem.write32(wp, w.hwnd); mem.write32(wp + 4, 0); mem.write32(wp + 8, nl - base.l); mem.write32(wp + 12, nt - base.t); mem.write32(wp + 16, nw); mem.write32(wp + 20, nh); mem.write32(wp + 24, flags);
    this.send(w, WM.WINDOWPOSCHANGING, 0, wp);
    nl = base.l + mem.readS32(wp + 8); nt = base.t + mem.readS32(wp + 12); nw = mem.readS32(wp + 16); nh = mem.readS32(wp + 20);
    const dx = nl - w.rect.l, dy = nt - w.rect.t;
    w.rect = { l: nl, t: nt, r: nl + nw, b: nt + nh };
    if (flags & SWP_FRAMECHANGED) { /* nc sizes derive from style */ }
    this.layout(w);
    if (dx || dy) this.moveChildren(w, dx, dy);
    if (flags & SWP_SHOWWINDOW) this.showWindow(w, 5);
    if (flags & SWP_HIDEWINDOW) this.showWindow(w, 0);
    if (!(flags & SWP_NOZORDER) && !isChild) { const i = this.zorder.indexOf(w); if (i > 0) { this.zorder.splice(i, 1); this.zorder.unshift(w); } }
    if (!(flags & SWP_NOACTIVATE) && !isChild && w.visible) this.activate(w, false);
    mem.write32(wp + 24, flags);
    this.send(w, WM.WINDOWPOSCHANGED, 0, wp);
    this.proc.processHeap.free_(wp);
    const sizeChanged = oldClient.r - oldClient.l !== this.clientW(w) || oldClient.b - oldClient.t !== this.clientH(w);
    const moved = oldRect.l !== w.rect.l || oldRect.t !== w.rect.t;
    if (sizeChanged) { this.send(w, WM.SIZE, w.maximized ? 2 : 0, (this.clientH(w) << 16) | (this.clientW(w) & 0xffff)); this.invalidate(w, null, true); }
    if (moved) this.send(w, WM.MOVE, 0, (((w.client.t - base.t) & 0xffff) << 16) | ((w.client.l - base.l) & 0xffff));
    this.dirty = true;
    return 1;
  }

  moveChildren(w, dx, dy) {
    for (const ch of w.children) { ch.rect.l += dx; ch.rect.r += dx; ch.rect.t += dy; ch.rect.b += dy; ch.client.l += dx; ch.client.r += dx; ch.client.t += dy; ch.client.b += dy; this.moveChildren(ch, dx, dy); }
  }

  destroyWindow(w, silent = false) {
    if (!w || w.destroyed) return 0;
    for (const ch of [...w.children]) this.destroyWindow(ch, silent);
    if (!silent) { this.send(w, WM.DESTROY, 0, 0); }
    w.destroyed = true;
    if (!silent) this.send(w, WM.NCDESTROY, 0, 0);
    if (w.parent) w.parent.children = w.parent.children.filter((x) => x !== w);
    const zi = this.zorder.indexOf(w); if (zi >= 0) this.zorder.splice(zi, 1);
    if (this.focus === w.hwnd) this.focus = 0;
    if (this.active === w.hwnd) { this.active = 0; const next = this.zorder.find((x) => x.visible); if (next) this.activate(next, true); }
    if (this.capture === w.hwnd) this.capture = 0;
    if (this.foreground === w.hwnd) this.foreground = 0;
    this.proc.timers = this.proc.timers.filter((t) => t.hwnd !== w.hwnd);
    // drop queued messages for the window
    for (const t of this.proc.threads) if (t.msgQueue) t.msgQueue.msgs = t.msgQueue.msgs.filter((m) => m.hwnd !== w.hwnd);
    if (w.surface) { freeSurface(this.proc, w.surface); w.surface = null; }
    this.windows.delete(w.hwnd);
    this.proc.handles.map.delete(w.hwnd);
    this.dirty = true;
    return 1;
  }

  // ------------------------------------------------------------------ DefWindowProc
  defWindowProc(w, msg, wParam, lParam) {
    const mem = this.mem;
    switch (msg) {
      case WM.NCCREATE: return 1;
      case WM.NCCALCSIZE: return 0;
      case WM.NCHITTEST: return 1; // HTCLIENT
      case WM.NCACTIVATE: return 1;
      case WM.NCPAINT: return 0;
      case WM.NCDESTROY: return 0;
      case WM.CREATE: return 0;
      case WM.PAINT: {
        // validate and erase (as if BeginPaint/EndPaint were called)
        const dc = this.beginPaint(w, null);
        this.endPaint(w, dc);
        return 0;
      }
      case WM.ERASEBKGND: {
        const dc = this.proc.handles.getAs(wParam, 'gdi');
        const br = w.cls?.hbrBackground ?? 0;
        if (!dc || !br) return 0;
        const color = this.brushColor(br);
        if (color === null) return 0;
        fillRect(dc.surface, dc.clip, dc.clip.l, dc.clip.t, dc.clip.r, dc.clip.b, color);
        this.dirty = true;
        return 1;
      }
      case WM.CLOSE: this.destroyWindow(w); return 0;
      case WM.SETTEXT: w.title = lParam ? mem.readCString(lParam) : ''; this.host?.display?.setTitle?.(w.title); return 1;
      case WM.GETTEXT: { if (!wParam) return 0; const n = Math.min(w.title.length, wParam - 1); mem.writeCString(lParam, w.title.slice(0, n)); return n; }
      case WM.GETTEXTLENGTH: return w.title.length;
      case WM.SETCURSOR: return 0;
      case WM.MOUSEACTIVATE: return 1; // MA_ACTIVATE
      case WM.ACTIVATE: if ((wParam & 0xffff) !== 0) this.setFocus(w); return 0;
      case WM.SYSCOMMAND: {
        const cmd = wParam & 0xfff0;
        if (cmd === 0xf060) { this.send(w, WM.CLOSE, 0, 0); return 0; } // SC_CLOSE
        if (cmd === 0xf020) { w.minimized = true; return 0; }
        if (cmd === 0xf120) { w.minimized = false; return 0; }
        return 0;
      }
      case WM.SYSKEYDOWN: if (wParam === 0x73 && this.keyState[VK.MENU] & 0x80) { this.post(w, WM.SYSCOMMAND, 0xf060, 0); } return 0; // Alt+F4
      case WM.WINDOWPOSCHANGED: return 0;
      case WM.GETMINMAXINFO: return 0;
      case WM.SETREDRAW: return 0;
      case WM.SHOWWINDOW: return 0;
      case WM.KEYDOWN: case WM.KEYUP: case WM.CHAR: case WM.SYSKEYUP: case WM.SYSCHAR: return 0;
      case 0x7b: return 0; // WM_CONTEXTMENU
      case 0x2a1: return 0; // WM_MOUSEHOVER
      case 0x5: return 0;
      default: return 0;
    }
  }

  brushColor(h) {
    if (h < 0x20 && h > 0) return this.sysColor(h - 1); // COLOR_xxx + 1
    const b = this.proc.handles.getAs(h, 'gdi');
    if (!b || b.kind !== 'brush' || b.style === 1) return null;
    return b.color;
  }

  sysColor(i) {
    const T = { 0: 0xc0c0c0, 1: 0x004e98, 2: 0x0a246a, 3: 0x808080, 4: 0xd4d0c8, 5: 0xffffff, 6: 0x000000, 7: 0x000000, 8: 0x000000, 9: 0xffffff, 10: 0x808080, 11: 0xd4d0c8, 12: 0x808080, 13: 0x0a246a, 14: 0xffffff, 15: 0xd4d0c8, 16: 0x808080, 17: 0x808080, 18: 0x000000, 19: 0xd4d0c8, 20: 0xffffff, 21: 0x404040, 22: 0xd4d0c8, 23: 0x000000, 24: 0xffffe1, 25: 0x000000, 26: 0x0000ff, 27: 0x3a6ea5, 28: 0xa6caf0, 29: 0xd4d0c8, 30: 0xd4d0c8 };
    return T[i] ?? 0;
  }

  beginPaint(w, psAddr) {
    const dc = this.windowDC(this.vm.ctx, w, true);
    const inv = w.invalid ?? { l: 0, t: 0, r: this.clientW(w), b: this.clientH(w) };
    const erase = w.eraseBkgnd;
    if (psAddr) {
      const mem = this.mem;
      mem.write32(psAddr, dc.handle); mem.write32(psAddr + 4, erase ? 1 : 0);
      mem.write32(psAddr + 8, inv.l); mem.write32(psAddr + 12, inv.t); mem.write32(psAddr + 16, inv.r); mem.write32(psAddr + 20, inv.b);
      mem.fill(psAddr + 24, 40, 0);
    }
    w.invalid = null; w.eraseBkgnd = false;
    if (erase) { if (!this.send(w, WM.ERASEBKGND, dc.handle, 0) && psAddr) this.mem.write32(psAddr + 4, 1); }
    w.paintDC = dc;
    return dc;
  }

  endPaint(w, dc) {
    if (dc) { this.proc.handles.map.delete(dc.handle); }
    w.paintDC = null;
    this.dirty = true;
    this.present();
  }

  screenDC(c) {
    const top = this.zorder.find((w) => w.visible && w.surface) ?? null;
    if (top) { const dc = makeDC(this.proc, top.surface, { hwnd: 0, window: top, ox: -top.client.l, oy: -top.client.t }); return dc.handle; }
    const s = allocSurface(this.proc, this.screen.width, this.screen.height, 'screen');
    const dc = makeDC(this.proc, s, {});
    dc.ownsBitmap = null; dc.screenSurface = s;
    return dc.handle;
  }
}

/** Ensure a window manager exists for the current process. */
export function wmOf(vm) {
  if (!vm.wm || vm.wm.proc !== vm.proc) vm.wm = new WindowManager(vm);
  return vm.wm;
}

// =============================================================================================
/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerUser32(api, vm) {
  const mem = vm.mem;
  const U = {};
  const wm = () => wmOf(vm);
  const win = (h) => { const w = wm().windows.get(h >>> 0); return w && !w.destroyed ? w : null; };
  const readRect = (a) => ({ l: mem.readS32(a), t: mem.readS32(a + 4), r: mem.readS32(a + 8), b: mem.readS32(a + 12) });
  const writeRect = (a, r) => { mem.write32(a, r.l); mem.write32(a + 4, r.t); mem.write32(a + 8, r.r); mem.write32(a + 12, r.b); };
  const strOrAtom = (a, wide) => (a < 0x10000 ? a : wide ? mem.readWString(a) : mem.readCString(a));

  // ---------------------------------------------------------------- classes
  const regClass = (c, ex, wide) => {
    const p = c.arg(0) + (ex ? 4 : 0);
    const nameA = mem.read32(p + 36);
    const name = nameA < 0x10000 ? `#${nameA}` : wide ? mem.readWString(nameA) : mem.readCString(nameA);
    const cls = { name, wndProc: mem.read32(p + 4), style: mem.read32(p), cbClsExtra: mem.read32(p + 8), cbWndExtra: mem.read32(p + 12), hInstance: mem.read32(p + 16), hIcon: mem.read32(p + 20), hCursor: mem.read32(p + 24), hbrBackground: mem.read32(p + 28), menuName: mem.read32(p + 32), hIconSm: ex ? mem.read32(p + 40) : 0, extra: new DataView(new ArrayBuffer(Math.max(mem.read32(p + 8), 4))) };
    const atom = wm().registerClass(cls);
    if (!atom) return c.fail(E.CLASS_ALREADY_EXISTS);
    vm.log('win', `RegisterClass "${name}" wndproc=${cls.wndProc.toString(16)}`);
    return atom;
  };
  U.RegisterClassA = [1, (c) => regClass(c, false, false)];
  U.RegisterClassW = [1, (c) => regClass(c, false, true)];
  U.RegisterClassExA = [1, (c) => regClass(c, true, false)];
  U.RegisterClassExW = [1, (c) => regClass(c, true, true)];
  U.UnregisterClassA = [2, (c) => { const cls = wm().findClass(strOrAtom(c.arg(0), false), false); if (!cls || cls.builtin) return 0; wm().classes.delete(cls.name.toLowerCase()); wm().classByAtom.delete(cls.atom); return 1; }];
  U.UnregisterClassW = [2, (c) => { const cls = wm().findClass(strOrAtom(c.arg(0), true), true); if (!cls || cls.builtin) return 0; wm().classes.delete(cls.name.toLowerCase()); return 1; }];
  const getClassInfo = (c, ex, wide) => {
    const cls = wm().findClass(strOrAtom(c.arg(1), wide), wide);
    if (!cls) return c.fail(E.CLASS_DOES_NOT_EXIST);
    const p = c.arg(2) + (ex ? 4 : 0);
    if (ex) mem.write32(c.arg(2), 48);
    mem.write32(p, cls.style); mem.write32(p + 4, typeof cls.wndProc === 'number' ? cls.wndProc : api.thunkFor('user32.dll', 'DefWindowProcA')); mem.write32(p + 8, cls.cbClsExtra); mem.write32(p + 12, cls.cbWndExtra);
    mem.write32(p + 16, cls.hInstance); mem.write32(p + 20, cls.hIcon); mem.write32(p + 24, cls.hCursor); mem.write32(p + 28, cls.hbrBackground); mem.write32(p + 32, cls.menuName); mem.write32(p + 36, c.arg(1));
    if (ex) mem.write32(p + 40, cls.hIconSm ?? 0);
    return 1;
  };
  U.GetClassInfoA = [3, (c) => getClassInfo(c, false, false)];
  U.GetClassInfoW = [3, (c) => getClassInfo(c, false, true)];
  U.GetClassInfoExA = [3, (c) => getClassInfo(c, true, false)];
  U.GetClassInfoExW = [3, (c) => getClassInfo(c, true, true)];
  U.GetClassNameA = [3, (c) => { const w = win(c.arg(0)); if (!w) return 0; const s = w.cls?.name ?? '#32769'; mem.writeCString(c.arg(1), s, c.arg(2)); return Math.min(s.length, c.arg(2) - 1); }];
  U.GetClassNameW = [3, (c) => { const w = win(c.arg(0)); if (!w) return 0; const s = w.cls?.name ?? '#32769'; mem.writeWString(c.arg(1), s, c.arg(2)); return Math.min(s.length, c.arg(2) - 1); }];
  const classLong = (c, set) => {
    const w = win(c.arg(0)); if (!w || !w.cls) return 0;
    const idx = c.sarg(1); const cls = w.cls; const v = c.arg(2);
    const get = () => { switch (idx) { case -26: return cls.style; case -24: return typeof cls.wndProc === 'number' ? cls.wndProc : 0; case -20: return cls.cbClsExtra; case -18: return cls.cbWndExtra; case -16: return cls.hInstance; case -14: return cls.hIcon; case -12: return cls.hCursor; case -10: return cls.hbrBackground; case -8: return cls.menuName; case -32: return cls.atom; case -34: return cls.hIconSm ?? 0; default: return idx >= 0 && idx + 4 <= cls.extra.byteLength ? cls.extra.getUint32(idx, true) : 0; } };
    const old = get();
    if (set) { switch (idx) { case -26: cls.style = v; break; case -24: cls.wndProc = v; break; case -16: cls.hInstance = v; break; case -14: cls.hIcon = v; break; case -12: cls.hCursor = v; break; case -10: cls.hbrBackground = v; break; case -8: cls.menuName = v; break; case -34: cls.hIconSm = v; break; default: if (idx >= 0 && idx + 4 <= cls.extra.byteLength) cls.extra.setUint32(idx, v, true); } }
    return old;
  };
  U.GetClassLongA = [2, (c) => classLong(c, false)]; U.GetClassLongW = U.GetClassLongA;
  U.SetClassLongA = [3, (c) => classLong(c, true)]; U.SetClassLongW = U.SetClassLongA;

  // ---------------------------------------------------------------- windows
  const createWindow = (c, wide) => {
    const p = { exStyle: c.arg(0), className: strOrAtom(c.arg(1), wide), classAddr: c.arg(1), titleAddr: c.arg(2), title: c.arg(2) ? (wide ? mem.readWString(c.arg(2)) : mem.readCString(c.arg(2))) : '', style: c.arg(3), x: c.sarg(4), y: c.sarg(5), w: c.sarg(6), h: c.sarg(7), parent: c.arg(8), menu: c.arg(9), hInstance: c.arg(10), lpParam: c.arg(11), wide };
    if (typeof p.className === 'number' && p.className >= 0x10000) p.className = String(p.className);
    return wm().createWindow(c, p);
  };
  U.CreateWindowExA = [12, (c) => createWindow(c, false)];
  U.CreateWindowExW = [12, (c) => createWindow(c, true)];
  U.DestroyWindow = [1, (c) => { const w = win(c.arg(0)); if (!w) return c.fail(E.INVALID_WINDOW_HANDLE); return wm().destroyWindow(w); }];
  U.DefWindowProcA = [4, (c) => { const w = win(c.arg(0)); if (!w) return 0; return wm().defWindowProc(w, c.arg(1), c.arg(2), c.arg(3)); }];
  U.DefWindowProcW = U.DefWindowProcA;
  U.DefDlgProcA = U.DefWindowProcA; U.DefDlgProcW = U.DefWindowProcA; U.DefMDIChildProcA = U.DefWindowProcA; U.DefFrameProcA = [5, (c) => U.DefWindowProcA[1](c)];
  U.ShowWindow = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; return wm().showWindow(w, c.arg(1)); }];
  U.ShowWindowAsync = U.ShowWindow;
  U.UpdateWindow = [1, (c) => { const w = win(c.arg(0)); if (!w) return 0; if (w.invalid && !rectEmpty(w.invalid) && w.visible) { wm().send(w, WM.PAINT, 0, 0); w.invalid = null; } wm().present(); return 1; }];
  U.InvalidateRect = [3, (c) => { if (!c.arg(0)) { for (const w of wm().zorder) wm().invalidate(w, null, true); return 1; } const w = win(c.arg(0)); if (!w) return 0; wm().invalidate(w, c.arg(1) ? readRect(c.arg(1)) : null, c.arg(2) !== 0); return 1; }];
  U.InvalidateRgn = [3, (c) => { const w = win(c.arg(0)); if (!w) return 0; wm().invalidate(w, null, c.arg(2) !== 0); return 1; }];
  U.ValidateRect = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; wm().validate(w, c.arg(1) ? readRect(c.arg(1)) : null); return 1; }];
  U.ValidateRgn = [2, (c) => { const w = win(c.arg(0)); if (w) w.invalid = null; return 1; }];
  U.RedrawWindow = [4, (c) => { const w = win(c.arg(0)) ?? wm().zorder[0]; if (!w) return 0; const f = c.arg(3); if (f & 1) wm().invalidate(w, c.arg(1) ? readRect(c.arg(1)) : null, (f & 4) !== 0); if (f & 0x100 && w.invalid && w.visible) { wm().send(w, WM.PAINT, 0, 0); w.invalid = null; wm().present(); } return 1; }];
  U.GetUpdateRect = [3, (c) => { const w = win(c.arg(0)); if (!w) return 0; const inv = w.invalid; if (c.arg(1)) writeRect(c.arg(1), inv ?? { l: 0, t: 0, r: 0, b: 0 }); return inv && !rectEmpty(inv) ? 1 : 0; }];
  U.GetUpdateRgn = [3, (c) => { const w = win(c.arg(0)); return w?.invalid ? 2 : 1; }];
  U.BeginPaint = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; return wm().beginPaint(w, c.arg(1)).handle; }];
  U.EndPaint = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const dc = c.proc.handles.getAs(mem.read32(c.arg(1)), 'gdi'); wm().endPaint(w, dc); return 1; }];
  U.GetDC = [1, (c) => { const w = c.arg(0) ? win(c.arg(0)) : null; if (!w) return wm().screenDC(c); return wm().windowDC(c, w).handle; }];
  U.GetDCEx = [3, (c) => { const w = c.arg(0) ? win(c.arg(0)) : null; if (!w) return wm().screenDC(c); return wm().windowDC(c, w).handle; }];
  U.GetWindowDC = [1, (c) => { const w = c.arg(0) ? win(c.arg(0)) : null; if (!w) return wm().screenDC(c); return wm().windowDC(c, w).handle; }];
  U.ReleaseDC = [2, (c) => { const dc = c.proc.handles.getAs(c.arg(1), 'gdi'); if (!dc || dc.kind !== 'dc') return 0; if (dc.screenSurface) freeSurface(c.proc, dc.screenSurface); c.proc.handles.map.delete(c.arg(1)); wm().present(); return 1; }];
  U.GetClientRect = [2, (c) => { const w = win(c.arg(0)); if (!w) return c.fail(E.INVALID_WINDOW_HANDLE); writeRect(c.arg(1), { l: 0, t: 0, r: wm().clientW(w), b: wm().clientH(w) }); return 1; }];
  U.GetWindowRect = [2, (c) => { const w = win(c.arg(0)); if (!w) return c.fail(E.INVALID_WINDOW_HANDLE); writeRect(c.arg(1), w.rect); return 1; }];
  U.ClientToScreen = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const p = c.arg(1); mem.write32(p, mem.readS32(p) + w.client.l); mem.write32(p + 4, mem.readS32(p + 4) + w.client.t); return 1; }];
  U.ScreenToClient = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const p = c.arg(1); mem.write32(p, mem.readS32(p) - w.client.l); mem.write32(p + 4, mem.readS32(p + 4) - w.client.t); return 1; }];
  U.MapWindowPoints = [4, (c) => { const a = c.arg(0) ? win(c.arg(0)) : null, b = c.arg(1) ? win(c.arg(1)) : null; const dx = (a ? a.client.l : 0) - (b ? b.client.l : 0), dy = (a ? a.client.t : 0) - (b ? b.client.t : 0); for (let i = 0; i < c.arg(3); i++) { const p = c.arg(2) + 8 * i; mem.write32(p, mem.readS32(p) + dx); mem.write32(p + 4, mem.readS32(p + 4) + dy); } return ((dy & 0xffff) << 16 | (dx & 0xffff)) >>> 0; }];
  U.SetWindowPos = [7, (c) => { const w = win(c.arg(0)); if (!w) return 0; return wm().setWindowPos(w, c.sarg(2), c.sarg(3), c.sarg(4), c.sarg(5), c.arg(6)); }];
  U.MoveWindow = [6, (c) => { const w = win(c.arg(0)); if (!w) return 0; wm().setWindowPos(w, c.sarg(1), c.sarg(2), c.sarg(3), c.sarg(4), 4 | 0x10); if (c.arg(5)) wm().invalidate(w, null, true); return 1; }];
  U.BeginDeferWindowPos = [1, () => 1];
  U.DeferWindowPos = [8, (c) => { const w = win(c.arg(1)); if (w) wm().setWindowPos(w, c.sarg(3), c.sarg(4), c.sarg(5), c.sarg(6), c.arg(7)); return 1; }];
  U.EndDeferWindowPos = [1, () => 1];
  U.GetWindowPlacement = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const p = c.arg(1); mem.write32(p, 44); mem.write32(p + 4, 0); mem.write32(p + 8, w.minimized ? 2 : w.maximized ? 3 : 1); mem.write32(p + 12, 0xffffffff); mem.write32(p + 16, 0xffffffff); mem.write32(p + 20, 0xffffffff); mem.write32(p + 24, 0xffffffff); writeRect(p + 28, w.rect); return 1; }];
  U.SetWindowPlacement = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const r = readRect(c.arg(1) + 28); wm().setWindowPos(w, r.l, r.t, r.r - r.l, r.b - r.t, 4 | 0x10); wm().showWindow(w, mem.read32(c.arg(1) + 8)); return 1; }];
  const windowLong = (c, set, wide) => {
    const w = win(c.arg(0)); if (!w) return c.fail(E.INVALID_WINDOW_HANDLE);
    const idx = c.sarg(1), v = c.arg(2);
    const get = () => { switch (idx) { case -4: return typeof w.wndProc === 'number' ? w.wndProc : api.thunkFor('user32.dll', wide ? 'DefWindowProcW' : 'DefWindowProcA'); case -6: return w.hInstance; case -8: return w.owner ? w.owner.hwnd : (w.parent && !w.parent.desktop ? w.parent.hwnd : 0); case -12: return w.id; case -16: return w.style; case -20: return w.exStyle; case -21: return w.userData; default: return idx >= 0 && idx + 4 <= w.extra.byteLength ? w.extra.getUint32(idx, true) : 0; } };
    const old = get();
    if (set) { switch (idx) { case -4: w.wndProc = v; break; case -6: w.hInstance = v; break; case -8: w.owner = win(v); break; case -12: w.id = v; break; case -16: w.style = v; w.visible = (v & WS_VISIBLE) !== 0; wm().layout(w); break; case -20: w.exStyle = v; wm().layout(w); break; case -21: w.userData = v; break; default: if (idx >= 0 && idx + 4 <= w.extra.byteLength) w.extra.setUint32(idx, v, true); else vm.warn(`SetWindowLong: bad index ${idx}`); } }
    return old >>> 0;
  };
  U.GetWindowLongA = [2, (c) => windowLong(c, false, false)]; U.GetWindowLongW = [2, (c) => windowLong(c, false, true)];
  U.SetWindowLongA = [3, (c) => windowLong(c, true, false)]; U.SetWindowLongW = [3, (c) => windowLong(c, true, true)];
  U.GetWindowWord = [2, (c) => windowLong(c, false, false) & 0xffff];
  U.SetWindowWord = [3, (c) => windowLong(c, true, false) & 0xffff];
  U.SetWindowTextA = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; wm().send(w, WM.SETTEXT, 0, c.arg(1)); return 1; }];
  U.SetWindowTextW = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; w.title = c.wstr(1) ?? ''; return 1; }];
  U.GetWindowTextA = [3, (c) => { const w = win(c.arg(0)); if (!w) return 0; return wm().send(w, WM.GETTEXT, c.arg(2), c.arg(1)); }];
  U.GetWindowTextW = [3, (c) => { const w = win(c.arg(0)); if (!w || !c.arg(2)) return 0; const n = Math.min(w.title.length, c.arg(2) - 1); mem.writeWString(c.arg(1), w.title.slice(0, n)); return n; }];
  U.GetWindowTextLengthA = [1, (c) => { const w = win(c.arg(0)); return w ? w.title.length : 0; }];
  U.GetWindowTextLengthW = U.GetWindowTextLengthA;
  U.IsWindow = [1, (c) => (win(c.arg(0)) ? 1 : 0)];
  U.IsWindowVisible = [1, (c) => { let w = win(c.arg(0)); while (w && !w.desktop) { if (!w.visible) return 0; w = w.parent; } return w ? 1 : 0; }];
  U.IsWindowEnabled = [1, (c) => (win(c.arg(0))?.enabled ? 1 : 0)];
  U.EnableWindow = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const was = w.enabled; w.enabled = c.arg(1) !== 0; if (was !== w.enabled) wm().send(w, WM.ENABLE, w.enabled ? 1 : 0, 0); return was ? 0 : 1; }];
  U.IsIconic = [1, (c) => (win(c.arg(0))?.minimized ? 1 : 0)];
  U.IsZoomed = [1, (c) => (win(c.arg(0))?.maximized ? 1 : 0)];
  U.IsChild = [2, (c) => { let w = win(c.arg(1)); while (w && w.parent) { w = w.parent; if (w.hwnd === c.arg(0)) return 1; } return 0; }];
  U.GetParent = [1, (c) => { const w = win(c.arg(0)); if (!w) return 0; if (w.style & WS_CHILD) return w.parent && !w.parent.desktop ? w.parent.hwnd : 0; return w.owner ? w.owner.hwnd : 0; }];
  U.SetParent = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const np = c.arg(1) ? win(c.arg(1)) : wm().desktop; const old = w.parent; if (old) old.children = old.children.filter((x) => x !== w); w.parent = np; np.children.push(w); return old ? old.hwnd : 0; }];
  U.GetAncestor = [2, (c) => { let w = win(c.arg(0)); if (!w) return 0; const f = c.arg(1); if (f === 1) return w.parent && !w.parent.desktop ? w.parent.hwnd : wm().desktop.hwnd; while (w.parent && !w.parent.desktop) w = w.parent; if (f === 3 && w.owner) w = w.owner; return w.hwnd; }];
  U.GetDesktopWindow = [0, () => wm().desktop.hwnd];
  U.GetTopWindow = [1, (c) => { const w = c.arg(0) ? win(c.arg(0)) : wm().desktop; if (!w) return 0; const ch = w.desktop ? wm().zorder[0] : w.children[0]; return ch ? ch.hwnd : 0; }];
  U.GetWindow = [2, (c) => {
    const w = win(c.arg(0)); if (!w) return 0;
    const cmd = c.arg(1);
    const sib = w.parent && !w.parent.desktop ? w.parent.children : wm().zorder;
    const i = sib.indexOf(w);
    switch (cmd) { case 0: return sib[0]?.hwnd ?? 0; case 1: return sib[sib.length - 1]?.hwnd ?? 0; case 2: return sib[i + 1]?.hwnd ?? 0; case 3: return i > 0 ? sib[i - 1].hwnd : 0; case 4: return w.owner?.hwnd ?? 0; case 5: return w.children[0]?.hwnd ?? 0; default: return 0; }
  }];
  U.GetNextDlgTabItem = [3, (c) => c.arg(1)];
  U.GetWindowThreadProcessId = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; c.out32(1, c.proc.pid); return w.thread?.id ?? c.proc.threads[0].id; }];
  U.FindWindowA = [2, (c) => { const cls = c.str(0), title = c.str(1); for (const w of wm().zorder) if ((!cls || (w.cls?.name ?? '').toLowerCase() === cls.toLowerCase()) && (title === null || w.title === title)) return w.hwnd; return 0; }];
  U.FindWindowW = [2, (c) => { const cls = c.wstr(0), title = c.wstr(1); for (const w of wm().zorder) if ((!cls || (w.cls?.name ?? '').toLowerCase() === cls.toLowerCase()) && (title === null || w.title === title)) return w.hwnd; return 0; }];
  U.FindWindowExA = [4, (c) => { const cls = c.str(2), title = c.str(3); const parent = c.arg(0) ? win(c.arg(0)) : wm().desktop; const list = parent?.desktop ? wm().zorder : parent?.children ?? []; for (const w of list) if ((!cls || (w.cls?.name ?? '').toLowerCase() === cls.toLowerCase()) && (title === null || w.title === title)) return w.hwnd; return 0; }];
  U.EnumWindows = [2, (c) => { for (const w of [...wm().zorder]) if (!vm.callGuest(c.thread, c.arg(0), [w.hwnd, c.arg(1)])) break; return 1; }];
  U.EnumThreadWindows = [3, (c) => { for (const w of [...wm().zorder]) if (w.thread?.id === c.arg(0) && !vm.callGuest(c.thread, c.arg(1), [w.hwnd, c.arg(2)])) break; return 1; }];
  U.EnumChildWindows = [3, (c) => { const p = win(c.arg(0)); if (!p) return 0; const all = []; const walk = (w) => { for (const ch of w.children) { all.push(ch); walk(ch); } }; walk(p); for (const w of all) if (!vm.callGuest(c.thread, c.arg(1), [w.hwnd, c.arg(2)])) break; return 1; }];
  U.WindowFromPoint = [2, (c) => { const w = wm().windowAt(c.sarg(0), c.sarg(1)); return w ? w.hwnd : 0; }];
  U.ChildWindowFromPoint = [3, (c) => { const p = win(c.arg(0)); if (!p) return 0; const x = p.client.l + c.sarg(1), y = p.client.t + c.sarg(2); for (const ch of p.children) if (x >= ch.rect.l && x < ch.rect.r && y >= ch.rect.t && y < ch.rect.b) return ch.hwnd; return p.hwnd; }];
  U.ChildWindowFromPointEx = [4, (c) => U.ChildWindowFromPoint[1](c)];
  U.GetDlgItem = [2, (c) => { const p = win(c.arg(0)); if (!p) return 0; const walk = (w) => { for (const ch of w.children) { if (ch.id === c.arg(1)) return ch; const r = walk(ch); if (r) return r; } return null; }; const f = walk(p); return f ? f.hwnd : 0; }];
  U.GetDlgCtrlID = [1, (c) => win(c.arg(0))?.id ?? 0];
  U.AdjustWindowRect = [3, (c) => { const nc = wm().ncSizes(c.arg(1), 0); const r = readRect(c.arg(0)); writeRect(c.arg(0), { l: r.l - nc.l, t: r.t - nc.t - (c.arg(2) ? MENU_H : 0), r: r.r + nc.r, b: r.b + nc.b }); return 1; }];
  U.AdjustWindowRectEx = [4, (c) => { const nc = wm().ncSizes(c.arg(1), c.arg(3)); const r = readRect(c.arg(0)); writeRect(c.arg(0), { l: r.l - nc.l, t: r.t - nc.t - (c.arg(2) ? MENU_H : 0), r: r.r + nc.r, b: r.b + nc.b }); return 1; }];

  // ---------------------------------------------------------------- focus / activation / capture
  U.SetFocus = [1, (c) => { const w = c.arg(0) ? win(c.arg(0)) : null; if (c.arg(0) && !w) return 0; return wm().setFocus(w); }];
  U.GetFocus = [0, () => wm().focus];
  U.SetActiveWindow = [1, (c) => { const w = win(c.arg(0)); const prev = wm().active; if (w) wm().activate(w, true); return prev; }];
  U.GetActiveWindow = [0, () => wm().active];
  U.SetForegroundWindow = [1, (c) => { const w = win(c.arg(0)); if (!w) return 0; wm().activate(w, true); return 1; }];
  U.GetForegroundWindow = [0, () => wm().foreground || wm().active];
  U.BringWindowToTop = [1, (c) => { const w = win(c.arg(0)); if (!w) return 0; wm().activate(w, true); return 1; }];
  U.SetCapture = [1, (c) => { const prev = wm().capture; wm().capture = c.arg(0); return prev; }];
  U.ReleaseCapture = [0, () => { const w = win(wm().capture); wm().capture = 0; if (w) wm().send(w, WM.CAPTURECHANGED, 0, 0); return 1; }];
  U.GetCapture = [0, () => wm().capture];
  U.LockSetForegroundWindow = [1, () => 1];
  U.AllowSetForegroundWindow = [1, () => 1];
  U.GetLastActivePopup = [1, (c) => c.arg(0)];
  U.GetGUIThreadInfo = [2, (c) => { const p = c.arg(1); mem.write32(p + 4, 0); mem.write32(p + 8, wm().active); mem.write32(p + 12, wm().focus); mem.write32(p + 16, wm().capture); return 1; }];
  U.AnyPopup = [0, () => 0];
  U.FlashWindow = [2, () => 0];
  U.FlashWindowEx = [1, () => 0];

  // ---------------------------------------------------------------- messages
  const getMessage = (c, wide) => {
    const p = c.arg(0), hf = c.arg(1), min = c.arg(2), max = c.arg(3);
    const w = wm();
    let m = w.peek(c.thread, hf, min, max, true);
    if (!m) {
      w.present();
      vm.sched.block(c.thread, () => w.hasMessage(c.thread, hf, min, max), INFINITE, 'GetMessage');
      m = w.peek(c.thread, hf, min, max, true);
    }
    w.writeMsg(p, m);
    if (m.msg === WM.QUIT) return 0;
    return 1;
  };
  U.GetMessageA = [4, (c) => getMessage(c, false)];
  U.GetMessageW = [4, (c) => getMessage(c, true)];
  const peekMessage = (c) => {
    const p = c.arg(0), hf = c.arg(1), min = c.arg(2), max = c.arg(3), flags = c.arg(4);
    const w = wm();
    w.present();
    const m = w.peek(c.thread, hf, min, max, (flags & PM_REMOVE) !== 0);
    if (!m) { if (++w.idleSpins > 64) { w.idleSpins = 0; vm.sched.yieldFrom(c.thread); vm.clock.tick?.(0.1); } return 0; }
    w.idleSpins = 0;
    w.writeMsg(p, m);
    return 1;
  };
  U.PeekMessageA = [5, peekMessage];
  U.PeekMessageW = [5, peekMessage];
  U.TranslateMessage = [1, (c) => {
    const p = c.arg(0); const msg = mem.read32(p + 4);
    if (msg !== WM.KEYDOWN && msg !== WM.SYSKEYDOWN) return 0;
    const vk = mem.read32(p + 8), lParam = mem.read32(p + 12);
    // prefer the character the host attached to this key press (keyboard layout of the user), else the US mapping
    const pc = wm().pendingChars, i = pc ? pc.findIndex((e) => e.vk === vk) : -1;
    const ch = i >= 0 ? pc.splice(i, 1)[0].code : vkToChar(vk, wm().keyState);
    if (ch === null) return 0;
    const w = win(mem.read32(p));
    if (w) wm().post(w, msg === WM.SYSKEYDOWN ? WM.SYSCHAR : WM.CHAR, ch, lParam);
    return 1;
  }];
  // Message delivery to a guest window procedure is a guest-level call (D028, Vm.tailCallGuest): no JS frame
  // stays between the caller and the procedure, so a blocking wait inside the procedure can be parked.
  const guestProcOf = (w, msg) => (w && typeof w.wndProc === 'number' && !(w.destroyed && msg !== WM.NCDESTROY) ? w.wndProc : 0);
  U.DispatchMessageA = [1, (c) => {
    const p = c.arg(0);
    const m = { hwnd: mem.read32(p), msg: mem.read32(p + 4), wParam: mem.read32(p + 8), lParam: mem.read32(p + 12) };
    const w = wm();
    if (m.msg === WM.TIMER && m.lParam) return vm.tailCallGuest(c, m.lParam, [m.hwnd, WM.TIMER, m.wParam, w.tick()], { argBytes: 4 });
    const win_ = w.windows.get(m.hwnd), proc = guestProcOf(win_, m.msg);
    if (!proc) return w.dispatch(m);
    const after = m.msg === WM.PAINT ? () => { if (win_.invalid && !rectEmpty(win_.invalid)) win_.invalid = null; w.present(); } : null;
    return vm.tailCallGuest(c, proc, [win_.hwnd, m.msg, m.wParam, m.lParam], { argBytes: 4, after });
  }];
  U.DispatchMessageW = U.DispatchMessageA;
  const sendMessage = (c) => {
    const w = win(c.arg(0));
    if (!w) { if (c.arg(0) === 0xffff) { for (const x of [...wm().zorder]) wm().send(x, c.arg(1), c.arg(2), c.arg(3)); return 0; } return 0; }
    const proc = guestProcOf(w, c.arg(1));
    if (proc) return vm.tailCallGuest(c, proc, [w.hwnd, c.arg(1), c.arg(2), c.arg(3)], { argBytes: 16 });
    return wm().send(w, c.arg(1), c.arg(2), c.arg(3));
  };
  U.SendMessageA = [4, sendMessage]; U.SendMessageW = [4, sendMessage];
  U.SendMessageTimeoutA = [7, (c) => { const r = sendMessage(c); c.out32(6, r); return 1; }];
  U.SendMessageTimeoutW = U.SendMessageTimeoutA;
  U.SendNotifyMessageA = [4, sendMessage]; U.SendMessageCallbackA = [6, (c) => { sendMessage(c); return 1; }];
  U.SendDlgItemMessageA = [5, (c) => { const p = win(c.arg(0)); if (!p) return 0; const ch = p.children.find((x) => x.id === c.arg(1)); return ch ? wm().send(ch, c.arg(2), c.arg(3), c.arg(4)) : 0; }];
  const postMessage = (c) => { if (c.arg(0) === 0xffff) { for (const x of wm().zorder) wm().post(x, c.arg(1), c.arg(2), c.arg(3)); return 1; } const w = c.arg(0) ? win(c.arg(0)) : null; if (c.arg(0) && !w) return c.fail(E.INVALID_WINDOW_HANDLE); wm().post(w, c.arg(1), c.arg(2), c.arg(3), w ? null : c.thread); return 1; };
  U.PostMessageA = [4, postMessage]; U.PostMessageW = [4, postMessage];
  U.PostThreadMessageA = [4, (c) => { const t = c.proc.thread(c.arg(0)); if (!t) return c.fail(E.INVALID_PARAMETER); wm().post(null, c.arg(1), c.arg(2), c.arg(3), t); return 1; }];
  U.PostThreadMessageW = U.PostThreadMessageA;
  U.PostQuitMessage = [1, (c) => { wm().queueOf(c.thread).quit = c.arg(0); }];
  U.CallWindowProcA = [5, (c) => { const proc = c.arg(0); const w = win(c.arg(1)); if (!proc) return 0; const name = api.nameOf(proc); if (name) { if (!w) return 0; return wm().defWindowProc(w, c.arg(2), c.arg(3), c.arg(4)); } return vm.tailCallGuest(c, proc, [c.arg(1), c.arg(2), c.arg(3), c.arg(4)], { argBytes: 20 }); }];
  U.CallWindowProcW = U.CallWindowProcA;
  U.GetMessagePos = [0, () => ((wm().cursor.y & 0xffff) << 16 | (wm().cursor.x & 0xffff)) >>> 0];
  U.GetMessageTime = [0, () => wm().tick()];
  U.GetMessageExtraInfo = [0, () => 0];
  U.SetMessageExtraInfo = [1, () => 0];
  U.GetQueueStatus = [1, (c) => { const q = wm().queueOf(c.thread); wm().pump(); const any = q.msgs.length > 0 || wm().paintPending(c.thread, 0) || wm().dueTimer(c.thread, 0); return any ? 0x00ff00ff : 0; }];
  U.GetInputState = [0, (c) => { wm().pump(); return wm().queueOf(c.thread).msgs.some((m) => m.msg >= 0x100 && m.msg <= 0x20e) ? 1 : 0; }];
  U.WaitMessage = [0, (c) => { vm.sched.block(c.thread, () => wm().hasMessage(c.thread, 0, 0, 0), INFINITE, 'WaitMessage'); return 1; }];
  U.InSendMessage = [0, () => 0];
  U.ReplyMessage = [1, () => 1];
  U.RegisterWindowMessageA = [1, (c) => { const s = c.str(0) ?? ''; let a = [...c.proc.atoms].find(([, v]) => v === s)?.[0]; if (!a) { a = c.proc.nextAtom++; c.proc.atoms.set(a, s); } return a; }];
  U.RegisterWindowMessageW = [1, (c) => { const s = c.wstr(0) ?? ''; let a = [...c.proc.atoms].find(([, v]) => v === s)?.[0]; if (!a) { a = c.proc.nextAtom++; c.proc.atoms.set(a, s); } return a; }];
  U.MsgWaitForMultipleObjects = [5, (c) => {
    const n = c.arg(0), ph = c.arg(1), all = c.arg(2) !== 0, ms = c.arg(3);
    const objs = []; for (let i = 0; i < n; i++) { const o = waitObject(c, mem.read32(ph + 4 * i)); if (!o) return WAIT_FAILED; objs.push(o); }
    const t = c.thread;
    const ready = () => (n > 0 && (all ? objs.every((o) => isSignaled(o, t)) : objs.some((o) => isSignaled(o, t)))) || wm().hasMessage(t, 0, 0, 0);
    const claim = () => {
      const i = objs.findIndex((o) => isSignaled(o, t));
      if (i >= 0 && (!all || objs.every((o) => isSignaled(o, t)))) { if (all) objs.forEach((o) => consumeSignal(o, t)); else consumeSignal(objs[i], t); return WAIT_OBJECT_0 + (all ? 0 : i); }
      return WAIT_OBJECT_0 + n; // a message
    };
    const ok = vm.sched.block(t, ready, ms === INFINITE ? INFINITE : ms, 'MsgWait', claim);
    if (!ok) return WAIT_TIMEOUT;
    return t.wakeValue;
  }];
  U.MsgWaitForMultipleObjectsEx = [5, (c) => U.MsgWaitForMultipleObjects[1](c)];

  // ---------------------------------------------------------------- timers
  U.SetTimer = [4, (c) => {
    const w = c.arg(0) ? win(c.arg(0)) : null;
    if (c.arg(0) && !w) return 0;
    let id = c.arg(1);
    const elapse = Math.min(Math.max(c.arg(2), 10), 0x7fffffff);
    if (!w) id = wm().nextTimerId++;
    const timers = c.proc.timers;
    const existing = timers.find((t) => t.kind === 'wm' && t.hwnd === (w ? w.hwnd : 0) && t.id === id && (w || t.thread === c.thread));
    if (existing) { existing.elapse = elapse; existing.due = vm.clock.now() + elapse; existing.proc = c.arg(3); return id; }
    timers.push({ kind: 'wm', hwnd: w ? w.hwnd : 0, id, elapse, due: vm.clock.now() + elapse, proc: c.arg(3), thread: w ? w.thread : c.thread });
    return id;
  }];
  U.KillTimer = [2, (c) => { const before = c.proc.timers.length; c.proc.timers = c.proc.timers.filter((t) => !(t.kind === 'wm' && t.hwnd === c.arg(0) && t.id === c.arg(1))); return before !== c.proc.timers.length ? 1 : 0; }];

  // ---------------------------------------------------------------- input state
  U.GetKeyState = [1, (c) => { const s = wm().keyState[c.arg(0) & 0xff]; return ((s & 0x80 ? 0x8000 : 0) | (s & 1)) >>> 0; }];
  U.GetAsyncKeyState = [1, (c) => { wm().pump(); const s = wm().keyState[c.arg(0) & 0xff]; return (s & 0x80 ? 0x8000 : 0) >>> 0; }];
  U.GetKeyboardState = [1, (c) => { mem.writeBytes(c.arg(0), wm().keyState); return 1; }];
  U.SetKeyboardState = [1, (c) => { wm().keyState.set(mem.bytes(c.arg(0), 256)); return 1; }];
  U.GetCursorPos = [1, (c) => { const p = c.arg(0); mem.write32(p, wm().cursor.x); mem.write32(p + 4, wm().cursor.y); return 1; }];
  U.SetCursorPos = [2, (c) => { wm().cursor = { x: c.sarg(0), y: c.sarg(1) }; vm.host?.setCursorPos?.(c.sarg(0), c.sarg(1)); return 1; }];
  U.ClipCursor = [1, (c) => { wm().clip = c.arg(0) ? readRect(c.arg(0)) : null; return 1; }];
  U.GetClipCursor = [1, (c) => { writeRect(c.arg(0), wm().clip ?? { l: 0, t: 0, r: wm().screen.width, b: wm().screen.height }); return 1; }];
  U.ShowCursor = [1, (c) => { const w = wm(); w.showCursorCount += c.arg(0) ? 1 : -1; vm.host?.display?.showCursor?.(w.showCursorCount >= 0); return w.showCursorCount >>> 0; }];
  U.SetCursor = [1, (c) => {
    const p = wm().cursorHandle, h = c.arg(0);
    wm().cursorHandle = h;
    if (h !== p) { const o = h ? c.proc.handles.getAs(h, 'gdi') : null; if (o?.kind === 'cursor') vm.host?.display?.setCursor?.(o.image ? h : 'sys' + (o.id || 32512), o.image ?? null, o.id || 32512); else if (!h) vm.host?.display?.showCursor?.(false); }
    return p;
  }];
  U.GetCursor = [0, () => wm().cursorHandle];
  U.GetCursorInfo = [1, (c) => { const p = c.arg(0); mem.write32(p + 4, wm().showCursorCount >= 0 ? 1 : 0); mem.write32(p + 8, wm().cursorHandle); mem.write32(p + 12, wm().cursor.x); mem.write32(p + 16, wm().cursor.y); return 1; }];
  U.MapVirtualKeyA = [2, (c) => mapVirtualKey(c.arg(0), c.arg(1))];
  U.MapVirtualKeyW = U.MapVirtualKeyA;
  U.MapVirtualKeyExA = [3, (c) => mapVirtualKey(c.arg(0), c.arg(1))];
  U.ToAscii = [5, (c) => { const ch = vkToChar(c.arg(0), mem.bytes(c.arg(2), 256)); if (ch === null) return 0; mem.write16(c.arg(3), ch); return 1; }];
  U.ToAsciiEx = [6, (c) => U.ToAscii[1](c)];
  U.ToUnicode = [6, (c) => { const ch = vkToChar(c.arg(0), mem.bytes(c.arg(2), 256)); if (ch === null) return 0; mem.write16(c.arg(3), ch); return 1; }];
  U.ToUnicodeEx = [7, (c) => U.ToUnicode[1](c)];
  U.VkKeyScanA = [1, (c) => { const ch = c.arg(0) & 0xff; const s = String.fromCharCode(ch); if (/[a-z]/.test(s)) return s.toUpperCase().charCodeAt(0); if (/[A-Z]/.test(s)) return 0x100 | ch; if (/[0-9 ]/.test(s)) return ch; return 0xffff; }];
  U.VkKeyScanW = U.VkKeyScanA;
  U.GetKeyNameTextA = [3, (c) => { const vk = mapVirtualKey((c.arg(0) >> 16) & 0xff, 1); const s = vk >= 0x41 && vk <= 0x5a ? String.fromCharCode(vk) : `Key${vk}`; mem.writeCString(c.arg(1), s, c.arg(2)); return s.length; }];
  U.GetKeyboardLayout = [1, () => 0x04090409];
  U.GetKeyboardLayoutNameA = [1, (c) => { mem.writeCString(c.arg(0), '00000409'); return 1; }];
  U.GetKeyboardLayoutList = [2, (c) => { if (c.arg(0) && c.arg(1)) mem.write32(c.arg(1), 0x04090409); return 1; }];
  U.ActivateKeyboardLayout = [2, () => 0x04090409];
  U.LoadKeyboardLayoutA = [2, () => 0x04090409];
  U.GetKeyboardType = [1, (c) => [4, 0, 12][c.arg(0)] ?? 0];
  U.keybd_event = [4, (c) => { wm().inputEvent({ type: c.arg(2) & 2 ? 'keyup' : 'keydown', vk: c.arg(0), scan: c.arg(1) }); }];
  U.mouse_event = [5, (c) => { const f = c.arg(0); const w = wm(); let x = w.cursor.x, y = w.cursor.y; if (f & 1) { if (f & 0x8000) { x = c.sarg(1) * w.screen.width / 65536 | 0; y = c.sarg(2) * w.screen.height / 65536 | 0; } else { x += c.sarg(1); y += c.sarg(2); } w.inputEvent({ type: 'mousemove', x, y }); } if (f & 2) w.inputEvent({ type: 'mousedown', button: 0, x, y }); if (f & 4) w.inputEvent({ type: 'mouseup', button: 0, x, y }); if (f & 8) w.inputEvent({ type: 'mousedown', button: 1, x, y }); if (f & 0x10) w.inputEvent({ type: 'mouseup', button: 1, x, y }); }];
  U.SendInput = [3, (c) => { const n = c.arg(0); for (let i = 0; i < n; i++) { const p = c.arg(1) + i * c.arg(2); const t = mem.read32(p); if (t === 1) wm().inputEvent({ type: mem.read32(p + 12) & 2 ? 'keyup' : 'keydown', vk: mem.read16(p + 4), scan: mem.read16(p + 6) }); } return n; }];
  U.RegisterRawInputDevices = [3, () => 1];
  U.GetRawInputData = [5, (c) => { if (c.arg(2)) mem.write32(c.arg(3), 0); return 0; }];
  U.GetRawInputDeviceList = [3, (c) => { if (c.arg(1)) mem.write32(c.arg(1), 0); return 0; }];
  U.SetWindowsHookExA = [4, (c) => c.proc.handles.create({ type: 'hook', kind: c.arg(0), proc: c.arg(1) })];
  U.SetWindowsHookExW = U.SetWindowsHookExA;
  U.SetWindowsHookA = [2, (c) => c.proc.handles.create({ type: 'hook', kind: c.arg(0), proc: c.arg(1) })];
  U.UnhookWindowsHookEx = [1, (c) => { c.proc.handles.map.delete(c.arg(0)); return 1; }];
  U.UnhookWindowsHook = [2, () => 1];
  U.CallNextHookEx = [4, () => 0];
  U.TrackMouseEvent = [1, () => 1];
  U.GetDoubleClickTime = [0, () => 500];
  U.SetDoubleClickTime = [1, () => 1];
  U.SwapMouseButton = [1, () => 0];
  U.GetSystemMetrics = [1, (c) => systemMetric(wm(), c.arg(0))];
  U.SystemParametersInfoA = [4, (c) => systemParametersInfo(c, wm(), false)];
  U.SystemParametersInfoW = [4, (c) => systemParametersInfo(c, wm(), true)];
  U.GetSysColor = [1, (c) => { const v = wm().sysColor(c.arg(0)); return ((v & 0xff) << 16 | (v & 0xff00) | (v >> 16)) >>> 0; }];
  U.GetSysColorBrush = [1, (c) => c.proc.handles.create({ type: 'gdi', kind: 'brush', style: 0, color: wm().sysColor(c.arg(0)), stock: true })];
  U.SetSysColors = [3, () => 1];

  // ---------------------------------------------------------------- display modes
  U.EnumDisplaySettingsA = [3, (c) => enumDisplaySettings(c, wm(), false)];
  U.EnumDisplaySettingsW = [3, (c) => enumDisplaySettings(c, wm(), true)];
  U.EnumDisplaySettingsExA = [4, (c) => enumDisplaySettings(c, wm(), false)];
  U.EnumDisplaySettingsExW = [4, (c) => enumDisplaySettings(c, wm(), true)];
  U.ChangeDisplaySettingsA = [2, (c) => changeDisplaySettings(c, wm(), c.arg(0), c.arg(1))];
  U.ChangeDisplaySettingsW = U.ChangeDisplaySettingsA;
  U.ChangeDisplaySettingsExA = [5, (c) => changeDisplaySettings(c, wm(), c.arg(1), c.arg(2))];
  U.ChangeDisplaySettingsExW = U.ChangeDisplaySettingsExA;
  U.EnumDisplayDevicesA = [4, (c) => { if (c.arg(1) !== 0) return 0; const p = c.arg(2); mem.writeCString(p + 4, '\\\\.\\DISPLAY1', 32); mem.writeCString(p + 36, 'Orthros Display Adapter', 128); mem.write32(p + 164, 0x5); mem.writeCString(p + 168, 'PCI\\VEN_1234&DEV_5678', 128); mem.writeCString(p + 296, '', 128); return 1; }];
  U.EnumDisplayDevicesW = [4, (c) => { if (c.arg(1) !== 0) return 0; const p = c.arg(2); mem.writeWString(p + 4, '\\\\.\\DISPLAY1', 32); mem.writeWString(p + 68, 'Orthros Display Adapter', 128); mem.write32(p + 324, 0x5); mem.writeWString(p + 328, 'PCI\\VEN_1234&DEV_5678', 128); return 1; }];
  U.EnumDisplayMonitors = [4, (c) => { const r = c.proc.processHeap.alloc(16); writeRect(r, { l: 0, t: 0, r: wm().screen.width, b: wm().screen.height }); vm.callGuest(c.thread, c.arg(2), [1, c.arg(0), r, c.arg(3)]); c.proc.processHeap.free_(r); return 1; }];
  const monitorInfo = (c, wide) => { const p = c.arg(1); const cb = mem.read32(p); writeRect(p + 4, { l: 0, t: 0, r: wm().screen.width, b: wm().screen.height }); writeRect(p + 20, { l: 0, t: 0, r: wm().screen.width, b: wm().screen.height }); mem.write32(p + 36, 1); if (cb >= 72) { if (wide) mem.writeWString(p + 40, '\\\\.\\DISPLAY1', 32); else mem.writeCString(p + 40, '\\\\.\\DISPLAY1', 32); } return 1; };
  U.GetMonitorInfoA = [2, (c) => monitorInfo(c, false)];
  U.GetMonitorInfoW = [2, (c) => monitorInfo(c, true)];
  U.MonitorFromWindow = [2, () => 1]; U.MonitorFromPoint = [3, () => 1]; U.MonitorFromRect = [2, () => 1];

  // ---------------------------------------------------------------- resources: icons, cursors, strings, bitmaps
  const pseudoIcon = (c, kind, id) => c.proc.handles.create({ type: 'gdi', kind, id, stock: true });
  U.LoadIconA = [2, (c) => pseudoIcon(c, 'icon', c.arg(1))];
  U.LoadIconW = U.LoadIconA;
  U.LoadCursorA = [2, (c) => pseudoIcon(c, 'cursor', c.arg(1))];
  U.LoadCursorW = U.LoadCursorA;
  /** A cursor from a .cur/.ani file: its frames and animation (gfx/gdi/cursor.js), shown by the host on SetCursor. */
  const cursorFromFile = (c, name) => {
    if (!name) return c.fail(E.FILE_NOT_FOUND);
    const bytes = vm.vfs.readFile(c.proc.path(name));
    if (!bytes) return c.fail(E.FILE_NOT_FOUND);
    const image = parseCursorFile(bytes);
    if (!image) { vm.warn(`LoadCursorFromFile(${name}): unrecognized cursor file`); return pseudoIcon(c, 'cursor', 32512); }
    return c.proc.handles.create({ type: 'gdi', kind: 'cursor', id: 0, image, file: name });
  };
  U.LoadCursorFromFileA = [1, (c) => cursorFromFile(c, c.str(0))];
  U.LoadCursorFromFileW = [1, (c) => cursorFromFile(c, c.wstr(0))];
  U.CreateCursor = [7, (c) => pseudoIcon(c, 'cursor', 0)];
  U.CreateIcon = [7, (c) => pseudoIcon(c, 'icon', 0)];
  U.CreateIconIndirect = [1, (c) => pseudoIcon(c, 'icon', 0)];
  U.CreateIconFromResourceEx = [7, (c) => pseudoIcon(c, 'icon', 0)];
  U.CreateIconFromResource = [4, (c) => pseudoIcon(c, 'icon', 0)];
  U.LookupIconIdFromDirectoryEx = [5, () => 1];
  U.DestroyIcon = [1, (c) => { c.proc.handles.map.delete(c.arg(0)); return 1; }];
  U.DestroyCursor = U.DestroyIcon;
  U.CopyIcon = [1, (c) => c.arg(0)];
  U.GetIconInfo = [2, (c) => { const p = c.arg(1); mem.write32(p, 1); mem.write32(p + 4, 0); mem.write32(p + 8, 0); mem.write32(p + 12, 0); mem.write32(p + 16, 0); return 1; }];
  U.DrawIcon = [4, () => 1]; U.DrawIconEx = [9, () => 1];
  U.SetSystemCursor = [2, () => 1];
  U.LoadImageA = [6, (c) => loadImage(c, false)];
  U.LoadImageW = [6, (c) => loadImage(c, true)];
  U.LoadBitmapA = [2, (c) => loadBitmapRes(c, c.arg(0), c.arg(1) < 0x10000 ? c.arg(1) : mem.readCString(c.arg(1)))];
  U.LoadBitmapW = [2, (c) => loadBitmapRes(c, c.arg(0), c.arg(1) < 0x10000 ? c.arg(1) : mem.readWString(c.arg(1)))];
  function loadImage(c, wide) {
    const type = c.arg(2), flags = c.arg(5);
    if (flags & 0x10) { // LR_LOADFROMFILE
      const name = wide ? c.wstr(1) : c.str(1);
      if (type === 0) { const data = vm.vfs.readFile(c.proc.path(name ?? '')); if (data) return bitmapFromBmp(c, data); return 0; }
      if (type === 2) return cursorFromFile(c, name);
      return pseudoIcon(c, 'icon', 0);
    }
    if (type === 0) return loadBitmapRes(c, c.arg(0), c.arg(1) < 0x10000 ? c.arg(1) : wide ? mem.readWString(c.arg(1)) : mem.readCString(c.arg(1)));
    return pseudoIcon(c, type === 1 ? 'icon' : 'cursor', c.arg(1));
  }
  function loadBitmapRes(c, hinst, name) {
    const m = c.proc.moduleByHandle(hinst);
    if (!m || m.builtin) return pseudoIcon(c, 'bitmap-missing', 0);
    const r = findResource(m, mem, 2, name, -1);
    if (!r) return c.fail(E.RESOURCE_NAME_NOT_FOUND);
    const info = parseBitmapInfo(mem, r.addr, 0);
    const bits = r.addr + info.headerSize + info.colorsSize;
    const src = dibSurface(mem, bits, info);
    const s = allocSurface(c.proc, info.width, info.height, 'bitmap');
    blit(s, { l: 0, t: 0, r: info.width, b: info.height }, 0, 0, info.width, info.height, src, 0, 0);
    return c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: info.width, height: info.height, bpp: 32 });
  }
  function bitmapFromBmp(c, data) {
    const tmp = c.proc.vmem.alloc(data.length, 4, 'bmpfile'); mem.writeBytes(tmp, data);
    const off = mem.read32(tmp + 10);
    const info = parseBitmapInfo(mem, tmp + 14, 0);
    const src = dibSurface(mem, tmp + off, info);
    const s = allocSurface(c.proc, info.width, info.height, 'bitmap');
    blit(s, { l: 0, t: 0, r: info.width, b: info.height }, 0, 0, info.width, info.height, src, 0, 0);
    c.proc.vmem.release(tmp);
    return c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: info.width, height: info.height, bpp: 32 });
  }
  const loadString = (c, wide) => {
    const m = c.proc.moduleByHandle(c.arg(0)); const id = c.arg(1); const buf = c.arg(2), max = c.arg(3);
    let s = null;
    if (m && !m.builtin) {
      const r = findResource(m, mem, 6, (id >> 4) + 1, -1);
      if (r) { let p = r.addr; for (let i = 0; i < 16; i++) { const len = mem.read16(p); p += 2; if (i === (id & 15)) { s = mem.readWString(p, len).slice(0, len); break; } p += 2 * len; } }
    }
    if (s === null) { c.setLastError(E.RESOURCE_NAME_NOT_FOUND); if (max) { if (wide) mem.write16(buf, 0); else mem.write8(buf, 0); } return 0; }
    if (max === 0) { if (wide) { mem.write32(buf, 0); } return s.length; }
    const n = Math.min(s.length, max - 1);
    if (wide) mem.writeWString(buf, s.slice(0, n)); else mem.writeCString(buf, s.slice(0, n));
    return n;
  };
  U.LoadStringA = [4, (c) => loadString(c, false)];
  U.LoadStringW = [4, (c) => loadString(c, true)];
  U.LoadMenuA = [2, (c) => c.proc.handles.create({ type: 'menu', items: [] })];
  U.LoadMenuW = U.LoadMenuA;
  U.LoadAcceleratorsA = [2, (c) => c.proc.handles.create({ type: 'accel' })];
  U.LoadAcceleratorsW = U.LoadAcceleratorsA;
  U.TranslateAcceleratorA = [3, () => 0]; U.TranslateAcceleratorW = [3, () => 0];
  U.CreateAcceleratorTableA = [2, (c) => c.proc.handles.create({ type: 'accel' })];
  U.DestroyAcceleratorTable = [1, () => 1];

  // ---------------------------------------------------------------- menus (minimal)
  const menu = (c) => c.proc.handles.create({ type: 'menu', items: [] });
  U.CreateMenu = [0, menu]; U.CreatePopupMenu = [0, menu];
  U.DestroyMenu = [1, (c) => { c.proc.handles.map.delete(c.arg(0)); return 1; }];
  U.AppendMenuA = [4, (c) => { const m = c.proc.handles.getAs(c.arg(0), 'menu'); if (!m) return 0; m.items.push({ flags: c.arg(1), id: c.arg(2), text: c.arg(1) & 0x10 ? '' : c.str(3) ?? '' }); return 1; }];
  U.AppendMenuW = [4, (c) => { const m = c.proc.handles.getAs(c.arg(0), 'menu'); if (!m) return 0; m.items.push({ flags: c.arg(1), id: c.arg(2), text: '' }); return 1; }];
  U.InsertMenuA = [5, (c) => { const m = c.proc.handles.getAs(c.arg(0), 'menu'); if (!m) return 0; m.items.push({ flags: c.arg(2), id: c.arg(3), text: '' }); return 1; }];
  U.InsertMenuItemA = [4, () => 1]; U.SetMenuItemInfoA = [4, () => 1]; U.GetMenuItemInfoA = [4, () => 0];
  U.DeleteMenu = [3, () => 1]; U.RemoveMenu = [3, () => 1]; U.EnableMenuItem = [3, () => 0]; U.CheckMenuItem = [3, () => 0]; U.CheckMenuRadioItem = [5, () => 1];
  U.GetMenu = [1, (c) => win(c.arg(0))?.menu ?? 0];
  U.SetMenu = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; w.menu = c.arg(1); w.hasMenu = !!c.arg(1); wm().layout(w); return 1; }];
  U.GetSystemMenu = [2, (c) => menu(c)];
  U.GetSubMenu = [2, () => 0]; U.GetMenuItemCount = [1, (c) => c.proc.handles.getAs(c.arg(0), 'menu')?.items.length ?? -1]; U.GetMenuItemID = [2, () => 0xffffffff];
  U.GetMenuState = [3, () => 0xffffffff]; U.GetMenuStringA = [5, () => 0]; U.DrawMenuBar = [1, () => 1]; U.TrackPopupMenu = [7, () => 0]; U.TrackPopupMenuEx = [6, () => 0];
  U.SetMenuDefaultItem = [3, () => 1]; U.HiliteMenuItem = [4, () => 1]; U.ModifyMenuA = [5, () => 1]; U.IsMenu = [1, (c) => (c.proc.handles.getAs(c.arg(0), 'menu') ? 1 : 0)];

  // ---------------------------------------------------------------- dialogs / message boxes (stubs)
  const msgBox = (c, title, text, type) => {
    vm.log('warn', `MessageBox: [${title ?? ''}] ${text ?? ''}`);
    const r = vm.host?.messageBox?.(title ?? '', text ?? '', type);
    if (r !== undefined) return r;
    const t = type & 0xf;
    return t === 4 ? 6 : t === 3 ? 6 : t === 5 ? 4 : 1;
  };
  U.MessageBoxA = [4, (c) => msgBox(c, c.str(2), c.str(1), c.arg(3))];
  U.MessageBoxW = [4, (c) => msgBox(c, c.wstr(2), c.wstr(1), c.arg(3))];
  U.MessageBoxExA = [5, (c) => msgBox(c, c.str(2), c.str(1), c.arg(3))];
  U.MessageBoxIndirectA = [1, (c) => { const p = c.arg(0); return msgBox(c, mem.readCString(mem.read32(p + 16) || 0) || '', mem.readCString(mem.read32(p + 12)), mem.read32(p + 20)); }];
  U.MessageBeep = [1, () => 1];
  U.DialogBoxParamA = [5, (c) => { vm.warn('DialogBoxParam: dialogs unsupported'); return 0xffffffff; }];
  U.DialogBoxParamW = U.DialogBoxParamA; U.DialogBoxIndirectParamA = U.DialogBoxParamA;
  U.CreateDialogParamA = [5, (c) => { vm.warn('CreateDialogParam: dialogs unsupported'); return 0; }];
  U.CreateDialogParamW = U.CreateDialogParamA; U.CreateDialogIndirectParamA = U.CreateDialogParamA;
  U.EndDialog = [2, () => 1]; U.IsDialogMessageA = [2, () => 0]; U.IsDialogMessageW = [2, () => 0];
  U.GetDlgItemTextA = [4, (c) => { const p = win(c.arg(0)); const ch = p?.children.find((x) => x.id === c.arg(1)); if (!ch) return 0; mem.writeCString(c.arg(2), ch.title, c.arg(3)); return Math.min(ch.title.length, c.arg(3) - 1); }];
  U.SetDlgItemTextA = [3, (c) => { const p = win(c.arg(0)); const ch = p?.children.find((x) => x.id === c.arg(1)); if (!ch) return 0; ch.title = c.str(2) ?? ''; return 1; }];
  U.GetDlgItemInt = [4, (c) => { const p = win(c.arg(0)); const ch = p?.children.find((x) => x.id === c.arg(1)); if (c.arg(2)) mem.write32(c.arg(2), ch ? 1 : 0); return ch ? (parseInt(ch.title, 10) | 0) >>> 0 : 0; }];
  U.SetDlgItemInt = [4, (c) => { const p = win(c.arg(0)); const ch = p?.children.find((x) => x.id === c.arg(1)); if (ch) ch.title = String(c.arg(3) ? c.sarg(2) : c.arg(2)); return ch ? 1 : 0; }];
  U.CheckDlgButton = [3, () => 1]; U.IsDlgButtonChecked = [2, () => 0]; U.CheckRadioButton = [4, () => 1];
  U.GetDialogBaseUnits = [0, () => (16 << 16) | 8];
  U.SetDlgItemText = U.SetDlgItemTextA;

  // ---------------------------------------------------------------- drawing helpers
  const dcOf = (c, h) => { const o = c.proc.handles.getAs(h, 'gdi'); return o && o.kind === 'dc' ? o : null; };
  U.FillRect = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const r = readRect(c.arg(1)); const col = wm().brushColor(c.arg(2)); if (col === null) return 1; const ox = dc.ox + dc.vpOrg.x - dc.wndOrg.x, oy = dc.oy + dc.vpOrg.y - dc.wndOrg.y; fillRect(dc.surface, dc.clip, r.l + ox, r.t + oy, r.r + ox, r.b + oy, col); if (dc.window) wm().touch(dc.window); return 1; }];
  U.FrameRect = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const r = readRect(c.arg(1)); const col = wm().brushColor(c.arg(2)); if (col === null) return 1; const ox = dc.ox, oy = dc.oy; fillRect(dc.surface, dc.clip, r.l + ox, r.t + oy, r.r + ox, r.t + oy + 1, col); fillRect(dc.surface, dc.clip, r.l + ox, r.b + oy - 1, r.r + ox, r.b + oy, col); fillRect(dc.surface, dc.clip, r.l + ox, r.t + oy, r.l + ox + 1, r.b + oy, col); fillRect(dc.surface, dc.clip, r.r + ox - 1, r.t + oy, r.r + ox, r.b + oy, col); if (dc.window) wm().touch(dc.window); return 1; }];
  U.InvertRect = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const r = readRect(c.arg(1)); for (let y = r.t; y < r.b; y++) for (let x = r.l; x < r.r; x++) { const X = x + dc.ox, Y = y + dc.oy; if (X >= dc.clip.l && X < dc.clip.r && Y >= dc.clip.t && Y < dc.clip.b) dc.surface.setPixel(X, Y, ~dc.surface.getPixel(X, Y) & 0xffffff); } return 1; }];
  U.DrawEdge = [4, () => 1]; U.DrawFrameControl = [4, () => 1]; U.DrawFocusRect = [2, () => 1]; U.DrawStateA = [10, () => 1];
  /**
   * DrawText(Ex): lines split on CR/LF (or one line with DT_SINGLELINE), word wrapping (DT_WORDBREAK), '&' mnemonic
   * prefixes (unless DT_NOPREFIX), tab expansion, horizontal and single-line vertical alignment, DT_CALCRECT, clipping
   * to the rectangle unless DT_NOCLIP. Returns the text height (the offset of its bottom with DT_VCENTER/DT_BOTTOM).
   */
  const drawTextA = (c, wide) => {
    const dc = dcOf(c, c.arg(0)); if (!dc) return 0;
    const n = c.sarg(2); let s = wide ? (n < 0 ? mem.readWString(c.arg(1)) : mem.readWStringN(c.arg(1), n)) : (n < 0 ? mem.readCString(c.arg(1)) : mem.readCStringN(c.arg(1), n));
    const r = readRect(c.arg(3)); const fmt = c.arg(4);
    const { engine, font } = dcFont(vm, c.proc, dc);
    const width = (t) => engine.extent(font, t, dc.charExtra ?? 0).w;
    if (!(fmt & 0x800)) s = s.replace(/&(&?)/g, (m, amp) => amp); // DT_NOPREFIX clear: "&x" -> "x", "&&" -> "&"
    if (fmt & 0x40) { const tab = font.aveCharWidth * 8 || 64; s = s.split(/(\r\n|\n|\r)/).map((line) => { let out = ''; for (const ch of line) { if (ch === '\t') { const w = width(out); const next = (Math.floor(w / tab) + 1) * tab; while (width(out) < next) out += ' '; } else out += ch; } return out; }).join(''); }
    let lines = fmt & 0x20 ? [s.replace(/\r\n|\n|\r/g, ' ')] : s.split(/\r\n|\n|\r/);
    const boxW = r.r - r.l;
    if ((fmt & 0x10) && !(fmt & 0x20)) { // DT_WORDBREAK: greedy wrap at spaces, words wider than the box on their own line
      const wrapped = [];
      for (const line of lines) {
        const words = line.split(/( +)/); let cur = '';
        for (const w of words) {
          if (!w) continue;
          const tryLine = cur + w;
          if (cur && width(tryLine.replace(/ +$/, '')) > boxW && /\S/.test(w)) { wrapped.push(cur.replace(/ +$/, '')); cur = w; }
          else cur = tryLine;
        }
        wrapped.push(cur.replace(/ +$/, ''));
      }
      lines = wrapped;
    }
    const lh = font.height + (fmt & 0x200 ? font.externalLeading : 0);
    const totalH = lines.length * lh;
    const widths = lines.map(width), maxW = Math.max(0, ...widths);
    if (fmt & 0x400) { writeRect(c.arg(3), { l: r.l, t: r.t, r: (fmt & 0x20) || (fmt & 0x10) ? r.l + maxW : r.l + maxW, b: r.t + totalH }); return totalH; }
    let y = r.t;
    if ((fmt & 0x20) && (fmt & 0x4)) y = r.t + ((r.b - r.t - lh) >> 1);
    else if ((fmt & 0x20) && (fmt & 0x8)) y = r.b - lh;
    const ox = dc.ox + dc.vpOrg.x - dc.wndOrg.x, oy = dc.oy + dc.vpOrg.y - dc.wndOrg.y;
    const clip = fmt & 0x100 ? dc.clip : clipRect(dc.clip, { l: r.l + ox, t: r.t + oy, r: r.r + ox, b: r.b + oy });
    const top = y;
    lines.forEach((line, i) => {
      let x = r.l;
      if (fmt & 1) x = r.l + ((boxW - widths[i]) >> 1); else if (fmt & 2) x = r.r - widths[i];
      if (dc.surface) engine.draw(dc.surface, clip, x + ox, y + oy, line, font, dc.textColor, engine.advances(font, line, dc.charExtra ?? 0), dc.bkMode === 2 ? dc.bkColor : null);
      y += lh;
    });
    if (dc.window) wm().touch(dc.window);
    return (fmt & 0xc) && (fmt & 0x20) ? y - r.t : y - top;
  };
  U.DrawTextA = [5, (c) => drawTextA(c, false)];
  U.DrawTextW = [5, (c) => drawTextA(c, true)];
  U.DrawTextExA = [6, (c) => drawTextA(c, false)];
  U.DrawTextExW = [6, (c) => drawTextA(c, true)];
  const tabbed = (c, dc, s) => { const { engine, font } = dcFont(vm, c.proc, dc); const tab = font.aveCharWidth * 8 || 64; let out = ''; for (const ch of s) { if (ch === '\t') { const w = engine.extent(font, out).w; const next = (Math.floor(w / tab) + 1) * tab; while (engine.extent(font, out).w < next) out += ' '; } else out += ch; } return { engine, font, text: out }; };
  U.TabbedTextOutA = [8, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const { engine, font, text } = tabbed(c, dc, mem.readCStringN(c.arg(3), c.arg(4))); const ox = dc.ox + dc.vpOrg.x - dc.wndOrg.x, oy = dc.oy + dc.vpOrg.y - dc.wndOrg.y; const adv = engine.advances(font, text); if (dc.surface) engine.draw(dc.surface, dc.clip, c.sarg(1) + ox, c.sarg(2) + oy, text, font, dc.textColor, adv, dc.bkMode === 2 ? dc.bkColor : null); if (dc.window) wm().touch(dc.window); return ((font.height & 0xffff) << 16) | (engine.extent(font, text).w & 0xffff); }];
  U.GetTabbedTextExtentA = [5, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const { engine, font, text } = tabbed(c, dc, mem.readCStringN(c.arg(1), c.arg(2))); return ((font.height & 0xffff) << 16) | (engine.extent(font, text).w & 0xffff); }];

  // ---------------------------------------------------------------- rects / misc
  U.SetRect = [5, (c) => { writeRect(c.arg(0), { l: c.sarg(1), t: c.sarg(2), r: c.sarg(3), b: c.sarg(4) }); return 1; }];
  U.SetRectEmpty = [1, (c) => { writeRect(c.arg(0), { l: 0, t: 0, r: 0, b: 0 }); return 1; }];
  U.CopyRect = [2, (c) => { writeRect(c.arg(0), readRect(c.arg(1))); return 1; }];
  U.IsRectEmpty = [1, (c) => (rectEmpty(readRect(c.arg(0))) ? 1 : 0)];
  U.EqualRect = [2, (c) => { const a = readRect(c.arg(0)), b = readRect(c.arg(1)); return a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b ? 1 : 0; }];
  U.PtInRect = [3, (c) => { const r = readRect(c.arg(0)); const x = c.sarg(1), y = c.sarg(2); return x >= r.l && x < r.r && y >= r.t && y < r.b ? 1 : 0; }];
  U.OffsetRect = [3, (c) => { const r = readRect(c.arg(0)); writeRect(c.arg(0), { l: r.l + c.sarg(1), t: r.t + c.sarg(2), r: r.r + c.sarg(1), b: r.b + c.sarg(2) }); return 1; }];
  U.InflateRect = [3, (c) => { const r = readRect(c.arg(0)); writeRect(c.arg(0), { l: r.l - c.sarg(1), t: r.t - c.sarg(2), r: r.r + c.sarg(1), b: r.b + c.sarg(2) }); return 1; }];
  U.IntersectRect = [3, (c) => { const r = clipRect(readRect(c.arg(1)), readRect(c.arg(2))); if (rectEmpty(r)) { writeRect(c.arg(0), { l: 0, t: 0, r: 0, b: 0 }); return 0; } writeRect(c.arg(0), r); return 1; }];
  U.UnionRect = [3, (c) => { const a = readRect(c.arg(1)), b = readRect(c.arg(2)); const ea = rectEmpty(a), eb = rectEmpty(b); const r = ea ? b : eb ? a : { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) }; writeRect(c.arg(0), r); return rectEmpty(r) ? 0 : 1; }];
  U.SubtractRect = [3, (c) => { writeRect(c.arg(0), readRect(c.arg(1))); return 1; }];
  U.wsprintfA = [0, (c) => { const s = formatPrintf(c, mem.readCString(c.arg(1)), c.sp + 12); mem.writeCString(c.arg(0), s, 1024); return Math.min(s.length, 1023); }, { cc: CC_CDECL }];
  U.wsprintfW = [0, (c) => { const s = formatPrintf(c, mem.readWString(c.arg(1)), c.sp + 12, { wide: true }); mem.writeWString(c.arg(0), s, 1024); return Math.min(s.length, 1023); }, { cc: CC_CDECL }];
  U.wvsprintfA = [3, (c) => { const s = formatPrintf(c, mem.readCString(c.arg(1)), c.arg(2)); mem.writeCString(c.arg(0), s, 1024); return Math.min(s.length, 1023); }];
  U.wvsprintfW = [3, (c) => { const s = formatPrintf(c, mem.readWString(c.arg(1)), c.arg(2), { wide: true }); mem.writeWString(c.arg(0), s, 1024); return Math.min(s.length, 1023); }];
  U.CharUpperA = [1, (c) => { const a = c.arg(0); if (a < 0x10000) return encodeString(caseMap(decodeBytes(Uint8Array.of(a & 0xff)), true, 0)).bytes[0]; mem.writeBytes(a, encodeString(caseMap(decodeBytes(mem.bytes(a, mem.readCString(a).length)), true, 0)).bytes); return a; }];
  U.CharLowerA = [1, (c) => { const a = c.arg(0); if (a < 0x10000) return encodeString(caseMap(decodeBytes(Uint8Array.of(a & 0xff)), false, 0)).bytes[0]; mem.writeBytes(a, encodeString(caseMap(decodeBytes(mem.bytes(a, mem.readCString(a).length)), false, 0)).bytes); return a; }];
  U.CharUpperW = [1, (c) => { const a = c.arg(0); if (a < 0x10000) return caseMap(String.fromCharCode(a), true).charCodeAt(0); mem.writeWString(a, caseMap(mem.readWString(a), true)); return a; }];
  U.CharLowerW = [1, (c) => { const a = c.arg(0); if (a < 0x10000) return caseMap(String.fromCharCode(a), false).charCodeAt(0); mem.writeWString(a, caseMap(mem.readWString(a), false)); return a; }];
  U.CharUpperBuffA = [2, (c) => { const n = c.arg(1); mem.writeBytes(c.arg(0), encodeString(caseMap(decodeBytes(mem.bytes(c.arg(0), n)), true, 0)).bytes); return n; }];
  U.CharLowerBuffA = [2, (c) => { const n = c.arg(1); mem.writeBytes(c.arg(0), encodeString(caseMap(decodeBytes(mem.bytes(c.arg(0), n)), false, 0)).bytes); return n; }];
  U.CharNextA = [1, (c) => (mem.read8(c.arg(0)) ? c.arg(0) + 1 : c.arg(0))];
  U.CharPrevA = [2, (c) => (c.arg(1) > c.arg(0) ? c.arg(1) - 1 : c.arg(0))];
  U.CharNextW = [1, (c) => (mem.read16(c.arg(0)) ? c.arg(0) + 2 : c.arg(0))];
  U.CharToOemA = [2, (c) => { mem.writeCString(c.arg(1), mem.readCString(c.arg(0))); return 1; }];
  U.OemToCharA = [2, (c) => { mem.writeCString(c.arg(1), mem.readCString(c.arg(0))); return 1; }];
  U.CharToOemBuffA = [3, (c) => { mem.copy(c.arg(1), c.arg(0), c.arg(2)); return 1; }];
  U.OemToCharBuffA = [3, (c) => { mem.copy(c.arg(1), c.arg(0), c.arg(2)); return 1; }];
  U.IsCharAlphaA = [1, (c) => (/\p{L}/u.test(String.fromCharCode(c.arg(0) & 0xff)) ? 1 : 0)];
  U.IsCharAlphaNumericA = [1, (c) => (/[\p{L}\p{N}]/u.test(String.fromCharCode(c.arg(0) & 0xff)) ? 1 : 0)];
  U.IsCharUpperA = [1, (c) => (/\p{Lu}/u.test(String.fromCharCode(c.arg(0) & 0xff)) ? 1 : 0)];
  U.IsCharLowerA = [1, (c) => (/\p{Ll}/u.test(String.fromCharCode(c.arg(0) & 0xff)) ? 1 : 0)];
  U.GetProcessWindowStation = [0, () => 0x100];
  U.GetUserObjectInformationA = [5, (c) => { if (c.arg(1) === 1) { const p = c.arg(2); if (c.arg(3) >= 12) { mem.write32(p, 1); mem.write32(p + 4, 0); mem.write32(p + 8, 1); } c.out32(4, 12); return 1; } return 0; }];
  U.GetUserObjectInformationW = U.GetUserObjectInformationA;
  U.GetThreadDesktop = [1, () => 0x104];
  U.OpenInputDesktop = [3, () => 0x104];
  U.CloseDesktop = [1, () => 1];
  U.SetProcessDPIAware = [0, () => 1];
  U.ExitWindowsEx = [2, () => 1];
  U.SetLayeredWindowAttributes = [4, () => 1];
  U.UpdateLayeredWindow = [9, () => 1];
  U.GetLayeredWindowAttributes = [4, () => 0];
  U.PrintWindow = [3, () => 0];
  U.GetPriorityClipboardFormat = [2, () => 0xffffffff];
  U.OpenClipboard = [1, () => 1]; U.CloseClipboard = [0, () => 1]; U.EmptyClipboard = [0, () => 1];
  U.GetClipboardData = [1, () => 0]; U.SetClipboardData = [2, (c) => c.arg(1)]; U.IsClipboardFormatAvailable = [1, () => 0];
  U.RegisterClipboardFormatA = [1, (c) => 0xc200]; U.GetClipboardOwner = [0, () => 0]; U.CountClipboardFormats = [0, () => 0];
  U.SetWindowRgn = [3, () => 1]; U.GetWindowRgn = [2, () => 0];
  U.GetScrollPos = [2, () => 0]; U.SetScrollPos = [4, () => 0]; U.GetScrollRange = [4, () => 1]; U.SetScrollRange = [5, () => 1]; U.SetScrollInfo = [4, () => 0]; U.GetScrollInfo = [3, () => 0]; U.ShowScrollBar = [3, () => 1]; U.EnableScrollBar = [3, () => 1];
  U.ScrollWindow = [5, () => 1]; U.ScrollWindowEx = [8, () => 0]; U.ScrollDC = [7, () => 1];
  U.CreateCaret = [4, () => 1]; U.DestroyCaret = [0, () => 1]; U.ShowCaret = [1, () => 1]; U.HideCaret = [1, () => 1]; U.SetCaretPos = [2, () => 1]; U.GetCaretBlinkTime = [0, () => 500]; U.SetCaretBlinkTime = [1, () => 1];
  U.SetPropA = [3, (c) => { const w = win(c.arg(0)); if (!w) return 0; w.props.set(c.arg(1) < 0x10000 ? c.arg(1) : mem.readCString(c.arg(1)).toLowerCase(), c.arg(2)); return 1; }];
  U.GetPropA = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; return w.props.get(c.arg(1) < 0x10000 ? c.arg(1) : mem.readCString(c.arg(1)).toLowerCase()) ?? 0; }];
  U.RemovePropA = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const k = c.arg(1) < 0x10000 ? c.arg(1) : mem.readCString(c.arg(1)).toLowerCase(); const v = w.props.get(k) ?? 0; w.props.delete(k); return v; }];
  U.SetPropW = [3, (c) => { const w = win(c.arg(0)); if (!w) return 0; w.props.set(c.arg(1) < 0x10000 ? c.arg(1) : mem.readWString(c.arg(1)).toLowerCase(), c.arg(2)); return 1; }];
  U.GetPropW = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; return w.props.get(c.arg(1) < 0x10000 ? c.arg(1) : mem.readWString(c.arg(1)).toLowerCase()) ?? 0; }];
  U.RemovePropW = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const k = c.arg(1) < 0x10000 ? c.arg(1) : mem.readWString(c.arg(1)).toLowerCase(); const v = w.props.get(k) ?? 0; w.props.delete(k); return v; }];
  U.SetWindowContextHelpId = [2, () => 1];
  U.GetWindowInfo = [2, (c) => { const w = win(c.arg(0)); if (!w) return 0; const p = c.arg(1); writeRect(p + 4, w.rect); writeRect(p + 20, w.client); mem.write32(p + 36, w.style); mem.write32(p + 40, w.exStyle); mem.write32(p + 44, wm().active === w.hwnd ? 1 : 0); mem.write32(p + 48, 4); mem.write32(p + 52, 4); mem.write16(p + 56, w.cls?.atom ?? 0); mem.write16(p + 58, 0x500); return 1; }];
  U.GetWindowModuleFileNameA = [3, (c) => { const s = c.proc.exePath; mem.writeCString(c.arg(1), s, c.arg(2)); return Math.min(s.length, c.arg(2) - 1); }];
  U.GetClassWord = [2, (c) => classLong(c, false) & 0xffff];
  U.GetShellWindow = [0, () => 0];
  U.GetComboBoxInfo = [2, () => 0];
  U.NotifyWinEvent = [4, () => {}];
  U.SetWinEventHook = [7, () => 1]; U.UnhookWinEvent = [1, () => 1];
  U.BlockInput = [1, () => 1];
  U.GetLastInputInfo = [1, (c) => { mem.write32(c.arg(0) + 4, wm().tick()); return 1; }];
  U.DefRawInputProc = [3, () => 0];
  U.ChangeClipboardChain = [2, () => 1]; U.SetClipboardViewer = [1, () => 0];
  U.SetWindowsHookW = U.SetWindowsHookA;
  U.GetSystemMenu = [2, (c) => menu(c)];
  U.CreateMDIWindowA = [10, () => 0];
  U.TileWindows = [5, () => 0]; U.CascadeWindows = [5, () => 0];
  U.SetTimerQueueTimer = [7, () => 0];
  U.IsWindowUnicode = [1, () => 0];
  U.IsHungAppWindow = [1, () => 0];
  U.GetWindowLongPtrA = U.GetWindowLongA; U.SetWindowLongPtrA = U.SetWindowLongA;

  api.define('user32.dll', U);
}

// ---------------------------------------------------------------- helpers
function systemMetric(wm, i) {
  const s = wm.screen;
  switch (i) {
    case 0: case 16: case 78: return s.width; case 1: case 79: return s.height; case 17: return s.height - 30;
    case 2: case 3: case 20: case 21: return 16; case 4: return CAPTION_H; case 5: case 6: return 1; case 7: case 8: return 3;
    case 9: case 10: return 16; case 11: case 12: case 13: case 14: return 32; case 15: return MENU_H; case 19: return 1;
    case 28: return 112; case 29: return 27; case 30: case 31: return 18; case 32: case 33: return FRAME_THICK; case 34: return 112; case 35: return 27;
    case 36: case 37: return 4; case 38: case 39: return 75; case 43: return 3; case 45: case 46: return 2; case 49: case 50: return 16; case 51: return 15;
    case 52: case 53: return 13; case 54: case 55: return 18; case 57: return 160; case 58: return 24; case 59: return s.width + 12; case 60: return s.height + 12;
    case 61: return s.width + 8; case 62: return s.height + 8; case 68: case 69: return 4; case 71: case 72: return 13; case 75: return 1; case 80: return 1; case 81: return 1;
    case 76: case 77: return 0; case 0x1000: return 0; case 4096: return 0;
    default: return 0;
  }
}

function systemParametersInfo(c, wm, wide) {
  const mem = c.mem;
  const action = c.arg(0), pv = c.arg(2);
  switch (action) {
    case 0x30: if (pv) { mem.write32(pv, 0); mem.write32(pv + 4, 0); mem.write32(pv + 8, wm.screen.width); mem.write32(pv + 12, wm.screen.height); } return 1; // SPI_GETWORKAREA
    case 0x10: if (pv) mem.write32(pv, 0); return 1; // SPI_GETSCREENSAVEACTIVE
    case 0x11: return 1;
    case 0x29: { // SPI_GETNONCLIENTMETRICS
      if (!pv) return 0;
      const size = mem.read32(pv);
      mem.fill(pv + 4, Math.max(size - 4, 0), 0);
      mem.write32(pv + 4, 1); mem.write32(pv + 8, 4); mem.write32(pv + 12, 18); mem.write32(pv + 16, 18);
      const lf = (off, h) => { mem.write32(off, -h); mem.write32(off + 16, 400); if (wide) mem.writeWString(off + 28, 'Tahoma', 32); else mem.writeCString(off + 28, 'Tahoma', 32); };
      const lfSize = wide ? 92 : 60;
      lf(pv + 20, 11); mem.write32(pv + 20 + lfSize, 13); mem.write32(pv + 24 + lfSize, 13); lf(pv + 28 + lfSize, 11); mem.write32(pv + 28 + 2 * lfSize, 18); mem.write32(pv + 32 + 2 * lfSize, 18); lf(pv + 36 + 2 * lfSize, 11); lf(pv + 36 + 3 * lfSize, 11); lf(pv + 36 + 4 * lfSize, 11);
      return 1;
    }
    case 0x03: if (pv) { mem.write32(pv, 6); mem.write32(pv + 4, 10); mem.write32(pv + 8, 1); } return 1; // SPI_GETMOUSE
    case 0x04: return 1;
    case 0x70: if (pv) mem.write32(pv, 10); return 1; // SPI_GETMOUSESPEED
    case 0x71: return 1;
    case 0x68: if (pv) mem.write32(pv, 3); return 1; // SPI_GETWHEELSCROLLLINES
    case 0x16: if (pv) mem.write32(pv, 1); return 1; // SPI_GETKEYBOARDDELAY
    case 0x0a: if (pv) mem.write32(pv, 31); return 1; // SPI_GETKEYBOARDSPEED
    case 0x01: if (pv) mem.write32(pv, 1); return 1; // SPI_GETBEEP
    case 0x3a: case 0x3c: case 0x36: case 0x32: case 0x34: case 0x38: case 0x3e: case 0x40: case 0x42: case 0x44: case 0x46: case 0x48: case 0x4a: case 0x4c: // accessibility (STICKYKEYS etc.)
      if (pv) { const cb = mem.read32(pv); mem.fill(pv + 4, Math.max(cb - 4, 0), 0); }
      return 1;
    case 0x3b: case 0x3d: case 0x37: case 0x33: case 0x35: case 0x39: case 0x3f: case 0x41: case 0x43: case 0x45: case 0x47: case 0x49: case 0x4b: case 0x4d: return 1;
    case 0x1004: if (pv) mem.write32(pv, 0); return 1; // SPI_GETFONTSMOOTHING? (0x4a) approximate
    case 0x4a: if (pv) mem.write32(pv, 1); return 1;
    case 0x0d: return 1; // SPI_SETDESKWALLPAPER
    case 0x5e: case 0x5f: return 1;
    case 0x73: if (pv) { mem.write32(pv, 0); } return 1; // SPI_GETFOREGROUNDLOCKTIMEOUT
    case 0x2000: if (pv) mem.write32(pv, 0); return 1; // SPI_GETFOREGROUNDLOCKTIMEOUT (alt)
    case 0x2001: return 1;
    case 0x1012: if (pv) mem.write32(pv, 0); return 1;
    default: c.vm.warn(`SystemParametersInfo: unhandled action 0x${action.toString(16)}`); return 1;
  }
}

function mapVirtualKey(code, type) {
  const scanOf = (vk) => { if (vk >= 0x41 && vk <= 0x5a) return [0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c][vk - 0x41]; if (vk >= 0x30 && vk <= 0x39) return vk === 0x30 ? 0x0b : vk - 0x30 + 1; const t = { 0x1b: 1, 0x08: 0x0e, 0x09: 0x0f, 0x0d: 0x1c, 0x10: 0x2a, 0x11: 0x1d, 0x12: 0x38, 0x20: 0x39, 0x25: 0x4b, 0x26: 0x48, 0x27: 0x4d, 0x28: 0x50, 0x70: 0x3b, 0x71: 0x3c, 0x72: 0x3d, 0x73: 0x3e, 0x74: 0x3f, 0x75: 0x40, 0x76: 0x41, 0x77: 0x42, 0x78: 0x43, 0x79: 0x44, 0x7a: 0x57, 0x7b: 0x58, 0xa0: 0x2a, 0xa1: 0x36, 0xa2: 0x1d, 0xa3: 0x1d, 0xa4: 0x38, 0xa5: 0x38 }; return t[vk] ?? 0; };
  switch (type) {
    case 0: case 4: return scanOf(code);
    case 1: case 3: { for (let vk = 0; vk < 256; vk++) if (scanOf(vk) === code) return vk; return 0; }
    case 2: { const ch = vkToChar(code, new Uint8Array(256)); return ch ?? 0; }
    default: return 0;
  }
}

const SHIFTED = { 0x30: ')', 0x31: '!', 0x32: '@', 0x33: '#', 0x34: '$', 0x35: '%', 0x36: '^', 0x37: '&', 0x38: '*', 0x39: '(', 0xba: ':', 0xbb: '+', 0xbc: '<', 0xbd: '_', 0xbe: '>', 0xbf: '?', 0xc0: '~', 0xdb: '{', 0xdc: '|', 0xdd: '}', 0xde: '"' };
const UNSHIFTED = { 0xba: ';', 0xbb: '=', 0xbc: ',', 0xbd: '-', 0xbe: '.', 0xbf: '/', 0xc0: '`', 0xdb: '[', 0xdc: '\\', 0xdd: ']', 0xde: "'" };
function vkToChar(vk, keyState) {
  const shift = (keyState[0x10] & 0x80) !== 0, ctrl = (keyState[0x11] & 0x80) !== 0, caps = (keyState[0x14] & 1) !== 0;
  if (vk >= 0x41 && vk <= 0x5a) { if (ctrl) return vk - 0x40; const up = shift !== caps; return up ? vk : vk + 32; }
  if (vk >= 0x30 && vk <= 0x39) return shift ? SHIFTED[vk].charCodeAt(0) : vk;
  if (vk === 0x20) return 32; if (vk === 0x0d) return 13; if (vk === 0x08) return 8; if (vk === 0x09) return 9; if (vk === 0x1b) return 27;
  if (vk >= 0x60 && vk <= 0x69) return vk - 0x60 + 48;
  if (vk === 0x6a) return 42; if (vk === 0x6b) return 43; if (vk === 0x6d) return 45; if (vk === 0x6e) return 46; if (vk === 0x6f) return 47;
  if (SHIFTED[vk]) return (shift ? SHIFTED[vk] : UNSHIFTED[vk]).charCodeAt(0);
  return null;
}

function enumDisplaySettings(c, wm, wide) {
  const mem = c.mem;
  const i = c.arg(1) >>> 0, p = c.arg(2);
  const modes = [];
  for (const [w, h] of wm.host?.display?.modes ?? [[640, 480], [800, 600], [1024, 768], [1280, 720], [1280, 1024], [1600, 1200], [1920, 1080]]) for (const bpp of [16, 32]) modes.push([w, h, bpp]);
  let m;
  if (i === 0xffffffff || i === 0xfffffffe) m = [wm.screen.width, wm.screen.height, wm.screen.bpp];
  else if (i < modes.length) m = modes[i];
  else return 0;
  const nameLen = wide ? 64 : 32;
  const off = (o) => p + o + (wide ? nameLen - 32 : 0);
  mem.write16(p + nameLen, 0x401); mem.write16(p + nameLen + 2, 0x401); mem.write16(p + nameLen + 4, wide ? 220 : 156); mem.write16(p + nameLen + 6, 0);
  mem.write32(p + nameLen + 8, 0x40000 | 0x80000 | 0x100000 | 0x400000);
  const base = p + nameLen + 8 + 4 + 16 + 2 * 5 + (wide ? 64 : 32) + 2; // dmLogPixels position
  void base; void off;
  const bppOff = wide ? 168 : 104;
  mem.write32(p + bppOff, m[2]); mem.write32(p + bppOff + 4, m[0]); mem.write32(p + bppOff + 8, m[1]); mem.write32(p + bppOff + 12, 0); mem.write32(p + bppOff + 16, 60);
  return 1;
}

function changeDisplaySettings(c, wm, devmode, flags) {
  const mem = c.mem;
  if (!devmode) { wm.setDisplayMode(0, 0, 32, false); return 0; } // restore the default mode
  const size = mem.read16(devmode + 36);
  const wide = size >= 200;
  const bppOff = wide ? 168 : 104;
  const fields = mem.read32(devmode + (wide ? 72 : 40));
  const bpp = fields & 0x40000 ? mem.read32(devmode + bppOff) : wm.screen.bpp;
  const w = fields & 0x80000 ? mem.read32(devmode + bppOff + 4) : wm.screen.width;
  const h = fields & 0x100000 ? mem.read32(devmode + bppOff + 8) : wm.screen.height;
  if (flags & 2) return 0; // CDS_TEST
  c.vm.log('win', `ChangeDisplaySettings ${w}x${h}x${bpp} flags=${flags.toString(16)}`);
  wm.setDisplayMode(w, h, bpp, (flags & 4) !== 0);
  return 0;
}

export { vkToChar };
