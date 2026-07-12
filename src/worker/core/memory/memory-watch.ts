/**
 * Memory Watchpoint System for debugging texture loading
 *
 * Tracks memory regions and detects when data is written to them
 * Also sends updates to UI via postMessage
 */

import { Logger, LogCategory } from '../logger';

interface WatchRegion {
    name: string;
    start: number;
    end: number;
    size: number;
    createdAt: number;
    lastChecksum: number;
    lastNonZeroBytes: number;
    checksHistory: { time: number; checksum: number; nonZero: number }[];
}

interface LargeWriteEvent {
    source: string; // e.g. "ReadFile"
    address: number;
    size: number;
    timestamp: number;
    intersectsWithSurface: boolean;
    matchedRegionName?: string;
    matchedRegionStart?: number;
}

interface AssetWriteEvent {
    source: string; // e.g. "ReadFile:car.bmq"
    address: number;
    size: number;
    timestamp: number;
    sample: Uint8Array;
}

// Helper to send messages to UI
const postToUI = (type: string, data: any) => {
    try {
        self.postMessage({ type, data });
    } catch {
        // Worker context may not be available
    }
};

class MemoryWatchSystem {
    private regions: Map<number, WatchRegion> = new Map();
    private mem: Uint8Array | null = null;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private enabled = true;
    private largeWriteEvents: LargeWriteEvent[] = [];
    private assetWriteEvents: AssetWriteEvent[] = [];
    private maxLargeWriteEvents = 50; // Keep last 50 large write events
    private maxAssetWriteEvents = 50; // Keep last 50 asset write events

    /**
     * Initialize with memory reference
     */
    init(mem: Uint8Array) {
        this.mem = mem;
        Logger.log(LogCategory.SYSTEM, `[MEMWATCH] Initialized with ${mem.length} bytes`);
    }

    /**
     * Register a memory region to watch
     */
    watch(name: string, start: number, size: number) {
        if (!this.enabled) return;

        const region: WatchRegion = {
            name,
            start,
            end: start + size,
            size,
            createdAt: performance.now(),
            lastChecksum: 0,
            lastNonZeroBytes: 0,
            checksHistory: [],
        };

        // Calculate initial state
        if (this.mem) {
            const { checksum, nonZeroCount } = this.analyzeRegion(region);
            region.lastChecksum = checksum;
            region.lastNonZeroBytes = nonZeroCount;
        }

        this.regions.set(start, region);

        Logger.log(LogCategory.DDRAW,
            `[MEMWATCH] Watching "${name}" @ 0x${start.toString(16)}-0x${(start + size).toString(16)} (${size} bytes)`
        );

        // Notify UI
        postToUI("memwatch_region", { name, start, size });
    }

    /**
     * Unwatch a region
     */
    unwatch(start: number) {
        const region = this.regions.get(start);
        if (region) {
            Logger.log(LogCategory.DDRAW, `[MEMWATCH] Stopped watching "${region.name}" @ 0x${start.toString(16)}`);
            this.regions.delete(start);
            postToUI("memwatch_unwatch", { start });
        }
    }

    /**
     * Check a specific region for changes
     */
    checkRegion(start: number): { changed: boolean; nonZeroCount: number; samplePixels: string } {
        const region = this.regions.get(start);
        if (!region || !this.mem) {
            return { changed: false, nonZeroCount: 0, samplePixels: '' };
        }

        const { checksum, nonZeroCount, samplePixels } = this.analyzeRegion(region);
        const changed = checksum !== region.lastChecksum;

        if (changed) {
            const elapsed = performance.now() - region.createdAt;
            Logger.log(LogCategory.DDRAW,
                `[MEMWATCH] DATA CHANGED in "${region.name}" @ 0x${start.toString(16)} after ${elapsed.toFixed(1)}ms: ` +
                `nonZero=${nonZeroCount}/${region.size} (${(100 * nonZeroCount / region.size).toFixed(1)}%) ` +
                `samples: ${samplePixels}`
            );

            region.lastChecksum = checksum;
            region.lastNonZeroBytes = nonZeroCount;
            region.checksHistory.push({ time: elapsed, checksum, nonZero: nonZeroCount });

            // Notify UI
            postToUI("memwatch_update", {
                start,
                nonZeroCount,
                samplePixels
            });
        }

        return { changed, nonZeroCount, samplePixels };
    }

    /**
     * Check all watched regions
     */
    checkAll() {
        if (!this.enabled || !this.mem) return;

        for (const [start] of this.regions) {
            this.checkRegion(start);
        }
    }

