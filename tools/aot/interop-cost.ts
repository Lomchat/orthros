/**
 * What does one guest-to-host round trip cost?
 *
 * This decides the shape of the whole ahead-of-time design. A translated
 * function runs 4x faster than the same bytes in v86 — 0.30 us against 1.45 us
 * for a 270-instruction function — but only if something calls it. If entering
 * it from guest code costs on the order of a microsecond, per-function
 * installation hands the entire gain back at the door, and the translation has
 * to cover a whole region of the call graph so one entry amortises over many
 * calls. If entry is cheap, installing one function at a time works and the
 * project is far smaller.
 *
 * Measured against an identical loop with the trap removed, so the loop's own
 * cost cancels.
 *
 *   bun tools/aot/interop-cost.ts [--iterations 300000]
 */

const MEM_SIZE = 32 * 1024 * 1024;
const BASE = 0x100000;
const ENTRY = 0x1000;

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const iterations = Number(arg("iterations", "300000"));

/** `withTrap`: the loop body performs `out dx, al` to a port a host handler owns.
 *  Otherwise the body is the same length with the trap replaced by padding. */
function buildImage(n: number, withTrap: boolean): ArrayBuffer {
    const img = new Uint8Array(0x3000);
    const dv = new DataView(img.buffer);
    const MAGIC = 0x1BADB002, FLAGS = 0x10000;
    dv.setUint32(0x00, MAGIC, true);
    dv.setUint32(0x04, FLAGS, true);
    dv.setUint32(0x08, (-(MAGIC + FLAGS)) >>> 0, true);
    dv.setUint32(0x0c, BASE, true);
    dv.setUint32(0x10, BASE, true);
    dv.setUint32(0x14, BASE + img.length, true);
    dv.setUint32(0x18, BASE + img.length + 0x1000, true);
    dv.setUint32(0x1c, BASE + ENTRY, true);

    let o = ENTRY;
    img[o++] = 0xBC; dv.setUint32(o, 0x200000, true); o += 4;   // mov esp
    img[o++] = 0xBB; dv.setUint32(o, n, true); o += 4;          // mov ebx, n
    img[o++] = 0xBA; dv.setUint32(o, 0x00e9, true); o += 4;     // mov edx, port
    const loop = o;
    if (withTrap) { img[o++] = 0xEE; }                          // out dx, al
    else { img[o++] = 0x90; }                                   // nop, same length
    img[o++] = 0x4B;                                            // dec ebx
    img[o++] = 0x0F; img[o++] = 0x85;                           // jnz loop
    dv.setInt32(o, loop - (o + 4), true); o += 4;
    img[o++] = 0xF4; img[o++] = 0xEB; img[o++] = 0xFE;          // hlt; jmp $
    return img.buffer.slice(0);
}

function run(withTrap: boolean): Promise<{ ms: number; hits: number }> {
    return new Promise(async (resolve) => {
        const { V86 } = await import("../../vendor/v86/build/libv86.mjs" as string);
        const emulator = new (V86 as any)({ autostart: false, memory_size: MEM_SIZE, log_level: 0 });
        let started = 0, hits = 0;
        const timer = setTimeout(() => finish(-1), 180_000);
        function finish(ms: number) {
            clearTimeout(timer);
            try { emulator.stop(); } catch { /* already stopped */ }
            resolve({ ms, hits });
        }
        emulator.bus.register("cpu-event-halt", () => finish(performance.now() - started));
        emulator.add_listener("emulator-loaded", () => {
            const cpu = emulator.v86.cpu;
            cpu.reboot_internal();
            cpu.reset_memory();
            // A handler that does nothing but count: the point is the crossing,
            // not the work on the far side.
            cpu.io.register_write(0x00e9, { name: "aot-probe" }, () => { hits++; });
            cpu.load_multiboot(buildImage(iterations, withTrap));
            started = performance.now();
            emulator.run();
        });
    });
}

const withTrap = await run(true);
const withoutTrap = await run(false);

if (withTrap.ms < 0 || withoutTrap.ms < 0) {
    console.log("a run did not finish");
    process.exit(1);
}

const perTrapUs = ((withTrap.ms - withoutTrap.ms) * 1000) / iterations;
console.log(`iterations       ${iterations.toLocaleString()}`);
console.log(`with trap        ${withTrap.ms.toFixed(1)} ms   (handler hits ${withTrap.hits.toLocaleString()})`);
console.log(`without trap     ${withoutTrap.ms.toFixed(1)} ms`);
console.log(`per round trip   ${perTrapUs.toFixed(3)} us`);
console.log(`\nfor scale: a 270-instruction function costs 1.45 us in v86 and 0.30 us translated,`);
console.log(`so a round trip above ~1.1 us cancels the translation of one such function.`);
