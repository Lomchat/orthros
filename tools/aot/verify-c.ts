/**
 * Differential verification of C translations through v86's own dispatcher.
 *
 * The executable's whole .text is loaded at its real address in a v86 guest,
 * so calls out of a translated function run the callee's real bytes. Each
 * function is run twice from identical registers and memory: once as bytes
 * (interpreter and JIT), once with its page modules registered so the
 * dispatcher enters the translation at the function entry and at every
 * after-call resume point. Registers, the scratch and stack regions and the
 * retired-instruction counter must match exactly — the counter is what v86
 * turns into guest time, so a translation that miscounts would skew the
 * scheduler even if it computed the right values.
 *
 *   bun tools/aot/verify-c.ts <exe> --entries 0xc6a540,0xcab970 [--seed N]
 *       [--keep /tmp/aot-verify] [--candidates /tmp/aot-candidates.json --take N]
 *
 * Needs clang with a wasm32 target and a wasm-ld (rust-lld exposed under that
 * name works), and vendor/v86/build with jit_register_external_module.
 */

import { Decoder } from "./decode";
import { assembleBatch, lastRejection, translateFunctionC, type CFunction } from "./x86-to-c";

const MEM_SIZE = 64 * 1024 * 1024;
const IMAGE_BASE_GUEST = 0x100000;
const STUB_OFF = 0x1000;
const SCRATCH = 0x2000000;
const SCRATCH_LEN = 0x8000;
const STACK_TOP = 0x2800000;
const STACK_BASE = STACK_TOP - 0x1000;
const STACK_LEN = 0x2000;
const WASM_TABLE_OFFSET = 1024;
const REGN = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const exe = process.argv[2];
if (!exe) { console.error("usage: verify-c.ts <exe> --entries 0x...,0x..."); process.exit(2); }
const seed = Number(arg("seed", "20260902"));
const keep = arg("keep", "");

function fill(buf: Uint8Array, s: number): void {
    let x = s >>> 0;
    for (let i = 0; i < buf.length; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        buf[i] = (x >>> 24) & 0xff;
    }
}

async function textSection(path: string): Promise<{ vma: number; bytes: Uint8Array }> {
    const tmp = `/tmp/aot-text-${process.pid}.bin`;
    Bun.spawnSync(["objcopy", "-O", "binary", "--only-section=.text", path, tmp]);
    const bytes = new Uint8Array(await Bun.file(tmp).arrayBuffer());
    const hdr = await new Response(Bun.spawn(["objdump", "-h", path]).stdout).text();
    const row = hdr.split("\n").find((l) => / \.text\s/.test(l))!;
    const vma = parseInt(row.trim().split(/\s+/)[3]!, 16);
    return { vma, bytes };
}

interface RunResult {
    ok: boolean;
    status: string;
    regs: Int32Array;
    scratch: Uint8Array;
    stack: Uint8Array;
    retired: number;
    interpreted: number;
}

/** Build the guest image once: .text at its VMA plus the register stub. */
function buildImage(text: { vma: number; bytes: Uint8Array }): Uint8Array {
    const end = text.vma + text.bytes.length;
    const imgLen = (end - IMAGE_BASE_GUEST + 0xfff) & ~0xfff;
    const img = new Uint8Array(imgLen);
    const dv = new DataView(img.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, IMAGE_BASE_GUEST, true);
    dv.setUint32(0x10, IMAGE_BASE_GUEST, true);
    dv.setUint32(0x14, IMAGE_BASE_GUEST + imgLen, true);
    dv.setUint32(0x18, IMAGE_BASE_GUEST + imgLen + 0x1000, true);
    dv.setUint32(0x1c, IMAGE_BASE_GUEST + STUB_OFF, true);
    img.set(text.bytes, text.vma - IMAGE_BASE_GUEST);
    return img;
}

/** Patch the stub for one function: registers in, halt as return address. */
function writeStub(img: Uint8Array, funcAddr: number, regs: Int32Array): void {
    const dv = new DataView(img.buffer);
    let o = STUB_OFF;
    const haltAt = IMAGE_BASE_GUEST + STUB_OFF + 0x200;
    img[o++] = 0xBC; dv.setUint32(o, STACK_TOP, true); o += 4;
    img[o++] = 0xB8; dv.setUint32(o, haltAt, true); o += 4;
    img[o++] = 0x50;
    for (const reg of [0, 1, 2, 3, 5, 6, 7]) {
        img[o++] = 0xB8 + reg; dv.setUint32(o, regs[reg]!, true); o += 4;
    }
    img[o++] = 0xE9;
    dv.setInt32(o, funcAddr - (IMAGE_BASE_GUEST + o + 4), true);
    o += 4;
    img[STUB_OFF + 0x200] = 0xF4;
    img[STUB_OFF + 0x201] = 0xEB; img[STUB_OFF + 0x202] = 0xFE;
}

