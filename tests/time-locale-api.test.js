// The time zone and locale APIs end to end, through their handlers in a booted process with a synthetic zone
// (Central Europe) so the result does not depend on the machine: GetTimeZoneInformation's layout and return value,
// local time, FileTime <-> local FileTime, SystemTimeToTzSpecificLocalTime / back, CRT localtime / gmtime / mktime,
// GetLocaleInfoA/W sizes (LOCALE_RETURN_NUMBER: a DWORD).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Ctx } from '../src/win32/ctx.js';

const EXE = new URL('../build/pe/hello.exe', import.meta.url).pathname;
const skip = !fs.existsSync(EXE) && 'build/pe/hello.exe missing (make pe-tests)';

const lastSunday = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
const europe = (ms) => { const y = new Date(ms).getUTCFullYear(); const a = Date.UTC(y, 2, lastSunday(y, 2), 1), b = Date.UTC(y, 9, lastSunday(y, 9), 1); return ms >= a && ms < b ? 120 : 60; };

function boot(wall) {
  const vfs = new Vfs(); const t = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', t);
  t.open('hello.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new VirtualClock(wall); clock.zone = europe;
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 64, height: 64 }), logKinds: [] });
  vm.createProcess({ exePath: 'C:\\Test\\hello.exe' });
  const mem = vm.mem, scratch = vm.proc.processHeap.alloc(0x1000, true), frame = vm.proc.processHeap.alloc(64, true);
  const call = (dll, name, ...args) => {
    args.forEach((a, i) => mem.write32(frame + 4 + 4 * i, a >>> 0));
    const c = new Ctx(vm); c.thread = vm.proc.threads[0]; c.cpu = c.thread.cpu; c.sp = frame;
    const r = vm.api.lookup(dll, name).fn(c); return r === undefined ? r : r >>> 0;
  };
  const st = (p) => [0, 2, 6, 8, 10, 12, 14].map((o) => mem.read16(p + o)); // year month day hour min sec ms
  return { vm, mem, scratch, call, st };
}

test('time zone APIs with a daylight-saving zone', { skip }, () => {
  const now = Date.UTC(2026, 6, 15, 10, 30, 0); // summer: CEST
  const { mem, scratch: p, call, st } = boot(now);
  assert.equal(call('kernel32.dll', 'GetTimeZoneInformation', p), 2, 'TIME_ZONE_ID_DAYLIGHT');
  assert.equal(mem.readS32(p), -60); assert.equal(mem.readS32(p + 84), 0); assert.equal(mem.readS32(p + 168), -60);
  assert.deepEqual([0, 2, 4, 6, 8].map((o) => mem.read16(p + 68 + o)), [0, 10, 0, 5, 3]);
  assert.deepEqual([0, 2, 4, 6, 8].map((o) => mem.read16(p + 152 + o)), [0, 3, 0, 5, 2]);
  call('kernel32.dll', 'GetLocalTime', p + 200);
  assert.deepEqual(st(p + 200), [2026, 7, 15, 12, 30, 0, 0]);
  call('kernel32.dll', 'GetSystemTime', p + 220);
  assert.deepEqual(st(p + 220), [2026, 7, 15, 10, 30, 0, 0]);
  // a winter UTC time through the TZI the program got: one hour, and back
  const ft = (ms) => BigInt(ms) * 10000n + 116444736000000000n;
  mem.write64(p + 240, ft(Date.UTC(2026, 0, 10, 8, 0)));
  call('kernel32.dll', 'FileTimeToSystemTime', p + 240, p + 260);
  call('kernel32.dll', 'SystemTimeToTzSpecificLocalTime', p, p + 260, p + 280);
  assert.deepEqual(st(p + 280), [2026, 1, 10, 9, 0, 0, 0]);
  call('kernel32.dll', 'SystemTimeToTzSpecificLocalTime', 0, p + 260, p + 300);
  assert.deepEqual(st(p + 300), [2026, 1, 10, 9, 0, 0, 0]);
  call('kernel32.dll', 'TzSpecificLocalTimeToSystemTime', p, p + 280, p + 320);
  assert.deepEqual(st(p + 320), st(p + 260));
  // FileTimeToLocalFileTime: the current bias (Windows), round trip exact
  call('kernel32.dll', 'FileTimeToLocalFileTime', p + 240, p + 340);
  assert.equal(mem.read64(p + 340) - mem.read64(p + 240), 2n * 3600n * 10000000n);
  call('kernel32.dll', 'LocalFileTimeToFileTime', p + 340, p + 360);
  assert.equal(mem.read64(p + 360), mem.read64(p + 240));
});

