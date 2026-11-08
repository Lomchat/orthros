// The manifest's patches of a module's code (process.js applyPatches): applied only over the bytes they expect, their
// own code placed where nothing else goes (above the main thread's stack, made under 0x130000 after the exe loads —
// a patch's code once put at 0x120000 was overwritten by the stack: BFME crashed in its skirmish menu).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { PeImage } from '../src/loader/pe.js';

const EXE = new URL('../build/pe/hello.exe', import.meta.url).pathname;
const skip = !fs.existsSync(EXE) && 'build/pe/hello.exe missing (make pe-tests)';

function boot(bytes, patches) {
  const vfs = new Vfs(); vfs.mount('C:\\', new MemBackend());
  const clock = new VirtualClock(Date.UTC(2026, 0, 1)), warnings = [];
  const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 640, height: 480 }), logKinds: ['warn'] });
  vm.logFn = (kind, msg) => warnings.push(msg);
  vm.createProcess({ exePath: 'C:\\hello.exe', exeBytes: bytes, patches });
  return { m: vm.mem, warnings };
}

test('manifest patches: checked bytes, own code above the main stack', { skip }, () => {
  const bytes = fs.readFileSync(EXE), img = new PeImage(bytes), at = img.imageBase + img.entryRva, rva = '0x' + img.entryRva.toString(16);
  const hex = (m, a, n) => Array.from(m.u8.subarray(a, a + n), (b) => b.toString(16).padStart(2, '0')).join('');
  const orig = hex(boot(bytes, []).m, at, 16);
  const { m, warnings } = boot(bytes, [
    { module: 'HELLO.EXE', rva, from: orig.slice(0, 14), call: 'c3' },
    { module: 'hello.exe', rva: '0x' + (img.entryRva + 8).toString(16), from: 'f1f2f3f4f5f6f7', to: '90909090909090' },
  ]);
  const cave = (m.read32(at + 1) + at + 5) >>> 0;
  assert.equal(m.u8[at], 0xe8, 'a call in place of the patched bytes');
  assert.deepEqual([m.u8[at + 5], m.u8[at + 6]], [0x90, 0x90], 'the rest nops');
  assert.equal(m.u8[cave], 0xc3, 'its code where the call goes');
  assert.ok(cave >= 0x130000, `its code at ${cave.toString(16)}, not under the main stack`);
  assert.ok(warnings.some((w) => /patch skipped, other bytes there/.test(w)), 'the patch over other bytes is skipped');
  assert.equal(hex(m, at + 8, 7), orig.slice(16, 30), 'left as it was');
});
