// x86-32 instruction decoder (user-mode subset: integer, x87, MMX, SSE, SSE2, a few SSE3).
//
// decode(mem, addr) -> Insn. The decoder is table-driven: opcode maps hold "MNEMONIC ops" specs
// in the Intel-manual operand notation (Eb, Gv, Ib, Vps, Wps, ...) which are parsed once at load
// into operand templates. Both the interpreter and the JIT consume the decoded form.

import { SEG } from './state.js';

// ---------------------------------------------------------------------------------------------
// Operand kinds
export const OT = Object.freeze({
  REG: 1, // GPR: size 1/2/4, r = register number (for size 1, r>=4 means AH..BH)
  MEM: 2, // memory: size bytes, base/index (-1 none), scale, disp (int32), seg (override or -1)
  IMM: 3, // immediate: v (number, sign/zero extended as decoded), size
  SEG: 4, // segment register r
  ST: 5, // x87 ST(r)
  MM: 6, // MMX register r
  XMM: 7, // XMM register r
  CR: 8,
  DR: 9,
  REL: 10, // branch target: v = absolute target address
  FAR: 11, // far pointer immediate: seg, v (offset)
});

// Mnemonic list -> OP enum. Order does not matter; generated at load.
const MNEMONICS = `
ADD OR ADC SBB AND SUB XOR CMP TEST NOT NEG MUL IMUL DIV IDIV INC DEC
ROL ROR RCL RCR SHL SHR SAR SHLD SHRD
MOV MOVZX MOVSX LEA XCHG XADD CMPXCHG CMPXCHG8B BSWAP CMOVCC SETCC
BT BTS BTR BTC BSF BSR
PUSH POP PUSHA POPA PUSHF POPF LAHF SAHF ENTER LEAVE
JMP JMPF JCC CALL CALLF RET RETF LOOP LOOPE LOOPNE JECXZ INT INT3 INTO IRET
CBW CWD MOVS CMPS STOS LODS SCAS INS OUTS XLAT
CLC STC CMC CLD STD CLI STI HLT NOP PAUSE WAIT UD2 SALC
DAA DAS AAA AAS AAM AAD BOUND ARPL
IN OUT CPUID RDTSC RDPMC RDMSR WRMSR SYSENTER SYSEXIT
LDS LES LFS LGS LSS
MOVCR MOVDR
FXSAVE FXRSTOR LDMXCSR STMXCSR LFENCE MFENCE SFENCE CLFLUSH PREFETCH
FADD FMUL FCOM FCOMP FSUB FSUBR FDIV FDIVR FLD FST FSTP FLDENV FLDCW FNSTENV FNSTCW
FXCH FNOP FCHS FABS FTST FXAM FLD1 FLDL2T FLDL2E FLDPI FLDLG2 FLDLN2 FLDZ
F2XM1 FYL2X FPTAN FPATAN FXTRACT FPREM1 FDECSTP FINCSTP FPREM FYL2XP1 FSQRT FSINCOS FRNDINT FSCALE FSIN FCOS
FIADD FIMUL FICOM FICOMP FISUB FISUBR FIDIV FIDIVR FCMOVCC FUCOMPP
FILD FISTTP FIST FISTP FNCLEX FNINIT FUCOMI FCOMI FUCOMIP FCOMIP
FRSTOR FNSAVE FNSTSW FFREE FUCOM FUCOMP FADDP FMULP FCOMPP FSUBRP FSUBP FDIVRP FDIVP FBLD FBSTP
EMMS MOVD MOVQ
PUNPCKLBW PUNPCKLWD PUNPCKLDQ PACKSSWB PCMPGTB PCMPGTW PCMPGTD PACKUSWB
PUNPCKHBW PUNPCKHWD PUNPCKHDQ PACKSSDW PUNPCKLQDQ PUNPCKHQDQ
PSHUFW PSHUFD PSHUFHW PSHUFLW PCMPEQB PCMPEQW PCMPEQD
PSRLW PSRLD PSRLQ PSRAW PSRAD PSLLW PSLLD PSLLQ PSRLDQ PSLLDQ
PADDQ PMULLW PMOVMSKB PSUBUSB PSUBUSW PMINUB PAND PADDUSB PADDUSW PMAXUB PANDN
PAVGB PAVGW PMULHUW PMULHW MOVNTQ MOVNTDQ PSUBSB PSUBSW PMINSW POR PADDSB PADDSW PMAXSW PXOR
PMULUDQ PMADDWD PSADBW MASKMOVQ MASKMOVDQU PSUBB PSUBW PSUBD PSUBQ PADDB PADDW PADDD
PINSRW PEXTRW PMOVMSK MOVQ2DQ MOVDQ2Q MOVDQA MOVDQU LDDQU
MOVUPS MOVUPD MOVSS MOVSD MOVLPS MOVLPD MOVHLPS MOVLHPS MOVHPS MOVHPD MOVSLDUP MOVSHDUP MOVDDUP
UNPCKLPS UNPCKLPD UNPCKHPS UNPCKHPD MOVAPS MOVAPD MOVNTPS MOVNTPD MOVNTI
CVTPI2PS CVTPI2PD CVTSI2SS CVTSI2SD CVTTPS2PI CVTTPD2PI CVTTSS2SI CVTTSD2SI CVTPS2PI CVTPD2PI CVTSS2SI CVTSD2SI
CVTPS2PD CVTPD2PS CVTSS2SD CVTSD2SS CVTDQ2PS CVTPS2DQ CVTTPS2DQ CVTTPD2DQ CVTDQ2PD CVTPD2DQ
UCOMISS UCOMISD COMISS COMISD MOVMSKPS MOVMSKPD
SQRTPS SQRTPD SQRTSS SQRTSD RSQRTPS RSQRTSS RCPPS RCPSS
ANDPS ANDPD ANDNPS ANDNPD ORPS ORPD XORPS XORPD
ADDPS ADDPD ADDSS ADDSD MULPS MULPD MULSS MULSD SUBPS SUBPD SUBSS SUBSD
MINPS MINPD MINSS MINSD DIVPS DIVPD DIVSS DIVSD MAXPS MAXPD MAXSS MAXSD
CMPPS CMPPD CMPSS CMPSD SHUFPS SHUFPD ADDSUBPS ADDSUBPD HADDPS HADDPD HSUBPS HSUBPD
INVALID
`.trim().split(/\s+/);

/** @type {Record<string, number>} */
export const OP = Object.freeze(Object.fromEntries(MNEMONICS.map((m, i) => [m, i])));
export const OP_NAMES = MNEMONICS;

// Condition codes (for JCC/SETCC/CMOVCC/FCMOVCC): standard 0..15 encoding.
export const CC_NAMES = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

// ---------------------------------------------------------------------------------------------
// Opcode tables. Each entry: "MNEM op1,op2,op3" or null (invalid), or a group marker.

const GRP1 = ['ADD', 'OR', 'ADC', 'SBB', 'AND', 'SUB', 'XOR', 'CMP'];
const GRP2 = ['ROL', 'ROR', 'RCL', 'RCR', 'SHL', 'SHR', 'SHL', 'SAR'];

