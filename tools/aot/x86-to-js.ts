/**
 * Translate an x86 leaf function into JavaScript.
 *
 * The runtime JIT already keeps registers in locals inside a module, so simply
 * pre-compiling guest code buys little. What it cannot skip is the lazy-flag
 * bookkeeping it emits for every arithmetic instruction, because a block it has
 * not seen might read the flags. A whole-function translation knows the answer:
 * flags are caller-clobbered, so a flag update is dead unless some path from it
 * reaches a reader before another writer. In compiler output that is nearly
 * always a `cmp`/`test` immediately followed by its branch; every other flag
 * update costs nothing to emit.
 *
 * Control flow becomes a block-indexed loop rather than structured JavaScript.
 * Recovering `if`/`while` from a CFG needs a relooper, and a switch over block
 * indices is correct for every shape without one.
 *
 * The failure mode is deliberately blunt. An unmodelled opcode, an addressing
 * form, a flag producer this does not know, a branch leaving the decoded extent
 * — any of them declines the whole function and the guest's own code keeps
 * running. Guessing would produce a function wrong in a way nothing here would
 * notice.
 */

export interface Insn {
    addr: number;
    mnemonic: string;
    operand: string;
    size: number;
}

/** Why a function was declined, so the subset can be extended on evidence
 *  rather than on guesses about what a binary contains. */
export let lastRejection = "";

export interface Translation {
    entry: number;
    /** Body of a function taking (r, dv) — registers as Int32Array, memory as DataView. */
    js: string;
    instructions: number;
    blocks: number;
    /** Flag producers whose result a branch actually consumed. */
    liveFlagSites: number;
}

const REG32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const REG16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const REG8_LOW = ["al", "cl", "dl", "bl"];
const REG8_HIGH = ["ah", "ch", "dh", "bh"];

const COND_BRANCH = new Set([
    "je", "jz", "jne", "jnz", "jl", "jnge", "jle", "jng", "jg", "jnle", "jge", "jnl",
    "jb", "jnae", "jc", "jbe", "jna", "ja", "jnbe", "jae", "jnb", "jnc", "js", "jns",
]);

/** Producers whose flags this translator can reproduce. */
const FLAG_PRODUCER = new Set(["cmp", "test", "sub", "add", "and", "or", "xor", "inc", "dec"]);

/** Reads flags but is not a conditional branch — not modelled. */
const OTHER_FLAG_READER = /^(set[a-z]+|cmov[a-z]+|adc|sbb|rcl|rcr|salc|lahf)$/;

function regIndex(name: string): number | null {
    const i = REG32.indexOf(name);
    return i >= 0 ? i : null;
}

interface Operand {
    kind: "reg32" | "reg16" | "reg8lo" | "reg8hi" | "imm" | "mem";
    index?: number;
    value?: number;
    addr?: string;
    width?: number;
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
        // A segment override needs the segment base, which is not tracked here;
        // fs:/gs: in particular are thread-local and never constant.
        if (mem[2] && mem[2].toLowerCase() !== "ds") return null;
        const addr = parseAddress(mem[3]!);
        if (addr === null) return null;
        return { kind: "mem", addr, width };
    }
    return null;
}

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
                parts.push(`(${REG32[r]} * ${scaled[2]})`);
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
    if (disp !== 0) parts.push(String(disp | 0));
    if (parts.length === 0) return null;
    return `((${parts.join(" + ")}) >>> 0)`;
}

function readExpr(op: Operand): string | null {
    switch (op.kind) {
        case "reg32": return REG32[op.index!]!;
        case "reg16": return `(${REG32[op.index!]} & 0xffff)`;
        case "reg8lo": return `(${REG32[op.index!]} & 0xff)`;
        case "reg8hi": return `((${REG32[op.index!]} >>> 8) & 0xff)`;
        case "imm": return String(op.value! | 0);
        case "mem":
            if (op.width === 1) return `dv.getUint8(${op.addr})`;
            if (op.width === 2) return `dv.getUint16(${op.addr}, true)`;
            if (op.width === 4) return `dv.getInt32(${op.addr}, true)`;
            return null;
        default: return null;
    }
}

