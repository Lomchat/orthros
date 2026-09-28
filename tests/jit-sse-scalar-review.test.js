// Adversarial checks of the XMM lane-0 shadows and the fused (U)COMISS conditions (translate-sse-float.js,
// Emitter.xmmShadowSync / pushFcmpCond) against the reference interpreter: self-modifying stores issued from a
// block holding dirty shadows, fused compares whose flags a successor block (in the region) or PUSHFD reads, SETCC
// to memory, CMOVCC from memory, x87 code interleaved with scalar SSE, backward branches with tiny time slices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F, ST } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import '../src/cpu/jit/translate-sse-float.js';
import '../src/cpu/jit/translate-sse-int.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x1000;
const MEMOP = DATA + 0x100;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);
const f32bits = (v) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.getUint32(0, true); };

function makeExec(jit) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const J = jit ? new Jit(mem, I, { smc: true }) : null;
  return {
    mem, cpu, I, J,
    run(end, slice = 1e6) {
      I.cache.clear();
      if (!J) return I.run({ stopAt: end, maxInsns: 1e6 });
      J.reset(); J.cpu = cpu; J.boundaries = new Set([end]);
      let r, n = 0;
      for (;;) {
        r = J.run({ stopAt: end, maxInsns: slice });
        if (r === EXIT.SMC) J.invalidate(mem.read32(cpu.base + ST.EXIT_ARG), 16); // (as core/vm.js does)
        else if (r !== EXIT.TIMESLICE || ++n >= 1e5) break;
      }
      return r;
    },
  };
}
const EI = makeExec(false), EJ = makeExec(true);
function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
const SPECIAL = [0, -0, 1, -1, 0.5, 2.5, -2.5, Infinity, -Infinity, 3e9, 2147483648, -2147483648, 1e-40, -1e-45, 1e30]
  .map(f32bits).concat([0x7fc00000, 0xffc00000, 0x7fa00001, 0xff812345]);

function snapshot(E) {
  const { mem, cpu } = E;
  const s = { eip: hex(cpu.eip), eflags: hex(cpu.eflags & ARITH), regs: [], xmm: [], fpr: [],
    mem: Buffer.from(mem.bytes(DATA, DATA_SIZE)).toString('hex'), code: Buffer.from(mem.bytes(CODE, 0x100)).toString('hex') };
  for (let k = 0; k < 8; k++) s.regs.push(hex(cpu.reg(k)));
  for (let k = 0; k < 8; k++) s.xmm.push(Buffer.from(mem.bytes(cpu.xmmAddr(k), 16)).toString('hex'));
  return s;
}

function runBoth(code, seed, label, { slice, init } = {}) {
  for (const E of [EI, EJ]) {
    const { mem, cpu } = E;
    cpu.reset();
    mem.fill(DATA, DATA_SIZE, 0);
    mem.fill(CODE - 0x100, 0x2000, 0xcc);
    mem.writeBytes(CODE, code);
    const r = prng(seed);
    const val = () => ((r() & 3) ? SPECIAL[r() % SPECIAL.length] : f32bits(((r() % 20000) - 10000) / 64));
    for (let k = 0; k < 8; k++) for (let l = 0; l < 4; l++) mem.write32(cpu.xmmAddr(k) + 4 * l, val());
    for (let i = 0; i < 0x100; i += 4) mem.write32(MEMOP + i, val());
    for (let k = 0; k < 8; k++) cpu.setReg(k, r());
    cpu.eax = MEMOP; cpu.esp = DATA + 0xf00; cpu.edi = DATA + 0x800;
    cpu.eflags = F.RESERVED1 | F.IF | (r() & ARITH);
    cpu.mxcsr = 0x1f80;
    if (init) init(E);
    cpu.eip = CODE;
  }
  const end = CODE + code.length;
  const ri = EI.run(end), rj = EJ.run(end, slice);
  assert.equal(ri, EXIT.HALT, `${label}: interpreter exit ${ri}`);
  assert.equal(rj, EXIT.HALT, `${label}: jit exit ${rj}`);
  assert.deepEqual(snapshot(EJ), snapshot(EI), label);
}

test('a self-modifying store from a block holding dirty shadows', () => {
  // movss xmm0,[eax] ; mulss xmm0,xmm0 ; movss xmm1,xmm0 ; addss xmm1,[eax+4] ;
  // movss [ebx],xmm1         (ebx = the imm32 of the mov below: the block is left mid-way)
  // mov ecx, 0x11111111 ; addps xmm0, xmm1 ; movss [eax+8], xmm1 ; cvttss2si edx, xmm0
  const code = [0xf3, 0x0f, 0x10, 0x00, 0xf3, 0x0f, 0x59, 0xc0, 0xf3, 0x0f, 0x10, 0xc8, 0xf3, 0x0f, 0x58, 0x48, 0x04,
    0xf3, 0x0f, 0x11, 0x0b];
  const movAt = code.length;
  code.push(0xb9, 0x11, 0x11, 0x11, 0x11, 0x0f, 0x58, 0xc1, 0xf3, 0x0f, 0x11, 0x48, 0x08, 0xf3, 0x0f, 0x2c, 0xd0);
  for (const slice of [1e6, 2, 1]) {
    runBoth(Uint8Array.from(code), 11, `smc slice ${slice}`, {
      slice,
      init: (E) => { E.cpu.ebx = CODE + movAt + 1; E.mem.write32(MEMOP, f32bits(1.5)); E.mem.write32(MEMOP + 4, f32bits(0.25)); },
    });
  }
});

