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
import { SMC_MAP_BASE, SMC_CODE, SMC_WATCH, SMC_NULL, THUNK_BASE, THUNK_END } from '../memory.js';
import { USER_END } from '../nullpage.js';
import { REGION_PARAMS, REGION_RESULTS, REGION_ARG_OFFSETS, EXIT_STEP, LZ, FAST_STATS, FAST_TABLE, FAST } from './runtime.js';

/** the calls of each kernel (u32 per definition, counted by the kernel: the share of calls off its path, see Jit.libFallback) */
export const LIB_CALLS = FAST_STATS + 0x100;
/**
 * the entry of each definition's live kernel (u32 per definition, 0: none; Jit.libKernel / dropOne): what a region running
 * a kernel inline checks at run time (translate.js libInlineOf) — the code at that entry still the bytes recognised
 */
export const LIB_LIVE = FAST_STATS + 0x180;

// x87 status word condition codes (interp-x87.js)
const C0 = 0x100, C1 = 0x200, C3 = 0x4000, SW_CC = 0x4700;
const LOGIC32 = (LZ.LOGIC << 2) | 2;

// msvcr71's _getptd (emitGetptd), and the data its common path and the locale check read — the import slots of
// GetLastError and SetLastError, the TlsGetValue / FlsGetValue pointer, the TLS index, __ptlocinfo —, as offsets from a
// kernel's entry in the reference build (the fingerprint holds their addresses relative to the entry)
const GETPTD = 0x7c349636;
const getptdK = (ref) => ({ gle: 0x7c37a044 - ref, tlsv: 0x7c38b428 - ref, tlsi: 0x7c38b430 - ref, sle: 0x7c37a054 - ref, ploc: 0x7c38ef44 - ref });

/**
 * Kernel definitions. `ranges`: [offset from the entry, length] of the bytes the kernel depends on; `relocs`: offsets
 * from the entry of the absolute addresses among them; `hash`: their fingerprint (libFingerprint); `first`, `quick`: the
 * first byte and a hash of the first bytes (libQuick), probes before the fingerprint; `ref`: the entry in
 * the reference build (msvcr71.dll 7.10.3052.4, preferred base 0x7c340000; documentation, and the offsets below are
 * written from it); `k`: the kernel's constants. tools/gen/libkernel-sigs.mjs prints the relocs and hashes of a DLL.
 */
