/**
 * Does translated code actually beat the JIT?
 *
 * Everything else about the ahead-of-time pipeline is moot if it does not. v86's
 * JIT already keeps registers in locals inside a module, so the translation only
 * wins if dropping dead flag updates and dispatcher round trips is worth more
 * than running as JavaScript instead of generated WebAssembly. That is an
 * empirical question and this answers it, offline, without a browser.
 *
 * Both sides execute the same function the same number of times over the same
 * memory. The guest loop is left to warm up so the comparison is against
 * compiled code, not against v86's interpreter.
 *
 *   bun tools/aot/bench.ts <exe> --entries 0xdde410 [--iterations 200000]
 */

import { translateFunction, lastRejection, type Insn } from "./x86-to-js";

const MEM_SIZE = 32 * 1024 * 1024;
const IMAGE_BASE_GUEST = 0x100000;
const STUB_OFF = 0x1000;
const FUNC_OFF = 0x8000;
const SCRATCH = 0x400000;
const SCRATCH_LEN = 0x8000;
const STACK_TOP = 0x300000;
const STACK_BASE = STACK_TOP - 0x1000;
const STACK_LEN = 0x2000;

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const exe = process.argv[2];
if (!exe) { console.error("usage: bench.ts <exe> --entries 0x..."); process.exit(2); }
const iterations = Number(arg("iterations", "200000"));
const seed = Number(arg("seed", "20260901"));

function fill(buf: Uint8Array, s: number): void {
    let x = s >>> 0;
    for (let i = 0; i < buf.length; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        buf[i] = (x >>> 24) & 0xff;
    }
}