function writeStmt(op: Operand, valueExpr: string): string | null {
    switch (op.kind) {
        case "reg32": return `${REG32[op.index!]} = (${valueExpr}) | 0;`;
        case "reg16": {
            const r = REG32[op.index!]!;
            return `${r} = ((${r} & ~0xffff) | ((${valueExpr}) & 0xffff)) | 0;`;
        }
        case "reg8lo": {
            const r = REG32[op.index!]!;
            return `${r} = ((${r} & ~0xff) | ((${valueExpr}) & 0xff)) | 0;`;
        }
        case "reg8hi": {
            const r = REG32[op.index!]!;
            return `${r} = ((${r} & ~0xff00) | (((${valueExpr}) & 0xff) << 8)) | 0;`;
        }
        case "mem":
            if (op.width === 1) return `dv.setUint8(${op.addr}, (${valueExpr}) & 0xff);`;
            if (op.width === 2) return `dv.setUint16(${op.addr}, (${valueExpr}) & 0xffff, true);`;
            if (op.width === 4) return `dv.setInt32(${op.addr}, (${valueExpr}) | 0, true);`;
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
    shl: (a, b) => `(${a} << (${b} & 31))`,
    shr: (a, b) => `(${a} >>> (${b} & 31))`,
    sar: (a, b) => `(${a} >> (${b} & 31))`,
    imul: (a, b) => `Math.imul(${a}, ${b})`,
};

function reject(reason: string): null { lastRejection = reason; return null; }

function directTarget(operand: string): number | null {
    const m = /^0?x?([0-9a-f]+)\b/.exec(operand.trim());
    if (!m) return null;
    const v = parseInt(m[1]!, 16);
    return Number.isFinite(v) ? v : null;
}

/**
 * Condition for a branch, given the producer that set the flags. `fa`/`fb` hold
 * the producer's operands rather than a reconstructed flag word, which keeps the
 * signed and unsigned forms exact without modelling CF and OF.
 */
function conditionExpr(branch: string, producer: string): string | null {
    const logical = producer === "test" || producer === "and" || producer === "or" || producer === "xor";
    // A logical producer clears CF and OF, so only the zero and sign forms mean
    // anything after one; a carry form would be asking about a flag it did not set.
    const z = logical ? `((fa & fb) === 0)` : `(fa === fb)`;
    const sign = logical ? `(((fa & fb) | 0) < 0)` : `(((fa - fb) | 0) < 0)`;
    switch (branch) {
        case "je": case "jz": return z;
        case "jne": case "jnz": return `!${z}`;
        case "js": return sign;
        case "jns": return `!${sign}`;
        default: break;
    }
    if (logical) {
        // test/and/or/xor clear CF and OF, so the carry and overflow forms
        // collapse to the zero and sign ones rather than being unmodellable.
        switch (branch) {
            case "jbe": case "jna": return z;                 // CF|ZF -> ZF
            case "ja": case "jnbe": return `!${z}`;
            case "jb": case "jnae": case "jc": return "false"; // CF is always 0
            case "jae": case "jnb": case "jnc": return "true";
            case "jle": case "jng": return `(${z} || ${sign})`; // ZF | (SF^OF), OF=0
            case "jg": case "jnle": return `(!${z} && !${sign})`;
            case "jl": case "jnge": return sign;               // SF^OF, OF=0
            case "jge": case "jnl": return `!${sign}`;
            default: return null;
        }
    }
    switch (branch) {
        case "jl": case "jnge": return `((fa | 0) < (fb | 0))`;
        case "jle": case "jng": return `((fa | 0) <= (fb | 0))`;
        case "jg": case "jnle": return `((fa | 0) > (fb | 0))`;
        case "jge": case "jnl": return `((fa | 0) >= (fb | 0))`;
        case "jb": case "jnae": case "jc": return `((fa >>> 0) < (fb >>> 0))`;
        case "jbe": case "jna": return `((fa >>> 0) <= (fb >>> 0))`;
        case "ja": case "jnbe": return `((fa >>> 0) > (fb >>> 0))`;
        case "jae": case "jnb": case "jnc": return `((fa >>> 0) >= (fb >>> 0))`;
        default: return null;
    }
}

interface Block { start: number; insns: Insn[]; }

/** Index of the operand-separating comma, ignoring commas inside brackets. */
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

export function translateFunction(insns: Insn[], entry: number): Translation | null {
    lastRejection = "";
    const byAddr = new Map<number, Insn>();
    for (const i of insns) byAddr.set(i.addr, i);

    // Every address a branch can land on starts a block, so a block is never
    // entered halfway with flag state the emitter did not account for.
    const leaders = new Set<number>([entry]);
    {
        const walked = new Set<number>();
        const work = [entry];
        while (work.length > 0) {
            let pc = work.pop()!;
            for (;;) {
                if (walked.has(pc)) break;
                walked.add(pc);
                const insn = byAddr.get(pc);
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
    for (const start of leaders) {
        const body: Insn[] = [];
        let pc = start;
        for (;;) {
            const insn = byAddr.get(pc);
            if (!insn) return reject(`no instruction at 0x${pc.toString(16)}`);
            body.push(insn);
            const m = insn.mnemonic;
            if (m === "ret" || m === "retn" || m === "jmp" || COND_BRANCH.has(m)) break;
            pc += insn.size;
            if (leaders.has(pc)) break;   // the next block starts here
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

        // Flags are materialised only when this block's own terminator consumes
        // them, and only from the last producer before it. That is what compiler
        // output looks like, and it is what makes every other update dead.
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

            // cmp and test exist only for their flags: emit them when the branch
            // consumes them, drop them entirely otherwise.
            if (mnemonic === "cmp" || mnemonic === "test") {
                if (!isProducer) continue;
                if (!srcText) return reject(`${mnemonic} missing source`);
                const a = parseOperand(dstText), b = parseOperand(srcText);
                if (!a || !b) return reject(`operand: ${mnemonic} ${operand}`);
                const ra = readExpr(a), rb = readExpr(b);
                if (ra === null || rb === null) return reject(`read: ${mnemonic}`);
                lines.push(`fa = (${ra}) | 0; fb = (${rb}) | 0;`);
                liveFlagSites++;
                continue;
            }

            const dst = parseOperand(dstText);
            if (!dst) return reject(`operand: ${mnemonic} ${dstText}`);

            if (mnemonic === "push") {
                const v = readExpr(dst);
                if (v === null) return reject(`read: push ${dstText}`);
                lines.push(`esp = (esp - 4) | 0;`, `dv.setInt32(esp >>> 0, (${v}) | 0, true);`);
                continue;
            }
            if (mnemonic === "pop") {
                if (dst.kind === "mem" && dst.addr!.includes("esp")) return reject("pop into esp-relative memory");
                const w = writeStmt(dst, `dv.getInt32(esp >>> 0, true)`);
                if (!w) return reject(`write: pop ${dstText}`);
                lines.push(w, `esp = (esp + 4) | 0;`);
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
                resultExpr = `((${raw}) << ${32 - bits} >> ${32 - bits})`;
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
                const a = readExpr(dst), b = readExpr(src);
                if (a === null || b === null) return reject(`read: ${mnemonic}`);
                const expr = BINARY[mnemonic]!(a, b);
                if (isProducer) {
                    // The branch tests this result against zero, so present it to
                    // conditionExpr in the same shape a `cmp x, 0` would.
                    lines.push(`fa = (${expr}) | 0; fb = 0;`);
                    liveFlagSites++;
                    const w = writeStmt(dst, "fa");
                    if (!w) return reject(`write: ${mnemonic}`);
                    lines.push(w);
                    continue;
                }
                resultExpr = expr;
            }
            else if (mnemonic === "inc" || mnemonic === "dec") {
                const a = readExpr(dst);
                if (a === null) return reject(`read: ${mnemonic}`);
                const expr = `(${a} ${mnemonic === "inc" ? "+" : "-"} 1)`;
                if (isProducer) {
                    lines.push(`fa = (${expr}) | 0; fb = 0;`);
                    liveFlagSites++;
                    const w = writeStmt(dst, "fa");
                    if (!w) return reject(`write: ${mnemonic}`);
                    lines.push(w);
                    continue;
                }
                resultExpr = expr;
            }
            else if (mnemonic === "neg" || mnemonic === "not") {
                const a = readExpr(dst);
                if (a === null) return reject(`read: ${mnemonic}`);
                resultExpr = mnemonic === "neg" ? `(0 - ${a})` : `(~${a})`;
            }
            else return reject(`unsupported: ${mnemonic}`);

            if (resultExpr === null) return reject(`operand: ${mnemonic} ${operand}`);
            const stmt = writeStmt(dst, resultExpr);
            if (!stmt) return reject(`write: ${mnemonic} ${dstText}`);
            lines.push(stmt);
        }

        if (term.mnemonic === "ret" || term.mnemonic === "retn") {
            lines.push("return;");
        }
        else if (term.mnemonic === "jmp") {
            const bi = indexOf.get(directTarget(term.operand)!);
            if (bi === undefined) return reject("jmp outside the function");
            lines.push(`b = ${bi}; continue;`);
        }
        else if (COND_BRANCH.has(term.mnemonic)) {
            const producer = block.insns[producerIdx]!.mnemonic;
            const cond = conditionExpr(term.mnemonic, producer);
            if (cond === null) return reject(`${term.mnemonic} after ${producer}`);
            const taken = indexOf.get(directTarget(term.operand)!);
            const fall = indexOf.get(term.addr + term.size);
            if (taken === undefined || fall === undefined) return reject("branch outside the function");
            lines.push(`if (${cond}) { b = ${taken}; continue; }`, `b = ${fall}; continue;`);
        }
        else {
            const fall = indexOf.get(term.addr + term.size);
            if (fall === undefined) return reject("fallthrough outside the function");
            lines.push(`b = ${fall}; continue;`);
        }

        out.push(`case ${indexOf.get(start)}: {\n${lines.map((l) => "    " + l).join("\n")}\n}`);
    }

    if (out.length === 0) return reject("empty body");

    const prologue = REG32.map((r, i) => `let ${r} = r[${i}] | 0;`).join("\n");
    const epilogue = REG32.map((r, i) => `r[${i}] = ${r} | 0;`).join("\n");
    // The register write-back sits in `finally` so a faulting memory access
    // leaves the caller with the state the guest would have had at that point,
    // rather than with the values it passed in.
    const js =
        `${prologue}\n` +
        `let fa = 0, fb = 0, b = 0;\n` +
        `try {\n` +
        `  for (;;) { switch (b) {\n${out.join("\n")}\n` +
        `    default: return;\n  } }\n` +
        `} finally {\n${epilogue}\n}\n`;

    return { entry, js, instructions: total, blocks: blocks.size, liveFlagSites };
}

/** Kept for callers that only ask for the simple shape; the CFG translator
 *  handles a single block as a degenerate case. */
export function translateStraightLineLeaf(insns: Insn[], entry: number): Translation | null {
    return translateFunction(insns, entry);
}