export const LIB_KERNELS = Object.freeze([
  // floor / ceil (x87 path: __sse2_available clear): _ctrlfp(round-down / up control word), the frndint helper, a
  // compare with the argument (an inexact result with the precision exception unmasked raises: not this path),
  // _ctrlfp(caller's control word), the result pushed
  {
    name: 'msvcr71!floor', kind: 'round', ref: 0x7c34539f, quick: 0x7672dea5, first: 0x83,
    ranges: [[0, 0x11f], [0x7c377361 - 0x7c34539f, 0xd3], [0x7c375c77 - 0x7c34539f, 0x24], [0x7c377650 - 0x7c34539f, 0x11], [0x7c3824b0 - 0x7c34539f, 0x50]],
    relocs: [0x2, 0x48, 0x61, 0xe5, 0xff, 0x108, 0x110, 0x31fd1, 0x32031], hash: [0x6d20c56d, 0xd50f6b6a],
    k: { sse2: 0x7c38b300 - 0x7c34539f, cwg: 0x7c390bc8 - 0x7c34539f, ret: 0x7c377407 - 0x7c34539f, rc: 1, n: 85 },
  },
  {
    name: 'msvcr71!ceil', kind: 'round', ref: 0x7c345284, quick: 0x877cf24d, first: 0x83,
    ranges: [[0, 0x11b], [0x7c37728e - 0x7c345284, 0xd3], [0x7c375c77 - 0x7c345284, 0x24], [0x7c377650 - 0x7c345284, 0x11], [0x7c382460 - 0x7c345284, 0x50]],
    relocs: [0x2, 0x48, 0x61, 0xe5, 0xfa, 0x103, 0x10c, 0x32019, 0x32079], hash: [0x9365b624, 0x75fb52c5],
    k: { sse2: 0x7c38b300 - 0x7c345284, cwg: 0x7c390bc4 - 0x7c345284, ret: 0x7c377334 - 0x7c345284, rc: 2, n: 85 },
  },
  // memcmp: the byte loop (a pointer not 4-aligned), or repz cmpsd and the tail's byte tests; the bytes compared and
  // the result, ecx / edx as the last compare left them, the instructions of the loops' iterations
  {
    name: 'msvcr71!memcmp', kind: 'memcmp', ref: 0x7c343234, quick: 0x69c5fee, first: 0x8b,
    ranges: [[0, 0xb8]], relocs: [], hash: [0x61345d54, 0xd0825227],
    k: {},
  },
  // memcpy (a memmove): the forward copy to a 4-aligned destination; its jump tables are among the bytes fingerprinted
  {
    name: 'msvcr71!memcpy', kind: 'memcpy', ref: 0x7c342ebb, quick: 0xc6748697, first: 0x55,
    ranges: [[0, 0x7c343056 - 0x7c342ebb]], relocs: [0x38, 0x50, 0x57, 0x5e, 0x65, 0x69, 0x6d, 0x96, 0xb9, 0xd6, 0xe5, 0xe9, 0xed, 0xf1, 0xf5, 0xf9, 0xfd, 0x101, 0x14b, 0x151, 0x155, 0x159, 0x15d],
    hash: [0x3d056856, 0xf18432d],
    k: {},
  },
  // fabs: _ctrlfp(0x133f), the sign bit cleared through the frame, _ctrlfp(caller's control word), the result pushed
  {
    name: 'msvcr71!fabs', kind: 'fabs', ref: 0x7c374dc3, quick: 0x464f3c66, first: 0x55,
    ranges: [[0, 0xb1], [0x7c375c77 - 0x7c374dc3, 0x24]],
    relocs: [0x46], hash: [0xbee672fa, 0xd3255eb6],
    k: { ret: 0x7c374e6b - 0x7c374dc3, n: 64 },
  },
  // _stricmp, the "C" locale (emitStricmp): the function, _getptd (its data present) and __ascii_stricmp
  {
    name: 'msvcr71!_stricmp', kind: 'stricmp', ref: 0x7c3505dc, quick: 0xa8b499f4, first: 0x55,
    ranges: [[0, 0x69], [GETPTD - 0x7c3505dc, 0x71], [0x7c3432ec - 0x7c3505dc, 0x4e]],
    relocs: [-0x6fa2, -0x6f9c, -0x6f94, -0x6f73, -0x6f6d, -0x6f62, -0x6f55, -0x6f3e, 0xf], hash: [0x58f7df30, 0xb6b5ad3f],
    k: { ...getptdK(0x7c3505dc), ret: 0x7c350609 - 0x7c3505dc },
  },
  // tolower, the "C" locale (emitTolower): the function, _getptd and _tolower_lk
  {
    name: 'msvcr71!tolower', kind: 'tolower', ref: 0x7c352396, quick: 0x8ca2f045, first: 0xe8,
    ranges: [[0, 0x22], [GETPTD - 0x7c352396, 0x71], [0x7c3522ce - 0x7c352396, 0xc8]],
    relocs: [-0x8d5c, -0x8d56, -0x8d4e, -0x8d2d, -0x8d27, -0x8d1c, -0x8d0f, -0x8cf8, 0xa], hash: [0x58a776aa, 0x8eafd8a2],
    k: { ...getptdK(0x7c352396), ret: 0x7c3523b5 - 0x7c352396 },
  },
  // strtok (emitStrtok): the function, _getptd and __security_check_cookie
  {
    name: 'msvcr71!strtok', kind: 'strtok', ref: 0x7c36ff6c, quick: 0x50d24028, first: 0x55,
    ranges: [[0, 0xb5], [GETPTD - 0x7c36ff6c, 0x71], [0x7c341aed - 0x7c36ff6c, 0xd]],
    relocs: [-0x2e47d, -0x26932, -0x2692c, -0x26924, -0x26903, -0x268fd, -0x268f2, -0x268e5, -0x268ce, 0x7], hash: [0xfb23afe, 0x2667bd8],
    k: { ...getptdK(0x7c36ff6c), cookie: 0x7c38b118 - 0x7c36ff6c, ret: 0x7c37001f - 0x7c36ff6c, gret: 0x7c3496a2 - 0x7c36ff6c },
  },
]);

/**
 * The definitions a value of the JIT option `libKernels` turns on, or null for none: true every one, false none, a list
 * of names (an array or a comma-separated string; 'memcmp' or 'msvcr71!memcmp') those named.
 */
export function libKernelDefs(v) {
  if (!v) return null;
  if (v === true) return new Set(LIB_KERNELS);
  const names = new Set((Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean));
  const on = new Set(LIB_KERNELS.filter((d) => names.has(d.name) || names.has(d.name.slice(d.name.indexOf('!') + 1))));
  return on.size ? on : null;
}

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

/**
 * The quick probe of `def` at `entry`: FNV-1a of the first QUICK bytes of its code, the bytes of absolute addresses left
 * out (`quick` in the table) — looked at for every block the JIT registers, before the whole fingerprint.
 */