// One-byte opcode map. Special tokens: '@grp1', '@grp2', ... handled in decode(); '@x87'; '@0F';
// prefixes are handled before table lookup.
const ONE = new Array(256).fill(null);
{
  const alu = GRP1;
  for (let i = 0; i < 8; i++) {
    const m = alu[i];
    const b = i * 8;
    ONE[b + 0] = `${m} Eb,Gb`;
    ONE[b + 1] = `${m} Ev,Gv`;
    ONE[b + 2] = `${m} Gb,Eb`;
    ONE[b + 3] = `${m} Gv,Ev`;
    ONE[b + 4] = `${m} AL,Ib`;
    ONE[b + 5] = `${m} eAX,Iz`;
  }
  ONE[0x06] = 'PUSH ES'; ONE[0x07] = 'POP ES';
  ONE[0x0e] = 'PUSH CS';
  ONE[0x16] = 'PUSH SS'; ONE[0x17] = 'POP SS';
  ONE[0x1e] = 'PUSH DS'; ONE[0x1f] = 'POP DS';
  ONE[0x27] = 'DAA'; ONE[0x2f] = 'DAS'; ONE[0x37] = 'AAA'; ONE[0x3f] = 'AAS';
  for (let i = 0; i < 8; i++) {
    ONE[0x40 + i] = `INC Zv`;
    ONE[0x48 + i] = `DEC Zv`;
    ONE[0x50 + i] = `PUSH Zv`;
    ONE[0x58 + i] = `POP Zv`;
    ONE[0x91 + i] = `XCHG Zv,eAX`;
    ONE[0xb0 + i] = `MOV Zb,Ib`;
    ONE[0xb8 + i] = `MOV Zv,Iv`;
  }
  ONE[0x60] = 'PUSHA'; ONE[0x61] = 'POPA'; ONE[0x62] = 'BOUND Gv,Ma'; ONE[0x63] = 'ARPL Ew,Gw';
  ONE[0x68] = 'PUSH Iz'; ONE[0x69] = 'IMUL Gv,Ev,Iz'; ONE[0x6a] = 'PUSH Ibs'; ONE[0x6b] = 'IMUL Gv,Ev,Ibs';
  ONE[0x6c] = 'INS Yb,DX'; ONE[0x6d] = 'INS Yv,DX'; ONE[0x6e] = 'OUTS DX,Xb'; ONE[0x6f] = 'OUTS DX,Xv';
  for (let i = 0; i < 16; i++) ONE[0x70 + i] = `JCC Jb`;
  ONE[0x80] = '@grp1 Eb,Ib'; ONE[0x81] = '@grp1 Ev,Iz'; ONE[0x82] = '@grp1 Eb,Ib'; ONE[0x83] = '@grp1 Ev,Ibs';
  ONE[0x84] = 'TEST Eb,Gb'; ONE[0x85] = 'TEST Ev,Gv'; ONE[0x86] = 'XCHG Eb,Gb'; ONE[0x87] = 'XCHG Ev,Gv';
  ONE[0x88] = 'MOV Eb,Gb'; ONE[0x89] = 'MOV Ev,Gv'; ONE[0x8a] = 'MOV Gb,Eb'; ONE[0x8b] = 'MOV Gv,Ev';
  ONE[0x8c] = 'MOV Ev,Sw'; ONE[0x8d] = 'LEA Gv,M'; ONE[0x8e] = 'MOV Sw,Ew'; ONE[0x8f] = '@grp1a Ev';
  ONE[0x90] = 'NOP';
  ONE[0x98] = 'CBW'; ONE[0x99] = 'CWD'; ONE[0x9a] = 'CALLF Ap'; ONE[0x9b] = 'WAIT';
  ONE[0x9c] = 'PUSHF'; ONE[0x9d] = 'POPF'; ONE[0x9e] = 'SAHF'; ONE[0x9f] = 'LAHF';
  ONE[0xa0] = 'MOV AL,Ob'; ONE[0xa1] = 'MOV eAX,Ov'; ONE[0xa2] = 'MOV Ob,AL'; ONE[0xa3] = 'MOV Ov,eAX';
  ONE[0xa4] = 'MOVS Yb,Xb'; ONE[0xa5] = 'MOVS Yv,Xv'; ONE[0xa6] = 'CMPS Xb,Yb'; ONE[0xa7] = 'CMPS Xv,Yv';
  ONE[0xa8] = 'TEST AL,Ib'; ONE[0xa9] = 'TEST eAX,Iz';
  ONE[0xaa] = 'STOS Yb,AL'; ONE[0xab] = 'STOS Yv,eAX'; ONE[0xac] = 'LODS AL,Xb'; ONE[0xad] = 'LODS eAX,Xv';
  ONE[0xae] = 'SCAS AL,Yb'; ONE[0xaf] = 'SCAS eAX,Yv';
  ONE[0xc0] = '@grp2 Eb,Ib'; ONE[0xc1] = '@grp2 Ev,Ib'; ONE[0xc2] = 'RET Iw'; ONE[0xc3] = 'RET';
  ONE[0xc4] = 'LES Gv,Mp'; ONE[0xc5] = 'LDS Gv,Mp'; ONE[0xc6] = '@movimm Eb,Ib'; ONE[0xc7] = '@movimm Ev,Iz';
  ONE[0xc8] = 'ENTER Iw,Ib'; ONE[0xc9] = 'LEAVE'; ONE[0xca] = 'RETF Iw'; ONE[0xcb] = 'RETF';
  ONE[0xcc] = 'INT3'; ONE[0xcd] = 'INT Ib'; ONE[0xce] = 'INTO'; ONE[0xcf] = 'IRET';
  ONE[0xd0] = '@grp2 Eb,1'; ONE[0xd1] = '@grp2 Ev,1'; ONE[0xd2] = '@grp2 Eb,CL'; ONE[0xd3] = '@grp2 Ev,CL';
  ONE[0xd4] = 'AAM Ib'; ONE[0xd5] = 'AAD Ib'; ONE[0xd6] = 'SALC'; ONE[0xd7] = 'XLAT';
  for (let i = 0; i < 8; i++) ONE[0xd8 + i] = '@x87';
  ONE[0xe0] = 'LOOPNE Jb'; ONE[0xe1] = 'LOOPE Jb'; ONE[0xe2] = 'LOOP Jb'; ONE[0xe3] = 'JECXZ Jb';
  ONE[0xe4] = 'IN AL,Ib'; ONE[0xe5] = 'IN eAX,Ib'; ONE[0xe6] = 'OUT Ib,AL'; ONE[0xe7] = 'OUT Ib,eAX';
  ONE[0xe8] = 'CALL Jz'; ONE[0xe9] = 'JMP Jz'; ONE[0xea] = 'JMPF Ap'; ONE[0xeb] = 'JMP Jb';
  ONE[0xec] = 'IN AL,DX'; ONE[0xed] = 'IN eAX,DX'; ONE[0xee] = 'OUT DX,AL'; ONE[0xef] = 'OUT DX,eAX';
  ONE[0xf1] = 'INT1'; ONE[0xf4] = 'HLT'; ONE[0xf5] = 'CMC';
  ONE[0xf6] = '@grp3 Eb'; ONE[0xf7] = '@grp3 Ev';
  ONE[0xf8] = 'CLC'; ONE[0xf9] = 'STC'; ONE[0xfa] = 'CLI'; ONE[0xfb] = 'STI'; ONE[0xfc] = 'CLD'; ONE[0xfd] = 'STD';
  ONE[0xfe] = '@grp4 Eb'; ONE[0xff] = '@grp5 Ev';
}

