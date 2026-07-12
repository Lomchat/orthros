// Unit tests for CachedSource — the LRU block-cache decorator that gives an
// async-only ZipSource a working readRangeSync for warm blocks. Pure unit: no
// worker/DOM. Pins the cache contract (sync-miss → async fault → sync-hit),
// cross-block assembly, fault coalescing, LRU eviction, and EOF handling.

import { describe, it, expect } from "bun:test";
import { CachedSource, computeAdaptiveMaxBytes, MAX_CACHE_BYTES, MIN_CACHE_BYTES } from "../../src/worker/runtime/filesystem/cached-source";
import type { ZipSource } from "@bottleship/formats/zip";

/** Deterministic 0..255 ramp so any range's bytes are predictable. */
function ramp(n: number): Uint8Array {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = i & 0xff;
    return a;
}

/** Async-only fake source that counts inner reads and can be gated to test
 *  coalescing. Mirrors BlobSource semantics (no readRangeSync). */
class FakeSource implements ZipSource {
    size: number;
    calls = 0;
    ranges: Array<[number, number]> = [];
    gate: Promise<void> | null = null;
    private data: Uint8Array;

    constructor(data: Uint8Array) {
        this.data = data;
        this.size = data.byteLength;
    }

    async readRange(start: number, end: number): Promise<Uint8Array> {
        this.calls++;
        this.ranges.push([start, end]);
        if (this.gate) await this.gate;
        const s = Math.max(0, Math.min(start, this.size));
        const e = Math.max(s, Math.min(end, this.size));
        // Return a COPY so the cache can't accidentally alias the backing buffer.
        return this.data.slice(s, e);
    }
}

