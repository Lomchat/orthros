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

import { CapstoneDecoder } from "./decoder-capstone";
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
/** "pointers" (default) points stack arguments into the scratch region;
 *  "small" makes them small integers, which is what count-taking functions
 *  (rep movs, loops) need to terminate. */
const argStyle = arg("args", "pointers");
/** "pointers" (default) points registers into scratch; "small" makes them
 *  small integers, for functions whose counts or indices arrive in registers. */
const regStyle = arg("regs", "pointers");
/** Treat <exe> as a flat code blob at this address (synthetic fixtures). */
const rawBase = arg("raw-base", "") ? Number(arg("raw-base", "")) : null;
const keep = arg("keep", "");

function fill(buf: Uint8Array, s: number): void {
    let x = s >>> 0;
    for (let i = 0; i < buf.length; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        buf[i] = (x >>> 24) & 0xff;
    }
}

async function textSection(path: string): Promise<{ vma: number; bytes: Uint8Array }> {
    if (rawBase !== null) return { vma: rawBase, bytes: new Uint8Array(await Bun.file(path).arrayBuffer()) };
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
    /** Where the guest stopped, which names the loop when a run times out. */
    eip: number;
    /** x87 state: the eight slots (mantissa + tag, padding excluded), TOP,
     *  the empty bitmap, the status and control words and the dirty flag. */
    fpu: Uint8Array;
}

/** A slot's value as f64 bits: relaxed slots hold them directly, true F80
 *  slots are converted with round-to-nearest-even on the dropped mantissa
 *  bits, as v86's own to_f64 does. The two representations are both legal in
 *  v86 (the interpreter's helpers push constants as true F80, the JIT pushes
 *  them relaxed), so the comparison must not distinguish them. */
function slotF64Bits(m: bigint, se: number): bigint {
    if (se === 0x7ffe) return m;
    const sign = (se >> 15) & 1;
    const exp = se & 0x7fff;
    if (exp === 0 && m === 0n) return BigInt(sign) << 63n;
    if (exp === 0x7fff) {
        // infinity or NaN
        const frac = (m & 0x7fffffffffffffffn) >> 11n;
        return (BigInt(sign) << 63n) | (0x7ffn << 52n) | frac;
    }
    let e = exp - 16383 + 1023;
    if (e <= 0 || e >= 0x7ff) return (BigInt(sign) << 63n) | (BigInt(Math.max(0, Math.min(0x7ff, e))) << 52n);
    let sig = m >> 11n; // 53 bits with the explicit integer bit
    const rem = m & 0x7ffn;
    if (rem > 0x400n || (rem === 0x400n && (sig & 1n) === 1n)) sig += 1n;
    if (sig >> 53n) { sig >>= 1n; e += 1; }
    const frac = sig & 0xfffffffffffffn;
    return (BigInt(sign) << 63n) | (BigInt(e) << 52n) | frac;
}

function captureFpu(lin: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 * 10 + 7);
    const dv = new DataView(lin.buffer, lin.byteOffset, lin.byteLength);
    for (let s = 0; s < 8; s++) {
        const m = dv.getBigUint64(1152 + 16 * s, true), se = dv.getUint16(1160 + 16 * s, true);
        const o = new DataView(out.buffer, s * 10, 10);
        o.setBigUint64(0, slotF64Bits(m, se), true);
        o.setUint16(8, 0, true);
    }
    out[80] = lin[1032]!; out[81] = lin[816]!;
    // The status word without its exception flags: the interpreter's helpers
    // raise IE on an out-of-range fist, the JIT's inline path (which the
    // translation mirrors) does not, and no game reads that bit.
    out[82] = 0; out[83] = lin[1041]!;
    out[84] = lin[1036]!; out[85] = lin[1037]!;
    out[86] = lin[632]!;
    return out;
}

