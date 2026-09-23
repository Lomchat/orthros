// JIT runtime module: the WASM-side dispatcher loop (EIP -> translated block via a hash table
// in guest memory), the lazy-flag materialization helper and small numeric helpers. Built once
// per Jit instance with the same emitter used for translated regions.
import { ModuleBuilder, Code, T } from './wasm.js';
import { ST, EXIT, F } from '../state.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE, JIT_HASH_BASE, JIT_HASH_BITS, JIT_SCRATCH_BASE } from '../memory.js';
import { addExpKernels } from './fpmath-exp.js';
import { addTrigKernels } from './fpmath-trig.js';
import { addAtanKernels } from './fpmath-atan.js';
import { addNanKernels } from './fpmath-nan.js';
import { addRoundKernels } from './fpmath-round.js';

/**
 * Transcendental kernels of the runtime module, in the order the region modules import them
 * (translate.js IMP_* constants follow this list after flags/round24/fallback): name -> [params, results].
 */
export const MATH_KERNELS = Object.freeze([
  ['exp2m1', [T.f64], [T.f64]], // 2^x - 1 (F2XM1)
  ['log2', [T.f64], [T.f64]], // log2 x (FYL2X)
  ['log2p1', [T.f64], [T.f64]], // log2(1 + x) (FYL2XP1)
  ['scalb', [T.f64, T.f64], [T.f64]], // a 2^trunc(b) with the interpreter's FSCALE special cases
  ['sin', [T.f64], [T.f64]], // FSIN / FSINCOS
  ['cos', [T.f64], [T.f64]], // FCOS / FSINCOS
  ['tan', [T.f64], [T.f64]], // FPTAN
  ['atan2', [T.f64, T.f64], [T.f64]], // atan2(y, x) (FPATAN: y = ST(1), x = ST(0))
  ['sincos', [T.f64], [T.f64, T.f64]], // (sin x, cos x) from one range reduction (FSINCOS)
  ['nan2', [T.f64, T.f64], [T.f64, T.i32]], // x87 NaN-operand rule: (result, raise IE) (fpmath-nan.js)
  ['arith24', [T.f64, T.f64, T.i32, T.i32], [T.f64]], // exact PC=24 rounding of an operation (fpmath-round.js)
  ['f32rc', [T.f64, T.i32], [T.f32]], // FST m32 under a directed rounding mode (fpmath-round.js)
]);

export const EXIT_TRANSLATE = 7;
export const HASH_ENTRY = 16; // eip u32, fnIdx u32, block u32, pad
export const HASH_PROBES = 4;
// Region function signature: (block, state, eax, ecx, edx, ebx, esp, ebp, esi, edi, eflags,
// lzop, lzres, lza, lzb, fs) -> nextEip|0. The parameters double as the region's locals 0..15
// (see translate.js), so a region can hand its live register file to the next one with a tail
// call (region chaining) without going through the state block.
export const REGION_PARAMS = Object.freeze(Array(16).fill(T.i32));
export const REGION_RESULTS = Object.freeze([T.i32]);
/** State-block offsets of the 14 register/flag arguments that follow (block, state). */
export const REGION_ARG_OFFSETS = Object.freeze([...Array.from({ length: 8 }, (_, i) => ST.GPR + 4 * i), ST.EFLAGS, ST.LZ_OP, ST.LZ_RES, ST.LZ_SRC1, ST.LZ_SRC2, ST.FS_BASE]);

