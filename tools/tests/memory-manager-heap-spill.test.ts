import { describe, expect, test } from "bun:test";
import { AddressSpace } from "../../src/worker/core/memory/address-space";
import { MemoryManager } from "../../src/worker/core/process";
import { MEM_HEAP_SIZE, MEM_SURFACE_BASE } from "../../src/worker/core/cpu/emulator-config";

// 768 MB of guest RAM: the whole 512 MB HEAP window plus a 48 MB SURFACE bucket.
const RAM = 0x30000000;
const BLOCK = 16 << 20;

function manager(): MemoryManager {
    const mem = new Uint8Array(RAM);
    const as = new AddressSpace(() => mem);
    as.initializeLayout(RAM);
    const mm = new MemoryManager(as);
    mm.refreshLayoutBuckets();
    return mm;
}

function bucket(mm: MemoryManager, kind: string) {
    return mm.getBucketStats().find((b) => b.kind === kind)!;
}

describe("MemoryManager HEAP spill", () => {
    test("a HEAP allocation that no longer fits the window lands in SURFACE, is freed there and reused", () => {
        const mm = manager();
        expect(bucket(mm, "HEAP").limit - bucket(mm, "HEAP").base).toBeLessThanOrEqual(MEM_HEAP_SIZE);
        expect(bucket(mm, "SURFACE")).toBeDefined();

        // Fill the window with 16 MB blocks until the next one cannot fit.
        const blocks: number[] = [];
        for (;;) {
            const heap = bucket(mm, "HEAP");
            if (heap.limit - heap.next < BLOCK) break;
            blocks.push(mm.alloc(BLOCK, "HEAP"));
        }
        expect(blocks.length).toBeGreaterThan(20);

        const surfaceLiveBefore = bucket(mm, "SURFACE").liveUsed;
        const spilled = mm.alloc(BLOCK, "HEAP");
        expect(spilled).toBeGreaterThanOrEqual(MEM_SURFACE_BASE);
        expect(bucket(mm, "SURFACE").liveUsed - surfaceLiveBefore).toBe(BLOCK);

        mm.free(spilled);
        // Freed at the frontier the block may rewind it instead of joining the list; live bytes tell.
        expect(bucket(mm, "SURFACE").liveUsed).toBe(surfaceLiveBefore);

        // The next overflow reuses the freed SURFACE block rather than the frontier.
        const again = mm.alloc(BLOCK, "HEAP");
        expect(again).toBe(spilled);

        // Regular HEAP blocks still free into the HEAP window.
        const heapBefore = bucket(mm, "HEAP").freeBytes;
        mm.free(blocks[0]!);
        expect(bucket(mm, "HEAP").freeBytes - heapBefore).toBe(BLOCK);
        const back = mm.alloc(BLOCK, "HEAP");
        expect(back).toBe(blocks[0]!);
    });

    test("a SURFACE request that overflows is not redirected", () => {
        const mm = manager();
        const surface = bucket(mm, "SURFACE");
        expect(() => mm.alloc(surface.limit - surface.base + BLOCK, "SURFACE")).toThrow();
    });
});