// Two-byte (0F xx) map. For SSE opcodes an object {n:'..', 66:'..', F3:'..', F2:'..'} selects
// by mandatory prefix; 'mmx' entries "P,Q" are promoted to XMM when 66 is present.
const TWO = new Array(256).fill(null);
{
  const sse = (n, p66, pF3, pF2) => ({ n, 66: p66, F3: pF3, F2: pF2 });
  const mmx = (spec) => ({ mmx: spec });
  TWO[0x00] = '@grp6'; TWO[0x01] = '@grp7'; TWO[0x02] = 'INVALID'; TWO[0x03] = 'INVALID';
  TWO[0x05] = 'INVALID'; TWO[0x06] = 'INVALID'; TWO[0x08] = 'INVALID'; TWO[0x09] = 'INVALID';
  TWO[0x0b] = 'UD2'; TWO[0x0d] = 'NOP Ev';
  TWO[0x10] = sse('MOVUPS Vps,Wps', 'MOVUPD Vpd,Wpd', 'MOVSS Vss,Wss', 'MOVSD Vsd,Wsd');
  TWO[0x11] = sse('MOVUPS Wps,Vps', 'MOVUPD Wpd,Vpd', 'MOVSS Wss,Vss', 'MOVSD Wsd,Vsd');
  TWO[0x12] = sse('@movlps', 'MOVLPD Vq,Mq', 'MOVSLDUP Vps,Wps', 'MOVDDUP Vpd,Wq');
  TWO[0x13] = sse('MOVLPS Mq,Vq', 'MOVLPD Mq,Vq', null, null);
  TWO[0x14] = sse('UNPCKLPS Vps,Wps', 'UNPCKLPD Vpd,Wpd', null, null);
  TWO[0x15] = sse('UNPCKHPS Vps,Wps', 'UNPCKHPD Vpd,Wpd', null, null);
  TWO[0x16] = sse('@movhps', 'MOVHPD Vq,Mq', 'MOVSHDUP Vps,Wps', null);
  TWO[0x17] = sse('MOVHPS Mq,Vq', 'MOVHPD Mq,Vq', null, null);
  TWO[0x18] = '@grp16';
  for (let i = 0x19; i <= 0x1f; i++) TWO[i] = 'NOP Ev';
  TWO[0x20] = 'MOVCR Rd,Cd'; TWO[0x21] = 'MOVDR Rd,Dd'; TWO[0x22] = 'MOVCR Cd,Rd'; TWO[0x23] = 'MOVDR Dd,Rd';
  TWO[0x28] = sse('MOVAPS Vps,Wps', 'MOVAPD Vpd,Wpd', null, null);
  TWO[0x29] = sse('MOVAPS Wps,Vps', 'MOVAPD Wpd,Vpd', null, null);
  TWO[0x2a] = sse('CVTPI2PS Vps,Qq', 'CVTPI2PD Vpd,Qq', 'CVTSI2SS Vss,Ed', 'CVTSI2SD Vsd,Ed');
  TWO[0x2b] = sse('MOVNTPS Mdq,Vps', 'MOVNTPD Mdq,Vpd', null, null);
  TWO[0x2c] = sse('CVTTPS2PI Pq,Wq', 'CVTTPD2PI Pq,Wpd', 'CVTTSS2SI Gd,Wss', 'CVTTSD2SI Gd,Wsd');
  TWO[0x2d] = sse('CVTPS2PI Pq,Wq', 'CVTPD2PI Pq,Wpd', 'CVTSS2SI Gd,Wss', 'CVTSD2SI Gd,Wsd');
  TWO[0x2e] = sse('UCOMISS Vss,Wss', 'UCOMISD Vsd,Wsd', null, null);
  TWO[0x2f] = sse('COMISS Vss,Wss', 'COMISD Vsd,Wsd', null, null);
  TWO[0x30] = 'WRMSR'; TWO[0x31] = 'RDTSC'; TWO[0x32] = 'RDMSR'; TWO[0x33] = 'RDPMC';
  TWO[0x34] = 'SYSENTER'; TWO[0x35] = 'SYSEXIT';
  for (let i = 0; i < 16; i++) TWO[0x40 + i] = 'CMOVCC Gv,Ev';
  TWO[0x50] = sse('MOVMSKPS Gd,Ups', 'MOVMSKPD Gd,Upd', null, null);
  TWO[0x51] = sse('SQRTPS Vps,Wps', 'SQRTPD Vpd,Wpd', 'SQRTSS Vss,Wss', 'SQRTSD Vsd,Wsd');
  TWO[0x52] = sse('RSQRTPS Vps,Wps', null, 'RSQRTSS Vss,Wss', null);
  TWO[0x53] = sse('RCPPS Vps,Wps', null, 'RCPSS Vss,Wss', null);
  TWO[0x54] = sse('ANDPS Vps,Wps', 'ANDPD Vpd,Wpd', null, null);
  TWO[0x55] = sse('ANDNPS Vps,Wps', 'ANDNPD Vpd,Wpd', null, null);
  TWO[0x56] = sse('ORPS Vps,Wps', 'ORPD Vpd,Wpd', null, null);
  TWO[0x57] = sse('XORPS Vps,Wps', 'XORPD Vpd,Wpd', null, null);
  TWO[0x58] = sse('ADDPS Vps,Wps', 'ADDPD Vpd,Wpd', 'ADDSS Vss,Wss', 'ADDSD Vsd,Wsd');
  TWO[0x59] = sse('MULPS Vps,Wps', 'MULPD Vpd,Wpd', 'MULSS Vss,Wss', 'MULSD Vsd,Wsd');
  TWO[0x5a] = sse('CVTPS2PD Vpd,Wq', 'CVTPD2PS Vps,Wpd', 'CVTSS2SD Vsd,Wss', 'CVTSD2SS Vss,Wsd');
  TWO[0x5b] = sse('CVTDQ2PS Vps,Wdq', 'CVTPS2DQ Vdq,Wps', 'CVTTPS2DQ Vdq,Wps', null);
  TWO[0x5c] = sse('SUBPS Vps,Wps', 'SUBPD Vpd,Wpd', 'SUBSS Vss,Wss', 'SUBSD Vsd,Wsd');
  TWO[0x5d] = sse('MINPS Vps,Wps', 'MINPD Vpd,Wpd', 'MINSS Vss,Wss', 'MINSD Vsd,Wsd');
  TWO[0x5e] = sse('DIVPS Vps,Wps', 'DIVPD Vpd,Wpd', 'DIVSS Vss,Wss', 'DIVSD Vsd,Wsd');
  TWO[0x5f] = sse('MAXPS Vps,Wps', 'MAXPD Vpd,Wpd', 'MAXSS Vss,Wss', 'MAXSD Vsd,Wsd');
  TWO[0x60] = mmx('PUNPCKLBW Pq,Qd'); TWO[0x61] = mmx('PUNPCKLWD Pq,Qd'); TWO[0x62] = mmx('PUNPCKLDQ Pq,Qd');
  TWO[0x63] = mmx('PACKSSWB Pq,Qq'); TWO[0x64] = mmx('PCMPGTB Pq,Qq'); TWO[0x65] = mmx('PCMPGTW Pq,Qq');
  TWO[0x66] = mmx('PCMPGTD Pq,Qq'); TWO[0x67] = mmx('PACKUSWB Pq,Qq');
  TWO[0x68] = mmx('PUNPCKHBW Pq,Qq'); TWO[0x69] = mmx('PUNPCKHWD Pq,Qq'); TWO[0x6a] = mmx('PUNPCKHDQ Pq,Qq');
  TWO[0x6b] = mmx('PACKSSDW Pq,Qq');
  TWO[0x6c] = sse(null, 'PUNPCKLQDQ Vdq,Wdq', null, null); TWO[0x6d] = sse(null, 'PUNPCKHQDQ Vdq,Wdq', null, null);
  TWO[0x6e] = sse('MOVD Pq,Ed', 'MOVD Vdq,Ed', null, null);
  TWO[0x6f] = sse('MOVQ Pq,Qq', 'MOVDQA Vdq,Wdq', 'MOVDQU Vdq,Wdq', null);
  TWO[0x70] = sse('PSHUFW Pq,Qq,Ib', 'PSHUFD Vdq,Wdq,Ib', 'PSHUFHW Vdq,Wdq,Ib', 'PSHUFLW Vdq,Wdq,Ib');
  TWO[0x71] = '@grp12'; TWO[0x72] = '@grp13'; TWO[0x73] = '@grp14';
  TWO[0x74] = mmx('PCMPEQB Pq,Qq'); TWO[0x75] = mmx('PCMPEQW Pq,Qq'); TWO[0x76] = mmx('PCMPEQD Pq,Qq');
  TWO[0x77] = 'EMMS';
  TWO[0x7c] = sse(null, 'HADDPD Vpd,Wpd', null, 'HADDPS Vps,Wps');
  TWO[0x7d] = sse(null, 'HSUBPD Vpd,Wpd', null, 'HSUBPS Vps,Wps');
  TWO[0x7e] = sse('MOVD Ed,Pq', 'MOVD Ed,Vdq', 'MOVQ Vq,Wq', null);
  TWO[0x7f] = sse('MOVQ Qq,Pq', 'MOVDQA Wdq,Vdq', 'MOVDQU Wdq,Vdq', null);
  for (let i = 0; i < 16; i++) TWO[0x80 + i] = 'JCC Jz';
  for (let i = 0; i < 16; i++) TWO[0x90 + i] = 'SETCC Eb';
  TWO[0xa0] = 'PUSH FS'; TWO[0xa1] = 'POP FS'; TWO[0xa2] = 'CPUID'; TWO[0xa3] = 'BT Ev,Gv';
  TWO[0xa4] = 'SHLD Ev,Gv,Ib'; TWO[0xa5] = 'SHLD Ev,Gv,CL';
  TWO[0xa8] = 'PUSH GS'; TWO[0xa9] = 'POP GS'; TWO[0xab] = 'BTS Ev,Gv';
  TWO[0xac] = 'SHRD Ev,Gv,Ib'; TWO[0xad] = 'SHRD Ev,Gv,CL'; TWO[0xae] = '@grp15'; TWO[0xaf] = 'IMUL Gv,Ev';
  TWO[0xb0] = 'CMPXCHG Eb,Gb'; TWO[0xb1] = 'CMPXCHG Ev,Gv'; TWO[0xb2] = 'LSS Gv,Mp'; TWO[0xb3] = 'BTR Ev,Gv';
  TWO[0xb4] = 'LFS Gv,Mp'; TWO[0xb5] = 'LGS Gv,Mp'; TWO[0xb6] = 'MOVZX Gv,Eb'; TWO[0xb7] = 'MOVZX Gv,Ew';
  TWO[0xb9] = 'INVALID'; TWO[0xba] = '@grp8'; TWO[0xbb] = 'BTC Ev,Gv'; TWO[0xbc] = 'BSF Gv,Ev'; TWO[0xbd] = 'BSR Gv,Ev';
  TWO[0xbe] = 'MOVSX Gv,Eb'; TWO[0xbf] = 'MOVSX Gv,Ew';
  TWO[0xc0] = 'XADD Eb,Gb'; TWO[0xc1] = 'XADD Ev,Gv';
  TWO[0xc2] = sse('CMPPS Vps,Wps,Ib', 'CMPPD Vpd,Wpd,Ib', 'CMPSS Vss,Wss,Ib', 'CMPSD Vsd,Wsd,Ib');
  TWO[0xc3] = 'MOVNTI Md,Gd';
  TWO[0xc4] = sse('PINSRW Pq,Ew,Ib', 'PINSRW Vdq,Ew,Ib', null, null);
  TWO[0xc5] = sse('PEXTRW Gd,Nq,Ib', 'PEXTRW Gd,Udq,Ib', null, null);
  TWO[0xc6] = sse('SHUFPS Vps,Wps,Ib', 'SHUFPD Vpd,Wpd,Ib', null, null);
  TWO[0xc7] = '@grp9';
  for (let i = 0; i < 8; i++) TWO[0xc8 + i] = 'BSWAP Zd';
  TWO[0xd0] = sse(null, 'ADDSUBPD Vpd,Wpd', null, 'ADDSUBPS Vps,Wps');
  TWO[0xd1] = mmx('PSRLW Pq,Qq'); TWO[0xd2] = mmx('PSRLD Pq,Qq'); TWO[0xd3] = mmx('PSRLQ Pq,Qq');
  TWO[0xd4] = mmx('PADDQ Pq,Qq'); TWO[0xd5] = mmx('PMULLW Pq,Qq');
  TWO[0xd6] = sse(null, 'MOVQ Wq,Vq', 'MOVQ2DQ Vdq,Nq', 'MOVDQ2Q Pq,Uq');
  TWO[0xd7] = sse('PMOVMSKB Gd,Nq', 'PMOVMSKB Gd,Udq', null, null);
  TWO[0xd8] = mmx('PSUBUSB Pq,Qq'); TWO[0xd9] = mmx('PSUBUSW Pq,Qq'); TWO[0xda] = mmx('PMINUB Pq,Qq');
  TWO[0xdb] = mmx('PAND Pq,Qq'); TWO[0xdc] = mmx('PADDUSB Pq,Qq'); TWO[0xdd] = mmx('PADDUSW Pq,Qq');
  TWO[0xde] = mmx('PMAXUB Pq,Qq'); TWO[0xdf] = mmx('PANDN Pq,Qq');
  TWO[0xe0] = mmx('PAVGB Pq,Qq'); TWO[0xe1] = mmx('PSRAW Pq,Qq'); TWO[0xe2] = mmx('PSRAD Pq,Qq');
  TWO[0xe3] = mmx('PAVGW Pq,Qq'); TWO[0xe4] = mmx('PMULHUW Pq,Qq'); TWO[0xe5] = mmx('PMULHW Pq,Qq');
  TWO[0xe6] = sse(null, 'CVTTPD2DQ Vdq,Wpd', 'CVTDQ2PD Vpd,Wq', 'CVTPD2DQ Vdq,Wpd');
  TWO[0xe7] = sse('MOVNTQ Mq,Pq', 'MOVNTDQ Mdq,Vdq', null, null);
  TWO[0xe8] = mmx('PSUBSB Pq,Qq'); TWO[0xe9] = mmx('PSUBSW Pq,Qq'); TWO[0xea] = mmx('PMINSW Pq,Qq');
  TWO[0xeb] = mmx('POR Pq,Qq'); TWO[0xec] = mmx('PADDSB Pq,Qq'); TWO[0xed] = mmx('PADDSW Pq,Qq');
  TWO[0xee] = mmx('PMAXSW Pq,Qq'); TWO[0xef] = mmx('PXOR Pq,Qq');
  TWO[0xf0] = sse(null, null, null, 'LDDQU Vdq,Mdq');
  TWO[0xf1] = mmx('PSLLW Pq,Qq'); TWO[0xf2] = mmx('PSLLD Pq,Qq'); TWO[0xf3] = mmx('PSLLQ Pq,Qq');
  TWO[0xf4] = mmx('PMULUDQ Pq,Qq'); TWO[0xf5] = mmx('PMADDWD Pq,Qq'); TWO[0xf6] = mmx('PSADBW Pq,Qq');
  TWO[0xf7] = sse('MASKMOVQ Pq,Nq', 'MASKMOVDQU Vdq,Udq', null, null);
  TWO[0xf8] = mmx('PSUBB Pq,Qq'); TWO[0xf9] = mmx('PSUBW Pq,Qq'); TWO[0xfa] = mmx('PSUBD Pq,Qq');
  TWO[0xfb] = mmx('PSUBQ Pq,Qq'); TWO[0xfc] = mmx('PADDB Pq,Qq'); TWO[0xfd] = mmx('PADDW Pq,Qq');
  TWO[0xfe] = mmx('PADDD Pq,Qq');
}

