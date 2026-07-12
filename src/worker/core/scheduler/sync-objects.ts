/**
 * SyncObjectManager — Event/Mutex/Semaphore management.
 * Provides create/signal/check/consume for kernel synchronization objects.
 */

import { Logger, LogCategory } from '../logger';
import { SystemResourceProvider } from '../resources/system-resource-provider';
import { hypercallDataManager } from '../cpu/hypercall-data';
import {
    KernelEventObject,
    KernelSemaphoreObject,
    KernelMutexObject,
    KernelThreadObject,
    KernelObject,
    WaitDecision,
    ThreadState,
    WAIT_OBJECT_0,
    WAIT_ABANDONED,
    WAIT_FAILED,
} from './types';

export type ThreadLookupFn = (threadId: number) => { state: ThreadState } | null;

export class SyncObjectManager {
    private resourceProvider = SystemResourceProvider.getInstance();
    private eventHandles = new Set<number>();
    private semaphoreHandles = new Set<number>();
    private mutexHandles = new Set<number>();

    // ─── Events ─────────────────────────────────────────────────────────────

    createEvent(manualReset: boolean, initialState: boolean): number {
        const handle = this.resourceProvider.registerKernelObject({
            kind: 'event', manualReset, signaled: initialState,
        } as KernelEventObject);
        this.eventHandles.add(handle);
        hypercallDataManager.registerEventMirror(handle, manualReset, initialState);
        return handle;
    }

    setEvent(handle: number): boolean {
        const event = this._getEvent(handle);
        if (!event) return false;
        event.signaled = true;
        if (event.manualReset) {
            event.pendingWake = true;
        }
        hypercallDataManager.writeEventMirrorSignaled(handle, true, event.manualReset);
        return true;
    }

    resetEvent(handle: number): boolean {
        const event = this._getEvent(handle);
        if (!event) return false;
        event.signaled = false;
        event.pendingWake = false;
        hypercallDataManager.writeEventMirrorSignaled(handle, false, event.manualReset);
        return true;
    }

    // ─── Semaphores ─────────────────────────────────────────────────────────

    createSemaphore(initialCount: number, maxCount: number): number {
        const count = Math.max(0, initialCount | 0);
        const max = Math.max(1, maxCount | 0);
        const handle = this.resourceProvider.registerKernelObject({
            kind: 'semaphore', count: Math.min(count, max), max,
        } as KernelSemaphoreObject);
        this.semaphoreHandles.add(handle);
        return handle;
    }

    releaseSemaphore(handle: number, releaseCount: number): { ok: boolean; previousCount: number } {
        const sem = this._getSemaphore(handle);
        if (!sem) return { ok: false, previousCount: 0 };
        const rc = releaseCount | 0;
        if (rc <= 0) return { ok: false, previousCount: sem.count };
        const prev = sem.count;
        if (sem.count + rc > sem.max) return { ok: false, previousCount: prev };
        sem.count += rc;
        return { ok: true, previousCount: prev };
    }

    // ─── Mutexes ────────────────────────────────────────────────────────────

    createMutex(initialOwner: boolean, ownerThreadId: number): number {
        const handle = this.resourceProvider.registerKernelObject({
            kind: 'mutex',
            ownerThreadId: initialOwner ? ownerThreadId : null,
            recursion: initialOwner ? 1 : 0,
            abandoned: false,
        } as KernelMutexObject);
        this.mutexHandles.add(handle);
        hypercallDataManager.registerMutexMirror(
            handle,
            initialOwner ? ownerThreadId : null,
            initialOwner ? 1 : 0,
        );
        return handle;
    }

    releaseMutex(handle: number, ownerThreadId: number): boolean {
        const mutex = this._getMutex(handle);
        if (!mutex) return false;
        const mirrored = hypercallDataManager.readMutexMirrorState(handle);
        // A valid mirror with owner === null means the mutex is FREE (e.g. a WASM
        // fast-path Release already ran) — `mirrored?.owner ?? ...` would misread
        // that as "no mirror" and fall back to the stale JS owner, letting a
        // second Release succeed on an already-free mutex.
        const owner = mirrored ? mirrored.owner : mutex.ownerThreadId;
        if (owner !== ownerThreadId) {
            Logger.warn(LogCategory.KERNEL32,
                `ReleaseMutex: T${ownerThreadId} not owner (owner=${owner === null ? 'none' : `T${owner}`})`);
            return false;
        }
        const recursion = mirrored ? mirrored.recursion : mutex.recursion;
        if (recursion > 0) mutex.recursion = recursion - 1;
        else mutex.recursion = 0;
        if (mutex.recursion === 0) mutex.ownerThreadId = null;
        hypercallDataManager.writeMutexMirror(handle, mutex.ownerThreadId, mutex.recursion);
        return true;
    }