test('CRT localtime / gmtime / mktime in the zone', { skip }, () => {
  const { mem, scratch: p, call } = boot(Date.UTC(2026, 0, 1));
  const t = Date.UTC(2026, 6, 15, 10, 30, 5) / 1000;
  mem.write32(p, t);
  const tm = (q) => [0, 4, 8, 12, 16, 20, 24, 28, 32].map((o) => mem.readS32(q + o));
  const g = tm(call('msvcrt.dll', 'gmtime', p));
  assert.deepEqual(g, [5, 30, 10, 15, 6, 126, 3, 195, 0]);
  const lp = call('msvcrt.dll', 'localtime', p), l = tm(lp);
  assert.deepEqual(l, [5, 30, 12, 15, 6, 126, 3, 195, 1], 'local, tm_isdst set in summer');
  assert.equal(call('msvcrt.dll', 'mktime', lp), t, 'mktime inverts localtime');
  mem.write32(p, Date.UTC(2026, 0, 15, 23, 30) / 1000);
  const w = tm(call('msvcrt.dll', 'localtime', p));
  assert.deepEqual(w.slice(0, 6).concat(w[8]), [0, 30, 0, 16, 0, 126, 0], 'next day locally, no daylight saving in winter');
});

test('GetLocaleInfoA/W: sizes, LOCALE_RETURN_NUMBER, short buffer', { skip }, () => {
  const { vm, mem, scratch: p, call } = boot(0);
  const LOCALE_SDECIMAL = 0x0e, LOCALE_IDIGITS = 0x11, RETURN_NUMBER = 0x20000000, ERROR_INSUFFICIENT_BUFFER = 122;
  assert.equal(call('kernel32.dll', 'GetLocaleInfoA', 0x409, LOCALE_SDECIMAL, 0, 0), 2);
  assert.equal(call('kernel32.dll', 'GetLocaleInfoA', 0x409, LOCALE_SDECIMAL, p, 2), 2);
  assert.equal(mem.readCString(p), '.');
  assert.equal(call('kernel32.dll', 'GetLocaleInfoA', 0x409, LOCALE_SDECIMAL, p, 1), 0);
  assert.equal(vm.proc.threads[0].lastError, ERROR_INSUFFICIENT_BUFFER);
  assert.equal(call('kernel32.dll', 'GetLocaleInfoW', 0x409, LOCALE_SDECIMAL, p, 2), 2);
  assert.equal(mem.readWString(p), '.');
  assert.equal(call('kernel32.dll', 'GetLocaleInfoA', 0x409, LOCALE_IDIGITS | RETURN_NUMBER, 0, 0), 4);
  assert.equal(call('kernel32.dll', 'GetLocaleInfoW', 0x409, LOCALE_IDIGITS | RETURN_NUMBER, 0, 0), 2);
  assert.equal(call('kernel32.dll', 'GetLocaleInfoW', 0x409, LOCALE_IDIGITS | RETURN_NUMBER, p + 16, 2), 2);
  assert.equal(mem.read32(p + 16), 2);
  assert.equal(call('kernel32.dll', 'GetLocaleInfoA', 0x409, 0x01 | RETURN_NUMBER, p + 16, 4), 4);
  assert.equal(mem.read32(p + 16), 0x409, 'LOCALE_ILANGUAGE is hexadecimal');
  assert.equal(call('kernel32.dll', 'GetLocaleInfoA', 0x409, 0x5b, p, 8), 4, 'LOCALE_IGEOID (answered before the table was re-keyed)');
  assert.equal(mem.readCString(p), '244');
});