// x87: [opcode-0xD8][reg] for memory forms; register forms keyed by full modrm byte.
const X87_MEM = [
  ['FADD Md', 'FMUL Md', 'FCOM Md', 'FCOMP Md', 'FSUB Md', 'FSUBR Md', 'FDIV Md', 'FDIVR Md'], // D8 (m32fp)
  ['FLD Md', null, 'FST Md', 'FSTP Md', 'FLDENV M', 'FLDCW Mw', 'FNSTENV M', 'FNSTCW Mw'], // D9
  ['FIADD Md', 'FIMUL Md', 'FICOM Md', 'FICOMP Md', 'FISUB Md', 'FISUBR Md', 'FIDIV Md', 'FIDIVR Md'], // DA (m32int)
  ['FILD Md', 'FISTTP Md', 'FIST Md', 'FISTP Md', null, 'FLD Mt', null, 'FSTP Mt'], // DB
  ['FADD Mq', 'FMUL Mq', 'FCOM Mq', 'FCOMP Mq', 'FSUB Mq', 'FSUBR Mq', 'FDIV Mq', 'FDIVR Mq'], // DC (m64fp)
  ['FLD Mq', 'FISTTP Mq', 'FST Mq', 'FSTP Mq', 'FRSTOR M', null, 'FNSAVE M', 'FNSTSW Mw'], // DD
  ['FIADD Mw', 'FIMUL Mw', 'FICOM Mw', 'FICOMP Mw', 'FISUB Mw', 'FISUBR Mw', 'FIDIV Mw', 'FIDIVR Mw'], // DE (m16int)
  ['FILD Mw', 'FISTTP Mw', 'FIST Mw', 'FISTP Mw', 'FBLD Mt', 'FILD Mq', 'FBSTP Mt', 'FISTP Mq'], // DF
];
// Register forms: map from (opcode-0xD8)*64 + (modrm-0xC0) -> spec. Built below.
const X87_REG = new Array(8 * 64).fill(null);
{
  const set = (opc, base, spec, count = 8) => {
    for (let i = 0; i < count; i++) X87_REG[(opc - 0xd8) * 64 + (base - 0xc0) + i] = spec;
  };
  set(0xd8, 0xc0, 'FADD ST,STi'); set(0xd8, 0xc8, 'FMUL ST,STi'); set(0xd8, 0xd0, 'FCOM STi'); set(0xd8, 0xd8, 'FCOMP STi');
  set(0xd8, 0xe0, 'FSUB ST,STi'); set(0xd8, 0xe8, 'FSUBR ST,STi'); set(0xd8, 0xf0, 'FDIV ST,STi'); set(0xd8, 0xf8, 'FDIVR ST,STi');
  set(0xd9, 0xc0, 'FLD STi'); set(0xd9, 0xc8, 'FXCH STi'); set(0xd9, 0xd0, 'FNOP', 1);
  const d9 = { 0xe0: 'FCHS', 0xe1: 'FABS', 0xe4: 'FTST', 0xe5: 'FXAM', 0xe8: 'FLD1', 0xe9: 'FLDL2T', 0xea: 'FLDL2E',
    0xeb: 'FLDPI', 0xec: 'FLDLG2', 0xed: 'FLDLN2', 0xee: 'FLDZ', 0xf0: 'F2XM1', 0xf1: 'FYL2X', 0xf2: 'FPTAN',
    0xf3: 'FPATAN', 0xf4: 'FXTRACT', 0xf5: 'FPREM1', 0xf6: 'FDECSTP', 0xf7: 'FINCSTP', 0xf8: 'FPREM',
    0xf9: 'FYL2XP1', 0xfa: 'FSQRT', 0xfb: 'FSINCOS', 0xfc: 'FRNDINT', 0xfd: 'FSCALE', 0xfe: 'FSIN', 0xff: 'FCOS' };
  for (const k in d9) set(0xd9, +k, d9[k], 1);
  set(0xda, 0xc0, 'FCMOVCC STi'); set(0xda, 0xc8, 'FCMOVCC STi'); set(0xda, 0xd0, 'FCMOVCC STi'); set(0xda, 0xd8, 'FCMOVCC STi');
  set(0xda, 0xe9, 'FUCOMPP', 1);
  set(0xdb, 0xc0, 'FCMOVCC STi'); set(0xdb, 0xc8, 'FCMOVCC STi'); set(0xdb, 0xd0, 'FCMOVCC STi'); set(0xdb, 0xd8, 'FCMOVCC STi');
  set(0xdb, 0xe2, 'FNCLEX', 1); set(0xdb, 0xe3, 'FNINIT', 1); set(0xdb, 0xe8, 'FUCOMI ST,STi'); set(0xdb, 0xf0, 'FCOMI ST,STi');
  set(0xdc, 0xc0, 'FADD STi,ST'); set(0xdc, 0xc8, 'FMUL STi,ST'); set(0xdc, 0xe0, 'FSUBR STi,ST'); set(0xdc, 0xe8, 'FSUB STi,ST');
  set(0xdc, 0xf0, 'FDIVR STi,ST'); set(0xdc, 0xf8, 'FDIV STi,ST');
  set(0xdd, 0xc0, 'FFREE STi'); set(0xdd, 0xd0, 'FST STi'); set(0xdd, 0xd8, 'FSTP STi'); set(0xdd, 0xe0, 'FUCOM STi'); set(0xdd, 0xe8, 'FUCOMP STi');
  set(0xde, 0xc0, 'FADDP STi,ST'); set(0xde, 0xc8, 'FMULP STi,ST'); set(0xde, 0xd9, 'FCOMPP', 1);
  set(0xde, 0xe0, 'FSUBRP STi,ST'); set(0xde, 0xe8, 'FSUBP STi,ST'); set(0xde, 0xf0, 'FDIVRP STi,ST'); set(0xde, 0xf8, 'FDIVP STi,ST');
  set(0xdf, 0xe0, 'FNSTSW AX', 1); set(0xdf, 0xe8, 'FUCOMIP ST,STi'); set(0xdf, 0xf0, 'FCOMIP ST,STi');
}

