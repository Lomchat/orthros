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
 * budget the loop head. The instruction counter is exact per block, because
 * v86 derives guest time from it.
 *
 * Flags: a conditional branch reads the last flag-writing instruction of its
 * own block, which must be one of the modelled producers (cmp, test, add,
 * sub, and, or, xor, inc, dec); every other flag update is dead by the x86
 * calling convention. Any shape outside the subset declines the function.
 *
 * The emitted C must never use a data segment or the C shadow stack: only
 * locals, the guest stack and the shared memory. That is what lets a module
 * share v86's memory.
 */

import { BlockReader, CapstoneDecoder, directTarget, type Insn } from "./decoder-capstone";

export let lastRejection = "";

export interface CFunction {
    entry: number;
    name: string;
    c: string;
    instructions: number;
    blocks: number;
    liveFlagSites: number;
    calls: number;
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
    c: string;
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
]);
/** Flag producers a branch can consume. */
const FLAG_PRODUCER = new Set(["cmp", "test", "sub", "add", "and", "or", "xor", "inc", "dec"]);
/** Instructions that leave the flags alone; anything else between a producer
 *  and its branch is a flag writer the model does not follow. */
const FLAG_PRESERVING = new Set([
    "mov", "movzx", "movsx", "lea", "push", "pop", "xchg", "nop", "cdq", "cwde", "cbw", "leave", "not",
]);
const OTHER_FLAG_READER = /^(set[a-z]+|cmov[a-z]+|adc|sbb|rcl|rcr|salc|lahf|pushf[d]?|popf[d]?)$/;

const LOOP_LIMIT = 100_000;
const SIZE_BUDGET = 4096;

interface Operand {
    kind: "reg32" | "reg16" | "reg8lo" | "reg8hi" | "imm" | "mem";
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
    else if (segment && segment !== "ds") return null;
    if (disp !== 0 || parts.length === 0) parts.push(`${disp >>> 0}u`);
    return `(${parts.join(" + ")})`;
}

