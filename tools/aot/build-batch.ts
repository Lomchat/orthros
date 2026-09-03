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
import { compileTranslationC, compileTranslationUnits } from "./compile-c";
import { assembleBatch, lastRejection, translateFunctionC, type CFunction } from "./x86-to-c";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const exe = process.argv[2];
const out = arg("out", "");
if (!exe || !out) { console.error("usage: build-batch.ts <exe> --out <path> [--candidates ...]"); process.exit(2); }

let entries = arg("entries", "").split(",").filter(Boolean).map((e) => Number(e));
// --entries-file: one address per line (hex), e.g. the bridged callees a run
// observed (dbg.aotStats().runUntil.targets), which the static closure cannot
// see because they are reached through indirect calls.
const entriesFile = arg("entries-file", "");
if (entriesFile) {
    const extra = (await Bun.file(entriesFile).text()).split(/\s+/).map((t) => t.trim()).filter(Boolean)
        .map((t) => Number(t.startsWith("0x") ? t : `0x${t}`)).filter((n) => Number.isFinite(n) && n > 0);
    entries = entries.concat(extra);
    console.log(`entries file: ${extra.length} addresses`);
}
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
    // dbg.hotPages rows carry the page as a hex address string ("0xbab000").
    const hp = JSON.parse(await Bun.file(hotPagesPath).text()) as { top: Array<{ page?: number | string; addr?: number; count?: number; entries?: number }> };
    const rows = (hp.top ?? []).map((r) => ({ page: (typeof r.page === "string" ? Number(r.page) : (r.page ?? (r.addr ?? 0))) >>> 12, n: r.count ?? r.entries ?? 0 }))
        .sort((a, b) => b.n - a.n).slice(0, topPages);
    hotSet = new Set(rows.map((r) => r.page));
    console.log(`hot pages: keeping ${hotSet.size} of ${hp.top?.length ?? 0}`);
}

const decoder = await CapstoneDecoder.open(exe);
// --extra-image <file> --extra-base 0x...: a raw image of code that is not in
// the executable (Orthros's runtime x86 bodies in THUNK_CODE, dumped by the
// harness), translated at its address; entries are routed by address range.
// The manifest carries the image's hash so the install can verify the live
// bytes before trusting those translations.
// Several images: --extra-image <file> --extra-base 0x... for one, and/or
// --extra-images <list> whose lines are `file@0xbase` (the harness writes one
// per bridged THUNK_CODE page past the generator's cursor).
const extraSpecs: Array<{ file: string; base: number }> = [];
if (arg("extra-image", "") && Number(arg("extra-base", "0")) > 0) extraSpecs.push({ file: arg("extra-image", ""), base: Number(arg("extra-base", "0")) });
const extraList = arg("extra-images", "");
if (extraList) {
    for (const line of (await Bun.file(extraList).text()).split(/\r?\n/)) {
        const m = /^(.+)@(0x[0-9a-fA-F]+)$/.exec(line.trim());
        if (m) extraSpecs.push({ file: m[1]!, base: Number(m[2]) });
    }
}
const extras: Array<{ decoder: CapstoneDecoder; region: { base: number; size: number; sha256: string } }> = [];
for (const spec of extraSpecs) {
    const bytes = new Uint8Array(await Bun.file(spec.file).arrayBuffer());
    if (bytes.byteLength === 0) continue;
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    extras.push({ decoder: await CapstoneDecoder.open(spec.file, undefined, spec.base), region: { base: spec.base, size: bytes.byteLength, sha256: sha } });
    console.log(`extra image: ${spec.file} at 0x${spec.base.toString(16)}, ${bytes.byteLength} bytes, sha256 ${sha.slice(0, 16)}`);
}
const inExtra = (addr: number) => extras.find((e) => addr >= e.region.base && addr < e.region.base + e.region.size);
const decoderFor = (addr: number): CapstoneDecoder => inExtra(addr)?.decoder ?? decoder;
let functions: CFunction[] = [];
let skipped = 0;
for (const entry of entries) {
    if (hotSet && !hotSet.has(entry >>> 12) && !inExtra(entry)) continue;
    const t = await translateFunctionC(decoderFor(entry), entry, recordedAll.size ? recordedAll : undefined);
    if (!t) { skipped++; if (skipped <= 10) console.log(`0x${entry.toString(16)} skipped: ${lastRejection}`); continue; }
    functions.push(t);
}

