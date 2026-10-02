// Builtin DLLs seen from guest code as on Windows, through the API handlers of a booted process:
// - module images: a builtin DLL's HMODULE holds MZ/PE headers and an export directory whose functions are the thunks
//   GetProcAddress returns, inside the image (found from a function address by scanning down for MZ, by VirtualQuery's
//   allocation base or GetModuleHandleEx(FROM_ADDRESS));
// - drives: the manifest's CD-ROM drive (GetDriveType, GetLogicalDrives, GetVolumeInformation, its files), and the
//   Win32 removal of a path's trailing spaces and periods;
// - DirectInput 8 EnumDevices class filters (no game controller reported as the keyboard);
// - DirectDraw's device queries; COM objects owned by another (back buffers) kept valid without references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend, normalizeWin, mountGameCdrom } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Ctx } from '../src/win32/ctx.js';
import { writeGuid, Com } from '../src/win32/com.js';
import { ApiRegistry, buildExportImage } from '../src/win32/api.js';
import { GuestMemory, THUNK_BASE, THUNK_END } from '../src/cpu/memory.js';

const EXE = new URL('../build/pe/hello.exe', import.meta.url).pathname;
const skip = !fs.existsSync(EXE) && 'build/pe/hello.exe missing (make pe-tests)';

function boot(manifest = {}) {
  const vfs = new Vfs(); const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', t);
  t.open('hello.exe', { create: true }).write(0, fs.readFileSync(EXE));
  t.mkdir('AUDIO'); t.open('AUDIO/WILD.ADF', { create: true }).write(0, new Uint8Array([1, 2, 3]));
  mountGameCdrom(vfs, manifest, t);
  const clock = new VirtualClock(Date.UTC(2026, 0, 1));
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 64, height: 64 }), logKinds: [] });
  vm.createProcess({ exePath: 'C:\\Test\\hello.exe' });
  const mem = vm.mem, heap = vm.proc.processHeap, scratch = heap.alloc(0x1000, true), frame = heap.alloc(64, true);
  const ctx = (...args) => {
    args.forEach((a, i) => mem.write32(frame + 4 + 4 * i, a >>> 0));
    const c = new Ctx(vm); c.thread = vm.proc.threads[0]; c.cpu = c.thread.cpu; c.sp = frame; return c;
  };
  const call = (dll, name, ...args) => { const r = vm.api.lookup(dll, name).fn(ctx(...args)); return r === undefined ? r : r >>> 0; };
  const str = (s) => { const a = heap.alloc(s.length + 1, true); mem.writeCString(a, s); return a; };
  return { vm, mem, heap, scratch, call, ctx, str };
}

/** The exports of an in-memory PE image, by walking its headers as guest code does. */
function readExports(mem, base) {
  assert.equal(mem.read16(base), 0x5a4d, 'MZ');
  const pe = base + mem.read32(base + 0x3c);
  assert.equal(mem.read32(pe), 0x4550, 'PE signature');
  assert.equal(mem.read16(pe + 24), 0x10b, 'PE32 optional header');
  assert.equal(mem.read32(pe + 24 + 28), base, 'ImageBase');
  const ed = base + mem.read32(pe + 24 + 96);
  const n = mem.read32(ed + 24), eat = base + mem.read32(ed + 28), names = base + mem.read32(ed + 32), ords = base + mem.read32(ed + 36);
  const out = new Map();
  for (let i = 0; i < n; i++) out.set(mem.readCString(base + mem.read32(names + 4 * i)), base + mem.read32(eat + 4 * mem.read16(ords + 2 * i)));
  return { name: mem.readCString(base + mem.read32(ed + 12)), exports: out, base1: mem.read32(ed + 16), sizeOfImage: mem.read32(pe + 24 + 56) };
}

