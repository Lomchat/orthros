/**
 * Scheduler cold diagnostics (read-mostly observability surface).
 *
 * Contents: thread-table / thread-snapshot / async-restore-queue formatting,
 * freeze-watchdog wait diagnosis, throttled deadlock detector scan+diagnose,
 * and the yield (idle-attribution) report builder. Scheduler state travels in
 * via explicit narrow parameters (same style as scheduler-context.ts).
 *
 * Hot / stateful counterparts stay in scheduler.ts: the asyncRestoreTrace ring
 * + traceAsyncRestore/dumpSchedulerAsyncState (private state on the switch
 * path), the deadlock throttle timestamp, and yieldStats accumulation
 * (recordYield). detectDeadlock() is
 * not purely read-only: its last resort force-wakes a CRITICAL_SECTION waiter
 * (safe to retry) through the injected wakeThread callback — the wake
 * machinery itself remains in scheduler.ts.
 */

import { Logger, LogCategory } from '../logger';
import {
    Thread, ThreadState, THREAD_STATE_NAMES,
    WaitReason, WAIT_REASON_NAMES,
    ThunkBoundaryKind,
} from './types';
import type { SyncObjectManager } from './sync-objects';

export function hx(v: number | null | undefined): string {
    return `0x${((v ?? 0) >>> 0).toString(16)}`;
}

export function boundaryKindName(kind: ThunkBoundaryKind | null | undefined): string {
    switch (kind) {
        case ThunkBoundaryKind.THUNK_STUB: return 'THUNK_STUB';
        case ThunkBoundaryKind.SPIN_LOOP: return 'SPIN_LOOP';
        case ThunkBoundaryKind.CALLBACK_STUB: return 'CALLBACK_STUB';
        case ThunkBoundaryKind.GUEST_CODE: return 'GUEST_CODE';
        default: return 'unknown';
    }
}

export function formatThreadSnapshot(thread: Thread | null): string {
    if (!thread) return 'thread=null';
    const saved = thread.context
        ? `savedEip=${hx(thread.context.eip)},savedEsp=${hx(thread.context.esp)}`
        : 'saved=null';
    const wait = thread.waitInfo
        ? `,wait=${WAIT_REASON_NAMES[thread.waitInfo.reason] ?? thread.waitInfo.reason}`
        : '';
    const stack = `stack=[${hx(thread.stackBase)},${hx(thread.stackTop)})`;
    return `T${thread.id}:${THREAD_STATE_NAMES[thread.state]},gen=${thread.asyncParkGeneration >>> 0},${saved},${stack}${wait}`;
}

/** Format the thunk dispatcher's pending async-restore queue (first 8 rows). */
export function formatPendingAsyncRestoreQueue(dispatcher: unknown): string {
    const d = dispatcher as any;
    const rows = d?.getPendingAsyncRestoreDiagnostics?.()
        ?? d?.getPendingAsyncRestores?.()
        ?? [];
    if (!rows.length) return '[]';
    return '[' + rows.slice(0, 8).map((r: any, i: number) => {
        const tid = (r.threadId ?? 0) >>> 0;
        const gen = (r.asyncParkGeneration ?? 0) >>> 0;
        const fn = (r.functionId ?? 0) >>> 0;
        const ret = (r.returnAddr ?? 0) >>> 0;
        const esp = (r.esp ?? 0) >>> 0;
        const cleanup = (r.cleanupBytes ?? 0) >>> 0;
        return `#${i}:T${tid}/g${gen}/${r.completionName ?? '?'}:fn=${hx(fn)},esp=${hx(esp)},ret=${hx(ret)},cleanup=${cleanup}`;
    }).join(' ') + (rows.length > 8 ? ` ...+${rows.length - 8}` : '') + ']';
}

