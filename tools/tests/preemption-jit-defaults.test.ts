import { describe, expect, test } from "bun:test";
import { PreemptionManager } from "../../src/worker/core/cpu/preemption-manager";

describe("PreemptionManager JIT defaults", () => {
    test("enables validated RET chaining but keeps target speculation disabled at boot", () => {
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

        expect(manager.isRetChainingEnabled()).toBe(true);
        expect(manager.isDynamicChainSitePicEnabled()).toBe(true);
        expect(manager.isRetSpeculationEnabled()).toBe(false);
        expect(manager.isLeafCallFusionEnabled()).toBe(true);
        expect(manager.isLeafReturnLocalEnabled()).toBe(true);
        expect(manager.isInlineIntraModuleDispatchEnabled()).toBe(true);
        expect(manager.isTier2RegionsEnabled()).toBe(false);
        expect(manager.isTier2AdaptiveEnabled()).toBe(true);
        expect(manager.getJitMaxPendingCompiles()).toBe(2);
        expect(manager.isDirectBlockChainingEnabled()).toBe(false);
        expect(configs.get(4)).toBe(0);
        expect(configs.get(12)).toBe(1);
        expect(configs.get(13)).toBe(0);
        expect(configs.get(27)).toBe(1);
        expect(configs.get(28)).toBe(1);
        expect(configs.get(30)).toBe(1);
        expect(configs.get(22)).toBe(1);
        expect(configs.get(23)).toBe(0);
        expect(configs.get(24)).toBe(1);
        expect(configs.get(25)).toBe(2);
    });

    test("keeps the dynamic-chain site-PIC kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setDynamicChainSitePic(false);

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

        expect(manager.isDynamicChainSitePicEnabled()).toBe(false);
        expect(configs.get(30)).toBe(0);
        expect(cacheClears).toBe(0);

        manager.setDynamicChainSitePic(true);
        expect(configs.get(30)).toBe(1);
        expect(cacheClears).toBe(1);
    });

    test("keeps the Tier-2 leaf-fusion kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setLeafCallFusion(false);

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

        expect(manager.isLeafCallFusionEnabled()).toBe(false);
        expect(configs.get(27)).toBe(0);
        expect(cacheClears).toBe(0);

        manager.setLeafCallFusion(true);
        expect(configs.get(27)).toBe(1);
        expect(cacheClears).toBe(1);
    });

    test("keeps the fused-leaf local-return kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setLeafReturnLocal(false);

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

        expect(manager.isLeafReturnLocalEnabled()).toBe(false);
        expect(configs.get(28)).toBe(0);
        expect(cacheClears).toBe(0);

        manager.setLeafReturnLocal(true);
        expect(configs.get(28)).toBe(1);
        expect(cacheClears).toBe(1);
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

    test("keeps the adaptive Tier-2 kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setTier2Adaptive(false);

        manager.initialize({
            wasm_memory: memory,
            wm: {
                exports: {
                    memory,
                    get_hypercall_page_ptr: () => 4,
                    set_relaxed_fpu: () => {},
                    set_jit_config: (index: number, value: number) => configs.set(index, value),
                },
            },
        });

        expect(manager.isTier2AdaptiveEnabled()).toBe(false);
        expect(configs.get(24)).toBe(0);

        manager.setTier2Adaptive(true);
        expect(manager.isTier2AdaptiveEnabled()).toBe(true);
        expect(configs.get(24)).toBe(1);
    });

    test("bounds and preserves the asynchronous JIT compile window", () => {
        const configs = new Map<number, number>();
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setJitMaxPendingCompiles(99);

        manager.initialize({
            wasm_memory: memory,
            wm: {
                exports: {
                    memory,
                    get_hypercall_page_ptr: () => 4,
                    set_relaxed_fpu: () => {},
                    set_jit_config: (index: number, value: number) => configs.set(index, value),
                },
            },
        });

        expect(manager.getJitMaxPendingCompiles()).toBe(8);
        expect(configs.get(25)).toBe(8);

        manager.setJitMaxPendingCompiles(0);
        expect(manager.getJitMaxPendingCompiles()).toBe(1);
        expect(configs.get(25)).toBe(1);
    });
});