    /**
     * Dump current state of a watched region
     */
    dump(start: number, maxBytes = 64): string {
        const region = this.regions.get(start);
        if (!region || !this.mem) {
            return `[MEMWATCH] Region 0x${start.toString(16)} not found`;
        }

        const { nonZeroCount, samplePixels, firstNonZeroOffset } = this.analyzeRegion(region);

        let dump = `[MEMWATCH] Dump "${region.name}" @ 0x${start.toString(16)}:\n`;
        dump += `  Size: ${region.size} bytes\n`;
        dump += `  Non-zero: ${nonZeroCount} bytes (${(100 * nonZeroCount / region.size).toFixed(1)}%)\n`;
        dump += `  First non-zero offset: ${firstNonZeroOffset === -1 ? 'N/A' : `+0x${firstNonZeroOffset.toString(16)}`}\n`;
        dump += `  Sample pixels (16-bit): ${samplePixels}\n`;

        // Hex dump first N bytes
        const dumpSize = Math.min(maxBytes, region.size);
        let hex = '  Hex: ';
        for (let i = 0; i < dumpSize; i++) {
            hex += this.mem[region.start + i].toString(16).padStart(2, '0') + ' ';
            if ((i + 1) % 16 === 0) hex += '\n       ';
        }
        dump += hex;

        return dump;
    }

    /**
     * Manual check triggered from code (call this before Load, etc)
     * OPTIMIZED: Uses sampling instead of checking every byte
     */
    probe(name: string, start: number, size: number): { hasData: boolean; nonZeroCount: number } {
        if (!this.mem) return { hasData: false, nonZeroCount: 0 };

        const mem = this.mem;
        const end = start + size;

        // IMPROVED: Check more sample points and always check start/end
        // For textures (256x256@16bpp = 131072 bytes), we need better coverage
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const sampleCount = Math.min(16, Math.max(8, Math.floor(size / 4096))); // More samples for larger buffers
        let hasNonZero = false;
        let nonZeroSamples = 0;

        // Always check first 64 bytes (texture header/start)
        if (start + 64 <= end) {
            for (let i = 0; i < 16; i++) {
                const offset = start + i * 4;
                if (offset + 4 <= end) {
                    const v = view.getUint32(offset, true);
                    if (v !== 0) {
                        hasNonZero = true;
                        nonZeroSamples++;
                        break;
                    }
                }
            }
        }

        // Check last 64 bytes (texture end)
        if (!hasNonZero && end >= 64) {
            const lastStart = Math.max(start, end - 64);
            for (let i = 0; i < 16; i++) {
                const offset = lastStart + i * 4;
                if (offset + 4 <= end) {
                    const v = view.getUint32(offset, true);
                    if (v !== 0) {
                        hasNonZero = true;
                        nonZeroSamples++;
                        break;
                    }
                }
            }
        }

        // Check sample points across the buffer
        for (let i = 0; i < sampleCount && !hasNonZero; i++) {
            const offset = start + Math.floor((size * i) / sampleCount);
            // Check 16 bytes at each sample point (4 x 32-bit reads)
            if (offset + 16 <= end) {
                const v1 = view.getUint32(offset, true);
                const v2 = view.getUint32(offset + 4, true);
                const v3 = view.getUint32(offset + 8, true);
                const v4 = view.getUint32(offset + 12, true);
                if ((v1 | v2 | v3 | v4) !== 0) {
                    hasNonZero = true;
                    nonZeroSamples++;
                    break;
                }
            }
        }

        // Estimate non-zero count based on samples found
        const nonZeroCount = hasNonZero ? nonZeroSamples : 0;

        // Only log in verbose mode (disable for performance)
        // Logger.log(LogCategory.DDRAW, `[MEMWATCH] Probe "${name}" @ 0x${start.toString(16)}: hasData=${hasNonZero}`);

        // Only notify UI occasionally (throttled)
        if (this.probeCounter++ % 100 === 0) {
            postToUI("memwatch_probe", { name, start, size, hasData: hasNonZero, nonZeroCount });
        }

        return { hasData: hasNonZero, nonZeroCount };
    }

    private probeCounter = 0;

    /**
     * Start periodic checking
     */
    startPolling(intervalMs = 500) {
        if (this.intervalId) return;

        this.intervalId = setInterval(() => this.checkAll(), intervalMs);
        Logger.log(LogCategory.SYSTEM, `[MEMWATCH] Started polling every ${intervalMs}ms`);
    }

