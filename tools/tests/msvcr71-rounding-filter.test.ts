import { describe, expect, it } from 'bun:test';
import { msvcr71Descriptor } from '../../src/worker/core/hle-lib/libs/msvcr71/descriptor';
import { assembleMsvcr71FiniteDoubleFilter } from '../../src/worker/core/hle-lib/libs/msvcr71/rounding-filter';

function i32(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

describe('MSVCR71 finite ceil/floor filter', () => {
    it('routes finite values to WASM and special exponents to the original', () => {
        const base = 0x1000;
        const stub = 0x2000;
        const original = 0x3000;
        const code = assembleMsvcr71FiniteDoubleFilter(base, stub, original);

        expect(Array.from(code.slice(0, 15))).toEqual([
            0x8b, 0x44, 0x24, 0x08,
            0x25, 0x00, 0x00, 0xf0, 0x7f,
            0x3d, 0x00, 0x00, 0xf0, 0x7f,
            0x0f,
        ]);
        const originalJmp = 20;
        const stubJmp = 25;
        expect(base + originalJmp + 5 + i32(code, originalJmp + 1)).toBe(original);
        expect(base + stubJmp + 5 + i32(code, stubJmp + 1)).toBe(stub);
    });

    it('binds both VC71 x87 fallbacks to the generic math handlers', () => {
        expect(msvcr71Descriptor.functions.ceil_x87.hypercallHandlerId).toBe(44);
        expect(msvcr71Descriptor.functions.floor_x87.hypercallHandlerId).toBe(45);
        expect(msvcr71Descriptor.functions.ceil_x87.entryFilter).toBeDefined();
        expect(msvcr71Descriptor.functions.floor_x87.entryFilter).toBeDefined();
    });
});
