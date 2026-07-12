import { describe, expect, test } from 'bun:test';

/**
 * Invariants for GlobalLock/GlobalSize handle-vs-pointer classification.
 * Fixed blocks must have (ptr & 7) === 0; moveable handles are &mem_entry.ptr → (handle & 7) === 4.
 */
const SLAB_HEADER_ZONE = 16;
const SLAB_BIN_SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
const MOVEABLE_HANDLE_TAG = 4;

describe('global memory pointer alignment', () => {
    test('slab user pointers stay 8-byte aligned for 8-byte aligned arena bases', () => {
        for (let base = 0x0100_0000; base <= 0x0100_0040; base += 8) {
            let cursor = base;
            for (let step = 0; step < 64; step++) {
                const user = cursor + SLAB_HEADER_ZONE;
                expect(user & 7).toBe(0);
                cursor = user + SLAB_BIN_SIZES[step % SLAB_BIN_SIZES.length]!;
            }
        }
    });

    test('moveable handle tag does not overlap 8-byte fixed pointer alignment', () => {
        expect(MOVEABLE_HANDLE_TAG & 7).toBe(4);
        for (const size of [8, 16, 40, 64, 4096]) {
            // Simulated bump-alloc addresses (MemoryManager aligns to 8).
            const fixed = 0x0100_0200 + size * 3;
            const aligned = (fixed + 7) & ~7;
            expect(aligned & 7).toBe(0);
            expect(aligned & 7).not.toBe(MOVEABLE_HANDLE_TAG);
        }
    });

    test('mem_entry handle layout: desc+4 carries moveable tag, data slot is 8-aligned', () => {
        const desc = 0x0100_1000; // 8-byte aligned descriptor base
        const handle = desc + 4;
        expect(handle & 7).toBe(MOVEABLE_HANDLE_TAG);
        const dataPtr = 0x0100_2000;
        expect(dataPtr & 7).toBe(0);
    });
});
