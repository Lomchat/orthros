/**
 * Translate x86 functions into C, in the ABI of a v86 JIT module.
 *
 * The runtime model mirrors v86's own: one module per guest page, entered
 * through `page_<addr>(initial_state)` whose cases are the entry points that
 * page owns. An entry is either a function start or a resume point after a
 * call — because a call is an exit here: the return address is pushed, EIP is
 * set to the target and the function returns to the dispatcher, which later
 * re-enters the function at the after-call block when the callee returns.
 * Functions are `static void fn_<addr>(int block)`; a page case just calls
 * the owning function at the right block, so a function whose entries span
 * pages is reached from each page's module.
 *
 * Everything runs in v86's linear memory: guest registers and the
 * instruction pointer at the fixed offsets of `global_pointers.rs`, guest RAM
 * at `mem_base()`. Every exit materialises EIP: `ret` pops it, a call sets
 * the target, an indirect jump its computed target, a loop that exhausts its
 * budget the loop head, and a memory access past guest RAM or a division
 * that would fault exits at the instruction's own address before running
 * it, so v86 raises the fault where the guest would have. The instruction
 * counter is exact, because v86 derives guest time from it.
 *
 * Flags: every consumer (a conditional branch, setcc, cmovcc, adc, sbb) reads
 * the last flag-writing instruction before it in its own block, which must be
 * one of the modelled producers (cmp, test, add, sub, and, or, xor, inc,
 * dec); the producer's operands are captured only when something consumes
 * them, every other flag update being dead by the x86 calling convention.
 * Any shape outside the subset declines the function.
 *
 * The emitted C must never use a data segment or the C shadow stack: only
 * locals, the guest stack and the shared memory. That is what lets a module
 * share v86's memory.
 */

import { BlockReader, CapstoneDecoder, directTarget, type Insn } from "./decoder-capstone";
import { X87_PRELUDE, emitX87, x87Kind } from "./x87-c";

export let lastRejection = "";

export interface CFunction {
    entry: number;
    name: string;
    c: string;
    instructions: number;
    blocks: number;
    liveFlagSites: number;
    calls: number;
    /** Direct call targets, for a batch to pull in the callees a function leaves for. */
    callTargets: number[];
    /** Entry addresses (function start + after-call resumes) and their block index. */
    entries: Array<{ addr: number; block: number }>;
    extent: number;
}

export interface PageModule {
    page: number;
    name: string;
    /** initial_state -> entry address, in case order. */
    states: Array<{ addr: number; fn: string; block: number }>;
}

export interface Batch {
    /** The whole unit, for a batch small enough to compile in one go. */
    c: string;
    /** Prelude, declarations and macros shared by every unit. */
    header: string;
    /** Function bodies split into balanced units; the last one also holds the
     *  dispatcher and the page modules. Compiled in parallel and linked. */
    units: string[];
    functions: CFunction[];
    pages: PageModule[];
}

const REG32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const REG16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const REG8_LOW = ["al", "cl", "dl", "bl"];
const REG8_HIGH = ["ah", "ch", "dh", "bh"];

const COND_BRANCH = new Set([
    "je", "jz", "jne", "jnz", "jl", "jnge", "jle", "jng", "jg", "jnle", "jge", "jnl",
    "jb", "jnae", "jc", "jbe", "jna", "ja", "jnbe", "jae", "jnb", "jnc", "js", "jns",
    "jp", "jpe", "jnp", "jpo", "jo", "jno",
]);
/** Flag producers a consumer can read. `sahf` and the fcomi family carry the
 *  x87 compare result into EFLAGS. */
const FLAG_PRODUCER = new Set(["cmp", "test", "sub", "add", "and", "or", "xor", "inc", "dec", "neg",
    "shl", "shr", "sar", "adc", "sbb", "imul", "mul",
    "bt", "bts", "btr", "btc", "popfd",
    "repe cmpsb", "repe cmpsw", "repe cmpsd",
    "sahf", "fcomi", "fcomip", "fcompi", "fucomi", "fucomip", "fucompi",
    "ucomisd", "comisd", "ucomiss", "comiss"]);
/** Instructions that leave the flags alone; anything else between a producer
 *  and its consumer is a flag writer the model does not follow. Every x87
 *  instruction except the fcomi family and fcmovcc is one of them. */
const FLAG_PRESERVING = new Set([
    "mov", "movzx", "movsx", "lea", "push", "pop", "xchg", "nop", "cdq", "cwde", "cbw", "leave", "not", "rdtsc",
    "enter", "wait", "fwait", "pushfd", "stmxcsr", "ldmxcsr",
    "movq", "movd", "movapd", "movaps", "movdqa", "movups", "movdqu",
    "psrlq", "psllq", "psubd", "paddd", "andpd", "andps", "orpd", "orps",
    "xorpd", "xorps", "pand", "pandn", "por", "pxor",
]);
const SETCC = /^set(e|z|ne|nz|l|nge|le|ng|g|nle|ge|nl|b|nae|c|be|na|a|nbe|ae|nb|nc|s|ns|p|pe|np|po|o|no)$/;
const CMOVCC = /^cmov(e|z|ne|nz|l|nge|le|ng|g|nle|ge|nl|b|nae|c|be|na|a|nbe|ae|nb|nc|s|ns|p|pe|np|po|o|no)$/;
const OTHER_FLAG_READER = /^(set[a-z]+|cmov[a-z]+|fcmov[a-z]+|rcl|rcr|salc|lahf|pushf[d]?|popf[d]?|into|loop[a-z]*|jecxz)$/;

function preservesFlags(m: string): boolean {
    return FLAG_PRESERVING.has(m) || (x87Kind(m) !== null && !FLAG_PRODUCER.has(m) && !/^fcmov/.test(m));
}

const LOOP_LIMIT = 100_000;
const SIZE_BUDGET = 4096;
/** Guest instructions one entry may retire (through native calls included)
 *  before handing control back to the dispatcher, so the scheduler's quantum
 *  is honoured; and the native call depth a translation may add to the host
 *  stack before falling back to the dispatcher for the call. */
const INVOCATION_BUDGET = 100_000;
const NATIVE_CALL_DEPTH = 24;

type ProducerKind = "cmp" | "add" | "logic" | "inc" | "dec" | "sahf" | "fcomi" | "raw" | "runtime";

interface Operand {
    kind: "reg32" | "reg16" | "reg8lo" | "reg8hi" | "imm" | "mem" | "xmm";
    index?: number;
    value?: number;
    addr?: string;
    width?: number;
}

function regIndex(name: string): number | null {
    const i = REG32.indexOf(name);
    return i >= 0 ? i : null;
}

function reject(reason: string): null { lastRejection = reason; return null; }

function parseAddress(inner: string, segment: string | null): string | null {
    const parts: string[] = [];
    let disp = 0;
    for (const rawTerm of inner.split("+")) {
        for (const [i, sub] of rawTerm.split("-").entries()) {
            const term = sub.trim();
            if (!term) continue;
            const negative = i > 0;
            const scaled = /^([a-z]{3})\*(\d)$/.exec(term);
            if (scaled) {
                const r = regIndex(scaled[1]!);
                if (r === null || negative) return null;
                parts.push(`(${REG32[r]} * ${scaled[2]}u)`);
                continue;
            }
            const r = regIndex(term);
            if (r !== null) {
                if (negative) return null;
                parts.push(REG32[r]!);
                continue;
            }
            const n = /^(0x[0-9a-f]+|\d+)$/i.exec(term);
            if (!n) return null;
            disp += (negative ? -1 : 1) * Number(n[1]);
            continue;
        }
    }
    if (segment === "fs") parts.push("FSBASE");
    else if (segment && segment !== "ds" && segment !== "es" && segment !== "ss" && segment !== "cs") return null;
    if (disp !== 0 || parts.length === 0) parts.push(`${disp >>> 0}u`);
    return `(${parts.join(" + ")})`;
}

export function parseOperand(text: string): Operand | null {
    const t = text.trim();
    const xmm = /^xmm([0-7])$/i.exec(t);
    if (xmm) return { kind: "xmm", index: Number(xmm[1]) };
    const r32 = regIndex(t);
    if (r32 !== null) return { kind: "reg32", index: r32 };
    const r16 = REG16.indexOf(t);
    if (r16 >= 0) return { kind: "reg16", index: r16 };
    const r8l = REG8_LOW.indexOf(t);
    if (r8l >= 0) return { kind: "reg8lo", index: r8l };
    const r8h = REG8_HIGH.indexOf(t);
    if (r8h >= 0) return { kind: "reg8hi", index: r8h };
    const imm = /^(-?)(0x[0-9a-f]+|\d+)$/i.exec(t);
    // Number() does not parse a signed hexadecimal literal.
    if (imm) return { kind: "imm", value: (imm[1] ? -Number(imm[2]) : Number(imm[2])) | 0 };
    const widths: Record<string, number> = { BYTE: 1, WORD: 2, DWORD: 4, QWORD: 8, TBYTE: 10, XMMWORD: 16 };
    const mem = /^(?:(BYTE|WORD|DWORD|QWORD|TBYTE|XMMWORD)\s+PTR\s+)?(?:([a-z]{2}):)?\[(.+)\]$/i.exec(t);
    if (mem) {
        const width = mem[1] ? widths[mem[1].toUpperCase()]! : 4;
        const addr = parseAddress(mem[3]!, mem[2] ? mem[2].toLowerCase() : null);
        if (addr === null) return null;
        return { kind: "mem", addr, width };
    }
    const moffs = /^(?:(BYTE|WORD|DWORD|QWORD)\s+PTR\s+)?([a-z]{2}):(0x[0-9a-f]+|\d+)$/i.exec(t);
    if (moffs) {
        const width = moffs[1] ? widths[moffs[1].toUpperCase()]! : 4;
        const seg = moffs[2]!.toLowerCase();
        const off = Number(moffs[3]) >>> 0;
        if (seg === "ds") return { kind: "mem", addr: `(${off}u)`, width };
        if (seg === "fs") return { kind: "mem", addr: `(FSBASE + ${off}u)`, width };
        return null;
    }
    return null;
}

function operandWidth(op: Operand): number {
    switch (op.kind) {
        case "reg32": return 4;
        case "reg16": return 2;
        case "reg8lo": case "reg8hi": return 1;
        case "xmm": return 16;
        case "mem": return op.width!;
        default: return 4;
    }
}

function readExpr(op: Operand): string | null {
    switch (op.kind) {
        case "reg32": return REG32[op.index!]!;
        case "reg16": return `(${REG32[op.index!]} & 0xffffu)`;
        case "reg8lo": return `(${REG32[op.index!]} & 0xffu)`;
        case "reg8hi": return `((${REG32[op.index!]} >> 8) & 0xffu)`;
        case "imm": return `${op.value! >>> 0}u`;
        case "mem":
            if (op.width === 1) return `LD8(${op.addr})`;
            if (op.width === 2) return `LD16(${op.addr})`;
            if (op.width === 4) return `LD32(${op.addr})`;
            return null;
        default: return null;
    }
}

function writeStmt(op: Operand, valueExpr: string): string | null {
    switch (op.kind) {
        case "reg32": return `${REG32[op.index!]} = (uint32_t)(${valueExpr});`;
        case "reg16": {
            const r = REG32[op.index!]!;
            return `${r} = (${r} & ~0xffffu) | ((uint32_t)(${valueExpr}) & 0xffffu);`;
        }
        case "reg8lo": {
            const r = REG32[op.index!]!;
            return `${r} = (${r} & ~0xffu) | ((uint32_t)(${valueExpr}) & 0xffu);`;
        }
        case "reg8hi": {
            const r = REG32[op.index!]!;
            return `${r} = (${r} & ~0xff00u) | (((uint32_t)(${valueExpr}) & 0xffu) << 8);`;
        }
        case "mem":
            if (op.width === 1) return `ST8(${op.addr}, (uint32_t)(${valueExpr}));`;
            if (op.width === 2) return `ST16(${op.addr}, (uint32_t)(${valueExpr}));`;
            if (op.width === 4) return `ST32(${op.addr}, (uint32_t)(${valueExpr}));`;
            return null;
        default: return null;
    }
}