/** Does this engine accept `return_call_indirect` (WASM tail calls)? Region chaining needs it. */
export function supportsReturnCall() {
  try {
    const m = new ModuleBuilder();
    m.importTable('env', 'table', 1, undefined);
    const t = m.type([T.i32], [T.i32]);
    const c = new Code();
    c.get(0).i32(0).return_call_indirect(t, 0);
    m.func([T.i32], [T.i32], [], c, 'f');
    return WebAssembly.validate(m.build());
  } catch { return false; }
}
// Fast-path API table: one byte per thunk index (id of a WASM implementation, 0 = none), and a
// small block of per-process constants used by those implementations.
export const FAST_TABLE = JIT_SCRATCH_BASE;
export const PROC_CONSTS = JIT_SCRATCH_BASE + 0x10000; // +0 process heap handle
export const FAST = Object.freeze({ GetLastError: 1, SetLastError: 2, TlsGetValue: 3, TlsSetValue: 4, EnterCriticalSection: 5, LeaveCriticalSection: 6, TryEnterCriticalSection: 7, InterlockedIncrement: 8, InterlockedDecrement: 9, InterlockedExchange: 10, InterlockedExchangeAdd: 11, InterlockedCompareExchange: 12, GetCurrentThreadId: 13, GetCurrentProcessId: 14, GetProcessHeap: 15 });
export const FAST_NAMES = { 'kernel32.dll!GetLastError': 1, 'kernel32.dll!SetLastError': 2, 'kernel32.dll!TlsGetValue': 3, 'kernel32.dll!FlsGetValue': 3, 'kernel32.dll!TlsSetValue': 4, 'kernel32.dll!FlsSetValue': 4, 'kernel32.dll!EnterCriticalSection': 5, 'kernel32.dll!LeaveCriticalSection': 6, 'kernel32.dll!TryEnterCriticalSection': 7, 'kernel32.dll!InterlockedIncrement': 8, 'kernel32.dll!InterlockedDecrement': 9, 'kernel32.dll!InterlockedExchange': 10, 'kernel32.dll!InterlockedExchangeAdd': 11, 'kernel32.dll!InterlockedCompareExchange': 12, 'kernel32.dll!GetCurrentThreadId': 13, 'kernel32.dll!GetCurrentProcessId': 14, 'kernel32.dll!GetProcessHeap': 15 };

// Lazy flag op kinds (kind << 2 | sizeLog2)
export const LZ = Object.freeze({ NONE: 0, ADD: 1, SUB: 2, LOGIC: 3, INC: 4, DEC: 5, NEG: 6, SHL: 7, SHR: 8, SAR: 9, MUL: 10, IMUL: 11, SHLD: 12, BSF: 13 });

/** JS mirror of the WASM flags helper (used when leaving WASM with lazy state pending). */
export function materializeFlags(op, res, a, b, ef) {
  const kind = op >> 2, sz = op & 3;
  const bits = 8 << sz, mask = bits === 32 ? 0xffffffff : (1 << bits) - 1, sign = (1 << (bits - 1)) >>> 0;
  res = (res & mask) >>> 0; a = (a & mask) >>> 0; b = (b & mask) >>> 0;
  let cf = 0, of = 0, af = 0;
  switch (kind) {
    case LZ.ADD: cf = res < a ? 1 : 0; of = ((a ^ res) & (b ^ res) & sign) ? 1 : 0; af = (a ^ b ^ res) & 0x10 ? 1 : 0; break;
    case LZ.SUB: cf = a < b ? 1 : 0; of = ((a ^ b) & (a ^ res) & sign) ? 1 : 0; af = (a ^ b ^ res) & 0x10 ? 1 : 0; break;
    case LZ.LOGIC: break;
    case LZ.INC: cf = b & 1; of = res === sign ? 1 : 0; af = (res & 0xf) === 0 ? 1 : 0; break;
    case LZ.DEC: cf = b & 1; of = res === (sign - 1) >>> 0 ? 1 : 0; af = (res & 0xf) === 0xf ? 1 : 0; break;
    case LZ.NEG: cf = a !== 0 ? 1 : 0; of = a === sign ? 1 : 0; af = (a & 0xf) !== 0 ? 1 : 0; break;
    case LZ.SHL: cf = b <= bits ? (b === bits ? a & 1 : (a >>> (bits - b)) & 1) : 0; of = (((res & sign) ? 1 : 0) ^ cf); break;
    case LZ.SHR: cf = (a >>> (b - 1)) & 1; of = (a & sign) ? 1 : 0; break;
    case LZ.SAR: cf = (a >>> (b - 1)) & 1; of = 0; break;
    case LZ.MUL: cf = of = a !== 0 ? 1 : 0; break;
    case LZ.IMUL: cf = of = b & 1; break;
    case LZ.SHLD: cf = a & 1; of = b & 1; break;
    case LZ.BSF: break;
    default: return ef >>> 0;
  }
  let f = ef & ~(F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF);
  if (cf) f |= F.CF; if (of) f |= F.OF; if (af) f |= F.AF;
  if (res === 0) f |= F.ZF; if (res & sign) f |= F.SF;
  let p = res & 0xff; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1; if (!(p & 1)) f |= F.PF;
  if (kind === LZ.BSF) { f = (f & ~F.ZF) | (a ? F.ZF : 0); }
  return f >>> 0;
}

/**
 * Build the runtime module bytes. Imports: env.memory, env.table.
 * Exports: run(eip, state) -> exit code (halts at ST.STOP_AT); flags(op,res,a,b,ef) -> ef;
 * round24(x, rc) -> x'; the transcendental kernels of MATH_KERNELS (pure WASM, fpmath-*.js).
 */
