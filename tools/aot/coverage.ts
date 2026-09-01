/**
 * How much of the hot path could a translator cover, under three policies?
 *
 * Leaf-only translation is verified and 3.8-22x faster than the JIT, and reaches
 * 5 of the 331 function entries inside the pages the in-game profile names as
 * hot. The blockers there are what C++ game code is made of: virtual calls
 * through vtables, jump tables, and calls in general. So the question is not
 * whether translation is fast — that is measured — but whether relaxing those
 * two restrictions buys enough coverage to matter.
 *
 * The policies, in increasing order of what the runtime would have to support:
 *
 *   leaf      no calls at all — what exists today
 *   direct    a direct call is fine when its callee also qualifies
 *   dispatch  an indirect call or jump becomes a table lookup: call the
 *             translated target if there is one, otherwise re-enter the emulator
 *
 * Only the third can reach virtual dispatch, and only it justifies the machinery
 * a dispatch table needs — so its number decides whether that work is worth
 * starting.
 *
 *   bun tools/aot/coverage.ts <exe> [--pages 0x426000,...] [--sample 400]
 */

import { Decoder, directTarget, type Insn } from "./decode";

type Policy = "leaf" | "direct" | "dispatch";

const SUPPORTED = new Set([
    "mov", "movzx", "movsx", "lea", "push", "pop", "xchg",
    "add", "sub", "inc", "dec", "neg", "not", "imul",
    "and", "or", "xor", "shl", "shr", "sar", "test", "cmp", "nop",
]);

const COND = /^j(?!mp$)[a-z]+$/;

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const exe = process.argv[2];
if (!exe) { console.error("usage: coverage.ts <exe> [--pages a,b] [--sample N]"); process.exit(2); }
const sample = Number(arg("sample", "400"));
const pagesArg = arg("pages", "");

const dec = await Decoder.open(exe);

/**
 * Does `entry` translate under `policy`? Memoised per policy, and recursive
 * calls assume success while in progress so a cycle does not disqualify itself.
 */
const memo = new Map<string, boolean>();
async function translatable(entry: number, policy: Policy, depth = 0): Promise<boolean> {
    const key = `${policy}:${entry}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (depth > 8) return false;
    memo.set(key, true);                       // optimistic for recursion

    const body = await dec.functionBody(entry);
    if (!body) { memo.set(key, false); return false; }

    for (const insn of body) {
        const { mnemonic, operand } = insn;
        if (mnemonic === "ret" || mnemonic === "retn" || COND.test(mnemonic)) continue;
        if (mnemonic === "jmp") {
            if (directTarget(operand) !== null) continue;
            // An indirect jump is a jump table; only a dispatch table can take it.
            if (policy !== "dispatch") { memo.set(key, false); return false; }
            continue;
        }
        if (mnemonic === "call") {
            const t = directTarget(operand);
            if (t === null) {
                if (policy !== "dispatch") { memo.set(key, false); return false; }
                continue;
            }
            if (policy === "leaf") { memo.set(key, false); return false; }
            // Under dispatch, an unqualified callee is still reachable through
            // the table, so it does not disqualify the caller.
            if (policy === "direct" && !(await translatable(t, "direct", depth + 1))) {
                memo.set(key, false); return false;
            }
            continue;
        }
        if (!SUPPORTED.has(mnemonic)) { memo.set(key, false); return false; }
    }
    return true;
}

// Function entries: direct call targets that land on a decodable instruction.
const entries = new Set<number>();
{
    const seed = await dec.functionBody(0x401000, 200_000);
    void seed;
    // Sweep call sites by decoding windows across .text; the decoder keeps each
    // window, so this doubles as warming the cache.
    for (let a = 0x401000; a < 0x1073000; a += 16 * 1024) {
        const insn = await dec.at(a);
        void insn;
    }
    for (const [, insn] of (dec as unknown as { cache: Map<number, Insn> }).cache) {
        if (insn.mnemonic !== "call") continue;
        const t = directTarget(insn.operand);
        if (t !== null && dec.inText(t)) entries.add(t);
    }
}
console.log(`function entries discovered: ${entries.size.toLocaleString()}`);

const pages = pagesArg
    ? pagesArg.split(",").map((p) => Number(p))
    : [];

async function report(label: string, list: number[]): Promise<void> {
    const counts: Record<Policy, number> = { leaf: 0, direct: 0, dispatch: 0 };
    for (const e of list) {
        for (const p of ["leaf", "direct", "dispatch"] as Policy[]) {
            if (await translatable(e, p)) counts[p]++;
        }
    }
    const pct = (n: number) => list.length > 0 ? `${(n * 100 / list.length).toFixed(1)}%` : "n/a";
    console.log(`${label}: ${list.length} entries — leaf ${counts.leaf} (${pct(counts.leaf)})`
        + `, direct ${counts.direct} (${pct(counts.direct)})`
        + `, dispatch ${counts.dispatch} (${pct(counts.dispatch)})`);
}

if (pages.length > 0) {
    const hot: number[] = [];
    for (const page of pages) {
        for (const e of entries) if (e >= page && e < page + 0x1000) hot.push(e);
    }
    await report("hot pages", hot.sort((a, b) => a - b));
}

const all = [...entries].sort((a, b) => a - b);
const step = Math.max(1, Math.floor(all.length / sample));
await report(`whole image (every ${step}th entry)`, all.filter((_, i) => i % step === 0));
