// Debugging facilities of the JIT (src/cpu/jit/listing.js, Jit opts.blockCounts): the WASM listing of a region per guest
// instruction with its block structure, and per-block execution counters of profiling translations — exact counts,
// shared by every translation of a run, no effect on what the code computes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, BLOCK_COUNTS_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { listRegion } from '../src/cpu/jit/listing.js';
import { allocBlockCounters, translateRegion } from '../src/cpu/jit/translate.js';
import { Code } from '../src/cpu/jit/wasm.js';

const CODE = 0x20000000, DATA = 0x10000000;
// xor eax, eax ; L: add eax, [esi+ecx*4] ; inc ecx ; cmp ecx, edx ; jl L ; hlt
const LOOP = [0x31, 0xc0, 0x03, 0x04, 0x8e, 0x41, 0x39, 0xd1, 0x7c, 0xf8, 0xf4];

function runLoop(opts, slice = 1e7) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, Uint8Array.from(LOOP));
  for (let k = 0; k < 100; k++) mem.write32(DATA + 4 * k, k * 3);
  cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.esi = DATA; cpu.ecx = 0; cpu.edx = 100; cpu.eflags = F.RESERVED1 | F.IF;
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true, ...opts }); jit.cpu = cpu;
  let r; do r = jit.run({ stopAt: CODE + LOOP.length - 1, maxInsns: slice }); while (r === EXIT.TIMESLICE);
  return { mem, cpu, jit };
}

test('block counters count every entry of every block (whole and time-sliced runs), results unchanged', () => {
  const plain = runLoop({});
  for (const slice of [1e7, 3, 7]) {
    const { cpu, jit } = runLoop({ blockCounts: true }, slice);
    assert.equal(cpu.eax >>> 0, plain.cpu.eax >>> 0);
    const r = jit.regionAt(CODE);
    assert.ok(r && r.counters >= 0, 'the region has counters');
    const counts = jit.blockCounts(r);
    const byEip = new Map(r.blocks.map((b, i) => [b.eip, counts[i]]));
    // (time slices re-enter the region: the loop block still counts one entry per iteration)
    assert.equal(byEip.get(CODE + 2), 100, `loop body entries (slices of ${slice}): ${[...byEip]}`);
    assert.equal(jit.blockCounts(jit.regionAt(CODE + 2)).length, r.blocks.length);
  }
  assert.equal(plain.jit.blockCounts(plain.jit.regionAt(CODE)), null, 'no counters without blockCounts');
});

test('the counter area is shared and bounded', () => {
  const mem = new GuestMemory();
  const a = allocBlockCounters(mem, 10), b = allocBlockCounters(mem, 5);
  assert.equal(a, BLOCK_COUNTS_BASE + 4);
  assert.equal(b, a + 40);
  assert.equal(allocBlockCounters(mem, 1e9), -1);
});

test('listing: blocks, terminators, successors, per-instruction operations and counts', () => {
  const { mem, jit } = runLoop({ blockCounts: true });
  const r = jit.regionAt(CODE);
  const { text, groups, summary } = listRegion(mem, r.entry, { ...jit.translateOpts(r.fnIdx, r.fpc), blockCounts: false }, { counts: jit.blockCounts(r) });
  assert.match(text, /-- block 1 @20000002\.\.2000000a: 4 insns, jcc, -> 20000002, 2000000a, loop depth 1.*executed 100/);
  assert.match(text, /20000002 {2}add eax, dword ptr \[esi\+ecx\*4\]/);
  assert.match(text, /region epilogue/);
  const add = groups.find((g) => g.label.includes('add eax'));
  assert.ok(add.ops.includes('i32load 0,0') && add.ops.includes('set lzop'), add.ops.join(' | '));
  assert.ok(summary.mem >= 1 && summary.local > 0);
  // the listing translates as the JIT does, and leaves the emitter as it was (its hooks removed)
  const getBefore = Code.prototype.get;
  const listed = listRegion(mem, r.entry, { smc: true }).result.code;
  assert.equal(Code.prototype.get, getBefore);
  assert.deepEqual([...translateRegion(mem, r.entry, { smc: true }).code], [...listed]);
});
