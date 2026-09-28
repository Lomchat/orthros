// M2: PE loader + Win32 bootstrap. Runs CRT-free test programs built by tools/pe/build.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { wmOf } from '../src/win32/user32.js';

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
  const vm = new Vm({ vfs, clock, host, jit: opts.jit, apiHist: opts.apiHist, logKinds: opts.logKinds ?? ['warn', 'crash'] });
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

// a failure exit (non-zero code) leaves a report for the host: the exiting thread, the recent API calls and the last
// exceptions raised, a C++ exception with its thrown type's name (MSVC ThrowInfo chain, built here in guest memory)
test('hello.exe: a non-zero exit code leaves a failure report with the last exceptions raised', { skip: skip('hello.exe') }, () => {
  const { vm } = boot('hello.exe');
  const m = vm.mem, a = vm.proc.processHeap.alloc(64);
  const ti = a, cta = a + 16, ct = a + 24, td = a + 36;
  m.write32(ti + 12, cta); m.write32(cta, 1); m.write32(cta + 4, ct); m.write32(ct + 4, td); m.writeCString(td + 8, '.?AVFailure@@');
  vm.seh.remember(vm.proc.threads[0], 0xe06d7363, vm.proc.exe.entry, [0x19930520, 0, ti]);
  assert.equal(vm.run(), 42);
  assert.match(vm.exitReport, /process exit with code 42 in thread/);
  assert.match(vm.exitReport, /kernel32\.dll!ExitProcess/);
  assert.match(vm.exitReport, /exceptions raised: 1, the last ones:\n  t\d+ 0xe06d7363 \.\?AVFailure@@ at /);
});

test('seh.exe: frame-based SEH dispatch, fault continuation, RtlUnwind, execution faults at bad addresses, an exception raised in a handler', { skip: skip('seh.exe') }, () => {
  for (const jit of [true, false]) {
    const { vm } = boot('seh.exe', { jit });
    const code = vm.run();
    const exec = (a) => `exec code 0xc0000005\nexec addr 0x${a}\nexec info 0x${a}\n`;
    assert.equal(vm.stdout.join(''), 'div result 0x0000004d\ninner code 0xc0000094\ninner hits after unwind 0x00000065\ntop is outer 0x00000001\n' +
      exec('00000000') + exec('fffffff0') + exec('ffffffff') +
      'nested inner 0x0000004d\nnested inner code 0xc0000094\nnested outer 0x00000037\n', `jit=${jit}`);
    assert.equal(code, 0);
  }
});

test('threads.exe: CreateThread, critical sections, events, Sleep, waits', { skip: skip('threads.exe') }, () => {
  const { vm } = boot('threads.exe');
  const code = vm.run();
  assert.equal(vm.stdout.join(''), 'counter=2000\nwait=0\nslept ok=1\ntids differ=1\n');
  assert.equal(code, 0);
});

test('sync.exe: waits satisfied at signal time (mutex/critical-section hand-off, single wake-ups, handshake, abandonment), uncontended mutexes without JavaScript', { skip: skip('sync.exe') }, () => {
  for (const jit of [true, false]) {
    const { vm } = boot('sync.exe', { jit, apiHist: true });
    const code = vm.run();
    assert.equal(vm.stdout.join(''),
      'mutex_handoff=1\nmutex_join=0\nmutex_violations=0\nmutex_release_failures=0\n' +
      'cs_handoff=1\ncs_join=0\ncs_violations=0\n' +
      'event_first=1\nevent_second=2\nsem_first=1\nsem_second=2\n' +
      'handshake=1\nhandshake_bounded=1\nhandshake_join=0\nhandshake_A_free=0\n' +
      'abandoned=128\n', `executor jit=${jit}`);
    assert.equal(code, 0);
    // (JIT: an uncontended mutex is taken and released without JavaScript — about 25,000 calls each otherwise)
    if (jit) for (const n of ['WaitForSingleObject', 'ReleaseMutex']) assert.ok(vm.apiHist().get(`kernel32.dll!${n}`) < 500, `${n} calls handled in JavaScript: ${vm.apiHist().get(`kernel32.dll!${n}`)}`);
  }
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
  for (const [k, v] of [['int', '49965701'], ['sieve', '000245c5'], ['memory', '213a0000'], ['string', '00fa0000'], ['fpu', '000007d1'], ['sse', 'd4fd7eca']]) assert.ok(out.includes(`${k} 0x${v}`), `${k} checksum in\n${out}`);
  assert.ok(vm.jit.stats.consolidations >= 5, `consolidations: ${vm.jit.stats.consolidations}`);
});

