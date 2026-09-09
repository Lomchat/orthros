#!/usr/bin/env node
/**
 * bench-v8 — time a translated function under V8 (node), the engine the game
 * runs on, instead of JavaScriptCore (Bun), whose verdicts on code shape do
 * not transfer.
 *
 * Loads a batch module produced by verify-c.ts --keep <dir> (batch.wasm), gives
 * it a linear memory laid out like v86's (registers at 64, flags at 120,
 * instruction counter at 664, MEM_SIZE at 812, x87 state at 816+), places the
 * fixture's scratch/stack, and calls the page export with the requested state
 * `iterations` times, resetting the registers each call.
 *
 *   node tools/aot/bench-v8.mjs <batch.wasm> --page page_200000 --state 0
 *        [--iterations 20000] [--ecx 0x300000] [--esp 0x3ff000] [--mem-mb 8]
 *        [--warmup 2000]
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const wasmPath = argv[0];
if (!wasmPath) { console.error("usage: bench-v8.mjs <batch.wasm> --page <export> --state <n>"); process.exit(2); }
const pageName = arg("page", "page_200000");
const state = Number(arg("state", "0"));
const iterations = Number(arg("iterations", "20000"));
const warmup = Number(arg("warmup", "2000"));
const memMb = Number(arg("mem-mb", "8"));
const ecx0 = Number(arg("ecx", "0x300000"));
const esp0 = Number(arg("esp", "0x3ff000"));

const pages = Math.ceil((memMb * 1024 * 1024) / 65536);
const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
const mem8 = new Uint8Array(memory.buffer);
const dv = new DataView(memory.buffer);
const MEM_SIZE = memMb * 1024 * 1024;
dv.setUint32(812, MEM_SIZE, true);          // MEM_SIZE
let exits = 0, slow = 0, guard = 0;
const imports = {
    env: {
        memory,
        mem_base: () => 0,
        guard_exit: () => { guard++; },
        slow_exit: () => { slow++; },
        get_eflags: () => dv.getInt32(120, true),
        run_until: () => 1,
        hypercall_out: () => {},
        read_tsc: () => 0n,
        x87_set_cw: () => {},
        x87_sin: Math.sin, x87_cos: Math.cos, x87_tan: Math.tan, x87_atan2: Math.atan2,
    },
};
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), imports);
const entry = instance.exports[pageName];
if (typeof entry !== "function") { console.error(`no export ${pageName}; exports: ${Object.keys(instance.exports).join(" ")}`); process.exit(2); }

function resetRegs() {
    // eax ecx edx ebx esp ebp esi edi at REG32 (offset 64)
    dv.setUint32(64 + 0, 0, true);
    dv.setUint32(64 + 4, ecx0 >>> 0, true);
    dv.setUint32(64 + 8, 0, true);
    dv.setUint32(64 + 12, 0, true);
    dv.setUint32(64 + 16, esp0 >>> 0, true);
    dv.setUint32(64 + 20, 0, true);
    dv.setUint32(64 + 24, 0, true);
    dv.setUint32(64 + 28, 0, true);
    dv.setUint32(120, 0x202, true);          // FLAGS
    dv.setUint32(100, 0, true);              // FLAGS_CHANGED
    dv.setUint32(664, 0, true);              // INSTRUCTION_COUNTER
    // A return address on the stack so a ret leaves the function cleanly.
    dv.setUint32(esp0, 0x100, true);
}
const repeat = Number(arg("repeat", "7"));
for (let i = 0; i < warmup; i++) { resetRegs(); entry(state); }
// Several timed batches; the minimum is the robust figure on a shared box,
// the median shows the spread.
const samples = [];
for (let r = 0; r < repeat; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) { resetRegs(); entry(state); }
    samples.push(Number(process.hrtime.bigint() - t0) / iterations);
}
samples.sort((a, b) => a - b);
const min = samples[0], med = samples[Math.floor(samples.length / 2)];
console.log(`${pageName}[${state}] x${iterations} x${repeat}: min ${min.toFixed(1)} ns/call, median ${med.toFixed(1)}, max ${samples[samples.length - 1].toFixed(1)}; retired=${dv.getUint32(664, true)} slow=${slow} guard=${guard} eax=0x${dv.getUint32(64, true).toString(16)}`);
