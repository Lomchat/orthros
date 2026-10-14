// The x87 condition-code probe (tools/x87cc-probe.mjs, tests/x87-cc-hw.test.js): one instruction run from known
// condition codes C3 C2 C1 C0 on a known stack, the status word read back by FNSTSW AX. Each case is a byte sequence
// valid both in 32-bit mode (Orthros) and in 64-bit mode (the native runner, tools/oracle/x87cc.c): memory operands are
// [eax + disp] only, eax holding the data block's address (< 2^32 on both sides), set by a `mov eax, imm32` in front.
//   fninit ; fld m64 2.0 ; fld m64 0.75 ; fld m64 -1.5 ; <stack variant> ;
//   fnstenv [eax+64] ; or word [eax+68], <cc> ; fldenv [eax+64]   (the condition codes set, nothing else changed)
//   <instruction> ; fnstsw ax ; fninit
// The runner stops at the final fninit; AX is the result.

/** the data block (256 bytes) at eax */
export function dataBlock() {
  const b = new Uint8Array(256), dv = new DataView(b.buffer);
  dv.setFloat64(0, -1.5, true); dv.setFloat64(8, 2.0, true); dv.setFloat64(16, 0.75, true); dv.setFloat64(24, NaN, true);
  dv.setInt32(32, 3, true); dv.setFloat32(40, 0.5, true); dv.setUint16(56, 0x037f, true);
  dv.setFloat64(200, -0, true); dv.setFloat64(208, Infinity, true); dv.setFloat64(216, 2 ** 64, true); dv.setFloat64(224, NaN, true);
  dv.setFloat64(232, 0, true);
  return b;
}

export const INS = {
  fcomi: [0xdb, 0xf1], fucomi: [0xdb, 0xe9], fcomip: [0xdf, 0xf1], fucomip: [0xdf, 0xe9],
  fcomi_nan: [0xdd, 0x40, 0x18, 0xdb, 0xf1], fucomi_nan: [0xdd, 0x40, 0x18, 0xdb, 0xe9], // (a QNaN pushed first)
  fcom: [0xd8, 0xd1], fcomp: [0xd8, 0xd9], fcompp: [0xde, 0xd9], fucom: [0xdd, 0xe1], fucomp: [0xdd, 0xe9], fucompp: [0xda, 0xe9],
  fcom_m64: [0xdc, 0x50, 0x10], fcom_m32: [0xd8, 0x50, 0x28], ficom_m32: [0xda, 0x50, 0x20], ficomp_m32: [0xda, 0x58, 0x20], ficom_m16: [0xde, 0x50, 0x20],
  ftst: [0xd9, 0xe4], fxam: [0xd9, 0xe5],
  fld_st: [0xd9, 0xc1], fld_m64: [0xdd, 0x40, 0x10], fild_m32: [0xdb, 0x40, 0x20], fld1: [0xd9, 0xe8], fldz: [0xd9, 0xee], fldpi: [0xd9, 0xeb],
  fst_m64: [0xdd, 0x50, 0x30], fstp_m64: [0xdd, 0x58, 0x30], fst_st: [0xdd, 0xd3], fist_m32: [0xdb, 0x50, 0x30], fistp_m32: [0xdb, 0x58, 0x30], fisttp_m32: [0xdb, 0x48, 0x30],
  fadd: [0xd8, 0xc1], fadd_m64: [0xdc, 0x40, 0x10], faddp: [0xde, 0xc1], fmul: [0xd8, 0xc9], fsub: [0xd8, 0xe1], fdiv: [0xd8, 0xf1], fdivr: [0xd8, 0xf9], fdiv_m64: [0xdc, 0x70, 0x10],
  fchs: [0xd9, 0xe0], fabs: [0xd9, 0xe1], fsqrt: [0xd9, 0xfa], frndint: [0xd9, 0xfc], fscale: [0xd9, 0xfd], fxtract: [0xd9, 0xf4], fprem: [0xd9, 0xf8], fprem1: [0xd9, 0xf5],
  f2xm1: [0xd9, 0xf0], fyl2x: [0xd9, 0xf1], fyl2xp1: [0xd9, 0xf9], fsin: [0xd9, 0xfe], fcos: [0xd9, 0xff], fsincos: [0xd9, 0xfb], fptan: [0xd9, 0xf2], fpatan: [0xd9, 0xf3],
  fxch: [0xd9, 0xc9], ffree2: [0xdd, 0xc2], ffree5: [0xdd, 0xc5], fincstp: [0xd9, 0xf7], fdecstp: [0xd9, 0xf6], fnop: [0xd9, 0xd0],
  fldcw: [0xd9, 0x68, 0x38], fnstcw: [0xd9, 0x78, 0x30], fnclex: [0xdb, 0xe2], fnstsw_m: [0xdd, 0x78, 0x30],
  fcmovb: [0xda, 0xc1], fcmovnb: [0xdb, 0xc1], fcmove: [0xda, 0xc9], fcmovu: [0xda, 0xd9], fcmovnu: [0xdb, 0xd9],
};
/** after the three loads (ST(0) = -1.5, ST(1) = 0.75, ST(2) = 2.0): another ST(0) or the order changed */
export const STACKS = {
  neg: [],
  pos: [0xd9, 0xca], // fxch st(2): 2.0 on top, -1.5 in ST(2)
  negzero: [0xdd, 0x80, 200, 0, 0, 0], // fld m64 [eax+200]: -0 pushed
  inf: [0xdd, 0x80, 208, 0, 0, 0], // +inf
  big: [0xdd, 0x80, 216, 0, 0, 0], // 2^64 (trig out of range, FPREM partial)
  nan: [0xdd, 0x80, 224, 0, 0, 0], // a QNaN
  zero1: [0xdd, 0x80, 232, 0, 0, 0, 0xd9, 0xc9], // +0 pushed then exchanged: ST(1) = 0 (FPREM invalid)
};
export const CCS = [0x0000, 0x0200, 0x4500, 0x4700, 0x0100, 0x4000, 0x0400];