test('d3dlost.exe: Direct3D 9 Reset, a fullscreen device lost while the application is inactive', { skip: skip('d3dlost.exe') }, () => {
  const { vm, host } = boot('d3dlost.exe', { jit: true });
  // the host window loses the focus at 3 s and regains it at 6 s (fullscreen), then again at 12 s / 13 s (windowed)
  host.script.push({ at: 3000, ev: { type: 'focus', focused: false } }, { at: 6000, ev: { type: 'focus', focused: true } },
    { at: 12000, ev: { type: 'focus', focused: false } }, { at: 13000, ev: { type: 'focus', focused: true } });
  assert.equal(vm.run(), 0);
  const out = Object.fromEntries(vm.stdout.join('').trim().split('\n').map((l) => l.split('=')));
  const OK = '0x00000000', LOST = '0x88760868', NOTRESET = '0x88760869';
  assert.deepEqual([out.device, out.reset, out.getrt0, out.rt0isbb, out.getds, out.getrt1, out.rt1], [OK, OK, OK, '1', OK, '0x88760866', '0'], 'after Reset: render target 0 = back buffer 0, automatic depth-stencil, render target 1 unset');
  assert.deepEqual([out.resetfs, out.fs_tcl, out.lost_tcl, out.lost_present, out.lost_reset, out.back_tcl, out.back_reset, out.ok_tcl, out.ok_present],
    [OK, OK, LOST, LOST, LOST, NOTRESET, OK, OK, OK], 'fullscreen: lost while the application is inactive, then waiting for Reset');
  assert.deepEqual([out.resetwin, out.win_tcl, out.win_present], [OK, OK, OK], 'a windowed device is not lost');
  assert.deepEqual([out.devrelease, out.d3drelease], ['0', '0']);
});

test('dx9.exe: Direct3D 9 device, texture, vertex declaration, draw and readback path', { skip: skip('dx9.exe') }, () => {
  const { vm } = boot('dx9.exe', { jit: true });
  const code = vm.run();
  assert.equal(code, 0);
  const out = Object.fromEntries(vm.stdout.join('').trim().split('\n').map((l) => l.split('=')));
  assert.deepEqual([out.adapters, out.modew, out.modefmt, out.maxtex, out.vsver, out.psver, out.numrts], ['1', '800', '22', '4096', '0xfffe0200', '0xffff0200', '4']);
  assert.ok(Number(out.modecount) > 10, 'display modes enumerated per format');
  for (const k of ['checktype', 'checkfmt', 'checkds', 'device', 'tex', 'lockrect', 'unlockrect', 'surflevel', 'decl', 'setdecl', 'vb', 'vblock', 'vbunlock', 'stream', 'begin', 'clear', 'rs_cull', 'settex', 'sampler', 'draw', 'end', 'present', 'backbuffer', 'offscreen', 'rtdata', 'offlock']) assert.equal(out[k], '0x00000000', k);
  assert.deepEqual([out.levels, out.surfw, out.surfms, out.bbw, out.bbh], ['1', '8', '0', '320', '240'], 'DX9 surface descriptors');
  assert.deepEqual([out.texrefs, out.vbrefs, out.devrelease, out.d3drelease], ['1', '1', '0', '0'], 'reference counting');
  for (const k of ['settransform', 'rs_zwrite', 'rs_zwrite2', 'gettransform']) assert.equal(out[k], '0x00000000', k);
  assert.deepEqual([out.transform5, out.zwrite], ['5', '1'], 'deferred state setters: arguments taken at the call, applied in order before a getter');
  assert.ok(vm.deferredCalls >= 1, 'state setters went through the deferred call queue');
  assert.equal(vm.proc.unknownImports.size, 0);
});

// Host input: a mouse release waits until the game presented a frame after the press (at most 250 ms), so a game
// sampling the button once per frame sees a click shorter than one of its frames; GetAsyncKeyState bit 0 reports
// a press since its previous call.
test('input: a click shorter than a frame still shows the button down for one frame; GetAsyncKeyState bit 0', { skip: skip('window.exe') }, () => {
  const { vm, host, clock } = boot('window.exe');
  const wm = wmOf(vm);
  vm.d3dDevice = { frames: 5, lost: 0 };
  host.inputQueue.push({ type: 'mousedown', button: 0, x: 10, y: 10 }, { type: 'mouseup', button: 0, x: 10, y: 10 }, { type: 'mousemove', x: 20, y: 20 });
  wm.pump();
  assert.equal(wm.keyState[1] & 0x80, 0x80, 'button down seen, release held');
  assert.equal(wm.cursor.x, 10, 'the move after the held release waits too');
  wm.pump();
  assert.equal(wm.keyState[1] & 0x80, 0x80, 'no frame yet: still held');
  vm.d3dDevice.frames = 6;
  wm.pump();
  assert.equal(wm.keyState[1] & 0x80, 0, 'released after a frame');
  assert.equal(wm.cursor.x, 20);
  // without a frame, the release goes after 250 ms
  host.inputQueue.push({ type: 'mousedown', button: 0, x: 1, y: 1 }, { type: 'mouseup', button: 0, x: 1, y: 1 });
  wm.pump(); assert.equal(wm.keyState[1] & 0x80, 0x80);
  clock.sleep(300); wm.pump(); assert.equal(wm.keyState[1] & 0x80, 0, 'released after 250 ms without a frame');
  vm.d3dDevice = null;
  // GetAsyncKeyState: bit 0 once after a press (here a tap already over), then 0
  host.inputQueue.push({ type: 'keydown', vk: 0x41, scan: 0x1e }, { type: 'keyup', vk: 0x41, scan: 0x1e });
  wm.pump();
  assert.equal(wm.asyncPressed[0x41], 1, 'pressed since the last call');
});

