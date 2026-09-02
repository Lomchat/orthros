/**
 * Compile translated C into a module that can share v86's linear memory.
 *
 * Such a module must own nothing in that memory: no data segment (an active
 * segment is written at instantiation, straight over v86's CPU state at
 * offset 1024) and no shadow-stack traffic (the C stack pointer would point
 * into v86's globals). `-fno-jump-tables` removes the lookup tables clang
 * otherwise emits for large switches; the guard below refuses any module that
 * still carries a data segment or touches its stack-pointer global.
 */

export interface CompileResult {
    ok: boolean;
    error?: string;
    bytes?: number;
}

const FLAGS = [
    "--target=wasm32", "-O2", "-nostdlib", "-fno-jump-tables", "-fno-stack-protector",
    "-Wl,--no-entry", "-Wl,--import-memory", "-Wl,--allow-undefined",
];

/** Section ids of a wasm binary, with the data section's segment count. */
export function wasmSections(b: Uint8Array): Array<{ id: number; size: number; segments?: number }> {
    const out: Array<{ id: number; size: number; segments?: number }> = [];
    let p = 8;
    const leb = (): number => { let r = 0, s = 0; for (;;) { const x = b[p++]!; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return r >>> 0; };
    while (p < b.length) {
        const id = b[p++]!;
        const size = leb();
        const start = p;
        const sec: { id: number; size: number; segments?: number } = { id, size };
        if (id === 11) sec.segments = leb();
        out.push(sec);
        p = start + size;
    }
    return out;
}

/** True when the module's code reads or writes global 0 (the stack pointer). */
function usesStackPointer(wasmPath: string): boolean | null {
    const objdump = ["llvm-objdump", "/usr/lib/llvm-18/bin/llvm-objdump"].find((c) => Bun.spawnSync(["sh", "-c", `command -v ${c}`]).exitCode === 0);
    if (!objdump) return null;
    const r = Bun.spawnSync([objdump, "-d", wasmPath], { stdout: "pipe", stderr: "pipe", maxBuffer: 1 << 30 });
    if (r.exitCode !== 0) return null;
    return /global\.(get|set)\s+0\b/.test(r.stdout.toString());
}

export function compileTranslationC(cPath: string, wasmPath: string): CompileResult {
    const clang = Bun.spawnSync(["clang", ...FLAGS, "-o", wasmPath, cPath], { stdout: "pipe", stderr: "pipe" });
    if (clang.exitCode !== 0) return { ok: false, error: clang.stderr.toString() };
    const bytes = new Uint8Array(Bun.spawnSync(["cat", wasmPath], { maxBuffer: 1 << 30 }).stdout);
    const data = wasmSections(bytes).find((s) => s.id === 11);
    if (data && (data.segments ?? 0) > 0) {
        return { ok: false, error: `${wasmPath}: ${data.segments} data segment(s) would be written into v86's memory at instantiation` };
    }
    const sp = usesStackPointer(wasmPath);
    if (sp === true) return { ok: false, error: `${wasmPath}: code uses the shadow stack pointer` };
    return { ok: true, bytes: bytes.byteLength };
}
