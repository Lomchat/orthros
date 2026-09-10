/**
 * x87 for the translator, mirroring the JIT's relaxed path (see
 * x87-contract.md): a stack slot whose tag is 0x7FFE holds raw f64 bits, and
 * every fast form checks that tag before computing in double. A slot in any
 * other representation, and every instruction the JIT itself leaves to a
 * helper, exits to the interpreter at the instruction (`slowExit`); the
 * translation resumes right behind it. TOP and the empty bitmap are the
 * function's `top`/`fempty` locals; `fdirty` asks the epilogue to write them
 * back and to mark the FPU state dirty for the thread scheduler.
 */

export interface X87Operand {
    kind: "reg32" | "reg16" | "reg8lo" | "reg8hi" | "imm" | "mem";
    index?: number;
    value?: number;
    addr?: string;
    width?: number;
}

export interface X87Helpers {
    parseOperand(text: string): X87Operand | null;
    readExpr(op: X87Operand): string | null;
    guardMem(lines: string[], op: X87Operand, insnAddr: number, done: number): void;
    guardExit(insnAddr: number, done: number): string;
    slowExit(insnAddr: number, done: number): string;
}

export const X87_PRELUDE = `/* The x87 register file lives in v86's memory but is only touched by this
 * code while a translation runs: every call out (hypercall_out, run_until) is
 * an opaque call clang must assume clobbers memory, so plain may_alias
 * accesses are exact and let a block keep ST(i), the tags and the control
 * word in registers instead of a volatile round trip per instruction. */
#define FPU_ST_M(s) (*(u64u *)(uintptr_t)(1152u + 16u * (s)))
#define FPU_ST_T(s) (*(u16u *)(uintptr_t)(1160u + 16u * (s)))
#define FPU_TOP (*(uint8_t *)1032)
#define FPU_EMPTY (*(uint8_t *)816)
#define FPU_CW (*(u16u *)1036)
#define FPU_SW (*(u16u *)1040)
#define FPU_DIRTY (*(uint8_t *)632)
#define FLAGS_CHANGED (*(volatile int32_t *)100)
typedef union { double d; uint64_t u; float f; uint32_t w; } fbits;
static inline double f64u(uint64_t u) { fbits b; b.u = u; return b.d; }
static inline uint64_t u64d(double d) { fbits b; b.d = d; return b.u; }
static inline float f32u(uint32_t w) { fbits b; b.w = w; return b.f; }
static inline uint32_t u32f(float f) { fbits b; b.f = f; return b.w; }
#define X87_SLOT(i) ((top + (i)) & 7u)
#define X87_OK(s) (FPU_ST_T(s) == 0x7ffeu)
/* A true F80 slot as the f64 bits v86 computes with (F80::to_f64): NaN keeps
 * its quiet bit and payload, F80 denormals flush to zero, f64 subnormals keep
 * v86's masked shift. Every consumer reads a slot through X87_LD and writes
 * its result relaxed with X87_ST, so a raw m80 load or a value left by the
 * interpreter never forces an exit. */
static inline uint64_t x87_f80_to_f64(uint64_t m, uint32_t se) {
    uint64_t sign = (uint64_t)(se >> 15) << 63;
    int32_t exp = (int32_t)(se & 0x7fffu);
    if (exp == 0 && m == 0ull) return sign;
    if (exp == 0x7fff) {
        if (m == 0x8000000000000000ull) return sign | (0x7ffull << 52);
        return sign | (0x7ffull << 52) | (((m >> 62) & 1ull) << 51) | (((m & 0x3fffffffffffffffull) >> 11) & 0x7ffffffffffffull);
    }
    if (exp == 0) return sign;
    int32_t e = exp - 16383 + 1023;
    if (e >= 0x7ff) return sign | (0x7ffull << 52);
    if (e <= 0) { int32_t shift = 1 - e; if (shift >= 64) return sign; return sign | (m >> ((uint32_t)(11 + shift) & 63u)); }
    return sign | ((uint64_t)e << 52) | ((m & 0x7fffffffffffffffull) >> 11);
}
#define X87_LD(s) (X87_OK(s) ? FPU_ST_M(s) : x87_f80_to_f64(FPU_ST_M(s), (uint32_t)FPU_ST_T(s)))
#define X87_ST(s, v) do { FPU_ST_M(s) = (v); FPU_ST_T(s) = (uint16_t)0x7ffeu; } while (0)
/* Reading an empty slot is a stack fault (v86 supplies the indefinite NaN and
 * sets IE): the interpreter's, so the block exits before it. */
#define X87_EMPTY(s) ((fempty >> (s)) & 1u)
#define X87_PUSH(m, t) do { top = (top - 1u) & 7u; fempty &= ~(1u << top); FPU_ST_M(top) = (m); FPU_ST_T(top) = (uint16_t)(t); } while (0)
#define X87_POP() do { fempty |= (1u << top); top = (top + 1u) & 7u; } while (0)
#define X87_ROUND(r) (((((uint32_t)FPU_CW) >> 8) & 3u) == 0u ? (double)(float)(r) : (r))
#define X87_CMP(x, y, lt, eq, un) ((x) < (y) ? (lt) : (x) == (y) ? (eq) : (y) < (x) ? 0u : (un))
static inline double x87_round_rc(double v, uint32_t rc) {
    return rc == 1u ? __builtin_floor(v) : rc == 2u ? __builtin_ceil(v) : rc == 3u ? __builtin_trunc(v) : __builtin_nearbyint(v);
}
static inline uint32_t x87_to_i32(double r) {
    return (r != r || r >= 2147483648.0 || r < -2147483648.0) ? 0x80000000u : (uint32_t)(int32_t)r;
}
static inline uint64_t x87_to_i64(double r) {
    return (r != r || r >= 9223372036854775808.0 || r < -9223372036854775808.0) ? 0x8000000000000000ull : (uint64_t)(int64_t)r;
}
/* Relaxed f64 bits to the true 80-bit form, as v86 canonicalises a slot it
 * stores with fstp m80 (F80::of_f64_strict): explicit integer bit, rebias
 * 1023 -> 16383, denormals normalised, NaN payload and quiet bit kept. Two
 * pure functions (no address-taken local: the module has no shadow stack). */
static inline uint64_t x87_f64_to_f80_m(uint64_t src) {
    uint32_t exp = (uint32_t)(src >> 52) & 0x7ffu;
    uint64_t mant = src & 0xfffffffffffffull;
    if (exp == 0u && mant == 0ull) return 0ull;
    if (exp == 0x7ffu) return mant == 0ull ? 0x8000000000000000ull : 0x8000000000000000ull | (((mant >> 51) & 1ull) << 62) | ((mant & 0x7ffffffffffffull) << 11);
    if (exp == 0u) return 0x8000000000000000ull | ((mant << ((uint32_t)__builtin_clzll(mant) - 11u)) << 11);
    return 0x8000000000000000ull | (mant << 11);
}
static inline uint32_t x87_f64_to_f80_se(uint64_t src) {
    uint32_t sign = (uint32_t)(src >> 63) << 15;
    uint32_t exp = (uint32_t)(src >> 52) & 0x7ffu;
    uint64_t mant = src & 0xfffffffffffffull;
    if (exp == 0u && mant == 0ull) return sign;
    if (exp == 0x7ffu) return sign | 0x7fffu;
    if (exp == 0u) return sign | (uint32_t)(15361 - (int32_t)((uint32_t)__builtin_clzll(mant) - 12u));
    return sign | (exp + 15360u);
}
`;

