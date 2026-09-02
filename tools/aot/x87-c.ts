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

export const X87_PRELUDE = `typedef uint64_t __attribute__((aligned(1))) u64u;
#define LD64(a) (*(volatile u64u *)(uintptr_t)(mb + (a)))
#define ST64(a, v) (*(volatile u64u *)(uintptr_t)(mb + (a)) = (uint64_t)(v))
#define FPU_ST_M(s) (*(volatile uint64_t *)(uintptr_t)(1152u + 16u * (s)))
#define FPU_ST_T(s) (*(volatile uint16_t *)(uintptr_t)(1160u + 16u * (s)))
#define FPU_TOP (*(volatile uint8_t *)1032)
#define FPU_EMPTY (*(volatile uint8_t *)816)
#define FPU_CW (*(volatile uint16_t *)1036)
#define FPU_SW (*(volatile uint16_t *)1040)
#define FPU_DIRTY (*(volatile uint8_t *)632)
#define FLAGS_CHANGED (*(volatile int32_t *)100)
typedef union { double d; uint64_t u; float f; uint32_t w; } fbits;
static inline double f64u(uint64_t u) { fbits b; b.u = u; return b.d; }
static inline uint64_t u64d(double d) { fbits b; b.d = d; return b.u; }
static inline float f32u(uint32_t w) { fbits b; b.w = w; return b.f; }
static inline uint32_t u32f(float f) { fbits b; b.f = f; return b.w; }
#define X87_SLOT(i) ((top + (i)) & 7u)
#define X87_OK(s) (FPU_ST_T(s) == 0x7ffeu)
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
`;

const FAST = new Set([
    "fld", "fild", "fst", "fstp", "fist", "fistp", "fisttp",
    "fadd", "faddp", "fiadd", "fsub", "fsubp", "fisub", "fsubr", "fsubrp", "fisubr",
    "fmul", "fmulp", "fimul", "fdiv", "fdivp", "fidiv", "fdivr", "fdivrp", "fidivr",
    "fchs", "fabs", "fld1", "fldz", "fldpi", "fldl2e", "fldln2", "fldlg2", "fldl2t",
    "fxch", "fcom", "fcomp", "fcompp", "fucom", "fucomp", "fucompp", "ficom", "ficomp", "ftst",
    "fcomi", "fcomip", "fcompi", "fucomi", "fucomip", "fucompi", "fnstsw", "fstsw", "fnstcw", "fstcw", "ffree", "fnop",
]);

/** "fast" (translated inline), "slow" (interpreter runs it), or null when
 *  the mnemonic is not an x87 instruction. */
export function x87Kind(mnemonic: string, operand?: string): "fast" | "slow" | null {
    if (mnemonic === "fwait") return "fast";
    if (!mnemonic.startsWith("f")) return null;
    if (!FAST.has(mnemonic)) return "slow";
    if (operand !== undefined) {
        const o = operand.toLowerCase();
        if (o.includes("tbyte")) return "slow";
        // fistp m64 is a helper in the JIT too.
        if ((mnemonic === "fistp" || mnemonic === "fisttp" || mnemonic === "fist") && o.includes("qword")) return "slow";
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
        lines.push(`if (!X87_OK(top)) { ${slow} }`);
        if (op.width === 4) lines.push(`ST32(${op.addr}, u32f((float)f64u(FPU_ST_M(top))));`);
        else if (op.width === 8) lines.push(`ST64(${op.addr}, FPU_ST_M(top));`);
        else return `${mnemonic} width ${op.width}`;
        if (mnemonic === "fstp") lines.push(`X87_POP();`);
        return { producer: false };
    }
    if (mnemonic === "fist" || mnemonic === "fistp" || mnemonic === "fisttp") {
        const op = mem(ops[0] ?? "");
        if (typeof op === "string") return op;
        if (op.width !== 2 && op.width !== 4) return `${mnemonic} width ${op.width}`;
        lines.push(`if (!X87_OK(top)) { ${slow} }`);
        const rounded = mnemonic === "fisttp"
            ? `__builtin_trunc(f64u(FPU_ST_M(top)))`
            : `x87_round_rc(f64u(FPU_ST_M(top)), (((uint32_t)FPU_CW) >> 10) & 3u)`;
        if (op.width === 4) lines.push(`ST32(${op.addr}, x87_to_i32(${rounded}));`);
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
            lines.push(`{ uint32_t sd = X87_SLOT(${d}u), ss = X87_SLOT(${s}u); if (!(X87_OK(sd) && X87_OK(ss))) { ${slow} } double x = f64u(FPU_ST_M(sd)), y = f64u(FPU_ST_M(ss)); FPU_ST_M(sd) = u64d(X87_ROUND(${combine("x", "y")})); }`);
            if (pop) lines.push(`X87_POP();`);
            return { producer: false };
        }
        if (ops.length === 2) {
            const d = stIndex(ops[0]!), s = stIndex(ops[1]!);
            if (d === null || s === null || (d !== 0 && s !== 0)) return `${mnemonic} ${ops.join(", ")}`;
            lines.push(`{ uint32_t sd = X87_SLOT(${d}u), ss = X87_SLOT(${s}u); if (!(X87_OK(sd) && X87_OK(ss))) { ${slow} } double x = f64u(FPU_ST_M(sd)), y = f64u(FPU_ST_M(ss)); FPU_ST_M(sd) = u64d(X87_ROUND(${combine("x", "y")})); }`);
            if (pop) lines.push(`X87_POP();`);
            return { producer: false };
        }
        if (pop) return `${mnemonic} ${ops.join(", ")}`;
        const m = mem(ops[0]!);
        if (typeof m === "string") return m;
        const v = memF64(m, integer);
        if (v === null) return `${mnemonic} width ${m.width}`;
        lines.push(`{ if (!X87_OK(top)) { ${slow} } double x = f64u(FPU_ST_M(top)), y = ${v}; FPU_ST_M(top) = u64d(X87_ROUND(${combine("x", "y")})); }`);
        return { producer: false };
    }

    if (mnemonic === "fchs" || mnemonic === "fabs") {
        lines.push(`if (!X87_OK(top)) { ${slow} }`);
        lines.push(mnemonic === "fchs" ? `FPU_ST_M(top) ^= 0x8000000000000000ull;` : `FPU_ST_M(top) &= 0x7fffffffffffffffull;`);
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
        let check = `X87_OK(top)`;
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
                y = `f64u(FPU_ST_M(X87_SLOT(${si}u)))`;
                check = `(X87_OK(top) && X87_OK(X87_SLOT(${si}u)))`;
            } else {
                const m = mem(last);
                if (typeof m === "string") return m;
                const v = memF64(m, false);
                if (v === null) return `${mnemonic} width ${m.width}`;
                y = v;
            }
        }
        lines.push(`if (!${check}) { ${slow} }`);
        if (eflags) {
            lines.push(`{ double x = f64u(FPU_ST_M(top)), y = ${y}; fa = X87_CMP(x, y, 1u, 64u, 69u); FLAGS = (int32_t)(((uint32_t)FLAGS & ~0x8d5u) | fa); FLAGS_CHANGED = 0; }`);
        } else {
            lines.push(`{ double x = f64u(FPU_ST_M(top)), y = ${y}; FPU_SW = (uint16_t)(((uint32_t)FPU_SW & ~0x4700u) | X87_CMP(x, y, 0x100u, 0x4000u, 0x4500u)); }`);
        }
        for (let k = 0; k < pops; k++) lines.push(`X87_POP();`);
        return { producer: eflags };
    }

    return `unsupported: ${mnemonic}`;
}
