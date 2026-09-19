// JIT mechanics of the SSE/MMX translators (translate-sse-*.js), checked directly against the
// reference interpreter on hand-built code: self-modifying-code detection for every vector store
// form, lazy-flag coherence around COMIS*/conditional code, FS/GS/a16 addressing, interpreter
// fallbacks (FXSAVE) between native SSE ops, x87/MMX TOP+tag coupling, region consolidation.
// No oracle here: the interpreter is the reference (validated by tests/cpu-interp.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, SMC_BITMAP_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, ST, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import '../src/cpu/interp-x87.js';
import '../src/cpu/interp-sse.js';
import { Jit } from '../src/cpu/jit/jit.js';
import '../src/cpu/jit/translate-sse-float.js';
import '../src/cpu/jit/translate-sse-int.js';

const CODE = 0x20000000, DATA = 0x10000000, DATA_SIZE = 0x2000;
const ARITH = F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF;
const hex = (v) => '0x' + (v >>> 0).toString(16);

// ---------------------------------------------------------------- executors
function makeInterp() {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  return { mem, cpu, run(end, maxInsns = 100000) { I.cache.clear(); return I.run({ stopAt: end, maxInsns }); }, I };
}
function makeJit(opts = {}) {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  const I = new Interp(mem, cpu);
  const jit = new Jit(mem, I, { smc: true, fallbackHist: true, ...opts });
  return {
    mem, cpu, jit, I,
    run(end, maxInsns = 100000) { jit.reset(); I.cache.clear(); jit.boundaries = new Set([end]); jit.cpu = cpu; return jit.run({ stopAt: end, maxInsns }); },
  };
}
const EI = makeInterp();
const EJ = makeJit();

// ---------------------------------------------------------------- state helpers
function bytesOf(s) { return Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16)); }
/** deterministic bytes (xorshift32) */
function prng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
function f32bits(v) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return b.getUint32(0, true); }

/** Reset both executors to one identical state; returns the end address. */
function load(code, setup = () => {}, execs = [EI, EJ]) {
  const c = bytesOf(code);
  for (const E of execs) {
    const { mem, cpu } = E;
    cpu.reset();
    mem.fill(DATA, DATA_SIZE, 0);
    mem.fill(CODE - 0x1000, 0x3000, 0xcc);
    mem.writeBytes(CODE, c);
    const r = prng(0x1234567);
    for (let k = 0; k < 8; k++) {
      // XMM: lanes 0,1 finite floats (as f32 and as bytes), lanes 2,3 random bits
      const v = new DataView(new ArrayBuffer(16));
      v.setFloat32(0, ((r() % 2000) - 1000) / 8, true);
      v.setFloat32(4, ((r() % 2000) - 1000) / 16, true);
      v.setUint32(8, r(), true); v.setUint32(12, r(), true);
      mem.writeBytes(cpu.xmmAddr(k), new Uint8Array(v.buffer));
      mem.write64(cpu.mmAddr(k), (BigInt(r()) << 32n) | BigInt(r()));
    }
    for (let i = 0; i < DATA_SIZE; i += 4) mem.write32(DATA + i, r());
    for (let k = 0; k < 8; k++) cpu.setReg(k, r());
    cpu.esp = DATA + 0x1800;
    cpu.eflags = F.RESERVED1 | F.IF | (r() & ARITH);
    cpu.fsBase = 0; cpu.gsBase = 0;
    mem.u8[SMC_BITMAP_BASE + ((CODE >>> 12) >>> 3)] = 0; // fresh SMC bitmap for the code page
    mem.u8[SMC_BITMAP_BASE + (((CODE - 0x1000) >>> 12) >>> 3)] = 0;
    setup(mem, cpu);
  }
  return CODE + c.length;
}

function snapshot(E, memRanges = [[DATA, DATA_SIZE]]) {
  const { mem, cpu } = E;
  const s = { eip: hex(cpu.eip), exit: cpu.exit, eflags: hex(cpu.eflags & ARITH), regs: [], xmm: [], mm: [], st: [], top: cpu.fpuTop, tw: cpu.fpuTw, mxcsr: hex(cpu.mxcsr), mem: [] };
  for (let k = 0; k < 8; k++) s.regs.push(hex(cpu.reg(k)));
  for (let k = 0; k < 8; k++) s.xmm.push(Buffer.from(mem.bytes(cpu.xmmAddr(k), 16)).toString('hex'));
  for (let k = 0; k < 8; k++) s.mm.push(mem.read64(cpu.mmAddr(k)).toString(16));
  // only tagged-valid x87 slots are architecturally visible (the interpreter poisons popped slots)
  for (let k = 0; k < 8; k++) { const v = cpu.fpr(k); s.st.push(!((cpu.fpuTw >> k) & 1) ? 'empty' : Number.isNaN(v) ? 'nan' : String(v)); }
  for (const [a, n] of memRanges) s.mem.push(Buffer.from(mem.bytes(a, n)).toString('hex'));
  return s;
}