test('builtin DLLs are PE images: exports, function addresses inside, found by scanning down', { skip }, () => {
  const { vm, mem, call, str, scratch } = boot();
  const k32 = call('kernel32.dll', 'GetModuleHandleA', str('KERNEL32.DLL'));
  assert.equal(k32, THUNK_BASE, 'kernel32 first, at the 1 MB-aligned start of the thunk area');
  const img = readExports(mem, k32);
  assert.equal(img.name, 'kernel32.dll');
  const gpa = call('kernel32.dll', 'GetProcAddress', k32, str('GetTickCount'));
  assert.equal(img.exports.get('GetTickCount'), gpa, 'the export table names the thunk GetProcAddress returns');
  assert.ok(gpa > k32 && gpa < k32 + img.sizeOfImage, 'inside the image');
  // names sorted (a binary search of the name table works)
  const names = [...img.exports.keys()];
  assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  // the base of the module holding a function, by the page scan software does
  let p = gpa & ~0xfff; while (mem.read16(p) !== 0x5a4d) p -= 0x1000;
  assert.equal(p, k32);
  // an import of another DLL resolves inside that DLL's image
  const user32 = call('kernel32.dll', 'LoadLibraryA', str('user32.dll'));
  const msgBox = call('kernel32.dll', 'GetProcAddress', user32, str('MessageBoxA'));
  assert.equal(readExports(mem, user32).exports.get('MessageBoxA'), msgBox);
  p = msgBox & ~0xfff; while (mem.read16(p) !== 0x5a4d) p -= 0x1000;
  assert.equal(p, user32);
  // VirtualQuery: an image page whose allocation base is the module
  assert.equal(call('kernel32.dll', 'VirtualQuery', msgBox, scratch, 28), 28);
  assert.equal(mem.read32(scratch + 4), user32, 'AllocationBase');
  assert.equal(mem.read32(scratch + 16), 0x1000, 'MEM_COMMIT');
  assert.equal(mem.read32(scratch + 24), 0x1000000, 'MEM_IMAGE');
  assert.equal(mem.read32(scratch + 20), 0x80, 'a small-alignment image: PAGE_EXECUTE_WRITECOPY');
  call('kernel32.dll', 'VirtualQuery', user32, scratch, 28);
  assert.equal(mem.read32(scratch), user32, 'from the image base');
  // GetModuleHandleEx(FROM_ADDRESS)
  assert.equal(call('kernel32.dll', 'GetModuleHandleExA', 4 | 2, msgBox, scratch), 1);
  assert.equal(mem.read32(scratch), user32);
  // the thunks still dispatch to their handlers
  assert.equal(vm.api.nameOf(msgBox), 'user32.dll!MessageBoxA');
});

test('thunk windows: aliases share thunks, ordinals, unknown names in the slack, internal DLLs without headers', () => {
  const mem = new GuestMemory({ sizeBytes: 0x80000000 });
  const api = new ApiRegistry(mem);
  api.define('base.dll', { Alpha: [0, () => 1], Beta: [1, () => 2, { ordinal: 3 }] });
  api.dll('base.dll', ['alias.dll']);
  api.define('orthros.dll', { __x: [0, () => 0] });
  const internal = api.thunkFor('orthros.dll', '__x');
  assert.ok(internal >= THUNK_BASE && internal < THUNK_END && api.windowAt(internal) === null, 'internal thunks: no module image');
  const base = api.moduleBase('base.dll');
  assert.equal(api.thunkFor('alias.dll', 'Alpha'), api.thunkFor('base.dll', 'Alpha'), 'an alias resolves to the same thunk');
  const img = readExports(mem, base);
  assert.equal(img.base1, 1);
  assert.equal(img.exports.get('Beta'), api.thunkForOrdinal('base.dll', 3), 'ordinal 3 is Beta');
  const ed = base + mem.read32(base + 0x40 + 24 + 96);
  assert.equal(base + mem.read32(base + mem.read32(ed + 28) + 4 * 2), api.thunkFor('base.dll', 'Beta'), 'EAT[ordinal - base]');
  assert.equal(mem.read32(base + mem.read32(ed + 28)), 0, 'unused ordinal 1: no function');
  const unknown = api.thunkFor('base.dll', 'NotImplemented');
  assert.equal(api.windowAt(unknown), api.window('base.dll'), 'an unknown name gets a slot of its DLL image');
  assert.equal(api.thunk((unknown - THUNK_BASE) / 16).def, null);
  assert.deepEqual(buildExportImage('x.dll', undefined).funcs, []);
});

