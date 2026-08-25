import { describe, expect, test } from "bun:test";
import { PreemptionManager } from "../../src/worker/core/cpu/preemption-manager";

describe("PreemptionManager JIT defaults", () => {
    test("keeps measured-negative RET dispatch experiments disabled at boot", () => {
        const configs = new Map<number, number>();
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        const cpu = {
            wasm_memory: memory,
            wm: {
                exports: {
                    memory,
                    get_hypercall_page_ptr: () => 4,
                    set_relaxed_fpu: () => {},
                    set_jit_config: (index: number, value: number) => configs.set(index, value),
                },
            },
        };

        manager.initialize(cpu);

        expect(manager.isRetChainingEnabled()).toBe(false);
        expect(manager.isRetSpeculationEnabled()).toBe(false);
        expect(configs.get(12)).toBe(0);
        expect(configs.get(13)).toBe(0);
    });
});