// Groups keyed by ModRM.reg
const GROUPS = {
  grp1: GRP1,
  grp1a: ['POP', null, null, null, null, null, null, null],
  grp2: GRP2,
  grp3: ['TEST', 'TEST', 'NOT', 'NEG', 'MUL', 'IMUL', 'DIV', 'IDIV'],
  grp4: ['INC', 'DEC', null, null, null, null, null, null],
  grp5: ['INC', 'DEC', 'CALL', 'CALLF', 'JMP', 'JMPF', 'PUSH', null],
  grp6: [null, null, null, null, null, null, null, null],
  grp7: [null, null, null, null, null, null, null, null],
  grp8: [null, null, null, null, 'BT', 'BTS', 'BTR', 'BTC'],
  grp9: [null, 'CMPXCHG8B', null, null, null, null, null, null],
  grp12: [null, null, 'PSRLW', null, 'PSRAW', null, 'PSLLW', null],
  grp13: [null, null, 'PSRLD', null, 'PSRAD', null, 'PSLLD', null],
  grp14: [null, null, 'PSRLQ', 'PSRLDQ', null, null, 'PSLLQ', 'PSLLDQ'],
  grp15: ['FXSAVE', 'FXRSTOR', 'LDMXCSR', 'STMXCSR', null, 'LFENCE', 'MFENCE', 'SFENCE'],
  grp16: ['PREFETCH', 'PREFETCH', 'PREFETCH', 'PREFETCH', null, null, null, null],
  movimm: ['MOV', null, null, null, null, null, null, null],
};