    /**
     * Stop periodic checking
     */
    stopPolling() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            Logger.log(LogCategory.SYSTEM, `[MEMWATCH] Stopped polling`);
        }
    }

    /**
     * Get list of all watched regions
     */
    getWatchedRegions(): WatchRegion[] {
        return Array.from(this.regions.values());
    }

    /**
     * Enable/disable the system
     */
    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        Logger.log(LogCategory.SYSTEM, `[MEMWATCH] ${enabled ? 'Enabled' : 'Disabled'}`);
    }

    /**
     * Analyze a memory region
     */
    private analyzeRegion(region: WatchRegion): {
        checksum: number;
        nonZeroCount: number;
        samplePixels: string;
        firstNonZeroOffset: number;
    } {
        if (!this.mem) {
            return { checksum: 0, nonZeroCount: 0, samplePixels: '', firstNonZeroOffset: -1 };
        }

        let checksum = 0;
        let nonZeroCount = 0;
        let firstNonZeroOffset = -1;
        const samplePixels: string[] = [];

        // Calculate checksum and count non-zero bytes
        // Use sampling for large regions (check every Nth byte)
        const step = region.size > 65536 ? Math.floor(region.size / 4096) : 1;

        for (let i = 0; i < region.size; i += step) {
            const byte = this.mem[region.start + i];
            checksum = (checksum * 31 + byte) >>> 0; // Simple hash
            if (byte !== 0) {
                nonZeroCount++;
                if (firstNonZeroOffset === -1) firstNonZeroOffset = i;
            }
        }

        // Adjust count if we sampled
        if (step > 1) {
            nonZeroCount *= step;
        }

        // Sample first 4 pixels (assuming 16bpp)
        for (let i = 0; i < 4; i++) {
            const offset = region.start + i * 2;
            if (offset + 1 < region.end) {
                const pixel = this.mem[offset] | (this.mem[offset + 1] << 8);
                samplePixels.push(`0x${pixel.toString(16)}`);
            }
        }

        return {
            checksum,
            nonZeroCount,
            samplePixels: samplePixels.join(' '),
            firstNonZeroOffset
        };
    }

    /**
     * Record a large write event (called from MemoryGuard or other sources)
     */
    recordLargeWrite(source: string, address: number, size: number, intersectsWithSurface: boolean, matchedRegionName?: string, matchedRegionStart?: number): void {
        const event: LargeWriteEvent = {
            source,
            address,
            size,
            timestamp: performance.now(),
            intersectsWithSurface,
            matchedRegionName,
            matchedRegionStart,
        };

        this.largeWriteEvents.unshift(event); // Add to front
        if (this.largeWriteEvents.length > this.maxLargeWriteEvents) {
            this.largeWriteEvents = this.largeWriteEvents.slice(0, this.maxLargeWriteEvents);
        }

        // Notify UI
        postToUI("memwatch_largewrite", {
            source: event.source,
            address: event.address,
            size: event.size,
            intersectsWithSurface: event.intersectsWithSurface,
            matchedRegionName: event.matchedRegionName,
            matchedRegionStart: event.matchedRegionStart,
        });
    }

    /**
     * Record an asset write event (small PRM/BMQ reads)
     */
    recordAssetWrite(source: string, address: number, size: number, sample: Uint8Array): void {
        const event: AssetWriteEvent = {
            source,
            address,
            size,
            timestamp: performance.now(),
            sample,
        };

        this.assetWriteEvents.unshift(event);
        if (this.assetWriteEvents.length > this.maxAssetWriteEvents) {
            this.assetWriteEvents = this.assetWriteEvents.slice(0, this.maxAssetWriteEvents);
        }
    }

    /**
     * Get recent large write events
     */
    getLargeWriteEvents(): LargeWriteEvent[] {
        return [...this.largeWriteEvents];
    }

    /**
     * Get recent asset write events
     */
    getAssetWriteEvents(): AssetWriteEvent[] {
        return [...this.assetWriteEvents];
    }

    /**
     * Search entire memory for a byte pattern (e.g. to find where data was copied "silently")
     */
    findBytes(pattern: Uint8Array, step = 1, maxHits = 5): number[] {
        if (!this.mem || pattern.length === 0) return [];
        const hits: number[] = [];
        const mem = this.mem;
        const patLen = pattern.length;
        const searchLimit = mem.length - patLen;

        for (let i = 0x10000; i < searchLimit; i += step) {
            if (mem[i] === pattern[0]) {
                let match = true;
                for (let j = 1; j < patLen; j++) {
                    if (mem[i + j] !== pattern[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    hits.push(i);
                    if (hits.length >= maxHits) break;
                }
            }
        }
        return hits;
    }

    /**
     * Reset all watches
     */
    reset() {
        this.stopPolling();
        this.regions.clear();
        this.largeWriteEvents = [];
        this.assetWriteEvents = [];
        Logger.log(LogCategory.SYSTEM, `[MEMWATCH] Reset`);
        postToUI("memwatch_reset", {});
    }
}

// Global singleton
export const memoryWatch = new MemoryWatchSystem();