test('fused COMISS + JCC whose successors read the flags (in-region blocks, PUSHFD, ADC)', () => {
  const tails = [
    [0x83, 0xd1, 0x00], // adc ecx, 0 (CF)
    [0x9c, 0x5a], // pushfd ; pop edx (every flag)
    [0x0f, 0x9a, 0xc1], // setp cl
    [0x01, 0xd1], // add ecx, edx (flags overwritten)
  ];
  const pairs = [[1, 2], [2, 1], [3, 3], [NaN, 0], [-0, 0]];
  for (let cc = 0; cc < 16; cc++) for (const t1 of tails) for (const t2 of tails) for (const [a, b] of pairs) for (const op of [0x2e, 0x2f]) {
    // comiss xmm1,xmm2 ; jcc T ; <t1> ; jmp E ; T: <t2> ; E: mulss xmm1, xmm2
    const code = [0x0f, op, 0xca, 0x70 + cc, t1.length + 2, ...t1, 0xeb, t2.length, ...t2, 0xf3, 0x0f, 0x59, 0xca];
    runBoth(Uint8Array.from(code), cc + 1, `cc ${cc} t1 ${t1} t2 ${t2} a=${a} b=${b}`, {
      init: (E) => { E.mem.write32(E.cpu.xmmAddr(1), f32bits(a)); E.mem.write32(E.cpu.xmmAddr(2), f32bits(b)); },
    });
  }
});

test('fused COMISS + SETCC m8 / CMOVCC r,m32, then PUSHFD', () => {
  for (let cc = 0; cc < 16; cc++) for (const [a, b] of [[1, 2], [2, 1], [3, 3], [NaN, 0]]) {
    // comiss xmm3,[eax+8] ; setcc [eax+0x40] ; ucomiss xmm3,xmm4 ; cmovcc ecx,[eax+0x44] ; pushfd ; pop edx
    const code = [0x0f, 0x2f, 0x58, 0x08, 0x0f, 0x90 + cc, 0x40, 0x40, 0x0f, 0x2e, 0xdc, 0x0f, 0x40 + cc, 0x48, 0x44, 0x9c, 0x5a];
    runBoth(Uint8Array.from(code), cc + 50, `cc ${cc} a=${a} b=${b}`, {
      init: (E) => {
        E.mem.write32(E.cpu.xmmAddr(3), f32bits(a)); E.mem.write32(MEMOP + 8, f32bits(b)); E.mem.write32(E.cpu.xmmAddr(4), f32bits(b));
      },
    });
  }
});

test('scalar-single loop with a fused compare as back edge, every small time slice', () => {
  //    mov ecx, 13 ; xorps xmm2, xmm2 (packed)
  // L: cvtsi2ss xmm0, ecx ; addss xmm2, xmm0 ; mulss xmm2, [eax] ; movss xmm3, xmm2 ; dec ecx ;
  //    comiss xmm3, [eax+4] ; movd edx, xmm3 (non-shadow reader between? no: must be next for fusion) ...
  //    ja L2 ; ... ; L2: test ecx, ecx ; jnz L
  const code = Uint8Array.from([0xb9, 13, 0, 0, 0, 0x0f, 0x57, 0xd2,
    0xf3, 0x0f, 0x2a, 0xc1, 0xf3, 0x0f, 0x58, 0xd0, 0xf3, 0x0f, 0x59, 0x10, 0xf3, 0x0f, 0x10, 0xda, 0x49,
    0x0f, 0x2f, 0x58, 0x04, 0x77, 0x04, 0x66, 0x0f, 0x7e, 0xda, // ja +4 ; movd edx, xmm3
    0x85, 0xc9, 0x75, 0xdc, 0x0f, 0x58, 0xda]);
  for (const slice of [1e6, 5, 3, 2, 1]) {
    runBoth(code, 77, `slice ${slice}`, { slice, init: (E) => { E.mem.write32(MEMOP, f32bits(0.9)); E.mem.write32(MEMOP + 4, f32bits(20)); } });
  }
});

test('x87 code interleaved with scalar SSE', () => {
  // fld dword [eax] ; movss xmm0,[eax+4] ; fmul dword [eax+4] ; addss xmm0,[eax] ; fstp dword [eax+8] ;
  // movss xmm1,[eax+8] ; comiss xmm0,xmm1 ; fld1 ; jbe +2 ; fchs ; nop ; fstp dword [eax+12] ; subss xmm1, xmm0
  const code = Uint8Array.from([0xd9, 0x00, 0xf3, 0x0f, 0x10, 0x40, 0x04, 0xd8, 0x48, 0x04, 0xf3, 0x0f, 0x58, 0x00, 0xd9, 0x58, 0x08,
    0xf3, 0x0f, 0x10, 0x48, 0x08, 0x0f, 0x2f, 0xc1, 0xd9, 0xe8, 0x76, 0x02, 0xd9, 0xe0, 0x90, 0xd9, 0x58, 0x0c, 0xf3, 0x0f, 0x5c, 0xc8]);
  for (const [a, b] of [[1.5, 2], [2, 1.5], [NaN, 1], [0, -0]]) {
    runBoth(code, 5, `a=${a} b=${b}`, { init: (E) => { E.mem.write32(MEMOP, f32bits(a)); E.mem.write32(MEMOP + 4, f32bits(b)); } });
  }
});

