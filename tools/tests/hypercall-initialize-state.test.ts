import { describe, expect, test } from "bun:test";
import { HypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";

const OFF_HC_SLAB_CTL_PTR = 0x1444;

function fakeCpu(memory: WebAssembly.Memory): any {
    return {
        wasm_memory: memory,
        mem8: new Uint8Array(memory.buffer, 0x8000, 0x8000),
        instruction_counter: new Uint32Array(1),
        wm: { exports: { set_guest_mem_size: () => undefined } },
    };
}

describe("HypercallDataManager initialization ordering", () => {
    test("publishes a slab pointer configured before the page exists", () => {
        const memory = new WebAssembly.Memory({ initial: 2 });
        const cpu = fakeCpu(memory);
        const manager = new HypercallDataManager();
        const hpBase = 0x1000;
        const slabControl = 0x2400;

        manager.setSlabControlAddr(slabControl);
        manager.initialize(cpu, hpBase);

        const view = new DataView(memory.buffer);
        expect(view.getUint32(hpBase + OFF_HC_SLAB_CTL_PTR, true)).toBe(slabControl);
    });

    test("re-publishes configured state after a same-buffer page reset", () => {
        const memory = new WebAssembly.Memory({ initial: 2 });
        const cpu = fakeCpu(memory);
        const manager = new HypercallDataManager();
        const hpBase = 0x1000;
        const slabControl = 0x2800;
        const view = new DataView(memory.buffer);

        manager.initialize(cpu, hpBase);
        manager.setSlabControlAddr(slabControl);

        view.setUint32(hpBase + OFF_HC_SLAB_CTL_PTR, 0, true);
        manager.initialize(cpu, hpBase);

        expect(view.getUint32(hpBase + OFF_HC_SLAB_CTL_PTR, true)).toBe(slabControl);
    });
});