// Call-graph closure (--closure N [--closure-max-insns M]): the callees the
// translated set leaves for are bridged through the nested dispatcher at
// every call; pulling the small ones in turns those into native calls. Each
// round translates the direct call targets of the current set that are not
// yet translated and fit the size bound; thunks are one-instruction callees
// whose CFG follows the jump, so a thunk's target comes with it.
const closureRounds = Number(arg("closure", "0"));
const closureMaxInsns = Number(arg("closure-max-insns", "64"));
for (let round = 0; round < closureRounds; round++) {
    const have = new Set(functions.map((f) => f.entry));
    const wanted = new Set<number>();
    for (const f of functions) for (const t of f.callTargets) if (!have.has(t)) wanted.add(t);
    let added = 0, rejected = 0, tooBig = 0;
    for (const target of [...wanted].sort((a, b) => a - b)) {
        const t = await translateFunctionC(decoderFor(target), target, recordedAll.size ? recordedAll : undefined);
        if (!t) { rejected++; continue; }
        if (t.instructions > closureMaxInsns) { tooBig++; continue; }
        functions.push(t); added++;
    }
    console.log(`closure round ${round + 1}: ${wanted.size} callees wanted, ${added} added, ${tooBig} over ${closureMaxInsns} instructions, ${rejected} rejected`);
    if (added === 0) break;
}

// Page coverage (opt-in with --whole-pages): keep only pages where every
// entry the runtime dispatches to lands in a translation. v86 now lets a JIT
// module and an external module share a page, so this is no longer required;
// it remains available to measure the fully-covered subset.
if (recorded.size > 0 && process.argv.includes("--whole-pages")) {
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
const unitsArg = Number(arg("units", "1"));
const batch = assembleBatch(functions, unitsArg);
if (batch.pages.length > 4096) { console.error(`${batch.pages.length} pages exceed the 4096 external slots`); process.exit(2); }
// The exact function list that went in, so verify-c.ts can check the batch.
const selectedPath = arg("dump-selected", "");
if (selectedPath) {
    await Bun.write(selectedPath, JSON.stringify({ accepted: functions.map((f) => ({ entry: f.entry, instructions: f.instructions, blocks: f.blocks, calls: f.calls })) }));
}

const cPath = `${out}.c`;
let compiled: import("./compile-c").CompileResult;
if (batch.units.length > 1) {
    // Several units: the header once, one file per unit, compiled in parallel.
    const hPath = `${out}.h`;
    await Bun.write(hPath, batch.header);
    const unitPaths: string[] = [];
    for (const [i, u] of batch.units.entries()) {
        const up = `${out}.u${i}.c`;
        await Bun.write(up, `#include "${hPath}"\n` + u);
        unitPaths.push(up);
    }
    console.log(`${unitPaths.length} units (${batch.units.map((u) => (u.length >> 20) + " MB").join(", ")})`);
    if (process.argv.includes("--no-compile")) {
        console.log(`${functions.length} functions (${functions.reduce((a, f) => a + f.instructions, 0)} insns), ${batch.pages.length} page modules; not compiled (--no-compile)`);
        process.exit(0);
    }
    compiled = await compileTranslationUnits(unitPaths, `${out}.wasm`, Number(arg("jobs", "8")));
} else {
    await Bun.write(cPath, batch.c);
    if (process.argv.includes("--no-compile")) {
        console.log(`${cPath}: ${functions.length} functions (${functions.reduce((a, f) => a + f.instructions, 0)} insns), ${batch.pages.length} page modules; not compiled (--no-compile)`);
        process.exit(0);
    }
    compiled = compileTranslationC(cPath, `${out}.wasm`);
}
if (!compiled.ok) { console.error(compiled.error); process.exit(1); }

const manifest = {
    version: 1,
    exe,
    functions: functions.length,
    instructions: functions.reduce((s, f) => s + f.instructions, 0),
    pages: batch.pages.map((pm) => ({ page: pm.page, name: pm.name, states: pm.states.map((s) => s.addr) })),
    // Code translated from a raw image outside the executable: the install
    // checks these bytes against live memory before registering their pages.
    // Hashed per 4 KB page actually used by a translation, so allocations
    // elsewhere in the region after the dump do not invalidate it.
    regions: await (async () => {
        const out: Array<{ base: number; size: number; sha256: string }> = [];
        for (const e of extras) {
            const bytes = new Uint8Array(await Bun.file(extraSpecs.find((sp) => sp.base === e.region.base)!.file).arrayBuffer());
            const used = new Set<number>();
            for (const f of functions) {
                if (f.entry < e.region.base || f.entry >= e.region.base + e.region.size) continue;
                for (let a = f.entry & ~0xfff; a < f.entry + Math.max(f.extent, 1); a += 0x1000) used.add(a);
            }
            for (const pg of [...used].sort((a, b) => a - b)) {
                const off = pg - e.region.base;
                const slice = bytes.subarray(Math.max(0, off), Math.min(bytes.byteLength, off + 0x1000));
                out.push({ base: pg, size: slice.byteLength, sha256: new Bun.CryptoHasher("sha256").update(slice).digest("hex") });
            }
        }
        return out;
    })(),
};
await Bun.write(`${out}.json`, JSON.stringify(manifest));
const wasmSize = (await Bun.file(`${out}.wasm`).arrayBuffer()).byteLength;
console.log(`${out}.wasm: ${functions.length} functions (${manifest.instructions} insns), ${batch.pages.length} page modules, ${wasmSize} bytes; skipped ${skipped}`);
decoder.close();
for (const e of extras) e.decoder.close();
process.exit(0);
