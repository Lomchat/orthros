/**
 * Translate an x86 function into C, in the ABI of a v86 JIT module.
 *
 * The emitted function is `void fn_<addr>(int32_t initial_state)`. It runs in
 * v86's own linear memory: guest registers and the instruction pointer live at
 * the fixed offsets of `global_pointers.rs`, guest RAM at `mem_base()` (an
 * import the host resolves once per instance). On return the dispatcher
 * continues at whatever `instruction_pointer` says, so every exit materialises
 * it: `ret` pops the return address, a preempted loop or an unsupported
 * situation exits at the address of the next instruction the guest would run.
 *
 * Flags follow the same rule as the JavaScript translator that preceded this
 * one: a branch reads the operands of the last flag producer of its own block,
 * every other flag update is dead by the x86 calling convention, and a shape
 * this does not model declines the whole function. The instruction counter is
 * kept exact per block, because v86 derives guest time from it.
 *
 * Nothing in the emitted C uses a data segment or the C shadow stack: only
 * locals, the guest's own stack, and the shared memory. The module must stay
 * that way to share v86's memory safely.
 */

import { Decoder, directTarget, type Insn } from "./decode";

export let lastRejection = "";

export interface CTranslation {
    entry: number;
    name: string;
    c: string;
    instructions: number;
    blocks: number;
    liveFlagSites: number;
    /** Instruction extent from the entry, for extracting the guest bytes. */
    extent: number;
}

const REG32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const REG16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const REG8_LOW = ["al", "cl", "dl", "bl"];
const REG8_HIGH = ["ah", "ch", "dh", "bh"];

const COND_BRANCH = new Set([
    "je", "jz", "jne", "jnz", "jl", "jnge", "jle", "jng", "jg", "jnle", "jge", "jnl",
    "jb", "jnae", "jc", "jbe", "jna", "ja", "jnbe", "jae", "jnb", "jnc", "js", "jns",
]);
const FLAG_PRODUCER = new Set(["cmp", "test", "sub", "add", "and", "or", "xor", "inc", "dec"]);
const OTHER_FLAG_READER = /^(set[a-z]+|cmov[a-z]+|adc|sbb|rcl|rcr|salc|lahf|pushf[d]?|popf[d]?)$/;

/** Back-edges taken before a loop hands control back to the scheduler; the
 *  JIT's own bound is 100 003. */
const LOOP_LIMIT = 100_000;

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