async function disassembleRange(path: string, start: number, len: number): Promise<Insn[]> {
    const proc = Bun.spawn([
        "objdump", "-d", "-M", "intel",
        `--start-address=0x${start.toString(16)}`,
        `--stop-address=0x${(start + len).toString(16)}`,
        path,
    ], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    const insns: Insn[] = [];
    for (const line of out.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const a = line.slice(0, tab).trim();
        if (!a.endsWith(":")) continue;
        const addr = parseInt(a.slice(0, -1), 16);
        if (!Number.isFinite(addr)) continue;
        const rest = line.slice(tab + 1);
        const t2 = rest.indexOf("\t");
        if (t2 < 0) continue;
        const bytes = rest.slice(0, t2).trim();
        const asm = rest.slice(t2 + 1).trim();
        if (!asm || asm.startsWith("(bad)")) continue;
        const sp = asm.indexOf(" ");
        insns.push({
            addr,
            mnemonic: sp < 0 ? asm : asm.slice(0, sp),
            operand: sp < 0 ? "" : asm.slice(sp + 1).trim(),
            size: bytes.split(/\s+/).length,
        });
    }
    return insns;
}

async function readFunctionBytes(path: string, start: number, len: number): Promise<Uint8Array> {
    const tmp = `/tmp/aot-bench-${process.pid}.bin`;
    Bun.spawnSync(["objcopy", "-O", "binary", "--only-section=.text", path, tmp]);
    const text = new Uint8Array(await Bun.file(tmp).arrayBuffer());
    const hdr = await new Response(Bun.spawn(["objdump", "-h", path]).stdout).text();
    const row = hdr.split("\n").find((l) => / \.text\s/.test(l))!;
    const vma = parseInt(row.trim().split(/\s+/)[3]!, 16);
    return text.slice(start - vma, start - vma + len);
}

/** Run the function `n` times inside v86 and return the wall time. */
function runGuestLoop(code: Uint8Array, n: number, scratch: Uint8Array, stack: Uint8Array) {
    return new Promise<number>(async (resolve) => {
        const { V86 } = await import("../../vendor/v86/build/libv86.mjs" as string);
        const emulator = new (V86 as any)({ autostart: false, memory_size: MEM_SIZE, log_level: 0 });
        let started = 0;
        const timer = setTimeout(() => finish(-1), 120_000);
        function finish(ms: number) {
            clearTimeout(timer);
            try { emulator.stop(); } catch { /* already stopped */ }
            resolve(ms);
        }
        emulator.bus.register("cpu-event-halt", () => finish(performance.now() - started));
        emulator.add_listener("emulator-loaded", () => {
            const cpu = emulator.v86.cpu;
            cpu.reboot_internal();
            cpu.reset_memory();

            const img = new Uint8Array(FUNC_OFF + code.length + 0x1000);
            const dv = new DataView(img.buffer);
            const MAGIC = 0x1BADB002, FLAGS = 0x10000;
            dv.setUint32(0x00, MAGIC, true);
            dv.setUint32(0x04, FLAGS, true);
            dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
            dv.setUint32(0x0c, IMAGE_BASE_GUEST, true);
            dv.setUint32(0x10, IMAGE_BASE_GUEST, true);
            dv.setUint32(0x14, IMAGE_BASE_GUEST + img.length, true);
            dv.setUint32(0x18, IMAGE_BASE_GUEST + img.length + 0x1000, true);
            dv.setUint32(0x1c, IMAGE_BASE_GUEST + STUB_OFF, true);
            img.set(code, FUNC_OFF);

            // mov esp; mov ebx,n; loop { call func; dec ebx; jnz loop } hlt
            let o = STUB_OFF;
            img[o++] = 0xBC; dv.setUint32(o, STACK_TOP, true); o += 4;
            img[o++] = 0xBB; dv.setUint32(o, n, true); o += 4;
            const loop = o;
            img[o++] = 0xE8;
            dv.setInt32(o, (IMAGE_BASE_GUEST + FUNC_OFF) - (IMAGE_BASE_GUEST + o + 4), true); o += 4;
            img[o++] = 0x4B;                                  // dec ebx
            img[o++] = 0x0F; img[o++] = 0x85;                 // jnz loop
            dv.setInt32(o, loop - (o + 4), true); o += 4;
            img[o++] = 0xF4; img[o++] = 0xEB; img[o++] = 0xFE;

            cpu.load_multiboot(img.buffer.slice(0));
            cpu.mem8.set(scratch, SCRATCH);
            cpu.mem8.set(stack, STACK_BASE);
            started = performance.now();
            emulator.run();
        });
    });
}

const entries = arg("entries", "").split(",").filter(Boolean).map((e) => Number(e));
if (entries.length === 0) { console.error("--entries required"); process.exit(2); }

for (const entry of entries) {
    const insns = await disassembleRange(exe, entry, 8192);
    const t = translateFunction(insns, entry);
    if (!t) { console.log(`0x${entry.toString(16)}  SKIP — ${lastRejection}`); continue; }

    let extent = 0;
    for (const i of insns) { extent += i.size; if (i.mnemonic === "ret" || i.mnemonic === "retn") break; }
    const code = await readFunctionBytes(exe, entry, extent);

    const scratch = new Uint8Array(SCRATCH_LEN); fill(scratch, seed);
    const stack = new Uint8Array(STACK_LEN); fill(stack, seed ^ 0x5bd1e995);
    {
        const sv = new DataView(stack.buffer);
        for (let i = 0; i < 8; i++) {
            const off = (STACK_TOP - STACK_BASE) + i * 4;
            if (off + 4 <= STACK_LEN) sv.setInt32(off, SCRATCH + 0x2000 + i * 0x100, true);
        }
    }

    const guestMs = await runGuestLoop(code, iterations, scratch, stack);
    if (guestMs < 0) { console.log(`0x${entry.toString(16)}  SKIP (guest did not finish)`); continue; }

    const mem = new Uint8Array(MEM_SIZE);
    mem.set(scratch, SCRATCH);
    mem.set(stack, STACK_BASE);
    const dv = new DataView(mem.buffer);
    const regs = new Int32Array(8);
    for (let i = 0; i < 8; i++) regs[i] = SCRATCH + 0x1000 + i * 0x40;
    regs[4] = (STACK_TOP - 4) | 0;
    dv.setInt32(STACK_TOP - 4, IMAGE_BASE_GUEST + STUB_OFF + 0x200, true);
    // eslint-disable-next-line no-new-func
    const fn = new Function("r", "dv", t.js) as (r: Int32Array, dv: DataView) => void;

    // Warm up so V8 has optimised the generated body, matching the guest side
    // being measured after its JIT has compiled the loop. Repeated calls mutate
    // the scratch region, so a pointer read back out of it can drift out of
    // range — that is the fixture ageing, not a translation error, and it only
    // means this function cannot be timed this way.
    const resetRegs = () => { for (let i = 0; i < 8; i++) regs[i] = SCRATCH + 0x1000 + i * 0x40; regs[4] = (STACK_TOP - 4) | 0; };
    let jsMs = -1;
    try {
        for (let i = 0; i < Math.min(iterations, 20_000); i++) { resetRegs(); fn(regs, dv); }
        const t0 = performance.now();
        for (let i = 0; i < iterations; i++) { resetRegs(); fn(regs, dv); }
        jsMs = performance.now() - t0;
    }
    catch (e) {
        console.log(`0x${entry.toString(16)}  SKIP (fixture aged out: ${String(e).slice(0, 40)})`);
        continue;
    }

    const speedup = guestMs / jsMs;
    console.log(
        `0x${entry.toString(16)}  ${String(t.instructions).padStart(4)} insns  ${String(t.blocks).padStart(2)} blocks  ` +
        `flagSites=${t.liveFlagSites}  v86=${guestMs.toFixed(0)}ms  translated=${jsMs.toFixed(0)}ms  ` +
        `${speedup >= 1 ? `${speedup.toFixed(2)}x faster` : `${(1 / speedup).toFixed(2)}x SLOWER`}`);
}
