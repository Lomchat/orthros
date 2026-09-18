// JIT runtime module: the WASM-side dispatcher loop (EIP -> translated block via a hash table
// in guest memory), the lazy-flag materialization helper and small numeric helpers. Built once
// per Jit instance with the same emitter used for translated regions.
import { ModuleBuilder, Code, T } from './wasm.js';
import { ST, EXIT, F } from '../state.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE, JIT_HASH_BASE, JIT_HASH_BITS } from '../memory.js';

export const EXIT_TRANSLATE = 7;
export const HASH_ENTRY = 16; // eip u32, fnIdx u32, block u32, pad
export const HASH_PROBES = 4;

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
 * Exports: run(eip, state, stopAt) -> exit code; flags(op,res,a,b,ef) -> ef; round24(x, rc) -> x'
 */
export function buildRuntime() {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 32768, 32768);
  m.importTable('env', 'table', 1024, undefined);
  const regionType = m.type([T.i32, T.i32], [T.i32]);

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

  // ---- run(eip, state, stopAt) -> exit code
  {
    const c = new Code();
    const [EIP, STATE, STOP, E, IDX, PROBE] = [0, 1, 2, 3, 4, 5];
    const L = c.loop();
    // stopAt
    c.get(EIP).get(STOP).eq(); const i0 = c.if_(); c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT.HALT).i32store(ST.EXIT); c.i32(EXIT.HALT).return_(); c.end(); void i0;
    // thunk region
    c.get(EIP).i32(THUNK_BASE).sub().i32(THUNK_END - THUNK_BASE).lt_u(); const i1 = c.if_();
    c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT.THUNK).i32store(ST.EXIT);
    c.get(STATE).get(EIP).i32(THUNK_BASE).sub().i32(THUNK_SIZE).div_u().i32store(ST.EXIT_ARG); c.i32(EXIT.THUNK).return_(); c.end(); void i1;
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
    // call region: (block, state) via table[fnIdx]
    c.get(E).i32load(8).get(STATE).get(E).i32load(4).call_indirect(regionType, 0).tee(EIP);
    c.eqz(); const i3 = c.if_(); c.get(STATE).i32load(ST.EXIT).return_(); c.end(); void i3;
    c.br(L);
    c.end(); // loop
    c.i32(0);
    const idx = m.func([T.i32, T.i32, T.i32], [T.i32], [T.i32, T.i32, T.i32], c, 'run');
    m.exportFunc('run', idx);
  }
  return m.build();
}
