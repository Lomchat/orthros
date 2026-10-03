// Regions translated ahead: the JIT records the entries it translated at a miss (with the x87 mode it assumed); a
// later run given that list translates them before executing anything (Jit.prewarm, or the background worker:
// bg-translate.js, Jit.bgPrewarm / bgInstall) and then runs without a miss, with the interpreter's results. A prewarm
// of an address without memory, or already translated, does nothing; a background translation whose code changed is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import { Jit } from '../src/cpu/jit/jit.js';

// the loop of jit-fpu-mode-guard.test.js: x87 code with mode switches, a local call, a conditional branch
const CODE_HEX = 'b914000000d906d84e04d99f00020000f7c1010000007404d92beb03d96b02d94608d8760cdd1ccfe8040000004975d5f4d97b08d96b04d94610db9c8f00010000d96b08c3';
const CODE = 0x20000000, DATA = 0x10000000, OUT = 0x10001000, CW = 0x10002000;
const bytes = Uint8Array.from(CODE_HEX.match(/../g).map((h) => parseInt(h, 16)));

function setup() {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, bytes);
  [1.1, 3.3, 1.0, 3.0, 2.7].forEach((v, i) => mem.writeF32(DATA + 4 * i, v));
  mem.write16(CW, 0x027f); mem.write16(CW + 2, 0x007f); mem.write16(CW + 4, 0x0c7f);
  cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.esi = DATA; cpu.edi = OUT; cpu.ebx = CW; cpu.eflags = F.RESERVED1 | F.IF;
  mem.write16(cpu.base + ST.FPU_CW, 0x007f);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  return { mem, cpu, jit };
}
const runAll = (jit) => { let r, n = 0; do r = jit.run({ maxInsns: 1e6 }); while (r === EXIT.TIMESLICE && ++n < 1e4); return r; };

test('regions learned by one run are translated ahead by the next: no miss, same results', () => {
  const a = setup();
  a.jit.learned = [];
  assert.equal(runAll(a.jit), EXIT.HALT);
  assert.ok(a.jit.learned.length >= 1);
  assert.equal(a.jit.learned.length, a.jit.stats.misses, 'one entry per miss');
  assert.ok(a.jit.learned.some(([, fpc]) => fpc === 0), 'the x87 mode assumed (24-bit) is kept');

  const b = setup();
  for (const [eip, fpc] of a.jit.learned) assert.equal(b.jit.prewarm(eip, fpc), true);
  assert.equal(b.jit.prewarm(a.jit.learned[0][0], a.jit.learned[0][1]), false, 'already translated');
  assert.equal(b.jit.prewarm(0x7000, null), false, 'no memory there');
  assert.equal(b.jit.stats.prewarmed, a.jit.learned.length);
  assert.equal(runAll(b.jit), EXIT.HALT);
  assert.equal(b.jit.stats.misses, 0, 'every region was ready');
  assert.equal(Buffer.from(b.mem.bytes(OUT, 0x300)).toString('hex'), Buffer.from(a.mem.bytes(OUT, 0x300)).toString('hex'));
});

// ---- the same regions translated by the background worker (bg-translate.js, driven here without a worker)
import { handleMessage } from '../src/cpu/jit/bg-translate.js';
function setupShared() {
  const mem = new GuestMemory({ shared: true }); // (shared: the background worker reads it)
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, bytes);
  [1.1, 3.3, 1.0, 3.0, 2.7].forEach((v, i) => mem.writeF32(DATA + 4 * i, v));
  mem.write16(CW, 0x027f); mem.write16(CW + 2, 0x007f); mem.write16(CW + 4, 0x0c7f);
  cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.esi = DATA; cpu.edi = OUT; cpu.ebx = CW; cpu.eflags = F.RESERVED1 | F.IF;
  mem.write16(cpu.base + ST.FPU_CW, 0x007f);
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, warn: (m) => { throw new Error(m); } });
  jit.cpu = cpu;
  const replies = [];
  jit.attachBackground({ postMessage: (m) => handleMessage(m, (r) => replies.push(r)) });
  return { mem, cpu, jit, replies };
}