function runGuest(
    img: Uint8Array, scratch: Uint8Array, stack: Uint8Array,
    install: ((cpu: any) => Promise<boolean>) | null,
): Promise<RunResult> {
    return new Promise(async (resolve) => {
        const { V86 } = await import("../../vendor/v86/build/libv86.mjs" as string);
        const emulator = new (V86 as any)({ autostart: false, memory_size: MEM_SIZE, log_level: 0 });
        let done = false;
        const finish = (status: string) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const cpu = emulator.v86.cpu;
            const ex = cpu.wm.exports;
            const mem = cpu.mem8 as Uint8Array;
            const out: RunResult = {
                ok: status === "halt", status,
                regs: Int32Array.from(cpu.reg32.slice(0, 8)),
                scratch: mem.slice(SCRATCH, SCRATCH + SCRATCH_LEN),
                stack: mem.slice(STACK_BASE, STACK_BASE + STACK_LEN),
                retired: cpu.instruction_counter[0] >>> 0,
                interpreted: Number(ex["profiler_interpreted_steps_get"]?.() ?? -1),
            };
            try { emulator.stop(); } catch { /* already stopped */ }
            resolve(out);
        };
        const timer = setTimeout(() => finish("timeout"), 20_000);
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", async () => {
            const cpu = emulator.v86.cpu;
            try {
                cpu.reboot_internal();
                cpu.reset_memory();
                cpu.set_jit_config(26, 10_000);
                cpu.jit_clear_cache?.();
                cpu.wm.exports["profiler_interpreted_steps_reset"]?.();
                cpu.load_multiboot(img.buffer.slice(0));
                cpu.mem8.set(scratch, SCRATCH);
                cpu.mem8.set(stack, STACK_BASE);
                if (install && !(await install(cpu))) { finish("install-failed"); return; }
                emulator.run();
            } catch (e) {
                finish(`error: ${String(e).split("\n")[0]}`);
            }
        });
    });
}

let entries = arg("entries", "").split(",").filter(Boolean).map((e) => Number(e));
const candidatesPath = arg("candidates", "");
if (candidatesPath) {
    const take = Number(arg("take", "100"));
    const skip = Number(arg("skip", "0"));
    const list = (JSON.parse(await Bun.file(candidatesPath).text()).accepted as Array<{ entry: number }>);
    entries = entries.concat(list.slice(skip, skip + take).map((c) => c.entry));
}
if (entries.length === 0) { console.error("--entries or --candidates required"); process.exit(2); }

const decoder = await Decoder.open(exe);
const functions: CFunction[] = [];
let skipped = 0;
for (const entry of entries) {
    const t = await translateFunctionC(decoder, entry);
    if (!t) { console.log(`0x${entry.toString(16)}  SKIP — ${lastRejection}`); skipped++; continue; }
    functions.push(t);
}
if (functions.length === 0) { console.log(`pass=0 fail=0 inconclusive=0 skipped=${skipped}`); process.exit(0); }

const batch = assembleBatch(functions);
if (batch.pages.length > 1024) { console.error("at most 1024 pages per batch (external table slots)"); process.exit(2); }

const dir = keep || `/tmp/aot-verify-${process.pid}`;
Bun.spawnSync(["mkdir", "-p", dir]);
const cPath = `${dir}/batch.c`;
const wasmPath = `${dir}/batch.wasm`;
await Bun.write(cPath, batch.c);
const clang = Bun.spawnSync([
    "clang", "--target=wasm32", "-O2", "-nostdlib", "-Wl,--no-entry", "-Wl,--import-memory",
    "-Wl,--allow-undefined", "-o", wasmPath, cPath,
], { stdout: "pipe", stderr: "pipe" });
if (clang.exitCode !== 0) {
    console.error(clang.stderr.toString());
    process.exit(1);
}
const wasmBytes = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
console.log(`batch: ${functions.length} functions, ${batch.pages.length} page modules, ${wasmBytes.length} bytes of wasm`);

