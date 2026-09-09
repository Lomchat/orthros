/**
 * Deferred critical-section wake (modern-Windows release of a contended section): the
 * leaver releases fully and keeps running; the scheduler delivers the waiter's wake at a
 * boundary, only if the section is still free then, and hands off immediately after a skip
 * streak so a waiter cannot starve. Runs against a real Scheduler + wait engine with the
 * CRITICAL_SECTION guest memory in a bound buffer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Scheduler, csDeferredWakePolicy } from '../../src/worker/core/scheduler/scheduler';
import { ThreadState, WaitReason, type CpuContext, type Thread } from '../../src/worker/core/scheduler/types';
import { Mem } from '../../src/worker/core/memory/mem-accessor';

const CS = 0x200;
const mem = new Uint8Array(0x1000);
const view = new DataView(mem.buffer);

function mkThread(id: number, state: ThreadState): Thread {
    return {
        id, handle: 0x1000 + id, state, context: null,
        stackBase: 0x00200000, stackSize: 0x00100000, stackTop: 0x00300000, startAddress: 0x00401000,
        parameter: 0, waitInfo: null, exitCode: null, tlsValues: new Map(), lastError: 0, suspendCount: 0,
        priority: 0, lastSwitchTime: 0, lastSwitchInsn: 0, tebAddress: 0, kernelPinCount: 0, apcQueue: [],
        quitPosted: false, quitExitCode: 0, asyncParkGeneration: 0,
    } as unknown as Thread;
}

function inject(s: Scheduler, t: Thread, opts: { runnable?: boolean; current?: boolean } = {}): Thread {
    const any = s as any;
    any.threads.set(t.id, t);
    if (opts.runnable && !any.runQueue.includes(t.id)) any.runQueue.push(t.id);
    if (opts.current) any.currentThreadId = t.id;
    return t;
}

function writeSection(lockCount: number, recursion: number, owner: number, sem: number): void {
    view.setInt32(CS + 4, lockCount, true);
    view.setUint32(CS + 8, recursion, true);
    view.setUint32(CS + 12, owner, true);
    view.setUint32(CS + 16, sem, true);
}

/** T2 parked on the section's LockSemaphore (as EnterCriticalSection leaves it), T1 running. */
function contended(): { s: Scheduler; leaver: Thread; waiter: Thread; sem: number } {
    const s = new Scheduler();
    const sem = s.createEvent(false, false);
    const waiter = inject(s, mkThread(2, ThreadState.RUNNING), { current: true });
    const ctx = { eip: 0x402000, esp: 0x290000 } as CpuContext;
    (s as any).blockThread(waiter, WaitReason.CRITICAL_SECTION, [sem], false, null, false, CS, ctx);
    expect(waiter.state).toBe(ThreadState.WAITING);
    const leaver = inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
    writeSection(0, 1, 1, sem);
    return { s, leaver, waiter, sem };
}

beforeEach(() => {
    mem.fill(0);
    Mem.bind(() => mem);
    csDeferredWakePolicy.enabled = true;
});

afterEach(() => {
    csDeferredWakePolicy.enabled = false;
});

describe('scheduler/deferCriticalSectionWake', () => {
    test('policy off: the release is not deferred (ordinary hand-off)', () => {
        csDeferredWakePolicy.enabled = false;
        const { s, sem } = contended();
        expect(s.deferCriticalSectionWake(CS, sem)).toBe(false);
        expect(s.csWakeStats.deferred).toBe(0);
    });

    test('the wake is delivered at a boundary when the section is free: waiter READY and owner', () => {
        const { s, waiter, sem } = contended();
        expect(s.deferCriticalSectionWake(CS, sem)).toBe(true);
        writeSection(-1, 0, 0, sem); // the leaver's full release
        expect(waiter.state).toBe(ThreadState.WAITING); // nothing happens at the release itself

        s.drainPendingCsWakes();
        expect(waiter.state).toBe(ThreadState.READY);
        expect(view.getInt32(CS + 4, true)).toBe(0);
        expect(view.getUint32(CS + 8, true)).toBe(1);
        expect(view.getUint32(CS + 12, true)).toBe(2);
        expect((s as any).waitEngine.getHandleWaiters(sem)).not.toContain(2);
        expect((s as any).switchRequested).toBe(true);
        expect((s as any).pendingCsWakes.size).toBe(0);
        expect(s.csWakeStats).toMatchObject({ deferred: 1, delivered: 1, skipped: 0, fairFallback: 0 });
    });

    test('a section taken again before the boundary keeps its waiter parked; the next release re-arms', () => {
        const { s, waiter, sem } = contended();
        expect(s.deferCriticalSectionWake(CS, sem)).toBe(true);
        writeSection(0, 1, 1, sem); // released then re-acquired by T1 (WASM fast path)
        s.drainPendingCsWakes();
        expect(waiter.state).toBe(ThreadState.WAITING);
        expect(view.getUint32(CS + 12, true)).toBe(1);
        expect((s as any).pendingCsWakes.size).toBe(0);
        expect(s.csWakeStats.skipped).toBe(1);

        expect(s.deferCriticalSectionWake(CS, sem)).toBe(true);
        writeSection(-1, 0, 0, sem);
        s.drainPendingCsWakes();
        expect(waiter.state).toBe(ThreadState.READY);
        expect(view.getUint32(CS + 12, true)).toBe(2);
    });

    test('a skip streak makes the next release hand off immediately, then the streak resets', () => {
        const { s, waiter, sem } = contended();
        for (let i = 0; i < 8; i++) {
            expect(s.deferCriticalSectionWake(CS, sem)).toBe(true);
            writeSection(0, 1, 1, sem);
            s.drainPendingCsWakes();
        }
        expect(waiter.state).toBe(ThreadState.WAITING);
        expect(s.csWakeStats.skipped).toBe(8);
        expect(s.deferCriticalSectionWake(CS, sem)).toBe(false); // ordinary path: immediate hand-off
        expect(s.csWakeStats.fairFallback).toBe(1);
        expect(s.deferCriticalSectionWake(CS, sem)).toBe(true);  // streak reset
    });

    test('a thread about to block or yield delivers the pending wake before counting runnable peers', () => {
        const { s, waiter, sem } = contended();
        expect(s.hasOtherRunnableThreads(1)).toBe(false);
        expect(s.deferCriticalSectionWake(CS, sem)).toBe(true);
        writeSection(-1, 0, 0, sem);
        expect(s.hasOtherRunnableThreads(1)).toBe(true);
        expect(waiter.state).toBe(ThreadState.READY);
        expect(view.getUint32(CS + 12, true)).toBe(2);
    });

    test('a waiter that left meanwhile: nothing to deliver', () => {
        const s = new Scheduler();
        const sem = s.createEvent(false, false);
        inject(s, mkThread(1, ThreadState.RUNNING), { current: true });
        writeSection(-1, 0, 0, sem);
        expect(s.deferCriticalSectionWake(CS, sem)).toBe(true);
        s.drainPendingCsWakes();
        expect(s.csWakeStats).toMatchObject({ deferred: 1, delivered: 0, noWaiter: 1 });
        expect((s as any).switchRequested).toBe(false);
    });

    test('turning the policy off delivers what is pending', () => {
        const { s, waiter, sem } = contended();
        expect(s.deferCriticalSectionWake(CS, sem)).toBe(true);
        writeSection(-1, 0, 0, sem);
        s.setCsDeferredWake(false);
        expect(waiter.state).toBe(ThreadState.READY);
        expect(s.isCsDeferredWake()).toBe(false);
    });
});