/** Sign-extend a value of `width` bytes to 32 bits, for width-exact flags. */
function sext(expr: string, width: number): string {
    if (width === 4) return expr;
    return `((uint32_t)(int32_t)(int${width * 8}_t)(${expr}))`;
}

function widthMask(width: number): string {
    return width === 4 ? "0xffffffffu" : width === 2 ? "0xffffu" : "0xffu";
}

const BINARY: Record<string, (a: string, b: string) => string> = {
    add: (a, b) => `(${a} + ${b})`,
    sub: (a, b) => `(${a} - ${b})`,
    and: (a, b) => `(${a} & ${b})`,
    or: (a, b) => `(${a} | ${b})`,
    xor: (a, b) => `(${a} ^ ${b})`,
    shl: (a, b) => `(${a} << (${b} & 31u))`,
    shr: (a, b) => `(${a} >> (${b} & 31u))`,
    sar: (a, b) => `((uint32_t)((int32_t)${a} >> (${b} & 31u)))`,
    imul: (a, b) => `(${a} * ${b})`,
};

/**
 * Exact flag expressions from the producer's kind and the values kept in
 * fa/fb/fr (all sign-extended to 32 bits from the operation's width):
 *   cmp/sub : fa = a, fb = b            (flags of a - b)
 *   add     : fa = a, fb = b, fr = a+b
 *   logic   : fr = result (and/or/xor/test)   CF = OF = 0
 *   inc/dec : fa = a, fr = result        CF unchanged: carry forms decline
 */
function flagExprs(kind: ProducerKind): { ZF: string; SF: string; CF: string | null; SO: string | null; PF: string | null } {
    // PF: even parity of the result's low byte.
    const parity = (r: string) => `(__builtin_parity((${r}) & 0xffu) == 0)`;
    // Operands are sign-extended to 32 bits and fr is the result re-extended
    // from the operation's width, so bit 31 is the narrow sign, fr == 0 the
    // narrow zero test, and unsigned order of the extended operands the
    // narrow one. add keeps its width-exact carry in fc.
    switch (kind) {
        case "cmp":
            return { ZF: `(fr == 0u)`, SF: `((int32_t)fr < 0)`, CF: `(fa < fb)`, SO: `((int32_t)fa < (int32_t)fb)`, PF: parity("fr") };
        case "add":
            return { ZF: `(fr == 0u)`, SF: `((int32_t)fr < 0)`, CF: `fc`,
                SO: `(((int32_t)fr < 0) != (((int32_t)((fa ^ fr) & (fb ^ fr))) < 0))`, PF: parity("fr") };
        case "logic":
            return { ZF: `(fr == 0u)`, SF: `((int32_t)fr < 0)`, CF: "0", SO: `((int32_t)fr < 0)`, PF: parity("fr") };
        // inc/dec: fa = operand, fr = result, fb = the width's minimum value
        // (sign-extended), so the overflow test is width-exact.
        case "inc":
            return { ZF: `(fr == 0u)`, SF: `((int32_t)fr < 0)`, CF: null, SO: `(((int32_t)fr < 0) != (fr == fb))`, PF: parity("fr") };
        case "dec":
            return { ZF: `(fr == 0u)`, SF: `((int32_t)fr < 0)`, CF: null, SO: `(((int32_t)fr < 0) != (fa == fb))`, PF: parity("fr") };
        // sahf: fa = AH. OF is untouched, so signed conditions decline.
        case "sahf":
            return { ZF: `((fa >> 6) & 1u)`, SF: `((fa >> 7) & 1u)`, CF: `(fa & 1u)`, SO: null, PF: `((fa >> 2) & 1u)` };
        // fcomi: fa = CF|PF|ZF of the compare; OF and SF are cleared, so
        // SF != OF is false.
        case "fcomi":
            return { ZF: `((fa >> 6) & 1u)`, SF: "0", CF: `(fa & 1u)`, SO: "0", PF: `((fa >> 2) & 1u)` };
        // raw: fa holds the materialised CF|PF|ZF|SF|OF bits (shifts, adc/sbb,
        // multiplies). runtime: no producer in this block; the flags are
        // whatever the last producer left (fk...) or, with fk = 0, v86's own.
        case "raw":
            return { ZF: `((fa >> 6) & 1u)`, SF: `((fa >> 7) & 1u)`, CF: `(fa & 1u)`, SO: `(((fa >> 7) & 1u) != ((fa >> 11) & 1u))`, PF: `((fa >> 2) & 1u)` };
        case "runtime":
            return { ZF: `((fl >> 6) & 1u)`, SF: `((fl >> 7) & 1u)`, CF: `(fl & 1u)`, SO: `(((fl >> 7) & 1u) != ((fl >> 11) & 1u))`, PF: `((fl >> 2) & 1u)` };
    }
}

function conditionExpr(cc: string, kind: ProducerKind): string | null {
    const { ZF, SF, CF, SO, PF } = flagExprs(kind);
    switch (cc) {
        case "e": case "z": return ZF;
        case "ne": case "nz": return `!${ZF}`;
        case "s": return SF;
        case "ns": return `!${SF}`;
        case "l": case "nge": return SO;
        case "ge": case "nl": return SO === null ? null : `!${SO}`;
        case "le": case "ng": return SO === null ? null : `(${ZF} || ${SO})`;
        case "g": case "nle": return SO === null ? null : `(!${ZF} && !${SO})`;
        case "p": case "pe": return PF;
        case "np": case "po": return PF === null ? null : `!${PF}`;
        case "o": return SO === null ? null : `(${SF} != ${SO})`;
        case "no": return SO === null ? null : `(${SF} == ${SO})`;
        case "b": case "nae": case "c": return CF;
        case "ae": case "nb": case "nc": return CF === null ? null : `!${CF}`;
        case "be": case "na": return CF === null ? null : `(${CF} || ${ZF})`;
        case "a": case "nbe": return CF === null ? null : `(!${CF} && !${ZF})`;
        default: return null;
    }
}

interface Block { start: number; insns: Insn[] }

/** Exit before instruction `insnAddr`, crediting the `done` instructions of
 *  the block that already ran; the host is told, then v86 resumes there. */
export function guardExit(insnAddr: number, done: number): string {
    return `cnt += ${done}u; ip = ${insnAddr >>> 0}u; guard_exit(ip); goto exit;`;
}

/** Exit before instruction `insnAddr` so the interpreter runs it: v86 is told
 *  to bypass this module once at that address, and the instruction after it
 *  is an entry, so the translation resumes right behind. */
export function slowExit(insnAddr: number, done: number): string {
    return `cnt += ${done}u; ip = ${insnAddr >>> 0}u; slow_exit(ip); goto exit;`;
}

/**
 * Guest RAM ends at MEM_SIZE; anything past it would trap the wasm module
 * instead of faulting the guest. The guard exits to the dispatcher at the
 * instruction's own address before it runs, with every earlier effect already
 * committed, so v86 raises the fault exactly where the guest would have.
 */
export function guardMem(lines: string[], op: Operand, insnAddr: number, done: number): void {
    if (op.kind !== "mem") return;
    lines.push(`a0 = ${op.addr}; if (a0 > ml - ${op.width}u) { ${guardExit(insnAddr, done)} }`);
    op.addr = "a0";
}

function splitOperands(operand: string): string[] {
    const out: string[] = [];
    let depth = 0, last = 0;
    for (let i = 0; i < operand.length; i++) {
        const c = operand[i];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === "," && depth === 0) { out.push(operand.slice(last, i)); last = i + 1; }
    }
    out.push(operand.slice(last));
    return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export const C_PRELUDE = `#include <stdint.h>
typedef uint32_t __attribute__((aligned(1))) u32u;
typedef uint16_t __attribute__((aligned(1))) u16u;
typedef uint64_t __attribute__((aligned(1))) u64u;
#define REG32 ((volatile int32_t *)64)
#define FLAGS (*(volatile int32_t *)120)
#define INSTRUCTION_POINTER ((volatile int32_t *)556)
#define PREVIOUS_IP ((volatile int32_t *)560)
#define INSTRUCTION_COUNTER ((volatile uint32_t *)664)
#define FSBASE ((uint32_t)*(volatile int32_t *)(736 + 4 * 4))
#define MEM_SIZE (*(volatile uint32_t *)812)
__attribute__((import_module("env"), import_name("mem_base"))) uint32_t mem_base(void);
__attribute__((import_module("env"), import_name("guard_exit"))) void guard_exit(uint32_t addr);
__attribute__((import_module("env"), import_name("slow_exit"))) void slow_exit(uint32_t addr);
__attribute__((import_module("env"), import_name("get_eflags"))) int32_t get_eflags(void);
__attribute__((import_module("env"), import_name("run_until"))) uint32_t run_until(uint32_t ret_eip, uint32_t stop_esp, uint32_t max);
/* The stub's out 0xB077, eax, performed by the translation itself. */
__attribute__((import_module("env"), import_name("hypercall_out"))) void hypercall_out(int32_t value);
/* rdtsc: v86's virtual time-stamp counter, with the instructions this
   translation has retired but not yet committed folded in, as the JIT does. */
__attribute__((import_module("env"), import_name("read_tsc"))) uint64_t read_tsc(int32_t pending);
#define FS_BASE (*(volatile int32_t *)752)
#define MXCSR (*(volatile int32_t *)824)
/* SSE state: v86 reg_xmm is 8 x 16 bytes at offset 832. Two 64-bit lanes each. */
#define XLO(i) (*(volatile u64u *)(uintptr_t)(832u + 16u*(uint32_t)(i)))
#define XHI(i) (*(volatile u64u *)(uintptr_t)(832u + 16u*(uint32_t)(i) + 8u))
/* Native call of a batch function by address (a compare tree over every entry);
   1 if it ran, 0 if the address is not in the batch. Defined by the batch. */
__attribute__((noinline)) int aot_dispatch(uint32_t target, uint32_t depth);
#define FLAGS_CHANGED_PTR (*(volatile int32_t *)100)
/* CF|PF|ZF|SF|OF of the last modelled producer, or v86's own flags when none ran. */
static inline uint32_t x86_flags_now(uint32_t fk, uint32_t fa, uint32_t fb, uint32_t fr, uint32_t fc) {
    uint32_t cf, zf, sf, of, pf;
    switch (fk) {
    case 0: return (uint32_t)get_eflags() & 0x8d5u;
    case 1: cf = fa < fb; zf = fr == 0u; sf = fr >> 31; of = ((fa ^ fb) & (fa ^ fr)) >> 31; break;
    case 2: cf = fc; zf = fr == 0u; sf = fr >> 31; of = ((fa ^ fr) & (fb ^ fr)) >> 31; break;
    case 3: cf = 0u; zf = fr == 0u; sf = fr >> 31; of = 0u; break;
    case 4: cf = fc; zf = fr == 0u; sf = fr >> 31; of = fr == fb; break;
    case 5: cf = fc; zf = fr == 0u; sf = fr >> 31; of = fa == fb; break;
    case 6: return ((uint32_t)FLAGS & 0x800u) | (fa & 0xd5u);
    default: return fa & 0x8d5u;
    }
    pf = (__builtin_parity(fr & 0xffu) == 0);
    return cf | (pf << 2) | (zf << 6) | (sf << 7) | (of << 11);
}

#define LD8(a)  ((uint32_t)*(volatile uint8_t *)(uintptr_t)(mb + (a)))
#define LD16(a) ((uint32_t)*(volatile u16u *)(uintptr_t)(mb + (a)))
#define LD32(a) (*(volatile u32u *)(uintptr_t)(mb + (a)))
#define ST8(a, v)  (*(volatile uint8_t *)(uintptr_t)(mb + (a)) = (uint8_t)(v))
#define ST16(a, v) (*(volatile u16u *)(uintptr_t)(mb + (a)) = (uint16_t)(v))
#define ST32(a, v) (*(volatile u32u *)(uintptr_t)(mb + (a)) = (uint32_t)(v))
#define LD64(a) (*(volatile u64u *)(uintptr_t)(mb + (a)))
#define ST64(a, v) (*(volatile u64u *)(uintptr_t)(mb + (a)) = (uint64_t)(v))
` + X87_PRELUDE;