/** One-line dump of every thread's state/context/wait — the crash-funnel thread table. */
export function formatDetailedThreadInfo(
    threads: ReadonlyMap<number, Thread>,
    currentThreadId: number | null,
    runQueue: readonly number[],
    mem: Uint8Array | null | undefined,
): string {
    const parts: string[] = [];
    for (const t of threads.values()) {
        const st = THREAD_STATE_NAMES[t.state] ?? `UNKNOWN(${t.state})`;
        const ctx = t.context
            ? `EIP=0x${t.context.eip.toString(16)},ESP=0x${t.context.esp.toString(16)}`
            : 'null';
        let waitDetail = '';
        if (t.waitInfo) {
            const reason = WAIT_REASON_NAMES[t.waitInfo.reason] ?? `R${t.waitInfo.reason}`;
            const handles = t.waitInfo.handles?.length
                ? t.waitInfo.handles.map((h: number) => '0x' + h.toString(16)).join(',')
                : '';
            if (t.waitInfo.csAddress) {
                let csOwner = '?';
                if (mem && t.waitInfo.csAddress + 16 <= mem.length) {
                    csOwner = 'T' + ((mem[t.waitInfo.csAddress + 12] | (mem[t.waitInfo.csAddress + 13] << 8) |
                        (mem[t.waitInfo.csAddress + 14] << 16) | (mem[t.waitInfo.csAddress + 15] << 24)) >>> 0);
                }
                waitDetail = `,wait=${reason}(CS@0x${t.waitInfo.csAddress.toString(16)},owner=${csOwner})`;
            } else if (handles) {
                waitDetail = `,wait=${reason}(${handles})`;
            } else {
                waitDetail = `,wait=${reason}`;
            }
        }
        parts.push(`T${t.id}:${st},gen=${t.asyncParkGeneration >>> 0},${ctx}${waitDetail}`);
    }
    return `currentId=${currentThreadId} runQueue=[${runQueue.join(',')}] threads=[${parts.join(' | ')}]`;
}

/**
 * Read-only diagnostic for present-stall triage: for every WAITING thread, re-evaluate its wait
 * condition via checkWait — which does NOT consume the signal (consumeWait is a separate step),
 * so this has NO side effects. A thread that is WAITING but whose condition is ALREADY
 * satisfiable = a LOST/MIS-PHASED WAKEUP ("case A": signal arrived but the thread wasn't
 * transitioned). If no waiter is satisfiable, the producer that should signal simply hasn't run
 * ("case B"). The freeze watchdog calls this at freeze time to decide the fix direction.
 */
export function diagnoseWaiters(
    threads: ReadonlyMap<number, Thread>,
    syncObjects: SyncObjectManager,
): Array<{ id: number; reason: string; handles: string[]; satisfiable: boolean; result: number }> {
    const out: Array<{ id: number; reason: string; handles: string[]; satisfiable: boolean; result: number }> = [];
    for (const [id, t] of threads) {
        if (t.state !== ThreadState.WAITING || !t.waitInfo) continue;
        const wi = t.waitInfo;
        const reason = wi.reason !== undefined ? (WAIT_REASON_NAMES[wi.reason] ?? String(wi.reason)) : '?';
        if (wi.reason === WaitReason.SLEEP) { out.push({ id, reason, handles: [], satisfiable: false, result: 0 }); continue; }
        let satisfiable = false, result = 0;
        try {
            const d = syncObjects.checkWait(wi.handles, wi.waitAll, id, (tid) => threads.get(tid) ?? null);
            satisfiable = !!d.ready; result = d.result >>> 0;
        } catch { /* read-only diagnostic — ignore */ }
        out.push({ id, reason, handles: (wi.handles ?? []).map((h: number) => '0x' + (h >>> 0).toString(16)), satisfiable, result });
    }
    return out;
}

/**
 * Deadlock scan + diagnosis (the body of Scheduler.detectDeadlock, after its
 * 2s throttle which stays with the scheduler's timestamp state). Force-wakes
 * only CRITICAL_SECTION waiters (safe to retry) via the injected wakeThread;
 * NEVER wakes INFINITE handle waits.
 */
