/**
 * CallbackCoordinator — Callback safety gate + deferred queue.
 *
 * Simple rules:
 * 1. No reentrancy — one callback at a time
 * 2. Bounded queue — drop oldest on overflow
 */

import { Logger, LogCategory } from '../logger';

export interface QueuedCallback {
    type: 'timer' | 'message' | 'apc' | 'generic';
    callback: () => void;
    /** For timer callbacks: timer ID for dedup */
    timerId?: number;
}

const MAX_QUEUE_SIZE = 256;
const MAX_CALLBACK_DEPTH = 16;

export class CallbackCoordinator {
    private queue: QueuedCallback[] = [];
    private callbackDepth = 0;

    // Stats
    private totalEnqueued = 0;
    private totalDispatched = 0;
    private totalDropped = 0;

    /**
     * Enqueue a callback for deferred dispatch.
     */
    enqueue(cb: QueuedCallback): void {
        if (this.queue.length >= MAX_QUEUE_SIZE) {
            this.queue.shift();
            this.totalDropped++;
        }
        this.queue.push(cb);
        this.totalEnqueued++;
    }

    /**
     * Dispatch one queued callback. Returns true if one was dispatched.
     * Allows reentrancy up to MAX_CALLBACK_DEPTH (e.g. SendMessage inside WndProc).
     */
    dispatchOne(): boolean {
        if (this.callbackDepth >= MAX_CALLBACK_DEPTH || this.queue.length === 0) return false;

        const cb = this.queue.shift()!;
        this.callbackDepth++;
        try {
            cb.callback();
            this.totalDispatched++;
        } finally {
            this.callbackDepth--;
        }
        return true;
    }

    isEmpty(): boolean {
        return this.queue.length === 0;
    }

    get queueSize(): number {
        return this.queue.length;
    }

    get isDispatching(): boolean { return this.callbackDepth > 0; }
    get currentDepth(): number { return this.callbackDepth; }

    getStats(): { queueSize: number; totalEnqueued: number; totalDispatched: number; totalDropped: number } {
        return {
            queueSize: this.queue.length,
            totalEnqueued: this.totalEnqueued,
            totalDispatched: this.totalDispatched,
            totalDropped: this.totalDropped,
        };
    }

    reset(): void {
        this.queue.length = 0;
        this.callbackDepth = 0;
        this.totalEnqueued = 0;
        this.totalDispatched = 0;
        this.totalDropped = 0;
    }
}
