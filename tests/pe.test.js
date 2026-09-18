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

test('dx.exe: DirectSound buffers/cursors, DirectInput keyboard+mouse, Direct3D 8 device/resources', { skip: skip('dx.exe') }, () => {
  const { vm, host } = boot('dx.exe', { jit: true });
  const base = 2850; // virtual ms consumed by the DirectSound sleeps before the DirectInput part
  host.at(base + 20, { type: 'keydown', vk: 0x41, scan: 0x1e });
  host.at(base + 50, { type: 'mousemove', x: 100, y: 100 });
  host.at(base + 80, { type: 'mousemove', x: 110, y: 105 });
  host.at(base + 81, { type: 'mousedown', button: 0, x: 110, y: 105 });
  const code = vm.run();
  assert.equal(code, 0);
  const out = Object.fromEntries(vm.stdout.join('').trim().split('\n').map((l) => l.split('=')));
  // DirectSound: 44.1 kHz 16-bit stereo, play cursor follows the virtual clock
  for (const k of ['dscreate', 'coop', 'primary', 'setformat', 'secondary', 'lock', 'unlock', 'play', 'playloop', 'setfreq', 'stop', 'setvol']) assert.equal(out[k], '0x00000000', k);
  assert.equal(out.lockbytes, '176400');
  assert.deepEqual([out.pos250, out.status250], ['44100', '0x00000011'], '250 ms of playback');
  assert.deepEqual([out.posend, out.statusend], ['0', '0x00000010'], 'non-looping buffer stops at its end');
  assert.deepEqual([out.posloop, out.statusloop], ['88200', '0x00000015'], 'looping wraps');
  assert.equal(out.posfreq, '97020', 'frequency change halves the advance rate');
  assert.equal(out.vol, '0xfffffda8', 'volume -600');
  // DirectInput
  assert.equal(out.key_a, '0x00000080', 'DIK_A pressed');
  assert.deepEqual([out.mx, out.my, out.mb0], ['10', '5', '0x00000080'], 'relative mouse motion and button');
  assert.equal(out.msevents, '5');
  assert.equal(out.ev0, '0x0000fed4', 'first buffered event: X axis, -300');
  // Direct3D 8
  assert.deepEqual([out.adapters, out.modew, out.modefmt, out.maxtex, out.vsver], ['1', '800', '22', '4096', '0xfffe0101']);
  for (const k of ['checktype', 'checkfmt', 'device', 'tex', 'lockrect', 'unlockrect', 'surflevel', 'vb', 'vblock', 'vbunlock', 'begin', 'clear', 'rs', 'settex', 'stream', 'fvf', 'draw', 'end', 'present', 'backbuffer']) assert.equal(out[k], '0x00000000', k);
  assert.deepEqual([out.levels, out.pitch, out.surfw, out.surfsize, out.surfpix], ['7', '256', '64', '16384', '0xffff0000'], 'texture levels and surface access');
  assert.deepEqual([out.bbw, out.bbh], ['320', '240']);
  assert.deepEqual([out.texrefs, out.vbrefs, out.devrelease, out.d3drelease], ['1', '1', '0', '0'], 'reference counting');
  assert.equal(vm.proc.unknownImports.size, 0);
});

test('bench.exe: JIT region consolidation into multi-function modules keeps results identical', { skip: skip('bench.exe') }, () => {
  const { vm } = boot('bench.exe', { jit: true });
  vm.jit.consolidateEvery = 4;
  const code = vm.run();
  assert.equal(code, 0);
  const out = vm.stdout.join('');
  for (const [k, v] of [['int', '49965701'], ['sieve', '000245c5'], ['memory', '213a0000'], ['string', '00fa0000'], ['fpu', '000007d1']]) assert.ok(out.includes(`${k} 0x${v}`), `${k} checksum in\n${out}`);
  assert.ok(vm.jit.stats.consolidations >= 5, `consolidations: ${vm.jit.stats.consolidations}`);
});
