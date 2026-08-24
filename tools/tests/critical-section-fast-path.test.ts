import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { registerFastPathSyncFunctions } from '../../src/worker/modules/kernel32/sync';

type FastHandler = (cpu: any, mem: Uint8Array, mem32: Uint32Array, view: DataView) => number | null;

const system = System.getInstance() as any;
const scheduler = system.scheduler as any;
const resources = system.resourceProvider as any;
const saved = {
    getCurrentThreadId: scheduler.getCurrentThreadId,
    hasWaitersForHandle: scheduler.hasWaitersForHandle,
    clearCriticalSectionOwner: scheduler.clearCriticalSectionOwner,
    isValidHandle: resources.isValidHandle,
};

let hasWaiters = false;
let validHandle = true;
let clearedOwner: number[] = [];

beforeEach(() => {
    hasWaiters = false;
    validHandle = true;
    clearedOwner = [];
    scheduler.getCurrentThreadId = () => 7;
    scheduler.hasWaitersForHandle = () => hasWaiters;
    scheduler.clearCriticalSectionOwner = (ptr: number) => { clearedOwner.push(ptr); return true; };
    resources.isValidHandle = () => validHandle;
});

afterEach(() => {
    scheduler.getCurrentThreadId = saved.getCurrentThreadId;
    scheduler.hasWaitersForHandle = saved.hasWaitersForHandle;
    scheduler.clearCriticalSectionOwner = saved.clearCriticalSectionOwner;
    resources.isValidHandle = saved.isValidHandle;
});

function leaveFixture(lockSemaphore: number): {
    handler: FastHandler;
    cpu: any;
    mem: Uint8Array;
    mem32: Uint32Array;
    view: DataView;
    cs: number;
} {
    const handlers = new Map<string, FastHandler>();
    registerFastPathSyncFunctions({
        registerFastPath: (_dll: string, name: string, handler: FastHandler) => handlers.set(name, handler),
    });
    const mem = new Uint8Array(0x1000);
    const mem32 = new Uint32Array(mem.buffer);
    const view = new DataView(mem.buffer);
    const esp = 0x100;
    const cs = 0x200;
    view.setUint32(esp + 4, cs, true);
    view.setUint32(cs + 4, 0, true);
    view.setUint32(cs + 8, 1, true);
    view.setUint32(cs + 12, 7, true);
    view.setUint32(cs + 16, lockSemaphore, true);
    return {
        handler: handlers.get('LeaveCriticalSection')!,
        cpu: { reg32: new Int32Array([0, 0, 0, 0, esp]) },
        mem,
        mem32,
        view,
        cs,
    };
}

describe('LeaveCriticalSection fast path', () => {
    test('releases a section whose persistent semaphore has no current waiters', () => {
        const f = leaveFixture(0x60000);
        expect(f.handler(f.cpu, f.mem, f.mem32, f.view)).toBe(0);
        expect(f.view.getUint32(f.cs + 4, true)).toBe(0xffffffff);
        expect(f.view.getUint32(f.cs + 8, true)).toBe(0);
        expect(f.view.getUint32(f.cs + 12, true)).toBe(0);
        expect(f.view.getUint32(f.cs + 16, true)).toBe(0x60000);
        expect(clearedOwner).toEqual([f.cs]);
    });

    test('preserves the exact slow path when the semaphore has a live waiter', () => {
        hasWaiters = true;
        const f = leaveFixture(0x60000);
        expect(f.handler(f.cpu, f.mem, f.mem32, f.view)).toBeNull();
        expect(f.view.getUint32(f.cs + 8, true)).toBe(1);
        expect(f.view.getUint32(f.cs + 12, true)).toBe(7);
        expect(clearedOwner).toEqual([]);
    });

    test('normalizes a stale semaphore before releasing', () => {
        validHandle = false;
        const f = leaveFixture(0xaaaaaaaa);
        expect(f.handler(f.cpu, f.mem, f.mem32, f.view)).toBe(0);
        expect(f.view.getUint32(f.cs + 16, true)).toBe(0);
        expect(f.view.getUint32(f.cs + 12, true)).toBe(0);
    });
});
