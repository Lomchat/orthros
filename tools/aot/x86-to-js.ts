/**
 * Translate a straight-line x86 leaf function into JavaScript.
 *
 * The runtime JIT already keeps registers in locals inside a module, so simply
 * pre-compiling guest code buys little. What it cannot skip is the lazy-flag
 * bookkeeping it emits for every arithmetic instruction, because a later block
 * it has not seen might read the flags. A whole-function translation knows the
 * answer: x86 calling conventions make flags caller-clobbered, so for a leaf
 * that ends in `ret` and contains no flag reader, every flag update is dead and
 * costs nothing to emit.
 *
 * Scope is deliberately narrow and the failure mode is deliberately blunt:
 * anything not fully understood returns null and the guest's own code keeps
 * running. Guessing at an addressing mode would produce a function that is
 * wrong in a way no test here would notice.
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
    /** Registers the body reads before writing; the caller must supply them. */
    readsEsp: boolean;
}

const REG32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const REG16 = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"];
const REG8_LOW = ["al", "cl", "dl", "bl"];
const REG8_HIGH = ["ah", "ch", "dh", "bh"];

/** Instructions whose only effect is on flags — dead in a flag-free leaf. */
const FLAG_ONLY = new Set(["cmp", "test"]);

/** Control flow: this translator emits straight-line code only. Separate from
 *  the flag readers below because the two need different work to lift — blocks
 *  and a CFG, versus a flag model — and conflating them hides which is the real
 *  blocker. */
const CONTROL_FLOW = /^(j[a-z]+|loop[a-z]*)$/;

/** Reads flags, which this translator does not model. */
const READS_FLAGS = /^(set[a-z]+|cmov[a-z]+|adc|sbb|rcl|rcr|salc|lahf)$/;

function regIndex(name: string): number | null {
    const i = REG32.indexOf(name);
    return i >= 0 ? i : null;
}

interface Operand {
    kind: "reg32" | "reg16" | "reg8lo" | "reg8hi" | "imm" | "mem";
    /** reg index for register forms */
    index?: number;
    value?: number;
    /** For mem: a JS expression computing the effective address. */
    addr?: string;
    /** For mem: access width in bytes. */
    width?: number;
}

/** Parse one Intel-syntax operand. Returns null for anything unmodelled. */
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
        // A segment override needs the segment base, which this translator does
        // not track. fs:/gs: in particular are thread-local and never constant.
        if (mem[2] && mem[2].toLowerCase() !== "ds") return null;
        const addr = parseAddress(mem[3]!);
        if (addr === null) return null;
        return { kind: "mem", addr, width };
    }
    return null;
}

/** Build a JS expression for `[base + index*scale + disp]`. */
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

/**
 * Translate one straight-line leaf. Returns null when anything is outside the
 * modelled subset — which is the safe answer, not a fallback to guesswork.
 */
function reject(reason: string): null { lastRejection = reason; return null; }

