// M2: PE loader + Win32 bootstrap. Runs CRT-free test programs built by tools/pe/build.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;

/** Boot a test exe in a fresh VM with a writable C:\Test holding the exe. */
function boot(exeName, opts = {}) {
  const vfs = new Vfs();
  const test = new MemBackend();
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', test);
  test.open(exeName, { create: true }).write(0, fs.readFileSync(PE_DIR + exeName));
  for (const [name, path] of Object.entries(opts.files ?? {})) test.open(name, { create: true }).write(0, fs.readFileSync(path));
  const clock = new VirtualClock();
  const host = new HeadlessHost({ clock, width: 800, height: 600 });
  const vm = new Vm({ vfs, clock, host, jit: opts.jit, logKinds: opts.logKinds ?? ['warn', 'crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\' + exeName });
  return { vm, host, clock };
}

const skip = (name) => !fs.existsSync(PE_DIR + name) && `build/pe/${name} missing (make pe-tests)`;

test('hello.exe: PE load, imports, heap, TLS, VirtualAlloc, files, exit code', { skip: skip('hello.exe') }, () => {
  const { vm } = boot('hello.exe');
  const code = vm.run();
  const out = vm.stdout.join('');
  assert.equal(code, 42);
  assert.equal(out,
    'hello from guest\n' +
    'abcdefghijklmnopqrstuvwxyz\n' +
    'abcdefghijklmnopqrstuvwxyz\n' +
    '1234\n' +
    '42\n' +
    '"C:\\Test\\hello.exe"\n' +
    'C:\\Test\\hello.exe\n' +
    'read back: written by guest\n' +
    '16\n' +
    '1234\n' +
    '8\n');
  assert.equal(vm.proc.unknownImports.size, 0);
});

test('window.exe: RegisterClass/CreateWindow, WM_PAINT via GDI, timers, input, message loop', { skip: skip('window.exe') }, () => {
  const { vm, host } = boot('window.exe');
  // scripted input: a key press and a click inside the client area (window at 100,100; client offset by frame/caption)
  host.at(25, { type: 'keydown', vk: 0x41, scan: 0x1e });
  host.at(26, { type: 'keyup', vk: 0x41, scan: 0x1e });
  host.at(35, { type: 'mousedown', button: 0, x: 100 + 4 + 12, y: 100 + 4 + 19 + 7 });
  host.at(36, { type: 'mouseup', button: 0, x: 100 + 4 + 12, y: 100 + 4 + 19 + 7 });
  const code = vm.run();
  // exit code = result(7) + paints*10 + keys*1000 + clicks*100000; clicks = x + y in client coords
  assert.equal(code % 10, 7, 'GetPixel readbacks (red rect, blue pixel)');
  const paints = Math.floor(code / 10) % 100;
  assert.ok(paints >= 2, `expected >= 2 paints, got ${paints}`);
  assert.equal(Math.floor(code / 1000) % 100, 0x41, 'WM_KEYDOWN delivered with VK_A');
  assert.equal(Math.floor(code / 100000), 12 + 7, 'WM_LBUTTONDOWN delivered with client coordinates');
  // the last presented frame shows the client surface with the red rectangle and blue pixel
  const d = host.display;
  assert.ok(d.frames > 0, 'frames presented');
  const cx = d.last.x, cy = d.last.y;
  assert.equal(d.pixelAt(cx + 50, cy + 30), 0xff0000, 'red rect presented');
  assert.equal(d.pixelAt(cx + 200, cy + 100), 0x0000ff, 'blue pixel presented');
  assert.equal(d.pixelAt(cx + 5, cy + 5), 0xffffff, 'class background brush (COLOR_WINDOW) erased');
  assert.equal(vm.proc.unknownImports.size, 0);
});

test('seh.exe: frame-based SEH dispatch, fault continuation, RtlUnwind', { skip: skip('seh.exe') }, () => {
  for (const jit of [true, false]) {
    const { vm } = boot('seh.exe', { jit });
    const code = vm.run();
    assert.equal(vm.stdout.join(''), 'div result 0x0000004d\ninner code 0xc0000094\ninner hits after unwind 0x00000065\ntop is outer 0x00000001\n', `jit=${jit}`);
    assert.equal(code, 0);
  }
});

test('threads.exe: CreateThread, critical sections, events, Sleep, waits', { skip: skip('threads.exe') }, () => {
  const { vm } = boot('threads.exe');
  const code = vm.run();
  assert.equal(vm.stdout.join(''), 'counter=2000\nwait=0\nslept ok=1\ntids differ=1\n');
  assert.equal(code, 0);
});

test('gdiplus.exe: GDI+ image loading (PNG/JPEG), LockBits, HBITMAP export, alpha drawing', { skip: skip('gdiplus.exe') }, () => {
  const fx = new URL('./fixtures/codec/', import.meta.url).pathname;
  const { vm } = boot('gdiplus.exe', { files: { 'rgb.png': fx + 'rgb.png', 'base.jpg': fx + 'base.jpg' } });
  const code = vm.run();
  assert.equal(code, 0);
  const out = Object.fromEntries(vm.stdout.join('').trim().split('\n').map((l) => l.split('=')));
  assert.equal(out.startup, '0');
  assert.equal(out.missing, '10', 'FileNotFound');
  assert.deepEqual([out.w, out.h, out.pf], ['97', '61', '0x00021808'], 'PNG RGB is reported as 24bpp');
  assert.equal(out['px(2,0)'], '0xff0a0000');
  assert.equal(out['px(30,30)'], '0xffff0000', 'red ellipse');
  assert.equal(out.stride, '292', '24bpp rows padded to 4 bytes');
  assert.equal(out.bgr, '0x000a0000');
  assert.equal(out['px(5,5)'], '0xff00ff00', 'write lock applied');
  assert.deepEqual([out.jw, out.jpf], ['97', '0x00021808']);
  const j = parseInt(out['jpx(80,30)'], 16);
  assert.ok(((j >> 8) & 0xff) > 250 && ((j >> 16) & 0xff) < 5 && (j & 0xff) < 5, `jpeg green rect ${out['jpx(80,30)']}`);
  assert.equal(out.palsize, '8', 'no palette: sizeof(ColorPalette) header only');
  assert.equal(out['gdi(2,0)'], '0x0000000a', 'HBITMAP export readable through GDI');
  assert.equal(out['blend(5,5)'], '0xff807f00', 'source-over of 50% red on green');
  assert.equal(out['gdi(35,12)'], '0x0006ff00', 'scaled draw into a DC');
  assert.equal(out['cpx(2,0)'], '0xff0a0000', 'clone');
  assert.equal(vm.proc.unknownImports.size, 0);
});
