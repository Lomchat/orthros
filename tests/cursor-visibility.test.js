// The system cursor's visibility, as Windows decides it, for every game alike (user32.js WindowManager.updateCursor,
// dinput8.js, the page's cursorView in src/host/web/pointer.js): ShowCursor's display count (shown at >= 0, 0 at start),
// SetCursor's shape (NULL: no cursor until the next SetCursor), WM_SETCURSOR sent at each mouse move over a window
// (DefWindowProc: the class cursor in the client area — none: the application sets it —, the arrow or a sizing cursor
// on the frame; not sent while the mouse is captured), an exclusive DirectInput mouse hiding it while acquired. The page
// shows that cursor and no other: none when it is hidden (a game drawing its own sprite), captured or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Ctx } from '../src/win32/ctx.js';
import { writeGuid } from '../src/win32/com.js';
import { wmOf } from '../src/win32/user32.js';
import { cursorView } from '../src/host/web/pointer.js';

const EXE = new URL('../build/pe/hello.exe', import.meta.url).pathname;
const skip = !fs.existsSync(EXE) && 'build/pe/hello.exe missing (make pe-tests)';

function boot() {
  const vfs = new Vfs(); const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', t);
  t.open('hello.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new VirtualClock(Date.UTC(2026, 0, 1));
  const host = new HeadlessHost({ clock, width: 640, height: 480 });
  const vm = new Vm({ vfs, clock, host, logKinds: [] });
  vm.createProcess({ exePath: 'C:\\Test\\hello.exe' });
  // what the host is told: the shape (its key) and whether the cursor shows
  let shape = null, vis = true;
  host.display.setCursor = (key) => { shape = key; };
  host.display.showCursor = (v) => { vis = v; };
  const mem = vm.mem, heap = vm.proc.processHeap, frame = heap.alloc(64, true), scratch = heap.alloc(0x100, true);
  const ctx = (...args) => {
    args.forEach((a, i) => mem.write32(frame + 4 + 4 * i, a >>> 0));
    const c = new Ctx(vm); c.thread = vm.proc.threads[0]; c.cpu = c.thread.cpu; c.sp = frame; return c;
  };
  const call = (dll, name, ...args) => { const r = vm.api.lookup(dll, name).fn(ctx(...args)); return r === undefined ? r : r >>> 0; };
  const user = (name, ...args) => call('user32.dll', name, ...args);
  const wm = wmOf(vm);
  return { vm, mem, heap, scratch, ctx, call, user, wm, host, visible: () => vis, shape: () => shape };
}

/** A top-level window of a class with cursor `hCursor` (DefWindowProc as its window procedure), the front one. */
function window(env, hCursor, style = 0x10000000 /* WS_VISIBLE */, rect = [0, 0, 640, 480]) {
  const { vm, wm } = env;
  const cls = { name: 'test', wndProc: 'builtin', style: 0, cbClsExtra: 0, cbWndExtra: 0, hInstance: 0, hIcon: 0, hCursor, hbrBackground: 0, menuName: 0, extra: new DataView(new ArrayBuffer(4)) };
  const w = wm.makeWindow({ cls, style, exStyle: 0, x: rect[0], y: rect[1], w: rect[2], h: rect[3], parent: wm.desktop, title: 'game' });
  w.thread = vm.proc.threads[0]; wm.zorder.unshift(w); wm.active = w.hwnd; wm.focus = w.hwnd;
  return w;
}
/** Host mouse input pumped, then the window thread's GetMessage / PeekMessage delivering what it was sent. */
function move(env, x, y) {
  const { host, wm, vm } = env;
  host.inputQueue.push({ type: 'mousemove', x, y });
  wm.pump();
  wm.deliverSent(vm.proc.threads[0]);
}

test('ShowCursor: a display count, shown at >= 0, 0 at start (a mouse is installed)', { skip }, () => {
  const env = boot(), { user, visible } = env;
  assert.equal(user('GetCursor'), user('LoadCursorA', 0, 32512), 'the arrow at start, the shared system handle');
  assert.equal(user('ShowCursor', 0) | 0, -1); assert.equal(visible(), false);
  assert.equal(user('ShowCursor', 0) | 0, -2);
  assert.equal(user('ShowCursor', 1) | 0, -1); assert.equal(visible(), false, 'two hides need two shows');
  assert.equal(user('ShowCursor', 1) | 0, 0); assert.equal(visible(), true);
  assert.equal(user('ShowCursor', 1) | 0, 1); assert.equal(user('ShowCursor', 0) | 0, 0); assert.equal(visible(), true);
  const p = env.scratch; env.mem.write32(p, 20);
  user('ShowCursor', 0); user('GetCursorInfo', p); assert.equal(env.mem.read32(p + 4), 0, 'CURSOR_SHOWING clear');
  user('ShowCursor', 1); user('GetCursorInfo', p); assert.equal(env.mem.read32(p + 4), 1);
});

test('SetCursor: NULL removes the cursor until the next shape; returns the previous one', { skip }, () => {
  const env = boot(), { user, visible } = env;
  const arrow = user('LoadCursorA', 0, 32512), wait = user('LoadCursorA', 0, 32514);
  assert.equal(user('LoadCursorA', 0, 32514), wait, 'a system cursor is one shared handle');
  assert.equal(user('SetCursor', wait), arrow);
  assert.equal(env.shape(), 'sys32514');
  assert.equal(user('SetCursor', 0), wait); assert.equal(visible(), false);
  assert.equal(user('GetCursor'), 0);
  user('SetCursor', arrow); assert.equal(visible(), true);
  user('DestroyCursor', arrow); assert.equal(user('SetCursor', arrow), arrow, 'a shared cursor is not destroyed');
});

test('WM_SETCURSOR: the class cursor in the client area at each mouse move, none: the application chooses', { skip }, () => {
  const env = boot(), { user, visible } = env;
  const wait = user('LoadCursorA', 0, 32514), cross = user('LoadCursorA', 0, 32515);
  const w = window(env, wait);
  move(env, 100, 100);
  assert.equal(user('GetCursor'), wait, 'DefWindowProc set the class cursor');
  // the application removes it (a game drawing its own sprite)... the next move over the window sets the class one again
  user('SetCursor', 0); assert.equal(visible(), false);
  move(env, 110, 100); assert.equal(visible(), true, 'as on Windows: a class cursor comes back at the next move');
  // SetClassLong(GCL_HCURSOR) changes it; a class without a cursor leaves the shape to the application
  user('SetClassLongA', w.hwnd, -12 >>> 0, cross);
  move(env, 120, 100); assert.equal(user('GetCursor'), cross);
  user('SetClassLongA', w.hwnd, -12 >>> 0, 0);
  user('SetCursor', 0);
  move(env, 130, 100); assert.equal(user('GetCursor'), 0, 'no class cursor: stays as the application set it');
  assert.equal(visible(), false);
  // the mouse captured (SetCapture): no WM_SETCURSOR
  user('SetClassLongA', w.hwnd, -12 >>> 0, wait);
  user('SetCapture', w.hwnd);
  move(env, 140, 100); assert.equal(user('GetCursor'), 0, 'captured: not sent');
  user('ReleaseCapture');
  move(env, 150, 100); assert.equal(user('GetCursor'), wait);
});

test('WM_SETCURSOR: the frame takes the arrow or a sizing cursor; outside any window the desktop arrow', { skip }, () => {
  const env = boot(), { user } = env;
  const wait = user('LoadCursorA', 0, 32514);
  const w = window(env, wait, 0x10000000 | 0x00c00000 | 0x00040000 /* WS_VISIBLE | WS_CAPTION | WS_THICKFRAME */, [50, 50, 300, 200]);
  move(env, 150, 52); // the top resizing edge
  assert.equal(user('GetCursor'), user('LoadCursorA', 0, 32645), 'IDC_SIZENS');
  move(env, w.rect.l + 1, 150);
  assert.equal(user('GetCursor'), user('LoadCursorA', 0, 32644), 'IDC_SIZEWE');
  move(env, 150, w.client.t - 3); // the caption
  assert.equal(user('GetCursor'), user('LoadCursorA', 0, 32512));
  move(env, w.client.l + 10, w.client.t + 10);
  assert.equal(user('GetCursor'), wait, 'the client area');
  move(env, 500, 400);
  assert.equal(user('GetCursor'), user('LoadCursorA', 0, 32512), 'the desktop');
});

test('WM_SETCURSOR sent by host input while the window thread waits: one pending per window, the latest', { skip }, () => {
  const env = boot(), { host, wm, vm, user } = env;
  const w = window(env, user('LoadCursorA', 0, 32514));
  const cur = vm.current; vm.current = null; // (pumped by a wait condition: no thread runs)
  for (let i = 0; i < 300; i++) host.inputQueue.push({ type: 'mousemove', x: 10 + (i % 50), y: 10 });
  host.inputQueue.push({ type: 'focus', focused: false });
  wm.pump();
  vm.current = cur;
  const sent = wm.queueOf(vm.proc.threads[0]).sent;
  assert.equal(sent.filter((s) => s.msg === 0x20).length, 1, 'the mouse moves did not fill the queue');
  assert.ok(sent.some((s) => s.fn), 'the focus change kept');
  wm.deliverSent(vm.proc.threads[0]);
  assert.equal(user('GetCursor'), w.cls.hCursor);
});

test('WM_SETCURSOR sent synchronously: a handler reading the mouse (GetCursorPos) does not re-process the input', { skip }, async () => {
  const env = boot(), { host, wm, vm, user, scratch } = env;
  const { TS } = await import('../src/win32/process.js');
  window(env, 0);
  const th = vm.proc.threads[0]; vm.current = th; th.state = TS.RUNNING; // (the window's thread pumps: sends run at once)
  let calls = 0; const def = wm.defWindowProc.bind(wm);
  wm.defWindowProc = (w, msg, a, b) => {
    if (msg !== 0x20) return def(w, msg, a, b);
    if (++calls > 10) throw new Error('WM_SETCURSOR re-entered');
    user('GetCursorPos', scratch); user('GetAsyncKeyState', 1); user('ShowCursor', 0); return 1;
  };
  host.inputQueue.push({ type: 'mousemove', x: 10, y: 10 }, { type: 'mousemove', x: 20, y: 10 }, { type: 'mousemove', x: 30, y: 12 });
  wm.pump();
  assert.equal(calls, 3, 'one WM_SETCURSOR per move');
  assert.equal(wm.mouseStats.moves, 3, 'each move processed once');
  assert.equal(env.mem.read32(scratch), 30);
  assert.equal(env.visible(), false);
});

/** A DirectInput 8 system mouse with the cooperative level `coop`. */
function diMouse(env, coop) {
  const { vm, mem, heap, call, ctx, scratch } = env;
  const iid = heap.alloc(16, true); writeGuid(mem, iid, 'bf798030-483a-4da2-aa99-5d64ed369700');
  assert.equal(call('dinput8.dll', 'DirectInput8Create', 0x400000, 0x800, iid, scratch, 0), 0);
  const diPtr = mem.read32(scratch), di = vm.com.implAt(diPtr);
  const guid = heap.alloc(16, true); writeGuid(mem, guid, '6f1d2b60-d5a0-11cf-bfc7-444553540000');
  assert.equal(di.CreateDevice(ctx(diPtr, guid, scratch + 4, 0)), 0);
  const devPtr = mem.read32(scratch + 4), dev = vm.com.implAt(devPtr);
  const fmt = heap.alloc(24, true); mem.write32(fmt, 24); mem.write32(fmt + 4, 16); mem.write32(fmt + 8, 2); mem.write32(fmt + 12, 16);
  assert.equal(dev.SetDataFormat(ctx(devPtr, fmt)), 0);
  assert.equal(dev.SetCooperativeLevel(ctx(devPtr, 0, coop)), 0);
  return { acquire: () => dev.Acquire(ctx(devPtr)), unacquire: () => dev.Unacquire(ctx(devPtr)), destroy: () => dev.destroy() };
}

test('DirectInput: an exclusive mouse hides the cursor while acquired; a non-exclusive one does not', { skip }, () => {
  const env = boot(), { visible, user } = env;
  const shared = diMouse(env, 2 | 4); // DISCL_NONEXCLUSIVE | DISCL_FOREGROUND
  shared.acquire(); assert.equal(visible(), true);
  shared.unacquire();
  const excl = diMouse(env, 1 | 4); // DISCL_EXCLUSIVE | DISCL_FOREGROUND
  excl.acquire(); assert.equal(visible(), false);
  user('ShowCursor', 1); assert.equal(visible(), false, 'whatever the display count');
  user('ShowCursor', 0);
  excl.unacquire(); assert.equal(visible(), true, 'unacquire restores it');
  excl.acquire(); assert.equal(visible(), false);
  env.host.inputQueue.push({ type: 'focus', focused: false }); env.wm.pump();
  assert.equal(visible(), true, 'the application deactivated (alt-tab): shown over its window');
  env.host.inputQueue.push({ type: 'focus', focused: true }); env.wm.pump();
  assert.equal(visible(), false, 'back in the foreground, still acquired: hidden again');
  excl.unacquire();
  excl.acquire(); assert.equal(visible(), false);
  excl.destroy(); assert.equal(visible(), true, 'released while acquired: restored');
  // the display count and DirectInput are independent: shown only when neither hides it
  user('ShowCursor', 0); excl.acquire(); excl.unacquire();
  assert.equal(visible(), false, 'still hidden by the display count');
});

test('the page: one cursor at most — the guest\'s, none when it is hidden, captured or not', () => {
  assert.deepEqual(cursorView(false, false), { css: 'none', soft: false }, 'hidden, free pointer: no CSS cursor (the game\'s sprite only)');
  assert.deepEqual(cursorView(false, true), { css: 'none', soft: false }, 'hidden, captured: no soft cursor');
  assert.deepEqual(cursorView(true, false), { css: 'guest', soft: false }, 'shown, free pointer: the guest\'s shape as CSS cursor');
  assert.deepEqual(cursorView(true, true), { css: 'none', soft: true }, 'shown, captured: the soft cursor only');
  assert.deepEqual(cursorView(undefined, false), { css: 'guest', soft: false }, 'before the worker said: the arrow, as at start');
});
