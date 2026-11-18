// REP MOVS / REP STOS under the JIT (translate.js repStore): the bulk memory.copy / memory.fill path and the
// element loop must give the reference interpreter's element-by-element result — memory, final ESI/EDI/ECX, flags —
// for byte/word/dword elements, both directions, counts around the bulk threshold, every overlap distance
// (including the "replicating" ones where x86 order repeats the first elements), fill values with and without the
// one-byte-repeated pattern, an FS-overridden source, and a backward copy over translated code (SMC exit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_MAP_BASE, SMC_CODE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { FULL, depth } from './depth.js';

const CODE = 0x20000000, DATA = 0x10000000, WIN = 0x1000; // the data window compared: [DATA, DATA + WIN)
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const hex = (v) => '0x' + (v >>> 0).toString(16);

function makeExec(useJit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = useJit ? new Jit(mem, I, { smc: true }) : null;
  return {
    mem, cpu, jit,
    /** run `code` (ending with hlt) at `at`, the data window filled with a byte pattern */
    exec(code, regs, at) {
      cpu.reset();
      const pat = new Uint8Array(WIN); for (let i = 0; i < WIN; i++) pat[i] = (i * 7 + 3) & 0xff;
      mem.writeBytes(DATA, pat);
      mem.writeBytes(at, Uint8Array.from(code));
      cpu.eip = at; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1 | F.IF | F.CF | F.ZF;
      for (const [k, v] of Object.entries(regs)) cpu[k] = v;
      let r;
      if (jit) { jit.cpu = cpu; r = jit.run({ maxInsns: 1e7 }); } else r = I.run({ maxInsns: 1e7 });
      return {
        r, eflags: hex(cpu.eflags), regs: [0, 1, 2, 3, 5, 6, 7].map((k) => hex(cpu.reg(k))),
        mem: Buffer.from(mem.bytes(DATA, WIN)).toString('hex'),
      };
    },
  };
}
const EI = makeExec(false), EJ = makeExec(true);
// every case runs at its own address: the interpreter's decoded instructions and the JIT's regions stay valid
let slot = 0;
// (the quick pass, tests/depth.js: every STRIDE-th case of the two sweeps — the full pass, ORTHROS_TEST_FULL=1: all)
const STRIDE = FULL ? 1 : 7;
let sweep = 0;
const sampled = () => sweep++ % STRIDE === 0;

/** mov esi, S ; mov edi, D ; mov ecx, N ; std|cld ; [66] [64] rep movs|stos ; cld ; hlt */
function prog(op, size, back, src, dst, n, fs = false) {
  const opc = { movs: size === 1 ? 0xa4 : 0xa5, stos: size === 1 ? 0xaa : 0xab }[op];
  return [0xbe, ...le(src), 0xbf, ...le(dst), 0xb9, ...le(n), back ? 0xfd : 0xfc,
    ...(size === 2 ? [0x66] : []), ...(fs ? [0x64] : []), 0xf3, opc, 0xfc, 0xf4];
}
function same(code, regs, what) {
  const at = CODE + 0x10000 + 32 * slot++;
  const I = EI.exec(code, regs, at), J = EJ.exec(code, regs, at);
  assert.equal(I.r, EXIT.HALT, what);
  const diff = [...I.mem].findIndex((ch, i) => ch !== J.mem[i]);
  assert.equal(diff, -1, `${what}: memory differs at DATA+${hex(diff >> 1)}`);
  assert.deepEqual({ ...J, mem: '' }, { ...I, mem: '' }, what);
}

test('rep movs: every size, direction, count around the bulk threshold and overlap distance matches the interpreter', () => {
  for (const size of [1, 2, 4]) {
    for (const back of [false, true]) {
      for (const n of [0, 1, 2, 11, 12, 13, 31, 64, 200]) {
        const bytes = n * size;
        // overlap distances dst - src: all small ones, both sides of the byte length, far apart
        const ds = new Set([0x800, -0x800, bytes, -bytes, bytes + 1, -bytes - 1, bytes - 1, 1 - bytes]);
        for (let d = -9; d <= 9; d++) ds.add(d);
        for (const d of ds) {
          // src/dst: the first element forward, the last one backward (ESI/EDI as a memmove sets them)
          const lo = DATA + 0x600, last = back ? bytes - size : 0;
          const src = lo + last, dst = lo + d + last;
          if (sampled()) same(prog('movs', size, back, src, dst, n), { eax: 0x5a5a5a5a }, `movs${size} ${back ? 'bwd' : 'fwd'} n=${n} d=${d}`);
        }
      }
    }
  }
});

