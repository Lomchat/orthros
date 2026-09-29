// Self-modifying-code detection on the JIT's stores (translate.js Emitter.smcCheck): one SMC map byte read per
// store, whose SMC_NEXT bit (the next page holds translated code) sends a store that ends past its page to a cold
// path deciding whether it reached the code page. Unaligned stores of every width written just before a code page
// (crossing into it, or stopping right before it) under the JIT with the VM's SMC handling, against the interpreter;
// the SMC_NEXT bit kept in step with the translations (set by a region, cleared when the last one of its page goes,
// write watches beside it); a hot loop storing just below a code page takes no SMC exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE, SMC_CODE, SMC_WATCH, SMC_NEXT } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';

const CODE = 0x20000000, DATA = 0x10000000;
const FN = CODE; // the callee, first bytes of its page
const MAIN = CODE + 0x2000; // two pages further: its own page, not next to the store's
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');

function makeExec(useJit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  // the reference decodes every instruction afresh (its decode cache is invalidated by the VM, not by stores)
  if (!useJit) I.cache = new (class extends Map { set() { return this; } })();
  const jit = useJit ? new Jit(mem, I, { smc: true }) : null;
  if (jit) jit.cpu = cpu;
  return { mem, cpu, jit, I };
}

/**
 * main: mov eax, 0x11 ; call FN ; mov ebx, eax ; mov edi, <at> ; <store> ; mov eax, 0x11 ; call FN ; hlt
 * FN: mov eax, 1 ; ret      — the store (at FN - k, k bytes before the code page) may rewrite FN's first bytes.
 * `noCall`: the second call left out (a store whose bytes do not leave FN runnable). Returns the registers, the
 * bytes around FN and the number of SMC exits (JIT).
 */
function run(useJit, at, store, { noCall = false } = {}) {
  const E = makeExec(useJit);
  const { mem, cpu } = E;
  cpu.reset();
  mem.fill(FN - 0x1000, 0x4000, 0xcc);
  mem.writeBytes(FN, Uint8Array.from([0xb8, 1, 0, 0, 0, 0xc3]));
  const main = [0xb8, ...le(0x11), 0xe8, ...le(FN - (MAIN + 10)), 0x89, 0xc3, 0xbf, ...le(at), ...store, 0xb8, ...le(0x11)];
  if (!noCall) main.push(0xe8, ...le(FN - (MAIN + main.length + 5)));
  main.push(0xf4);
  mem.writeBytes(MAIN, Uint8Array.from(main));
  cpu.eip = MAIN; cpu.esp = DATA + 0x800; cpu.eflags = F.RESERVED1 | F.IF;
  mem.write16(cpu.base + ST.SEG + 2 * 3, 0xc32b); // DS (a value whose high byte is a RET: see `mov [edi], ds`)
  mem.fill(DATA, 64, 0xc3); // (the loaded vectors: RETs; at DATA+32 an f80 whose significand's top byte is one)
  mem.writeBytes(DATA + 32, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0xc3, 0xc3, 0x43]));
  const end = MAIN + main.length - 1;
  let r, smc = 0;
  if (!useJit) r = E.I.run({ stopAt: end, maxInsns: 1e6 });
  else {
    // as the VM does: an SMC exit invalidates the written range (EXIT_ARG, EXIT_LEN) and resumes
    while ((r = E.jit.run({ stopAt: end, maxInsns: 1e6 })) === EXIT.SMC) {
      const len = mem.read32(cpu.base + ST.EXIT_LEN) || 16; mem.write32(cpu.base + ST.EXIT_LEN, 0);
      E.jit.invalidate(cpu.exitArg, len); smc++;
    }
  }
  assert.equal(r, EXIT.HALT);
  return { out: { eax: cpu.eax >>> 0, ebx: cpu.ebx >>> 0, bytes: hex([...mem.bytes(FN - 32, 40)]) }, smc, E };
}

