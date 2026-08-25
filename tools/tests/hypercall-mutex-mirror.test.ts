import { afterEach, describe, expect, it } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { hypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';
import { MUX_VALID } from '../../src/worker/core/cpu/hypercall-event-mirror';

describe('hypercall mutex mirror guest-memory addressing', () => {
    const system = System.getInstance() as any;
    const manager = hypercallDataManager as any;
    const oldProcess = system.process;
    const oldAddr = manager.mutexMirrorAddr;
    const oldWasmMemory = manager.wasmMemory;
    const oldShadow = new Uint32Array(manager.mutexMirrorShadow);

    afterEach(() => {
        system.process = oldProcess;
        manager.mutexMirrorAddr = oldAddr;
        manager.wasmMemory = oldWasmMemory;
        manager.mutexMirrorShadow.set(oldShadow);
    });

    it('reads and writes at guest byteOffset, not the raw WebAssembly buffer offset', () => {
        const raw = new ArrayBuffer(0x40000);
        const guestOffset = 0x10000;
        const guest = new Uint8Array(raw, guestOffset, 0x20000);
        const guestAddress = 0x2000;
        system.process = { getCurrentMemory: () => guest };
        manager.wasmMemory = raw;
        manager.mutexMirrorAddr = guestAddress;
        manager.mutexMirrorShadow.fill(0);

        // Poison the old, incorrect raw-buffer location. A correct write leaves
        // it untouched and publishes the word inside the guest-memory view.
        new DataView(raw).setUint32(guestAddress, 0xdeadbeef, true);
        hypercallDataManager.registerMutexMirror(0x30000, 7, 1);

        const rawView = new DataView(raw);
        expect(rawView.getUint32(guestAddress, true)).toBe(0xdeadbeef);
        expect(rawView.getUint32(guestOffset + guestAddress, true))
            .toBe((MUX_VALID | 0x00010000 | 7) >>> 0);
        expect(hypercallDataManager.readMutexMirrorState(0x30000))
            .toEqual({ owner: 7, recursion: 1, hasWaiters: false, abandoned: false });
    });
});