// ---------------------------------------------------------------------------------------------
// Operand template parsing

const SIZE_CODES = { b: 1, w: 2, d: 4, q: 8, v: -1, z: -2, dq: 16, p: -3, t: 10, a: -4, ss: 4, sd: 8, ps: 16, pd: 16, bs: -5 };

/** @param {string} tok */
function parseOperand(tok) {
  // Fixed registers and constants
  switch (tok) {
    case 'AL': return { m: 'fixreg', size: 1, r: 0 };
    case 'CL': return { m: 'fixreg', size: 1, r: 1 };
    case 'DX': return { m: 'fixreg', size: 2, r: 2 };
    case 'AX': return { m: 'fixreg', size: 2, r: 0 };
    case 'eAX': return { m: 'fixreg', size: -1, r: 0 };
    case '1': return { m: 'const', v: 1 };
    case 'ST': return { m: 'st', r: 0 };
    case 'STi': return { m: 'sti' };
    case 'ES': case 'CS': case 'SS': case 'DS': case 'FS': case 'GS':
      return { m: 'fixseg', r: SEG[tok] };
  }
  const meth = tok[0];
  let sz = tok.slice(1);
  if (meth === 'Z' || meth === 'E' || meth === 'G' || meth === 'M' || meth === 'R' || meth === 'I' || meth === 'J' ||
      meth === 'O' || meth === 'A' || meth === 'S' || meth === 'C' || meth === 'D' || meth === 'P' || meth === 'Q' ||
      meth === 'N' || meth === 'V' || meth === 'W' || meth === 'U' || meth === 'X' || meth === 'Y') {
    if (sz === '' && meth === 'M') return { m: meth, size: 0 };
    if (!(sz in SIZE_CODES)) throw new Error(`bad operand size in ${tok}`);
    return { m: meth, size: SIZE_CODES[sz] };
  }
  throw new Error(`bad operand token ${tok}`);
}