    releaseAllMutexesForThread(ownerThreadId: number): number[] {
        const released: number[] = [];
        for (const handle of this.mutexHandles) {
            const mutex = this._getMutex(handle);
            if (!mutex) continue;
            const owner = this._mutexOwner(mutex, handle);
            if (owner !== ownerThreadId) continue;
            mutex.ownerThreadId = null;
            mutex.recursion = 0;
            mutex.abandoned = true;
            // Preserve the live has-waiters bit (pass undefined, not false): an abandoned mutex
            // may still have real waiters, and clearing the bit would let a later WASM fast-path
            // ReleaseMutex skip the JS wake. syncHandleWaiters keeps the bit accurate otherwise.
            hypercallDataManager.writeMutexMirror(handle, null, 0, undefined, true);
            released.push(handle);
        }
        return released;
    }

    // ─── Wait checking ──────────────────────────────────────────────────────

    validateHandles(handles: number[]): boolean {
        if (handles.length === 0) return false;
        for (const h of handles) {
            const obj = this.resourceProvider.getKernelObject(h) as KernelObject | null;
            if (!obj) return false;
            if (obj.kind !== 'thread' && obj.kind !== 'event' &&
                obj.kind !== 'semaphore' && obj.kind !== 'mutex') return false;
        }
        return true;
    }