// The cursor shows when ShowCursor's count is >= 0 and a shape is set: SetCursor(NULL) hides it until the next
// SetCursor with a cursor (it used to stay hidden for good), independently of the count.
test('cursor: SetCursor(NULL) hides until the next SetCursor; ShowCursor counts independently', { skip: skip('window.exe') }, () => {
  const { vm } = boot('window.exe');
  const shown = []; vm.host.display.showCursor = (v) => shown.push(v); vm.host.display.setCursor = () => {};
  const call = (name, ...args) => vm.api.lookup('user32.dll', name).fn({ arg: (i) => args[i] >>> 0, proc: vm.proc });
  const h = vm.proc.handles.create({ type: 'gdi', kind: 'cursor', id: 32512 });
  call('SetCursor', h); call('SetCursor', 0); call('SetCursor', h);
  assert.deepEqual(shown, [true, false, true], 'hidden by SetCursor(NULL), shown again by the next cursor');
  shown.length = 0;
  call('ShowCursor', 0); call('SetCursor', 0); call('SetCursor', h); call('ShowCursor', 1);
  assert.deepEqual(shown, [false, false, false, true], 'a negative display count keeps it hidden whatever the shape');
});

// Winsock (D061): UDP and TCP inside the process, then over the virtual LAN with a machine played by the test (it
// answers the program's broadcast on port 8086, then accepts its TCP connection on 8100 and replies "ok" to "data").
import { LAN } from '../src/host/lan-proto.js';
test('net.exe: Winsock inside the process and over the virtual LAN', { skip: skip('net.exe') }, () => {
  const inside = boot('net.exe', { jit: true });
  assert.equal(inside.vm.run(), 0);
  const want = 'startup=0\nme=127.0.0.1\nbind1=0\nbind2=0\nbind_inuse=10048\nsendto=4\nrecvfrom=4\nfrom_port=9001\ndata_ping=1\nwouldblock=10035\nbcast_own=5\n' +
    'listen=0\nconnect=0\naccept_ready=1\naccepted=1\nsend=5\nrecv=5\ndata_hello=1\nreadable=1\nrecv2=3\nrecv3=3\ndata_world=1\npeer_closed=0\nrefused=10061\n';
  assert.equal(inside.vm.stdout.join(''), want);

  const { vm, host } = boot('net.exe', { jit: true });
  const other = { ip: 0x09004d0a, frames: [] }; // 10.77.0.9
  host.lan = {
    ip: '10.77.0.2',
    send(type, src, dst, payload) {
      other.frames.push(type);
      const back = (t, data = null) => vm.lanDeliver(t, dst.ip === 0xffffffff ? { ip: other.ip, port: dst.port } : dst, src, data);
      if (type === LAN.UDP && dst.port === 8086) back(LAN.UDP, new TextEncoder().encode('hello'));
      else if (type === LAN.SYN && dst.ip === other.ip && dst.port === 8100) back(LAN.ACCEPT);
      else if (type === LAN.DATA && new TextDecoder().decode(payload) === 'data') back(LAN.DATA, new TextEncoder().encode('ok'));
    },
  };
  assert.equal(vm.run(), 0);
  const out = vm.stdout.join('');
  assert.ok(out.startsWith('startup=0\nme=10.77.0.2\n'), out);
  assert.ok(out.endsWith('lan_reply=5\nlan_from=10.77.0.9\nlan_data=1\nlan_connect=0\nlan_recv=2\nlan_ok=1\n'), out);
  assert.deepEqual(other.frames, [LAN.UDP, LAN.UDP, LAN.SYN, LAN.DATA, LAN.FIN], 'both broadcasts leave the machine, then the connection');
});