/** Materialise the last modelled producer's flags into v86's EFLAGS at every
 *  exit (fk 0 = none ran since entry, so v86's copy is already right). */
const FLAGS_EPILOGUE =
    `    if (fk) { FLAGS = (int32_t)(((uint32_t)FLAGS & ~0x8d5u) | x86_flags_now(fk, fa, fb, fr, fc)); FLAGS_CHANGED = 0; }\n`;

/** Operand expression of a call/jmp target that is not a direct address. */
function indirectTargetExpr(operand: string): string | null {
    const op = parseOperand(operand);
    if (!op) return null;
    if (op.kind === "reg32") return REG32[op.index!]!;
    if (op.kind === "mem" && op.width === 4) return `LD32(${op.addr})`;
    return null;
}

function isFlagConsumer(m: string): boolean {
    return SETCC.test(m) || CMOVCC.test(m) || m === "adc" || m === "sbb" || COND_BRANCH.has(m);
}

/**
 * `extraEntries`: addresses the runtime is known to dispatch to (a recorded
 * hot profile). Any of them that is a block of this function becomes an
 * entry too, so a return into the function or a jump-table target lands in
 * the translation instead of handing the page back to the JIT.
 */
/** SSE2 integer/move/bitwise instructions the translator models directly on
 *  v86's XMM field (XLO/XHI lanes at 832). No rounding-mode dependence, so the
 *  packed-integer and bitwise forms are exact; loads/stores go through guest
 *  memory. Any XMM-register write marks the SSE/FPU context dirty, as v86 does,
 *  so a context switch saves it. */
const SSE2_INT = new Set([
    "movq", "movd", "movapd", "movaps", "movdqa", "movups", "movdqu",
    "psrlq", "psllq", "psubd", "paddd",
    "andpd", "andps", "orpd", "orps", "xorpd", "xorps",
    "pand", "pandn", "por", "pxor",
]);

interface Sse2Helpers {
    parseOperand: (t: string) => Operand | null;
    guardMem: (lines: string[], op: Operand, insnAddr: number, done: number) => void;
    guardExit: (insnAddr: number, done: number) => string;
}

/** SSE2 scalar/packed double arithmetic and compares. Bits reinterpret through
 *  f64u/u64d; NaN follows IEEE (a compare with a NaN is false, so lt/le/eq are
 *  false and neq/nlt/nle/unord are true). Packed touches both lanes, scalar the
 *  low lane only. Single-precision (ps/ss) is handled where needed. */
const SSE_FP_PRED: Record<string, (a: string, b: string) => string> = {
    eq: (a, b) => `(${a} == ${b})`, lt: (a, b) => `(${a} < ${b})`, le: (a, b) => `(${a} <= ${b})`,
    unord: (a, b) => `(${a} != ${a} || ${b} != ${b})`, neq: (a, b) => `!(${a} == ${b})`,
    nlt: (a, b) => `!(${a} < ${b})`, nle: (a, b) => `!(${a} <= ${b})`,
    ord: (a, b) => `!(${a} != ${a} || ${b} != ${b})`,
};
const SSE_FP_ARITH: Record<string, string> = { add: "+", sub: "-", mul: "*", div: "/" };

function emitSseFp(mnemonic: string, ops: string[], insn: Insn, i: number, lines: string[], h: Sse2Helpers): string | void | false {
    // Suffix pd/ps/sd/ss decides element type and lane count; the stem is an
    // arithmetic op or a cmpXX predicate. Returns false if not one of these.
    const m = /^(add|sub|mul|div|cmp([a-z]+))(pd|ps|sd|ss)$/.exec(mnemonic);
    if (!m) return false;
    const suffix = m[3]!;
    const isDouble = suffix === "pd" || suffix === "sd";
    const scalar = suffix === "sd" || suffix === "ss";
    if (!isDouble) return `unsupported: ${mnemonic}`; // ps/ss added when a target needs them
    const pred = m[2] ? SSE_FP_PRED[m[2]] : null;
    if (m[1]!.startsWith("cmp") && !pred) return `unsupported: ${mnemonic}`;
    const arith = !m[2] ? SSE_FP_ARITH[m[1]!] : null;

    const dOp = h.parseOperand(ops[0] ?? ""); const sOp = h.parseOperand(ops[1] ?? "");
    if (!dOp || dOp.kind !== "xmm" || !sOp) return `${mnemonic} ${ops.join(", ")}`;
    // Source double lanes (lane 0 low, lane 1 high) as C double expressions.
    let s0: string, s1: string;
    if (sOp.kind === "xmm") { s0 = `f64u(XLO(${sOp.index}))`; s1 = `f64u(XHI(${sOp.index}))`; }
    else if (sOp.kind === "mem") { h.guardMem(lines, sOp, insn.addr, i); s0 = `f64u(LD64(${sOp.addr}))`; s1 = `f64u(LD64((${sOp.addr}) + 8u))`; }
    else return `${mnemonic} ${ops.join(", ")}`;
    const d0 = `f64u(XLO(${dOp.index}))`, d1 = `f64u(XHI(${dOp.index}))`;
    const lane = (dv: string, sv: string): string =>
        pred ? `${pred(dv, sv)} ? ~(uint64_t)0 : (uint64_t)0` : `u64d(${dv} ${arith} ${sv})`;
    if (scalar) lines.push(`{ double da = ${d0}, sa = ${s0}; XLO(${dOp.index}) = ${lane("da", "sa")}; }`);
    else lines.push(`{ double da0 = ${d0}, da1 = ${d1}, sa0 = ${s0}, sa1 = ${s1}; XLO(${dOp.index}) = ${lane("da0", "sa0")}; XHI(${dOp.index}) = ${lane("da1", "sa1")}; }`);
    lines.push(`FPU_DIRTY = 1u;`);
    return;
}

function emitSse2(mnemonic: string, ops: string[], insn: Insn, i: number, lines: string[], h: Sse2Helpers): string | void {
    const dst = h.parseOperand(ops[0] ?? "");
    const src = h.parseOperand(ops[1] ?? "");
    if (!dst) return `operand: ${mnemonic} ${ops[0] ?? ""}`;
    // Bounds-check a memory operand once, leaving its address in a0.
    const guard = (op: Operand): string => { h.guardMem(lines, op, insn.addr, i); return op.addr!; };
    const dirty = () => lines.push(`FPU_DIRTY = 1u;`);

    if (mnemonic === "movd") {
        // 32-bit lane <-> GP register or memory. Writing an xmm zero-extends.
        if (dst.kind === "xmm" && src && src.kind === "reg32") { lines.push(`XLO(${dst.index}) = (uint32_t)${REG32[src.index!]}; XHI(${dst.index}) = 0u;`); dirty(); return; }
        if (dst.kind === "xmm" && src && src.kind === "mem") { const a = guard(src); lines.push(`XLO(${dst.index}) = LD32(${a}); XHI(${dst.index}) = 0u;`); dirty(); return; }
        if (dst.kind === "reg32" && src && src.kind === "xmm") { lines.push(`${REG32[dst.index!]} = (uint32_t)XLO(${src.index});`); return; }
        if (dst.kind === "mem" && src && src.kind === "xmm") { const a = guard(dst); lines.push(`ST32(${a}, (uint32_t)XLO(${src.index}));`); return; }
        return `movd ${ops.join(", ")}`;
    }
    if (mnemonic === "movq") {
        // Low 64 bits; writing an xmm from mem/xmm zero-extends the high lane.
        if (dst.kind === "xmm" && src && src.kind === "xmm") { lines.push(`XLO(${dst.index}) = XLO(${src.index}); XHI(${dst.index}) = 0u;`); dirty(); return; }
        if (dst.kind === "xmm" && src && src.kind === "mem") { const a = guard(src); lines.push(`XLO(${dst.index}) = LD64(${a}); XHI(${dst.index}) = 0u;`); dirty(); return; }
        if (dst.kind === "mem" && src && src.kind === "xmm") { const a = guard(dst); lines.push(`ST64(${a}, XLO(${src.index}));`); return; }
        return `movq ${ops.join(", ")}`;
    }
    // 128-bit move (aligned/unaligned/packed-double/packed-int all identical here).
    if (mnemonic === "movapd" || mnemonic === "movaps" || mnemonic === "movdqa" || mnemonic === "movups" || mnemonic === "movdqu") {
        if (dst.kind === "xmm" && src && src.kind === "xmm") { lines.push(`XLO(${dst.index}) = XLO(${src.index}); XHI(${dst.index}) = XHI(${src.index});`); dirty(); return; }
        if (dst.kind === "xmm" && src && src.kind === "mem") { const a = guard(src); lines.push(`XLO(${dst.index}) = LD64(${a}); XHI(${dst.index}) = LD64((${a}) + 8u);`); dirty(); return; }
        if (dst.kind === "mem" && src && src.kind === "xmm") { const a = guard(dst); lines.push(`ST64(${a}, XLO(${src.index})); ST64((${a}) + 8u, XHI(${src.index}));`); return; }
        return `${mnemonic} ${ops.join(", ")}`;
    }
    // Packed 64-bit lane shifts, by imm8 or by the low 64 bits of another xmm.
    if (mnemonic === "psrlq" || mnemonic === "psllq") {
        if (dst.kind !== "xmm" || !src) return `${mnemonic} ${ops.join(", ")}`;
        const op = mnemonic === "psrlq" ? ">>" : "<<";
        if (src.kind === "imm") {
            const sh = (src.value! & 0xff) >>> 0;
            if (sh > 63) lines.push(`XLO(${dst.index}) = 0u; XHI(${dst.index}) = 0u;`);
            else lines.push(`XLO(${dst.index}) = XLO(${dst.index}) ${op} ${sh}u; XHI(${dst.index}) = XHI(${dst.index}) ${op} ${sh}u;`);
            dirty(); return;
        }
        if (src.kind === "xmm") { lines.push(`{ uint64_t sh = XLO(${src.index}); if (sh > 63u) { XLO(${dst.index}) = 0u; XHI(${dst.index}) = 0u; } else { XLO(${dst.index}) = XLO(${dst.index}) ${op} sh; XHI(${dst.index}) = XHI(${dst.index}) ${op} sh; } }`); dirty(); return; }
        return `${mnemonic} ${ops.join(", ")}`;
    }
    // Packed 32-bit add/sub over the four dwords.
    if (mnemonic === "psubd" || mnemonic === "paddd") {
        if (dst.kind !== "xmm" || !src) return `${mnemonic} ${ops.join(", ")}`;
        const op = mnemonic === "psubd" ? "-" : "+";
        const sl = src.kind === "xmm" ? `XLO(${src.index})` : src.kind === "mem" ? `LD64(${guard(src)})` : null;
        if (sl === null) return `${mnemonic} ${ops.join(", ")}`;
        const sh = src.kind === "xmm" ? `XHI(${src.index})` : `LD64((a0) + 8u)`;
        lines.push(`{ uint64_t dl = XLO(${dst.index}), dh = XHI(${dst.index}), sl = ${sl}, sh = ${sh};`
            + ` uint32_t r0 = (uint32_t)dl ${op} (uint32_t)sl, r1 = (uint32_t)(dl >> 32) ${op} (uint32_t)(sl >> 32),`
            + ` r2 = (uint32_t)dh ${op} (uint32_t)sh, r3 = (uint32_t)(dh >> 32) ${op} (uint32_t)(sh >> 32);`
            + ` XLO(${dst.index}) = (uint64_t)r0 | ((uint64_t)r1 << 32); XHI(${dst.index}) = (uint64_t)r2 | ((uint64_t)r3 << 32); }`);
        dirty(); return;
    }
    // 128-bit bitwise. pandn is (~dst) & src.
    if (dst.kind !== "xmm" || !src) return `${mnemonic} ${ops.join(", ")}`;
    const bit: Record<string, string> = { andpd: "&", andps: "&", pand: "&", orpd: "|", orps: "|", por: "|", xorpd: "^", xorps: "^", pxor: "^" };
    if (mnemonic === "pandn") {
        const sl = src.kind === "xmm" ? `XLO(${src.index})` : src.kind === "mem" ? `LD64(${guard(src)})` : null;
        if (sl === null) return `pandn ${ops.join(", ")}`;
        const sh = src.kind === "xmm" ? `XHI(${src.index})` : `LD64((a0) + 8u)`;
        lines.push(`{ uint64_t sl = ${sl}, sh = ${sh}; XLO(${dst.index}) = (~XLO(${dst.index})) & sl; XHI(${dst.index}) = (~XHI(${dst.index})) & sh; }`);
        dirty(); return;
    }
    const b = bit[mnemonic];
    if (!b) return `unsupported: ${mnemonic}`;
    if (src.kind === "xmm") { lines.push(`XLO(${dst.index}) = XLO(${dst.index}) ${b} XLO(${src.index}); XHI(${dst.index}) = XHI(${dst.index}) ${b} XHI(${src.index});`); dirty(); return; }
    if (src.kind === "mem") { const a = guard(src); lines.push(`XLO(${dst.index}) = XLO(${dst.index}) ${b} LD64(${a}); XHI(${dst.index}) = XHI(${dst.index}) ${b} LD64((${a}) + 8u);`); dirty(); return; }
    return `${mnemonic} ${ops.join(", ")}`;
}

