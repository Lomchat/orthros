import { describe, expect, test } from "bun:test";
import { HypercallDataManager } from "../../src/worker/core/cpu/hypercall-data";

const OFF_HC_ENABLED = 0x008;
const OFF_HC_DISPATCH_TABLE = 0x100;
const OFF_HC_SLAB_CTL_PTR = 0x1444;
const OFF_HC_MUTEX_MIRROR_PTR = 0x1c50;
const OFF_HC_EAGL_TOKEN_CFG_PTR = 0x1c54;

function fakeCpu(memory: WebAssembly.Memory): any {
    return {
        wasm_memory: memory,
        mem8: new Uint8Array(memory.buffer, 0x8000, 0x8000),
        instruction_counter: new Uint32Array(1),
        wm: { exports: { set_guest_mem_size: () => undefined } },
    };
}

describe("HypercallDataManager process reset", () => {
    test("drops launcher dispatch IDs and process-local guest pointers", () => {
        const memory = new WebAssembly.Memory({ initial: 2 });
        const manager = new HypercallDataManager();
        const hpBase = 0x1000;
        const functionId = 1298;
        const view = new DataView(memory.buffer);

        manager.initialize(fakeCpu(memory), hpBase);
        manager.registerFunction("kernel32", "GetTickCount", functionId);
        manager.setSlabControlAddr(0x22000000);
        manager.setEaglTokenConfigPtr(0x23000000);
        (manager as any).mutexMirrorAddr = 0x24000000;
        view.setUint32(hpBase + OFF_HC_MUTEX_MIRROR_PTR, 0x24000000, true);
        manager.enable();

        expect(view.getUint8(hpBase + OFF_HC_DISPATCH_TABLE + functionId)).not.toBe(0);
        expect(manager.getRegisteredCount()).toBe(1);
        expect(view.getUint32(hpBase + OFF_HC_ENABLED, true)).toBe(1);

        manager.resetProcessState();

        expect(view.getUint8(hpBase + OFF_HC_DISPATCH_TABLE + functionId)).toBe(0);
        expect(manager.getRegisteredCount()).toBe(0);
        expect(view.getUint32(hpBase + OFF_HC_ENABLED, true)).toBe(0);
        expect(view.getUint32(hpBase + OFF_HC_SLAB_CTL_PTR, true)).toBe(0);
        expect(view.getUint32(hpBase + OFF_HC_MUTEX_MIRROR_PTR, true)).toBe(0);
        expect(view.getUint32(hpBase + OFF_HC_EAGL_TOKEN_CFG_PTR, true)).toBe(0);
        expect((manager as any).slabControlAddr).toBe(0);
        expect((manager as any).mutexMirrorAddr).toBe(0);
        expect((manager as any).eaglTokenCfgAddr).toBe(0);
    });
});