    checkWait(handles: number[], waitAll: boolean, threadId: number, threadLookup: ThreadLookupFn): WaitDecision {
        if (handles.length === 0) {
            return { ready: true, result: WAIT_FAILED, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] };
        }
        return waitAll
            ? this._checkWaitAll(handles, threadId, threadLookup)
            : this._checkWaitAny(handles, threadId, threadLookup);
    }

    consumeWait(decision: WaitDecision, threadId: number): void {
        for (const h of decision.consumeAutoReset) {
            const e = this._getEvent(h);
            if (e && !e.manualReset) {
                e.signaled = false;
                hypercallDataManager.writeEventMirrorSignaled(h, false, false);
            }
        }
        for (const h of decision.consumePendingWake ?? []) {
            const e = this._getEvent(h);
            if (e?.manualReset) {
                e.pendingWake = false;
                hypercallDataManager.clearEventMirrorPendingWake(h);
            }
        }
        for (const h of decision.consumeSemaphores) {
            const s = this._getSemaphore(h);
            if (s && s.count > 0) s.count--;
        }
        for (const h of decision.consumeMutexes) {
            const m = this._getMutex(h);
            if (m) {
                const mirrored = hypercallDataManager.readMutexMirrorState(h);
                if (mirrored) {
                    m.ownerThreadId = mirrored.owner;
                    m.recursion = mirrored.recursion;
                }
                m.abandoned = false;
                if (m.ownerThreadId === null) { m.ownerThreadId = threadId; m.recursion = 1; }
                else if (m.ownerThreadId === threadId) m.recursion++;
                hypercallDataManager.writeMutexMirror(h, m.ownerThreadId, m.recursion, undefined, false);
            }
        }
    }

    isSignaled(handle: number, threadId: number, threadLookup: ThreadLookupFn): boolean {
        const obj = this.resourceProvider.getKernelObject(handle) as KernelObject | null;
        if (!obj) return false;
        switch (obj.kind) {
            case 'thread': { const t = threadLookup((obj as KernelThreadObject).threadId); return t !== null && t.state === ThreadState.TERMINATED; }
            case 'event': return this._eventReady(obj as KernelEventObject, handle);
            case 'semaphore': return (obj as KernelSemaphoreObject).count > 0;
            case 'mutex': { const m = obj as KernelMutexObject; const owner = this._mutexOwner(m, handle); return owner === null || owner === threadId; }
        }
        return false;
    }

    describeHandle(handle: number): string {
        const obj = this.resourceProvider.getKernelObject(handle) as KernelObject | null;
        if (!obj) return 'INVALID';
        switch (obj.kind) {
            case 'event': { const e = obj as KernelEventObject; return `event(sig=${e.signaled ? 1 : 0},manual=${e.manualReset ? 1 : 0},wake=${e.pendingWake ? 1 : 0})`; }
            case 'semaphore': { const s = obj as KernelSemaphoreObject; return `sem(${s.count}/${s.max})`; }
            case 'mutex': { const m = obj as KernelMutexObject; return `mutex(owner=${m.ownerThreadId ?? 'none'})`; }
            case 'thread': return `thread(${(obj as KernelThreadObject).threadId})`;
        }
    }

    reset(): void {
        for (const h of this.eventHandles) this.resourceProvider.unregisterKernelObject(h);
        for (const h of this.semaphoreHandles) this.resourceProvider.unregisterKernelObject(h);
        for (const h of this.mutexHandles) this.resourceProvider.unregisterKernelObject(h);
        this.eventHandles.clear();
        this.semaphoreHandles.clear();
        this.mutexHandles.clear();
        hypercallDataManager.clearEventMirrors();
    }

    private _mutexOwner(m: KernelMutexObject, handle: number): number | null {
        const mirrored = hypercallDataManager.readMutexMirrorState(handle);
        if (mirrored) return mirrored.owner;
        return m.ownerThreadId;
    }

    private _mutexAbandoned(m: KernelMutexObject, handle: number): boolean {
        const mirrored = hypercallDataManager.readMutexMirrorState(handle);
        if (mirrored) return mirrored.abandoned;
        return m.abandoned;
    }

    // ─── Private ────────────────────────────────────────────────────────────

    private _getEvent(h: number): KernelEventObject | null {
        const o = this.resourceProvider.getKernelObject(h) as KernelObject | null;
        return o && o.kind === 'event' ? o as KernelEventObject : null;
    }
    private _getSemaphore(h: number): KernelSemaphoreObject | null {
        const o = this.resourceProvider.getKernelObject(h) as KernelObject | null;
        return o && o.kind === 'semaphore' ? o as KernelSemaphoreObject : null;
    }
    private _getMutex(h: number): KernelMutexObject | null {
        const o = this.resourceProvider.getKernelObject(h) as KernelObject | null;
        return o && o.kind === 'mutex' ? o as KernelMutexObject : null;
    }

    private _eventReady(e: KernelEventObject, handle: number): boolean {
        const st = this._getEventState(e, handle);
        return st.signaled || !!(st.manualReset && st.pendingWake);
    }

    private _getEventState(e: KernelEventObject, handle: number): { signaled: boolean; manualReset: boolean; pendingWake: boolean } {
        const mirrored = hypercallDataManager.readEventMirrorState(handle);
        if (mirrored) return mirrored;
        return { signaled: e.signaled, manualReset: e.manualReset, pendingWake: !!e.pendingWake };
    }

    private _eventWaitConsume(h: number, e: KernelEventObject): { consumeAutoReset: number[]; consumePendingWake?: number[] } {
        const st = this._getEventState(e, h);
        if (!st.manualReset) return { consumeAutoReset: [h] };
        if (st.pendingWake) return { consumeAutoReset: [], consumePendingWake: [h] };
        return { consumeAutoReset: [] };
    }

    private _checkWaitAll(handles: number[], threadId: number, tl: ThreadLookupFn): WaitDecision {
        const autoReset: number[] = [];
        const pendingWake: number[] = [];
        const sems: number[] = [];
        const mutexes: number[] = [];
        let anyAbandoned = false;
        for (const h of handles) {
            const obj = this.resourceProvider.getKernelObject(h) as KernelObject | null;
            if (!obj) return { ready: true, result: WAIT_FAILED, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] };
            switch (obj.kind) {
                case 'thread': { const t = tl((obj as KernelThreadObject).threadId); if (!t || t.state !== ThreadState.TERMINATED) return _notReady; break; }
                case 'event': {
                    const e = obj as KernelEventObject;
                    const st = this._getEventState(e, h);
                    if (!this._eventReady(e, h)) return _notReady;
                    if (!st.manualReset) autoReset.push(h);
                    else if (st.pendingWake) pendingWake.push(h);
                    break;
                }
                case 'semaphore': { const s = obj as KernelSemaphoreObject; if (s.count <= 0) return _notReady; sems.push(h); break; }
                case 'mutex': { const m = obj as KernelMutexObject; const owner = this._mutexOwner(m, h); if (owner !== null && owner !== threadId) return _notReady; if (this._mutexAbandoned(m, h)) anyAbandoned = true; mutexes.push(h); break; }
            }
        }
        return {
            ready: true,
            result: anyAbandoned ? WAIT_ABANDONED : WAIT_OBJECT_0,
            consumeAutoReset: autoReset,
            consumePendingWake: pendingWake.length ? pendingWake : undefined,
            consumeSemaphores: sems,
            consumeMutexes: mutexes,
        };
    }

    private _checkWaitAny(handles: number[], threadId: number, tl: ThreadLookupFn): WaitDecision {
        for (let i = 0; i < handles.length; i++) {
            const h = handles[i];
            const obj = this.resourceProvider.getKernelObject(h) as KernelObject | null;
            if (!obj) return { ready: true, result: WAIT_FAILED, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] };
            switch (obj.kind) {
                case 'thread': { const t = tl((obj as KernelThreadObject).threadId); if (t && t.state === ThreadState.TERMINATED) return { ready: true, result: WAIT_OBJECT_0 + i, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] }; break; }
                case 'event': {
                    const e = obj as KernelEventObject;
                    if (this._eventReady(e, h)) {
                        const consume = this._eventWaitConsume(h, e);
                        return {
                            ready: true,
                            result: WAIT_OBJECT_0 + i,
                            consumeAutoReset: consume.consumeAutoReset ?? [],
                            consumePendingWake: consume.consumePendingWake,
                            consumeSemaphores: [],
                            consumeMutexes: [],
                        };
                    }
                    break;
                }
                case 'semaphore': { const s = obj as KernelSemaphoreObject; if (s.count > 0) return { ready: true, result: WAIT_OBJECT_0 + i, consumeAutoReset: [], consumeSemaphores: [h], consumeMutexes: [] }; break; }
                case 'mutex': { const m = obj as KernelMutexObject; const owner = this._mutexOwner(m, h); if (owner === null || owner === threadId) return { ready: true, result: (this._mutexAbandoned(m, h) ? WAIT_ABANDONED : WAIT_OBJECT_0) + i, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [h] }; break; }
            }
        }
        return _notReady;
    }
}

const _notReady: WaitDecision = { ready: false, result: 0, consumeAutoReset: [], consumeSemaphores: [], consumeMutexes: [] };
