/**
 * Build an ahead-of-time batch for the runtime: translate a candidate list,
 * compile it with clang and write the module plus its manifest.
 *
 *   bun tools/aot/build-batch.ts <exe> --candidates /tmp/aot-candidates.json
 *       --out /srv/bfme/data/bfme1.aot [--take N] [--skip N] [--entries 0x..,0x..]
 *       [--profile <hotp>] [--hot-pages <json> --top-pages N]
 *
 * Produces `<out>.wasm` and `<out>.json`. The manifest lists every page
 * module with its export name and the entry addresses in state order, which
 * is all the worker needs: table slot per page, one registration per entry.
 *
 * v86 owns one module per page, so a page is only worth taking when every
 * entry the runtime dispatches to on it lands in a translation; otherwise
 * the JIT would compile the page and evict the batch's module. With
 * --profile, the recorded entries become extra entries of the functions
 * that contain them and pages with an uncovered recorded entry are dropped.
 * With --hot-pages (the load harness's --dump-hot-pages output) only the
 * --top-pages hottest pages are kept. Verify with verify-c.ts before shipping.
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
// Recorded entries, by page, from the hot profile.
const profilePath = arg("profile", "");
const recorded = new Map<number, Set<number>>();
const recordedAll = new Set<number>();
if (profilePath) {
    const bytes = new Uint8Array(await Bun.file(profilePath).arrayBuffer());
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint32(8, true);
    let i = 12;
    for (let k = 0; k < count; k++) {
        const page = dv.getUint32(i, true);
        const n = dv.getUint32(i + 8, true);
        i += 12;
        const set = new Set<number>();
        for (let e = 0; e < n; e++) {
            const addr = ((page << 12) >>> 0) + (dv.getUint16(i + 2 * e, true) & 0xfff);
            set.add(addr); recordedAll.add(addr);
        }
        i += (2 * n + 3) & ~3;
        recorded.set(page, set);
    }
}
// Hot pages from the harness dump: keep the top N by dispatch entries.
const hotPagesPath = arg("hot-pages", "");
const topPages = Number(arg("top-pages", "0"));
let hotSet: Set<number> | null = null;
if (hotPagesPath && topPages > 0) {
    const hp = JSON.parse(await Bun.file(hotPagesPath).text()) as { top: Array<{ page?: number; addr?: number; count?: number; entries?: number }> };
    const rows = (hp.top ?? []).map((r) => ({ page: r.page ?? ((r.addr ?? 0) >>> 12), n: r.count ?? r.entries ?? 0 }))
        .sort((a, b) => b.n - a.n).slice(0, topPages);
    hotSet = new Set(rows.map((r) => r.page));
    console.log(`hot pages: keeping ${hotSet.size} of ${hp.top?.length ?? 0}`);
}

const decoder = await CapstoneDecoder.open(exe);
let functions: CFunction[] = [];
let skipped = 0;
for (const entry of entries) {
    if (hotSet && !hotSet.has(entry >>> 12)) continue;
    const t = await translateFunctionC(decoder, entry, recordedAll.size ? recordedAll : undefined);
    if (!t) { skipped++; if (skipped <= 10) console.log(`0x${entry.toString(16)} skipped: ${lastRejection}`); continue; }
    functions.push(t);
}

// Page coverage: an entry the runtime dispatches to must be an entry of some
// translated function on that page, or the JIT takes the page back.
if (recorded.size > 0) {
    const covered = new Set<number>();
    for (const f of functions) for (const e of f.entries) covered.add(e.addr);
    const badPages = new Set<number>();
    let uncovered = 0;
    for (const f of functions) {
        for (const e of f.entries) {
            const page = e.addr >>> 12;
            for (const rec of recorded.get(page) ?? []) {
                if (!covered.has(rec)) { badPages.add(page); uncovered++; }
            }
        }
    }
    const before = functions.length;
    functions = functions.filter((f) => f.entries.every((e) => !badPages.has(e.addr >>> 12)));
    console.log(`page coverage: ${badPages.size} pages with uncovered recorded entries dropped (${before - functions.length} functions), ${uncovered} uncovered entries`);
}
const batch = assembleBatch(functions);
if (batch.pages.length > 4096) { console.error(`${batch.pages.length} pages exceed the 4096 external slots`); process.exit(2); }
// The exact function list that went in, so verify-c.ts can check the batch.
const selectedPath = arg("dump-selected", "");
if (selectedPath) {
    await Bun.write(selectedPath, JSON.stringify({ accepted: functions.map((f) => ({ entry: f.entry, instructions: f.instructions, blocks: f.blocks, calls: f.calls })) }));
}

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
decoder.close();
process.exit(0);