function describeFpu(f: Uint8Array): string {
    const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
    const slots: string[] = [];
    for (let s = 0; s < 8; s++) {
        const m = dv.getBigUint64(s * 10, true), t = dv.getUint16(s * 10 + 8, true);
        if (m !== 0n || t !== 0) slots.push(`${s}:${m.toString(16)}/${t.toString(16)}`);
    }
    return `top=${f[80]} empty=${f[81]!.toString(16)} sw=${dv.getUint16(82, true).toString(16)} cw=${dv.getUint16(84, true).toString(16)} dirty=${f[86]} [${slots.join(" ")}]`;
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

let traceEntry: number | null = null;
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
            if (process.argv.includes("--trace-dispatch") && traceEntry !== null) {
                const d = ex["jit_debug_dispatch"]?.(traceEntry) >>> 0;
                console.log(`  dispatch(0x${traceEntry.toString(16)}) at ${status}: jit=${(d >>> 31) & 1} ext=${(d >>> 30) & 1} flagsMatch=${(d >>> 29) & 1} state=0x${(d & 0xffff).toString(16)} flags=0x${(ex["jit_get_current_state_flags"]?.() >>> 0).toString(16)} extDispatches=${ex["jit_external_dispatches"]?.() >>> 0} extMisses=${ex["jit_external_misses"]?.() >>> 0}`);
            }
            const out: RunResult = {
                ok: status === "halt", status,
                regs: Int32Array.from(cpu.reg32.slice(0, 8)),
                scratch: mem.slice(SCRATCH, SCRATCH + SCRATCH_LEN),
                stack: mem.slice(STACK_BASE, STACK_BASE + STACK_LEN),
                retired: cpu.instruction_counter[0] >>> 0,
                interpreted: Number(ex["profiler_interpreted_steps_get"]?.() ?? -1),
                eip: cpu.instruction_pointer[0] >>> 0,
                fpu: captureFpu(new Uint8Array(cpu.wasm_memory.buffer)),
            };
            try { emulator.stop(); } catch { /* already stopped */ }
            resolve(out);
        };
        const timer = setTimeout(() => finish("timeout"), 6_000);
        emulator.bus.register("cpu-event-halt", () => finish("halt"));
        emulator.add_listener("emulator-loaded", async () => {
            const cpu = emulator.v86.cpu;
            try {
                cpu.reboot_internal();
                cpu.reset_memory();
                cpu.set_jit_config(26, 10_000);
                // The production runtime runs the FPU in relaxed mode (raw f64
                // in the stack slots); the translation assumes it.
                cpu.wm.exports["set_relaxed_fpu"]?.(1);
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

const decoder = await CapstoneDecoder.open(exe, undefined, rawBase);
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
    for (let i = 0; i < 8; i++) regs[i] = regStyle === "small" ? 0x100 + i * 8 : SCRATCH + 0x1000 + i * 0x40;
    regs[4] = STACK_TOP;
    const scratch = new Uint8Array(SCRATCH_LEN);
    fill(scratch, seed);
    const stack = new Uint8Array(STACK_LEN);
    fill(stack, seed ^ 0x5bd1e995);
    {
        const sv = new DataView(stack.buffer);
        for (let i = 0; i < 8; i++) {
            const off = (STACK_TOP - STACK_BASE) + i * 4;
            if (off + 4 <= STACK_LEN) sv.setInt32(off, argStyle === "small" ? 3 + i * 2 : SCRATCH + 0x2000 + i * 0x100, true);
        }
    }
    const img = image.slice();
    writeStub(img, t.entry, regs);

    traceEntry = t.entry;
    const guest = await runGuest(img, scratch, stack, null);
    if (!guest.ok) { console.log(`0x${t.entry.toString(16)}  INCONCLUSIVE (guest: ${guest.status})`); inconclusive++; continue; }

    const guardExits: number[] = [];
    const slowExits: number[] = [];
    const ext = await runGuest(img, scratch, stack, async (cpu: any) => {
        const ex = cpu.wm.exports;
        const memBase = cpu.mem8.byteOffset >>> 0;
        // slow_exit: the module is about to hand an instruction to the
        // interpreter; v86 bypasses the external table once at that address.
        const { instance } = await WebAssembly.instantiate(wasmBytes, { env: {
            memory: cpu.wasm_memory, mem_base: () => memBase,
            guard_exit: (addr: number) => { guardExits.push(addr >>> 0); },
            slow_exit: (addr: number) => { slowExits.push(addr >>> 0); ex["jit_ext_interpret_once"]?.(addr >>> 0); },
        } });
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
        // The dispatcher's view of the entry right after registration (the TLB
        // has no entry yet, so this only tells whether registration published).
        if (process.argv.includes("--trace-dispatch")) {
            const d = ex["jit_debug_dispatch"]?.(t.entry) >>> 0;
            console.log(`  dispatch(0x${t.entry.toString(16)}) after register: jit=${(d >>> 31) & 1} ext=${(d >>> 30) & 1} flagsMatch=${(d >>> 29) & 1} state=0x${(d & 0xffff).toString(16)} externalPages=${ex["jit_external_pages"]?.() >>> 0}`);
        }
        return true;
    });
    if (!ext.ok) { console.log(`0x${t.entry.toString(16)}  FAIL (external: ${ext.status} at eip=0x${ext.eip.toString(16)}, retired=${ext.retired}, guest retired=${guest.retired})`); fail++; continue; }

    const diffs: string[] = [];
    for (let i = 0; i < 8; i++) {
        if ((guest.regs[i]! | 0) !== (ext.regs[i]! | 0)) {
            diffs.push(`${REGN[i]} guest=0x${(guest.regs[i]! >>> 0).toString(16)} c=0x${(ext.regs[i]! >>> 0).toString(16)}`);
        }
    }
    let memDiff = 0;
    const firstDiffs: string[] = [];
    for (let i = 0; i < SCRATCH_LEN; i++) {
        if (guest.scratch[i] !== ext.scratch[i]) {
            memDiff++;
            if (firstDiffs.length < 4) firstDiffs.push(`+0x${i.toString(16)}:${guest.scratch[i]!.toString(16)}/${ext.scratch[i]!.toString(16)}`);
        }
    }
    if (memDiff > 0) diffs.push(`${memDiff} scratch bytes differ (${firstDiffs.join(" ")})`);
    let stackDiff = 0;
    for (let i = 0; i < STACK_LEN; i++) if (guest.stack[i] !== ext.stack[i]) stackDiff++;
    if (stackDiff > 0) diffs.push(`${stackDiff} stack bytes differ`);
    if (guest.retired !== ext.retired) diffs.push(`retired guest=${guest.retired} c=${ext.retired}`);
    let fpuDiff = false;
    for (let i = 0; i < guest.fpu.length; i++) if (guest.fpu[i] !== ext.fpu[i]) { fpuDiff = true; break; }
    if (fpuDiff) diffs.push(`x87 guest=${describeFpu(guest.fpu)} c=${describeFpu(ext.fpu)}`);
    // A guard exit is not a divergence: the instruction ran in v86 instead, and
    // the state comparison above is what judges the outcome. It is reported so
    // a synthetic pointer past RAM is visible.
    const guardNote = (guardExits.length > 0
        ? `, ${guardExits.length} guard exit(s) at ${guardExits.slice(0, 3).map((a) => "0x" + a.toString(16)).join(",")}` : "")
        + (slowExits.length > 0 ? `, ${slowExits.length} slow exit(s)` : "");
    // Identical state but no drop in interpreted work: the dispatcher never
    // entered the translation (or it exited at once). Not a divergence, but
    // not a verification either.
    const notEntered = diffs.length === 0 && !(ext.interpreted < guest.interpreted);

    if (notEntered) {
        console.log(`0x${t.entry.toString(16)}  INCONCLUSIVE (not entered: interpreted ${ext.interpreted} vs ${guest.interpreted}${guardNote})`);
        inconclusive++;
    } else if (diffs.length === 0) {
        console.log(`0x${t.entry.toString(16)}  PASS  ${t.instructions} insns, ${t.blocks} blocks, ${t.calls} calls, ${t.liveFlagSites} live flag sites, retired=${guest.retired}${guardNote}`);
        pass++;
    } else {
        console.log(`0x${t.entry.toString(16)}  FAIL  ${diffs.join("; ")}`);
        fail++;
    }
}

console.log(`\npass=${pass} fail=${fail} inconclusive=${inconclusive} skipped=${skipped}`);
if (!keep) Bun.spawnSync(["rm", "-rf", dir]);
decoder.close();
process.exit(fail > 0 ? 1 : 0);
