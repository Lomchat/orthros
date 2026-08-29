import { afterEach, describe, expect, it } from 'bun:test';
import { hypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';

describe('D3DX math hypercall registration', () => {
    const manager = hypercallDataManager as any;
    const oldCpu = manager.cpu;
    const oldBase = manager.hpBase;
    const oldInitialized = manager.initialized;
    const oldView = manager.view;
    const oldMemory = manager.wasmMemory;
    const oldEntries = new Map(manager.registeredEntries);

    afterEach(() => {
        manager.cpu = oldCpu;
        manager.hpBase = oldBase;
        manager.initialized = oldInitialized;
        manager.view = oldView;
        manager.wasmMemory = oldMemory;
        manager.registeredEntries = new Map(oldEntries);
    });

    it('routes the public Catmull-Rom export to generic WASM handler 82', () => {
        const memory = new WebAssembly.Memory({ initial: 2 });
        manager.cpu = { wasm_memory: memory };
        manager.hpBase = 0x1000;
        manager.initialized = true;
        manager.view = new DataView(memory.buffer);
        manager.wasmMemory = memory.buffer;
        manager.registeredEntries = new Map();

        hypercallDataManager.registerFunction('D3DX9', 'D3DXVec3CatmullRom', 321);

        expect(new Uint8Array(memory.buffer)[0x1000 + 0x100 + 321]).toBe(82);
        expect(manager.registeredEntries.get(321)).toBe(82);
    });
});
