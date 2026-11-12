// Library kernels (DECISIONS.md D122): functions of shared libraries that hundreds of games ship unchanged (the C
// runtime msvcr71.dll...) recognised by the content of their code, and run as one WASM function in place of their
// translation. The game's own executable is never looked at (Jit opts.libScope): a library is recognised, never a game.
//
// Recognition: a definition names the byte ranges a kernel depends on — relative to the function's entry: the
// function, the helpers it calls on the path the kernel implements — and the 32-bit absolute addresses among them
// (relocated with the module); a fingerprint hashes those bytes with each absolute address replaced by its offset from
// the entry, so that the same library loaded at another base matches too, and its data (a control-word constant, a
// feature flag) sits at the same offset from the entry. Only fingerprints ship here, no library bytes.
//
// Execution: a kernel is a function with the regions' signature (translate.js REGION_PARAMS: block, state, registers,
// lazy flags, budget) entered through the JIT's hash table like a region — the dispatcher, a chained exit, the chain
// stub reach it by the function's address, the block parameter holding that address. It reproduces, exactly, every
// effect the original code has on the path it implements: the result, the registers the code leaves (EAX, ECX... the
// values the helpers leave behind), the flags of its last flag-setting instruction, the x87 control / status / tag words,
// stack top and physical registers, the stack memory below the caller's ESP the code writes (dead to the caller, kept
// all the same), the instructions charged to the budget; then it returns to the caller's address through the chain
// stub. Anything else — an input the path does not cover (an infinity, a NaN), an x87 stack that would overflow, an
// unmasked exception the path would raise, the feature flag selecting the other implementation, a stack near the end
// of the address space — takes the exact way: the kernel leaves with EXIT_STEP at the entry, the interpreter runs the
// entry's instruction and translation goes on from the next one, as without the kernel. tests/jit-lib-kernels.test.js
// runs each kernel against the reference interpreter running the original code on randomized inputs.
import { ModuleBuilder, Code, T } from './wasm.js';
import { ST } from '../state.js';
import { REGION_PARAMS, REGION_RESULTS, REGION_ARG_OFFSETS, EXIT_STEP, LZ } from './runtime.js';

// x87 status word condition codes (interp-x87.js)
const C0 = 0x100, C1 = 0x200, C3 = 0x4000, SW_CC = 0x4700;
const LOGIC32 = (LZ.LOGIC << 2) | 2;

/**
 * Kernel definitions. `ranges`: [offset from the entry, length] of the bytes the kernel depends on; `relocs`: offsets
 * from the entry of the absolute addresses among them; `hash`: their fingerprint (libFingerprint); `ref`: the entry in
 * the reference build (msvcr71.dll 7.10.3052.4, preferred base 0x7c340000; documentation, and the offsets below are
 * written from it); `k`: the kernel's constants. tools/gen/libkernel-sigs.mjs prints the relocs and hashes of a DLL.
 */
export const LIB_KERNELS = Object.freeze([
  // floor / ceil (x87 path: __sse2_available clear): _ctrlfp(round-down / up control word), the frndint helper, a
  // compare with the argument (an inexact result with the precision exception unmasked raises: not this path),
  // _ctrlfp(caller's control word), the result pushed
  {
    name: 'msvcr71!floor', kind: 'round', ref: 0x7c34539f, first: 0x83,
    ranges: [[0, 0xd], [0x7c377361 - 0x7c34539f, 0xd3], [0x7c375c77 - 0x7c34539f, 0x24], [0x7c377650 - 0x7c34539f, 0x11]],
    relocs: [0x2, 0x31fd1, 0x32031], hash: [0xd70488ab, 0xedf36a89],
    k: { sse2: 0x7c38b300 - 0x7c34539f, cwg: 0x7c390bc8 - 0x7c34539f, ret: 0x7c377407 - 0x7c34539f, rc: 1, n: 85 },
  },
  {
    name: 'msvcr71!ceil', kind: 'round', ref: 0x7c345284, first: 0x83,
    ranges: [[0, 0xd], [0x7c37728e - 0x7c345284, 0xd3], [0x7c375c77 - 0x7c345284, 0x24], [0x7c377650 - 0x7c345284, 0x11]],
    relocs: [0x2, 0x32019, 0x32079], hash: [0xee8c8759, 0x2c3488ae],
    k: { sse2: 0x7c38b300 - 0x7c345284, cwg: 0x7c390bc4 - 0x7c345284, ret: 0x7c377334 - 0x7c345284, rc: 2, n: 85 },
  },
  // fabs: _ctrlfp(0x133f), the sign bit cleared through the frame, _ctrlfp(caller's control word), the result pushed
  {
    name: 'msvcr71!fabs', kind: 'fabs', ref: 0x7c374dc3, first: 0x55,
    ranges: [[0, 0xb1], [0x7c375c77 - 0x7c374dc3, 0x24]],
    relocs: [0x46], hash: [0xbee672fa, 0xd3255eb6],
    k: { ret: 0x7c374e6b - 0x7c374dc3, n: 64 },
  },
]);

