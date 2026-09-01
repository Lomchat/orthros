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
        expect(manager.isRepMovsBridgeEnabled()).toBe(true);
        expect(manager.isSyncBoundaryContinuationEnabled()).toBe(true);
        expect(manager.isDeferredCompileQueueEnabled()).toBe(true);
        expect(manager.isContiguousCrossPageInstructionsEnabled()).toBe(true);
        expect(manager.isDynamicChainBudgetFastExitEnabled()).toBe(true);
        expect(manager.isImmediateExitCacheSyncEnabled()).toBe(true);
        expect(manager.isInlineIntraModuleDispatchEnabled()).toBe(true);
        expect(manager.isTier2RegionsEnabled()).toBe(false);
        expect(manager.isTier2AdaptiveEnabled()).toBe(true);
        // Six, not two: two leaves the queue permanently backed up, and one slow
        // module (272,6 ms measured) then stalls every module behind it.
        expect(manager.getJitMaxPendingCompiles()).toBe(6);
        expect(manager.isDirectBlockChainingEnabled()).toBe(false);
        expect(configs.get(4)).toBe(0);
        expect(configs.get(12)).toBe(1);
        expect(configs.get(13)).toBe(0);
        expect(configs.get(27)).toBe(1);
        expect(configs.get(28)).toBe(1);
        expect(configs.get(30)).toBe(1);
        expect(configs.get(35)).toBe(1);
        expect(configs.get(36)).toBe(1);
        expect(configs.get(37)).toBe(1);
        expect(configs.get(38)).toBe(1);
        expect(configs.get(41)).toBe(1);
        expect(configs.get(22)).toBe(1);
        expect(configs.get(23)).toBe(0);
        expect(configs.get(24)).toBe(1);
        expect(configs.get(25)).toBe(6);
    });

    test("synchronizes an urgent zero budget with generated JIT guards", () => {
        const memory = { buffer: new ArrayBuffer(4096) };
        const cachedLimits: number[] = [];
        const manager = new PreemptionManager();
        manager.initialize({
            wasm_memory: memory,
            wm: {
                exports: {
                    memory,
                    get_hypercall_page_ptr: () => 4,
                    set_relaxed_fpu: () => {},
                    set_jit_config: () => {},
                    jit_set_cycle_limit_cached: (limit: number) => cachedLimits.push(limit),
                },
            },
        });

        manager.requestImmediateExit();
        expect(new DataView(memory.buffer).getUint32(4, true)).toBe(0);
        expect(cachedLimits).toEqual([0]);

        manager.setImmediateExitCacheSync(false);
        manager.requestImmediateExit();
        expect(cachedLimits).toEqual([0]);
    });

    test("keeps the REP MOVS bridge kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setRepMovsBridge(false);

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

        expect(manager.isRepMovsBridgeEnabled()).toBe(false);
        expect(configs.get(35)).toBe(0);
        expect(cacheClears).toBe(0);

        manager.setRepMovsBridge(true);
        expect(configs.get(35)).toBe(1);
        expect(cacheClears).toBe(1);
    });

    test("keeps the synchronous-boundary continuation kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setSyncBoundaryContinuation(false);

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

        expect(manager.isSyncBoundaryContinuationEnabled()).toBe(false);
        expect(configs.get(36)).toBe(0);
        expect(cacheClears).toBe(0);

        manager.setSyncBoundaryContinuation(true);
        expect(configs.get(36)).toBe(1);
        expect(cacheClears).toBe(1);
    });

    test("keeps the deferred-compile queue kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setDeferredCompileQueue(true);

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

        expect(manager.isDeferredCompileQueueEnabled()).toBe(true);
        expect(configs.get(37)).toBe(1);
        expect(cacheClears).toBe(0);

        manager.setDeferredCompileQueue(false);
        expect(configs.get(37)).toBe(0);
        expect(cacheClears).toBe(1);
    });

    test("keeps the contiguous cross-page instruction kill-switch across a fresh v86 init", () => {
        const configs = new Map<number, number>();
        let cacheClears = 0;
        const memory = { buffer: new ArrayBuffer(4096) };
        const manager = new PreemptionManager();
        manager.setContiguousCrossPageInstructions(false);

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

        expect(manager.isContiguousCrossPageInstructionsEnabled()).toBe(false);
        expect(configs.get(38)).toBe(0);
        expect(cacheClears).toBe(0);

        manager.setContiguousCrossPageInstructions(true);
        expect(configs.get(38)).toBe(1);
        expect(cacheClears).toBe(1);
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

        // Default ON where the browser supports wasm tail calls: without chaining
        // every constant-successor module exit returns to the dispatcher.
        manager.initialize(makeCpu(true));
        expect(manager.isDirectBlockChainingSupported()).toBe(true);
        expect(manager.isDirectBlockChainingEnabled()).toBe(true);
        expect(configs.get(4)).toBe(1);

        // A diagnostic opt-out must survive a reload, so the kill switch is not
        // silently undone by the next game load.
        manager.setDirectBlockChaining(false);
        expect(manager.isDirectBlockChainingEnabled()).toBe(false);
        expect(configs.get(4)).toBe(0);
        expect(cacheClears).toBe(1);

        configs.clear();
        manager.initialize(makeCpu(true));
        expect(configs.get(4)).toBe(0);
        expect(cacheClears).toBe(1); // cold-cache boot does not clear again

        manager.setDirectBlockChaining(true);
        expect(configs.get(4)).toBe(1);

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