export async function translateFunctionC(decoder: CapstoneDecoder, entry: number, extraEntries?: Set<number>, sameImage?: (addr: number) => boolean): Promise<CFunction | null> {
    // A direct jump whose target lives in another image than the entry (an EXE
    // function tail-calling a THUNK_CODE leaf, a DLL leaf) is a tail call, not a
    // block of this function: it exits to the dispatcher. Default: one image.
    const inImage = sameImage ?? (() => true);
    lastRejection = "";
    // Every block decodes from its own leader; a sequential read continues
    // that window, so the same address always yields the same instruction.
    const reader = new BlockReader(decoder);
    const at = (pc: number): Promise<Insn | null> => reader.at(pc);

    const first = await at(entry);
    if (!first) return reject(`no instruction at 0x${entry.toString(16)}`);
    if (first.mnemonic === "int3") return reject("entry is padding");

    const leaders = new Set<number>([entry]);
    const resumes = new Set<number>();
    {
        const walked = new Set<number>();
        const work = [entry];
        while (work.length > 0) {
            let pc = work.pop()!;
            for (;;) {
                if (walked.has(pc)) break;
                walked.add(pc);
                const insn = await at(pc);
                if (!insn) return reject(`no instruction at 0x${pc.toString(16)}`);
                if (walked.size > SIZE_BUDGET) return reject("function exceeds size budget");
                const { mnemonic, operand } = insn;
                if (mnemonic === "ret" || mnemonic === "retn") break;
                if (mnemonic === "call") {
                    const after = pc + insn.size;
                    leaders.add(after); resumes.add(after); work.push(after);
                    break;
                }
                // An x87 instruction the translation hands to the interpreter
                // ends its block: the dispatcher resumes right behind it.
                if (x87Kind(mnemonic, operand) === "slow") {
                    const after = pc + insn.size;
                    leaders.add(after); resumes.add(after); work.push(after);
                    break;
                }
                // A port write performed in place may hand the guest to the
                // dispatcher, or to the interpreter for another port: the
                // instruction behind it is where the translation resumes.
                if (mnemonic === "out") {
                    const after = pc + insn.size;
                    leaders.add(after); resumes.add(after); work.push(after);
                    break;
                }
                if (mnemonic === "jmp") {
                    const t = directTarget(operand);
                    if (t === null || !inImage(t)) break;
                    leaders.add(t); work.push(t); break;
                }
                if (COND_BRANCH.has(mnemonic)) {
                    const t = directTarget(operand);
                    if (t === null) return reject(`indirect ${mnemonic}`);
                    leaders.add(pc + insn.size); work.push(pc + insn.size);
                    if (inImage(t)) { leaders.add(t); work.push(t); }
                    break;
                }
                pc += insn.size;
            }
        }
    }

    const blocks = new Map<number, Block>();
    let maxEnd = entry;
    for (const start of leaders) {
        const body: Insn[] = [];
        let pc = start;
        for (;;) {
            const insn = await at(pc);
            if (!insn) return reject(`no instruction at 0x${pc.toString(16)}`);
            body.push(insn);
            pc += insn.size;
            if (pc > maxEnd) maxEnd = pc;
            const m = insn.mnemonic;
            if (m === "ret" || m === "retn" || m === "jmp" || m === "call" || COND_BRANCH.has(m)) break;
            if (x87Kind(m, insn.operand) === "slow") break;
            if (leaders.has(pc)) break;
        }
        blocks.set(start, { start, insns: body });
    }

    const order = [...blocks.keys()].sort((a, b) => a - b);
    const indexOf = new Map<number, number>();
    order.forEach((a, i) => indexOf.set(a, i));

    const out: string[] = [];
    let liveFlagSites = 0;
    let total = 0;
    let calls = 0;
    const callTargets: number[] = [];
    // Decided before emission: a call site emitted before the function's first
    // x87 instruction must already save and reload TOP/EMPTY around the call,
    // or a callee that returns a value on the x87 stack leaves the local stack
    // pointer stale (and every fst/fstp after it reads the wrong slot).
    let fpuUsed = order.some((start) => blocks.get(start)!.insns.some((insn) => x87Kind(insn.mnemonic, insn.operand) === "fast"));
    const x87Helpers = { parseOperand, readExpr, guardMem, guardExit, slowExit };
    const loads = REG32.map((r, i) => `uint32_t ${r} = (uint32_t)REG32[${i}];`).join(" ");
    const reloads = REG32.map((r, i) => `${r} = (uint32_t)REG32[${i}];`).join(" ");
    const stores = REG32.map((r, i) => `REG32[${i}] = (int32_t)${r};`).join(" ");
    let nativeCalls = 0;

    for (const start of order) {
        const block = blocks.get(start)!;
        total += block.insns.length;
        const lines: string[] = [];
        const n = block.insns.length;
        const term = block.insns[n - 1]!;

        // Each consumer's producer: the last flag writer before it, which must
        // be modelled. Every modelled producer keeps its operands in fa/fb/fr
        // and its kind in fk, so any exit can materialise the flags v86 would
        // hold; `captured` only counts the consumers.
        const producerOf = new Map<number, number>();
        const captured = new Set<number>();
        for (let i = 0; i < n; i++) {
            if (!isFlagConsumer(block.insns[i]!.mnemonic)) continue;
            let p = -1;
            for (let j = i - 1; j >= 0; j--) {
                const m = block.insns[j]!.mnemonic;
                if (FLAG_PRODUCER.has(m)) { p = j; break; }
                if (!preservesFlags(m) && !SETCC.test(m) && !CMOVCC.test(m)) {
                    return reject(`${block.insns[i]!.mnemonic} after unmodelled flag writer ${m}`);
                }
            }
            // No producer in this block: the flags are read at run time from
            // the last producer of this invocation, or from v86 when none ran.
            producerOf.set(i, p);
            if (p >= 0) captured.add(p);
        }
        const kinds = new Map<number, ProducerKind>();
        const runtimeFlags = (i: number, lines: string[]): void => {
            if (producerOf.get(i) === -1) lines.push(`fl = x86_flags_now(fk, fa, fb, fr, fc);`);
        };
        const condFor = (i: number, cc: string): string | null => {
            const p = producerOf.get(i)!;
            const kind = p === -1 ? "runtime" : kinds.get(p);
            return kind ? conditionExpr(cc, kind) : null;
        };
        const carryFor = (i: number): string | null => {
            const p = producerOf.get(i)!;
            const kind = p === -1 ? "runtime" : kinds.get(p);
            return kind ? flagExprs(kind).CF : null;
        };
        const producerName = (i: number): string => { const p = producerOf.get(i)!; return p === -1 ? "(runtime flags)" : block.insns[p]!.mnemonic; };

        for (let i = 0; i < n; i++) {
            const insn = block.insns[i]!;
            const { mnemonic, operand } = insn;
            const isCaptured = captured.has(i);

            if (mnemonic === "ret" || mnemonic === "retn" || mnemonic === "call") break;
            if (mnemonic === "jmp" || COND_BRANCH.has(mnemonic)) break;
            if (mnemonic === "nop" || mnemonic === "wait" || mnemonic === "fwait") continue;
            if (mnemonic === "int3") return reject("int3 inside function");
            const xk = x87Kind(mnemonic, operand);
            if (xk === "slow") break;
            if (mnemonic === "sahf") {
                lines.push(`fa = (eax >> 8) & 0xffu; fk = 6u;`);
                kinds.set(i, "sahf");
                if (isCaptured) liveFlagSites++;
                continue;
            }
            if (xk === "fast") {
                const r = emitX87(x87Helpers, mnemonic, splitOperands(operand), insn, i, lines);
                if (typeof r === "string") return reject(r);
                fpuUsed = true;
                if (r.producer) { kinds.set(i, "fcomi"); lines.push(`fk = 0u;`); if (isCaptured) liveFlagSites++; }
                continue;
            }
            if (mnemonic === "pushfd") {
                // The word pushed carries the last modelled producer's
                // arithmetic flags (v86's own when none ran) over v86's other
                // bits; an unmodelled writer in between cannot be materialised.
                for (let j = i - 1; j >= 0; j--) {
                    const m = block.insns[j]!.mnemonic;
                    if (FLAG_PRODUCER.has(m)) break;
                    if (!preservesFlags(m) && !SETCC.test(m) && !CMOVCC.test(m)) return reject(`pushfd after unmodelled flag writer ${m}`);
                }
                lines.push(`if (esp - 4u > ml - 4u) { ${guardExit(insn.addr, i)} }`, `esp -= 4u;`, `ST32(esp, ((uint32_t)FLAGS & ~0x8d5u) | x86_flags_now(fk, fa, fb, fr, fc));`);
                continue;
            }
            if (mnemonic === "popfd") {
                // A change of IF or TF is privileged and traps: the interpreter
                // runs that pop. Otherwise DF, NT, AC and ID are written as v86
                // does in ring 0, and the arithmetic bits become the producer
                // of what follows.
                lines.push(`if (esp > ml - 4u) { ${guardExit(insn.addr, i)} }`);
                lines.push(`{ uint32_t v = LD32(esp); if (((v ^ (uint32_t)FLAGS) & 0x300u) != 0u) { ${slowExit(insn.addr, i)} }`);
                lines.push(`  esp += 4u; FLAGS = (int32_t)(((uint32_t)FLAGS & ~0x244400u) | (v & 0x244400u)); fa = v & 0x8d5u; fk = 8u; }`);
                kinds.set(i, "raw");
                if (isCaptured) liveFlagSites++;
                continue;
            }
            if (OTHER_FLAG_READER.test(mnemonic) && !SETCC.test(mnemonic) && !CMOVCC.test(mnemonic)) return reject(`reads flags: ${mnemonic}`);
            if (mnemonic === "leave") { lines.push(`if (ebp > ml - 4u) { ${guardExit(insn.addr, i)} }`, `esp = ebp;`, `ebp = LD32(esp);`, `esp += 4u;`); continue; }
            if (mnemonic === "cdq") { lines.push(`edx = ((int32_t)eax < 0) ? 0xffffffffu : 0u;`); continue; }
            if (mnemonic === "rdtsc") { lines.push(`{ uint64_t ts = read_tsc((int32_t)(cnt + ${i}u)); eax = (uint32_t)ts; edx = (uint32_t)(ts >> 32); }`); continue; }
            if (mnemonic === "cwde") { lines.push(`eax = (uint32_t)(int32_t)(int16_t)eax;`); continue; }
            if (mnemonic === "cbw") { lines.push(`eax = (eax & ~0xffffu) | ((uint32_t)(int32_t)(int8_t)eax & 0xffffu);`); continue; }

            const ops = splitOperands(operand);
            const dstText = ops[0] ?? "";
            const srcText = ops[1] ?? null;

            if (mnemonic === "enter") {
                const size = Number(ops[0]), level = Number(ops[1] ?? "0");
                if (!Number.isFinite(size) || level !== 0) return reject(`enter ${operand}`);
                lines.push(`if (esp - 4u > ml - 4u) { ${guardExit(insn.addr, i)} }`, `esp -= 4u;`, `ST32(esp, ebp);`, `ebp = esp;`, `esp -= ${size >>> 0}u;`);
                continue;
            }
            if (mnemonic === "stmxcsr" || mnemonic === "ldmxcsr") {
                // MXCSR round-trips through v86's field (offset 824). The
                // relaxed SSE path computes in round-to-nearest, so a guest that
                // saves and restores the default control word matches; a leaf
                // that only stores or reloads it (CRT _controlfp, _ftol setup)
                // is exact.
                const m = parseOperand(ops[0] ?? "");
                if (!m || m.kind !== "mem") return reject(`${mnemonic} ${operand}`);
                guardMem(lines, m, insn.addr, i);
                // ldmxcsr changes SSE state: mark the FPU/SSE context dirty
                // so a context switch saves the new MXCSR, as v86 does.
                lines.push(mnemonic === "stmxcsr" ? `ST32(${m.addr}, MXCSR);` : `MXCSR = (int32_t)LD32(${m.addr}); FPU_DIRTY = 1u;`);
                continue;
            }
            {
                const r = emitSseFp(mnemonic, ops, insn, i, lines, { parseOperand, guardMem, guardExit });
                if (typeof r === "string") return reject(r);
                if (r !== false) continue;
            }
            if (SSE2_INT.has(mnemonic)) {
                const r = emitSse2(mnemonic, ops, insn, i, lines, { parseOperand, guardMem, guardExit });
                if (typeof r === "string") return reject(r);
                continue;
            }
            if (mnemonic === "ucomisd" || mnemonic === "comisd" || mnemonic === "ucomiss" || mnemonic === "comiss") {
                // Scalar FP compare into CF/PF/ZF, with OF/SF/AF cleared, exactly
                // as x87 fcomi: unordered sets CF|PF|ZF, else CF=below, ZF=equal.
                const single = mnemonic.endsWith("ss");
                const dOp = parseOperand(ops[0] ?? ""); const sOp = parseOperand(ops[1] ?? "");
                if (!dOp || dOp.kind !== "xmm" || !sOp) return reject(`${mnemonic} ${operand}`);
                const av = single ? `(double)f32u((uint32_t)XLO(${dOp.index}))` : `f64u(XLO(${dOp.index}))`;
                let bv: string;
                if (sOp.kind === "xmm") bv = single ? `(double)f32u((uint32_t)XLO(${sOp.index}))` : `f64u(XLO(${sOp.index}))`;
                else if (sOp.kind === "mem") { guardMem(lines, sOp, insn.addr, i); bv = single ? `(double)f32u(LD32(${sOp.addr}))` : `f64u(LD64(${sOp.addr}))`; }
                else return reject(`${mnemonic} ${operand}`);
                lines.push(`{ double a = ${av}, b = ${bv}; fa = (a != a || b != b) ? 0x45u : (a < b ? 0x01u : (a == b ? 0x40u : 0x00u)); FLAGS = (int32_t)(((uint32_t)FLAGS & ~0x8d5u) | fa); FLAGS_CHANGED = 0; }`);
                lines.push(`fk = 0u;`);
                kinds.set(i, "fcomi");
                if (isCaptured) liveFlagSites++;
                continue;
            }

            if (mnemonic === "out") {
                // out dx, eax to Orthros's hypercall port is performed in place,
                // as a stub's is; any other port is the interpreter's. The
                // handler may switch threads, park or redirect the thread: EIP
                // or the FS base then differs and the dispatcher takes over with
                // the state already committed. Nothing is assumed about the
                // flags or registers it leaves.
                if (dstText !== "dx" || srcText !== "eax") return reject(`unsupported: out ${operand}`);
                nativeCalls++;
                const next = (insn.addr + insn.size) >>> 0;
                const fpuOut = fpuUsed ? `if (fdirty) { FPU_TOP = (uint8_t)top; FPU_EMPTY = (uint8_t)fempty; FPU_DIRTY = 1u; fdirty = 0u; } ` : "";
                const fpuIn = fpuUsed ? ` top = FPU_TOP; fempty = FPU_EMPTY;` : "";
                lines.push(`if ((edx & 0xffffu) != 0xB077u) { ${slowExit(insn.addr, i)} }`);
                lines.push(`${stores} ${fpuOut}if (fk) { FLAGS = (int32_t)(((uint32_t)FLAGS & ~0x8d5u) | x86_flags_now(fk, fa, fb, fr, fc)); FLAGS_CHANGED = 0; fk = 0u; }`);
                lines.push(`*INSTRUCTION_COUNTER += cnt + ${i + 1}u; cnt = 0u; *PREVIOUS_IP = (int32_t)${insn.addr >>> 0}u; *INSTRUCTION_POINTER = (int32_t)${next}u;`);
                lines.push(`{ int32_t fs0 = FS_BASE; hypercall_out((int32_t)eax); if (FS_BASE != fs0 || (uint32_t)*INSTRUCTION_POINTER != ${next}u) goto exit_foreign; }`);
                lines.push(`${reloads}${fpuIn} fk = 0u; cnt = 0u - ${i + 1}u;`);
                continue;
            }

            if (mnemonic.startsWith("repe cmps")) {
                // repe cmps: compares until a mismatch or ECX = 0; the flags are
                // those of the last pair compared. With ECX = 0 nothing is
                // compared and the flags stay as they were, which this model
                // cannot express: the interpreter runs that case.
                const elem = mnemonic.endsWith("d") ? 4 : mnemonic.endsWith("w") ? 2 : 1;
                const ld = elem === 4 ? "LD32" : elem === 2 ? "LD16" : "LD8";
                for (let j = i - 1; j >= 0; j--) {
                    const m = block.insns[j]!.mnemonic;
                    if (FLAG_PRODUCER.has(m)) break;
                    if (!preservesFlags(m) && !SETCC.test(m) && !CMOVCC.test(m)) return reject(`${mnemonic} after unmodelled flag writer ${m}`);
                }
                lines.push(`if (FLAGS & 0x400) { ${guardExit(insn.addr, i)} }`);
                lines.push(`if (ecx == 0u) { ${slowExit(insn.addr, i)} }`);
                lines.push(`if ((uint64_t)esi + (uint64_t)ecx * ${elem}u > ml || (uint64_t)edi + (uint64_t)ecx * ${elem}u > ml) { ${guardExit(insn.addr, i)} }`);
                lines.push(`for (;;) { fa = ${sext(`${ld}(esi)`, elem)}; fb = ${sext(`${ld}(edi)`, elem)}; esi += ${elem}u; edi += ${elem}u; ecx -= 1u; if (fa != fb || ecx == 0u) break; }`, `fr = ${sext("(fa - fb)", elem)}; fk = 1u;`);
                kinds.set(i, "cmp");
                if (isCaptured) liveFlagSites++;
                continue;
            }
            if (mnemonic.startsWith("rep ")) {
                // rep movs/stos: forward only (DF set exits to v86), whole range
                // guarded up front so the guest faults before any element moves.
                const op = mnemonic.slice(4);
                const elem = op.endsWith("d") ? 4 : op.endsWith("w") ? 2 : op.endsWith("b") ? 1 : 0;
                if (elem === 0 || (!op.startsWith("movs") && !op.startsWith("stos"))) return reject(`unsupported: ${mnemonic}`);
                const ld = elem === 4 ? "LD32" : elem === 2 ? "LD16" : "LD8";
                const st = elem === 4 ? "ST32" : elem === 2 ? "ST16" : "ST8";
                lines.push(`if (FLAGS & 0x400) { ${guardExit(insn.addr, i)} }`);
                if (op.startsWith("movs")) {
                    lines.push(`if ((uint64_t)esi + (uint64_t)ecx * ${elem}u > ml || (uint64_t)edi + (uint64_t)ecx * ${elem}u > ml) { ${guardExit(insn.addr, i)} }`);
                    lines.push(`while (ecx != 0u) { ${st}(edi, ${ld}(esi)); esi += ${elem}u; edi += ${elem}u; ecx -= 1u; }`);
                } else {
                    const src = elem === 4 ? "eax" : elem === 2 ? "(eax & 0xffffu)" : "(eax & 0xffu)";
                    lines.push(`if ((uint64_t)edi + (uint64_t)ecx * ${elem}u > ml) { ${guardExit(insn.addr, i)} }`);
                    lines.push(`while (ecx != 0u) { ${st}(edi, ${src}); edi += ${elem}u; ecx -= 1u; }`);
                }
                continue;
            }

            if (mnemonic === "cmp" || mnemonic === "test") {
                if (!srcText) return reject(`${mnemonic} missing source`);
                const a = parseOperand(dstText), b = parseOperand(srcText);
                if (!a || !b) return reject(`operand: ${mnemonic} ${operand}`);
                guardMem(lines, a, insn.addr, i); guardMem(lines, b, insn.addr, i);
                const ra = readExpr(a), rb = readExpr(b);
                if (ra === null || rb === null) return reject(`read: ${mnemonic}`);
                const w = operandWidth(a);
                if (mnemonic === "cmp") {
                    lines.push(`fa = ${sext(ra, w)}; fb = ${sext(`(${rb} & ${widthMask(w)})`, w)}; fr = ${sext("(fa - fb)", w)}; fk = 1u;`);
                    kinds.set(i, "cmp");
                } else {
                    lines.push(`fr = ${sext(`(${ra} & ${rb})`, w)}; fk = 3u;`);
                    kinds.set(i, "logic");
                }
                if (isCaptured) liveFlagSites++;
                continue;
            }

            const dst = parseOperand(dstText);
            if (!dst) return reject(`operand: ${mnemonic} ${dstText}`);

            if (SETCC.test(mnemonic)) {
                runtimeFlags(i, lines);
                const cond = condFor(i, mnemonic.slice(3));
                if (cond === null) return reject(`${mnemonic} after ${producerName(i)}`);
                if (operandWidth(dst) !== 1) return reject(`${mnemonic} ${dstText}`);
                guardMem(lines, dst, insn.addr, i);
                const w = writeStmt(dst, `${cond} ? 1u : 0u`);
                if (!w) return reject(`write: ${mnemonic}`);
                lines.push(w);
                continue;
            }
            if (CMOVCC.test(mnemonic)) {
                if (!srcText) return reject(`${mnemonic} missing source`);
                runtimeFlags(i, lines);
                const cond = condFor(i, mnemonic.slice(4));
                if (cond === null) return reject(`${mnemonic} after ${producerName(i)}`);
                const src = parseOperand(srcText);
                if (!src || (dst.kind !== "reg32" && dst.kind !== "reg16")) return reject(`${mnemonic} ${operand}`);
                // The source is read whether or not the move happens.
                guardMem(lines, src, insn.addr, i);
                const v = readExpr(src);
                if (v === null) return reject(`read: ${mnemonic}`);
                const w = writeStmt(dst, v);
                if (!w) return reject(`write: ${mnemonic}`);
                lines.push(`if (${cond}) { ${w} }`);
                continue;
            }
            if (mnemonic === "adc" || mnemonic === "sbb") {
                if (!srcText) return reject(`${mnemonic} missing source`);
                runtimeFlags(i, lines);
                const cf = carryFor(i);
                if (cf === null) return reject(`${mnemonic} after ${producerName(i)}`);
                const src = parseOperand(srcText);
                if (!src) return reject(`operand: ${mnemonic} ${srcText}`);
                const w = operandWidth(dst);
                guardMem(lines, dst, insn.addr, i); guardMem(lines, src, insn.addr, i);
                const a = readExpr(dst), b = readExpr(src);
                if (a === null || b === null) return reject(`read: ${mnemonic}`);
                const M = widthMask(w);
                // Carry-in is read before anything is written; the width-exact
                // carry-out and overflow come from the zero- and sign-extended
                // operands, the rest from the re-extended result.
                if (mnemonic === "adc") {
                    lines.push(`{ uint32_t ci = (uint32_t)${cf}; uint32_t az = ${a} & ${M}, bz = ${b} & ${M}; uint64_t t = (uint64_t)az + bz + ci; fa = ${sext("(uint32_t)az", w)}; fb = ${sext("bz", w)}; fr = ${sext("(uint32_t)t", w)}; uint32_t cfo = (uint32_t)(t >> ${8 * w}) & 1u; uint32_t of = ((fa ^ fr) & (fb ^ fr)) >> 31; fa = cfo | ((__builtin_parity(fr & 0xffu) == 0) << 2) | ((fr == 0u) << 6) | ((fr >> 31) << 7) | (of << 11); fk = 8u; ${writeStmt(dst, "fr")} }`);
                } else {
                    lines.push(`{ uint32_t ci = (uint32_t)${cf}; uint32_t az = ${a} & ${M}, bz = ${b} & ${M}; fa = ${sext("az", w)}; fb = ${sext("bz", w)}; fr = ${sext("(az - bz - ci)", w)}; uint32_t cfo = ((uint64_t)az < (uint64_t)bz + ci); uint32_t of = ((fa ^ fb) & (fa ^ fr)) >> 31; fa = cfo | ((__builtin_parity(fr & 0xffu) == 0) << 2) | ((fr == 0u) << 6) | ((fr >> 31) << 7) | (of << 11); fk = 8u; ${writeStmt(dst, "fr")} }`);
                }
                kinds.set(i, "raw");
                if (isCaptured) liveFlagSites++;
                continue;
            }

            if (mnemonic === "push") {
                if (dst.kind === "reg16" || dst.kind === "reg8lo" || dst.kind === "reg8hi") return reject("push of a sub-register");
                if (dst.kind === "mem" && dst.width !== 4) return reject("push of a narrow memory operand");
                guardMem(lines, dst, insn.addr, i);
                const v = readExpr(dst);
                if (v === null) return reject(`read: push ${dstText}`);
                lines.push(`if (esp - 4u > ml - 4u) { ${guardExit(insn.addr, i)} }`, `esp -= 4u;`, `ST32(esp, ${v});`);
                continue;
            }
            if (mnemonic === "pop") {
                if (dst.kind === "mem" && dst.addr!.includes("esp")) return reject("pop into esp-relative memory");
                if (dst.kind !== "reg32" && !(dst.kind === "mem" && dst.width === 4)) return reject(`pop ${dstText}`);
                lines.push(`if (esp > ml - 4u) { ${guardExit(insn.addr, i)} }`);
                guardMem(lines, dst, insn.addr, i);
                const w = writeStmt(dst, `LD32(esp)`);
                if (!w) return reject(`write: pop ${dstText}`);
                lines.push(w, `esp += 4u;`);
                continue;
            }
            if (mnemonic === "bt" || mnemonic === "bts" || mnemonic === "btr" || mnemonic === "btc") {
                // CF takes the selected bit; the other arithmetic flags are
                // undefined and keep the previous producer's values, as the
                // hardware leaves them. A register bit offset on memory selects
                // the dword at addr + 4 * floor(offset / 32).
                if (!srcText) return reject(`${mnemonic} missing source`);
                const src = parseOperand(srcText);
                if (!src || (src.kind !== "reg32" && src.kind !== "imm")) return reject(`${mnemonic} ${operand}`);
                if (dst.kind !== "reg32" && !(dst.kind === "mem" && dst.width === 4)) return reject(`${mnemonic} ${dstText}`);
                const bit = src.kind === "imm" ? `${(src.value! & 31) >>> 0}u` : `(${REG32[src.index!]} & 31u)`;
                const update = mnemonic === "bts" ? "v | m" : mnemonic === "btr" ? "v & ~m" : mnemonic === "btc" ? "v ^ m" : null;
                const carry = `fa = (x86_flags_now(fk, fa, fb, fr, fc) & ~1u) | ((v >> ${bit}) & 1u); fk = 8u;`;
                if (dst.kind === "mem") {
                    const off = src.kind === "imm" ? "" : ` + (uint32_t)(((int32_t)${REG32[src.index!]} >> 5) << 2)`;
                    lines.push(`a0 = ${dst.addr}${off}; if (a0 > ml - 4u) { ${guardExit(insn.addr, i)} }`);
                    lines.push(`{ uint32_t v = LD32(a0), m = 1u << ${bit}; ${carry}${update ? ` ST32(a0, ${update});` : ""} }`);
                } else {
                    const r = REG32[dst.index!];
                    lines.push(`{ uint32_t v = ${r}, m = 1u << ${bit}; ${carry}${update ? ` ${r} = ${update};` : ""} }`);
                }
                kinds.set(i, "raw");
                if (isCaptured) liveFlagSites++;
                continue;
            }
            if (mnemonic === "xchg") {
                if (!srcText) return reject("xchg missing source");
                const src = parseOperand(srcText);
                if (!src || dst.kind !== "reg32" || src.kind !== "reg32") return reject(`xchg ${operand}`);
                lines.push(`{ uint32_t t = ${REG32[dst.index!]}; ${REG32[dst.index!]} = ${REG32[src.index!]}; ${REG32[src.index!]} = t; }`);
                continue;
            }
            if (mnemonic === "mul" || mnemonic === "div" || mnemonic === "idiv" || (mnemonic === "imul" && ops.length === 1)) {
                if (srcText) return reject(`${mnemonic} ${operand}`);
                if (operandWidth(dst) !== 4) return reject(`${mnemonic} on a sub-register`);
                guardMem(lines, dst, insn.addr, i);
                const s = readExpr(dst);
                if (s === null) return reject(`read: ${mnemonic}`);
                if (mnemonic === "mul") {
                    // CF = OF = high half non-zero; ZF/SF/PF from the low half.
                    lines.push(`{ uint64_t p = (uint64_t)eax * (uint64_t)(${s}); eax = (uint32_t)p; edx = (uint32_t)(p >> 32); uint32_t o = edx != 0u; fa = o | (o << 11) | ((__builtin_parity(eax & 0xffu) == 0) << 2) | ((eax == 0u) << 6) | ((eax >> 31) << 7); fk = 8u; }`);
                    kinds.set(i, "raw");
                } else if (mnemonic === "imul") {
                    lines.push(`{ int64_t p = (int64_t)(int32_t)eax * (int64_t)(int32_t)(${s}); eax = (uint32_t)p; edx = (uint32_t)((uint64_t)p >> 32); uint32_t o = p != (int64_t)(int32_t)eax; fa = o | (o << 11) | ((__builtin_parity(eax & 0xffu) == 0) << 2) | ((eax == 0u) << 6) | ((eax >> 31) << 7); fk = 8u; }`);
                    kinds.set(i, "raw");
                } else if (mnemonic === "div") {
                    lines.push(`{ uint32_t d = ${s}; uint64_t num = ((uint64_t)edx << 32) | eax; if (d == 0u || num / d > 0xffffffffull) { ${guardExit(insn.addr, i)} } eax = (uint32_t)(num / d); edx = (uint32_t)(num % d); }`);
                } else {
                    lines.push(`{ int32_t d = (int32_t)(${s}); int64_t num = (int64_t)(((uint64_t)edx << 32) | eax); if (d == 0 || (num == INT64_MIN && d == -1)) { ${guardExit(insn.addr, i)} } int64_t q = num / d; if (q != (int64_t)(int32_t)q) { ${guardExit(insn.addr, i)} } eax = (uint32_t)(int32_t)q; edx = (uint32_t)(int32_t)(num % d); }`);
                }
                continue;
            }

            let resultExpr: string | null = null;
            guardMem(lines, dst, insn.addr, i);

            if (mnemonic === "mov" || mnemonic === "movzx") {
                if (!srcText) return reject(`${mnemonic} missing source`);
                const src = parseOperand(srcText);
                if (!src) return reject(`operand: ${mnemonic} ${srcText}`);
                guardMem(lines, src, insn.addr, i);
                resultExpr = readExpr(src);
            }
            else if (mnemonic === "movsx") {
                if (!srcText) return reject("movsx missing source");
                const src = parseOperand(srcText);
                if (!src || src.kind === "imm") return reject(`operand: movsx ${srcText}`);
                guardMem(lines, src, insn.addr, i);
                const raw = readExpr(src);
                if (raw === null) return reject("read: movsx");
                const bits = src.kind === "reg16" || src.width === 2 ? 16 : 8;
                resultExpr = `((uint32_t)(int32_t)(int${bits}_t)(${raw}))`;
            }
            else if (mnemonic === "lea") {
                if (!srcText) return reject("lea missing source");
                const m = /^(?:BYTE|WORD|DWORD|QWORD)?\s*(?:PTR)?\s*(?:([a-z]{2}):)?\[(.+)\]$/i.exec(srcText.trim());
                if (!m) return reject(`lea form: ${srcText}`);
                if (m[1]) return reject("lea with segment");
                resultExpr = parseAddress(m[2]!, null);
            }
            else if (mnemonic === "imul" && ops.length === 3) {
                const src = parseOperand(ops[1]!), imm = parseOperand(ops[2]!);
                if (!src || !imm || imm.kind !== "imm" || dst.kind !== "reg32") return reject(`imul ${operand}`);
                guardMem(lines, src, insn.addr, i);
                const b = readExpr(src);
                if (b === null) return reject("read: imul");
                lines.push(`{ int64_t p = (int64_t)(int32_t)(${b}) * (int64_t)${imm.value! | 0}; fr = (uint32_t)p; uint32_t o = p != (int64_t)(int32_t)fr; fa = o | (o << 11) | ((__builtin_parity(fr & 0xffu) == 0) << 2) | ((fr == 0u) << 6) | ((fr >> 31) << 7); fk = 8u; }`);
                kinds.set(i, "raw");
                if (isCaptured) liveFlagSites++;
                resultExpr = "fr";
            }
            else if (BINARY[mnemonic]) {
                if (!srcText) return reject(`${mnemonic} missing source`);
                const src = parseOperand(srcText);
                if (!src) return reject(`operand: ${mnemonic} ${srcText}`);
                guardMem(lines, src, insn.addr, i);
                const a = readExpr(dst), b = readExpr(src);
                if (a === null || b === null) return reject(`read: ${mnemonic}`);
                const w = operandWidth(dst);
                if (mnemonic === "imul" && w !== 4) return reject(`imul on a sub-register`);
                const expr = BINARY[mnemonic]!(a, b);
                if (mnemonic === "add" || mnemonic === "sub" || mnemonic === "and" || mnemonic === "or" || mnemonic === "xor") {
                    if (mnemonic === "add") {
                        const carry = w === 4 ? `(fr < fa)` : `((((fa & ${widthMask(w)}) + (fb & ${widthMask(w)})) >> ${8 * w}) & 1u)`;
                        lines.push(`fa = ${sext(a, w)}; fb = ${sext(`(${b} & ${widthMask(w)})`, w)}; fr = ${sext("(fa + fb)", w)}; fc = ${carry}; fk = 2u;`);
                        kinds.set(i, "add");
                    } else if (mnemonic === "sub") {
                        lines.push(`fa = ${sext(a, w)}; fb = ${sext(`(${b} & ${widthMask(w)})`, w)}; fr = ${sext("(fa - fb)", w)}; fk = 1u;`);
                        kinds.set(i, "cmp");
                    } else {
                        lines.push(`fr = ${sext(expr, w)}; fk = 3u;`);
                        kinds.set(i, "logic");
                    }
                    if (isCaptured) liveFlagSites++;
                    const wr = writeStmt(dst, "fr");
                    if (!wr) return reject(`write: ${mnemonic}`);
                    lines.push(wr);
                    continue;
                }
                if (mnemonic === "imul") {
                    lines.push(`{ int64_t p = (int64_t)(int32_t)(${a}) * (int64_t)(int32_t)(${b}); fr = (uint32_t)p; uint32_t o = p != (int64_t)(int32_t)fr; fa = o | (o << 11) | ((__builtin_parity(fr & 0xffu) == 0) << 2) | ((fr == 0u) << 6) | ((fr >> 31) << 7); fk = 8u; }`);
                    kinds.set(i, "raw");
                    if (isCaptured) liveFlagSites++;
                    resultExpr = "fr";
                } else {
                    // shl/shr/sar: a zero count leaves the flags alone; CF is
                    // the last bit shifted out, OF is defined for a count of
                    // one (and computed that way for any count).
                    const W = 8 * w;
                    const az = `(${a} & ${widthMask(w)})`;
                    let body: string;
                    if (mnemonic === "shl") {
                        body = `uint32_t r = ${sext(`((az << c) & ${widthMask(w)})`, w)}; uint32_t cfo = c <= ${W}u ? (az >> (${W}u - c)) & 1u : 0u; uint32_t of = ((r >> 31) ^ cfo) & 1u;`;
                    } else if (mnemonic === "shr") {
                        body = `uint32_t r = ${sext(`(az >> (c > ${W - 1}u ? ${W - 1}u : c))`, w)}; if (c > ${W - 1}u) r = 0u; uint32_t cfo = c <= ${W}u ? (az >> (c - 1u)) & 1u : 0u; uint32_t of = (az >> ${W - 1}u) & 1u;`;
                    } else {
                        body = `int32_t as = (int32_t)${sext("az", w)}; uint32_t r = (uint32_t)(as >> (c > 31u ? 31u : c)); uint32_t cfo = c <= ${W}u ? ((uint32_t)as >> (c - 1u)) & 1u : (uint32_t)(as < 0); uint32_t of = 0u;`;
                    }
                    lines.push(`{ uint32_t c = (${b}) & 31u; uint32_t az = ${az}; if (c) { ${body} fr = r; fa = cfo | ((__builtin_parity(fr & 0xffu) == 0) << 2) | ((fr == 0u) << 6) | ((fr >> 31) << 7) | (of << 11); fk = 8u; ${writeStmt(dst, "fr")} } }`);
                    kinds.set(i, "raw");
                    if (isCaptured) liveFlagSites++;
                    continue;
                }
            }
            else if (mnemonic === "inc" || mnemonic === "dec") {
                const a = readExpr(dst);
                if (a === null) return reject(`read: ${mnemonic}`);
                const w = operandWidth(dst);
                const expr = `(${a} ${mnemonic === "inc" ? "+" : "-"} 1u)`;
                const minValue = w === 4 ? "0x80000000u" : w === 2 ? "0xffff8000u" : "0xffffff80u";
                // CF is untouched: taken from the current flags, exact whether a
                // producer ran in this invocation or v86's copy is still lazy.
                lines.push(`fc = (fk ? x86_flags_now(fk, fa, fb, fr, fc) : (((uint32_t)FLAGS_CHANGED & 1u) ? (uint32_t)get_eflags() : (uint32_t)FLAGS)) & 1u;`);
                lines.push(`fa = ${sext(a, w)}; fb = ${minValue}; fr = ${sext(expr, w)}; fk = ${mnemonic === "inc" ? 4 : 5}u;`);
                kinds.set(i, mnemonic);
                if (isCaptured) liveFlagSites++;
                const wr = writeStmt(dst, "fr");
                if (!wr) return reject(`write: ${mnemonic}`);
                lines.push(wr);
                continue;
            }
            else if (mnemonic === "neg" || mnemonic === "not") {
                const a = readExpr(dst);
                if (a === null) return reject(`read: ${mnemonic}`);
                if (mnemonic === "neg") {
                    // Flags of 0 - a.
                    const w = operandWidth(dst);
                    lines.push(`fa = 0u; fb = ${sext(a, w)}; fr = ${sext("(0u - fb)", w)}; fk = 1u;`);
                    kinds.set(i, "cmp");
                    if (isCaptured) liveFlagSites++;
                }
                resultExpr = mnemonic === "neg" ? `(0u - ${a})` : `(~${a})`;
            }
            else return reject(`unsupported: ${mnemonic}`);

            if (resultExpr === null) return reject(`operand: ${mnemonic} ${operand}`);
            const stmt = writeStmt(dst, resultExpr);
            if (!stmt) return reject(`write: ${mnemonic} ${dstText}`);
            lines.push(stmt);
        }

        const exitAt = (addrExpr: string) => `ip = ${addrExpr}; goto exit;`;

        if (term.mnemonic === "ret" || term.mnemonic === "retn") {
            const imm = term.operand.trim();
            const pops = imm ? Number(imm) : 0;
            if (!Number.isFinite(pops)) return reject(`ret ${imm}`);
            lines.push(`if (esp > ml - 4u) { ${guardExit(term.addr, n - 1)} }`, `cnt += ${n}u;`, `ip = LD32(esp);`, `esp += ${4 + pops}u;`, `goto exit;`);
        }
        else if (term.mnemonic === "call") {
            let direct = directTarget(term.operand);
            let operandText = term.operand;
            let folded = false;
            // A direct call to an import thunk (jmp dword ptr [slot]) is the
            // call through the slot: no thunk to enter, and the stub behind
            // the slot is performed here.
            if (direct !== null) {
                const thunk = (await decoder.linear(direct, 8))[0];
                const m = thunk && thunk.mnemonic === "jmp" ? /^dword ptr \[(0x[0-9a-f]+)\]$/i.exec(thunk.operand) : null;
                if (m) { operandText = `dword ptr [${m[1]}]`; direct = null; folded = true; }
            }
            const target = direct !== null ? `${direct >>> 0}u` : indirectTargetExpr(operandText);
            if (target === null) return reject(`call ${term.operand}`);
            calls++;
            if (direct !== null) callTargets.push(direct >>> 0);
            const targetOp = direct === null ? parseOperand(operandText) : null;
            if (targetOp && targetOp.kind === "mem") guardMem(lines, targetOp, term.addr, n - 1);
            const targetExpr = targetOp && targetOp.kind === "mem" ? `LD32(a0)` : target;
            const ret = (term.addr + term.size) >>> 0;
            // A folded thunk retired its jmp on the way to the target.
            lines.push(`{ uint32_t t = ${targetExpr}; if (esp - 4u > ml - 4u) { ${guardExit(term.addr, n - 1)} } cnt += ${folded ? n + 1 : n}u; esp -= 4u; ST32(esp, ${ret}u);`);
            // A callee in the same batch is called natively: state goes through
            // memory both ways, and if the callee came back by ret to our
            // return address we carry on here; any other exit of the callee is
            // ours too, with its state already committed (exit_foreign).
            const resume = indexOf.get(ret);
            const fpuOut = fpuUsed ? `if (fdirty) { FPU_TOP = (uint8_t)top; FPU_EMPTY = (uint8_t)fempty; FPU_DIRTY = 1u; fdirty = 0u; } ` : "";
            const fpuIn = fpuUsed ? ` top = FPU_TOP; fempty = FPU_EMPTY;` : "";
            if (direct !== null && resume !== undefined) {
                nativeCalls++;
                lines.push(`#ifdef HAVE_fn_${direct.toString(16)}`);
                // Blocks are numbered by address, so the callee's entry is not
                // block 0 whenever its CFG reaches below the entry (a tail call
                // through a lower jump thunk, a loop placed before it).
                lines.push(`if (depth < ${NATIVE_CALL_DEPTH}u) { ${stores} ${fpuOut}*INSTRUCTION_COUNTER += cnt; cnt = 0u; fn_${direct.toString(16)}(ENTRY_fn_${direct.toString(16)}, depth + 1u);`);
                lines.push(`    if ((uint32_t)*INSTRUCTION_POINTER == ${ret}u) { rb = ${resume}u; goto native_return; }`);
                lines.push(`    goto exit_foreign; }`);
                lines.push(`#endif`);
            }
            if (resume !== undefined) {
                // A callee this batch does not own (an import, an indirect
                // target, a function outside the lot) runs under the nested
                // dispatcher until it returns here; the flags are made exact
                // first because the callee may be JIT code reading them.
                nativeCalls++;
                // A Win32/CRT stub (mov eax, id; mov edx, 0xB077; out dx, eax;
                // ret N) is performed here instead of under the nested
                // dispatcher: the same port write the interpreter would make,
                // then the ret. A handler that switched threads, parked the
                // thread or redirected to a callback leaves EIP or the FS base
                // changed, and the exit hands the guest to the dispatcher.
                lines.push(`if (t + 14u <= ml && LD8(t) == 0xB8u && LD8(t + 5u) == 0xBAu && LD32(t + 6u) == 0xB077u && LD8(t + 10u) == 0xEFu && (LD8(t + 11u) == 0xC2u || LD8(t + 11u) == 0xC3u)) {`);
                lines.push(`    uint32_t hid = LD32(t + 1u), hn = LD8(t + 11u) == 0xC2u ? LD16(t + 12u) : 0u; eax = hid; edx = 0xB077u; ${stores} ${fpuOut}`);
                lines.push(`    if (fk) { FLAGS = (int32_t)(((uint32_t)FLAGS & ~0x8d5u) | x86_flags_now(fk, fa, fb, fr, fc)); FLAGS_CHANGED = 0; fk = 0u; }`);
                lines.push(`    *INSTRUCTION_COUNTER += cnt + 3u; cnt = 0u; *PREVIOUS_IP = (int32_t)(t + 10u); *INSTRUCTION_POINTER = (int32_t)(t + 11u);`);
                lines.push(`    { int32_t fs0 = FS_BASE; hypercall_out((int32_t)hid); if (FS_BASE != fs0 || (uint32_t)*INSTRUCTION_POINTER != t + 11u) goto exit_foreign; }`);
                lines.push(`    ${reloads}${fpuIn} fk = 0u; ip = LD32(esp); esp += 4u + hn; cnt = 1u; if (ip == ${ret}u) { b = ${resume}; continue; } goto exit; }`);
                lines.push(`if (depth < ${NATIVE_CALL_DEPTH}u) { ${stores} ${fpuOut}`);
                lines.push(`    if (fk) { FLAGS = (int32_t)(((uint32_t)FLAGS & ~0x8d5u) | x86_flags_now(fk, fa, fb, fr, fc)); FLAGS_CHANGED = 0; fk = 0u; }`);
                lines.push(`    *INSTRUCTION_COUNTER += cnt; cnt = 0u; *PREVIOUS_IP = (int32_t)t; *INSTRUCTION_POINTER = (int32_t)t;`);
                // An indirect target the batch owns is called natively, like a
                // direct one; anything else runs under the nested dispatcher.
                lines.push(`    if (aot_dispatch(t, depth + 1u)) { if ((uint32_t)*INSTRUCTION_POINTER == ${ret}u) { rb = ${resume}u; goto native_return; } goto exit_foreign; }`);
                lines.push(`    if (run_until(${ret}u, esp, ${INVOCATION_BUDGET}u) == 0u) { rb = ${resume}u; goto native_return; }`);
                lines.push(`    goto exit_foreign; }`);
            }
            lines.push(`${exitAt("t")} }`);
        }
        else if (term.mnemonic === "jmp") {
            const direct = directTarget(term.operand);
            if (direct === null) {
                const targetOp = parseOperand(term.operand);
                if (targetOp && targetOp.kind === "mem") guardMem(lines, targetOp, term.addr, n - 1);
                const target = targetOp && targetOp.kind === "mem" ? `LD32(a0)` : indirectTargetExpr(term.operand);
                if (target === null) return reject(`jmp ${term.operand}`);
                lines.push(`cnt += ${n}u;`, exitAt(target));
            } else if (!inImage(direct)) {
                lines.push(`cnt += ${n}u;`, exitAt(`${direct >>> 0}u`));
            } else {
                const bi = indexOf.get(direct);
                if (bi === undefined) return reject("jmp outside the function");
                lines.push(`cnt += ${n}u;`);
                if (direct <= term.addr) lines.push(`if (++loops > ${LOOP_LIMIT}u || *INSTRUCTION_COUNTER - cnt0 + cnt > ${INVOCATION_BUDGET}u) { ${exitAt(`${direct >>> 0}u`)} }`);
                lines.push(`b = ${bi}; continue;`);
            }
        }
        else if (COND_BRANCH.has(term.mnemonic)) {
            runtimeFlags(n - 1, lines);
            const cond = condFor(n - 1, term.mnemonic.slice(1));
            if (cond === null) return reject(`${term.mnemonic} after ${producerName(n - 1)}`);
            const target = directTarget(term.operand)!;
            const fall = indexOf.get(term.addr + term.size);
            if (fall === undefined) return reject("branch outside the function");
            if (!inImage(target)) {
                // The taken edge tail-calls another image: exit there; the
                // fall-through stays this function's next block.
                lines.push(`cnt += ${n}u;`, `if (${cond}) { ${exitAt(`${target >>> 0}u`)} }`, `b = ${fall}; continue;`);
            } else {
                const taken = indexOf.get(target);
                if (taken === undefined) return reject("branch outside the function");
                const backEdge = target <= term.addr ? `if (++loops > ${LOOP_LIMIT}u || *INSTRUCTION_COUNTER - cnt0 + cnt > ${INVOCATION_BUDGET}u) { ${exitAt(`${target >>> 0}u`)} } ` : "";
                lines.push(`cnt += ${n}u;`, `if (${cond}) { ${backEdge}b = ${taken}; continue; }`, `b = ${fall}; continue;`);
            }
        }
        else if (x87Kind(term.mnemonic, term.operand) === "slow") {
            // The interpreter runs this one instruction; the block after it is
            // an entry, so the translation is re-entered right behind.
            lines.push(slowExit(term.addr, n - 1));
        }
        else {
            const fall = indexOf.get(term.addr + term.size);
            if (fall === undefined) return reject("fallthrough outside the function");
            lines.push(`cnt += ${n}u;`, `b = ${fall}; continue;`);
        }

        out.push(`        case ${indexOf.get(start)}: {\n${lines.map((l) => "            " + l).join("\n")}\n        }`);
    }

    if (out.length === 0) return reject("empty body");

    const name = `fn_${entry.toString(16)}`;
    // TOP and the empty bitmap live in locals while the translation runs: no
    // helper can observe them in between, and every exit writes them back.
    const fpuLoad = fpuUsed ? `    uint32_t top = FPU_TOP, fempty = FPU_EMPTY, fdirty = 0u;\n` : "";
    const fpuStore = fpuUsed ? `    if (fdirty) { FPU_TOP = (uint8_t)top; FPU_EMPTY = (uint8_t)fempty; FPU_DIRTY = 1u; }\n` : "";
    const c =
        `void ${name}(int b, uint32_t depth)\n{\n` +
        `    const uint32_t mb = mem_base();\n` +
        `    const uint32_t ml = MEM_SIZE;\n` +
        `    ${loads}\n` +
        `    uint32_t fa = 0u, fb = 0u, fr = 0u, fc = 0u, fk = 0u, fl = 0u, cnt = 0u, loops = 0u, ip = 0u, a0 = 0u, rb = 0u;\n` +
        `    (void)fl;\n` +
        `    const uint32_t cnt0 = *INSTRUCTION_COUNTER;\n` +
        `    (void)depth; (void)cnt0;\n` +
        fpuLoad +
        `    for (;;) { switch (b) {\n${out.join("\n")}\n` +
        `        default: ip = ${entry >>> 0}u; goto exit;\n    }\n` +
        // One reload arm per function: a callee that came back natively to a
        // return address lands here with the resume block in rb. Kept out of
        // the ~150 000 call sites, which each held a copy.
        (nativeCalls > 0 ? `    native_return: ${reloads}${fpuUsed ? " top = FPU_TOP; fempty = FPU_EMPTY;" : ""} fk = 0u; b = (int)rb;\n` : "") +
        `    }\n` +
        `exit:\n    ${stores}\n` +
        FLAGS_EPILOGUE +
        fpuStore +
        `    *PREVIOUS_IP = (int32_t)ip;\n` +
        `    *INSTRUCTION_POINTER = (int32_t)ip;\n` +
        `    *INSTRUCTION_COUNTER += cnt;\n` +
        `    return;\n` +
        (nativeCalls > 0 ? `exit_foreign:\n    *INSTRUCTION_COUNTER += cnt;\n` : "") +
        `}\n`;

    const entries = [{ addr: entry, block: indexOf.get(entry)! }];
    const wanted = new Set<number>(resumes);
    if (extraEntries) {
        for (const a of order) if (a !== entry && extraEntries.has(a)) wanted.add(a);
    }
    for (const r of [...wanted].sort((a, b) => a - b)) {
        const bi = indexOf.get(r);
        if (bi !== undefined) entries.push({ addr: r, block: bi });
    }

    return { entry, name, c, instructions: total, blocks: blocks.size, liveFlagSites, calls, callTargets, entries, extent: maxEnd - entry };
}