test('the manifest CD-ROM drive and trailing spaces / periods of paths', { skip }, () => {
  assert.equal(normalizeWin('DATA\\MAPS\\generic.IDE ', 'C:\\Game'), 'C:\\Game\\DATA\\MAPS\\generic.IDE');
  assert.equal(normalizeWin('C:\\a\\b. . '), 'C:\\a\\b');
  assert.equal(normalizeWin('C:\\a\\..'), 'C:\\');
  assert.equal(normalizeWin('C:\\a\\*.'), 'C:\\a\\*.', 'wildcard patterns kept');
  assert.equal(normalizeWin('\\\\?\\C:\\x. '), 'C:\\x. ', '\\\\?\\ paths kept');
  {
    const { call, str, mem, scratch } = boot();
    assert.equal(call('kernel32.dll', 'GetDriveTypeA', str('D:\\')), 5, 'D: an empty CD-ROM drive');
    assert.equal(call('kernel32.dll', 'GetLogicalDrives'), 0x4);
    assert.equal(call('kernel32.dll', 'GetVolumeInformationA', str('D:\\'), scratch, 64, 0, 0, 0, 0, 0), 0, 'no disc');
    assert.equal(call('kernel32.dll', 'GetDriveTypeA', 0), 3, 'NULL: the current drive');
    void mem;
  }
  const { call, str, mem, scratch } = boot({ cdrom: { drive: 'E', label: 'DISC_1' } });
  assert.equal(call('kernel32.dll', 'GetDriveTypeA', str('E:\\')), 5);
  assert.equal(call('kernel32.dll', 'GetLogicalDrives'), 0x14, 'C: and E:');
  assert.equal(call('kernel32.dll', 'GetLogicalDriveStringsA', 64, scratch), 8);
  assert.deepEqual([...mem.bytes(scratch, 9)], [...Buffer.from('C:\\\0E:\\\0\0')]);
  assert.equal(call('kernel32.dll', 'GetVolumeInformationA', str('E:\\'), scratch, 64, scratch + 64, 0, 0, scratch + 128, 16), 1);
  assert.equal(mem.readCString(scratch), 'DISC_1');
  assert.equal(mem.readCString(scratch + 128), 'CDFS');
  const h = call('kernel32.dll', 'CreateFileA', str('E:\\audio\\wild.adf '), 0x80000000, 1, 0, 3, 0, 0);
  assert.notEqual(h, 0xffffffff, 'the game files on the disc, a trailing space removed');
});

test('DirectInput 8 EnumDevices: classes and types', { skip }, () => {
  const { vm, mem, heap, call, ctx, scratch } = boot();
  const iid = heap.alloc(16, true); writeGuid(mem, iid, 'bf798030-483a-4da2-aa99-5d64ed369700');
  assert.equal(call('dinput8.dll', 'DirectInput8Create', 0x400000, 0x800, iid, scratch, 0), 0);
  const di = vm.com.implAt(mem.read32(scratch));
  // a stdcall callback recording the device types: [rec] = count, then the types
  const rec = heap.alloc(64, true), code = heap.alloc(64, true);
  const b = [0x8b, 0x44, 0x24, 0x04, 0x8b, 0x40, 0x24, 0x8b, 0x0d, ...le(rec), 0x89, 0x04, 0x8d, ...le(rec + 4), 0xff, 0x05, ...le(rec), 0xb8, 1, 0, 0, 0, 0xc2, 8, 0];
  mem.writeBytes(code, b);
  const types = (filter) => { mem.write32(rec, 0); di.EnumDevices(ctx(mem.read32(scratch), filter, code, 0, 0)); return Array.from({ length: mem.read32(rec) }, (_, i) => mem.read32(rec + 4 + 4 * i) & 0xff); };
  assert.deepEqual(types(0), [0x13, 0x12], 'all: keyboard, mouse');
  assert.deepEqual(types(4), [], 'DI8DEVCLASS_GAMECTRL: no game controller');
  assert.deepEqual(types(3), [0x13], 'DI8DEVCLASS_KEYBOARD');
  assert.deepEqual(types(2), [0x12], 'DI8DEVCLASS_POINTER');
  assert.deepEqual(types(1), [], 'DI8DEVCLASS_DEVICE');
  assert.deepEqual(types(0x12), [0x12], 'a device type');
});
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];

