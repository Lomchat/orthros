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
    ranges: [[0, 0x11f], [0x7c377361 - 0x7c34539f, 0xd3], [0x7c375c77 - 0x7c34539f, 0x24], [0x7c377650 - 0x7c34539f, 0x11], [0x7c3824b0 - 0x7c34539f, 0x50]],
    relocs: [0x2, 0x48, 0x61, 0xe5, 0xff, 0x108, 0x110, 0x31fd1, 0x32031], hash: [0x6d20c56d, 0xd50f6b6a],
    k: { sse2: 0x7c38b300 - 0x7c34539f, cwg: 0x7c390bc8 - 0x7c34539f, ret: 0x7c377407 - 0x7c34539f, rc: 1, n: 85 },
  },
  {
    name: 'msvcr71!ceil', kind: 'round', ref: 0x7c345284, first: 0x83,
    ranges: [[0, 0x11b], [0x7c37728e - 0x7c345284, 0xd3], [0x7c375c77 - 0x7c345284, 0x24], [0x7c377650 - 0x7c345284, 0x11], [0x7c382460 - 0x7c345284, 0x50]],
    relocs: [0x2, 0x48, 0x61, 0xe5, 0xfa, 0x103, 0x10c, 0x32019, 0x32079], hash: [0x9365b624, 0x75fb52c5],
    k: { sse2: 0x7c38b300 - 0x7c345284, cwg: 0x7c390bc4 - 0x7c345284, ret: 0x7c377334 - 0x7c345284, rc: 2, n: 85 },
  },
  // memcmp: the byte loop (a pointer not 4-aligned), or repz cmpsd and the tail's byte tests; the bytes compared and
  // the result, ecx / edx as the last compare left them, the instructions of the loops' iterations
  {
    name: 'msvcr71!memcmp', kind: 'memcmp', ref: 0x7c343234, first: 0x8b,
    ranges: [[0, 0xb8]], relocs: [], hash: [0x61345d54, 0xd0825227],
    k: {},
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
const L_B1 = 26, L_B2 = 27, L_LEN = 28, L_I = 29, L_U = 30, L_J = 31, L_Q = 32, L_XB = 33, L_TB = 34, L_RB = 35;
const LOCALS = [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.f64, T.f64, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i64, T.i64, T.i64, T.i64];

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
    const ret = () => emitReturn(c, chainIdx, opts.chain !== false);
    if (d.kind === 'round') emitRound(c, d.k, fallback, ret);
    else if (d.kind === 'fabs') emitFabs(c, d.k, fallback);
    else if (d.kind === 'memcmp') emitMemcmp(c, fallback);
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
function emitRound(c, k, fallback, ret) {
  guardStack(c, fallback, 40, 12);
  guardPushes(c, fallback, 1);
  c.get(P.ENTRY).i32load(k.sse2);
  const sse = c.if_(); emitRoundSse(c, k, fallback, ret); c.end(); void sse; // (__sse2_available: the SSE2 path)
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

/**
 * memcmp(b1, b2, n): n = 0 returns at once. Else push esi / edi, esi = b1, edi = b2, edx = (b1 | b2) & 3. Not 4-aligned:
 * an odd n compares its first byte (cmp cl, [edi]), then pairs of bytes (cl / dl loaded) until n is used up. Aligned:
 * repz cmpsd over n / 4 words, a differing word's bytes tested in order (ecx / edx: the words, shifted right by 16 for
 * the upper two bytes); then the n % 4 tail bytes from the next words (edx = b1's, ecx = b2's, the third byte compared
 * under the mask 0xff0000). A difference: sbb eax, eax ; pop edi ; sbb eax, -1 (1 or -1, the flags of that sbb); equal:
 * eax 0, the flags of the last test / sub. The bytes are compared 8 at a time; the registers and the instruction count
 * follow from where the first difference is.
 */
function emitMemcmp(c, fallback) {
  guardStack(c, fallback, 8, 16);
  c.get(P.EFL).i32(0x400).and().br_if(fallback); // (DF set: repz cmpsd backwards)
  const done = c.block();
  c.get(L_S).i32load(12).tee(L_LEN).eqz();
  const zero = c.if_(); // mov eax, [esp+12] ; test eax, eax ; je ; ret
  c.i32(4).set(L_N); eqFlags(c, LZ.LOGIC, 0, 0); c.br(done);
  c.end(); void zero;
  c.get(L_S).i32load(4).set(L_B1); c.get(L_S).i32load(8).set(L_B2);
  // (pointers in the first 64 KiB, near the end of the space, a huge length: the exact way)
  c.get(L_LEN).i32(0x7f000000).gt_u().br_if(fallback);
  for (const b of [L_B1, L_B2]) {
    c.get(b).i32(0x10000).lt_u().br_if(fallback);
    c.get(b).i32(0x7fff0000 - 8).get(L_LEN).sub().gt_u().br_if(fallback);
  }
  at(c, 4); c.get(P.ESI).i32store(0); at(c, 8); c.get(P.EDI).i32store(0);
  // L_I = the first differing byte (n: none)
  c.i32(0).set(L_I);
  const found = c.block();
  const wide = c.loop();
  c.get(L_I).i32(8).add().get(L_LEN).le_u();
  const w = c.if_();
  c.get(L_B1).get(L_I).add().i64load(0, 0).get(L_B2).get(L_I).add().i64load(0, 0).i64xor().tee(L_Q).i64eqz().eqz();
  const hit = c.if_(); c.get(L_I).get(L_Q).i64ctz().wrap().i32(3).shr_u().add().set(L_I); c.br(found); c.end(); void hit;
  c.get(L_I).i32(8).add().set(L_I); c.br(wide);
  c.end(); void w;
  c.end(); void wide;
  const narrow = c.loop();
  c.get(L_I).get(L_LEN).ge_u().br_if(found);
  c.get(L_B1).get(L_I).add().i32load8u(0).get(L_B2).get(L_I).add().i32load8u(0).ne().br_if(found);
  c.get(L_I).i32(1).add().set(L_I); c.br(narrow);
  c.end(); void narrow;
  c.end(); void found;
  const b1At = (i) => { c.get(L_B1); i(); c.add().i32load8u(0); };
  const b2At = (i) => { c.get(L_B2); i(); c.add().i32load8u(0); };
  c.get(L_B1).get(L_B2).or().i32(3).and().tee(L_U);
  const unaligned = c.if_();
  {
    // ecx keeps its upper bytes (cl written); edx = U, then dl written
    const lowEcx = (i) => { c.get(P.ECX).i32(~0xff).and(); b1At(i); c.or().set(P.ECX); };
    c.get(L_LEN).i32(1).and();
    const odd = c.if_();
    c.get(L_I).eqz();
    const first = c.if_(); c.i32(21).set(L_N); lowEcx(() => c.i32(0)); c.get(L_U).set(P.EDX); diffFlags(c); c.br(done); c.end(); void first;
    c.get(L_LEN).i32(1).eq();
    const one = c.if_(); c.i32(23).set(L_N); lowEcx(() => c.i32(0)); c.get(L_U).set(P.EDX); eqFlags(c, LZ.SUB, 1, 1); c.br(done); c.end(); void one;
    c.i32(1).set(L_J); c.i32(20).set(L_N); // (the pairs from byte 1, 20 instructions before them)
    c.else_();
    c.i32(0).set(L_J); c.i32(13).set(L_N);
    c.end(); void odd;
    c.get(L_I).get(L_LEN).lt_u();
    const d = c.if_(); // the pair holding byte I: 12 per pair before it, 4 or 8 in it, then sbb ... ret: 5
    c.get(L_N).get(L_I).get(L_J).sub().i32(1).shr_u().i32(12).mul().add().i32(9).get(L_I).get(L_J).sub().i32(1).and().i32(2).shl().add().add().set(L_N);
    lowEcx(() => c.get(L_I)); b2At(() => c.get(L_I)); c.set(P.EDX); diffFlags(c); c.br(done);
    c.end(); void d;
    c.get(L_N).get(L_LEN).get(L_J).sub().i32(1).shr_u().i32(12).mul().add().i32(3).add().set(L_N);
    lowEcx(() => c.get(L_LEN).i32(1).sub()); b2At(() => c.get(L_LEN).i32(1).sub()); c.set(P.EDX); eqFlags(c, LZ.SUB, 2, 2); c.br(done);
  }
  c.end(); void unaligned;
  {
    // aligned: L_J = 4 * (n / 4), the words' bytes
    c.get(L_LEN).i32(~3).and().set(L_J);
    c.get(L_I).get(L_J).lt_u();
    const inWord = c.if_(); // a differing word (repz cmpsd stops after it): its byte I & 3
    c.get(L_B1).get(L_I).i32(~3).and().add().i32load(0).set(P.ECX);
    c.get(L_B2).get(L_I).i32(~3).and().add().i32load(0).set(P.EDX);
    c.get(L_I).i32(2).and();
    const hiHalf = c.if_();
    c.get(P.ECX).i32(16).shr_u().set(P.ECX); c.get(P.EDX).i32(16).shr_u().set(P.EDX);
    c.i32(34).i32(33).get(L_I).i32(1).and().select().set(L_N);
    c.else_();
    c.i32(29).i32(27).get(L_I).i32(1).and().select().set(L_N);
    c.end(); void hiHalf;
    diffFlags(c); c.br(done);
    c.end(); void inWord;
    // the tail: t0 = 17 after repz cmpsd, 15 when n < 4 (shr's je)
    c.i32(17).i32(15).get(L_J).select().set(L_N);
    c.get(L_LEN).i32(3).and().tee(L_U).eqz();
    const none = c.if_(); c.get(L_N).i32(5).add().set(L_N); c.i32(0).set(P.ECX); c.i32(0).set(P.EDX); eqFlags(c, LZ.LOGIC, 0, 0); c.br(done); c.end(); void none;
    c.get(L_B1).get(L_J).add().i32load(0).set(P.EDX); c.get(L_B2).get(L_J).add().i32load(0).set(P.ECX);
    const tail = (j, nDiff, nEq, last) => { // byte j of the tail: it differs (I = J + j), or the tail ends after it (U = j + 1)
      c.get(L_I).get(L_J).i32(j).add().eq();
      const dj = c.if_(); c.get(L_N).i32(nDiff).add().set(L_N); diffFlags(c); c.br(done); c.end(); void dj;
      let e = null;
      if (!last) { c.get(L_U).i32(j + 1).eq(); e = c.if_(); }
      c.get(L_N).i32(nEq).add().set(L_N); eqFlags(c, LZ.SUB, 1, 1); c.br(done);
      if (e) c.end();
    };
    tail(0, 12, 11, false);
    tail(1, 16, 15, false);
    c.get(P.ECX).i32(0xff0000).and().set(P.ECX); c.get(P.EDX).i32(0xff0000).and().set(P.EDX);
    tail(2, 22, 20, true);
  }
  c.end(); // done
}
/** the result of a difference at byte I: CF = b1[I] < b2[I]; sbb eax, eax ; sbb eax, -1 -> -1 / 1 and that sbb's flags */
function diffFlags(c) {
  c.get(L_B1).get(L_I).add().i32load8u(0).get(L_B2).get(L_I).add().i32load8u(0).lt_u().set(L_G);
  c.i32(1).get(L_G).i32(1).shl().sub().tee(P.EAX).set(P.LZRES);
  c.i32((LZ.SBB << 2) | 2).set(P.LZOP); c.i32(0).get(L_G).sub().set(P.LZA); c.i32(-1).set(P.LZB);
}
/** equal: eax = 0, the flags of the last `kind` instruction (a, b: its operands, the result 0) */
function eqFlags(c, kind, a, b) {
  c.i32(0).set(P.EAX); c.i32(0).set(P.LZRES); c.i32((kind << 2) | 2).set(P.LZOP); c.i32(a).set(P.LZA); c.i32(b).set(P.LZB);
}

/**
 * floor / ceil, the SSE2 path (__sse2_available set; MXCSR's exceptions all masked, the control word's too — else the
 * x87 path follows, left to the exact way). sub esp, 8 ; stmxcsr [esp+4] ; fnstcw [esp] (eax: their tests) ; lea esp,
 * [esp+8] ; xmm0 = x, xmm2 = (0x433, 0x433) - (biased exponent E, 0) dword-wise, xmm1 = x >> (0x433 - E) (xmm7 = x,
 * eax = sign and exponent); then by side — the one where the truncation is the result (floor: x >= 0, ceil: x < 0) and
 * the other — and by size (|x| < 1, an integral exponent, else): the truncation shifted back, the adjustment by 1.0
 * from a compare mask (cmpltpd / cmpnlepd), the result stored over the argument and loaded (fld), or a constant loaded
 * (|x| < 1 on the truncation's side: +0 / -0). A NaN takes the error path (the exact way); an infinity is returned as it is.
 */
function emitRoundSse(c, k, fallback, ret) {
  const floor = k.rc === 1;
  c.get(P.STATE).i32load(ST.MXCSR).tee(L_G).i32(0x1f80).and().i32(0x1f80).ne().br_if(fallback);
  c.get(L_G).i32(0x8040).and().br_if(fallback); // (DAZ / FTZ: denormals compared as zeros — the exact way)
  c.get(L_CW).i32(0x7f).and().i32(0x7f).ne().br_if(fallback);
  c.get(L_S).i64load(4, 2).tee(L_XB).i64(52n).i64shr_u().wrap().tee(L_LO).i32(0x7ff).and().tee(L_HI); // L_LO = e12 (sign, exponent), L_HI = E
  c.i32(0x7ff).eq().get(L_XB).i64(0xfffffffffffffn).i64and().i64eqz().eqz().and().br_if(fallback); // (a NaN: the error path)
  // stores of the probe; eax = e12
  at(c, 4); c.get(L_G).i32store(0);
  at(c, 8); c.get(L_CW).i32store16(0);
  c.get(L_LO).set(P.EAX);
  // L_TB = the truncation (xmm1 after psrlq / psllq by the count 0x433 - E, as an unsigned dword: 0 from 64 on)
  c.i32(0x433).get(L_HI).sub().tee(L_J).i32(63).gt_u();
  const big0 = c.if_(T.i64); c.i64(0n); c.else_(); c.get(L_XB).i64(-1n).get(L_J).extend_u().i64shl().i64and(); c.end(); void big0;
  c.set(L_TB);
  const xmm = (i, lane, emit) => { c.get(P.STATE); emit(); c.i64store(ST.XMM + 16 * i + 8 * lane, 3); };
  xmm(7, 0, () => c.get(L_XB)); xmm(7, 1, () => c.i64(0n));
  xmm(2, 0, () => c.get(L_J).extend_u()); xmm(2, 1, () => c.i64(0x433n));
  xmm(1, 1, () => c.i64(0n)); xmm(0, 1, () => c.i64(0n));
  const flagsCmp = (lim) => { c.get(L_LO).i32(0x800).and().i32(lim).or().set(P.LZB); c.get(L_LO).set(P.LZA); c.get(L_LO).get(P.LZB).sub().set(P.LZRES); c.i32((LZ.SUB << 2) | 2).set(P.LZOP); };
  const flagsUcomi = () => { c.get(P.EFL).i32(~0x8d5).and().i32(0x40).or().set(P.EFL); c.i32(0).set(P.LZOP); }; // (ucomisd x, x: ZF)
  const push = () => { // fld: the result bits L_RB pushed
    setFprBelow(c, 1, () => c.get(L_RB).f64reinterpret_i64());
    c.get(P.STATE).get(L_T).i32(1).sub().i32(7).and().i32store8(ST.FPU_TOP);
    c.get(P.STATE).get(L_TW).i32(1).get(L_T).i32(1).sub().i32(7).and().shl().or().i32store16(ST.FPU_TW);
    c.get(P.STATE).get(P.STATE).i32load16u(ST.FPU_SW).i32(~C1).and().i32store16(ST.FPU_SW);
  };
  const store = () => { c.get(L_S).get(L_RB).i64store(4, 2); };
  c.get(L_LO).i32(0x800).and();
  if (floor) c.eqz();
  const simple = c.if_(); // the side where the truncation is the result
  {
    xmm(0, 0, () => c.get(L_HI).extend_u());
    c.get(L_HI).i32(0x3ff).lt_u();
    const small = c.if_(); // |x| < 1: a constant (fldz / fld -0.0); xmm1 = x >> count (no psllq)
    xmm(1, 0, () => { c.get(L_J).i32(63).gt_u(); const b = c.if_(T.i64); c.i64(0n); c.else_(); c.get(L_XB).get(L_J).extend_u().i64shr_u(); c.end(); void b; });
    c.i64(floor ? 0n : -0x8000000000000000n).set(L_RB); flagsCmp(0x3ff); c.i32(29).set(L_N); push(); ret();
    c.end(); void small;
    xmm(1, 0, () => c.get(L_TB));
    c.get(L_HI).i32(0x432).gt_u();
    const big = c.if_(); c.get(L_XB).set(L_RB); flagsUcomi(); c.i32(34).set(L_N); push(); ret(); c.end(); void big;
    c.get(L_TB).set(L_RB); store(); flagsCmp(0x432); c.i32(33).set(L_N); push(); ret();
  }
  c.end(); void simple;
  {
    // the other side: xmm0 = the compare mask of x against the truncation (floor: x < t, ceil: x > t), xmm3 = x
    xmm(1, 0, () => c.get(L_TB));
    c.i64(0n).get(L_XB).f64reinterpret_i64().get(L_TB).f64reinterpret_i64();
    if (floor) c.f64lt(); else c.f64gt();
    c.extend_u().i64sub().set(L_Q); // (all ones or 0)
    xmm(0, 0, () => c.get(L_Q));
    xmm(3, 0, () => c.get(L_XB)); xmm(3, 1, () => c.i64(0n));
    c.get(L_HI).i32(0x3ff).lt_u();
    const small = c.if_(); // |x| < 1: floor -1.0 or -0.0, ceil 1.0 or +0.0 (from a compare with -0.0 / +0.0)
    c.get(L_XB).f64reinterpret_i64().f64c(0);
    if (floor) { c.f64lt(); const s = c.if_(T.i64); c.i64(-0x4010000000000000n); c.else_(); c.i64(-0x8000000000000000n); c.end(); void s; }
    else { c.f64gt(); const s = c.if_(T.i64); c.i64(0x3ff0000000000000n); c.else_(); c.i64(0n); c.end(); void s; }
    c.set(L_RB); xmm(3, 0, () => c.get(L_RB)); store(); flagsCmp(0x3ff); c.i32(floor ? 37 : 36).set(L_N); push(); ret();
    c.end(); void small;
    c.get(L_HI).i32(0x432).gt_u();
    const big = c.if_(); c.get(L_XB).set(L_RB); flagsUcomi(); c.i32(37).set(L_N); push(); ret(); c.end(); void big;
    // andpd with 1.0, then subsd / addsd (exact: |t| < 2^52)
    c.get(L_Q).i64(0x3ff0000000000000n).i64and().set(L_Q);
    xmm(0, 0, () => c.get(L_Q));
    c.get(L_TB).f64reinterpret_i64().get(L_Q).f64reinterpret_i64();
    if (floor) c.f64sub(); else c.f64add();
    c.i64reinterpret_f64().set(L_RB);
    xmm(1, 0, () => c.get(L_RB)); store(); flagsCmp(0x432); c.i32(38).set(L_N); push(); ret();
  }
}