/** Group translated functions into per-page modules and one C unit. */
export function assembleBatch(allFunctions: CFunction[], units = 1): Batch {
    // The same entry can arrive twice (listed as an explicit entry and reached
    // again by closure); keep the first so a function is defined once. Without
    // this both copies survive ownership + call-closure and clang sees a
    // redefinition.
    {
        const seen = new Set<number>();
        allFunctions = allFunctions.filter((f) => (seen.has(f.entry) ? false : (seen.add(f.entry), true)));
    }
    // A translation whose every entry another translation already owns (a
    // thunk chain covers its target's body) gets no page state; unless a kept
    // function calls it directly it is unreachable and only adds code. Keep
    // the reachable set, to a fixed point, as clang's dead-function removal
    // did when every function was static in one unit.
    const claimed = new Set<number>();
    const owner = new Map<number, CFunction>();
    for (const f of allFunctions) {
        for (const e of f.entries) if (!claimed.has(e.addr)) { claimed.add(e.addr); owner.set(e.addr, f); }
    }
    const byEntry = new Map(allFunctions.map((f) => [f.entry, f] as const));
    const kept = new Set<CFunction>();
    for (const f of owner.values()) kept.add(f);
    for (let grew = true; grew;) {
        grew = false;
        for (const f of [...kept]) for (const t of f.callTargets) {
            const callee = byEntry.get(t);
            if (callee && !kept.has(callee)) { kept.add(callee); grew = true; }
        }
    }
    const functions = allFunctions.filter((f) => kept.has(f));
    const byPage = new Map<number, PageModule>();
    for (const f of functions) {
        for (const e of f.entries) {
            const page = e.addr >>> 12;
            let pm = byPage.get(page);
            if (!pm) { pm = { page, name: `page_${(page << 12 >>> 0).toString(16)}`, states: [] }; byPage.set(page, pm); }
            if (!pm.states.some((s) => s.addr === e.addr)) pm.states.push({ addr: e.addr, fn: f.name, block: e.block });
        }
    }
    const pages = [...byPage.values()].sort((a, b) => a.page - b.page);
    for (const pm of pages) pm.states.sort((a, b) => a.addr - b.addr);
    const pageCode = pages.map((pm) =>
        `__attribute__((export_name("${pm.name}")))\n` +
        `void ${pm.name}(int32_t initial_state)\n{\n` +
        `    switch (initial_state) {\n` +
        pm.states.map((s, i) => `        case ${i}: ${s.fn}(${s.block}, 0u); return;`).join("\n") +
        `\n        default: return;\n    }\n}\n`
    ).join("\n");
    // Every function is declared and flagged up front, so a call to another
    // translated function compiles to a native call whatever the order.
    const decls = functions.map((f) => `#define HAVE_${f.name} 1\n#define ENTRY_${f.name} ${f.entries[0]!.block}\nvoid ${f.name}(int b, uint32_t depth);`).join("\n");
    // The compare tree: -fno-jump-tables keeps it free of data segments.
    // Two levels, page then offset, so no generated function has more than a
    // few dozen blocks: one switch over every entry made the WebAssembly
    // backend's CFG stackifier take hours. noinline keeps clang from weighing
    // the tree at every one of the ~150 000 indirect call sites.
    const byEntryPage = new Map<number, CFunction[]>();
    for (const f of functions) {
        const page = f.entry >>> 12;
        let list = byEntryPage.get(page);
        if (!list) { list = []; byEntryPage.set(page, list); }
        list.push(f);
    }
    const dispatchPages = [...byEntryPage.entries()].sort((a, b) => a[0] - b[0]);
    const dispatch = dispatchPages.map(([page, list]) =>
        `__attribute__((noinline)) int aot_dispatch_p${page.toString(16)}(uint32_t target, uint32_t depth)\n{\n    switch (target) {\n`
        + list.map((f) => `        case ${f.entry >>> 0}u: ${f.name}(ENTRY_${f.name}, depth); return 1;`).join("\n")
        + "\n        default: return 0;\n    }\n}\n").join("\n")
        + "\n__attribute__((noinline)) int aot_dispatch(uint32_t target, uint32_t depth)\n{\n    switch (target >> 12) {\n"
        + dispatchPages.map(([page]) => `        case ${page}u: return aot_dispatch_p${page.toString(16)}(target, depth);`).join("\n")
        + "\n        default: return 0;\n    }\n}\n";
    const header = C_PRELUDE + "\n" + decls + "\n";
    const c = header + functions.map((f) => f.c).join("\n") + "\n" + dispatch + "\n" + pageCode;
    // Balanced by C length; a unit is only worth its own clang above ~40 MB.
    const total = functions.reduce((a, f) => a + f.c.length, 0);
    const unitCount = Math.max(1, Math.min(units, Math.ceil(total / (40 << 20))));
    const bodies: string[][] = Array.from({ length: unitCount }, () => []);
    const sizes = new Array<number>(unitCount).fill(0);
    for (const f of functions) {
        let k = 0;
        for (let i = 1; i < unitCount; i++) if (sizes[i]! < sizes[k]!) k = i;
        bodies[k]!.push(f.c); sizes[k]! += f.c.length;
    }
    const unitTexts = bodies.map((b) => b.join("\n") + "\n");
    unitTexts[unitTexts.length - 1] += dispatch + "\n" + pageCode;
    return { c, header, units: unitTexts, functions, pages };
}