export function detectDeadlock(args: {
    threads: ReadonlyMap<number, Thread>;
    mem: Uint8Array | null | undefined;
    hasPendingAsyncRestores: (() => boolean) | null;
    timerActiveCount: number;
    wakeThread: (thread: Thread, result: number) => void;
}): void {
    const { threads, mem } = args;

    let waitingCount = 0;
    let runnable = false;
    let asyncThunkWaiter = false;

    for (const t of threads.values()) {
        if (t.state === ThreadState.TERMINATED) continue;
        if (t.state === ThreadState.RUNNING || t.state === ThreadState.READY) { runnable = true; break; }
        if (t.state === ThreadState.WAITING) {
            // ASYNC_THUNK waits are woken by JS Promises, not by guest-visible
            // events. They are never part of a guest deadlock — skip them.
            if (t.waitInfo?.reason === WaitReason.ASYNC_THUNK) {
                asyncThunkWaiter = true;
                continue;
            }
            waitingCount++;
        }
    }

    if (runnable || waitingCount === 0) return;

    // Main thread in GetMessage async wait + one idle worker on an event is normal.
    if (asyncThunkWaiter && waitingCount <= 1) return;

    // If there are pending async restores queued, at least one ASYNC_THUNK
    // waiter is about to be woken — not a deadlock.
    if (args.hasPendingAsyncRestores?.()) return;

    // Check if timers exist — they may break the deadlock
    if (args.timerActiveCount > 0) return;

    // Diagnostic: dump full deadlock chain
    for (const t of threads.values()) {
        if (t.state !== ThreadState.WAITING || !t.waitInfo) continue;
        if (t.waitInfo.reason === WaitReason.CRITICAL_SECTION) {
            const csAddr = t.waitInfo.csAddress;
            let ownerInfo = '';
            if (mem && csAddr + 16 <= mem.length) {
                const ownerId = (mem[csAddr + 12] | (mem[csAddr + 13] << 8) |
                    (mem[csAddr + 14] << 16) | (mem[csAddr + 15] << 24)) >>> 0;
                const ownerThread = threads.get(ownerId);
                const ownerWait = ownerThread?.waitInfo;
                ownerInfo = ` owner=T${ownerId}`;
                if (ownerWait) {
                    ownerInfo += `(${WAIT_REASON_NAMES[ownerWait.reason]}`;
                    if (ownerWait.handles?.length) ownerInfo += `:${ownerWait.handles.map(h => '0x' + h.toString(16)).join(',')}`;
                    ownerInfo += ')';
                }
            }
            Logger.warn(LogCategory.THREAD,
                `DEADLOCK DIAG: T${t.id} waiting on CS@0x${csAddr.toString(16)}${ownerInfo}`);
        }
    }

    // Only force-wake CS waiters — they are safe to retry.
    // NEVER wake INFINITE handle waits (Mutex/Event/Semaphore) — guest code
    // assumes WAIT_TIMEOUT is impossible for INFINITE and may crash/corrupt.
    for (const t of threads.values()) {
        if (t.state !== ThreadState.WAITING || !t.waitInfo) continue;
        if (t.waitInfo.reason === WaitReason.CRITICAL_SECTION) {
            Logger.warn(LogCategory.THREAD,
                `DEADLOCK: ${waitingCount} threads all WAITING, no timers. Force-waking CS waiter T${t.id} at 0x${t.waitInfo.csAddress.toString(16)}`);
            args.wakeThread(t, 0);
            return;
        }
    }

    // True deadlock on handle-based waits — log diagnostic, don't force-wake
    const waitDetails: string[] = [];
    for (const t of threads.values()) {
        if (t.state !== ThreadState.WAITING || !t.waitInfo) continue;
        waitDetails.push(`T${t.id}:${WAIT_REASON_NAMES[t.waitInfo.reason]}(handles=[${t.waitInfo.handles.join(',')}])`);
    }
    Logger.error(LogCategory.THREAD,
        `DEADLOCK (unrecoverable): ${waitingCount} threads all WAITING, no timers, no CS waiters. ${waitDetails.join(', ')}`);
}

export interface YieldStat { count: number; totalMs: number; reqMs: number; maxMs: number }

/** Idle-attribution report: yieldToHost wall-clock grouped by source. */
export function buildYieldReport(
    yieldStats: ReadonlyMap<string, YieldStat>,
    yieldStatsSince: number,
): {
    windowMs: number; totalYieldMs: number; pctOfWindow: string;
    rows: Array<{ source: string; count: number; totalMs: number; avgMs: number; maxMs: number; pct: string }>;
} {
    const windowMs = performance.now() - yieldStatsSince;
    let totalYieldMs = 0;
    for (const s of yieldStats.values()) totalYieldMs += s.totalMs;
    const rows = [...yieldStats.entries()]
        .map(([source, s]) => ({
            source, count: s.count, totalMs: Math.round(s.totalMs),
            avgMs: s.count > 0 ? +(s.totalMs / s.count).toFixed(2) : 0,
            maxMs: Math.round(s.maxMs),
            pct: windowMs > 0 ? (s.totalMs / windowMs * 100).toFixed(1) + "%" : "0.0%",
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
    return {
        windowMs: Math.round(windowMs), totalYieldMs: Math.round(totalYieldMs),
        pctOfWindow: windowMs > 0 ? (totalYieldMs / windowMs * 100).toFixed(1) + "%" : "0.0%",
        rows,
    };
}
