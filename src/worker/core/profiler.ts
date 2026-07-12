/**
 * Lightweight profiler for tracking performance in hot paths.
 * Designed for low overhead when disabled.
 *
 * Operation IDs are global. Thunk dispatcher uses "dll:apiname" (e.g. ddraw:idirectdrawsurface7_lock).
 * Manual spans should use other names (e.g. SurfaceSyncManager.syncToCPU, syncToCPU:gpuWait) to avoid collision.
 *
 * For async operations, use startAsync()/endAsync() which support concurrent operations with the same ID.
 * For sync operations, start()/end() is slightly faster but NOT safe for concurrent/nested calls.
 */
export class Profiler {
    private enabled: boolean = false;
    private entries: Map<string, {
        totalTime: number;
        count: number;
        maxTime: number;
        counters: Record<string, number>;
    }> = new Map();

    // For sync operations (NOT safe for concurrent calls with same ID)
    private startTimes: Map<string, number> = new Map();

    // For async operations - uses stack to support concurrent/nested calls
    private asyncStartTimes: Map<string, number[]> = new Map();

    // Token-based async tracking for maximum safety
    private nextToken: number = 0;
    private tokenStarts: Map<number, { id: string; startTime: number }> = new Map();

    // Leak detection thresholds
    private static readonly MAX_ASYNC_STACK_SIZE = 100;
    private static readonly MAX_PENDING_TOKENS = 1000;
    private static readonly LEAK_CHECK_INTERVAL = 60000; // 1 minute
    private lastLeakCheck = 0;

    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        if (!enabled) {
            this.reset();
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    start(id: string) {
        if (!this.enabled) return;
        this.startTimes.set(id, performance.now());
    }

    end(id: string) {
        if (!this.enabled) return;
        const startTime = this.startTimes.get(id);
        if (startTime === undefined) return;

        const endTime = performance.now();
        const duration = endTime - startTime;

        this.recordDuration(id, duration);
    }

    /**
     * Start timing an async operation. Uses a stack internally to support
     * concurrent/nested calls with the same ID.
     *
     * Usage:
     *   profiler.startAsync('fileRead');
     *   await readFile();
     *   profiler.endAsync('fileRead');
     */
    startAsync(id: string) {
        if (!this.enabled) return;

        let stack = this.asyncStartTimes.get(id);
        if (!stack) {
            stack = [];
            this.asyncStartTimes.set(id, stack);
        }
        stack.push(performance.now());
    }

    /**
     * End timing an async operation. Pops the most recent start time for this ID.
     */
    endAsync(id: string) {
        if (!this.enabled) return;

        const stack = this.asyncStartTimes.get(id);
        if (!stack || stack.length === 0) return;

        const startTime = stack.pop()!;
        const duration = performance.now() - startTime;

        this.recordDuration(id, duration);
    }

    /**
     * Start timing with a unique token. Most reliable for async operations
     * where the same logical operation might have different IDs or complex nesting.
     *
     * Usage:
     *   const token = profiler.startToken('fileRead');
     *   await readFile();
     *   profiler.endToken(token);
     */
    startToken(id: string): number {
        if (!this.enabled) return -1;

        const token = this.nextToken++;
        this.tokenStarts.set(token, { id, startTime: performance.now() });
        return token;
    }

    /**
     * End timing for a specific token.
     */
    endToken(token: number) {
        if (!this.enabled || token < 0) return;

        const data = this.tokenStarts.get(token);
        if (!data) return;

        this.tokenStarts.delete(token);
        const duration = performance.now() - data.startTime;

        this.recordDuration(data.id, duration);
    }

    /**
     * Helper to wrap an async function with profiling.
     *
     * Usage:
     *   const result = await profiler.wrapAsync('fileRead', () => readFile(path));
     */
    async wrapAsync<T>(id: string, fn: () => Promise<T>): Promise<T> {
        if (!this.enabled) return fn();

        const startTime = performance.now();
        try {
            return await fn();
        } finally {
            const duration = performance.now() - startTime;
            this.recordDuration(id, duration);
        }
    }

    /**
     * Internal helper to record a duration measurement
     */
    private recordDuration(id: string, duration: number) {
        let entry = this.entries.get(id);
        if (!entry) {
            entry = { totalTime: 0, count: 0, maxTime: 0, counters: {} };
            this.entries.set(id, entry);
        }

        entry.totalTime += duration;
        entry.count++;
        entry.maxTime = Math.max(entry.maxTime, duration);
    }

    /**
     * Increments a named counter for a given profile ID.
     * Useful for tracking bytes synced, allocations, etc.
     */
    increment(id: string, counterName: string, value: number = 1) {
        if (!this.enabled) return;
        
        let entry = this.entries.get(id);
        if (!entry) {
            entry = { totalTime: 0, count: 0, maxTime: 0, counters: {} };
            this.entries.set(id, entry);
        }

        entry.counters[counterName] = (entry.counters[counterName] || 0) + value;
    }

    getStats() {
        // Periodic leak check
        this.checkLeaks();

        const stats: Record<string, any> = {};
        for (const [id, entry] of this.entries.entries()) {
            stats[id] = {
                avgTime: entry.count > 0 ? entry.totalTime / entry.count : 0,
                totalTime: entry.totalTime,
                count: entry.count,
                maxTime: entry.maxTime,
                counters: entry.counters
            };
        }
        return stats;
    }

    /**
     * Check for potential memory leaks in async tracking structures.
     * Called periodically from getStats() to avoid overhead.
     */
    private checkLeaks(): void {
        const now = performance.now();
        if (now - this.lastLeakCheck < Profiler.LEAK_CHECK_INTERVAL) {
            return;
        }
        this.lastLeakCheck = now;

        // Check async stacks for potential leaks
        let totalAsyncPending = 0;
        const leakyStacks: string[] = [];
        for (const [id, stack] of this.asyncStartTimes.entries()) {
            totalAsyncPending += stack.length;
            if (stack.length > Profiler.MAX_ASYNC_STACK_SIZE) {
                leakyStacks.push(`${id}(${stack.length})`);
                // Trim to prevent unbounded growth
                stack.splice(0, stack.length - Profiler.MAX_ASYNC_STACK_SIZE);
            }
        }

        // Check token tracking for potential leaks
        if (this.tokenStarts.size > Profiler.MAX_PENDING_TOKENS) {
            // Find and remove oldest tokens (likely leaked)
            const tokens = Array.from(this.tokenStarts.entries())
                .sort((a, b) => a[1].startTime - b[1].startTime);
            const toRemove = tokens.slice(0, tokens.length - Profiler.MAX_PENDING_TOKENS);
            for (const [token] of toRemove) {
                this.tokenStarts.delete(token);
            }
            console.warn(
                `[Profiler] Leak detected: ${toRemove.length} stale tokens removed ` +
                `(oldest: ${toRemove.map(t => t[1].id).slice(0, 5).join(', ')}...)`
            );
        }

        // Log warnings for leaky stacks
        if (leakyStacks.length > 0) {
            console.warn(
                `[Profiler] Leak detected: async stacks exceeding limit: ${leakyStacks.join(', ')}`
            );
        }

        // Log summary if there's significant pending state
        if (totalAsyncPending > 50 || this.tokenStarts.size > 50) {
            console.warn(
                `[Profiler] Pending state: asyncStacks=${totalAsyncPending} tokens=${this.tokenStarts.size}`
            );
        }
    }

    /**
     * Get leak detection statistics for debugging.
     */
    getLeakStats(): {
        asyncStacksCount: number;
        totalAsyncPending: number;
        pendingTokens: number;
        largestStacks: Array<{ id: string; size: number }>;
    } {
        let totalAsyncPending = 0;
        const stackSizes: Array<{ id: string; size: number }> = [];

        for (const [id, stack] of this.asyncStartTimes.entries()) {
            totalAsyncPending += stack.length;
            if (stack.length > 0) {
                stackSizes.push({ id, size: stack.length });
            }
        }

        stackSizes.sort((a, b) => b.size - a.size);

        return {
            asyncStacksCount: this.asyncStartTimes.size,
            totalAsyncPending,
            pendingTokens: this.tokenStarts.size,
            largestStacks: stackSizes.slice(0, 10),
        };
    }

    reset() {
        this.entries.clear();
        this.startTimes.clear();
        this.asyncStartTimes.clear();
        this.tokenStarts.clear();
        this.nextToken = 0;
        // Also reset GetPixel stats
        if (this.getPixelStatsGetter) {
            const clearFn = (this as any)._clearGetPixelStats;
            if (clearFn) clearFn();
        }
    }

    // GetPixel stats integration - set by GDI32 module
    private getPixelStatsGetter: (() => Array<{ hdc: number; count: number; maxX: number; maxY: number; estimatedSize: string }>) | null = null;

    /**
     * Register GetPixel stats getter (called by GDI32 module)
     */
    registerGetPixelStats(
        getter: () => Array<{ hdc: number; count: number; maxX: number; maxY: number; estimatedSize: string }>,
        clearer: () => void
    ): void {
        this.getPixelStatsGetter = getter;
        (this as any)._clearGetPixelStats = clearer;
    }

    /**
     * Get detailed GetPixel usage statistics per HDC.
     * Shows which surfaces are being queried pixel-by-pixel.
     * Call this to understand GetPixel hotspots.
     */
    getGetPixelStats(): Array<{ hdc: number; count: number; maxX: number; maxY: number; estimatedSize: string }> {
        if (!this.getPixelStatsGetter) {
            console.warn('[Profiler] GetPixel stats not registered. GDI32 module may not be loaded.');
            return [];
        }
        return this.getPixelStatsGetter();
    }
}

export const profiler = new Profiler();