test('DirectDraw: DirectDrawCreateEx and the device queries', { skip }, () => {
  const { vm, mem, heap, call, ctx, scratch } = boot();
  const iid7 = heap.alloc(16, true); writeGuid(mem, iid7, '15e65ec0-3b9c-11d2-b92f-00609797ea5b');
  assert.equal(call('ddraw.dll', 'DirectDrawCreateEx', 0, scratch, iid7, 0), 0);
  const ptr = mem.read32(scratch), dd = vm.com.implAt(ptr);
  assert.equal(vm.com.objectAt(ptr).iface.name, 'IDirectDraw7');
  assert.equal(dd.GetAvailableVidMem(ctx(ptr, 0, scratch + 4, scratch + 8)), 0);
  assert.ok(mem.read32(scratch + 4) >= 64 << 20 && mem.read32(scratch + 8) <= mem.read32(scratch + 4));
  const desc = heap.alloc(124, true); mem.write32(desc, 124);
  assert.equal(dd.GetDisplayMode(ctx(ptr, desc)), 0);
  assert.deepEqual([mem.read32(desc + 12), mem.read32(desc + 8), mem.read32(desc + 72 + 12)], [64, 64, 32], 'the display size and depth');
  // no IID_IDirectDraw7 for DirectDrawCreateEx: invalid
  assert.equal(call('ddraw.dll', 'DirectDrawCreateEx', 0, scratch, scratch + 32, 0), 0x80070057);
  // QueryInterface for an older version: another object of the same DirectDraw
  const iid1 = heap.alloc(16, true); writeGuid(mem, iid1, '6c14db80-a733-11ce-a521-0020af0be560');
  assert.equal(vm.com.dispatch(ctx(ptr, iid1, scratch + 16), vm.com.objectAt(ptr).iface, 0), 0);
  assert.equal(vm.com.objectAt(mem.read32(scratch + 16)).iface.name, 'IDirectDraw');
  // IDirect3DDevice8::CreateDepthStencilSurface takes 5 arguments (stack cleanup)
  assert.equal(vm.com.interfaces.get('IDirect3DDevice8').methods.find((m) => m.name === 'CreateDepthStencilSurface').argc, 5);
});

test('COM: an object kept alive by its owner survives its last Release at the same address', { skip }, () => {
  const { vm } = boot();
  const com = vm.com; void Com;
  com.interface('ITestKeep', '11111111-2222-3333-4444-555555555555', 'IUnknown', []);
  let destroyed = 0;
  const impl = { keepAlive: true, destroy() { destroyed++; } };
  const p = com.create(vm.proc, 'ITestKeep', impl);
  assert.equal(com.release(com.objectAt(p)), 0);
  assert.ok(com.objectAt(p), 'still an object');
  assert.equal(com.addRef(com.objectAt(p)), 1);
  com.release(com.objectAt(p));
  impl.keepAlive = false; com.unpin(impl);
  assert.equal(com.objectAt(p), null);
  assert.equal(destroyed, 1);
  const q = com.create(vm.proc, 'ITestKeep', { keepAlive: false });
  com.release(com.objectAt(q));
  assert.equal(com.objectAt(q), null, 'without an owner: destroyed at the last Release');
});

test('MapVirtualKey(MAPVK_VK_TO_CHAR): letters in upper case, other keys unshifted', { skip }, () => {
  const { call } = boot();
  assert.equal(call('user32.dll', 'MapVirtualKeyA', 0x46, 2), 0x46, "VK 'F' -> 'F'");
  assert.equal(call('user32.dll', 'MapVirtualKeyA', 0x57, 2), 0x57);
  assert.equal(call('user32.dll', 'MapVirtualKeyA', 0x31, 2), 0x31, "'1'");
  assert.equal(call('user32.dll', 'MapVirtualKeyA', 0xbd, 2), 0x2d, "'-'");
  assert.equal(call('user32.dll', 'MapVirtualKeyA', 0x46, 0), 0x21, 'VK_TO_VSC');
});

