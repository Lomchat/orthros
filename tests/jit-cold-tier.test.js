// The JIT's cold tier (Jit.runCold): with a background translator, a missed entry is asked of it and its code
// interpreted meanwhile, up to a number of instructions per entry (then translated on the spot). Same results as
// translated code; an instruction writing a page holding translated code is translated (its store then leaves with
// an SMC exit and the stale translation is dropped); code rewritten where nothing is translated is decoded again;
// faults are precise; the entries reach the background worker and its regions are installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { handleMessage } from '../src/cpu/jit/bg-translate.js';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

const hex = (s) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));
const CODE = 0x20000000, DATA = 0x10000000, OUT = 0x10001000, CW = 0x10002000;
// the x87 loop of jit-prewarm.test.js (mode switches, a local call, a conditional branch), 20 iterations
const X87_LOOP = hex('b914000000d906d84e04d99f00020000f7c1010000007404d92beb03d96b02d94608d8760cdd1ccfe8040000004975d5f4d97b08d96b04d94610db9c8f00010000d96b08c3');

function setup(code, { cold = true, bg = true } = {}) {
  const mem = new GuestMemory({ shared: true });
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, code);
  [1.1, 3.3, 1.0, 3.0, 2.7].forEach((v, i) => mem.writeF32(DATA + 4 * i, v));
  mem.write16(CW, 0x027f); mem.write16(CW + 2, 0x007f); mem.write16(CW + 4, 0x0c7f);
  cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.esi = DATA; cpu.edi = OUT; cpu.ebx = CW; cpu.eflags = F.RESERVED1 | F.IF;
  mem.write16(cpu.base + ST.FPU_CW, 0x007f);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, coldTier: cold, warn: (m) => { throw new Error(m); } });
  jit.cpu = cpu;
  const replies = [];
  if (bg) jit.attachBackground({ postMessage: (m) => handleMessage(m, (r) => replies.push(r)) });
  return { mem, cpu, jit, replies };
}
/** run to the end as the VM does: time slices go on, SMC exits invalidate the range written */
function runAll({ jit, mem, cpu }) {
  for (let n = 0; n < 1e5; n++) {
    const r = jit.run({ maxInsns: 1e5 });
    if (r === EXIT.SMC) {
      const len = mem.read32(cpu.base + ST.EXIT_LEN) || 16; mem.write32(cpu.base + ST.EXIT_LEN, 0);
      jit.interp.invalidate(cpu.exitArg, len); jit.invalidate(cpu.exitArg, len);
      continue;
    }
    if (r !== EXIT.TIMESLICE) return r;
  }
  throw new Error('no end');
}
const regs = (cpu) => [cpu.eax, cpu.ebx, cpu.ecx, cpu.edx, cpu.esi, cpu.edi, cpu.esp, cpu.ebp, cpu.eip].map((v) => v >>> 0);

test('x87 code run by the cold tier gives the translated code\'s results; its entries go to the background worker', () => {
  const a = setup(X87_LOOP, { cold: false });
  assert.equal(runAll(a), EXIT.HALT);
  const b = setup(X87_LOOP);
  assert.equal(runAll(b), EXIT.HALT);
  assert.deepEqual(regs(b.cpu), regs(a.cpu));
  assert.equal(Buffer.from(b.mem.bytes(OUT, 0x300)).toString('hex'), Buffer.from(a.mem.bytes(OUT, 0x300)).toString('hex'));
  assert.equal(b.mem.read16(b.cpu.base + ST.FPU_CW), a.mem.read16(a.cpu.base + ST.FPU_CW));
  assert.ok(b.jit.stats.coldEntries >= 1 && b.jit.stats.coldSteps > 100, JSON.stringify(b.jit.stats));
  assert.equal(b.jit.stats.misses, 1, 'nothing translated on this thread but the final HLT (never interpreted)');
  const sent = b.jit.flushCold();
  assert.equal(sent, b.jit.stats.coldEntries);
  for (const r of b.replies) b.jit.bgInstall(r);
  assert.equal(b.jit.bg.installed, sent);
  // a second run of the same code: the installed regions, no interpretation
  const steps = b.jit.stats.coldSteps;
  b.cpu.eip = CODE; b.cpu.esp = DATA + 0x8000; b.cpu.esi = DATA; b.cpu.edi = OUT; b.cpu.ebx = CW;
  assert.equal(runAll(b), EXIT.HALT);
  assert.equal(b.jit.stats.coldSteps, steps);
  assert.equal(b.jit.stats.misses, 1);
});

test('a hot loop is translated on the spot once its entry has run COLD_LIMIT instructions', () => {
  // mov ecx, 100000; L: add eax, ecx; dec ecx; jnz L; hlt
  const s = setup(hex('b9a0860100 01c8 49 75fb f4'));
  assert.equal(runAll(s), EXIT.HALT);
  assert.equal(s.cpu.eax >>> 0, (100000 * 100001 / 2) >>> 0);
  assert.ok(s.jit.stats.coldHot >= 1 && s.jit.stats.misses >= 1, JSON.stringify(s.jit.stats));
  assert.ok(s.jit.stats.coldSteps < 5000, 'interpreted a bounded number of instructions');
});