test('rep stos: every size and direction, fill values with and without a repeated byte', () => {
  for (const size of [1, 2, 4]) {
    for (const back of [false, true]) {
      for (const n of [0, 1, 11, 12, 13, 64, 300]) {
        for (const eax of [0, 0xffffffff, 0x41414141, 0x11223344, 0x00004141, 0x41410041, 0x12344141, 0x41414140]) {
          const last = back ? (n - 1) * size : 0;
          if (sampled()) same(prog('stos', size, back, 0, DATA + 0x400 + Math.max(0, last), n), { eax }, `stos${size} ${back ? 'bwd' : 'fwd'} n=${n} eax=${hex(eax)}`);
        }
      }
    }
  }
});

test('rep movs with an FS-overridden source (the segment base added per element)', () => {
  for (const back of [false, true]) {
    for (const n of [5, 40]) {
      const last = back ? (n - 1) * 4 : 0;
      const code = prog('movs', 4, back, 0x100 + last, DATA + 0x100 + last, n, true);
      same(code, { fsBase: DATA + 0x400 }, `fs: movsd ${back ? 'bwd' : 'fwd'} n=${n}`);
    }
  }
});

test('a backward rep movsd over translated code leaves with SMC and the new code runs', () => {
  // main: call FN ; mov ebx, eax ; std ; rep movsd (FN2 -> FN, 16 dwords, from the last) ; cld ; call FN ; hlt
  // FN: mov eax, 1 ; ret      FN2 (data): mov eax, 2 ; ret ; nops
  const FN = CODE + 0x100, FN2 = DATA + 0x100, n = 16;
  const main = [0xe8, ...le(FN - (CODE + 5)), 0x89, 0xc3, 0xbe, ...le(FN2 + 4 * (n - 1)), 0xbf, ...le(FN + 4 * (n - 1)), 0xb9, ...le(n), 0xfd, 0xf3, 0xa5, 0xfc];
  const at = main.length; main.push(0xe8, ...le(FN - (CODE + at + 5)), 0xf4);
  const code = new Uint8Array(0x100 + 4 * n); code.set(main, 0); code.set([0xb8, 1, 0, 0, 0, 0xc3], 0x100);
  const mem = EJ.mem, cpu = EJ.cpu;
  cpu.reset();
  mem.writeBytes(CODE, code);
  const f2 = new Uint8Array(4 * n).fill(0x90); f2.set([0xb8, 2, 0, 0, 0, 0xc3]); mem.writeBytes(FN2, f2);
  cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1 | F.IF;
  EJ.jit.cpu = cpu;
  let r, smc = 0;
  while ((r = EJ.jit.run({ stopAt: CODE + main.length - 1, maxInsns: 1e6 })) === EXIT.SMC) {
    const len = mem.read32(cpu.base + ST.EXIT_LEN) || 16; mem.write32(cpu.base + ST.EXIT_LEN, 0);
    EJ.jit.invalidate(cpu.exitArg, len); smc++;
  }
  assert.equal(r, EXIT.HALT);
  assert.ok(smc >= 1, 'the string store left with SMC');
  assert.deepEqual([cpu.ebx, cpu.eax, cpu.ecx, cpu.esi >>> 0, cpu.edi >>> 0], [1, 2, 0, FN2 - 4, FN - 4]);
});

test('rep stosd over translated code (element loop and memory.fill, both directions) leaves with SMC', () => {
  // main: call FN ; mov ebx, eax ; mov eax, 0xc3c3c3c3 ; mov edi, <FN or its last dword> ; mov ecx, n ; std|cld ;
  // rep stosd ; cld ; call FN ; hlt      FN: mov eax, 1 ; ret   -> overwritten with rets: the second call keeps EAX
  const FN = CODE + 0x100;
  for (const [n, back] of [[1, false], [1, true], [2, true], [40, false], [40, true]]) {
    const edi = back ? FN + 4 * (n - 1) : FN;
    const main = [0xe8, ...le(FN - (CODE + 5)), 0x89, 0xc3, 0xb8, ...le(0xc3c3c3c3), 0xbf, ...le(edi), 0xb9, ...le(n), back ? 0xfd : 0xfc, 0xf3, 0xab, 0xfc];
    const at = main.length; main.push(0xe8, ...le(FN - (CODE + at + 5)), 0xf4);
    const code = new Uint8Array(0x100 + 4 * n + 8); code.set(main, 0); code.set([0xb8, 1, 0, 0, 0, 0xc3], 0x100);
    const mem = EJ.mem, cpu = EJ.cpu;
    EJ.jit.invalidate(CODE, 0x1000);
    cpu.reset();
    mem.writeBytes(CODE, code);
    cpu.eip = CODE; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1 | F.IF;
    EJ.jit.cpu = cpu;
    let r, smc = 0;
    while ((r = EJ.jit.run({ stopAt: CODE + main.length - 1, maxInsns: 1e6 })) === EXIT.SMC) {
      const len = mem.read32(cpu.base + ST.EXIT_LEN) || 16; mem.write32(cpu.base + ST.EXIT_LEN, 0);
      EJ.jit.invalidate(cpu.exitArg, len); smc++;
    }
    const what = `stosd n=${n} ${back ? 'bwd' : 'fwd'}`;
    assert.equal(r, EXIT.HALT, what);
    assert.ok(smc >= 1, `${what}: the string store left with SMC`);
    assert.deepEqual([cpu.ebx, cpu.eax >>> 0, cpu.ecx, cpu.edi >>> 0], [1, 0xc3c3c3c3, 0, back ? FN - 4 : FN + 4 * n], what);
  }
});

