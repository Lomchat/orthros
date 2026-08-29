import { describe, expect, it } from 'bun:test';
import { msvcr71Descriptor } from '../../src/worker/core/hle-lib/libs/msvcr71/descriptor';
import {
    assembleMsvcr71FiniteDoubleFilter,
    assembleMsvcr71FloorInline,
    msvcr71FloorInlineReference,
} from '../../src/worker/core/hle-lib/libs/msvcr71/rounding-filter';

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

    it('keeps ceil on WASM and floor on the guest-native leaf', () => {
        expect(msvcr71Descriptor.functions.ceil_x87.hypercallHandlerId).toBe(44);
        expect(msvcr71Descriptor.functions.floor_x87.hypercallHandlerId).toBeUndefined();
        expect(msvcr71Descriptor.functions.ceil_x87.entryFilter).toBeDefined();
        expect(msvcr71Descriptor.functions.floor_x87.entryFilter).toBeDefined();
    });

    it('emits a local SSE2 floor leaf with exact fallback branches', () => {
        const base = 0x1000;
        const original = 0x3000;
        const code = assembleMsvcr71FloorInline(base, original);

        expect(Array.from(code.slice(0, 15))).toEqual([
            0xf2, 0x0f, 0x10, 0x44, 0x24, 0x04,
            0xf2, 0x0f, 0x2c, 0xc0,
            0x3d, 0x00, 0x00, 0x00, 0x80,
        ]);
        expect(base + 15 + 6 + i32(code, 17)).toBe(original);
        expect(base + 29 + 6 + i32(code, 31)).toBe(base + 61);
        expect(base + 35 + 6 + i32(code, 37)).toBe(base + 46);
        expect(Array.from(code.slice(61))).toEqual([0xdd, 0x44, 0x24, 0x04, 0xc3]);
    });

    it('matches Math.floor throughout its admitted domain and declines edges', () => {
        for (const value of [-1234.75, -2, -1.1, -0.5, -0, 0, 0.25, 1, 1.9, 2147483647.9]) {
            const actual = msvcr71FloorInlineReference(value);
            expect(actual).not.toBeNull();
            expect(Object.is(actual, Math.floor(value))).toBe(true);
        }
        for (const value of [NaN, Infinity, -Infinity, -2147483648, 2147483648, 1e100]) {
            expect(msvcr71FloorInlineReference(value)).toBeNull();
        }
    });
});