const FAST = new Set([
    "fld", "fild", "fst", "fstp", "fist", "fistp", "fisttp",
    "fadd", "faddp", "fiadd", "fsub", "fsubp", "fisub", "fsubr", "fsubrp", "fisubr",
    "fmul", "fmulp", "fimul", "fdiv", "fdivp", "fidiv", "fdivr", "fdivrp", "fidivr",
    "fchs", "fabs", "fld1", "fldz", "fldpi", "fldl2e", "fldln2", "fldlg2", "fldl2t",
    "fxch", "fcom", "fcomp", "fcompp", "fucom", "fucomp", "fucompp", "ficom", "ficomp", "ftst",
    "fcomi", "fcomip", "fcompi", "fucomi", "fucomip", "fucompi", "fnstsw", "fstsw", "fnstcw", "fstcw", "ffree", "fnop",
    "fsqrt", "fldcw", "fxam", "fsin", "fcos", "fsincos", "fptan", "fpatan",
]);

/** "fast" (translated inline), "slow" (interpreter runs it), or null when
 *  the mnemonic is not an x87 instruction. */
export function x87Kind(mnemonic: string, operand?: string): "fast" | "slow" | null {
    if (mnemonic === "fwait") return "fast";
    if (!mnemonic.startsWith("f")) return null;
    if (!FAST.has(mnemonic)) return "slow";
    if (operand !== undefined) {
        const o = operand.toLowerCase();
        // m80 (capstone: `xword ptr`) is only modelled as a raw load and store.
        if (o.includes("tbyte") || o.includes("xword")) return mnemonic === "fld" || mnemonic === "fstp" ? "fast" : "slow";
        // fistp m64 is a helper in the JIT too.
        if ((mnemonic === "fst" || mnemonic === "fstp") && o.includes("qword") && !o.includes("[")) return "slow";
    }
    return "fast";
}