/** Run the code on both executors from CODE to end and compare the whole visible state. */
function runBoth(code, setup, { memRanges, expectExit = EXIT.HALT, label = code } = {}) {
  const end = load(code, setup);
  for (const E of [EI, EJ]) E.cpu.eip = CODE;
  const before = { ...EJ.jit.stats };
  const ri = EI.run(end), rj = EJ.run(end);
  assert.equal(ri, expectExit, `${label}: interpreter exit ${ri} (${EI.I.lastFault?.message ?? ''})`);
  assert.equal(rj, expectExit, `${label}: jit exit ${rj} (${EJ.jit.lastFault?.message ?? ''})`);
  assert.deepEqual(snapshot(EJ, memRanges), snapshot(EI, memRanges), `${label}: jit state differs from the interpreter`);
  const s = EJ.jit.stats;
  return { native: s.native - before.native, fallback: s.fallback - before.fallback, fallbackSteps: s.fallbackSteps - before.fallbackSteps };
}

// ---------------------------------------------------------------- self-modifying code
// Every vector store form must exit EXIT.SMC (arg = store address) when it hits a page holding
// translated code; the store itself is performed before the exit and execution resumes at the
// next instruction once the host has invalidated the page.
const STORE_FORMS = [
  ['movaps [eax], xmm0', '0f2900', 16],
  ['movups [eax], xmm0', '0f1100', 16],
  ['movdqu [eax], xmm0', 'f30f7f00', 16],
  ['movntps [eax], xmm0', '0f2b00', 16],
  ['movq [eax], xmm0', '660fd600', 8],
  ['movq [eax], mm0', '0f7f00', 8],
  ['movlps [eax], xmm0', '0f1300', 8],
  ['movhps [eax], xmm0', '0f1700', 8],
  ['movsd [eax], xmm0', 'f20f1100', 8],
  ['movss [eax], xmm0', 'f30f1100', 4],
  ['movd [eax], xmm0', '660f7e00', 4],
  ['movnti [eax], ecx', '0fc308', 4],
  ['stmxcsr [eax]', '0fae18', 4],
  ['maskmovq mm0, mm1', '0ff7c1', 8],
  ['maskmovdqu xmm0, xmm1', '660ff7c1', 16],
];

test('SMC: vector stores into the translated page exit EXIT.SMC and resume correctly', () => {
  for (const [asm, code, n] of STORE_FORMS) {
    // the store targets the code page itself (0x100 bytes past the region: data, not code)
    const target = CODE + 0x100;
    const full = code + '90'.repeat(4) + '8b08'; // ... nop x4 ; mov ecx, [eax]
    const end = load(full, (mem, cpu) => { cpu.eax = target; cpu.edi = target; mem.write64(cpu.mmAddr(1), 0xffffffffffffffffn); mem.writeBytes(cpu.xmmAddr(1), new Uint8Array(16).fill(0xff)); });
    EI.cpu.eip = CODE; EJ.cpu.eip = CODE;
    assert.equal(EI.run(end), EXIT.HALT, asm);
    const r = EJ.run(end);
    assert.equal(r, EXIT.SMC, `${asm}: expected EXIT.SMC, got ${r}`);
    assert.equal(EJ.cpu.eip, CODE + code.length / 2, `${asm}: resume EIP must be the next instruction`);
    assert.equal(EJ.mem.read32(EJ.cpu.base + ST.EXIT_ARG), target, `${asm}: EXIT_ARG must be the store address`);
    assert.deepEqual(Buffer.from(EJ.mem.bytes(target, n)).toString('hex'), Buffer.from(EI.mem.bytes(target, n)).toString('hex'), `${asm}: bytes stored before the exit`);
    // host side: invalidate and continue (vm.js does invalidateCode(exitArg, ...))
    EJ.jit.invalidate(target, 16);
    assert.equal(EJ.run(end), EXIT.HALT, `${asm}: resume after invalidation`);
    assert.deepEqual(snapshot(EJ, [[target, 16]]), snapshot(EI, [[target, 16]]), `${asm}: state after resume`);
  }
});

