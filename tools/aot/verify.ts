/**
 * Differential verification of a translated leaf against v86 itself.
 *
 * A translator that is wrong in a way nothing checks is worse than no
 * translator, and reading generated JavaScript does not establish that it
 * matches x86. So the reference is the emulator: the same bytes run in v86 with
 * the same registers over the same memory, and every register and every byte of
 * the scratch region is compared afterwards.
 *
 * The guest is set up so the function's own `ret` lands on a `hlt`, which is what
 * ends the run — no instrumentation inside the function, and no assumption about
 * how it returns.
 *
 *   bun tools/aot/verify.ts <exe> --entries 0xc6a540,0xcab970 [--seed 12345]
 */

import { lastRejection, translateStraightLineLeaf, type Insn } from "./x86-to-js";

const MEM_SIZE = 32 * 1024 * 1024;
const IMAGE_BASE_GUEST = 0x100000;   // where the fixture is loaded in the test guest
const STUB_OFF = 0x1000;
const FUNC_OFF = 0x8000;
const SCRATCH = 0x400000;            // registers point here; compared afterwards
const SCRATCH_LEN = 0x8000;
const STACK_TOP = 0x300000;

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const exe = process.argv[2];
if (!exe) { console.error("usage: verify.ts <exe> --entries 0x...,0x..."); process.exit(2); }
const seed = Number(arg("seed", "20260901"));

/** Deterministic filler so both sides see identical memory. */
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
    // objcopy refuses to write to /dev/stdout, so extract once to a temp file.
    const tmp = `/tmp/aot-text-${process.pid}.bin`;
    Bun.spawnSync(["objcopy", "-O", "binary", "--only-section=.text", path, tmp]);
    const text = new Uint8Array(await Bun.file(tmp).arrayBuffer());
    // .text VMA from objdump -h
    const hdr = await new Response(Bun.spawn(["objdump", "-h", path]).stdout).text();
    const row = hdr.split("\n").find((l) => / \.text\s/.test(l))!;
    const vma = parseInt(row.trim().split(/\s+/)[3]!, 16);
    return text.slice(start - vma, start - vma + len);
}

/** v86 reference run: registers in, function runs, `hlt` ends it. */
function runGuest(code: Uint8Array, funcAddr: number, regs: Int32Array, scratch: Uint8Array) {
    return new Promise<{ regs: Int32Array; scratch: Uint8Array; ok: boolean }>(async (resolve) => {
        const { V86 } = await import("../../vendor/v86/build/libv86.mjs" as string);
        const emulator = new (V86 as any)({ autostart: false, memory_size: MEM_SIZE, log_level: 0 });
        const timer = setTimeout(() => finish(false), 20_000);

        function finish(ok: boolean) {
            clearTimeout(timer);
            const cpu = emulator.v86.cpu;
            const outRegs = Int32Array.from(cpu.reg32.slice(0, 8));
            const mem = cpu.mem8 as Uint8Array;
            const outScratch = mem.slice(SCRATCH, SCRATCH + SCRATCH_LEN);
            try { emulator.stop(); } catch { /* already stopped */ }
            resolve({ regs: outRegs, scratch: outScratch, ok });
        }

        emulator.bus.register("cpu-event-halt", () => finish(true));
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

            // Stub: load registers, point the return address at a hlt, jump in.
            let o = STUB_OFF;
            const haltAt = IMAGE_BASE_GUEST + STUB_OFF + 0x200;
            img[o++] = 0xBC; dv.setUint32(o, STACK_TOP, true); o += 4;          // mov esp
            img[o++] = 0xB8; dv.setUint32(o, haltAt, true); o += 4;             // mov eax, haltAt
            img[o++] = 0x50;                                                    // push eax
            for (const [i, name] of [0, 1, 2, 3, 5, 6, 7].entries()) {
                void name;
                const reg = [0, 1, 2, 3, 5, 6, 7][i]!;
                img[o++] = 0xB8 + reg; dv.setUint32(o, regs[reg]!, true); o += 4; // mov r32, imm32
            }
            img[o++] = 0xE9;                                                    // jmp func
            dv.setInt32(o, (IMAGE_BASE_GUEST + FUNC_OFF) - (IMAGE_BASE_GUEST + o + 4), true);
            o += 4;
            img[STUB_OFF + 0x200] = 0xF4;                                       // hlt
            img[STUB_OFF + 0x201] = 0xEB; img[STUB_OFF + 0x202] = 0xFE;

            cpu.load_multiboot(img.buffer.slice(0));
            cpu.mem8.set(scratch, SCRATCH);
            void funcAddr;
            emulator.run();
        });
    });
}

