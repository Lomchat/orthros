/**
 * Offline function discovery and translatability analysis for a guest PE.
 *
 * The runtime JIT compiles per 4 KB page, at most three pages per module, and
 * cannot keep a register in a local across a call — measured in game at 3.65
 * instructions per executed block and 187,000 dispatcher re-entries per second.
 * Translating whole functions ahead of time is the only route to a different
 * multiplier, and this is its first stage: decide, per function, whether it can
 * be translated at all.
 *
 * Static coverage of lotrbfme.exe justified building this: of 3.13M real
 * instructions (excluding int3 padding), 92.8% fall in a ~60-mnemonic integer
 * and branch subset, 4.6% are x87, and 86.7% of control transfers are direct.
 *
 * A function qualifies when every instruction is in the subset and every
 * control transfer is either internal or a direct call. Anything else — an
 * indirect jump, an unknown mnemonic, a branch out of the function's extent —
 * disqualifies it, and the guest's own code keeps running for it. Nothing here
 * is speculative about correctness: disqualification is the safe answer.
 *
 *   bun tools/aot/analyze-functions.ts <exe> [--base 0x400000] [--top 40]
 *     [--entries 0x426000,0x4cf000]
 */

const TRANSLATABLE = new Set([
    "mov", "movzx", "movsx", "lea", "push", "pop", "xchg",
    "add", "sub", "adc", "sbb", "inc", "dec", "neg", "imul", "mul", "div", "idiv",
    "and", "or", "xor", "not", "shl", "shr", "sar", "rol", "ror", "test", "cmp",
    "cdq", "cwde", "nop", "leave",
    "sete", "setne", "setl", "setle", "setg", "setge",
    "setb", "setbe", "seta", "setae", "sets", "setns",
    "cmove", "cmovne", "cmovl", "cmovle", "cmovg", "cmovge", "cmovb", "cmovbe",
]);

const COND_BRANCH = new Set([
    "je", "jne", "jl", "jle", "jg", "jge", "jb", "jbe", "ja", "jae",
    "js", "jns", "jo", "jno", "jp", "jnp", "jz", "jnz", "jc", "jnc",
]);

/** x87 is translatable in principle — v86 already owns the softfloat helpers —
 *  but not in this first stage, so it is reported separately rather than hidden
 *  inside the disqualified pile. */
function isX87(mnemonic: string): boolean {
    return mnemonic.startsWith("f") && !COND_BRANCH.has(mnemonic);
}

interface Insn {
    addr: number;
    mnemonic: string;
    operand: string;
    size: number;
}

type Reason = "ok" | "x87" | "indirect" | "unknown" | "runaway" | "no-return";

interface FunctionReport {
    entry: number;
    instructions: number;
    blocks: number;
    reason: Reason;
    detail?: string;
    /** A function that calls nothing needs no interop with the emulator at all:
     *  registers in, registers out, memory in between. Every hand-written HLE
     *  handler in this repo replaces exactly this shape. */
    leaf: boolean;
    memoryOps: number;
}

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const exe = process.argv[2];
if (!exe) {
    console.error("usage: analyze-functions.ts <exe> [--base 0x400000] [--top 40] [--entries a,b]");
    process.exit(2);
}
const imageBase = Number(arg("base", "0x400000"));
const topN = Number(arg("top", "40"));

/** objdump is a build-time dependency only: nothing here ships to the browser,
 *  and using a known-correct decoder keeps the first stage about the analysis
 *  rather than about writing an x86 decoder. */