test('SMC: stores to a non-code page do not exit', () => {
  for (const [asm, code] of STORE_FORMS) {
    const stats = runBoth(code, (mem, cpu) => { cpu.eax = DATA + 0x100; cpu.edi = DATA + 0x100; mem.write64(cpu.mmAddr(1), 0x80ff80ff80ff80ffn); }, { label: asm });
    assert.equal(stats.fallback, 0, `${asm}: must be native`);
  }
});

test('SMC: 16-byte store crossing into the translated page from the page before', () => {
  // The store starts 8 bytes before CODE (previous page, not translated) and overwrites the first
  // 8 bytes of the region. Hardware semantics: the modified code must not be executed from a
  // stale translation. movups [eax], xmm0 ; nop... ; mov ecx, [eax+8] (reads the new code bytes)
  const code = '0f1100' + '90'.repeat(8) + '8b4808';
  const end = load(code, (mem, cpu) => { cpu.eax = CODE - 8; mem.writeBytes(cpu.xmmAddr(0), bytesOf('00000000000000009090909090909090')); });
  EI.cpu.eip = CODE; EJ.cpu.eip = CODE;
  assert.equal(EI.run(end), EXIT.HALT);
  const r = EJ.run(end);
  assert.equal(r, EXIT.SMC, 'a store crossing into a translated page must be detected');
  assert.equal(EJ.mem.read32(EJ.cpu.base + ST.EXIT_ARG), CODE + 7, 'EXIT_ARG = last byte written (the page to invalidate)');
  assert.equal(EJ.cpu.eip, CODE + 3);
  // same with MASKMOVDQU (mask = all bytes) and the aligned forms, which cannot cross: page-aligned target, plain store
  const mm = '660ff7c1' + '90'.repeat(8) + '8b4808';
  const end2 = load(mm, (mem, cpu) => { cpu.edi = CODE - 8; cpu.eax = CODE - 8; mem.writeBytes(cpu.xmmAddr(1), new Uint8Array(16).fill(0x80)); mem.writeBytes(cpu.xmmAddr(0), bytesOf('00000000000000009090909090909090')); });
  EJ.cpu.eip = CODE;
  assert.equal(EJ.run(end2), EXIT.SMC, 'maskmovdqu crossing into the translated page');
  assert.equal(EJ.mem.read32(EJ.cpu.base + ST.EXIT_ARG), CODE + 7);
});

// ---------------------------------------------------------------- handlers without oracle coverage
test('RCP/RSQRT (no oracle coverage: hardware approximations) match the interpreter bit for bit', () => {
  // rcpps xmm0,xmm1 ; rsqrtps xmm2,xmm3 ; rcpss xmm4,xmm5 ; rsqrtss xmm6,[eax] ; rsqrtps xmm7,[eax]
  const code = '0f53c10f52d3f30f53e5f30f52300f5238';
  const specials = [0, -0, Infinity, -Infinity, NaN, 1, 4, 1e-40, -3, 2.5e-39, 1e30, 65536];
  for (let round = 0; round < 6; round++) {
    runBoth(code, (mem, cpu) => {
      cpu.eax = DATA + 0x40;
      const r = prng(77 + round);
      for (let k = 0; k < 8; k++) for (let l = 0; l < 4; l++) {
        const v = (r() & 3) ? specials[r() % specials.length] : ((r() % 20000) - 10000) / 64;
        mem.write32(cpu.xmmAddr(k) + 4 * l, f32bits(v));
        mem.write32(DATA + 0x40 + 4 * l, f32bits(specials[(r() + l) % specials.length]));
      }
    }, { label: `rcp/rsqrt round ${round}` });
  }
});

// ---------------------------------------------------------------- lazy flags / EFLAGS
test('lazy flags survive SSE/MMX ops, COMIS* materialize pending flags', () => {
  // add eax,ebx ; movaps xmm0,xmm1 ; adc ecx,0 ; paddw mm0,mm1 ; setz dl ; comiss xmm0,xmm1 ; setb dh ;
  // sub eax,1 ; comisd xmm2,xmm3 ; setz bl ; seto bh
  runBoth('01d80f28c183d1000ffdc10f94c20f2fc10f92c683e801660f2fd30f94c30f90c7', (mem, cpu) => { cpu.eax = 0x7fffffff; cpu.ebx = 1; });
  runBoth('01d80f28c183d1000ffdc10f94c20f2fc10f92c683e801660f2fd30f94c30f90c7', (mem, cpu) => { cpu.eax = 0xffffffff; cpu.ebx = 1; mem.writeBytes(cpu.xmmAddr(1), mem.bytes(cpu.xmmAddr(0), 16)); });
  // NaN operands: unordered -> ZF|PF|CF, OF/SF cleared
  runBoth('01d80f28c183d1000ffdc10f94c20f2fc10f92c683e801660f2fd30f94c30f90c7', (mem, cpu) => { cpu.eax = 0x7fffffff; cpu.ebx = 1; mem.write32(cpu.xmmAddr(1), 0x7fc00000); mem.write64(cpu.xmmAddr(3), 0x7ff8000000000000n); });
});