export function translateStraightLineLeaf(insns: Insn[], entry: number): Translation | null {
    lastRejection = "";
    const lines: string[] = [];
    let count = 0;
    let readsEsp = false;

    for (const insn of insns) {
        const { mnemonic, operand } = insn;
        count++;

        if (mnemonic === "ret" || mnemonic === "retn") break;
        if (mnemonic === "nop") continue;
        if (CONTROL_FLOW.test(mnemonic)) return reject(`control flow: ${mnemonic}`);
        if (READS_FLAGS.test(mnemonic)) return reject(`reads flags: ${mnemonic}`);
        // Flags are caller-clobbered, so a compare whose result nothing reads is
        // pure overhead — the JIT emits its lazy-flag stores for it regardless.
        if (FLAG_ONLY.has(mnemonic)) continue;

        const commaIdx = splitOperands(operand);
        const dstText = commaIdx === null ? operand : operand.slice(0, commaIdx);
        const srcText = commaIdx === null ? null : operand.slice(commaIdx + 1);

        if (mnemonic === "leave" || mnemonic === "cdq" || mnemonic === "cwde") return reject(mnemonic);

        const dst = parseOperand(dstText);
        if (!dst) return reject(`operand: ${mnemonic} ${dstText}`);
        if (mnemonic === "pop" && dst.kind === "mem" && dst.addr!.includes("esp")) {
            // [esp]-relative destination while esp is moving: the effective
            // address would be computed against the wrong value.
            return reject("pop into esp-relative memory");
        }
        if (mnemonic === "push") {
            const src = parseOperand(dstText);
            if (!src) return reject(`operand: push ${dstText}`);
            const v = readExpr(src);
            if (v === null) return reject(`read: push ${dstText}`);
            lines.push(`esp = (esp - 4) | 0;`);
            lines.push(`dv.setInt32(esp >>> 0, (${v}) | 0, true);`);
            continue;
        }
        if (mnemonic === "pop") {
            const w = writeStmt(dst, `dv.getInt32(esp >>> 0, true)`);
            if (!w) return reject(`write: pop ${dstText}`);
            lines.push(w);
            lines.push(`esp = (esp + 4) | 0;`);
            continue;
        }
        if (dst.kind === "mem" && dst.addr!.includes("esp")) readsEsp = true;

        if (mnemonic === "mov" || mnemonic === "movzx") {
            if (!srcText) return reject(`${mnemonic} missing source`);
            const src = parseOperand(srcText);
            if (!src) return reject(`operand: ${mnemonic} ${srcText}`);
            const value = readExpr(src);
            if (value === null) return reject(`read: ${mnemonic} ${srcText}`);
            const stmt = writeStmt(dst, value);
            if (!stmt) return reject(`write: ${mnemonic} ${dstText}`);
            lines.push(stmt);
            continue;
        }

        if (mnemonic === "movsx") {
            if (!srcText) return reject("movsx missing source");
            const src = parseOperand(srcText);
            if (!src || src.kind === "imm") return reject(`operand: movsx ${srcText}`);
            const raw = readExpr(src);
            if (raw === null) return reject(`read: movsx ${srcText}`);
            const bits = src.kind === "reg16" || src.width === 2 ? 16 : 8;
            const stmt = writeStmt(dst, `((${raw}) << ${32 - bits} >> ${32 - bits})`);
            if (!stmt) return reject(`write: movsx ${dstText}`);
            lines.push(stmt);
            continue;
        }

        if (mnemonic === "lea") {
            if (!srcText) return reject("lea missing source");
            const m = /^(?:BYTE|WORD|DWORD|QWORD)?\s*(?:PTR)?\s*\[(.+)\]$/i.exec(srcText.trim());
            if (!m) return reject(`lea form: ${srcText}`);
            const addr = parseAddress(m[1]!);
            if (addr === null) return reject(`lea address: ${srcText}`);
            const stmt = writeStmt(dst, addr);
            if (!stmt) return reject(`write: lea ${dstText}`);
            lines.push(stmt);
            continue;
        }

        const op = BINARY[mnemonic];
        if (op) {
            if (!srcText) return reject(`${mnemonic} missing source`);
            const src = parseOperand(srcText);
            if (!src) return reject(`operand: ${mnemonic} ${srcText}`);
            const a = readExpr(dst), b = readExpr(src);
            if (a === null || b === null) return reject(`read: ${mnemonic}`);
            const stmt = writeStmt(dst, op(a, b));
            if (!stmt) return reject(`write: ${mnemonic} ${dstText}`);
            lines.push(stmt);
            continue;
        }

        if (mnemonic === "inc" || mnemonic === "dec") {
            const a = readExpr(dst);
            if (a === null) return reject(`read: ${mnemonic}`);
            const stmt = writeStmt(dst, `(${a} ${mnemonic === "inc" ? "+" : "-"} 1)`);
            if (!stmt) return reject(`write: ${mnemonic}`);
            lines.push(stmt);
            continue;
        }

        if (mnemonic === "neg" || mnemonic === "not") {
            const a = readExpr(dst);
            if (a === null) return reject(`read: ${mnemonic}`);
            const stmt = writeStmt(dst, mnemonic === "neg" ? `(0 - ${a})` : `(~${a})`);
            if (!stmt) return reject(`write: ${mnemonic}`);
            lines.push(stmt);
            continue;
        }

        return reject(`unsupported: ${mnemonic}`);
    }

    if (lines.length === 0) return reject("empty body");

    const prologue = REG32.map((r, i) => `let ${r} = r[${i}] | 0;`).join("\n");
    const epilogue = REG32.map((r, i) => `r[${i}] = ${r} | 0;`).join("\n");
    return {
        entry,
        js: `${prologue}\n${lines.join("\n")}\n${epilogue}\n`,
        instructions: count,
        readsEsp,
    };
}

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