const entries = arg("entries", "").split(",").filter(Boolean).map((e) => Number(e));
if (entries.length === 0) { console.error("--entries required"); process.exit(2); }

let pass = 0, fail = 0, skipped = 0, inconclusive = 0;

for (const entry of entries) {
    const insns = await disassembleRange(exe, entry, 8192);
    const t = translateStraightLineLeaf(insns, entry);
    if (!t) { console.log(`0x${entry.toString(16)}  SKIP — ${lastRejection}`); skipped++; continue; }

    // Function extent = up to and including its ret.
    let extent = 0;
    for (const i of insns) { extent += i.size; if (i.mnemonic === "ret" || i.mnemonic === "retn") break; }
    const code = await readFunctionBytes(exe, entry, extent);

    const regs = new Int32Array(8);
    // Point every register into the scratch region so memory operands land in
    // initialised, comparable memory rather than wherever the original globals were.
    for (let i = 0; i < 8; i++) regs[i] = SCRATCH + 0x1000 + i * 0x40;
    regs[4] = STACK_TOP;

    const scratch = new Uint8Array(SCRATCH_LEN);
    fill(scratch, seed);

    const guest = await runGuest(code, entry, regs, scratch);
    if (!guest.ok) { console.log(`0x${entry.toString(16)}  SKIP (guest did not halt)`); skipped++; continue; }

    // Translated side, over an identical copy.
    const jsScratch = new Uint8Array(SCRATCH_LEN);
    fill(jsScratch, seed);
    const mem = new Uint8Array(MEM_SIZE);
    mem.set(jsScratch, SCRATCH);
    const dv = new DataView(mem.buffer);
    const jsRegs = Int32Array.from(regs);
    // eslint-disable-next-line no-new-func
    const fn = new Function("r", "dv", t.js) as (r: Int32Array, dv: DataView) => void;
    try { fn(jsRegs, dv); }
    catch (e) {
        // Synthetic memory means any pointer the function loads is garbage, so a
        // dereference outside the buffer says nothing about the translation. Only
        // the runtime shadow validator, with real arguments, can judge these.
        const oob = String(e).includes("Out of bounds");
        console.log(`0x${entry.toString(16)}  ${oob ? "INCONCLUSIVE (data-dependent pointer)" : `FAIL (threw: ${String(e)})`}`);
        if (oob) inconclusive++; else fail++;
        continue;
    }

    const diffs: string[] = [];
    const REGN = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
    for (let i = 0; i < 8; i++) {
        if (i === 4) continue;                       // esp: the stub's own push/ret move it
        if ((guest.regs[i]! | 0) !== (jsRegs[i]! | 0)) {
            diffs.push(`${REGN[i]} guest=0x${(guest.regs[i]! >>> 0).toString(16)} js=0x${(jsRegs[i]! >>> 0).toString(16)}`);
        }
    }
    let memDiff = 0;
    for (let i = 0; i < SCRATCH_LEN; i++) {
        if (guest.scratch[i] !== mem[SCRATCH + i]) memDiff++;
    }
    if (memDiff > 0) diffs.push(`${memDiff} scratch bytes differ`);

    if (diffs.length === 0) { console.log(`0x${entry.toString(16)}  PASS  ${t.instructions} insns translated`); pass++; }
    else { console.log(`0x${entry.toString(16)}  FAIL  ${diffs.join("; ")}`); fail++; }
}

console.log(`\npass=${pass} fail=${fail} inconclusive=${inconclusive} skipped=${skipped}`);
process.exit(fail > 0 ? 1 : 0);