const text = await textSection(exe);
const image = buildImage(text);
const pageSlot = new Map<number, number>();
batch.pages.forEach((pm, i) => pageSlot.set(pm.page, i));

let pass = 0, fail = 0, inconclusive = 0;

for (const t of functions) {
    const regs = new Int32Array(8);
    for (let i = 0; i < 8; i++) regs[i] = SCRATCH + 0x1000 + i * 0x40;
    regs[4] = STACK_TOP;
    const scratch = new Uint8Array(SCRATCH_LEN);
    fill(scratch, seed);
    const stack = new Uint8Array(STACK_LEN);
    fill(stack, seed ^ 0x5bd1e995);
    {
        const sv = new DataView(stack.buffer);
        for (let i = 0; i < 8; i++) {
            const off = (STACK_TOP - STACK_BASE) + i * 4;
            if (off + 4 <= STACK_LEN) sv.setInt32(off, SCRATCH + 0x2000 + i * 0x100, true);
        }
    }
    const img = image.slice();
    writeStub(img, t.entry, regs);

    const guest = await runGuest(img, scratch, stack, null);
    if (!guest.ok) { console.log(`0x${t.entry.toString(16)}  INCONCLUSIVE (guest: ${guest.status})`); inconclusive++; continue; }

    const ext = await runGuest(img, scratch, stack, async (cpu: any) => {
        const ex = cpu.wm.exports;
        const memBase = cpu.mem8.byteOffset >>> 0;
        const { instance } = await WebAssembly.instantiate(wasmBytes, { env: { memory: cpu.wasm_memory, mem_base: () => memBase } });
        const first = ex["jit_external_module_first_index"]() >>> 0;
        const flags = ex["jit_get_current_state_flags"]() >>> 0;
        // Only this function's entries: each lives in its page's module at the
        // state index the page assigned to it.
        for (const e of t.entries) {
            const page = e.addr >>> 12;
            const pm = batch.pages[pageSlot.get(page)!]!;
            const state = pm.states.findIndex((s) => s.addr === e.addr);
            const fn = (instance.exports as any)[pm.name];
            if (typeof fn !== "function" || state < 0) return false;
            const index = first + pageSlot.get(page)!;
            cpu.wm.wasm_table.set(index + WASM_TABLE_OFFSET, fn);
            if ((ex["jit_register_external_module"](index, e.addr, flags, state) >>> 0) !== 1) return false;
        }
        return true;
    });
    if (!ext.ok) { console.log(`0x${t.entry.toString(16)}  FAIL (external: ${ext.status})`); fail++; continue; }

    const diffs: string[] = [];
    for (let i = 0; i < 8; i++) {
        if ((guest.regs[i]! | 0) !== (ext.regs[i]! | 0)) {
            diffs.push(`${REGN[i]} guest=0x${(guest.regs[i]! >>> 0).toString(16)} c=0x${(ext.regs[i]! >>> 0).toString(16)}`);
        }
    }
    let memDiff = 0;
    for (let i = 0; i < SCRATCH_LEN; i++) if (guest.scratch[i] !== ext.scratch[i]) memDiff++;
    if (memDiff > 0) diffs.push(`${memDiff} scratch bytes differ`);
    let stackDiff = 0;
    for (let i = 0; i < STACK_LEN; i++) if (guest.stack[i] !== ext.stack[i]) stackDiff++;
    if (stackDiff > 0) diffs.push(`${stackDiff} stack bytes differ`);
    if (guest.retired !== ext.retired) diffs.push(`retired guest=${guest.retired} c=${ext.retired}`);
    if (!(ext.interpreted < guest.interpreted)) diffs.push(`module not entered (interpreted ${ext.interpreted} vs ${guest.interpreted})`);

    if (diffs.length === 0) {
        console.log(`0x${t.entry.toString(16)}  PASS  ${t.instructions} insns, ${t.blocks} blocks, ${t.calls} calls, ${t.liveFlagSites} live flag sites, retired=${guest.retired}`);
        pass++;
    } else {
        console.log(`0x${t.entry.toString(16)}  FAIL  ${diffs.join("; ")}`);
        fail++;
    }
}

console.log(`\npass=${pass} fail=${fail} inconclusive=${inconclusive} skipped=${skipped}`);
if (!keep) Bun.spawnSync(["rm", "-rf", dir]);
process.exit(fail > 0 ? 1 : 0);