test('a store into a page holding translated code is not interpreted: the translation is dropped (SMC)', () => {
  const FN = CODE + 0x3000;
  // main: nop; mov byte [FN+1], 2; call FN; hlt     FN: mov eax, 1; ret
  const code = new Uint8Array(0x3006);
  code.set(hex('90 c605' + [FN + 1].map((v) => [0, 8, 16, 24].map((k) => ((v >>> k) & 255).toString(16).padStart(2, '0')).join('')).join('') + '02'), 0);
  const call = CODE + 8, rel = (FN - (call + 5)) >>> 0;
  code.set([0xe8, rel & 255, (rel >>> 8) & 255, (rel >>> 16) & 255, rel >>> 24, 0xf4], 8);
  code.set(hex('b801000000c3'), 0x3000);
  const s = setup(code);
  s.jit.translate(FN, null, null); // (FN translated: its page is flagged)
  s.cpu.esp = DATA + 0x8000;
  assert.equal(runAll(s), EXIT.HALT);
  assert.equal(s.cpu.eax >>> 0, 2, 'the rewritten FN ran');
});

test('code rewritten where nothing is translated is decoded again by the cold tier', () => {
  const s = setup(hex('b805000000 f4')); // mov eax, 5; hlt
  assert.equal(runAll(s), EXIT.HALT);
  assert.equal(s.cpu.eax, 5);
  assert.equal(s.jit.stats.misses, 1, 'the HLT only');
  s.mem.write32(CODE + 1, 7); // (no SMC exit: the page holds no translation)
  s.cpu.eip = CODE;
  assert.equal(runAll(s), EXIT.HALT);
  assert.equal(s.cpu.eax, 7);
});

test('a fault in interpreted code is precise (EIP at the instruction)', () => {
  const s = setup(hex('90 31c9 f7f1 f4')); // nop; xor ecx, ecx; div ecx; hlt
  assert.equal(runAll(s), EXIT.FAULT);
  assert.equal(s.cpu.exitArg, 0, '#DE');
  assert.equal(s.cpu.eip >>> 0, CODE + 3);
  assert.equal(s.jit.stats.misses, 0, 'interpreted');
});

test('without a background translator the cold tier is not used', () => {
  const s = setup(X87_LOOP, { bg: false });
  assert.equal(runAll(s), EXIT.HALT);
  assert.ok(!s.jit.stats.coldEntries);
  assert.ok(s.jit.stats.misses >= 1);
});

// ---- whole programs: the test PEs give the same output with the cold tier (regions installed between slices)
const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
function bootPe(exe, cold) {
  const vfs = new Vfs(), dir = new MemBackend(); vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open(exe, { create: true }).write(0, fs.readFileSync(PE_DIR + exe));
  const clock = new VirtualClock(), host = new HeadlessHost({ clock, width: 800, height: 600 });
  const vm = new Vm({ vfs, clock, host, jit: true, sharedMemory: true, logKinds: ['warn', 'crash'], nullPage: exe === 'seh.exe' ? true : undefined }); // (seh.exe: its null-page cases read)
  if (cold) {
    const replies = [];
    vm.jit.attachBackground({ postMessage: (m) => handleMessage(m, (r) => replies.push(r)) });
    vm.jit.coldTier = true;
    const sliceEnd = vm.sliceEnd.bind(vm);
    vm.sliceEnd = (t, o) => { vm.jit.flushCold(); for (const r of replies.splice(0)) vm.jit.bgInstall(r); return sliceEnd(t, o); };
  }
  vm.createProcess({ exePath: 'C:\\Test\\' + exe });
  return vm;
}
for (const exe of ['hello.exe', 'seh.exe', 'threads.exe', 'sync.exe', 'bench.exe', 'dx9state.exe']) {
  test(`${exe}: the same output with the cold tier`, { skip: !fs.existsSync(PE_DIR + exe) && `build/pe/${exe} missing (make pe-tests)` }, () => {
    const a = bootPe(exe, false), codeA = a.run();
    const b = bootPe(exe, true), codeB = b.run();
    assert.equal(codeB, codeA);
    assert.equal(b.stdout.join(''), a.stdout.join(''));
    assert.ok(b.jit.stats.coldEntries > 0, 'code interpreted by the cold tier');
    assert.ok(b.jit.stats.misses < a.jit.stats.misses, `fewer translations on the game thread: ${b.jit.stats.misses} vs ${a.jit.stats.misses} (${b.jit.bg.installed} from the background)`);
  });
}

// stores the cold tier must leave to translation: a dword straddling into the next page, which holds translated code,
// and a push whose stack slot is in a page holding translated code
test('a store straddling into a page holding translated code, and a push onto one, are not interpreted', () => {
  const FN = CODE + 0x3000;
  // main: nop; mov dword [FN-2], 0x02b80000 (bytes 00 00 | b8 02: FN's first two bytes, FN becomes mov eax, 2);
  // call FN; hlt     FN: mov eax, 1; ret
  const code = new Uint8Array(0x3006);
  const a = FN - 2;
  code.set([0x90, 0xc7, 0x05, a & 255, (a >>> 8) & 255, (a >>> 16) & 255, a >>> 24, 0x00, 0x00, 0xb8, 0x02], 0);
  const call = CODE + 11, rel = (FN - (call + 5)) >>> 0;
  code.set([0xe8, rel & 255, (rel >>> 8) & 255, (rel >>> 16) & 255, rel >>> 24, 0xf4], 11);
  code.set(hex('b801000000c3'), 0x3000);
  const s = setup(code);
  s.jit.translate(FN, null, null);
  assert.equal(runAll(s), EXIT.HALT);
  assert.equal(s.cpu.eax >>> 0, 2, 'the rewritten FN ran');

  // a push whose slot is in a page holding translated code (ESP just past FN's first dword) is left to translation (the
  // cold tier's gate; translated code does not catch such a push as SMC either: stack stores are not checked)
  const t = setup(hex('68b8020000 f4'));
  t.jit.translate(FN, null, null);
  t.cpu.esp = FN + 4;
  assert.equal(t.jit.coldSafe(CODE), null);
  t.cpu.esp = FN - 0x100; // (the slot in the page before: interpreted)
  assert.notEqual(t.jit.coldSafe(CODE), null);
});
