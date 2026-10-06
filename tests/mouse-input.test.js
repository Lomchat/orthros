// The mouse, the same for every game: the page's captured (pointer lock) and free pointer (src/host/web/pointer.js),
// the input ring's encoding (browser-host.js decodeInput), and the window manager / DirectInput side (user32.js,
// dinput8.js) — relative motion reaching DirectInput unclamped, the guest cursor moved from where it is (SetCursorPos
// warps of a mouse-look camera), kept in the screen and the ClipCursor rectangle; host input processed in a wait
// condition (no guest thread running) without running guest code there: its sent messages (WM_ACTIVATEAPP...) are
// delivered by the window's thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PointerInput, winButton } from '../src/host/web/pointer.js';
import { EV, BUTTON_AT_CURSOR, decodeInput } from '../src/host/browser-host.js';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Ctx } from '../src/win32/ctx.js';
import { writeGuid } from '../src/win32/com.js';
import { wmOf } from '../src/win32/user32.js';

/** a PointerInput writing into an array as the ring would, decoded as the worker decodes it */
function page(w = 640, h = 480) {
  const ring = [];
  const p = new PointerInput((type, a, b, c) => ring.push(decodeInput(type | 0, a | 0, b | 0, c | 0)), () => ({ width: w, height: h }));
  return { p, ring };
}

test('captured mouse: device counts unclamped, the cursor motion in screen pixels with fractions carried', () => {
  const { p, ring } = page();
  p.lockedMove(5, -3, 2); // (2 CSS pixels per screen pixel)
  p.lockedMove(5, -3, 2);
  assert.deepEqual(ring.map((e) => [e.dx, e.dy, e.gdx, e.gdy, e.rel]), [[5, -3, 2, -1, true], [5, -3, 3, -2, true]], '2.5 + 2.5 = 5 pixels; -1.5 - 1.5 = -3');
  assert.deepEqual(ring.map((e) => e.seq), [1, 2]);
  // a big flick: the device counts as they are (a mouse-look camera turns by all of it), nothing clamped to the screen
  p.lockedMove(4000, 0, 1);
  assert.equal(ring[2].dx, 4000); assert.equal(ring[2].gdx, 4000);
  assert.equal(p.vx, 639, 'the drawn cursor stops at the screen edge');
  p.lockedMove(0, 0, 1); assert.equal(ring.length, 3, 'no motion: nothing sent');
});

test('captured mouse: the drawn cursor follows the worker (warps) plus the moves not yet taken', () => {
  const { p } = page();
  p.lockedMove(10, 10, 1); p.lockedMove(10, 10, 1); p.lockedMove(10, 10, 1); // seq 1..3
  p.cursorReport(320, 240, 1); // the game warped to the center after taking move 1: moves 2 and 3 still on the way
  assert.deepEqual([p.vx, p.vy], [340, 260]);
  p.cursorReport(320, 240, 3);
  assert.deepEqual([p.vx, p.vy], [320, 240], 'all taken: the guest cursor itself');
  assert.equal(p.pending.length, 0);
  // sequence numbers wrap at 24 bits
  p.seq = 0xfffffe; p.lockedMove(1, 0, 1); p.lockedMove(1, 0, 1);
  assert.deepEqual(p.pending.map((x) => x.seq), [0xffffff, 0]);
  p.cursorReport(100, 100, 0xffffff); assert.deepEqual(p.pending.map((x) => x.seq), [0]); assert.equal(p.vx, 101);
});

test('free pointer: positions clamped to the screen, motion only while over the game', () => {
  const { p, ring } = page();
  p.freeMove(100, 100); // entering: no motion
  p.freeMove(110, 95);
  p.freeMove(700, 95); // into the page's margin: at the edge, no motion
  p.freeMove(-50, 95);
  p.freeMove(20, 95); // back over the game elsewhere: no jump
  p.freeMove(25, 95);
  assert.deepEqual(ring.map((e) => [e.x, e.y, e.dx, e.dy]), [[100, 100, 0, 0], [110, 95, 10, -5], [639, 95, 0, 0], [0, 95, 0, 0], [20, 95, 0, 0], [25, 95, 5, 0]]);
  p.left(); p.freeMove(300, 300);
  assert.deepEqual([ring[6].dx, ring[6].dy], [0, 0], 'after leaving the window: no motion on the way back');
});

test('buttons: captured ones press where the guest cursor is', () => {
  const { p, ring } = page();
  p.button(true, winButton(2), true);
  p.button(false, 0, false, 700, -4);
  assert.deepEqual(ring[0], { type: 'mousedown', button: 1, x: 0, y: 0, rel: true });
  assert.deepEqual(ring[1], { type: 'mouseup', button: 0, x: 639, y: 0 });
  assert.equal(decodeInput(EV.MOUSEDOWN, 2 | BUTTON_AT_CURSOR, 5, 6).button, 2);
});