test('COMISS at a block entry (lazy state unknown) folds the pending flags at run time', () => {
  // add eax,ebx ; jmp +2 ; nop ; nop ; comiss xmm0,xmm1 ; setb cl ; seto dl ; sets dh ; setp al
  const code = '01d8eb0290900f2fc10f92c10f90c20f98c60f9ac0';
  runBoth(code, (mem, cpu) => { cpu.eax = 0x7fffffff; cpu.ebx = 1; });
  runBoth(code, (mem, cpu) => { cpu.eax = 5; cpu.ebx = 1; mem.write32(cpu.xmmAddr(0), f32bits(-1)); mem.write32(cpu.xmmAddr(1), f32bits(-1)); });
  runBoth(code, (mem, cpu) => { cpu.eax = 5; cpu.ebx = 1; mem.write32(cpu.xmmAddr(0), f32bits(NaN)); });
});

test('handlers with internal control flow (br_table, if) leave lazy flags intact', () => {
  // add eax,ebx ; cvttss2si ecx,xmm0 ; seto dl ; sub eax,ebx ; psllw mm0,mm1 ; setc dh ; cmp eax,ebx ;
  // cvtps2dq xmm0,xmm1 ; setle bl ; psraw xmm2,xmm3 ; setg bh ; maskmovq mm2,mm3 ; adc eax,0
  const code = '01d8f30f2cc80f90c229d80ff1c10f92c639d8660f5bc10f9ec3660fe1d30f9fc70ff7d383d000';
  for (const [a, b, mx] of [[0x7fffffff, 1, 0x1f80], [3, 5, 0x3f80], [5, 3, 0x5f80], [0x80000000, 1, 0x7f80]]) {
    runBoth(code, (mem, cpu) => {
      cpu.eax = a; cpu.ebx = b; cpu.edi = DATA + 0x200; cpu.mxcsr = mx;
      mem.write64(cpu.mmAddr(1), 3n); mem.write64(cpu.mmAddr(3), 0x80ff80ff80ff80ffn);
      mem.write32(cpu.xmmAddr(0), f32bits(2.5)); mem.write32(cpu.xmmAddr(1), f32bits(-2.5)); mem.write32(cpu.xmmAddr(1) + 4, f32bits(3e9));
    }, { label: `${code} a=${hex(a)} b=${hex(b)} mxcsr=${hex(mx)}` });
  }
});

// ---------------------------------------------------------------- interpreter fallback in the block
test('FXSAVE/FXRSTOR fallbacks between native SSE ops keep XMM, EFLAGS and memory coherent', () => {
  // addps xmm0,xmm1 ; fxsave [ecx] ; comiss xmm0,xmm1 ; setb al ; mulps xmm0,xmm1 ; fxrstor [ecx] ;
  // movaps [edx],xmm0 ; ucomisd xmm1,xmm2 ; setz ah
  const code = '0f58c10fae010f2fc10f92c00f59c10fae090f2902660f2eca0f94c4';
  const stats = runBoth(code, (mem, cpu) => { cpu.ecx = DATA + 0x400; cpu.edx = DATA + 0x100; }, { memRanges: [[DATA, 0x800]] });
  assert.equal(stats.fallback, 2, 'exactly FXSAVE and FXRSTOR fall back');
  assert.equal(stats.native, 7);
});

// ---------------------------------------------------------------- segments and address size
test('FS/GS overrides on vector loads, stores and MASKMOVQ; a16 operands', () => {
  // movaps xmm0,fs:[eax] ; movaps gs:[ebx],xmm1 ; fs maskmovq mm0,mm1 ; gs movups [ecx],xmm2 ; movq mm2,gs:[eax] ; ss movaps [edx],xmm3
  const code = '640f2800650f290b640ff7c1650f1111650f6f10360f291a';
  runBoth(code, (mem, cpu) => {
    cpu.fsBase = DATA + 0x1000; cpu.gsBase = DATA + 0x800;
    cpu.eax = 0x10; cpu.ebx = 0x20; cpu.ecx = 0x40; cpu.edx = DATA + 0x60; cpu.edi = 0x80;
    mem.write64(cpu.mmAddr(1), 0x80ff80ff80ff80ffn);
  });
  // movups xmm1,[bx+si] ; movaps [bx+di],xmm1 ; movq mm0,[bp+si] ; movq [di],mm0 — 16-bit addressing wraps at 64 KB
  const a16 = '670f1008670f2909670f6f02670f7f05';
  runBoth(a16, (mem, cpu) => { cpu.ebx = 0xffff7000; cpu.esi = 0x1000; cpu.edi = 0x9000; cpu.ebp = 0x8800; for (let i = 0; i < 0x2000; i += 4) mem.write32(0x8000 + i, 0x11111111 * ((i >> 2) & 15)); },
    { memRanges: [[0x8000, 0x2000]] });
});

