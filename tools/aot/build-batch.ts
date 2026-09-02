/**
 * Build an ahead-of-time batch for the runtime: translate a candidate list,
 * compile it with clang and write the module plus its manifest.
 *
 *   bun tools/aot/build-batch.ts <exe> --candidates /tmp/aot-candidates.json
 *       --out /srv/bfme/data/bfme1.aot [--take N] [--skip N] [--entries 0x..,0x..]
 *
 * Produces `<out>.wasm` and `<out>.json`. The manifest lists every page
 * module with its export name and the entry addresses in state order, which
 * is all the worker needs: table slot per page, one registration per entry.
 * Verify the same candidates with verify-c.ts before shipping a batch.
 */

import { CapstoneDecoder } from "./decoder-capstone";
import { assembleBatch, lastRejection, translateFunctionC, type CFunction } from "./x86-to-c";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const exe = process.argv[2];
const out = arg("out", "");
if (!exe || !out) { console.error("usage: build-batch.ts <exe> --out <path> [--candidates ...]"); process.exit(2); }

let entries = arg("entries", "").split(",").filter(Boolean).map((e) => Number(e));
const candidatesPath = arg("candidates", "");
if (candidatesPath) {
    const take = Number(arg("take", "1000000"));
    const skip = Number(arg("skip", "0"));
    const list = (JSON.parse(await Bun.file(candidatesPath).text()).accepted as Array<{ entry: number }>);
    entries = entries.concat(list.slice(skip, skip + take).map((c) => c.entry));
}
const decoder = await CapstoneDecoder.open(exe);
const functions: CFunction[] = [];
let skipped = 0;
for (const entry of entries) {
    const t = await translateFunctionC(decoder, entry);
    if (!t) { skipped++; if (skipped <= 10) console.log(`0x${entry.toString(16)} skipped: ${lastRejection}`); continue; }
    functions.push(t);
}
const batch = assembleBatch(functions);
if (batch.pages.length > 1024) { console.error(`${batch.pages.length} pages exceed the 1024 external slots`); process.exit(2); }

const cPath = `${out}.c`;
await Bun.write(cPath, batch.c);
const clang = Bun.spawnSync([
    "clang", "--target=wasm32", "-O2", "-nostdlib", "-Wl,--no-entry", "-Wl,--import-memory",
    "-Wl,--allow-undefined", "-o", `${out}.wasm`, cPath,
], { stdout: "pipe", stderr: "pipe" });
if (clang.exitCode !== 0) { console.error(clang.stderr.toString()); process.exit(1); }

const manifest = {
    version: 1,
    exe,
    functions: functions.length,
    instructions: functions.reduce((s, f) => s + f.instructions, 0),
    pages: batch.pages.map((pm) => ({ page: pm.page, name: pm.name, states: pm.states.map((s) => s.addr) })),
};
await Bun.write(`${out}.json`, JSON.stringify(manifest));
const wasmSize = (await Bun.file(`${out}.wasm`).arrayBuffer()).byteLength;
console.log(`${out}.wasm: ${functions.length} functions (${manifest.instructions} insns), ${batch.pages.length} page modules, ${wasmSize} bytes; skipped ${skipped}`);