const specCache = new Map();
/** @param {string} spec */
function parseSpec(spec) {
  let t = specCache.get(spec);
  if (t) return t;
  const sp = spec.indexOf(' ');
  const mnem = sp < 0 ? spec : spec.slice(0, sp);
  const ops = sp < 0 ? [] : spec.slice(sp + 1).split(',').map(parseOperand);
  if (!(mnem in OP)) throw new Error(`unknown mnemonic ${mnem}`);
  t = { op: OP[mnem], ops, needModrm: ops.some((o) => 'EGMRSCDPQNVWU'.includes(o.m) || o.m === 'sti') };
  specCache.set(spec, t);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Decoding

export class Insn {
  constructor() {
    this.addr = 0;
    this.len = 0;
    this.op = OP.INVALID;
    this.opsize = 4;
    this.adsize = 4;
    this.seg = -1;
    this.rep = 0;
    this.lock = false;
    this.cc = 0; // condition code for JCC/SETCC/CMOVCC/FCMOVCC
    this.opc = 0; // raw primary opcode byte (after 0F if two-byte), for ops needing it
    this.modrm = -1;
    /** @type {any[]} */
    this.ops = [];
    this.imm = 0;
    this.next = 0; // address of the following instruction
    this.ext = 0; // extra byte for misc uses (e.g. ENTER level)
  }
}

export class DecodeError extends Error {
  constructor(addr, msg) {
    super(`decode error at ${addr.toString(16)}: ${msg}`);
    this.addr = addr;
  }
}

/**
 * @param {import('./memory.js').GuestMemory} mem
 * @param {number} addr
 * @returns {Insn}
 */
export function decode(mem, addr) {
  const insn = new Insn();
  insn.addr = addr >>> 0;
  let p = addr >>> 0;
  let opsize16 = false;
  let adsize16 = false;
  let rep = 0;
  let seg = -1;
  let lock = false;
  let b;
  // Prefixes (max 14 bytes total; we stop at 15)
  for (;;) {
    b = mem.u8[p];
    if (b === 0x66) opsize16 = true;
    else if (b === 0x67) adsize16 = true;
    else if (b === 0xf2 || b === 0xf3) rep = b;
    else if (b === 0xf0) lock = true;
    else if (b === 0x26) seg = SEG.ES;
    else if (b === 0x2e) seg = SEG.CS;
    else if (b === 0x36) seg = SEG.SS;
    else if (b === 0x3e) seg = SEG.DS;
    else if (b === 0x64) seg = SEG.FS;
    else if (b === 0x65) seg = SEG.GS;
    else break;
    p++;
    if (p - insn.addr > 14) throw new DecodeError(insn.addr, 'too many prefixes');
  }
  insn.opsize = opsize16 ? 2 : 4;
  insn.adsize = adsize16 ? 2 : 4;
  insn.seg = seg;
  insn.lock = lock;

  let spec;
  let group = null;
  let twoByte = false;
  let opc = mem.u8[p++];
  if (opc === 0x0f) {
    twoByte = true;
    opc = mem.u8[p++];
    let e = TWO[opc];
    if (e === null) throw new DecodeError(insn.addr, `invalid opcode 0f ${opc.toString(16)}`);
    if (typeof e === 'object') {
      // SSE selection by mandatory prefix
      if (e.mmx) {
        if (opsize16) { spec = promoteMmx(e.mmx); opsize16 = false; insn.opsize = 4; }
        else spec = e.mmx;
      } else {
        let s = null;
        if (rep === 0xf3 && e.F3) { s = e.F3; rep = 0; }
        else if (rep === 0xf2 && e.F2) { s = e.F2; rep = 0; }
        else if (opsize16 && e[66]) { s = e[66]; opsize16 = false; insn.opsize = 4; }
        else s = e.n;
        if (!s) throw new DecodeError(insn.addr, `invalid sse form 0f ${opc.toString(16)}`);
        spec = s;
      }
    } else spec = e;
  } else {
    spec = ONE[opc];
    if (spec === null) throw new DecodeError(insn.addr, `invalid opcode ${opc.toString(16)}`);
  }
  insn.rep = rep;
  insn.opc = opc;

  // Special forms
  let forceModrm = false;
  if (spec === '@x87') {
    forceModrm = true; // every x87 opcode carries a ModRM byte, even operand-less forms
    const modrm = mem.u8[p];
    if (modrm < 0xc0) {
      spec = X87_MEM[opc - 0xd8][(modrm >> 3) & 7];
      if (!spec) throw new DecodeError(insn.addr, `invalid x87 ${opc.toString(16)} /${(modrm >> 3) & 7}`);
    } else {
      spec = X87_REG[(opc - 0xd8) * 64 + (modrm - 0xc0)];
      if (!spec) throw new DecodeError(insn.addr, `invalid x87 ${opc.toString(16)} ${modrm.toString(16)}`);
      if (spec.startsWith('FCMOVCC')) {
        // DA C0 FCMOVB, DA C8 FCMOVE, DA D0 FCMOVBE, DA D8 FCMOVU; DB: NB, NE, NBE, NU
        const k = (modrm >> 3) & 3;
        const cc = opc === 0xda ? [2, 4, 6, 10][k] : [3, 5, 7, 11][k];
        insn.cc = cc;
      }
    }
  } else if (spec[0] === '@') {
    const sp = spec.indexOf(' ');
    const gname = sp < 0 ? spec.slice(1) : spec.slice(1, sp);
    const rest = sp < 0 ? '' : spec.slice(sp + 1);
    const modrm = mem.u8[p];
    const reg = (modrm >> 3) & 7;
    if (gname === 'movlps') {
      spec = modrm < 0xc0 ? 'MOVLPS Vq,Mq' : 'MOVHLPS Vps,Ups';
    } else if (gname === 'movhps') {
      spec = modrm < 0xc0 ? 'MOVHPS Vq,Mq' : 'MOVLHPS Vps,Ups';
    } else {
      group = GROUPS[gname];
      let m = group[reg];
      if (!m) throw new DecodeError(insn.addr, `invalid group ${gname} /${reg}`);
      if (gname === 'grp3') {
        // TEST has an immediate, others do not
        spec = reg < 2 ? `TEST ${rest},${rest === 'Eb' ? 'Ib' : 'Iz'}` : `${m} ${rest}`;
      } else if (gname === 'grp5' && (reg === 3 || reg === 5)) {
        spec = `${m} Mp`;
      } else if (gname === 'grp8') {
        spec = `${m} Ev,Ib`;
      } else if (gname === 'grp12' || gname === 'grp13' || gname === 'grp14') {
        if (opsize16) { spec = `${m} Udq,Ib`; opsize16 = false; insn.opsize = 4; }
        else {
          if (m === 'PSRLDQ' || m === 'PSLLDQ') throw new DecodeError(insn.addr, 'PSxLDQ needs 66');
          spec = `${m} Nq,Ib`;
        }
      } else if (gname === 'grp15') {
        if (modrm >= 0xc0) spec = m; // fences
        else spec = `${m} M`;
      } else if (gname === 'grp16') {
        spec = 'PREFETCH M';
      } else if (gname === 'grp9') {
        spec = 'CMPXCHG8B Mq';
      } else {
        spec = rest ? `${m} ${rest}` : m;
      }
    }
  }

  const t = parseSpec(spec);
  insn.op = t.op;
  if (insn.op === OP.JCC || insn.op === OP.SETCC || insn.op === OP.CMOVCC) insn.cc = opc & 15;
  if (insn.op === OP.NOP && opc === 0x90 && rep === 0xf3) { insn.op = OP.PAUSE; insn.rep = 0; }

  // ModRM
  let modrm = -1, mod = 0, reg = 0, rm = 0;
  let memOp = null; // decoded memory operand template (without size), or null if rm is a register
  if (t.needModrm || forceModrm) {
    modrm = mem.u8[p++];
    insn.modrm = modrm;
    mod = modrm >> 6;
    reg = (modrm >> 3) & 7;
    rm = modrm & 7;
    if (mod !== 3) {
      memOp = { t: OT.MEM, size: 0, base: -1, index: -1, scale: 1, disp: 0, seg };
      if (!adsize16) {
        if (rm === 4) {
          const sib = mem.u8[p++];
          const ss = sib >> 6, idx = (sib >> 3) & 7, base = sib & 7;
          if (idx !== 4) { memOp.index = idx; memOp.scale = 1 << ss; }
          if (base === 5 && mod === 0) {
            memOp.disp = mem.dv.getInt32(p, true); p += 4;
          } else memOp.base = base;
        } else if (rm === 5 && mod === 0) {
          memOp.disp = mem.dv.getInt32(p, true); p += 4;
        } else memOp.base = rm;
        if (mod === 1) { memOp.disp = mem.i8[p]; p += 1; }
        else if (mod === 2) { memOp.disp = mem.dv.getInt32(p, true); p += 4; }
      } else {
        // 16-bit addressing forms
        const T16 = [[3, 6], [3, 7], [5, 6], [5, 7], [6, -1], [7, -1], [5, -1], [3, -1]];
        if (rm === 6 && mod === 0) { memOp.disp = mem.dv.getUint16(p, true); p += 2; }
        else { memOp.base = T16[rm][0]; memOp.index = T16[rm][1]; }
        if (mod === 1) { memOp.disp = mem.i8[p]; p += 1; }
        else if (mod === 2) { memOp.disp = mem.dv.getInt16(p, true); p += 2; }
        memOp.a16 = true;
      }
      // Default segment: SS when base is EBP/ESP, else DS. Only FS/GS bases are non-zero.
      if (memOp.seg < 0) memOp.seg = (memOp.base === 4 || memOp.base === 5) ? SEG.SS : SEG.DS;
    }
  }

  const osz = insn.opsize;
  const sizeOf = (s) => (s === -1 ? osz : s === -2 ? (osz === 2 ? 2 : 4) : s === -3 ? osz + 2 : s === -4 ? osz * 2 : s === -5 ? osz : s);
  const ops = insn.ops;
  for (const o of t.ops) {
    switch (o.m) {
      case 'fixreg': ops.push({ t: OT.REG, size: sizeOf(o.size), r: o.r }); break;
      case 'const': ops.push({ t: OT.IMM, size: 1, v: o.v }); break;
      case 'st': ops.push({ t: OT.ST, r: 0 }); break;
      case 'sti': ops.push({ t: OT.ST, r: modrm & 7 }); break;
      case 'fixseg': ops.push({ t: OT.SEG, r: o.r }); break;
      case 'Z': ops.push({ t: OT.REG, size: sizeOf(o.size), r: opc & 7 }); break;
      case 'E': case 'M': case 'R': {
        const size = sizeOf(o.size);
        if (memOp) {
          if (o.m === 'R') throw new DecodeError(insn.addr, 'register operand required');
          ops.push({ ...memOp, size });
        } else {
          if (o.m === 'M') throw new DecodeError(insn.addr, 'memory operand required');
          ops.push({ t: OT.REG, size, r: rm });
        }
        break;
      }
      case 'G': ops.push({ t: OT.REG, size: sizeOf(o.size), r: reg }); break;
      case 'S': ops.push({ t: OT.SEG, r: reg }); break;
      case 'C': ops.push({ t: OT.CR, r: reg }); break;
      case 'D': ops.push({ t: OT.DR, r: reg }); break;
      case 'P': ops.push({ t: OT.MM, r: reg }); break;
      case 'V': ops.push({ t: OT.XMM, r: reg }); break;
      case 'Q': case 'N': {
        if (memOp) { if (o.m === 'N') throw new DecodeError(insn.addr, 'mmx register required'); ops.push({ ...memOp, size: sizeOf(o.size) }); }
        else ops.push({ t: OT.MM, r: rm });
        break;
      }
      case 'W': case 'U': {
        if (memOp) { if (o.m === 'U') throw new DecodeError(insn.addr, 'xmm register required'); ops.push({ ...memOp, size: sizeOf(o.size) }); }
        else ops.push({ t: OT.XMM, r: rm });
        break;
      }
      case 'I': {
        const size = sizeOf(o.size);
        let v;
        if (o.size === -5) { v = mem.i8[p]; p += 1; } // Ibs: sign-extended byte
        else if (size === 1) { v = mem.u8[p]; p += 1; }
        else if (size === 2) { v = mem.dv.getUint16(p, true); p += 2; }
        else { v = mem.dv.getUint32(p, true); p += 4; }
        if (o.size === -5) v = size === 2 ? v & 0xffff : v >>> 0;
        ops.push({ t: OT.IMM, size, v });
        if (ops.length === 1 || insn.imm === 0) insn.imm = v;
        break;
      }
      case 'J': {
        const size = sizeOf(o.size);
        let rel;
        if (size === 1) { rel = mem.i8[p]; p += 1; }
        else if (size === 2) { rel = mem.dv.getInt16(p, true); p += 2; }
        else { rel = mem.dv.getInt32(p, true); p += 4; }
        // target computed after full length is known; store rel now
        ops.push({ t: OT.REL, v: 0, rel, size });
        break;
      }
      case 'O': {
        const size = sizeOf(o.size);
        let disp;
        if (adsize16) { disp = mem.dv.getUint16(p, true); p += 2; } else { disp = mem.dv.getInt32(p, true); p += 4; }
        ops.push({ t: OT.MEM, size, base: -1, index: -1, scale: 1, disp, seg: seg < 0 ? SEG.DS : seg });
        break;
      }
      case 'A': {
        const off = osz === 2 ? mem.dv.getUint16(p, true) : mem.dv.getUint32(p, true);
        p += osz;
        const sel = mem.dv.getUint16(p, true); p += 2;
        ops.push({ t: OT.FAR, seg: sel, v: off });
        break;
      }
      case 'X': ops.push({ t: OT.MEM, size: sizeOf(o.size), base: 6, index: -1, scale: 1, disp: 0, seg: seg < 0 ? SEG.DS : seg, str: true }); break;
      case 'Y': ops.push({ t: OT.MEM, size: sizeOf(o.size), base: 7, index: -1, scale: 1, disp: 0, seg: SEG.ES, str: true }); break;
      default: throw new DecodeError(insn.addr, `unhandled operand method ${o.m}`);
    }
  }
  insn.len = p - insn.addr;
  if (insn.len > 15) throw new DecodeError(insn.addr, 'instruction too long');
  insn.next = (insn.addr + insn.len) >>> 0;
  for (const o of ops) {
    if (o.t === OT.REL) {
      o.v = osz === 2 && o.size !== 1 ? (insn.next + o.rel) & 0xffff : (insn.next + o.rel) >>> 0;
      if (osz === 2) o.v = (insn.next + o.rel) & 0xffff; // 16-bit operand size truncates EIP
    }
  }
  // ENTER: ops Iw, Ib -> keep both
  if (insn.op === OP.ENTER) { insn.imm = ops[0].v; insn.ext = ops[1].v; }
  return insn;
}

/** Promote an MMX spec "MNEM Pq,Qq" to the XMM form for the 66 prefix. */
function promoteMmx(spec) {
  const sp = spec.indexOf(' ');
  const mnem = spec.slice(0, sp);
  const ops = spec.slice(sp + 1).split(',').map((o) => {
    if (o[0] === 'P') return 'Vdq';
    if (o[0] === 'Q') return 'Wdq';
    if (o[0] === 'N') return 'Udq';
    return o;
  });
  return `${mnem} ${ops.join(',')}`;
}

// ---------------------------------------------------------------------------------------------
// Formatting (Intel syntax, for traces)

const R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const SEGN = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];
const PTR = { 1: 'byte', 2: 'word', 4: 'dword', 6: 'fword', 8: 'qword', 10: 'tbyte', 16: 'xmmword' };