/** the definitions by the first byte of their code (`first`: a probe before hashing) */
const BY_FIRST = new Map();

/**
 * Fingerprint of the bytes `def` depends on at `entry` in `u8` (guest memory): two 32-bit hashes (FNV-1a and a
 * multiplicative one) of the ranges, each absolute address of `relocs` replaced by its offset from the entry.
 * Returns null when a range leaves the address space.
 */
export function libFingerprint(u8, entry, def) {
  const relAt = new Map(); for (const r of def.relocs) for (let i = 0; i < 4; i++) relAt.set(r + i, r);
  let h1 = 0x811c9dc5 | 0, h2 = 0x27d4eb2f;
  for (const [off, len] of def.ranges) {
    const a0 = (entry + off) >>> 0;
    if (a0 + len > 0x80000000) return null;
    for (let i = 0; i < len; i++) {
      const o = off + i, r = relAt.get(o);
      let b = u8[a0 + i];
      if (r !== undefined) { const a = entry + r, v = ((u8[a] | (u8[a + 1] << 8) | (u8[a + 2] << 16) | (u8[a + 3] << 24)) - entry) >>> 0; b = (v >>> (8 * (o - r))) & 0xff; }
      h1 = Math.imul(h1 ^ b, 0x01000193);
      h2 = Math.imul((h2 + b) ^ (h2 >>> 15), 0x85ebca6b) ^ o;
    }
  }
  return [h1 >>> 0, h2 >>> 0];
}

/** The kernel definition whose fingerprint the code at `eip` has, or null. */
export function matchLibKernel(u8, eip) {
  if (!BY_FIRST.size) for (const d of LIB_KERNELS) { let l = BY_FIRST.get(d.first); if (!l) BY_FIRST.set(d.first, (l = [])); l.push(d); }
  const l = BY_FIRST.get(u8[eip]);
  if (!l) return null;
  for (const d of l) {
    const h = libFingerprint(u8, eip, d);
    if (h && h[0] === d.hash[0] && h[1] === d.hash[1]) return d;
  }
  return null;
}

// ---- kernels
// parameters (REGION_PARAMS): block (= the entry address, from the hash entry), state, eax ecx edx ebx esp ebp esi edi,
// eflags, lazy op / result / a / b, budget
const P = { ENTRY: 0, STATE: 1, EAX: 2, ECX: 3, EDX: 4, EBX: 5, ESP: 6, EBP: 7, ESI: 8, EDI: 9, EFL: 10, LZOP: 11, LZRES: 12, LZA: 13, LZB: 14, IC: 15 };
// locals after the parameters
const L_S = 16, L_T = 17, L_TW = 18, L_CW = 19, L_G = 20, L_HI = 21, L_LO = 22, L_N = 23, L_X = 24, L_R = 25;
const LOCALS = [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.f64, T.f64];

/**
 * The kernel functions' module: memory, table and the runtime's chain stub imported; one exported function `k<i>` per
 * definition of LIB_KERNELS. opts.chain false (no tail calls, or chaining off): a kernel returns the caller's address to
 * the dispatcher with the state written back instead of tail-calling the chain stub.
 */
export function buildLibKernelModule(opts = {}) {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 32768, 32768, !!opts.shared);
  m.importTable('env', 'table', 1, undefined);
  const chainIdx = m.importFunc('env', 'chain', REGION_PARAMS, REGION_RESULTS);
  LIB_KERNELS.forEach((d, i) => {
    const c = new Code();
    const fallback = c.block();
    if (d.kind === 'round') emitRound(c, d.k, fallback);
    else if (d.kind === 'fabs') emitFabs(c, d.k, fallback);
    else throw new Error(`libkernels: unknown kind ${d.kind}`);
    emitReturn(c, chainIdx, opts.chain !== false);
    c.end(); // fallback: the original code from its entry (Jit.run: EXIT_STEP; the instruction stepped charged here, as a region charges its own)
    c.get(P.IC).i32(1).sub().set(P.IC);
    REGION_ARG_OFFSETS.forEach((off, k) => c.get(P.STATE).get(2 + k).i32store(off));
    c.get(P.STATE).get(P.ENTRY).i32store(ST.EIP);
    c.get(P.STATE).i32(EXIT_STEP).i32store(ST.EXIT);
    c.i32(0);
    m.exportFunc('k' + i, m.func(REGION_PARAMS, REGION_RESULTS, LOCALS, c, 'lib_' + d.name.replace(/\W/g, '_')));
  });
  return m.build();
}