async function disassemble(path: string): Promise<Insn[]> {
    const sections = await new Response(
        Bun.spawn(["objdump", "-h", path]).stdout).text();
    const text = sections.split("\n").find((l) => / \.text\s/.test(l));
    if (!text) throw new Error("no .text section");
    const parts = text.trim().split(/\s+/);
    const size = parseInt(parts[2]!, 16);
    const vma = parseInt(parts[3]!, 16);

    const proc = Bun.spawn([
        "objdump", "-d", "-M", "intel",
        `--start-address=0x${vma.toString(16)}`,
        `--stop-address=0x${(vma + size).toString(16)}`,
        path,
    ], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();

    const insns: Insn[] = [];
    for (const line of out.split("\n")) {
        // "  401000:\t55                   \tpush   ebp"
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const addrPart = line.slice(0, tab).trim();
        if (!addrPart.endsWith(":")) continue;
        const addr = parseInt(addrPart.slice(0, -1), 16);
        if (!Number.isFinite(addr)) continue;
        const rest = line.slice(tab + 1);
        const tab2 = rest.indexOf("\t");
        if (tab2 < 0) continue;
        const bytes = rest.slice(0, tab2).trim();
        const asm = rest.slice(tab2 + 1).trim();
        if (!asm || asm.startsWith("(bad)")) continue;
        const sp = asm.indexOf(" ");
        const mnemonic = sp < 0 ? asm : asm.slice(0, sp);
        const operand = sp < 0 ? "" : asm.slice(sp + 1).trim();
        insns.push({ addr, mnemonic, operand, size: bytes.split(/\s+/).length });
    }
    return insns;
}

/** A direct branch or call target, or null when the operand is register or
 *  memory indirect — which is what forces a fallback to the dispatcher. */
function directTarget(operand: string): number | null {
    const m = /^0?x?([0-9a-f]+)\b/.exec(operand.trim());
    if (!m) return null;
    const v = parseInt(m[1]!, 16);
    return Number.isFinite(v) ? v : null;
}

const insns = await disassemble(exe);
const byAddr = new Map<number, Insn>();
for (const i of insns) byAddr.set(i.addr, i);
console.log(`decoded ${insns.length.toLocaleString()} instructions`);

// Function entries: every direct call target that lands on a decoded
// instruction. Call targets are the most reliable entry evidence in a stripped
// binary — far better than guessing at prologues, which miss anything the
// optimiser reshaped.
const entriesArg = arg("entries", "");
const entries = new Set<number>();
if (entriesArg) {
    for (const e of entriesArg.split(",")) entries.add(Number(e));
}
else {
    for (const i of insns) {
        if (i.mnemonic !== "call") continue;
        const t = directTarget(i.operand);
        if (t !== null && byAddr.has(t)) entries.add(t);
    }
}
console.log(`function entries: ${entries.size.toLocaleString()}`);

const MAX_INSNS = 4096;

function analyze(entry: number): FunctionReport {
    const seen = new Set<number>();
    const queue = [entry];
    let count = 0;
    let blocks = 0;
    let x87 = 0;
    let reason: Reason = "ok";
    let detail: string | undefined;
    let sawReturn = false;
    let calls = 0;
    let memoryOps = 0;

    while (queue.length > 0) {
        let pc = queue.pop()!;
        if (seen.has(pc)) continue;
        blocks++;
        for (;;) {
            if (seen.has(pc)) break;
            const insn = byAddr.get(pc);
            if (!insn) { reason = "runaway"; detail = "fell off"; return { entry, instructions: count, blocks, reason, detail, leaf: calls === 0, memoryOps }; }
            seen.add(pc);
            count++;
            if (count > MAX_INSNS) { reason = "runaway"; detail = "budget"; return { entry, instructions: count, blocks, reason, detail, leaf: calls === 0, memoryOps }; }

            const { mnemonic, operand } = insn;
            const next = pc + insn.size;

            if (mnemonic === "ret" || mnemonic === "retn" || mnemonic === "hlt") { sawReturn = true; break; }
            if (mnemonic === "call") {
                // A direct call leaves this function and comes back; it does not
                // constrain translatability. An indirect one needs the dispatcher.
                if (directTarget(operand) === null) {
                    reason = "indirect"; detail = `call ${operand}`;
                    return { entry, instructions: count, blocks, reason, detail, leaf: false, memoryOps };
                }
                calls++;
                pc = next;
                continue;
            }
            if (mnemonic === "jmp") {
                const t = directTarget(operand);
                if (t === null) { reason = "indirect"; detail = `jmp ${operand}`; return { entry, instructions: count, blocks, reason, detail, leaf: calls === 0, memoryOps }; }
                // A jump to another function's entry is a tail call, not part of
                // this function. Following it merges the two and then runs away
                // through the whole call graph.
                if (t !== entry && entries.has(t)) { sawReturn = true; break; }
                pc = t;
                continue;
            }
            if (COND_BRANCH.has(mnemonic)) {
                const t = directTarget(operand);
                if (t === null) { reason = "indirect"; detail = `${mnemonic} ${operand}`; return { entry, instructions: count, blocks, reason, detail, leaf: calls === 0, memoryOps }; }
                queue.push(t);
                pc = next;
                continue;
            }
            if (operand.includes("PTR")) memoryOps++;
            if (isX87(mnemonic)) { x87++; pc = next; continue; }
            if (!TRANSLATABLE.has(mnemonic)) {
                reason = "unknown"; detail = mnemonic;
                return { entry, instructions: count, blocks, reason, detail, leaf: calls === 0, memoryOps };
            }
            pc = next;
        }
    }

    const leaf = calls === 0;
    if (!sawReturn) return { entry, instructions: count, blocks, reason: "no-return", leaf, memoryOps };
    if (x87 > 0) return { entry, instructions: count, blocks, reason: "x87", detail: `${x87} x87 insns`, leaf, memoryOps };
    return { entry, instructions: count, blocks, reason, leaf, memoryOps };
}

const reports: FunctionReport[] = [];
for (const e of entries) reports.push(analyze(e));

const tally = new Map<Reason, { n: number; insns: number }>();
for (const r of reports) {
    const t = tally.get(r.reason) ?? { n: 0, insns: 0 };
    t.n++; t.insns += r.instructions;
    tally.set(r.reason, t);
}
const totalInsns = reports.reduce((a, r) => a + r.instructions, 0);
console.log(`\nfunctions analysed: ${reports.length.toLocaleString()}  instructions reached: ${totalInsns.toLocaleString()}`);
for (const [reason, t] of [...tally.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${reason.padEnd(10)} ${String(t.n).padStart(7)} functions  ${String(t.insns).padStart(9)} insns  ${(t.insns * 100 / totalInsns).toFixed(1)}%`);
}

const ok = reports.filter((r) => r.reason === "ok").sort((a, b) => b.instructions - a.instructions);
const leaves = ok.filter((r) => r.leaf);
const leafInsns = leaves.reduce((a, r) => a + r.instructions, 0);
console.log(`\ntranslatable LEAF functions (no calls at all): ${leaves.length.toLocaleString()}`
    + `  ${leafInsns.toLocaleString()} insns  ${(leafInsns * 100 / totalInsns).toFixed(1)}% of reached`);
console.log(`largest translatable leaves (top ${topN}):`);
for (const r of leaves.slice(0, topN)) {
    console.log(`  0x${r.entry.toString(16)}  rva 0x${(r.entry - imageBase).toString(16)}  ${String(r.instructions).padStart(5)} insns  ${String(r.blocks).padStart(3)} blocks  ${r.memoryOps} mem`);
}

const runaway = new Map<string, number>();
for (const r of reports) {
    if (r.reason === "runaway" && r.detail) runaway.set(r.detail, (runaway.get(r.detail) ?? 0) + 1);
}
if (runaway.size > 0) {
    console.log("\nrunaway causes:");
    for (const [d, n] of [...runaway.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(6)}  ${d}`);
    }
}

const blockers = new Map<string, number>();
for (const r of reports) {
    if (r.reason === "unknown" && r.detail) blockers.set(r.detail, (blockers.get(r.detail) ?? 0) + 1);
}
if (blockers.size > 0) {
    console.log("\ntop mnemonics blocking translation:");
    for (const [m, n] of [...blockers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`  ${String(n).padStart(6)}  ${m}`);
    }
}