// [name, offset below FN (edi = FN - offset), store bytes, crosses into FN's page, options]
const CASES = [
  ['mov dword [edi], 0x02b8cccc (2 bytes into the page: mov eax, 2)', 2, [0xc7, 0x07, ...le(0x02b8cccc)], true],
  ['mov dword [edi], 0xc3cccccc (1 byte: ret)', 3, [0xc7, 0x07, ...le(0xc3cccccc)], true],
  ['mov dword [edi], 0x0007b8cc (3 bytes)', 1, [0xc7, 0x07, ...le(0x0007b8cc)], true],
  ['mov dword [edi] ending right before the page', 4, [0xc7, 0x07, ...le(0xc3c3c3c3)], false],
  ['mov dword [edi] ending 2 bytes before the page', 6, [0xc7, 0x07, ...le(0xc3c3c3c3)], false],
  ['mov word [edi], 0xc3cc', 1, [0x66, 0xc7, 0x07, 0xcc, 0xc3], true],
  ['mov word [edi] ending right before the page', 2, [0x66, 0xc7, 0x07, 0xc3, 0xc3], false],
  ['mov byte [edi], 0xc3 (last byte of the page before)', 1, [0xc6, 0x07, 0xc3], false],
  ['add dword [edi], 0x01000000 (read-modify-write: b8 -> b9, mov ecx, 1)', 3, [0x81, 0x07, ...le(0x01000000)], true],
  ['xchg [edi], eax', 2, [0xb8, ...le(0x03b8cccc), 0x87, 0x07], true],
  ['pop dword [edi]', 2, [0x68, ...le(0x04b8cccc), 0x8f, 0x07], true],
  ['mov [edi], ds (word, FN[0] = 0xc3)', 1, [0x8c, 0x1f], true],
  ['movups [edi], xmm0 (15 bytes before, 1 into the page)', 15, [0x0f, 0x10, 0x05, ...le(DATA), 0x0f, 0x11, 0x07], true],
  ['movups [edi], xmm0 ending right before the page', 16, [0x0f, 0x10, 0x05, ...le(DATA), 0x0f, 0x11, 0x07], false],
  ['movq [edi], xmm0 (8 bytes, 1 into the page)', 7, [0xf3, 0x0f, 0x7e, 0x05, ...le(DATA), 0x66, 0x0f, 0xd6, 0x07], true],
  ['fstp qword [edi] (8 bytes, 1 into the page)', 7, [0xdd, 0x05, ...le(DATA), 0xdd, 0x1f], true],
  ['fstp tword [edi] (10 bytes, 3 into the page)', 7, [0xdb, 0x2d, ...le(DATA + 32), 0xdb, 0x3f], true],
  ['fstp tword [edi] ending right before the page', 10, [0xdb, 0x2d, ...le(DATA + 32), 0xdb, 0x3f], false],
  ['fnstenv [edi] (28 bytes, 4 into the page)', 24, [0xd9, 0x37], true, { noCall: true }],
  ['fnsave [edi] (108 bytes, 8 into the page)', 100, [0xdd, 0x37], true, { noCall: true }],
  ['fnsave [edi] ending right before the page', 108, [0xdd, 0x37], false, { noCall: true }],
];

test('stores crossing from a data page into a translated code page are detected (and only those)', () => {
  for (const [name, off, store, crosses, opts] of CASES) {
    const I = run(false, FN - off, store, opts);
    const J = run(true, FN - off, store, opts);
    assert.deepEqual(J.out, I.out, name);
    if (crosses) assert.ok(J.smc >= 1, `${name}: SMC exit`);
    else assert.equal(J.smc, 0, `${name}: no SMC exit for a store that stays on its page`);
  }
});

test('the SMC_NEXT bit follows the translations of the next page, beside write watches', () => {
  const { E } = run(true, FN - 8, [0xc7, 0x07, ...le(0)]); // (nothing rewritten: FN still translated)
  const { mem, jit } = E;
  const P = FN >>> 12, map = (p) => mem.u8[SMC_MAP_BASE + p];
  assert.equal(map(P) & SMC_CODE, SMC_CODE);
  assert.equal(map(P - 1), SMC_NEXT, 'the page before the code: SMC_NEXT only');
  // a write watch on the page before keeps the bit; the page's code stays unwatched
  jit.watchWrites(FN - 0x100, 0x10, 'w');
  assert.equal(map(P - 1), SMC_NEXT | SMC_WATCH);
  jit.unwatch('w');
  assert.equal(map(P - 1), SMC_NEXT);
  // the last region of the page dropped: both bits go
  jit.invalidate(FN, 1);
  jit.invalidate(MAIN, 1);
  assert.equal(map(P) & SMC_CODE, 0);
  assert.equal(map(P - 1) & SMC_NEXT, 0);
  // a page that holds code and precedes code has both bits; dropping the next page's code keeps its own
  jit.translate(FN); jit.translate(FN - 0x1000 + 0x10);
  assert.equal(map(P - 1), SMC_CODE | SMC_NEXT);
  jit.invalidate(FN, 1);
  assert.equal(map(P - 1), SMC_CODE);
});

test('a loop storing into the last bytes of the page before its own code takes no SMC exit', () => {
  // code at the start of a page; the loop writes the 4 bytes just before it (one page below) N times
  // L: mov [edi], ecx ; mov word [edi+2], cx ; dec ecx ; jnz L ; hlt
  const E = makeExec(true), { mem, cpu } = E;
  cpu.reset();
  const code = Uint8Array.from([0x89, 0x0f, 0x66, 0x89, 0x4f, 0x02, 0x49, 0x75, 0xf7, 0xf4]);
  mem.writeBytes(CODE, code);
  cpu.eip = CODE; cpu.esp = DATA + 0x800; cpu.edi = CODE - 4; cpu.ecx = 1000; cpu.eflags = F.RESERVED1 | F.IF;
  let r, smc = 0;
  while ((r = E.jit.run({ stopAt: CODE + code.length - 1, maxInsns: 1e6 })) === EXIT.SMC) { smc++; E.jit.invalidate(cpu.exitArg, 16); }
  assert.equal(r, EXIT.HALT);
  assert.equal(smc, 0);
  assert.equal(mem.read32(CODE - 4) >>> 0, 0x00010001);
  assert.equal(mem.u8[SMC_MAP_BASE + (CODE >>> 12) - 1], SMC_NEXT);
});