const hex = (v) => (v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16));

/** @param {any} o */
export function fmtOperand(o) {
  switch (o.t) {
    case OT.REG: return (o.size === 1 ? R8 : o.size === 2 ? R16 : R32)[o.r];
    case OT.MEM: {
      const R = o.a16 ? R16 : R32;
      let s = '';
      if (o.base >= 0) s += R[o.base];
      if (o.index >= 0) s += (s ? '+' : '') + R[o.index] + (o.scale > 1 ? '*' + o.scale : '');
      if (o.disp !== 0 || !s) s += s ? (o.disp < 0 ? '-0x' + (-o.disp).toString(16) : '+0x' + o.disp.toString(16)) : '0x' + (o.disp >>> 0).toString(16);
      const segp = o.seg === SEG.FS || o.seg === SEG.GS || (o.seg >= 0 && o.seg !== SEG.DS && o.seg !== SEG.SS && !o.str) ? SEGN[o.seg] + ':' : '';
      const ptr = o.size ? (PTR[o.size] || o.size * 8 + 'bit') + ' ptr ' : '';
      return `${ptr}${segp}[${s}]`;
    }
    case OT.IMM: return hex(o.v);
    case OT.SEG: return SEGN[o.r];
    case OT.ST: return o.r === 0 ? 'st' : `st(${o.r})`;
    case OT.MM: return `mm${o.r}`;
    case OT.XMM: return `xmm${o.r}`;
    case OT.CR: return `cr${o.r}`;
    case OT.DR: return `dr${o.r}`;
    case OT.REL: return hex(o.v);
    case OT.FAR: return `${hex(o.seg)}:${hex(o.v)}`;
  }
  return '?';
}

/** @param {Insn} insn */
export function fmtInsn(insn) {
  let m = OP_NAMES[insn.op].toLowerCase();
  if (insn.op === OP.JCC) m = 'j' + CC_NAMES[insn.cc];
  else if (insn.op === OP.SETCC) m = 'set' + CC_NAMES[insn.cc];
  else if (insn.op === OP.CMOVCC) m = 'cmov' + CC_NAMES[insn.cc];
  else if (insn.op === OP.FCMOVCC) m = 'fcmov' + CC_NAMES[insn.cc];
  else if (insn.op === OP.CBW) m = insn.opsize === 2 ? 'cbw' : 'cwde';
  else if (insn.op === OP.CWD) m = insn.opsize === 2 ? 'cwd' : 'cdq';
  else if (insn.op === OP.MOVS || insn.op === OP.CMPS || insn.op === OP.STOS || insn.op === OP.LODS || insn.op === OP.SCAS) {
    const sz = insn.ops[0].size;
    m += sz === 1 ? 'b' : sz === 2 ? 'w' : 'd';
    return (insn.rep === 0xf3 ? (insn.op === OP.CMPS || insn.op === OP.SCAS ? 'repe ' : 'rep ') : insn.rep === 0xf2 ? 'repne ' : '') + m;
  }
  const pre = (insn.lock ? 'lock ' : '') + (insn.rep === 0xf3 ? 'rep ' : insn.rep === 0xf2 ? 'repne ' : '');
  return pre + m + (insn.ops.length ? ' ' + insn.ops.map(fmtOperand).join(', ') : '');
}