test('regions translated by the background worker are installed and run like the others', () => {
  const a = setup();
  a.jit.learned = [];
  assert.equal(runAll(a.jit), EXIT.HALT);
  const b = setupShared();
  const n = b.jit.bgPrewarm(a.jit.learned.map(([eip, fpc]) => [eip, fpc]));
  assert.equal(n, a.jit.learned.length);
  assert.equal(b.replies.length, 1, 'one batch');
  b.jit.bgInstall(b.replies[0]);
  assert.equal(b.jit.bg.installed, n);
  assert.equal(b.jit.bgPending(), 0);
  assert.equal(runAll(b.jit), EXIT.HALT);
  assert.equal(b.jit.stats.misses, 0, 'every region was ready');
  assert.equal(Buffer.from(b.mem.bytes(OUT, 0x300)).toString('hex'), Buffer.from(a.mem.bytes(OUT, 0x300)).toString('hex'));
});

test('a background translation is dropped when its code changed before the install, or was translated meanwhile', () => {
  const b = setupShared();
  b.jit.bgPrewarm([[CODE, 0]]);
  const old = b.mem.read8(CODE + 1);
  b.mem.write8(CODE + 1, old ^ 1); // (mov ecx, imm32: another loop count)
  b.jit.bgInstall(b.replies[0]);
  assert.equal(b.jit.bg.installed, 0);
  assert.equal(b.jit.bg.rejected, 1);
  b.mem.write8(CODE + 1, old);
  b.jit.bgPrewarm([[CODE, 0]]);
  b.jit.translate(CODE, null, 0); // (a miss translated it first)
  b.jit.bgInstall(b.replies[1]);
  assert.equal(b.jit.bg.installed, 0);
  assert.equal(b.jit.bg.rejected, 2);
  assert.equal(runAll(b.jit), EXIT.HALT);
});

test('learned entries that are blocks of a region the background worker translated before are skipped, not translated', () => {
  const a = setup();
  a.jit.learned = [];
  assert.equal(runAll(a.jit), EXIT.HALT);
  const blocks = a.jit.byEntry.get(CODE).blocks.map((x) => x.eip).filter((e) => e !== CODE);
  assert.ok(blocks.length >= 2, 'the region has blocks past its entry');
  // (the entries in one batch, interior blocks after the region holding them: the install would drop them)
  const b = setupShared();
  b.jit.coveredLearned = [];
  const list = [[CODE, 0], ...blocks.map((e) => [e, 0]), ...a.jit.learned.filter(([e]) => e !== CODE && !blocks.includes(e))];
  const n = b.jit.bgPrewarm(list);
  assert.equal(n, list.length);
  b.jit.bgInstall(b.replies[0]);
  assert.equal(b.jit.bg.covered, blocks.length);
  assert.deepEqual(b.jit.coveredLearned, blocks.map((e) => [e, 0]), 'reported (the server forgets them)');
  assert.equal(b.jit.bg.rejected, 0, 'nothing translated for the install to drop');
  assert.equal(b.jit.bg.installed, n - blocks.length);
  for (const e of blocks) assert.equal(b.jit.blockMap.get(e).region.entry, CODE, 'reached through the region holding it');
  assert.equal(runAll(b.jit), EXIT.HALT);
  assert.equal(Buffer.from(b.mem.bytes(OUT, 0x300)).toString('hex'), Buffer.from(a.mem.bytes(OUT, 0x300)).toString('hex'));
});

