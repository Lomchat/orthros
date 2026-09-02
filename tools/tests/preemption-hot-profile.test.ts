import { describe, expect, test } from "bun:test";
import { PreemptionManager } from "../../src/worker/core/cpu/preemption-manager";
import { HotProfilePersistence } from "../../src/worker/runtime/filesystem/hot-profile-persistence";

/** A HOTP v1 image with one page and the given entry offsets. */
function image(page: number, entries: number[]): Uint8Array {
    const n = entries.length;
    const body = 12 + ((2 * n + 3) & ~3);
    const bytes = new Uint8Array(12 + body);
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0, 0x50544f48, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, 1, true);
    dv.setUint32(12, page, true);
    dv.setUint32(16, 0xdeadbeef, true);
    dv.setUint32(20, n, true);
    entries.forEach((e, i) => dv.setUint16(24 + 2 * i, e, true));
    return bytes;
}

/** Mock wasm exports: the staging buffer lives at STAGE in the mock memory and
 *  the commit reads the page count straight out of the image header, which is
 *  what proves the bytes were copied into wasm memory before the commit. */
function mockCpu(memory: { buffer: ArrayBuffer }) {
    const STAGE = 1024;
    let staged = 0;
    let installed = 0;
    let exported: Uint8Array | null = null;
    const exports = {
        memory,
        get_hypercall_page_ptr: () => 4,
        set_relaxed_fpu: () => {},
        set_jit_config: () => {},
        jit_hot_profile_io_alloc: (len: number) => { staged = len; return STAGE; },
        jit_hot_profile_import_commit: (len: number) => {
            const dv = new DataView(memory.buffer, STAGE, len);
            if (dv.getUint32(0, true) !== 0x50544f48) return 0;
            installed = dv.getUint32(8, true);
            return installed;
        },
        jit_hot_profile_export_build: () => {
            exported = image(0x400, [0x10, 0x20]);
            new Uint8Array(memory.buffer, STAGE, exported.length).set(exported);
            return exported.length;
        },
        jit_hot_profile_io_ptr: () => STAGE,
        jit_hot_profile_clear: () => { installed = 0; },
    };
    return {
        cpu: { wasm_memory: memory, wm: { exports } },
        state: { get staged() { return staged; }, get installed() { return installed; } },
    };
}

describe("PreemptionManager hot-page profile", () => {
    test("a profile set before boot is installed on init, and again on a new instance", () => {
        const manager = new PreemptionManager();
        const bytes = image(0x401, [0x100, 0x200, 0x300]);
        // Before v86 exists there is nothing to install, but the intent is kept.
        expect(manager.setJitHotProfile(bytes)).toBeNull();
        expect(manager.getJitHotProfile()).toBe(bytes);

        const first = mockCpu({ buffer: new ArrayBuffer(8192) });
        manager.initialize(first.cpu);
        expect(first.state.staged).toBe(bytes.length);
        expect(first.state.installed).toBe(1);

        const second = mockCpu({ buffer: new ArrayBuffer(8192) });
        manager.initialize(second.cpu);
        expect(second.state.installed).toBe(1);
    });

    test("a profile set after init applies immediately; null clears it", () => {
        const manager = new PreemptionManager();
        const m = mockCpu({ buffer: new ArrayBuffer(8192) });
        manager.initialize(m.cpu);
        expect(m.state.installed).toBe(0);
        expect(manager.setJitHotProfile(image(0x402, [0x40]))).toEqual({ pages: 1 });
        expect(m.state.installed).toBe(1);
        expect(manager.setJitHotProfile(null)).toEqual({ pages: 0 });
        expect(m.state.installed).toBe(0);
    });

    test("export copies the image out of wasm memory", () => {
        const manager = new PreemptionManager();
        const m = mockCpu({ buffer: new ArrayBuffer(8192) });
        expect(manager.exportJitHotProfile()).toBeNull();
        manager.initialize(m.cpu);
        const out = manager.exportJitHotProfile();
        expect(out).not.toBeNull();
        expect(Array.from(out!)).toEqual(Array.from(image(0x400, [0x10, 0x20])));
        // A private copy: mutating wasm memory afterwards must not change it.
        new Uint8Array(m.cpu.wasm_memory.buffer, 1024, 4).fill(0);
        expect(out![0]).toBe(0x48);
    });
});

describe("HotProfilePersistence.isImage", () => {
    test("accepts a HOTP header and rejects anything else", () => {
        expect(HotProfilePersistence.isImage(image(1, []))).toBe(true);
        expect(HotProfilePersistence.isImage(new Uint8Array(0))).toBe(false);
        expect(HotProfilePersistence.isImage(new Uint8Array(11))).toBe(false);
        const wrongMagic = image(1, [1]);
        wrongMagic[0] ^= 0xff;
        expect(HotProfilePersistence.isImage(wrongMagic)).toBe(false);
    });
});