// random programs: the author's mix plus SETCC m8 / CMOVCC r,m / PUSHFD / x87 / SMC-free memory aliasing
const X = (r) => r() & 7;
const G = (r) => [1, 2, 3, 5, 6][r() % 5];
const regrm = (reg, rm) => 0xc0 | (reg << 3) | rm;
const mem8 = (r, reg) => [0x40 | (reg << 3), (r() % 0x40) * 4];
const SS_OPS = [0x58, 0x59, 0x5c, 0x5e, 0x5d, 0x5f, 0x51, 0x53, 0x52];
function insn(r) {
  const k = r() % 100;
  if (k < 10) return [0xf3, 0x0f, 0x10, regrm(X(r), X(r))];
  if (k < 18) return [0xf3, 0x0f, 0x10, ...mem8(r, X(r))];
  if (k < 24) return [0xf3, 0x0f, 0x11, ...mem8(r, X(r))];
  if (k < 40) { const op = SS_OPS[r() % SS_OPS.length]; return (r() & 3) ? [0xf3, 0x0f, op, regrm(X(r), X(r))] : [0xf3, 0x0f, op, ...mem8(r, X(r))]; }
  if (k < 44) return [0xf3, 0x0f, 0x2a, regrm(X(r), r() & 7)];
  if (k < 48) return [0xf3, 0x0f, (r() & 1) ? 0x2c : 0x2d, regrm(G(r), X(r))];
  if (k < 60) {
    const cmp = (r() & 3) ? [0x0f, (r() & 1) ? 0x2f : 0x2e, regrm(X(r), X(r))] : [0x0f, 0x2f, ...mem8(r, X(r))];
    const cc = r() & 15, c = r() % 6;
    if (c === 0) return [...cmp, 0x0f, 0x90 + cc, ...mem8(r, 0)]; // setcc m8
    if (c === 1) return [...cmp, 0x0f, 0x40 + cc, ...mem8(r, G(r))]; // cmovcc r, m32
    if (c === 2) return [...cmp, 0x0f, 0x40 + cc, regrm(G(r), r() & 7), 0x9c, 0x5a]; // cmovcc ; pushfd ; pop edx
    if (c === 3) return [...cmp, 0x0f, 0x90 + cc, regrm(0, 1), 0x0f, 0x90 + (r() & 15), regrm(0, 2)]; // two setcc
    return cmp;
  }
  if (k < 63) return [0x0f, 0x58, regrm(X(r), X(r))]; // addps
  if (k < 65) return [0x0f, 0xc6, regrm(X(r), X(r)), r() & 0xff]; // shufps
  if (k < 67) return [0x66, 0x0f, 0xd6, ...mem8(r, X(r))]; // movq m64, xmm
  if (k < 69) return [0xf3, 0x0f, 0x7e, ...mem8(r, X(r))]; // movq xmm, m64
  if (k < 71) return [0x66, 0x0f, 0xc5, regrm(G(r), X(r)), r() & 7]; // pextrw r32, xmm
  if (k < 73) return [0x66, 0x0f, 0xfe, regrm(X(r), X(r))]; // paddd
  if (k < 75) return [0xd9, 0x40, (r() % 0x40) * 4, 0xd9, 0x58, (r() % 0x40) * 4]; // fld m32 ; fstp m32
  if (k < 77) return [0x0f, 0x12, regrm(X(r), X(r))]; // movhlps
  if (k < 80) return [[0x01, 0xd1], [0x29, 0xf3], [0x31, 0xd2], [0xff, 0xc1], [0x9c, 0x5a]][r() % 5];
  if (k < 83) return [0x0f, 0x90 + (r() & 15), regrm(0, 2)];
  if (k < 85) return [0xeb, 0x00];
  return null;
}
function program(seed, n = 40) {
  const r = prng(seed);
  const out = [];
  let pendingJcc = -1;
  for (let i = 0; i < n; i++) {
    const b = insn(r);
    if (b === null) { out.push(0x70 + (r() & 15), 0); pendingJcc = out.length - 1; continue; }
    out.push(...b);
    if (pendingJcc >= 0) { out[pendingJcc] = b.length; pendingJcc = -1; }
  }
  return Uint8Array.from(out);
}
test('random scalar-single programs (extended mix) match the interpreter', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const code = program(seed * 65537 + 17);
    runBoth(code, seed, `seed ${seed} (${Buffer.from(code).toString('hex')})`, { slice: seed % 4 === 0 ? 1 + (seed % 5) : 1e6 });
  }
});