function parseAddress(inner: string): string | null {
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
    if (disp !== 0) parts.push(`${disp >>> 0}u`);
    if (parts.length === 0) return null;
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
    const mem = /^(BYTE|WORD|DWORD|QWORD)\s+PTR\s+(?:([a-z]{2}):)?\[(.+)\]$/i.exec(t);
    if (mem) {
        const widths: Record<string, number> = { BYTE: 1, WORD: 2, DWORD: 4, QWORD: 8 };
        const width = widths[mem[1]!.toUpperCase()]!;
        // fs:/gs: are thread-local; their base is not a translation-time constant.
        if (mem[2] && mem[2].toLowerCase() !== "ds") return null;
        const addr = parseAddress(mem[3]!);
        if (addr === null) return null;
        return { kind: "mem", addr, width };
    }
    return null;
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
 * Condition for a branch given the producer that set the flags. `fa`/`fb` hold
 * the producer's operands (or its result and zero), which keeps signed and
 * unsigned forms exact without modelling CF and OF themselves.
 */
function conditionExpr(branch: string, producer: string): string | null {
    const logical = producer === "test" || producer === "and" || producer === "or" || producer === "xor";
    const z = logical ? `((fa & fb) == 0u)` : `(fa == fb)`;
    const sign = logical ? `((int32_t)(fa & fb) < 0)` : `((int32_t)(fa - fb) < 0)`;
    switch (branch) {
        case "je": case "jz": return z;
        case "jne": case "jnz": return `!${z}`;
        case "js": return sign;
        case "jns": return `!${sign}`;
        default: break;
    }
    if (logical) {
        switch (branch) {
            case "jbe": case "jna": return z;
            case "ja": case "jnbe": return `!${z}`;
            case "jb": case "jnae": case "jc": return "0";
            case "jae": case "jnb": case "jnc": return "1";
            case "jle": case "jng": return `(${z} || ${sign})`;
            case "jg": case "jnle": return `(!${z} && !${sign})`;
            case "jl": case "jnge": return sign;
            case "jge": case "jnl": return `!${sign}`;
            default: return null;
        }
    }
    switch (branch) {
        case "jl": case "jnge": return `((int32_t)fa < (int32_t)fb)`;
        case "jle": case "jng": return `((int32_t)fa <= (int32_t)fb)`;
        case "jg": case "jnle": return `((int32_t)fa > (int32_t)fb)`;
        case "jge": case "jnl": return `((int32_t)fa >= (int32_t)fb)`;
        case "jb": case "jnae": case "jc": return `(fa < fb)`;
        case "jbe": case "jna": return `(fa <= fb)`;
        case "ja": case "jnbe": return `(fa > fb)`;
        case "jae": case "jnb": case "jnc": return `(fa >= fb)`;
        default: return null;
    }
}

interface Block { start: number; insns: Insn[] }

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

/** The C preamble every translation unit needs: state offsets, memory access. */
export const C_PRELUDE = `#include <stdint.h>
typedef uint32_t __attribute__((aligned(1))) u32u;
typedef uint16_t __attribute__((aligned(1))) u16u;
#define REG32 ((volatile int32_t *)64)
#define INSTRUCTION_POINTER ((volatile int32_t *)556)
#define PREVIOUS_IP ((volatile int32_t *)560)
#define INSTRUCTION_COUNTER ((volatile uint32_t *)664)
__attribute__((import_module("env"), import_name("mem_base"))) uint32_t mem_base(void);
#define LD8(a)  ((uint32_t)*(volatile uint8_t *)(uintptr_t)(mb + (a)))
#define LD16(a) ((uint32_t)*(volatile u16u *)(uintptr_t)(mb + (a)))
#define LD32(a) (*(volatile u32u *)(uintptr_t)(mb + (a)))
#define ST8(a, v)  (*(volatile uint8_t *)(uintptr_t)(mb + (a)) = (uint8_t)(v))
#define ST16(a, v) (*(volatile u16u *)(uintptr_t)(mb + (a)) = (uint16_t)(v))
#define ST32(a, v) (*(volatile u32u *)(uintptr_t)(mb + (a)) = (uint32_t)(v))
`;

/**
 * Translate the function at `entry`, pulling instructions from the decoder.
 * Leaf functions only in this version: a call declines the function.
 */
export async function translateFunctionC(decoder: Decoder, entry: number): Promise<CTranslation | null> {
    lastRejection = "";
    const byAddr = new Map<number, Insn>();
    const at = async (pc: number): Promise<Insn | null> => {
        const hit = byAddr.get(pc);
        if (hit) return hit;
        const insn = await decoder.at(pc);
        if (insn) byAddr.set(pc, insn);
        return insn;
    };

    const leaders = new Set<number>([entry]);
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
                if (walked.size > 8192) return reject("function exceeds size budget");
                const { mnemonic, operand } = insn;
                if (mnemonic === "ret" || mnemonic === "retn") break;
                if (mnemonic === "call") return reject(`call ${operand}`);
                if (mnemonic === "jmp") {
                    const t = directTarget(operand);
                    if (t === null) return reject(`indirect jmp ${operand}`);
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
            if (m === "ret" || m === "retn" || m === "jmp" || COND_BRANCH.has(m)) break;
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

    for (const start of order) {
        const block = blocks.get(start)!;
        total += block.insns.length;
        const lines: string[] = [];
        // Exact per-block accounting: v86 turns retired instructions into time.
        lines.push(`cnt += ${block.insns.length}u;`);

        const term = block.insns[block.insns.length - 1]!;
        const branchNeedsFlags = COND_BRANCH.has(term.mnemonic);
        let producerIdx = -1;
        if (branchNeedsFlags) {
            for (let i = block.insns.length - 2; i >= 0; i--) {
                if (FLAG_PRODUCER.has(block.insns[i]!.mnemonic)) { producerIdx = i; break; }
            }
            if (producerIdx < 0) return reject(`${term.mnemonic} with no flag producer in its block`);
        }

        for (let i = 0; i < block.insns.length; i++) {
            const insn = block.insns[i]!;
            const { mnemonic, operand } = insn;
            const isProducer = i === producerIdx;

            if (mnemonic === "ret" || mnemonic === "retn") break;
            if (mnemonic === "jmp" || COND_BRANCH.has(mnemonic)) break;
            if (mnemonic === "nop") continue;
            if (OTHER_FLAG_READER.test(mnemonic)) return reject(`reads flags: ${mnemonic}`);
            if (mnemonic === "leave" || mnemonic === "cdq" || mnemonic === "cwde") return reject(mnemonic);

            const commaIdx = splitOperands(operand);
            const dstText = commaIdx === null ? operand : operand.slice(0, commaIdx);
            const srcText = commaIdx === null ? null : operand.slice(commaIdx + 1);

            if (mnemonic === "cmp" || mnemonic === "test") {
                if (!isProducer) continue;
                if (!srcText) return reject(`${mnemonic} missing source`);
                const a = parseOperand(dstText), b = parseOperand(srcText);
                if (!a || !b) return reject(`operand: ${mnemonic} ${operand}`);
                const ra = readExpr(a), rb = readExpr(b);
                if (ra === null || rb === null) return reject(`read: ${mnemonic}`);
                // Sub-register operands compare within their width, so both sides
                // are sign-extended from that width before the comparison.
                const w = a.kind === "reg16" || (a.kind === "mem" && a.width === 2) ? 16
                    : a.kind === "reg8lo" || a.kind === "reg8hi" || (a.kind === "mem" && a.width === 1) ? 8 : 32;
                if (w === 32) lines.push(`fa = ${ra}; fb = ${rb};`);
                else lines.push(`fa = (uint32_t)(int32_t)(int${w}_t)(${ra}); fb = (uint32_t)(int32_t)(int${w}_t)(${rb});`);
                liveFlagSites++;
                continue;
            }

            const dst = parseOperand(dstText);
            if (!dst) return reject(`operand: ${mnemonic} ${dstText}`);

            if (mnemonic === "push") {
                const v = readExpr(dst);
                if (v === null) return reject(`read: push ${dstText}`);
                if (dst.kind === "reg16" || dst.kind === "reg8lo" || dst.kind === "reg8hi") return reject("push of a sub-register");
                lines.push(`esp -= 4u;`, `ST32(esp, ${v});`);
                continue;
            }
            if (mnemonic === "pop") {
                if (dst.kind === "mem" && dst.addr!.includes("esp")) return reject("pop into esp-relative memory");
                if (dst.kind !== "reg32" && !(dst.kind === "mem" && dst.width === 4)) return reject(`pop ${dstText}`);
                const w = writeStmt(dst, `LD32(esp)`);
                if (!w) return reject(`write: pop ${dstText}`);
                lines.push(w, `esp += 4u;`);
                continue;
            }

            let resultExpr: string | null = null;

            if (mnemonic === "mov" || mnemonic === "movzx") {
                if (!srcText) return reject(`${mnemonic} missing source`);
                const src = parseOperand(srcText);
                if (!src) return reject(`operand: ${mnemonic} ${srcText}`);
                resultExpr = readExpr(src);
            }
            else if (mnemonic === "movsx") {
                if (!srcText) return reject("movsx missing source");
                const src = parseOperand(srcText);
                if (!src || src.kind === "imm") return reject(`operand: movsx ${srcText}`);
                const raw = readExpr(src);
                if (raw === null) return reject("read: movsx");
                const bits = src.kind === "reg16" || src.width === 2 ? 16 : 8;
                resultExpr = `((uint32_t)(int32_t)(int${bits}_t)(${raw}))`;
            }
            else if (mnemonic === "lea") {
                if (!srcText) return reject("lea missing source");
                const m = /^(?:BYTE|WORD|DWORD|QWORD)?\s*(?:PTR)?\s*\[(.+)\]$/i.exec(srcText.trim());
                if (!m) return reject(`lea form: ${srcText}`);
                resultExpr = parseAddress(m[1]!);
            }
            else if (BINARY[mnemonic]) {
                if (!srcText) return reject(`${mnemonic} missing source`);
                const src = parseOperand(srcText);
                if (!src) return reject(`operand: ${mnemonic} ${srcText}`);
                // Sub-register arithmetic wraps within its width; only the
                // 32-bit forms are modelled here.
                if (dst.kind !== "reg32" && !(dst.kind === "mem" && dst.width === 4)) {
                    if (mnemonic === "and" || mnemonic === "or" || mnemonic === "xor") { /* width-exact by masking below */ }
                    else return reject(`${mnemonic} on a sub-register`);
                }
                const a = readExpr(dst), b = readExpr(src);
                if (a === null || b === null) return reject(`read: ${mnemonic}`);
                const expr = BINARY[mnemonic]!(a, b);
                if (isProducer) {
                    lines.push(`fa = (uint32_t)(${expr}); fb = 0u;`);
                    liveFlagSites++;
                    const w = writeStmt(dst, "fa");
                    if (!w) return reject(`write: ${mnemonic}`);
                    lines.push(w);
                    continue;
                }
                resultExpr = expr;
            }
            else if (mnemonic === "inc" || mnemonic === "dec") {
                if (dst.kind !== "reg32" && !(dst.kind === "mem" && dst.width === 4)) return reject(`${mnemonic} on a sub-register`);
                const a = readExpr(dst);
                if (a === null) return reject(`read: ${mnemonic}`);
                const expr = `(${a} ${mnemonic === "inc" ? "+" : "-"} 1u)`;
                if (isProducer) {
                    lines.push(`fa = (uint32_t)(${expr}); fb = 0u;`);
                    liveFlagSites++;
                    const w = writeStmt(dst, "fa");
                    if (!w) return reject(`write: ${mnemonic}`);
                    lines.push(w);
                    continue;
                }
                resultExpr = expr;
            }
            else if (mnemonic === "neg" || mnemonic === "not") {
                if (dst.kind !== "reg32" && !(dst.kind === "mem" && dst.width === 4)) return reject(`${mnemonic} on a sub-register`);
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

        const exitAt = (addr: number) => [
            `ip = ${addr >>> 0}u;`,
            `goto exit;`,
        ];

        if (term.mnemonic === "ret" || term.mnemonic === "retn") {
            const imm = term.operand.trim();
            const pops = imm ? Number(imm) : 0;
            if (!Number.isFinite(pops)) return reject(`ret ${imm}`);
            lines.push(`ip = LD32(esp);`, `esp += ${4 + pops}u;`, `goto exit;`);
        }
        else if (term.mnemonic === "jmp") {
            const target = directTarget(term.operand)!;
            const bi = indexOf.get(target);
            if (bi === undefined) return reject("jmp outside the function");
            if (target <= term.addr) lines.push(`if (++loops > ${LOOP_LIMIT}u) { ${exitAt(target).join(" ")} }`);
            lines.push(`b = ${bi}; continue;`);
        }
        else if (COND_BRANCH.has(term.mnemonic)) {
            const producer = block.insns[producerIdx]!.mnemonic;
            const cond = conditionExpr(term.mnemonic, producer);
            if (cond === null) return reject(`${term.mnemonic} after ${producer}`);
            const target = directTarget(term.operand)!;
            const taken = indexOf.get(target);
            const fall = indexOf.get(term.addr + term.size);
            if (taken === undefined || fall === undefined) return reject("branch outside the function");
            const backEdge = target <= term.addr ? `if (++loops > ${LOOP_LIMIT}u) { ${exitAt(target).join(" ")} } ` : "";
            lines.push(`if (${cond}) { ${backEdge}b = ${taken}; continue; }`, `b = ${fall}; continue;`);
        }
        else {
            const fall = indexOf.get(term.addr + term.size);
            if (fall === undefined) return reject("fallthrough outside the function");
            lines.push(`b = ${fall}; continue;`);
        }

        out.push(`        case ${indexOf.get(start)}: {\n${lines.map((l) => "            " + l).join("\n")}\n        }`);
    }

    if (out.length === 0) return reject("empty body");

    const name = `fn_${entry.toString(16)}`;
    const loads = REG32.map((r, i) => `    uint32_t ${r} = (uint32_t)REG32[${i}];`).join("\n");
    const stores = REG32.map((r, i) => `    REG32[${i}] = (int32_t)${r};`).join("\n");
    const c =
        `__attribute__((export_name("${name}")))\n` +
        `void ${name}(int32_t initial_state)\n{\n` +
        `    (void)initial_state;\n` +
        `    const uint32_t mb = mem_base();\n` +
        `${loads}\n` +
        `    uint32_t fa = 0u, fb = 0u, cnt = 0u, loops = 0u, ip = 0u;\n` +
        `    int b = 0;\n` +
        `    for (;;) switch (b) {\n${out.join("\n")}\n` +
        `        default: ip = ${entry >>> 0}u; goto exit;\n    }\n` +
        `exit:\n${stores}\n` +
        `    *PREVIOUS_IP = (int32_t)ip;\n` +
        `    *INSTRUCTION_POINTER = (int32_t)ip;\n` +
        `    *INSTRUCTION_COUNTER += cnt;\n` +
        `}\n`;

    return { entry, name, c, instructions: total, blocks: blocks.size, liveFlagSites, extent: maxEnd - entry };
}