// ---------------------------------------------------------------- the worker side, through the API handlers
const EXE = new URL('../build/pe/hello.exe', import.meta.url).pathname;
const skip = !fs.existsSync(EXE) && 'build/pe/hello.exe missing (make pe-tests)';

function boot() {
  const vfs = new Vfs(); const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', t);
  t.open('hello.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new VirtualClock(Date.UTC(2026, 0, 1));
  const host = new HeadlessHost({ clock, width: 640, height: 480 });
  const reports = []; host.cursorPos = (x, y, seq) => reports.push([x, y, seq]);
  const vm = new Vm({ vfs, clock, host, logKinds: [] });
  vm.createProcess({ exePath: 'C:\\Test\\hello.exe' });
  const mem = vm.mem, heap = vm.proc.processHeap, scratch = heap.alloc(0x1000, true), frame = heap.alloc(64, true);
  const ctx = (...args) => {
    args.forEach((a, i) => mem.write32(frame + 4 + 4 * i, a >>> 0));
    const c = new Ctx(vm); c.thread = vm.proc.threads[0]; c.cpu = c.thread.cpu; c.sp = frame; return c;
  };
  const call = (dll, name, ...args) => { const r = vm.api.lookup(dll, name).fn(ctx(...args)); return r === undefined ? r : r >>> 0; };
  const wm = wmOf(vm);
  const input = (...evs) => host.inputQueue.push(...evs);
  const cursor = () => { call('user32.dll', 'GetCursorPos', scratch + 0x800); return [mem.readS32(scratch + 0x800), mem.readS32(scratch + 0x804)]; };
  return { vm, mem, heap, scratch, call, ctx, wm, host, input, cursor, reports };
}
const rel = (dx, dy, seq, gdx = dx, gdy = dy) => ({ type: 'mousemove', rel: true, dx, dy, gdx, gdy, seq });

/** A DirectInput 8 system mouse, acquired, with a buffer of `buffer` events. */
function diMouse(env, buffer = 64) {
  const { vm, mem, heap, call, ctx, scratch } = env;
  const iid = heap.alloc(16, true); writeGuid(mem, iid, 'bf798030-483a-4da2-aa99-5d64ed369700');
  assert.equal(call('dinput8.dll', 'DirectInput8Create', 0x400000, 0x800, iid, scratch, 0), 0);
  const diPtr = mem.read32(scratch), di = vm.com.implAt(diPtr);
  const guid = heap.alloc(16, true); writeGuid(mem, guid, '6f1d2b60-d5a0-11cf-bfc7-444553540000');
  assert.equal(di.CreateDevice(ctx(diPtr, guid, scratch + 4, 0)), 0);
  const devPtr = mem.read32(scratch + 4), dev = vm.com.implAt(devPtr);
  const fmt = heap.alloc(24, true); mem.write32(fmt, 24); mem.write32(fmt + 4, 16); mem.write32(fmt + 8, 2 /* DIDF_RELAXIS */); mem.write32(fmt + 12, 16);
  assert.equal(dev.SetDataFormat(ctx(devPtr, fmt)), 0);
  const prop = heap.alloc(20, true); mem.write32(prop, 20); mem.write32(prop + 4, 16); mem.write32(prop + 12, 0); mem.write32(prop + 16, buffer);
  assert.equal(dev.SetProperty(ctx(devPtr, 1 /* DIPROP_BUFFERSIZE */, prop)), 0);
  assert.equal(dev.Acquire(ctx(devPtr)), 0);
  const st = heap.alloc(16, true), data = heap.alloc(16 * 64, true), n = heap.alloc(4, true);
  return {
    state: () => { assert.equal(dev.GetDeviceState(ctx(devPtr, 16, st)), 0); return [mem.readS32(st), mem.readS32(st + 4), mem.read8(st + 12)]; },
    data: () => { mem.write32(n, 64); assert.equal(dev.GetDeviceData(ctx(devPtr, 16, data, n, 0)), 0); return Array.from({ length: mem.read32(n) }, (_, i) => [mem.read32(data + 16 * i), mem.readS32(data + 16 * i + 4)]); },
  };
}

test('DirectInput relative mouse: captured motion unclamped, at the screen edge too, read without a message loop', { skip }, () => {
  const env = boot(), m = diMouse(env);
  // the cursor at the right edge: the motion goes on for the relative axes (a camera keeps turning), the cursor stays
  env.input(rel(400, 0, 1), rel(400, 0, 2), rel(400, 5, 3));
  assert.deepEqual(m.state(), [1200, 5, 0], 'GetDeviceState takes the pending input itself: no PeekMessage needed');
  assert.deepEqual(env.cursor(), [639, 245]);
  assert.deepEqual(m.state(), [0, 0, 0], 'relative: since the last read');
  env.input(rel(-3, 2, 4), { type: 'mousedown', button: 0, rel: true }, { type: 'mouseup', button: 0, rel: true });
  assert.deepEqual(m.data(), [[0, 400], [0, 400], [0, 400], [4, 5], [0, -3], [4, 2], [12, 0x80], [12, 0]], 'buffered: X, Y, button 0 down and up — relative too');
  assert.deepEqual(env.cursor(), [636, 247], 'the buttons at the guest cursor');
});

test('SetCursorPos mouse-look: the motion since the warp, exactly, every frame; ClipCursor keeps the cursor in', { skip }, () => {
  const env = boot(), { call, cursor, scratch, mem, reports } = env;
  let yaw = 0;
  for (let frame = 0; frame < 20; frame++) {
    call('user32.dll', 'SetCursorPos', 320, 240);
    env.input(rel(7, 1, frame + 1)); // the player turns right steadily
    const [x, y] = cursor();
    yaw += x - 320;
    assert.deepEqual([x, y], [327, 241], `frame ${frame}: the move from the warped position`);
  }
  assert.equal(yaw, 140, 'turned continuously, never stuck at an edge');
  assert.deepEqual(reports.at(-1), [327, 241, 20], 'the page told where the cursor is after its move 20');
  // ClipCursor: the cursor inside the rectangle, moved into it at once
  mem.write32(scratch, 100); mem.write32(scratch + 4, 100); mem.write32(scratch + 8, 200); mem.write32(scratch + 12, 150);
  call('user32.dll', 'ClipCursor', scratch);
  assert.deepEqual(cursor(), [199, 149]);
  env.input(rel(-500, -500, 21));
  assert.deepEqual(cursor(), [100, 100]);
  call('user32.dll', 'SetCursorPos', 0, 0);
  assert.deepEqual(cursor(), [100, 100], 'SetCursorPos inside the clip rectangle');
  env.input({ type: 'mousemove', x: 600, y: 10, dx: 0, dy: 0 });
  assert.deepEqual(cursor(), [199, 100], 'an absolute position too');
  call('user32.dll', 'ClipCursor', 0);
  env.input(rel(300, 300, 22));
  assert.deepEqual(cursor(), [499, 400], 'no clip: the screen only');
});

test('host input in a wait condition: sent messages delivered by the window thread, not run there', { skip }, () => {
  const env = boot(), { vm, wm, mem, heap, call, scratch } = env;
  // a window procedure recording the messages it gets: [rec] count, then the message numbers
  const rec = heap.alloc(256, true), code = heap.alloc(64, true);
  const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  mem.writeBytes(code, [0x8b, 0x44, 0x24, 0x08, 0x8b, 0x0d, ...le(rec), 0x89, 0x04, 0x8d, ...le(rec + 4), 0xff, 0x05, ...le(rec), 0x31, 0xc0, 0xc2, 16, 0]);
  const w = wm.makeWindow({ cls: null, style: 0x10000000, exStyle: 0, x: 0, y: 0, w: 640, h: 480, parent: wm.desktop, title: 'game' });
  w.wndProc = code; w.thread = vm.proc.threads[0]; wm.zorder.unshift(w); wm.active = w.hwnd; wm.focus = w.hwnd;
  // the window thread waits in GetMessage; the page's focus comes back: the scheduler evaluates its condition with no
  // guest thread running (the 'wait condition threw: ... reading cpu' of a player's session)
  const t = vm.proc.threads[0], cur = vm.current; vm.current = null;
  env.input({ type: 'focus', focused: false }, { type: 'focus', focused: true });
  let woke;
  assert.doesNotThrow(() => { woke = wm.hasMessage(t, 0, 0, 0); });
  vm.current = cur;
  assert.equal(woke, true, 'the thread wakes for its sent messages');
  assert.equal(mem.read32(rec), 0, 'no guest code ran in the condition');
  // its PeekMessage delivers them (WM_ACTIVATEAPP 0 then 1), and finds no posted message
  vm.current = t;
  assert.equal(call('user32.dll', 'PeekMessageA', scratch, 0, 0, 0, 1), 0);
  assert.deepEqual(Array.from({ length: mem.read32(rec) }, (_, i) => mem.read32(rec + 4 + 4 * i)), [0x1c, 0x1c]);
  assert.equal(wm.hasMessage(t, 0, 0, 0), false);
});