describe("CachedSource", () => {
    it("size mirrors the inner source", () => {
        const c = new CachedSource(new FakeSource(ramp(1000)));
        expect(c.size).toBe(1000);
    });

    it("readRangeSync misses cold, hits after an async fault of the same block", async () => {
        const fake = new FakeSource(ramp(256));
        const c = new CachedSource(fake, { blockSize: 16 });

        // Cold: block not resident → null (caller would go async).
        expect(c.readRangeSync(0, 8)).toBeNull();
        expect(fake.calls).toBe(0);

        // Async fault pulls in block 0.
        const got = await c.readRange(0, 8);
        expect(Array.from(got)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(fake.calls).toBe(1);
        // The fault read a whole 16-byte block, not just the 8 requested.
        expect(fake.ranges[0]).toEqual([0, 16]);

        // Warm: now served synchronously, no new inner call.
        const sync = c.readRangeSync(4, 12);
        expect(sync).not.toBeNull();
        expect(Array.from(sync!)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
        expect(fake.calls).toBe(1);
    });

    it("faults a cold block in SYNCHRONOUSLY when the inner source reads sync (BlobSource via FileReaderSync)", () => {
        // Sync-capable inner: mirrors BlobSource.readRangeSync. The whole point of
        // the fix — a cold block no longer false-EOFs the guest's sync read path.
        let syncCalls = 0;
        const data = ramp(256);
        const inner: ZipSource = {
            size: 256,
            async readRange(s, e) { return data.slice(s, e); },
            readRangeSync(s, e) { syncCalls++; return data.slice(s, e); },
        };
        const c = new CachedSource(inner, { blockSize: 16 });

        // Cold block, but inner is sync → served (not null), one inner fault.
        const got = c.readRangeSync(0, 8);
        expect(got).not.toBeNull();
        expect(Array.from(got!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(syncCalls).toBe(1);

        // Same block now resident → served from RAM, no new inner call.
        const warm = c.readRangeSync(8, 16);
        expect(Array.from(warm!)).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
        expect(syncCalls).toBe(1);
        expect(c.stats().faults).toBe(1);
    });

    it("sync fault-in bails to null if the inner sync read fails (transient)", () => {
        const inner: ZipSource = {
            size: 256,
            async readRange(s, e) { return ramp(256).slice(s, e); },
            readRangeSync() { return null; }, // simulate a FileReaderSync failure
        };
        const c = new CachedSource(inner, { blockSize: 16 });
        expect(c.readRangeSync(0, 8)).toBeNull();
    });

    it("assembles a read spanning multiple blocks", async () => {
        const fake = new FakeSource(ramp(256));
        const c = new CachedSource(fake, { blockSize: 16 });

        // [10, 50) covers blocks 0,1,2,3 (16-byte blocks).
        const got = await c.readRange(10, 50);
        expect(got.length).toBe(40);
        for (let i = 0; i < 40; i++) expect(got[i]).toBe((10 + i) & 0xff);
        expect(fake.calls).toBe(4);

        // Whole span now warm → single sync hit.
        const sync = c.readRangeSync(10, 50);
        expect(sync).not.toBeNull();
        expect(Array.from(sync!)).toEqual(Array.from(got));
        expect(fake.calls).toBe(4);
    });

    it("sync read returns null when only SOME covering blocks are resident", async () => {
        const fake = new FakeSource(ramp(256));
        const c = new CachedSource(fake, { blockSize: 16 });

        await c.readRange(0, 8); // block 0 only
        // [8, 24) spans block 0 (resident) + block 1 (cold) → must miss.
        expect(c.readRangeSync(8, 24)).toBeNull();
    });

    it("coalesces concurrent faults of the same block into one inner read", async () => {
        const fake = new FakeSource(ramp(256));
        let release!: () => void;
        fake.gate = new Promise<void>((r) => { release = r; });
        const c = new CachedSource(fake, { blockSize: 16 });

        const p1 = c.readRange(0, 4);
        const p2 = c.readRange(8, 12); // same block 0, still in-flight
        release();
        const [a, b] = await Promise.all([p1, p2]);

        expect(Array.from(a)).toEqual([0, 1, 2, 3]);
        expect(Array.from(b)).toEqual([8, 9, 10, 11]);
        expect(fake.calls).toBe(1); // one fault served both
    });

    it("evicts LRU blocks past the byte budget but stays correct", async () => {
        const fake = new FakeSource(ramp(1024));
        // 16-byte blocks, budget 48 bytes ⇒ at most 3 resident blocks.
        const c = new CachedSource(fake, { blockSize: 16, maxBytes: 48 });

        await c.readRange(0, 16);   // block 0
        await c.readRange(16, 32);  // block 1
        await c.readRange(32, 48);  // block 2
        expect(c.stats().residentBytes).toBeLessThanOrEqual(48);

        await c.readRange(48, 64);  // block 3 → evicts block 0 (oldest)
        expect(c.stats().residentBytes).toBeLessThanOrEqual(48);
        expect(c.readRangeSync(0, 4)).toBeNull(); // block 0 gone

        const callsBefore = fake.calls;
        // Re-reading the evicted block faults again, but data is still correct.
        const re = await c.readRange(0, 4);
        expect(Array.from(re)).toEqual([0, 1, 2, 3]);
        expect(fake.calls).toBe(callsBefore + 1);
    });

    it("touch on access keeps a hot block from being evicted", async () => {
        const fake = new FakeSource(ramp(1024));
        const c = new CachedSource(fake, { blockSize: 16, maxBytes: 48 });

        await c.readRange(0, 16);  // block 0
        await c.readRange(16, 32); // block 1
        await c.readRange(32, 48); // block 2
        // Re-touch block 0 so it's now MRU.
        expect(c.readRangeSync(0, 4)).not.toBeNull();

        await c.readRange(48, 64); // block 3 → should evict block 1 (now oldest), not block 0
        expect(c.readRangeSync(0, 4)).not.toBeNull();   // block 0 survived
        expect(c.readRangeSync(16, 20)).toBeNull();     // block 1 evicted
    });

    it("handles a final partial block at EOF", async () => {
        const fake = new FakeSource(ramp(40)); // 40 bytes, 16-byte blocks ⇒ block 2 has 8 bytes
        const c = new CachedSource(fake, { blockSize: 16 });

        const got = await c.readRange(32, 40);
        expect(Array.from(got)).toEqual([32, 33, 34, 35, 36, 37, 38, 39]);
        expect(fake.ranges[0]).toEqual([32, 40]); // clamped to size, not 32..48

        // Reading past EOF clamps.
        const past = await c.readRange(36, 100);
        expect(Array.from(past)).toEqual([36, 37, 38, 39]);
    });

    it("empty / degenerate ranges return an empty array", async () => {
        const c = new CachedSource(new FakeSource(ramp(64)), { blockSize: 16 });
        expect(Array.from(await c.readRange(10, 10))).toEqual([]);
        expect(Array.from(await c.readRange(50, 20))).toEqual([]); // end < start
        const sync = c.readRangeSync(10, 10);
        expect(sync).not.toBeNull();
        expect(Array.from(sync!)).toEqual([]);
    });

    it("sync readahead faults a run of consecutive blocks in one inner call", () => {
        const calls: Array<[number, number]> = [];
        const data = ramp(1024);
        const inner: ZipSource = {
            size: 1024,
            async readRange(s, e) { return data.slice(s, e); },
            readRangeSync(s, e) { calls.push([s, e]); return data.slice(s, e); },
        };
        const c = new CachedSource(inner, { blockSize: 16, syncReadaheadBlocks: 4 });

        const got = c.readRangeSync(0, 8);
        expect(Array.from(got!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(calls).toEqual([[0, 64]]); // 4 blocks in one inner read

        // The read-ahead blocks are warm — a sequential scan makes no new inner calls.
        expect(c.readRangeSync(16, 64)).not.toBeNull();
        expect(calls.length).toBe(1);

        // Next run starts where the readahead ended.
        c.readRangeSync(64, 72);
        expect(calls).toEqual([[0, 64], [64, 128]]);
    });

    it("sync readahead run stops at a resident block and clamps at EOF", async () => {
        const calls: Array<[number, number]> = [];
        const data = ramp(40); // 16-byte blocks ⇒ blocks 0,1 + 8-byte block 2
        const inner: ZipSource = {
            size: 40,
            async readRange(s, e) { return data.slice(s, e); },
            readRangeSync(s, e) { calls.push([s, e]); return data.slice(s, e); },
        };
        const c = new CachedSource(inner, { blockSize: 16, syncReadaheadBlocks: 8 });

        await c.readRange(16, 32); // block 1 resident
        const got = c.readRangeSync(0, 8); // run must stop before resident block 1
        expect(Array.from(got!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(calls).toEqual([[0, 16]]);

        const tail = c.readRangeSync(32, 40); // run clamps to EOF, not 32..(32+8*16)
        expect(Array.from(tail!)).toEqual([32, 33, 34, 35, 36, 37, 38, 39]);
        expect(calls).toEqual([[0, 16], [32, 40]]);
    });

    it("readahead blocks are evicted independently (per-block slices, correct bytes)", () => {
        const data = ramp(256);
        const inner: ZipSource = {
            size: 256,
            async readRange(s, e) { return data.slice(s, e); },
            readRangeSync(s, e) { return data.slice(s, e); },
        };
        // Budget = 3 blocks; a 4-block readahead run must evict its own oldest and stay correct.
        const c = new CachedSource(inner, { blockSize: 16, maxBytes: 48, syncReadaheadBlocks: 4 });
        const got = c.readRangeSync(0, 64); // spans the whole run
        expect(got).not.toBeNull();
        for (let i = 0; i < 64; i++) expect(got![i]).toBe(i & 0xff);
        expect(c.stats().residentBytes).toBeLessThanOrEqual(48);
    });

    it("a sync fault kicks a self-sustaining, cursor-anchored prefetch pipeline", async () => {
        const syncCalls: Array<[number, number]> = [];
        const asyncCalls: Array<[number, number]> = [];
        const data = ramp(8192);
        const inner: ZipSource = {
            size: 8192,
            async readRange(s, e) { asyncCalls.push([s, e]); return data.slice(s, e); },
            readRangeSync(s, e) { syncCalls.push([s, e]); return data.slice(s, e); },
        };
        // blockSize 16, run = 2 blocks (32 B), keep 3 runs ahead of the cursor.
        const c = new CachedSource(inner, {
            blockSize: 16, syncReadaheadBlocks: 1, prefetchAheadBlocks: 2, prefetchDepthRuns: 3,
        });

        // A single sync fault of block 0 primes MULTIPLE prefetch runs ahead — the
        // pipeline is depth 3, not single-flight. Cursor = block 0, window = 0 + 2*3
        // = block 6, so runs cover blocks 1..6 as three 2-block fetches.
        expect(c.readRangeSync(0, 8)).not.toBeNull();
        expect(syncCalls).toEqual([[0, 16]]);
        await new Promise((r) => setTimeout(r, 0));
        expect(asyncCalls).toEqual([[16, 48], [48, 80], [80, 112]]);

        // Advancing the cursor through already-prefetched blocks does NO sync inner
        // call AND slides the window forward, refilling the pipeline on the HIT.
        expect(c.readRangeSync(16, 112)).not.toBeNull(); // blocks 1..6, all resident
        expect(syncCalls.length).toBe(1);                // never went cold
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        // Cursor now block 6, window → block 12: more runs fetched past the old frontier.
        expect(asyncCalls.length).toBeGreaterThan(3);
        const maxEnd = Math.max(...asyncCalls.map(([, e]) => e));
        expect(maxEnd).toBeGreaterThanOrEqual(112);
    });

    it("prefetch quiesces when the guest stops advancing (window is cursor-anchored)", async () => {
        const asyncCalls: Array<[number, number]> = [];
        const data = ramp(1 << 20); // 1 MiB
        const inner: ZipSource = {
            size: data.byteLength,
            async readRange(s, e) { asyncCalls.push([s, e]); return data.slice(s, e); },
            readRangeSync(s, e) { return data.slice(s, e); },
        };
        const c = new CachedSource(inner, {
            blockSize: 256, syncReadaheadBlocks: 1, prefetchAheadBlocks: 4, prefetchDepthRuns: 4,
        });

        // One read near the start, then let the pipeline settle.
        expect(c.readRangeSync(0, 8)).not.toBeNull();
        for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

        // It must NOT have speculatively pulled the whole 1 MiB — the window bounds
        // prefetch to a bounded distance past the (non-advancing) cursor.
        const bytesPrefetched = asyncCalls.reduce((n, [s, e]) => n + (e - s), 0);
        expect(bytesPrefetched).toBeLessThan(data.byteLength / 4);
    });

    it("matches a ground-truth full read over many random ranges", async () => {
        const data = ramp(2000);
        const truth = data;
        const c = new CachedSource(new FakeSource(data), { blockSize: 64, maxBytes: 5 * 64 });

        // Seeded LCG for deterministic ranges.
        let seed = 123456789;
        const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);

        for (let i = 0; i < 200; i++) {
            const start = rnd(2000);
            const len = rnd(300);
            const end = start + len;
            const got = await c.readRange(start, end);
            const expS = Math.min(start, 2000);
            const expE = Math.min(end, 2000);
            expect(Array.from(got)).toEqual(Array.from(truth.subarray(expS, expE)));

            // Whatever is warm must round-trip identically through the sync path.
            const sync = c.readRangeSync(start, end);
            if (sync !== null) {
                expect(Array.from(sync)).toEqual(Array.from(truth.subarray(expS, expE)));
            }
        }
    });
});

describe("computeAdaptiveMaxBytes", () => {
    it("uses the floor for small archives", () => {
        expect(computeAdaptiveMaxBytes(0)).toBe(MIN_CACHE_BYTES);
        expect(computeAdaptiveMaxBytes(100 * 1024 * 1024)).toBe(MIN_CACHE_BYTES);
    });

    it("scales with archive size up to the cap", () => {
        const gb = 1024 * 1024 * 1024;
        expect(computeAdaptiveMaxBytes(gb)).toBe(Math.floor(gb * 0.15));
        expect(computeAdaptiveMaxBytes(2 * gb)).toBe(MAX_CACHE_BYTES);
    });
});