/** the return to the caller: ESP past the return address, the budget charged L_N instructions, the chain stub */
function emitReturn(c, chainIdx, chain) {
  c.get(P.IC).get(L_N).sub().set(P.IC);
  c.get(P.ESP).i32load(0).set(L_G); // (the return address)
  c.get(P.ESP).i32(4).add().set(P.ESP);
  if (chain) {
    c.get(L_G);
    for (let i = P.STATE; i <= P.IC; i++) c.get(i);
    c.return_call(chainIdx);
    return;
  }
  REGION_ARG_OFFSETS.forEach((off, k) => c.get(P.STATE).get(2 + k).i32store(off));
  c.get(P.STATE).get(L_G).i32store(ST.EIP);
  c.get(L_G).return_();
}

/** guards common to every kernel: ESP with room for the frame below it and the arguments above (else the exact way) */
function guardStack(c, fallback, below, above) {
  c.get(P.ESP).set(L_S);
  c.get(L_S).i32(0x10000 + below).sub().i32(0x7f000000 - above - (0x10000 + below)).gt_u().br_if(fallback);
}
/** L_T = TOP, L_TW = the tag word, L_CW = the control word; fallback unless the physical registers TOP-1..TOP-n are empty */
function guardPushes(c, fallback, n) {
  c.get(P.STATE).i32load8u(ST.FPU_TOP).set(L_T);
  c.get(P.STATE).i32load16u(ST.FPU_TW).set(L_TW);
  c.get(P.STATE).i32load16u(ST.FPU_CW).set(L_CW);
  for (let k = 1; k <= n; k++) { c.get(L_TW).i32(1).get(L_T).i32(k).sub().i32(7).and().shl().and().br_if(fallback); }
}
/** an infinity or a NaN in the double at [S+4]: fallback (L_HI, L_LO = its words) */
function guardFinite(c, fallback) {
  c.get(L_S).i32load(4).set(L_LO);
  c.get(L_S).i32load(8).tee(L_HI).i32(0x7ff00000).and().i32(0x7ff00000).eq().br_if(fallback);
}
/** S - d (as an address with a negative static offset: the base computed) */
function at(c, d) { c.get(L_S).i32(d).sub(); }
/** x87: physical register (TOP - k) & 7 = f64 on the stack top (emitted by `emit`) */
function setFprBelow(c, k, emit) { c.get(P.STATE).get(L_T).i32(k).sub().i32(7).and().i32(3).shl().add(); emit(); c.f64store(ST.FPR); }

/**
 * floor / ceil, the x87 path. On entry S = ESP (the return address), x at [S+4]. The code: push ebp / ecx / ecx / ebx /
 * esi, _ctrlfp(G, 0xffff) — G the routine's control word in the library's data (round down or up) —, fld x, the class
 * of x from its high word (an infinity or a NaN: _sptype and the error paths), the frndint helper (fld; frndint; fstp;
 * fld), r stored at [ebp-8], fucompp of r and x, fnstsw; an inexact result with PM unmasked raises (the error path);
 * _ctrlfp(caller's control word C, 0xffff), fld r, pops, leave, ret. What it leaves: see the stores below.
 */
