/**
 * Manual smoke test for the unpack-buffered wasm crate's 7z extraction.
 *
 * Ground truth: a local hp1_demo.7z (51 MB, LZMA:24 BCJ, solid, 2 blocks).
 * Asserts exactly 10 entries at exact uncompressed sizes.
 *
 * Run manually (NOT in committed vitest — needs the local 51MB file + nodejs wasm build):
 *   bun run build:unpack-buffered        # tools/build-unpack-buffered/build-wasm.sh
 *   bun tools/tests/unpack-buffered-7z.smoke.ts
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// nodejs-target wasm-bindgen build (synchronous wasm instantiation).
const wasm = require("../../tools/build-unpack-buffered/pkg-node/unpack_buffered.js") as {
    extract_7z: (bytes: Uint8Array) => Array<{ name: string; data: Uint8Array }>;
};

const ARCHIVE = process.env.ORTHROS_HP1_7Z ?? "tmp/hp1_demo.7z";

const EXPECTED: Record<string, number> = {
    "data1.cab": 1304995,
    "data2.cab": 52411461,
    "layout.bin": 422,
    "config.ini": 566,
    "Setup.ini": 168,
    "ikernel.ex_": 340866,
    "data1.hdr": 32949,
    "setup.inx": 205280,
    "IPLaunch.exe": 242176,
    "Setup.exe": 139264,
};

function basename(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i >= 0 ? p.slice(i + 1) : p;
}

const bytes = new Uint8Array(readFileSync(ARCHIVE));
console.log(`Read ${ARCHIVE} (${bytes.length} bytes)`);

const t0 = performance.now();
const entries = wasm.extract_7z(bytes);
const ms = (performance.now() - t0).toFixed(0);
console.log(`extract_7z returned ${entries.length} entries in ${ms}ms\n`);

const got = new Map<string, number>();
for (const e of entries) {
    got.set(basename(e.name), e.data.length);
}

let fail = 0;
console.log("entry              | got        | expected");
console.log("-------------------|------------|----------");
for (const [name, want] of Object.entries(EXPECTED)) {
    const have = got.get(name);
    const ok = have === want;
    if (!ok) fail++;
    console.log(
        `${name.padEnd(18)} | ${String(have ?? "MISSING").padStart(10)} | ${String(want).padStart(8)} ${ok ? "OK" : "MISMATCH"}`,
    );
}

// Also flag any unexpected extra files.
for (const name of got.keys()) {
    if (!(name in EXPECTED)) {
        console.log(`UNEXPECTED extra entry: ${name} (${got.get(name)} bytes)`);
        fail++;
    }
}

if (entries.length !== 10) {
    console.log(`\nFAIL: expected 10 entries, got ${entries.length}`);
    fail++;
}

if (fail === 0) {
    console.log("\nPASS: all 10 entries extracted at exact sizes.");
    process.exit(0);
} else {
    console.log(`\nFAIL: ${fail} problem(s).`);
    process.exit(1);
}