// ---------------------------------------------------------------- x87 / MMX coupling
test('MMX ops reset TOP/tags for the following x87 instructions; EMMS clears the tags', () => {
  // fld1 ; fld1 ; paddw mm0,mm1 ; fstp st(0) ; fld1 ; fadd st(0),st(1) ; emms
  runBoth('d9e8d9e80ffdc1ddd8d9e8d8c10f77', () => {});
  // paddw mm0,mm1 ; fld1 ; fstp st(0)
  runBoth('0ffdc1d9e8ddd8', (mem, cpu) => { cpu.fpuTop = 3; cpu.fpuTw = 0x12; });
  // fld1 ; paddw mm0,mm1 ; emms
  runBoth('d9e80ffdc10f77', (mem, cpu) => { cpu.fpuTop = 5; cpu.fpuTw = 0x00; });
});

// ---------------------------------------------------------------- memory ordering within a block
test('vector stores are visible to the following scalar loads of the same block', () => {
  // movaps [eax],xmm0 ; mov ecx,[eax+4] ; addps xmm0,xmm1 ; movaps [eax+16],xmm0 ; mov edx,[eax+20]
  runBoth('0f29008b48040f58c10f2940108b5014', (mem, cpu) => { cpu.eax = DATA + 0x300; });
});

// ---------------------------------------------------------------- consolidation
test('consolidated region modules (shared v128 locals) run identically', () => {
  const EJ2 = makeJit({ consolidateEvery: 2 });
  // addps xmm0,xmm1 ; mulps xmm2,xmm3 ; paddw mm0,mm1 ; movq mm2,mm3 ; cvtps2dq xmm4,xmm5
  const code = '0f58c10f59d30ffdc10f6fd3660f5be5';
  const c = bytesOf(code);
  const entries = [CODE, CODE + 0x40, CODE + 0x80, CODE + 0xc0];
  const setup = (mem, cpu) => { for (const e of entries) mem.writeBytes(e, c); };
  const expected = [];
  for (const e of entries) {
    load(code, setup, [EI]); EI.cpu.eip = e;
    assert.equal(EI.run(e + c.length), EXIT.HALT);
    expected.push(snapshot(EI));
  }
  // translate all four regions (consolidation kicks in after every 2), then run them again
  for (let pass = 0; pass < 2; pass++) {
    entries.forEach((e, k) => {
      load(code, setup, [EJ2]);
      EJ2.cpu.eip = e;
      EJ2.jit.boundaries = new Set([e + c.length]); EJ2.jit.cpu = EJ2.cpu; EJ2.I.cache.clear();
      assert.equal(EJ2.jit.run({ stopAt: e + c.length, maxInsns: 1000 }), EXIT.HALT);
      assert.deepEqual(snapshot(EJ2), expected[k], `region ${hex(e)} pass ${pass}`);
    });
  }
  assert.ok((EJ2.jit.stats.consolidations ?? 0) >= 2, `consolidations: ${EJ2.jit.stats.consolidations}`);
  assert.equal(EJ2.jit.stats.fallback, 0);
});

// ---------------------------------------------------------------- SSE op after a conditional branch
test('SSE op in a fallthrough block after JCC', () => {
  // cmp eax,ebx ; jz +3 ; addps xmm0,xmm1 ; ret  (ret pops from [esp])
  const code = '39d874030f58c1c3';
  for (const [a, b] of [[1, 1], [1, 2]]) {
    const end = load(code, (mem, cpu) => { cpu.eax = a; cpu.ebx = b; mem.write32(cpu.esp, CODE + 0x100); });
    for (const E of [EI, EJ]) { E.cpu.eip = CODE; E.run(CODE + 0x100); }
    assert.deepEqual(snapshot(EJ), snapshot(EI), `a=${a} b=${b}`);
    void end;
  }
});