function emitRound(c, k, fallback) {
  guardStack(c, fallback, 40, 12);
  c.get(P.ENTRY).i32load(k.sse2).br_if(fallback); // (__sse2_available: the SSE2 path)
  c.get(P.ENTRY).i32load(k.cwg).tee(L_G).i32(0xc00).and().i32(k.rc << 10).ne().br_if(fallback); // (G rounds the way of this kernel)
  guardFinite(c, fallback);
  guardPushes(c, fallback, 2);
  c.get(L_S).f64load(4).tee(L_X);
  if (k.rc === 1) c.f64floor(); else c.f64ceil();
  c.set(L_R);
  c.i32(k.n).set(L_N);
  c.get(L_R).get(L_X).f64ne();
  const inexact = c.if_();
  c.get(L_CW).i32(0x20).and().eqz().br_if(fallback); // (PM unmasked: the precision exception raised)
  c.i32(k.n + 2).set(L_N); // (test bl, 0x20 ; jne)
  c.end(); void inexact;
  // the stack below S, as the code leaves it
  const s = (d, emit) => { at(c, d); emit(); c.i32store(0); };
  s(4, () => c.get(P.EBP)); // push ebp
  at(c, 12); c.get(L_R).f64store(0); // fstp [ebp-8] (over the two ecx pushed)
  s(16, () => c.get(P.EBX)); s(20, () => c.get(P.ESI));
  s(24, () => c.get(L_HI).i32(0xffff0000 | 0).and().get(L_CW).or()); // (the last _ctrlfp's new control word, written at its argument)
  s(28, () => c.get(L_CW).extend16_s()); // (its argument: ebx = movsx of the first _ctrlfp's result)
  s(32, () => c.get(P.ENTRY).i32(k.ret).add()); // (its return address)
  s(36, () => c.get(L_S).i32(4).sub()); // (its push ebp)
  s(40, () => c.get(L_HI).i32(0xffff0000 | 0).and().get(L_G).i32(0x1f3f).and().i32(0x40).or().or()); // (its push ecx, fnstcw over the low half)
  // x87: r pushed twice below TOP (fld x / fld r, fucompp), r left at TOP-1
  setFprBelow(c, 1, () => c.get(L_R));
  setFprBelow(c, 2, () => c.get(L_R));
  c.get(P.STATE).get(L_T).i32(1).sub().i32(7).and().i32store8(ST.FPU_TOP);
  c.get(P.STATE).get(L_TW).i32(1).get(L_T).i32(1).sub().i32(7).and().shl().or().i32store16(ST.FPU_TW);
  c.get(P.STATE).get(L_CW).i32(0x1f3f).and().i32(0x40).or().i32store16(ST.FPU_CW);
  // the condition codes of fucompp (r, x): equal C3, r < x C0, r > x none; C1 cleared
  c.get(P.STATE).get(P.STATE).i32load16u(ST.FPU_SW).i32(~SW_CC).and();
  c.get(L_R).get(L_X).f64eq(); const eq = c.if_(T.i32); c.i32(C3); c.else_(); c.i32(C0).i32(0).get(L_R).get(L_X).f64lt().select(); c.end(); void eq;
  c.or().i32store16(ST.FPU_SW);
  // registers: eax = movsx of the last _ctrlfp's old control word (G's), ecx = the word its `or` made (the flags too)
  c.get(L_G).i32(0x1f3f).and().i32(0x40).or().set(P.EAX);
  c.get(L_HI).i32(0xffff0000 | 0).and().get(L_CW).or().tee(P.ECX).set(P.LZRES);
  c.i32(LOGIC32).set(P.LZOP); c.i32(0).set(P.LZA); c.i32(0).set(P.LZB);
}

/**
 * fabs, the finite path: push ebp / ecx / ecx / esi / edi, _ctrlfp(0x133f, 0xffff), the class of x from its high word,
 * [ebp-4] = high word without its sign, [ebp-8] = low word, _ctrlfp(caller's control word C, 0xffff), fld [ebp-8], pops,
 * leave, ret.
 */
function emitFabs(c, k, fallback) {
  guardStack(c, fallback, 40, 12);
  guardFinite(c, fallback);
  guardPushes(c, fallback, 1);
  c.i32(k.n).set(L_N);
  const s = (d, emit) => { at(c, d); emit(); c.i32store(0); };
  s(4, () => c.get(P.EBP));
  s(8, () => c.get(L_HI).i32(0x7fffffff).and());
  s(12, () => c.get(L_LO));
  s(16, () => c.get(P.ESI)); s(20, () => c.get(P.EDI));
  s(24, () => c.get(P.ECX).i32(0xffff0000 | 0).and().get(L_CW).or());
  s(28, () => c.get(L_CW).extend16_s());
  s(32, () => c.get(P.ENTRY).i32(k.ret).add());
  s(36, () => c.get(L_S).i32(4).sub());
  s(40, () => c.get(P.ECX).i32(0xffff0000 | 0).and().i32(0x137f).or()); // (0x133f as fldcw keeps it)
  setFprBelow(c, 1, () => { at(c, 12); c.f64load(0); });
  c.get(P.STATE).get(L_T).i32(1).sub().i32(7).and().i32store8(ST.FPU_TOP);
  c.get(P.STATE).get(L_TW).i32(1).get(L_T).i32(1).sub().i32(7).and().shl().or().i32store16(ST.FPU_TW);
  c.get(P.STATE).get(L_CW).i32(0x1f3f).and().i32(0x40).or().i32store16(ST.FPU_CW);
  c.get(P.STATE).get(P.STATE).i32load16u(ST.FPU_SW).i32(~C1).and().i32store16(ST.FPU_SW);
  c.i32(0x137f).set(P.EAX);
  c.get(P.ECX).i32(0xffff0000 | 0).and().get(L_CW).or().tee(P.ECX).set(P.LZRES);
  c.i32(LOGIC32).set(P.LZOP); c.i32(0).set(P.LZA); c.i32(0).set(P.LZB);
}