export function libQuick(u8, entry, def) {
  let h = 0x811c9dc5 | 0;
  for (let o = 0; o < QUICK; o++) if (!def.relocs.some((r) => o >= r && o < r + 4)) h = Math.imul(h ^ u8[entry + o], 0x01000193);
  return h >>> 0;
}
const QUICK = 12;
/** The kernel definition whose fingerprint the code at `eip` has, or null; `on`: the definitions looked for (null: all). */
export function matchLibKernel(u8, eip, on = null) {
  if (!BY_FIRST.size) for (const d of LIB_KERNELS) { let l = BY_FIRST.get(d.first); if (!l) BY_FIRST.set(d.first, (l = [])); l.push(d); }
  const l = BY_FIRST.get(u8[eip]);
  if (!l || eip > 0x7fffff00) return null;
  for (const d of l) {
    if ((on && !on.has(d)) || libQuick(u8, eip, d) !== d.quick) continue;
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
    c.i32(0).i32(0).i32load(LIB_CALLS + 4 * i).i32(1).add().i32store(LIB_CALLS + 4 * i);
    const fallback = c.block();
    const ret = () => emitReturn(c, chainIdx, opts.chain !== false);
    if (d.kind === 'round') emitRound(c, d.k, fallback, ret);
    else if (d.kind === 'fabs') emitFabs(c, d.k, fallback);
    else if (d.kind === 'memcmp') emitMemcmp(c, fallback);
    else if (d.kind === 'memcpy') emitMemcpy(c, fallback);
    else if (d.kind === 'stricmp') emitStricmp(c, fallback, KERNEL_LOCALS, null, null, d.k);
    else if (d.kind === 'tolower') emitTolower(c, fallback, KERNEL_LOCALS, null, null, d.k);
    else if (d.kind === 'strtok') emitStrtok(c, fallback, KERNEL_LOCALS, null, null, d.k);
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

/**
 * guards common to every kernel: S = ESP (in local `s`; `preset`: S already there) with room for the frame below it and
 * the arguments above (else the exact way)
 */
function guardStack(c, fallback, below, above, s = L_S, preset = false) {
  if (!preset) c.get(P.ESP).set(s);
  c.get(s).i32(0x10000 + below).sub().i32(0x7f000000 - above - (0x10000 + below)).gt_u().br_if(fallback);
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
 * `L`: the scratch locals (MEMCMP_LOCALS in the kernel, a translated region's own run inline: emitLibInline); `ret`: run
 * inline at a `call [slot]` — S = ESP - 4, the call's return address `ret` written there —, else S = ESP.
 */
function emitMemcmp(c, fallback, L = KERNEL_LOCALS, ret = null) {
  const { S: L_S, N: L_N, LEN: L_LEN, B1: L_B1, B2: L_B2, I: L_I, U: L_U, J: L_J, Q: L_Q } = L;
  if (ret !== null) c.get(P.ESP).i32(4).sub().set(L_S);
  guardStack(c, fallback, 8, 16, L_S, ret !== null);
  c.get(P.EFL).i32(0x400).and().br_if(fallback); // (DF set: repz cmpsd backwards)
  // (the call's push — should a guard below fail, the ordinary call writes the same value at the same place)
  if (ret !== null) c.get(L_S).i32(ret).i32store(0);
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
  c.get(L_S).i32(4).sub().get(P.ESI).i32store(0); c.get(L_S).i32(8).sub().get(P.EDI).i32store(0);
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
    const first = c.if_(); c.i32(21).set(L_N); lowEcx(() => c.i32(0)); c.get(L_U).set(P.EDX); diffFlags(c, L); c.br(done); c.end(); void first;
    c.get(L_LEN).i32(1).eq();
    const one = c.if_(); c.i32(23).set(L_N); lowEcx(() => c.i32(0)); c.get(L_U).set(P.EDX); eqFlags(c, LZ.SUB, 1, 1); c.br(done); c.end(); void one;
    c.i32(1).set(L_J); c.i32(20).set(L_N); // (the pairs from byte 1, 20 instructions before them)
    c.else_();
    c.i32(0).set(L_J); c.i32(13).set(L_N);
    c.end(); void odd;
    c.get(L_I).get(L_LEN).lt_u();
    const d = c.if_(); // the pair holding byte I: 12 per pair before it, 4 or 8 in it, then sbb ... ret: 5
    c.get(L_N).get(L_I).get(L_J).sub().i32(1).shr_u().i32(12).mul().add().i32(9).get(L_I).get(L_J).sub().i32(1).and().i32(2).shl().add().add().set(L_N);
    lowEcx(() => c.get(L_I)); b2At(() => c.get(L_I)); c.set(P.EDX); diffFlags(c, L); c.br(done);
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
    diffFlags(c, L); c.br(done);
    c.end(); void inWord;
    // the tail: t0 = 17 after repz cmpsd, 15 when n < 4 (shr's je)
    c.i32(17).i32(15).get(L_J).select().set(L_N);
    c.get(L_LEN).i32(3).and().tee(L_U).eqz();
    const none = c.if_(); c.get(L_N).i32(5).add().set(L_N); c.i32(0).set(P.ECX); c.i32(0).set(P.EDX); eqFlags(c, LZ.LOGIC, 0, 0); c.br(done); c.end(); void none;
    c.get(L_B1).get(L_J).add().i32load(0).set(P.EDX); c.get(L_B2).get(L_J).add().i32load(0).set(P.ECX);
    const tail = (j, nDiff, nEq, last) => { // byte j of the tail: it differs (I = J + j), or the tail ends after it (U = j + 1)
      c.get(L_I).get(L_J).i32(j).add().eq();
      const dj = c.if_(); c.get(L_N).i32(nDiff).add().set(L_N); diffFlags(c, L); c.br(done); c.end(); void dj;
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
/**
 * the scratch locals of the kernels a region can also run inline (memcmp, _stricmp, tolower), in their kernel functions
 * (G: memcmp's carry in diffFlags, written once S is no longer read: may share it — inline it does)
 */
const KERNEL_LOCALS = Object.freeze({ S: L_S, G: L_G, N: L_N, LEN: L_LEN, B1: L_B1, B2: L_B2, I: L_I, U: L_U, J: L_J, Q: L_Q });
/** the result of a difference at byte I: CF = b1[I] < b2[I]; sbb eax, eax ; sbb eax, -1 -> -1 / 1 and that sbb's flags */
function diffFlags(c, L) {
  c.get(L.B1).get(L.I).add().i32load8u(0).get(L.B2).get(L.I).add().i32load8u(0).lt_u().set(L.G);
  c.i32(1).get(L.G).i32(1).shl().sub().tee(P.EAX).set(P.LZRES);
  c.i32((LZ.SBB << 2) | 2).set(P.LZOP); c.i32(0).get(L.G).sub().set(P.LZA); c.i32(-1).set(P.LZB);
}

/** the kernel kinds a translated region can run inline (emitLibInline) */
export const LIB_INLINE_KINDS = new Set(['memcmp', 'stricmp', 'tolower', 'strtok']);
/**
 * A kernel run inline by a translated region (translate.js libInlineOf, opts.libInline): at an import stub's `jmp [slot]`
 * reached by a call (the return address on the stack: `ret` null) or at a `call [slot]` (`ret`: its return address,
 * pushed below ESP), the slot holding the function's entry `entry`. The region's locals hold the registers, the lazy
 * flags and the budget at the kernel parameters' indices (REGION_PARAMS' order: translate.js L_REG..., L_ICOUNT); `L`
 * names its scratch locals: i32 S, G (may share S), N, LEN, B1, B2, I, U, J, i64 Q. The kernel's effects but for the
 * return: ESP left as it is (the return address not popped), the function's instructions (its `ret` included) left in
 * L.N, not charged. `fallback`: an input off the kernel's path, nothing changed (but the call's push of `ret`, which the
 * ordinary call makes the same; strtok: see emitStrtok).
 */
export function emitLibInline(c, def, fallback, L, ret = null, entry = 0) {
  if (def.kind === 'memcmp') emitMemcmp(c, fallback, L, ret);
  else if (def.kind === 'stricmp') emitStricmp(c, fallback, L, ret, entry, def.k);
  else if (def.kind === 'tolower') emitTolower(c, fallback, L, ret, entry, def.k);
  else if (def.kind === 'strtok') emitStrtok(c, fallback, L, ret, entry, def.k);
  else throw new Error(`libkernels: ${def.name} is not run inline`);
}

/** pushes the address entry + `off`: from the kernel's entry parameter (`ent` null), or the entry a region runs it inline at */
function adr(c, ent, off) { if (ent === null) c.get(P.ENTRY).i32(off).add(); else c.i32((ent + off) | 0); }
/** fallback unless the i32 in local `p` is an address in [64 KiB, USER_END - 256) (a structure the path reads) */
function guardPtr(c, fallback, p) { c.get(p).i32(0x10000).sub().i32(USER_END - 0x10000 - 0x100).ge_u().br_if(fallback); }

/**
 * msvcr71's _getptd on its common path, the thread's data allocated: push ebx / esi, GetLastError, TlsGetValue
 * (__tlsindex) through the pointer the library keeps (TlsGetValue or FlsGetValue), test, SetLastError(the error read
 * first), eax = the data — 15 instructions. The three calls as the region's inline fast APIs and the dispatcher run them
 * (translate.js emitInlineApi, runtime.js fastApi): each slot holding that fast API's thunk, no parked call being
 * resumed, the index below 64 (the TEB's slots); the last error ends as it was. Anything else — the data not allocated
 * yet (0), or at an address the kernel would not read — takes the exact way. Leaves the data pointer in local `ptd`
 * (`t`: a scratch local). The stack it writes (ebx, esi, the error pushed, a return address) is the caller's to write.
 */
function emitGetptd(c, fallback, k, ent, ptd, t) {
  c.get(P.STATE).i32load(ST.RESUMING).br_if(fallback);
  for (const [off, fid] of [[k.gle, FAST.GetLastError], [k.tlsv, FAST.TlsGetValue], [k.sle, FAST.SetLastError]]) {
    adr(c, ent, off); c.i32load(0).i32(THUNK_BASE).sub().tee(t).i32(THUNK_END - THUNK_BASE).ge_u().get(t).i32(15).and().or().br_if(fallback);
    c.get(t).i32(4).shr_u().i32load8u(FAST_TABLE).i32(fid).ne().br_if(fallback);
  }
  adr(c, ent, k.tlsi); c.i32load(0).tee(t).i32(64).ge_u().br_if(fallback);
  c.get(P.STATE).i32load(ST.FS_BASE).get(t).i32(2).shl().add().i32load(0xe10).set(ptd);
  guardPtr(c, fallback, ptd);
}
/**
 * The locale data the string functions read (ptd in `loc` on entry, the locale data after): ptd->ptlocinfo, the library's
 * current one (__ptlocinfo; else __updatetlocinfo: the exact way), whose LC_CTYPE handle is 0 — the "C" locale (any other:
 * its tables, the exact way).
 */
function emitLocaleC(c, fallback, k, ent, loc) {
  c.get(loc).i32load(0x64).tee(loc); adr(c, ent, k.ploc); c.i32load(0).ne().br_if(fallback);
  guardPtr(c, fallback, loc);
  c.get(loc).i32load(0x14).br_if(fallback);
}

/**
 * _stricmp(s1, s2) in the "C" locale: push ebp / ecx / ebx, _getptd (emitGetptd), ebx = its locale data (emitLocaleC),
 * __ascii_stricmp(s1, s2) — push ebp / edi / esi / ebx, al = 0xff, then at each position s2's byte (al) against s1's
 * (ah): equal, `or al, al` (0 ends it: equal); different, both folded to lower case ('A'..'Z' + 0x20 through cl) and
 * compared — equal goes on, else sbb al, al ; sbb al, -1 (-1 or 1, the flags of that sbb) —; movsx eax, al, pops —,
 * the two arguments popped into ecx (s2 left), pop ebx, leave, ret. 51 instructions, 8 per position equal, 23 per
 * position different. The strings are read before the frame is written: one reaching the frame below S (or USER_END)
 * takes the exact way. `L`, `ret`: see emitLibInline; `ent`: the entry (null: the kernel's parameter).
 */
function emitStricmp(c, fallback, L, ret, ent, k) {
  const { S, N, LEN, B1, B2, I, U, J, Q } = L;
  if (ret !== null) c.get(P.ESP).i32(4).sub().set(S);
  guardStack(c, fallback, 40, 12, S, ret !== null);
  if (ret !== null) c.get(S).i32(ret).i32store(0);
  emitGetptd(c, fallback, k, ent, LEN, U);
  emitLocaleC(c, fallback, k, ent, LEN);
  c.get(LEN).extend_u().set(Q); // (the locale data, pushed last: kept in Q)
  c.get(S).i32load(4).set(B1); c.get(S).i32load(8).set(B2);
  // LEN = how far both strings may be read: up to the frame for a string below S, else to USER_END
  for (const [p, first] of [[B1, true], [B2, false]]) {
    c.get(p).i32(0x10000).sub().i32(USER_END - 0x10000).ge_u().br_if(fallback);
    c.get(S).i32(40).sub().i32(USER_END).get(p).get(S).lt_u().select().get(p).sub().tee(U).i32(0).le_s().br_if(fallback);
    if (first) c.get(U).set(LEN); else { c.get(U).get(LEN).get(U).get(LEN).lt_u().select().set(LEN); }
  }
  const lower = (x) => { c.get(x).get(x).i32(0x41).sub().i32(26).lt_u().i32(5).shl().add().set(x); };
  c.i32(51).set(N); c.i32(0).set(I);
  const done = c.block(), diff = c.block(), eq = c.block();
  const lp = c.loop();
  c.get(I).get(LEN).ge_u().br_if(fallback);
  c.get(B2).get(I).add().i32load8u(0).tee(U).get(B1).get(I).add().i32load8u(0).tee(J).eq();
  const same = c.if_();
  c.get(N).i32(8).add().set(N); c.get(U).eqz().br_if(eq);
  c.else_();
  c.get(N).i32(23).add().set(N); lower(U); lower(J); c.get(U).get(J).ne().br_if(diff);
  c.end(); void same;
  c.get(I).i32(1).add().set(I); c.br(lp);
  c.end(); void lp;
  c.end(); // eq: eax 0, the flags of `or al, al` (al 0)
  c.i32(0).set(P.EAX); c.i32(0).set(P.LZRES); c.i32(LZ.LOGIC << 2).set(P.LZOP); c.i32(0).set(P.LZA); c.i32(0).set(P.LZB);
  c.br(done);
  c.end(); // diff: J = s1's byte folded, U = s2's: CF = J < U; sbb al, al ; sbb al, -1
  c.get(J).get(U).lt_u().set(J);
  c.i32(-1).i32(1).get(J).select().set(P.EAX);
  c.i32(0xff).i32(1).get(J).select().set(P.LZRES); c.i32(0).get(J).sub().i32(0xff).and().set(P.LZA); c.i32(0xff).set(P.LZB);
  c.i32(LZ.SBB << 2).set(P.LZOP);
  c.end(); void done;
  // the frame, as the code leaves it
  const st = (d, emit) => { c.get(S).i32(d).sub(); emit(); c.i32store(0); };
  st(4, () => c.get(P.EBP)); st(8, () => c.get(P.ECX)); st(12, () => c.get(P.EBX));
  st(16, () => c.get(B2)); st(20, () => c.get(B1)); st(24, () => adr(c, ent, k.ret)); st(28, () => c.get(S).i32(4).sub());
  st(32, () => c.get(P.EDI)); st(36, () => c.get(P.ESI)); st(40, () => c.get(Q).wrap());
  c.get(B2).set(P.ECX);
}

/**
 * tolower(c) in the "C" locale: _getptd (emitGetptd), eax = its locale data (emitLocaleC), _tolower_lk(locale, c) —
 * push ebp / ecx / ebx / esi / edi, its locale's LC_CTYPE handle 0: c - 0x20 for 'A'..'Z' (signed compares with 0x41 and
 * 0x5a, the flags of the last), c otherwise —, the two arguments popped into ecx (c left), ret. 43 instructions below 'A',
 * 45 for 'A'..'Z', 46 above.
 */
function emitTolower(c, fallback, L, ret, ent, k) {
  const { S, N, LEN, B1, U } = L;
  if (ret !== null) c.get(P.ESP).i32(4).sub().set(S);
  guardStack(c, fallback, 32, 8, S, ret !== null);
  if (ret !== null) c.get(S).i32(ret).i32store(0);
  emitGetptd(c, fallback, k, ent, LEN, U);
  emitLocaleC(c, fallback, k, ent, LEN);
  c.get(S).i32load(4).set(B1);
  const st = (d, emit) => { c.get(S).i32(d).sub(); emit(); c.i32store(0); };
  st(4, () => c.get(B1)); st(8, () => c.get(LEN)); st(12, () => adr(c, ent, k.ret)); st(16, () => c.get(P.EBP));
  st(20, () => c.get(P.ECX)); st(24, () => c.get(P.EBX)); st(28, () => c.get(P.ESI)); st(32, () => c.get(P.EDI));
  c.get(B1).set(P.ECX);
  c.i32((LZ.SUB << 2) | 2).set(P.LZOP); c.get(B1).set(P.LZA);
  c.get(B1).i32(0x41).lt_s();
  const below = c.if_();
  c.i32(43).set(N); c.get(B1).set(P.EAX); c.i32(0x41).set(P.LZB);
  c.else_();
  c.i32(0x5a).set(P.LZB);
  c.get(B1).i32(0x5a).le_s();
  const upper = c.if_(); c.i32(45).set(N); c.get(B1).i32(0x20).add().set(P.EAX); c.else_(); c.i32(46).set(N); c.get(B1).set(P.EAX); c.end(); void upper;
  c.end(); void below;
  c.get(B1).get(P.LZB).sub().set(P.LZRES);
}

/**
 * strtok(str, control): push ebp, sub esp, 0x28, the security cookie at [ebp-4], push ebx / esi / edi, _getptd (its data
 * at [ebp-0x28]), a 32-byte bitmap at [ebp-0x24] zeroed (rep stosd) and a bit set for each byte of `control` and its
 * terminator; then from `str` — or, null, the data's _token (+0x18) — the delimiters skipped, the token up to the next
 * delimiter (a 0 written over it, the next search after it) or the terminator (the next search there); _token = the next
 * search, eax = the token or 0 (none left), ecx = the cookie, pops, __security_check_cookie (cmp ecx, cookie: its flags),
 * leave, ret. Instructions: 33; 12 per byte of `control` and its terminator; 3 (6 with str null); 14 per delimiter
 * skipped; then 18 at the terminator (no token), or 15 and 13 per byte of the token, 1 at a terminator after it or 12 at
 * a delimiter; 17 at the end.
 * As the code, the frame (the pushes, the cookie, the data, the bitmap) is written before the strings are read; all that
 * would take the exact way is checked before it but a string reaching the frame or USER_END before its terminator and
 * translated code, a watch or a page never mapped under the 0 written — those leave the exact way after it, whose code
 * writes the frame again with the same values before reading the strings. A string may not start in the frame.
 */
function emitStrtok(c, fallback, L, ret, ent, k) {
  const { S, N, LEN, B1, B2, I, U, J, Q } = L;
  if (ret !== null) c.get(P.ESP).i32(4).sub().set(S);
  guardStack(c, fallback, 0x4c, 12, S, ret !== null);
  if (ret !== null) c.get(S).i32(ret).i32store(0);
  emitGetptd(c, fallback, k, ent, LEN, U);
  // _token's store: no translated code, watch or page never mapped there, not across pages, not over the cookie
  const plain = (a) => { // (a byte or dword stored at the address in local `a`)
    c.get(a).i32(12).shr_u().i32load8u(SMC_MAP_BASE).i32(SMC_CODE | SMC_WATCH | SMC_NULL).and().br_if(fallback);
    c.get(a); adr(c, ent, k.cookie); c.sub().i32(3).add().i32(7).lt_u().br_if(fallback);
  };
  c.get(LEN).i32(0x18).add().tee(U).i32(0xfff).and().i32(0xffc).gt_u().br_if(fallback);
  plain(U);
  // B2 = the string (N: 36, 39 from _token), B1 = the control; how far each may be read (as _stricmp's): J, Q
  c.get(S).i32load(4).tee(B2);
  const given = c.if_(); c.i32(36).set(N); c.else_(); c.get(LEN).i32load(0x18).set(B2); c.i32(39).set(N); c.end(); void given;
  c.get(S).i32load(8).set(B1);
  for (const p of [B2, B1]) {
    c.get(p).i32(0x10000).sub().i32(USER_END - 0x10000).ge_u().br_if(fallback);
    c.get(S).i32(0x4c).sub().i32(USER_END).get(p).get(S).lt_u().select().get(p).sub().tee(J).i32(0).le_s().br_if(fallback);
    if (p === B2) c.get(J).extend_u().set(Q);
  }
  // the frame as the code has written it when it reads the strings (_getptd's pushes: ebx, esi = control, the last
  // error, SetLastError's return address; push 7 over push 8 over its own return address)
  const st = (d, emit) => { c.get(S).i32(d).sub(); emit(); c.i32store(0); };
  st(4, () => c.get(P.EBP)); st(8, () => { adr(c, ent, k.cookie); c.i32load(0); }); st(0x2c, () => c.get(LEN));
  st(0x30, () => c.get(P.EBX)); st(0x34, () => c.get(P.ESI)); st(0x38, () => c.get(P.EDI)); st(0x3c, () => c.i32(7));
  st(0x40, () => c.get(P.EBX)); st(0x44, () => c.get(B1)); st(0x48, () => c.get(P.STATE).i32load(ST.FS_BASE).i32load(0x34));
  st(0x4c, () => adr(c, ent, k.gret));
  c.get(S).i32(0x28).sub().set(U);
  for (const o of [0, 8, 16, 24]) c.get(U).i64(0n).i64store(o, 0);
  // a bit for each byte of the control and its terminator
  const cell = () => { c.get(S).i32(0x28).sub().get(U).i32(3).shr_u().add(); };
  c.i32(0).set(I);
  const bits = c.loop();
  c.get(I).get(J).ge_u().br_if(fallback);
  c.get(B1).get(I).add().i32load8u(0).set(U);
  cell(); cell(); c.i32load8u(0).i32(1).get(U).i32(7).and().shl().or().i32store8(0);
  c.get(N).i32(12).add().set(N); c.get(I).i32(1).add().set(I);
  c.get(U).br_if(bits);
  c.end(); void bits;
  // the string: B1 = where the token starts, I = where the next search will (its index)
  c.get(Q).wrap().set(J);
  const at = () => { c.get(I).get(J).ge_u().br_if(fallback); c.get(B2).get(I).add().i32load8u(0).set(U); };
  const bit = () => { cell(); c.i32load8u(0).get(U).i32(7).and().shr_u().i32(1).and(); };
  c.i32(0).set(I);
  const done = c.block(), tok = c.block();
  const lead = c.loop();
  at();
  bit(); c.eqz(); const first = c.if_(); c.get(N).i32(15).add().set(N); c.br(tok); c.end(); void first;
  c.get(U).eqz(); const none = c.if_(); c.get(I).set(B1); c.get(N).i32(18).add().set(N); c.br(done); c.end(); void none;
  c.get(N).i32(14).add().set(N); c.get(I).i32(1).add().set(I); c.br(lead);
  c.end(); void lead;
  c.end(); // tok
  c.get(I).set(B1);
  const scan = c.loop();
  c.get(N).i32(13).add().set(N); c.get(I).i32(1).add().set(I); at();
  c.get(U).eqz(); const end = c.if_(); c.get(N).i32(1).add().set(N); c.br(done); c.end(); void end;
  bit(); const delim = c.if_();
  c.get(N).i32(12).add().set(N);
  c.get(B2).get(I).add().set(U); plain(U); c.get(U).i32(0).i32store8(0);
  c.get(I).i32(1).add().set(I); c.br(done);
  c.end(); void delim;
  c.br(scan);
  c.end(); void scan;
  c.end(); void done;
  c.get(N).i32(17).add().set(N);
  c.get(B2).get(I).add().set(P.EDX);
  c.get(B2).get(B1).add().i32(0).get(B1).get(I).ne().select().set(P.EAX); // (and eax, ebx after neg / sbb: 0 for no token)
  c.get(LEN).get(P.EDX).i32store(0x18, 0);
  st(0x30, () => adr(c, ent, k.ret));
  c.get(S).i32(8).sub().i32load(0).tee(P.ECX).set(P.LZA); c.get(P.ECX).set(P.LZB); c.i32(0).set(P.LZRES); c.i32((LZ.SUB << 2) | 2).set(P.LZOP);
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

/**
 * memcpy(dst, src, n) — the C runtime's, a memmove —, its forward path with a 4-aligned destination: push ebp / edi /
 * esi, the overlap test (dst > src and dst < src + n: the backward copy, left to the exact way), n / 4 words by rep movsd
 * (8 and more) or an unrolled table of moves, then n % 4 bytes from a jump table; eax = dst, ecx = 0 after rep movsd or
 * the word count, edx = n % 4, the flags of cmp ecx, 8 or of the unrolled path's add edi. A forward copy reads each
 * byte before anything overwrites it: memory.copy's result. A destination page holding translated code (or watched,
 * or never mapped) takes the exact way, which detects the write.
 */
function emitMemcpy(c, fallback) {
  guardStack(c, fallback, 12, 16);
  c.get(P.EFL).i32(0x400).and().br_if(fallback); // (DF set: rep movsd backwards)
  c.get(L_S).i32load(4).tee(L_B1).i32(3).and().br_if(fallback); // (an unaligned destination: its byte head)
  c.get(L_S).i32load(8).set(L_B2); c.get(L_S).i32load(12).set(L_LEN);
  // the backward copy: dst > src and dst < src + n (mod 2^32, as the code compares)
  c.get(L_B1).get(L_B2).gt_u().get(L_B1).get(L_B2).get(L_LEN).add().lt_u().and().br_if(fallback);
  c.get(L_LEN).i32(0x7f000000).gt_u().br_if(fallback);
  for (const b of [L_B1, L_B2]) {
    c.get(b).i32(0x10000).lt_u().br_if(fallback);
    c.get(b).i32(0x7fff0000).get(L_LEN).sub().gt_u().br_if(fallback);
  }
  // the destination's pages (SMC detection, write watches, pages never mapped)
  c.get(L_LEN);
  const some = c.if_();
  c.get(L_B1).i32(12).shr_u().set(L_I);
  const pages = c.loop();
  c.get(L_I).i32load8u(SMC_MAP_BASE).i32(SMC_CODE | SMC_WATCH | SMC_NULL).and().br_if(fallback);
  c.get(L_I).i32(1).add().tee(L_I).get(L_B1).get(L_LEN).add().i32(1).sub().i32(12).shr_u().le_u().br_if(pages);
  c.end(); void pages;
  c.end(); void some;
  // 18 instructions to the alignment test's jne (dst <= src: jbe taken), 20 otherwise; then shr, and, cmp, jb
  c.i32(18).i32(20).get(L_B1).get(L_B2).le_u().select().set(L_N);
  at(c, 4); c.get(P.EBP).i32store(0); at(c, 8); c.get(P.EDI).i32store(0); at(c, 12); c.get(P.ESI).i32store(0);
  c.get(L_B1).get(L_B2).get(L_LEN).memcopy();
  c.get(L_LEN).i32(2).shr_u().set(L_J);
  c.get(L_B1).set(P.EAX); c.get(L_LEN).i32(3).and().set(P.EDX);
  c.get(L_J).i32(8).ge_u().get(L_J).eqz().or();
  const rep = c.if_(); // rep movsd ; jmp (or the table's entry 0: the jmp) — cmp ecx, 8's flags
  c.i32(0).set(P.ECX); c.get(L_N).i32(2).add().set(L_N);
  c.get(L_J).i32(8).sub().set(P.LZRES); c.get(L_J).set(P.LZA); c.i32(8).set(P.LZB); c.i32((LZ.SUB << 2) | 2).set(P.LZOP);
  c.else_(); // jmp [table] ; n / 4 moves ; lea ; add esi ; add edi ; jmp — add edi's flags
  c.get(L_J).set(P.ECX); c.get(L_N).get(L_J).i32(1).shl().add().i32(5).add().set(L_N);
  c.get(L_B1).get(L_J).i32(2).shl().tee(P.LZB).add().set(P.LZRES); c.get(L_B1).set(P.LZA); c.i32((LZ.ADD << 2) | 2).set(P.LZOP);
  c.end(); void rep;
  c.get(L_N).i32(5).add().get(P.EDX).i32(1).shl().add().set(L_N); // (the tail: n % 4 byte moves, mov eax / pops / leave / ret)
}
