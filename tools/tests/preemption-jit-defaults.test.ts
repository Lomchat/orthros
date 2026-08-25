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
        expect(manager.isInlineIntraModuleDispatchEnabled()).toBe(true);
        expect(manager.isDirectBlockChainingEnabled()).toBe(false);
        expect(configs.get(4)).toBe(0);
        expect(configs.get(12)).toBe(0);
        expect(configs.get(13)).toBe(0);
        expect(configs.get(22)).toBe(1);
    });

    test("gates direct block chaining on wasm tail-call support and preserves it on reload", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        const makeCpu = (supported: boolean) => ({
            jit_block_chaining_supported: supported,
            wasm_memory: memory,
            wm: {
                exports: {
                    memory,
                    get_hypercall_page_ptr: () => 4,
                    set_relaxed_fpu: () => {},
                    set_jit_config: (index: number, value: number) => configs.set(index, value),
                    jit_clear_cache_js: () => { cacheClears++; },
                },
            },
        });

        manager.initialize(makeCpu(true));
        expect(manager.isDirectBlockChainingSupported()).toBe(true);
        expect(manager.isDirectBlockChainingEnabled()).toBe(false);
        expect(configs.get(4)).toBe(0);

        manager.setDirectBlockChaining(true);
        expect(manager.isDirectBlockChainingEnabled()).toBe(true);
        expect(configs.get(4)).toBe(1);
        expect(cacheClears).toBe(1);

        configs.clear();
        manager.initialize(makeCpu(true));
        expect(configs.get(4)).toBe(1);
        expect(cacheClears).toBe(1); // cold-cache boot does not clear again

        configs.clear();
        manager.initialize(makeCpu(false));
        expect(manager.isDirectBlockChainingSupported()).toBe(false);
        expect(manager.isDirectBlockChainingEnabled()).toBe(false);
        expect(configs.get(4)).toBe(0);
    });

    test("keeps the inline-dispatch kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setInlineIntraModuleDispatch(false);

        manager.initialize({
            wasm_memory: memory,
            wm: {
                exports: {
                    memory,
                    get_hypercall_page_ptr: () => 4,
                    set_relaxed_fpu: () => {},
                    set_jit_config: (index: number, value: number) => configs.set(index, value),
                    jit_clear_cache_js: () => { cacheClears++; },
                },
            },
        });

        expect(manager.isInlineIntraModuleDispatchEnabled()).toBe(false);
        expect(configs.get(22)).toBe(0);
        expect(cacheClears).toBe(0); // boot applies the desired shape to a cold cache

        manager.setInlineIntraModuleDispatch(true);
        expect(configs.get(22)).toBe(1);
        expect(cacheClears).toBe(1);
    });
});