test('entries skipped as blocks of a region the emulator then did not install are asked again, once, and installed', () => {
  const a = setup();
  a.jit.learned = [];
  assert.equal(runAll(a.jit), EXIT.HALT);
  const blocks = a.jit.byEntry.get(CODE).blocks.map((x) => x.eip).filter((e) => e !== CODE);
  const b = setupShared();
  b.jit.bgPrewarm([[CODE, 0], ...blocks.map((e) => [e, 0])]);
  const old = b.mem.read8(CODE + 1);
  b.mem.write8(CODE + 1, old ^ 1); // (the region at CODE changed before its install: dropped)
  b.jit.bgInstall(b.replies[0]);
  assert.equal(b.jit.bg.rejected, 1);
  assert.equal(b.jit.bg.covered, 0, 'none of them counted as covered: asked again');
  assert.equal(b.replies.length, 2, 'a second batch with the skipped entries');
  b.jit.bgInstall(b.replies[1]);
  assert.ok(b.jit.bg.installed >= 1, 'the entries are translated on their own');
  assert.ok(blocks.some((e) => b.jit.byEntry.has(e)));
  assert.equal(b.replies.length, 2, 'asked again once only');
  // the same results as a run of the changed code without anything translated ahead
  const c = setup();
  c.mem.write8(CODE + 1, old ^ 1);
  assert.equal(runAll(c.jit), EXIT.HALT);
  assert.equal(runAll(b.jit), EXIT.HALT);
  assert.equal(Buffer.from(b.mem.bytes(OUT, 0x300)).toString('hex'), Buffer.from(c.mem.bytes(OUT, 0x300)).toString('hex'));
});

test('a batch made only of skipped entries is handled too: counted and reported when covered, asked again when not', () => {
  const a = setup();
  a.jit.learned = [];
  assert.equal(runAll(a.jit), EXIT.HALT);
  const blocks = a.jit.byEntry.get(CODE).blocks.map((x) => x.eip).filter((e) => e !== CODE);
  // installed covering region, its blocks in a later batch of their own (no module comes back for it)
  const b = setupShared();
  b.jit.coveredLearned = [];
  b.jit.bgPrewarm([[CODE, 0]]);
  b.jit.bgPrewarm(blocks.map((e) => [e, 0]));
  assert.equal(b.replies[1].module, null, 'nothing translated in the second batch');
  b.jit.bgInstall(b.replies[0]); b.jit.bgInstall(b.replies[1]);
  assert.equal(b.jit.bg.covered, blocks.length);
  assert.deepEqual(b.jit.coveredLearned, blocks.map((e) => [e, 0]));
  assert.equal(b.jit.bgPending(), 0);
  // covering region not installed: the entries of the all-skipped batch are asked again
  const c = setupShared();
  c.jit.coveredLearned = [];
  c.jit.bgPrewarm([[CODE, 0]]);
  c.jit.bgPrewarm(blocks.map((e) => [e, 0]));
  const old = c.mem.read8(CODE + 1);
  c.mem.write8(CODE + 1, old ^ 1);
  c.jit.bgInstall(c.replies[0]); c.jit.bgInstall(c.replies[1]);
  assert.equal(c.jit.bg.covered, 0);
  assert.deepEqual(c.jit.coveredLearned, []);
  assert.equal(c.replies.length, 3, 'asked again');
  c.jit.bgInstall(c.replies[2]);
  assert.ok(blocks.some((e) => c.jit.byEntry.has(e)));
  assert.equal(c.jit.bgPending(), 0);
});

test('an entry translated as its own region is not reported as a block of another', () => {
  const a = setup();
  a.jit.learned = [];
  assert.equal(runAll(a.jit), EXIT.HALT);
  const blocks = a.jit.byEntry.get(CODE).blocks.map((x) => x.eip).filter((e) => e !== CODE);
  const b = setupShared();
  b.jit.coveredLearned = [];
  b.jit.bgPrewarm([[CODE, 0]]);
  b.jit.bgPrewarm([[blocks[0], 0]]);
  b.mem.write8(CODE + 1, b.mem.read8(CODE + 1) ^ 1); // (the covering region is dropped)
  b.jit.bgInstall(b.replies[0]);
  // the game reaches the block first: translated here, as a region of its own
  b.jit.prewarm(blocks[0], 0);
  assert.equal(b.jit.blockMap.get(blocks[0]).region.entry, blocks[0]);
  b.jit.bgInstall(b.replies[1]);
  assert.deepEqual(b.jit.coveredLearned, [], 'its own region: still a learned entry');
});