export function buildRuntime() {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 32768, 32768);
  m.importTable('env', 'table', 1024, undefined);
  const regionType = m.type(REGION_PARAMS, REGION_RESULTS);

  // ---- transcendental kernels (x87 F2XM1/FYL2X/FYL2XP1/FSCALE/FSIN/FCOS/FSINCOS/FPTAN/FPATAN):
  // defined here once, imported by every region module like round24 (WASM -> WASM, D004)
  {
    const k = { ...addExpKernels(m), ...addTrigKernels(m), ...addAtanKernels(m), ...addNanKernels(m), ...addRoundKernels(m) };
    for (const [name] of MATH_KERNELS) m.exportFunc(name, k[name]);
  }

  // ---- flags(op, res, a, b, ef) -> ef
  {
    const c = new Code();
    // params: 0 op, 1 res, 2 a, 3 b, 4 ef ; locals: 5 kind, 6 bits, 7 sign, 8 f, 9 tmp, 10 mask
    const [OP, RES, A, B, EF, KIND, BITS, SIGN, FL, TMP, MASK] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    c.get(OP).i32(2).shr_u().set(KIND);
    c.i32(8).get(OP).i32(3).and().shl().set(BITS); // bits = 8 << sz
    c.i32(1).get(BITS).i32(1).sub().shl().set(SIGN);
    // mask = bits==32 ? -1 : (1<<bits)-1
    c.get(SIGN).i32(1).shl().i32(1).sub().set(MASK); // (sign<<1)-1 works for 32 too (wraps to -1)
    c.get(RES).get(MASK).and().set(RES); c.get(A).get(MASK).and().set(A); c.get(B).get(MASK).and().set(B);
    // f = ef & ~0x8d5
    c.get(EF).i32(~0x8d5).and().set(FL);
    // ZF
    c.get(RES).eqz(); const ifz = c.if_(); c.get(FL).i32(F.ZF).or().set(FL); c.end(); void ifz;
    // SF
    c.get(RES).get(SIGN).and(); const ifs = c.if_(); c.get(FL).i32(F.SF).or().set(FL); c.end(); void ifs;
    // PF: popcnt(res & 0xff) even
    c.get(RES).i32(0xff).and().popcnt().i32(1).and().eqz(); const ifp = c.if_(); c.get(FL).i32(F.PF).or().set(FL); c.end(); void ifp;
    // kind switch: compute cf/of/af into TMP bits (bit0=cf, bit1=of, bit2=af)
    const kinds = 14;
    const done = c.block();
    const labels = [];
    for (let k = 0; k < kinds; k++) labels.push(c.block());
    c.get(KIND).br_table(labels, done);
    // reverse order: label[0] closes first -> code for kind 0
    const setCF = () => { c.get(FL).i32(F.CF).or().set(FL); };
    const setOF = () => { c.get(FL).i32(F.OF).or().set(FL); };
    const setAF = () => { c.get(FL).i32(F.AF).or().set(FL); };
    const afFromXor = () => { c.get(A).get(B).xor().get(RES).xor().i32(0x10).and(); const i = c.if_(); setAF(); c.end(); void i; };
    for (let i = 0; i < kinds; i++) {
      const k = kinds - 1 - i; // the i-th `end` closes the innermost remaining block = labels[kinds-1-i]
      c.end(); // enter code for kind k
      switch (k) {
        case LZ.NONE: break;
        case LZ.ADD: { c.get(RES).get(A).lt_u(); const i = c.if_(); setCF(); c.end(); void i; c.get(A).get(RES).xor().get(B).get(RES).xor().and().get(SIGN).and(); const j = c.if_(); setOF(); c.end(); void j; afFromXor(); break; }
        case LZ.SUB: { c.get(A).get(B).lt_u(); const i = c.if_(); setCF(); c.end(); void i; c.get(A).get(B).xor().get(A).get(RES).xor().and().get(SIGN).and(); const j = c.if_(); setOF(); c.end(); void j; afFromXor(); break; }
        case LZ.LOGIC: break;
        case LZ.INC: { c.get(B).i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; c.get(RES).get(SIGN).eq(); const j = c.if_(); setOF(); c.end(); void j; c.get(RES).i32(0xf).and().eqz(); const l = c.if_(); setAF(); c.end(); void l; break; }
        case LZ.DEC: { c.get(B).i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; c.get(RES).get(SIGN).i32(1).sub().eq(); const j = c.if_(); setOF(); c.end(); void j; c.get(RES).i32(0xf).and().i32(0xf).eq(); const l = c.if_(); setAF(); c.end(); void l; break; }
        case LZ.NEG: { c.get(A); const i = c.if_(); setCF(); c.end(); void i; c.get(A).get(SIGN).eq(); const j = c.if_(); setOF(); c.end(); void j; c.get(A).i32(0xf).and(); const l = c.if_(); setAF(); c.end(); void l; break; }
        case LZ.SHL: {
          // cf = b<=bits ? (b==bits ? a&1 : (a >> (bits-b)) & 1) : 0
          c.get(B).get(BITS).le_u(); const i = c.if_(T.i32);
          c.get(B).get(BITS).eq(); const i2 = c.if_(T.i32); c.get(A).i32(1).and(); c.else_(); c.get(A).get(BITS).get(B).sub().shr_u().i32(1).and(); c.end(); void i2;
          c.else_(); c.i32(0); c.end(); void i;
          c.set(TMP);
          c.get(TMP); const i3 = c.if_(); setCF(); c.end(); void i3;
          c.get(RES).get(SIGN).and().i32(0).ne().get(TMP).xor(); const i4 = c.if_(); setOF(); c.end(); void i4;
          break;
        }
        case LZ.SHR: { c.get(A).get(B).i32(1).sub().shr_u().i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; c.get(A).get(SIGN).and(); const j = c.if_(); setOF(); c.end(); void j; break; }
        case LZ.SAR: { c.get(A).get(B).i32(1).sub().shr_u().i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; break; }
        case LZ.MUL: { c.get(A); const i = c.if_(); setCF(); setOF(); c.end(); void i; break; }
        case LZ.IMUL: { c.get(B).i32(1).and(); const i = c.if_(); setCF(); setOF(); c.end(); void i; break; }
        case LZ.SHLD: { c.get(A).i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; c.get(B).i32(1).and(); const j = c.if_(); setOF(); c.end(); void j; break; }
        case LZ.BSF: { c.get(FL).i32(~F.ZF).and().set(FL); c.get(A); const i = c.if_(); c.get(FL).i32(F.ZF).or().set(FL); c.end(); void i; break; }
      }
      c.br(done);
    }
    c.end(); // done
    c.get(FL);
    const idx = m.func([T.i32, T.i32, T.i32, T.i32, T.i32], [T.i32], [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32], c, 'flags');
    m.exportFunc('flags', idx);
  }

  // ---- round24(x f64, rc i32) -> f64 : round mantissa to 24 bits keeping the f64 exponent range
  {
    const c = new Code();
    const [X, RC, BITS, LOW, SIGN] = [0, 1, 2, 3, 4];
    c.get(X).i64reinterpret_f64().set(BITS);
    // exponent all ones (inf/nan) -> return x
    c.get(BITS).i64(0x7ff0000000000000n).i64and().i64(0x7ff0000000000000n).i64eq(); const i0 = c.if_(); c.get(X).return_(); c.end(); void i0;
    c.get(BITS).i64(0x1fffffffn).i64and().set(LOW);
    c.get(LOW).i64eqz(); const i1 = c.if_(); c.get(X).return_(); c.end(); void i1;
    c.get(BITS).i64(63n).i64shr_u().wrap().set(SIGN);
    // rc: 0 nearest, 1 down, 2 up, 3 trunc
    const done = c.block();
    const l3 = c.block(), l2 = c.block(), l1 = c.block(), l0 = c.block();
    c.get(RC).br_table([l0, l1, l2, l3], done);
    c.end(); // nearest
    c.get(BITS).i64(0x0fffffffn).i64add().get(BITS).i64(29n).i64shr_u().i64(1n).i64and().i64add().set(BITS); c.br(done);
    c.end(); // down: negative -> away from zero
    c.get(SIGN); const d1 = c.if_(); c.get(BITS).i64(0x20000000n).i64add().set(BITS); c.end(); void d1; c.br(done);
    c.end(); // up: positive -> away from zero
    c.get(SIGN).eqz(); const d2 = c.if_(); c.get(BITS).i64(0x20000000n).i64add().set(BITS); c.end(); void d2; c.br(done);
    c.end(); // trunc: nothing
    c.end(); // done
    c.get(BITS).i64(-0x20000000n).i64and().f64reinterpret_i64();
    const idx = m.func([T.f64, T.i32], [T.f64], [T.i64, T.i64, T.i32], c, 'round24');
    m.exportFunc('round24', idx);
  }

  // ---- fastApi(fid, state) -> 1 if handled (registers/stack updated as a stdcall return), else 0
  let fastApiIdx;
  {
    const c = new Code();
    const [FID, STATE, SP, TEB, A0, A1, A2, TM] = [0, 1, 2, 3, 4, 5, 6, 7];
    c.get(STATE).i32load(ST.GPR + 16).set(SP);
    c.get(STATE).i32load(ST.FS_BASE).set(TEB);
    c.get(SP).i32load(4).set(A0); c.get(SP).i32load(8).set(A1); c.get(SP).i32load(12).set(A2);
    // stdcall return helper: eax = value on stack, pop return address + argc*4
    const ret = (argc) => { c.i32store(ST.GPR); c.get(STATE).get(SP).i32load(0).i32store(ST.EIP); c.get(STATE).get(SP).i32(4 + 4 * argc).add().i32store(ST.GPR + 16); c.i32(1).return_(); };
    const notHandled = c.block();
    // a call re-executed after a parked wait carries a recorded result for its JavaScript handler
    c.get(STATE).i32load(ST.RESUMING).br_if(notHandled);
    const N = 16;
    const labels = new Array(N);
    for (let i = N - 1; i >= 0; i--) labels[i] = c.block();
    c.get(FID).br_table(labels, notHandled);
    for (let k = 0; k < N; k++) {
      c.end();
      switch (k) {
        case 0: c.br(notHandled); break;
        case 1: c.get(STATE).get(TEB).i32load(0x34); ret(0); break; // GetLastError
        case 2: c.get(TEB).get(A0).i32store(0x34); c.get(STATE).i32(0); ret(1); break; // SetLastError
        case 3: // TlsGetValue(i) i<64: last error = 0
          c.get(A0).i32(64).ge_u().br_if(notHandled);
          c.get(TEB).i32(0).i32store(0x34);
          c.get(STATE).get(TEB).get(A0).i32(2).shl().add().i32load(0xe10); ret(1); break;
        case 4: c.get(A0).i32(64).ge_u().br_if(notHandled); c.get(TEB).get(A0).i32(2).shl().add().get(A1).i32store(0xe10); c.get(STATE).i32(1); ret(2); break; // TlsSetValue
        case 5: { // EnterCriticalSection: owner == tid -> recursion; free -> take; else JS
          const own = c.block();
          c.get(A0).i32load(12).get(TEB).i32load(0x24).eq().br_if(own);
          c.get(A0).i32load(4).i32(-1).ne().br_if(notHandled);
          c.get(A0).i32(0).i32store(4); c.get(A0).i32(1).i32store(8); c.get(A0).get(TEB).i32load(0x24).i32store(12); c.get(STATE).i32(0); ret(1);
          c.end(); void own;
          c.get(A0).get(A0).i32load(8).i32(1).add().i32store(8); c.get(A0).get(A0).i32load(4).i32(1).add().i32store(4); c.get(STATE).i32(0); ret(1); break;
        }
        case 6: { // LeaveCriticalSection
          c.get(A0).get(A0).i32load(8).i32(1).sub().tee(TM).i32store(8);
          c.get(A0).get(A0).i32load(4).i32(1).sub().i32store(4);
          c.get(TM).i32(0).le_s(); const i = c.if_(); c.get(A0).i32(0).i32store(12); c.get(A0).i32(-1).i32store(4); c.get(A0).i32(0).i32store(8); c.end(); void i;
          c.get(STATE).i32(0); ret(1); break;
        }
        case 7: { // TryEnterCriticalSection
          const own = c.block(); const fail = c.block();
          c.get(A0).i32load(12).get(TEB).i32load(0x24).eq().br_if(own);
          c.get(A0).i32load(4).i32(-1).ne().br_if(fail);
          c.get(A0).i32(0).i32store(4); c.get(A0).i32(1).i32store(8); c.get(A0).get(TEB).i32load(0x24).i32store(12); c.get(STATE).i32(1); ret(1);
          c.end(); void fail; c.get(STATE).i32(0); ret(1);
          c.end(); void own;
          c.get(A0).get(A0).i32load(8).i32(1).add().i32store(8); c.get(A0).get(A0).i32load(4).i32(1).add().i32store(4); c.get(STATE).i32(1); ret(1); break;
        }
        case 8: c.get(A0).get(A0).i32load(0).i32(1).add().tee(TM).i32store(0); c.get(STATE).get(TM); ret(1); break;
        case 9: c.get(A0).get(A0).i32load(0).i32(1).sub().tee(TM).i32store(0); c.get(STATE).get(TM); ret(1); break;
        case 10: c.get(A0).i32load(0).set(TM); c.get(A0).get(A1).i32store(0); c.get(STATE).get(TM); ret(2); break;
        case 11: c.get(A0).i32load(0).set(TM); c.get(A0).get(TM).get(A1).add().i32store(0); c.get(STATE).get(TM); ret(2); break;
        case 12: { c.get(A0).i32load(0).set(TM); c.get(TM).get(A2).eq(); const i = c.if_(); c.get(A0).get(A1).i32store(0); c.end(); void i; c.get(STATE).get(TM); ret(3); break; }
        case 13: c.get(STATE).get(TEB).i32load(0x24); ret(0); break;
        case 14: c.get(STATE).get(TEB).i32load(0x20); ret(0); break;
        case 15: c.get(STATE).i32(PROC_CONSTS).i32load(0); ret(0); break;
      }
    }
    c.end(); // notHandled
    c.i32(0);
    fastApiIdx = m.func([T.i32, T.i32], [T.i32], [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32], c, 'fastApi');
    m.exportFunc('fastApi', fastApiIdx);
  }

  // ---- run(eip, state) -> exit code
  {
    const c = new Code();
    const [EIP, STATE, STOP, E, IDX, PROBE] = [0, 1, 2, 3, 4, 5];
    c.get(STATE).i32load(ST.STOP_AT).set(STOP);
    const L = c.loop();
    // stopAt
    c.get(EIP).get(STOP).eq(); const i0 = c.if_(); c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT.HALT).i32store(ST.EXIT); c.i32(EXIT.HALT).return_(); c.end(); void i0;
    // thunk region: fast path or exit
    c.get(EIP).i32(THUNK_BASE).sub().i32(THUNK_END - THUNK_BASE).lt_u(); const i1 = c.if_();
    c.get(EIP).i32(THUNK_BASE).sub().i32(THUNK_SIZE).div_u().set(IDX);
    c.get(IDX).i32load8u(FAST_TABLE).tee(E);
    const fast = c.if_();
    c.get(E).get(STATE).call(fastApiIdx);
    const handled = c.if_(); c.get(STATE).i32load(ST.EIP).set(EIP); c.br(L); c.end(); void handled;
    c.end(); void fast;
    c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT.THUNK).i32store(ST.EXIT);
    c.get(STATE).get(IDX).i32store(ST.EXIT_ARG); c.i32(EXIT.THUNK).return_(); c.end(); void i1;
    // budget
    c.get(STATE).i32load(ST.ICOUNT).i32(0).le_s(); const i2 = c.if_(); c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT.TIMESLICE).i32store(ST.EXIT); c.i32(EXIT.TIMESLICE).return_(); c.end(); void i2;
    // hash lookup with linear probing
    c.get(EIP).i32(0x9e3779b1 | 0).mul().i32(32 - JIT_HASH_BITS).shr_u().set(IDX);
    c.i32(0).set(PROBE);
    const found = c.block();
    const probeLoop = c.loop();
    c.get(IDX).get(PROBE).add().i32((1 << JIT_HASH_BITS) - 1).and().i32(HASH_ENTRY).mul().i32(JIT_HASH_BASE).add().set(E);
    c.get(E).i32load(0).get(EIP).eq().br_if(found);
    c.get(PROBE).i32(1).add().tee(PROBE).i32(HASH_PROBES).lt_u().br_if(probeLoop);
    c.end(); // probeLoop
    // miss
    c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT_TRANSLATE).i32store(ST.EXIT); c.i32(EXIT_TRANSLATE).return_();
    c.end(); // found
    // call region: (block, state, registers/flags from the state block) via table[fnIdx]
    c.get(E).i32load(8).get(STATE);
    for (const off of REGION_ARG_OFFSETS) c.get(STATE).i32load(off);
    c.get(E).i32load(4).call_indirect(regionType, 0).tee(EIP);
    c.eqz(); const i3 = c.if_(); c.get(STATE).i32load(ST.EXIT).return_(); c.end(); void i3;
    c.br(L);
    c.end(); // loop
    c.i32(0);
    const idx = m.func([T.i32, T.i32], [T.i32], [T.i32, T.i32, T.i32, T.i32], c, 'run');
    m.exportFunc('run', idx);
  }
  return m.build();
}