test('DirectSound3D: listener on a 3D primary buffer, 3D buffers attenuated and panned, deferred settings', { skip }, () => {
  const { vm, mem, heap, call, ctx, scratch } = boot();
  const com = vm.com;
  assert.equal(call('dsound.dll', 'DirectSoundCreate', 0, scratch, 0), 0);
  const dsPtr = mem.read32(scratch), ds = com.implAt(dsPtr);
  ds.SetCooperativeLevel(ctx(dsPtr, 0, 2));
  const desc = heap.alloc(36, true), wfx = heap.alloc(18, true);
  const f32 = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.getUint32(0, true); };
  const qi = (ptr, iid) => { const g = heap.alloc(16, true); writeGuid(mem, g, iid); const r = com.dispatch(ctx(ptr, g, scratch + 8), com.objectAt(ptr).iface, 0); return r === 0 ? mem.read32(scratch + 8) : 0; };
  // primary buffer without DSBCAPS_CTRL3D: no listener; with it: the listener
  mem.write32(desc, 36); mem.write32(desc + 4, 0x1);
  assert.equal(ds.CreateSoundBuffer(ctx(dsPtr, desc, scratch + 4, 0)), 0);
  const L_IID = '279afa84-4981-11ce-a521-0020af0be560', B_IID = '279afa86-4981-11ce-a521-0020af0be560';
  assert.equal(qi(mem.read32(scratch + 4), L_IID), 0);
  mem.write32(desc + 4, 0x1 | 0x10);
  const prim = (ds.primary = 0, ds.CreateSoundBuffer(ctx(dsPtr, desc, scratch + 4, 0)), mem.read32(scratch + 4));
  const lis = qi(prim, L_IID);
  assert.ok(lis, 'IDirectSound3DListener');
  // a mono 3D secondary buffer
  mem.write16(wfx, 1); mem.write16(wfx + 2, 1); mem.write32(wfx + 4, 22050); mem.write32(wfx + 8, 44100); mem.write16(wfx + 12, 2); mem.write16(wfx + 14, 16);
  mem.write32(desc + 4, 0x10 | 0x80); mem.write32(desc + 8, 4096); mem.write32(desc + 16, wfx);
  assert.equal(ds.CreateSoundBuffer(ctx(dsPtr, desc, scratch + 4, 0)), 0);
  const bufPtr = mem.read32(scratch + 4), buf = com.implAt(bufPtr), b3 = qi(bufPtr, B_IID);
  assert.ok(b3, 'IDirectSound3DBuffer');
  const B = com.implAt(b3), Lst = com.implAt(lis);
  const near = buf.gains();
  assert.deepEqual(near.map((g) => +g.toFixed(3)), [1, 1], 'at the listener: unity');
  // to the right (listener facing +z, up +y: +x is right), 10 units away with min distance 1: 1/10, panned right
  assert.equal(B.SetPosition(ctx(b3, f32(10), 0, 0, 0)), 0);
  const [l, r] = buf.gains();
  assert.ok(Math.abs(r - 0.1) < 1e-6 && l < 1e-6, `fully right, 1/10: ${l} ${r}`);
  // beyond the maximum distance: no more attenuation
  B.SetMaxDistance(ctx(b3, f32(5), 0));
  assert.ok(Math.abs(buf.gains()[1] - 0.2) < 1e-6, 'attenuated as at the maximum distance (1/5)');
  // deferred: nothing changes until CommitDeferredSettings
  const before = buf.gains();
  Lst.SetPosition(ctx(lis, f32(10), 0, 0, 1));
  assert.deepEqual(buf.gains(), before, 'deferred');
  Lst.CommitDeferredSettings(ctx(lis));
  assert.deepEqual(buf.gains().map((g) => +g.toFixed(3)), [1, 1], 'the listener moved onto the source');
  // DS3DMODE_DISABLE: no 3D processing
  B.SetPosition(ctx(b3, f32(-50), 0, 0, 0)); B.SetMode(ctx(b3, 2, 0));
  assert.deepEqual(buf.gains(), [1, 1]);
});

test('SystemParametersInfo: screen power saving settings', { skip }, () => {
  const { call, mem, scratch } = boot();
  assert.equal(call('user32.dll', 'SystemParametersInfoA', 0x54, 0, scratch, 0), 1, 'SPI_GETPOWEROFFACTIVE');
  assert.equal(mem.read32(scratch), 0);
  assert.equal(call('user32.dll', 'SystemParametersInfoA', 0x56, 1, 0, 0), 1, 'SPI_SETPOWEROFFACTIVE');
  call('user32.dll', 'SystemParametersInfoA', 0x54, 0, scratch, 0);
  assert.equal(mem.read32(scratch), 1);
  assert.equal(call('user32.dll', 'SystemParametersInfoA', 0x51, 600, 0, 0), 1, 'SPI_SETLOWPOWERTIMEOUT');
  call('user32.dll', 'SystemParametersInfoA', 0x4f, 0, scratch, 0);
  assert.equal(mem.read32(scratch), 600);
});