const CONSTS: Record<string, string> = {
    fld1: "0x3ff0000000000000ull",
    fldz: "0x0ull",
    fldpi: "0x400921fb54442d18ull",
    fldl2e: "0x3ff71547652b82feull",
    fldln2: "0x3fe62e42fefa39efull",
    fldlg2: "0x3fd34413509f79ffull",
    fldl2t: "0x400a934f0979a371ull",
};

function stIndex(text: string): number | null {
    const t = text.trim();
    if (t === "st") return 0;
    const m = /^st\((\d)\)$/.exec(t);
    return m ? Number(m[1]) : null;
}

/** Emit one fast x87 instruction. Returns a rejection reason, or whether the
 *  instruction is a flag producer (the fcomi family, whose result is in `fa`). */
export function emitX87(
    h: X87Helpers, mnemonic: string, ops: string[], insn: { addr: number }, i: number, lines: string[],
): { producer: boolean } | string {
    const slow = h.slowExit(insn.addr, i);
    const mem = (text: string): X87Operand | string => {
        const op = h.parseOperand(text);
        if (!op || op.kind !== "mem") return `${mnemonic} operand ${text}`;
        h.guardMem(lines, op, insn.addr, i);
        return op;
    };
    // A float or integer memory source as a double expression.
    const memF64 = (op: X87Operand, integer: boolean): string | null => {
        if (integer) {
            if (op.width === 2) return `(double)(int16_t)LD16(${op.addr})`;
            if (op.width === 4) return `(double)(int32_t)LD32(${op.addr})`;
            if (op.width === 8) return `(double)(int64_t)LD64(${op.addr})`;
            return null;
        }
        if (op.width === 4) return `(double)f32u(LD32(${op.addr}))`;
        if (op.width === 8) return `f64u(LD64(${op.addr}))`;
        return null;
    };

    if (mnemonic === "fnop" || mnemonic === "fwait") return { producer: false };

    if (mnemonic === "fnstsw" || mnemonic === "fstsw") {
        const t = (ops[0] ?? "").trim();
        const v = `(((uint32_t)FPU_SW & ~0x3800u) | (top << 11))`;
        if (t === "ax") { lines.push(`eax = (eax & ~0xffffu) | ${v};`); return { producer: false }; }
        const op = mem(t);
        if (typeof op === "string") return op;
        lines.push(`ST16(${op.addr}, ${v});`);
        return { producer: false };
    }
    if (mnemonic === "fnstcw" || mnemonic === "fstcw") {
        const op = mem(ops[0] ?? "");
        if (typeof op === "string") return op;
        lines.push(`ST16(${op.addr}, (uint32_t)FPU_CW);`);
        return { producer: false };
    }

    lines.push(`fdirty = 1u;`);

    if (mnemonic in CONSTS) {
        lines.push(`X87_PUSH(${CONSTS[mnemonic]}, 0x7ffeu);`);
        return { producer: false };
    }
    if (mnemonic === "fld" || mnemonic === "fild") {
        const t = ops[0] ?? "";
        const si = mnemonic === "fld" ? stIndex(t) : null;
        if (si !== null) {
            lines.push(`{ uint32_t s = X87_SLOT(${si}u); if ((fempty >> s) & 1u) { ${slow} } uint64_t m = FPU_ST_M(s); uint32_t t = FPU_ST_T(s); X87_PUSH(m, t); }`);
            return { producer: false };
        }
        const op = mem(t);
        if (typeof op === "string") return op;
        if (op.width === 10 && mnemonic === "fld") {
            // m80: pushed as the true F80 it encodes, no canonical form, as
            // v86's helper does; a later f64 read of that slot exits (the
            // slot is not relaxed), a raw copy or store of it is exact.
            lines.push(`X87_PUSH(LD64(${op.addr}), LD16(${op.addr} + 8u));`);
            return { producer: false };
        }
        const v = memF64(op, mnemonic === "fild");
        if (v === null) return `${mnemonic} width ${op.width}`;
        lines.push(`X87_PUSH(u64d(${v}), 0x7ffeu);`);
        return { producer: false };
    }
    if (mnemonic === "fst" || mnemonic === "fstp") {
        const t = ops[0] ?? "";
        const si = stIndex(t);
        if (si !== null) {
            if (si !== 0) lines.push(`{ uint32_t s = X87_SLOT(${si}u); FPU_ST_M(s) = FPU_ST_M(top); FPU_ST_T(s) = FPU_ST_T(top); }`);
            if (mnemonic === "fstp") lines.push(`X87_POP();`);
            return { producer: false };
        }
        const op = mem(t);
        if (typeof op === "string") return op;
        if (op.width === 10) {
            // fstp m80 stores the slot's 80-bit image; a relaxed slot is
            // canonicalised first, as v86's store does.
            if (mnemonic !== "fstp") return `${mnemonic} width ${op.width}`;
            lines.push(`{ uint64_t m = FPU_ST_M(top); uint32_t t = FPU_ST_T(top); if (t == 0x7ffeu) { t = x87_f64_to_f80_se(m); m = x87_f64_to_f80_m(m); } ST64(${op.addr}, m); ST16(${op.addr} + 8u, t); }`, `X87_POP();`);
            return { producer: false };
        }
        lines.push(`if (X87_EMPTY(top)) { ${slow} }`);
        if (op.width === 4) lines.push(`ST32(${op.addr}, u32f((float)f64u(X87_LD(top))));`);
        else if (op.width === 8) lines.push(`ST64(${op.addr}, X87_LD(top));`);
        else return `${mnemonic} width ${op.width}`;
        if (mnemonic === "fstp") lines.push(`X87_POP();`);
        return { producer: false };
    }
    if (mnemonic === "fist" || mnemonic === "fistp" || mnemonic === "fisttp") {
        const op = mem(ops[0] ?? "");
        if (typeof op === "string") return op;
        if (op.width !== 2 && op.width !== 4 && op.width !== 8) return `${mnemonic} width ${op.width}`;
        lines.push(`if (X87_EMPTY(top)) { ${slow} }`);
        const rounded = mnemonic === "fisttp"
            ? `__builtin_trunc(f64u(X87_LD(top)))`
            : `x87_round_rc(f64u(X87_LD(top)), (((uint32_t)FPU_CW) >> 10) & 3u)`;
        if (op.width === 8) lines.push(`ST64(${op.addr}, x87_to_i64(${rounded}));`);
        else if (op.width === 4) lines.push(`ST32(${op.addr}, x87_to_i32(${rounded}));`);
        else lines.push(`{ int32_t w = (int32_t)x87_to_i32(${rounded}); if (w < -0x8000 || w > 0x7fff) w = -0x8000; ST16(${op.addr}, (uint32_t)w); }`);
        if (mnemonic !== "fist") lines.push(`X87_POP();`);
        return { producer: false };
    }

    const arith = /^(f|fi)(add|sub|subr|mul|div|divr)(p?)$/.exec(mnemonic);
    if (arith) {
        const integer = arith[1] === "fi";
        const op = arith[2]!;
        const pop = arith[3] === "p";
        const cop = op === "add" ? "+" : op === "mul" ? "*" : op.startsWith("sub") ? "-" : "/";
        const reversed = op === "subr" || op === "divr";
        const combine = (x: string, y: string) => reversed ? `${y} ${cop} ${x}` : `${x} ${cop} ${y}`;
        // capstone prints the register forms with one operand: `fadd st(i)`
        // (D8) is st(0) op= st(i), `faddp st(i)` (DE) is st(i) op= st(0) then
        // pop; the DC forms come out as `fadd st(i), st(0)`.
        const single = ops.length === 0 ? 1 : ops.length === 1 ? stIndex(ops[0]!) : null;
        if (ops.length <= 1 && single !== null) {
            if (!pop && ops.length === 0) return `${mnemonic} without operands`;
            const d = pop ? single : 0, s = pop ? 0 : single;
            lines.push(`{ uint32_t sd = X87_SLOT(${d}u), ss = X87_SLOT(${s}u); if (X87_EMPTY(sd) || X87_EMPTY(ss)) { ${slow} } double x = f64u(X87_LD(sd)), y = f64u(X87_LD(ss)); X87_ST(sd, u64d(X87_ROUND(${combine("x", "y")}))); }`);
            if (pop) lines.push(`X87_POP();`);
            return { producer: false };
        }
        if (ops.length === 2) {
            const d = stIndex(ops[0]!), s = stIndex(ops[1]!);
            if (d === null || s === null || (d !== 0 && s !== 0)) return `${mnemonic} ${ops.join(", ")}`;
            lines.push(`{ uint32_t sd = X87_SLOT(${d}u), ss = X87_SLOT(${s}u); if (X87_EMPTY(sd) || X87_EMPTY(ss)) { ${slow} } double x = f64u(X87_LD(sd)), y = f64u(X87_LD(ss)); X87_ST(sd, u64d(X87_ROUND(${combine("x", "y")}))); }`);
            if (pop) lines.push(`X87_POP();`);
            return { producer: false };
        }
        if (pop) return `${mnemonic} ${ops.join(", ")}`;
        const m = mem(ops[0]!);
        if (typeof m === "string") return m;
        const v = memF64(m, integer);
        if (v === null) return `${mnemonic} width ${m.width}`;
        lines.push(`{ if (X87_EMPTY(top)) { ${slow} } double x = f64u(X87_LD(top)), y = ${v}; X87_ST(top, u64d(X87_ROUND(${combine("x", "y")}))); }`);
        return { producer: false };
    }

    if (mnemonic === "fchs" || mnemonic === "fabs") {
        // The sign lives in bit 63 of a relaxed slot's f64 bits, in bit 15 of a
        // true F80's sign/exponent word (v86's neg/abs keep the encoding).
        lines.push(`if (X87_EMPTY(top)) { ${slow} }`);
        lines.push(mnemonic === "fchs"
            ? `if (X87_OK(top)) FPU_ST_M(top) ^= 0x8000000000000000ull; else FPU_ST_T(top) = (uint16_t)((uint32_t)FPU_ST_T(top) ^ 0x8000u);`
            : `if (X87_OK(top)) FPU_ST_M(top) &= 0x7fffffffffffffffull; else FPU_ST_T(top) = (uint16_t)((uint32_t)FPU_ST_T(top) & 0x7fffu);`);
        return { producer: false };
    }
    if (mnemonic === "fsqrt") {
        // f64.sqrt is correctly rounded, like the relaxed helper's f64 sqrt.
        lines.push(`{ if (X87_EMPTY(top)) { ${slow} } double x = f64u(X87_LD(top)); X87_ST(top, u64d(X87_ROUND(__builtin_sqrt(x)))); }`);
        return { producer: false };
    }
    if (mnemonic === "fsin" || mnemonic === "fcos") {
        // v86: the f64 function of the interpreter's libm (imported from it),
        // C2 cleared, no range reduction check.
        lines.push(`{ if ((fempty >> top) & 1u) { ${slow} } X87_ST(top, u64d(x87_${mnemonic.slice(1)}(f64u(X87_LD(top)))));`
            + ` FPU_SW = (uint16_t)((uint32_t)FPU_SW & ~0x400u); }`);
        return { producer: false };
    }
    if (mnemonic === "fsincos") {
        // v86: ST(0) = sin, then cos pushed (C1 cleared by the push), C2 cleared.
        lines.push(`{ if ((fempty >> top) & 1u) { ${slow} } double x = f64u(X87_LD(top)); X87_ST(top, u64d(x87_sin(x)));`
            + ` X87_PUSH(u64d(x87_cos(x)), 0x7ffeu); FPU_SW = (uint16_t)((uint32_t)FPU_SW & ~0x600u); }`);
        return { producer: false };
    }
    if (mnemonic === "fptan") {
        // v86: ST(0) = tan, then 1.0 pushed (C1 cleared by the push), C2 cleared.
        lines.push(`{ if ((fempty >> top) & 1u) { ${slow} } X87_ST(top, u64d(x87_tan(f64u(X87_LD(top)))));`
            + ` X87_PUSH(0x3ff0000000000000ull, 0x7ffeu); FPU_SW = (uint16_t)((uint32_t)FPU_SW & ~0x600u); }`);
        return { producer: false };
    }
    if (mnemonic === "fpatan") {
        // v86: ST(1) = atan2(ST(1), ST(0)), then pop.
        lines.push(`{ uint32_t s1 = (top + 1u) & 7u; if (((fempty >> top) & 1u) || ((fempty >> s1) & 1u)) { ${slow} }`
            + ` X87_ST(s1, u64d(x87_atan2(f64u(X87_LD(s1)), f64u(X87_LD(top))))); X87_POP(); }`);
        return { producer: false };
    }
    if (mnemonic === "fxam") {
        // v86: C1 = sign, then NaN -> C0, zero -> C3, infinite -> C2|C0, else
        // C2 (no denormal class). An empty slot raises a stack fault there,
        // which stays the interpreter's.
        lines.push(`{ if (((fempty >> top) & 1u) || !X87_OK(top)) { ${slow} } uint64_t m = FPU_ST_M(top); double x = f64u(m);`
            + ` uint32_t sw = ((uint32_t)FPU_SW & ~0x4700u) | ((uint32_t)(m >> 63) << 9);`
            + ` if (x != x) sw |= 0x100u; else if (x == 0.0) sw |= 0x4000u; else if (x - x != 0.0) sw |= 0x500u; else sw |= 0x400u; FPU_SW = (uint16_t)sw; }`);
        return { producer: false };
    }
    if (mnemonic === "fldcw") {
        // The control word also drives v86's own rounding mode and precision
        // flag (helpers, JIT codegen), so the runtime is told through an import.
        const op = mem(ops[0] ?? "");
        if (typeof op === "string") return op;
        if (op.width !== 2) return `fldcw width ${op.width}`;
        lines.push(`{ uint32_t cw = LD16(${op.addr}); FPU_CW = (uint16_t)cw; x87_set_cw((int32_t)cw); }`);
        return { producer: false };
    }
    if (mnemonic === "fxch") {
        const si = ops.length > 0 ? stIndex(ops[ops.length - 1]!) : 1;
        if (si === null) return `fxch ${ops.join(", ")}`;
        lines.push(`{ uint32_t s = X87_SLOT(${si}u); uint64_t m = FPU_ST_M(top); uint32_t t = FPU_ST_T(top); FPU_ST_M(top) = FPU_ST_M(s); FPU_ST_T(top) = FPU_ST_T(s); FPU_ST_M(s) = m; FPU_ST_T(s) = (uint16_t)t; }`);
        return { producer: false };
    }
    if (mnemonic === "ffree") {
        const si = stIndex(ops[0] ?? "");
        if (si === null) return `ffree ${ops.join(", ")}`;
        lines.push(`fempty |= 1u << X87_SLOT(${si}u);`);
        return { producer: false };
    }

    // capstone spells DF F0+i / DB F0+i as fcompi / fcomip depending on the
    // build; both are the EFLAGS form.
    const cmp = /^(fcom|fcomp|fcompp|fucom|fucomp|fucompp|ficom|ficomp|ftst|fcomi|fcomip|fcompi|fucomi|fucomip|fucompi)$/.exec(mnemonic);
    if (cmp) {
        const eflags = mnemonic.includes("comi") || mnemonic.endsWith("compi");
        const pops = mnemonic.endsWith("pp") ? 2 : (mnemonic.endsWith("p") || mnemonic.endsWith("compi")) ? 1 : 0;
        let y: string;
        let empty = `X87_EMPTY(top)`;
        if (mnemonic === "ftst") y = "0.0";
        else if (mnemonic.startsWith("fi")) {
            const m = mem(ops[0] ?? "");
            if (typeof m === "string") return m;
            const v = memF64(m, true);
            if (v === null) return `${mnemonic} width ${m.width}`;
            y = v;
        } else {
            const last = ops.length > 0 ? ops[ops.length - 1]! : "st(1)";
            const si = stIndex(last);
            if (si !== null) {
                if (ops.length === 2 && stIndex(ops[0]!) !== 0) return `${mnemonic} ${ops.join(", ")}`;
                y = `f64u(X87_LD(X87_SLOT(${si}u)))`;
                empty = `(X87_EMPTY(top) || X87_EMPTY(X87_SLOT(${si}u)))`;
            } else {
                const m = mem(last);
                if (typeof m === "string") return m;
                const v = memF64(m, false);
                if (v === null) return `${mnemonic} width ${m.width}`;
                y = v;
            }
        }
        lines.push(`if (${empty}) { ${slow} }`);
        if (eflags) {
            lines.push(`{ double x = f64u(X87_LD(top)), y = ${y}; fa = X87_CMP(x, y, 1u, 64u, 69u); FLAGS = (int32_t)(((uint32_t)FLAGS & ~0x8d5u) | fa); FLAGS_CHANGED = 0; }`);
        } else {
            lines.push(`{ double x = f64u(X87_LD(top)), y = ${y}; FPU_SW = (uint16_t)(((uint32_t)FPU_SW & ~0x4700u) | X87_CMP(x, y, 0x100u, 0x4000u, 0x4500u)); }`);
        }
        for (let k = 0; k < pops; k++) lines.push(`X87_POP();`);
        return { producer: eflags };
    }

    return `unsupported: ${mnemonic}`;
}