/** @param {string[] | null} only instruction names (null: all) @param {number[]} ccs */
export function cases(only = null, ccs = CCS) {
  const out = [];
  for (const [sname, st] of Object.entries(STACKS)) for (const cc of ccs) for (const [iname, ins] of Object.entries(INS)) {
    if (only && !only.includes(iname)) continue;
    const code = [0xdb, 0xe3, 0xdd, 0x40, 0x08, 0xdd, 0x40, 0x10, 0xdd, 0x40, 0x00, ...st,
      0xd9, 0x70, 0x40, 0x66, 0x81, 0x48, 0x44, cc & 0xff, cc >> 8, 0xd9, 0x60, 0x40,
      ...ins, 0xdf, 0xe0, 0xdb, 0xe3];
    out.push({ name: `${iname} ${sname} ${cc.toString(16).padStart(4, '0')}`, iname, sname, cc, code: Uint8Array.from(code) });
  }
  return out;
}

/**
 * Run the cases in Orthros: the interpreter (jitOpts null) or the JIT with these options. One guest memory and one
 * JIT for all of them, each case at its own code address. Returns AX per case.
 * @param {{ name: string, code: Uint8Array }[]} list @param {object | null} jitOpts
 */
export async function runOrthros(list, jitOpts) {
  const { GuestMemory } = await import('../src/cpu/memory.js');
  const { CpuState, THREAD_STATES_BASE, EXIT, F } = await import('../src/cpu/state.js');
  const { Interp } = await import('../src/cpu/interp.js');
  await import('../src/cpu/interp-x87.js');
  const { Jit } = await import('../src/cpu/jit/jit.js');
  const CODE = 0x20000000, DATA = 0x10000000, STRIDE = 128;
  const mem = new GuestMemory(), cpu = new CpuState(mem, THREAD_STATES_BASE), I = new Interp(mem, cpu);
  cpu.reset();
  const ends = new Set();
  list.forEach((c, k) => {
    const at = CODE + k * STRIDE;
    if (c.code.length + 5 > STRIDE) throw new Error('case too long');
    mem.writeBytes(at, Uint8Array.from([0xb8, DATA & 0xff, (DATA >>> 8) & 0xff, (DATA >>> 16) & 0xff, DATA >>> 24, ...c.code]));
    ends.add(at + 5 + c.code.length - 2); // the final fninit
  });
  let jit = null;
  if (jitOpts) { jit = new Jit(mem, I, { smc: true, ...jitOpts }); jit.cpu = cpu; jit.boundaries = ends; }
  const data = dataBlock();
  return list.map((c, k) => {
    const at = CODE + k * STRIDE, end = at + 5 + c.code.length - 2;
    mem.writeBytes(DATA, data);
    cpu.eip = at; cpu.esp = DATA + 0x10000; cpu.eflags = F.RESERVED1 | F.IF;
    const r = jit ? jit.run({ stopAt: end, maxInsns: 1e5 }) : I.run({ stopAt: end, maxInsns: 1e5 });
    if (r !== EXIT.HALT) throw new Error(`${c.name}: exit ${r} at ${cpu.eip.toString(16)}`);
    return cpu.eax & 0xffff;
  });
}
