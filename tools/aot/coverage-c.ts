/**
 * How much of a recorded hot profile can the C translator take today?
 *
 * Every entry point of a HOTP image is a block start the runtime actually
 * dispatched to. Each is offered to the translator as a function entry; the
 * ones it accepts are the candidates for the external-module batch, ranked
 * here by instruction count. Rejections are tallied by reason so the next
 * extension of the subset is chosen on evidence.
 *
 *   bun tools/aot/coverage-c.ts <exe> <profile.hotp> [--base 0x400000]
 *       [--out /tmp/aot-candidates.json] [--limit N]
 */

import { CapstoneDecoder } from "./decoder-capstone";
import { lastRejection, translateFunctionC } from "./x86-to-c";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const exe = process.argv[2];
const profilePath = process.argv[3];
if (!exe || !profilePath) { console.error("usage: coverage-c.ts <exe> <profile.hotp>"); process.exit(2); }
const out = arg("out", "");
const limit = Number(arg("limit", "0"));

const bytes = new Uint8Array(await Bun.file(profilePath).arrayBuffer());
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (dv.getUint32(0, true) !== 0x50544f48) { console.error("not a HOTP image"); process.exit(2); }
const count = dv.getUint32(8, true);
const entries: number[] = [];
let i = 12;
for (let k = 0; k < count; k++) {
    const page = dv.getUint32(i, true);
    const n = dv.getUint32(i + 8, true);
    i += 12;
    for (let e = 0; e < n; e++) entries.push(((page << 12) >>> 0) + (dv.getUint16(i + 2 * e, true) & 0xfff));
    i += (2 * n + 3) & ~3;
}
entries.sort((a, b) => a - b);

const decoder = await CapstoneDecoder.open(exe);
const reasons = new Map<string, number>();
const accepted: Array<{ entry: number; instructions: number; blocks: number; liveFlagSites: number }> = [];
let inText = 0;
const t0 = performance.now();
for (const [k, entry] of entries.entries()) {
    if (limit > 0 && k >= limit) break;
    if (!decoder.inText(entry)) continue;
    inText++;
    const t = await translateFunctionC(decoder, entry);
    if (t) {
        accepted.push({ entry, instructions: t.instructions, blocks: t.blocks, liveFlagSites: t.liveFlagSites });
    } else {
        // Normalise the reason so operands do not split the tally.
        const key = lastRejection.replace(/0x[0-9a-f]+/g, "0x…").replace(/\b(e[abcd]x|e[sd]i|e[bs]p)\b/g, "r").slice(0, 60);
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
}
accepted.sort((a, b) => b.instructions - a.instructions);

const insns = accepted.reduce((s, a) => s + a.instructions, 0);
console.log(`profile entries=${entries.length} inText=${inText} translatable=${accepted.length} (${(100 * accepted.length / Math.max(1, inText)).toFixed(1)}%) instructions=${insns} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log("top rejections:");
for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(6)}  ${reason}`);
}
if (out) {
    await Bun.write(out, JSON.stringify({ exe, profile: profilePath, accepted }, null, 1));
    console.log(`wrote ${accepted.length} candidates to ${out}`);
}