// Copy and fill loops taken at once (opts.loopBulk, translate.js bulkLoopOf): the shapes compilers and hand-written
// decompressors give them — a byte copy counting down, an LZ match copy testing the counter's old value, dword / byte /
// word fills, a word copy ending at a pointer, a dword copy with displacements, counters stepping up or by 4 — with
// random counts around the threshold, every short overlap distance (the copies that repeat a pattern, the ones one
// element cannot do at once), page boundaries, a destination page holding translated code, a destination in the null
// page, and time slices ending anywhere: the JIT with and without the bulk form leave every slice with the same state
// (registers, flags, memory, instructions charged), and the interpreter ends with it.
test('copy and fill loops taken at once (loopBulk) match the element loop and the interpreter, slice by slice', () => {
  const W = 0x3000; // (the data window: three pages)
  const mk = (bulk) => { const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE), I = new Interp(mem, cpu); return { mem, cpu, I, jit: bulk === null ? null : new Jit(mem, I, { smc: true, loopBulk: bulk }) }; };
  const M0 = mk(false), M1 = mk(true), MI = mk(null);
  let seed = 0x10b;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const R = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };
  // [body bytes, registers (count n, source s, destination d), the element size, a copy]: jne back to the body follows
  const shapes = [
    [[0x8a, 0x11, 0x88, 0x16, 0x46, 0x41, 0x4f], (n, s, d) => ({ ecx: s, esi: d, edi: n }), 1, true], // mov dl,[ecx]; mov [esi],dl; inc esi; inc ecx; dec edi
    [[0x8a, 0x07, 0x88, 0x06, 0x46, 0x47, 0x8b, 0xc2, 0x4a, 0x85, 0xc0], (n, s, d) => ({ edi: s, esi: d, edx: n - 1 }), 1, true], // (an LZ match: the counter's old value tested)
    [[0x89, 0x07, 0x83, 0xc7, 0x04, 0x83, 0xe9, 0x01], (n, s, d) => ({ edi: d, ecx: n }), 4, false], // mov [edi],eax; add edi,4; sub ecx,1
    [[0xc6, 0x07, 0x20, 0x47, 0x49], (n, s, d) => ({ edi: d, ecx: n }), 1, false], // mov byte [edi],0x20; inc edi; dec ecx
    [[0x66, 0x8b, 0x06, 0x66, 0x89, 0x07, 0x83, 0xc6, 0x02, 0x83, 0xc7, 0x02, 0x3b, 0xf3], (n, s, d) => ({ esi: s, edi: d, ebx: (s + 2 * n) >>> 0 }), 2, true], // ... cmp esi, ebx
    [[0x8b, 0x46, 0x08, 0x89, 0x47, 0xfc, 0x8d, 0x76, 0x04, 0x83, 0xc7, 0x04, 0x49], (n, s, d) => ({ esi: s - 8, edi: d + 4, ecx: n }), 4, true], // mov eax,[esi+8]; mov [edi-4],eax; lea esi,[esi+4]; add edi,4; dec ecx
    [[0x66, 0x89, 0x1f, 0x83, 0xc7, 0x02, 0x41], (n, s, d) => ({ edi: d, ecx: -n >>> 0 }), 2, false], // mov [edi],bx; add edi,2; inc ecx (up to zero)
    [[0x8b, 0x06, 0x89, 0x07, 0x83, 0xc6, 0x04, 0x83, 0xc7, 0x04, 0x83, 0xe9, 0x04], (n, s, d) => ({ esi: s, edi: d, ecx: 4 * n }), 4, true], // ... sub ecx, 4
  ];
  /** run M from `at` to the HLT in slices of `slices` instructions (SMC exits: the range invalidated, as the VM does) */
  const states = (M, at, regs, slices, flagged) => {
    const { mem, cpu } = M, out = [];
    cpu.reset();
    const pat = new Uint8Array(W); for (let i = 0; i < W; i++) pat[i] = (i * 13 + 5) & 0xff;
    mem.writeBytes(DATA, pat);
    if (flagged && M.jit) mem.u8[SMC_MAP_BASE + ((DATA >>> 12) + 1)] |= SMC_CODE;
    for (const [k, v] of Object.entries(regs)) cpu.setReg(R[k], v);
    cpu.eip = at; cpu.esp = DATA + 0x8000; cpu.eflags = F.RESERVED1 | F.IF;
    for (let k = 0; k < 400; k++) {
      let r;
      if (M.jit) { M.jit.cpu = cpu; r = M.jit.run({ maxInsns: slices[k % slices.length] }); } else r = M.I.run({ maxInsns: 1e8 });
      if (r === EXIT.SMC) { const len = mem.read32(cpu.base + ST.EXIT_LEN) || 16; mem.write32(cpu.base + ST.EXIT_LEN, 0); M.jit.invalidate(cpu.exitArg, len); }
      out.push({ r, eip: hex(cpu.eip), eflags: hex(cpu.eflags), regs: [0, 1, 2, 3, 5, 6, 7].map((i) => hex(cpu.reg(i))), left: M.jit ? M.jit.remaining() : 0, mem: Buffer.from(mem.bytes(DATA, W)) });
      if (r !== EXIT.TIMESLICE && r !== EXIT.SMC) break;
    }
    if (flagged && M.jit) mem.u8[SMC_MAP_BASE + ((DATA >>> 12) + 1)] &= ~SMC_CODE;
    return out;
  };
  const N = depth(1600, 240);
  for (let i = 0; i < N; i++) {
    const [body, regsOf, z, copy] = shapes[i % shapes.length];
    const n = [1, 2, 15, 16, 17, 18, 31, 64, 100, 300, 1 + rnd(700)][rnd(11)], bytes = n * z;
    const d0 = DATA + 0x100 + rnd(0x40) * (rnd(2) ? 1 : z), ds = [bytes, -bytes, bytes + 1, bytes - 1, 1 - bytes, 0x800 - rnd(64), -0x80 - rnd(64)];
    let d = d0, s = copy ? d0 - (rnd(2) ? rnd(19) - 9 : ds[rnd(ds.length)]) : 0;
    if (rnd(12) === 0) d = DATA + 0x1000 - rnd(3 * z + 1); // (across a page boundary)
    if (copy && (s < DATA || s + bytes > DATA + W)) s = DATA + 0x80;
    const nullDst = rnd(30) === 0, flagged = rnd(10) === 0;
    if (nullDst) d = 0x8000;
    if (d + bytes > DATA + W) continue;
    const regs = { eax: rnd(3) ? 0 : (rnd(256) * 0x01010101) ^ (rnd(2) ? rnd(0x1000000) : 0), ebx: rnd(0x10000) | (rnd(0x10000) << 16), edx: rnd(256) << 8, ebp: 0x1234, ...regsOf(n, s >>> 0, d >>> 0) };
    const at = CODE + 0x80000 + 64 * (i % shapes.length); // (each shape at its address: translated once per machine)
    const code = [...body, 0x75, (-(body.length + 2)) & 0xff, 0xf4];
    for (const M of [M0, M1, MI]) M.mem.writeBytes(at, Uint8Array.from(code));
    const slices = rnd(3) ? [1e7] : [1 + rnd(40), 7 + rnd(400), 1 + rnd(3000)];
    const what = `shape ${i % shapes.length} n=${n} s=${hex(s)} d=${hex(d)} regs=${JSON.stringify(regs)} slices=${slices} flagged=${flagged}`;
    const a = states(M0, at, regs, slices, flagged), b = states(M1, at, regs, slices, flagged);
    assert.equal(b.length, a.length, `${what}: exits`);
    for (let k = 0; k < a.length; k++) {
      assert.ok(a[k].mem.equals(b[k].mem), `${what}: exit ${k}: memory differs at DATA+${hex(a[k].mem.findIndex((x, j) => x !== b[k].mem[j]))}`);
      assert.deepEqual({ ...b[k], mem: '' }, { ...a[k], mem: '' }, `${what}: exit ${k}`);
    }
    if (nullDst) continue; // (a fault: the interpreter's exception state is its own)
    const ref = states(MI, at, regs, [1e8], false), last = a[a.length - 1];
    assert.equal(last.r, EXIT.HALT, what); assert.equal(ref[0].r, EXIT.HALT, what);
    assert.deepEqual({ ...last, left: 0, eip: '', mem: '' }, { ...ref[0], eip: '', mem: '' }, `${what}: against the interpreter`); // (EIP: the JIT reports the HLT, the interpreter what follows)
    assert.ok(last.mem.equals(ref[0].mem), `${what}: memory against the interpreter`);
  }
  assert.ok(M1.jit.stats.loopBulk >= shapes.length, `every shape recognised (${M1.jit.stats.loopBulk} loops)`);
  assert.equal(M0.jit.stats.loopBulk, 0);
});