function parseOperand(text: string): Operand | null {
    const t = text.trim();
    const r32 = regIndex(t);
    if (r32 !== null) return { kind: "reg32", index: r32 };
    const r16 = REG16.indexOf(t);
    if (r16 >= 0) return { kind: "reg16", index: r16 };
    const r8l = REG8_LOW.indexOf(t);
    if (r8l >= 0) return { kind: "reg8lo", index: r8l };
    const r8h = REG8_HIGH.indexOf(t);
    if (r8h >= 0) return { kind: "reg8hi", index: r8h };
    const imm = /^(0x[0-9a-f]+|-?\d+)$/i.exec(t);
    if (imm) return { kind: "imm", value: Number(imm[1]) | 0 };
    const widths: Record<string, number> = { BYTE: 1, WORD: 2, DWORD: 4, QWORD: 8 };
    const mem = /^(?:(BYTE|WORD|DWORD|QWORD)\s+PTR\s+)?(?:([a-z]{2}):)?\[(.+)\]$/i.exec(t);
    if (mem) {
        const width = mem[1] ? widths[mem[1].toUpperCase()]! : 4;
        const addr = parseAddress(mem[3]!, mem[2] ? mem[2].toLowerCase() : null);
        if (addr === null) return null;
        return { kind: "mem", addr, width };
    }
    // moffs forms: `ds:0x12ed5c8`, `DWORD PTR ds:0x...`, `fs:0x0`.
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
 * Exact condition for a branch from the producer's kind and the values kept
 * in fa/fb/fr (all sign-extended to 32 bits from the operation's width):
 *   cmp/sub : fa = a, fb = b            (flags of a - b)
 *   add     : fa = a, fb = b, fr = a+b
 *   logic   : fr = result (and/or/xor/test)   CF = OF = 0
 *   inc/dec : fa = a, fr = result        CF unchanged: carry forms decline
 */
function conditionExpr(branch: string, kind: "cmp" | "add" | "logic" | "inc" | "dec"): string | null {
    let ZF: string, SF: string, CF: string | null, SO: string | null; // SO = SF ^ OF
    switch (kind) {
        case "cmp":
            ZF = `(fa == fb)`; SF = `((int32_t)(fa - fb) < 0)`; CF = `(fa < fb)`; SO = `((int32_t)fa < (int32_t)fb)`;
            break;
        case "add":
            ZF = `(fr == 0u)`; SF = `((int32_t)fr < 0)`; CF = `(fr < fa)`;
            SO = `(((int32_t)fr < 0) != (((int32_t)((fa ^ fr) & (fb ^ fr))) < 0))`;
            break;
        case "logic":
            ZF = `(fr == 0u)`; SF = `((int32_t)fr < 0)`; CF = "0"; SO = SF;
            break;
        case "inc":
            ZF = `(fr == 0u)`; SF = `((int32_t)fr < 0)`; CF = null; SO = `(((int32_t)fr < 0) != (fa == 0x7fffffffu))`;
            break;
        case "dec":
            ZF = `(fr == 0u)`; SF = `((int32_t)fr < 0)`; CF = null; SO = `(((int32_t)fr < 0) != (fa == 0x80000000u))`;
            break;
    }
    switch (branch) {
        case "je": case "jz": return ZF;
        case "jne": case "jnz": return `!${ZF}`;
        case "js": return SF;
        case "jns": return `!${SF}`;
        case "jl": case "jnge": return SO;
        case "jge": case "jnl": return `!${SO}`;
        case "jle": case "jng": return `(${ZF} || ${SO})`;
        case "jg": case "jnle": return `(!${ZF} && !${SO})`;
        case "jb": case "jnae": case "jc": return CF;
        case "jae": case "jnb": case "jnc": return CF === null ? null : `!${CF}`;
        case "jbe": case "jna": return CF === null ? null : `(${CF} || ${ZF})`;
        case "ja": case "jnbe": return CF === null ? null : `(!${CF} && !${ZF})`;
        default: return null;
    }
}

interface Block { start: number; insns: Insn[] }

/**
 * Guest RAM ends at MEM_SIZE; anything past it would trap the wasm module
 * instead of faulting the guest. The guard exits to the dispatcher at the
 * instruction's own address before it runs, with every earlier effect already
 * committed, so v86 raises the fault exactly where the guest would have.
 */
function guardMem(lines: string[], op: Operand, insnAddr: number, done: number): void {
    if (op.kind !== "mem") return;
    lines.push(`a0 = ${op.addr}; if (a0 > ml - ${op.width}u) { ${guardExit(insnAddr, done)} }`);
    op.addr = "a0";
}

/** Exit before instruction `insnAddr`, crediting the `done` instructions of
 *  the block that already ran; the host is told, then v86 resumes there. */
function guardExit(insnAddr: number, done: number): string {
    return `cnt += ${done}u; ip = ${insnAddr >>> 0}u; guard_exit(ip); goto exit;`;
}

function splitOperands(operand: string): number | null {
    let depth = 0;
    for (let i = 0; i < operand.length; i++) {
        const c = operand[i];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === "," && depth === 0) return i;
    }
    return null;
}

export const C_PRELUDE = `#include <stdint.h>
typedef uint32_t __attribute__((aligned(1))) u32u;
typedef uint16_t __attribute__((aligned(1))) u16u;
#define REG32 ((volatile int32_t *)64)
#define INSTRUCTION_POINTER ((volatile int32_t *)556)
#define PREVIOUS_IP ((volatile int32_t *)560)
#define INSTRUCTION_COUNTER ((volatile uint32_t *)664)
#define FSBASE ((uint32_t)*(volatile int32_t *)(736 + 4 * 4))
#define MEM_SIZE (*(volatile uint32_t *)812)
__attribute__((import_module("env"), import_name("guard_exit"))) void guard_exit(uint32_t addr);
__attribute__((import_module("env"), import_name("mem_base"))) uint32_t mem_base(void);
#define LD8(a)  ((uint32_t)*(volatile uint8_t *)(uintptr_t)(mb + (a)))
#define LD16(a) ((uint32_t)*(volatile u16u *)(uintptr_t)(mb + (a)))
#define LD32(a) (*(volatile u32u *)(uintptr_t)(mb + (a)))
#define ST8(a, v)  (*(volatile uint8_t *)(uintptr_t)(mb + (a)) = (uint8_t)(v))
#define ST16(a, v) (*(volatile u16u *)(uintptr_t)(mb + (a)) = (uint16_t)(v))
#define ST32(a, v) (*(volatile u32u *)(uintptr_t)(mb + (a)) = (uint32_t)(v))
`;

/** Operand expression of a call/jmp target that is not a direct address. */
function indirectTargetExpr(operand: string): string | null {
    const op = parseOperand(operand);
    if (!op) return null;
    if (op.kind === "reg32") return REG32[op.index!]!;
    if (op.kind === "mem" && op.width === 4) return `LD32(${op.addr})`;
    return null;
}

export async function translateFunctionC(decoder: CapstoneDecoder, entry: number): Promise<CFunction | null> {
    lastRejection = "";
    // Every block decodes from its own leader; a sequential read continues
    // that window, so the same address always yields the same instruction.
    const reader = new BlockReader(decoder);
    const at = (pc: number): Promise<Insn | null> => reader.at(pc);

    const first = await at(entry);
    if (!first) return reject(`no instruction at 0x${entry.toString(16)}`);
    if (first.mnemonic === "int3") return reject("entry is padding");

    // Leaders: the entry, branch targets and fall-throughs, and the
    // instruction after each call (a resume entry).
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
                if (mnemonic === "jmp") {
                    const t = directTarget(operand);
                    if (t === null) break;                       // indirect: an exit
                    leaders.add(t); work.push(t); break;
                }
                if (COND_BRANCH.has(mnemonic)) {
                    const t = directTarget(operand);
                    if (t === null) return reject(`indirect ${mnemonic}`);
                    leaders.add(t); leaders.add(pc + insn.size);
                    work.push(t); work.push(pc + insn.size); break;
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

    for (const start of order) {
        const block = blocks.get(start)!;
        total += block.insns.length;
        const lines: string[] = [];
        const n = block.insns.length;

        const term = block.insns[block.insns.length - 1]!;
        const branchNeedsFlags = COND_BRANCH.has(term.mnemonic);
        let producerIdx = -1;
        if (branchNeedsFlags) {
            for (let i = block.insns.length - 2; i >= 0; i--) {
                const m = block.insns[i]!.mnemonic;
                if (FLAG_PRODUCER.has(m)) { producerIdx = i; break; }
                if (!FLAG_PRESERVING.has(m)) return reject(`${term.mnemonic} after unmodelled flag writer ${m}`);
            }
            if (producerIdx < 0) return reject(`${term.mnemonic} with no flag producer in its block`);
        }
        let producerKind: "cmp" | "add" | "logic" | "inc" | "dec" | null = null;

        for (let i = 0; i < block.insns.length; i++) {
            const insn = block.insns[i]!;
            const { mnemonic, operand } = insn;
            const isProducer = i === producerIdx;

            if (mnemonic === "ret" || mnemonic === "retn" || mnemonic === "call") break;
            if (mnemonic === "jmp" || COND_BRANCH.has(mnemonic)) break;
            if (mnemonic === "nop") continue;
            if (mnemonic === "int3") return reject("int3 inside function");
            if (OTHER_FLAG_READER.test(mnemonic)) return reject(`reads flags: ${mnemonic}`);
            if (mnemonic === "leave") { lines.push(`if (ebp > ml - 4u) { ${guardExit(insn.addr, i)} }`, `esp = ebp;`, `ebp = LD32(esp);`, `esp += 4u;`); continue; }
            if (mnemonic === "cdq") { lines.push(`edx = ((int32_t)eax < 0) ? 0xffffffffu : 0u;`); continue; }
            if (mnemonic === "cwde") { lines.push(`eax = (uint32_t)(int32_t)(int16_t)eax;`); continue; }

            const commaIdx = splitOperands(operand);
            const dstText = commaIdx === null ? operand : operand.slice(0, commaIdx);
            const srcText = commaIdx === null ? null : operand.slice(commaIdx + 1);

            if (mnemonic === "cmp" || mnemonic === "test") {
                if (!isProducer) continue;
                if (!srcText) return reject(`${mnemonic} missing source`);
                const a = parseOperand(dstText), b = parseOperand(srcText);
                if (!a || !b) return reject(`operand: ${mnemonic} ${operand}`);
                guardMem(lines, a, insn.addr, i); guardMem(lines, b, insn.addr, i);
                const ra = readExpr(a), rb = readExpr(b);
                if (ra === null || rb === null) return reject(`read: ${mnemonic}`);
                const w = operandWidth(a);
                if (mnemonic === "cmp") {
                    lines.push(`fa = ${sext(ra, w)}; fb = ${sext(`(${rb} & ${w === 4 ? "0xffffffffu" : w === 2 ? "0xffffu" : "0xffu"})`, w)};`);
                    producerKind = "cmp";
                } else {
                    lines.push(`fr = ${sext(`(${ra} & ${rb})`, w)};`);
                    producerKind = "logic";
                }
                liveFlagSites++;
                continue;
            }

            const dst = parseOperand(dstText);
            if (!dst) return reject(`operand: ${mnemonic} ${dstText}`);

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
            if (mnemonic === "xchg") {
                if (!srcText) return reject("xchg missing source");
                const src = parseOperand(srcText);
                if (!src || dst.kind !== "reg32" || src.kind !== "reg32") return reject(`xchg ${operand}`);
                lines.push(`{ uint32_t t = ${REG32[dst.index!]}; ${REG32[dst.index!]} = ${REG32[src.index!]}; ${REG32[src.index!]} = t; }`);
                continue;
            }

            let resultExpr: string | null = null;
            // One memory operand per instruction (string forms are not
            // translated), so a single guard covers both the read and the write.
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
            else if (BINARY[mnemonic]) {
                if (!srcText) return reject(`${mnemonic} missing source`);
                const src = parseOperand(srcText);
                if (!src) return reject(`operand: ${mnemonic} ${srcText}`);
                guardMem(lines, src, insn.addr, i);
                const a = readExpr(dst), b = readExpr(src);
                if (a === null || b === null) return reject(`read: ${mnemonic}`);
                const w = operandWidth(dst);
                if ((mnemonic === "shl" || mnemonic === "shr" || mnemonic === "sar" || mnemonic === "imul") && w !== 4) {
                    return reject(`${mnemonic} on a sub-register`);
                }
                const expr = BINARY[mnemonic]!(a, b);
                if (isProducer) {
                    if (mnemonic === "add") {
                        lines.push(`fa = ${sext(a, w)}; fb = ${sext(`(${b} & ${w === 4 ? "0xffffffffu" : w === 2 ? "0xffffu" : "0xffu"})`, w)}; fr = fa + fb;`);
                        producerKind = "add";
                    } else if (mnemonic === "sub") {
                        lines.push(`fa = ${sext(a, w)}; fb = ${sext(`(${b} & ${w === 4 ? "0xffffffffu" : w === 2 ? "0xffffu" : "0xffu"})`, w)}; fr = fa - fb;`);
                        producerKind = "cmp";
                    } else if (mnemonic === "and" || mnemonic === "or" || mnemonic === "xor") {
                        lines.push(`fr = ${sext(expr, w)};`);
                        producerKind = "logic";
                    } else {
                        return reject(`${mnemonic} as flag producer`);
                    }
                    liveFlagSites++;
                    const wr = writeStmt(dst, "fr");
                    if (!wr) return reject(`write: ${mnemonic}`);
                    lines.push(wr);
                    continue;
                }
                resultExpr = expr;
            }
            else if (mnemonic === "inc" || mnemonic === "dec") {
                const a = readExpr(dst);
                if (a === null) return reject(`read: ${mnemonic}`);
                const w = operandWidth(dst);
                const expr = `(${a} ${mnemonic === "inc" ? "+" : "-"} 1u)`;
                if (isProducer) {
                    lines.push(`fa = ${sext(a, w)}; fr = ${sext(expr, w)};`);
                    producerKind = mnemonic;
                    liveFlagSites++;
                    const wr = writeStmt(dst, "fr");
                    if (!wr) return reject(`write: ${mnemonic}`);
                    lines.push(wr);
                    continue;
                }
                resultExpr = expr;
            }
            else if (mnemonic === "neg" || mnemonic === "not") {
                const a = readExpr(dst);
                if (a === null) return reject(`read: ${mnemonic}`);
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
            const direct = directTarget(term.operand);
            const target = direct !== null ? `${direct >>> 0}u` : indirectTargetExpr(term.operand);
            if (target === null) return reject(`call ${term.operand}`);
            calls++;
            // Evaluate the target before the push: an esp-relative target must
            // see the stack as the guest did.
            const targetOp = direct === null ? parseOperand(term.operand) : null;
            if (targetOp && targetOp.kind === "mem") guardMem(lines, targetOp, term.addr, n - 1);
            const targetExpr = targetOp && targetOp.kind === "mem" ? `LD32(a0)` : target;
            lines.push(`{ uint32_t t = ${targetExpr}; if (esp - 4u > ml - 4u) { ${guardExit(term.addr, n - 1)} } cnt += ${n}u; esp -= 4u; ST32(esp, ${(term.addr + term.size) >>> 0}u); ${exitAt("t")} }`);
        }
        else if (term.mnemonic === "jmp") {
            const direct = directTarget(term.operand);
            if (direct === null) {
                const targetOp = parseOperand(term.operand);
                if (targetOp && targetOp.kind === "mem") guardMem(lines, targetOp, term.addr, n - 1);
                const target = targetOp && targetOp.kind === "mem" ? `LD32(a0)` : indirectTargetExpr(term.operand);
                if (target === null) return reject(`jmp ${term.operand}`);
                lines.push(`cnt += ${n}u;`, exitAt(target));
            } else {
                const bi = indexOf.get(direct);
                if (bi === undefined) return reject("jmp outside the function");
                lines.push(`cnt += ${n}u;`);
                if (direct <= term.addr) lines.push(`if (++loops > ${LOOP_LIMIT}u) { ${exitAt(`${direct >>> 0}u`)} }`);
                lines.push(`b = ${bi}; continue;`);
            }
        }
        else if (COND_BRANCH.has(term.mnemonic)) {
            const cond = conditionExpr(term.mnemonic, producerKind!);
            if (cond === null) return reject(`${term.mnemonic} after ${block.insns[producerIdx]!.mnemonic}`);
            const target = directTarget(term.operand)!;
            const taken = indexOf.get(target);
            const fall = indexOf.get(term.addr + term.size);
            if (taken === undefined || fall === undefined) return reject("branch outside the function");
            const backEdge = target <= term.addr ? `if (++loops > ${LOOP_LIMIT}u) { ${exitAt(`${target >>> 0}u`)} } ` : "";
            lines.push(`cnt += ${n}u;`, `if (${cond}) { ${backEdge}b = ${taken}; continue; }`, `b = ${fall}; continue;`);
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
    const loads = REG32.map((r, i) => `    uint32_t ${r} = (uint32_t)REG32[${i}];`).join("\n");
    const stores = REG32.map((r, i) => `    REG32[${i}] = (int32_t)${r};`).join("\n");
    const c =
        `static void ${name}(int b)\n{\n` +
        `    const uint32_t mb = mem_base();\n` +
        `    const uint32_t ml = MEM_SIZE;\n` +
        `${loads}\n` +
        `    uint32_t fa = 0u, fb = 0u, fr = 0u, cnt = 0u, loops = 0u, ip = 0u, a0 = 0u;\n` +
        `    for (;;) switch (b) {\n${out.join("\n")}\n` +
        `        default: ip = ${entry >>> 0}u; goto exit;\n    }\n` +
        `exit:\n${stores}\n` +
        `    *PREVIOUS_IP = (int32_t)ip;\n` +
        `    *INSTRUCTION_POINTER = (int32_t)ip;\n` +
        `    *INSTRUCTION_COUNTER += cnt;\n` +
        `}\n`;

    const entries = [{ addr: entry, block: 0 }];
    for (const r of [...resumes].sort((a, b) => a - b)) {
        const bi = indexOf.get(r);
        if (bi !== undefined) entries.push({ addr: r, block: bi });
    }
    // Block 0 is the entry: `order` is sorted by address and the entry is the
    // lowest address reachable only if nothing jumps backwards before it, so
    // look the real index up instead of assuming 0.
    entries[0]!.block = indexOf.get(entry)!;

    return { entry, name, c, instructions: total, blocks: blocks.size, liveFlagSites, calls, entries, extent: maxEnd - entry };
}

/** Group translated functions into per-page modules and one C unit. */
export function assembleBatch(functions: CFunction[]): Batch {
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
        pm.states.map((s, i) => `        case ${i}: ${s.fn}(${s.block}); return;`).join("\n") +
        `\n        default: return;\n    }\n}\n`
    ).join("\n");
    const c = C_PRELUDE + "\n" + functions.map((f) => f.c).join("\n") + "\n" + pageCode;
    return { c, functions, pages };
}
