import { describe, expect, it } from 'bun:test';
import { patchLastErrorInlineStubs } from '../../src/worker/modules/kernel32/last-error-inline-stubs';

describe('kernel32 last-error inline stubs', () => {
    it('patches generated GetLastError and SetLastError slots exactly', () => {
        const codeBase = 0x21001000;
        const hpBase = 0x22002000;
        const code = new Uint8Array(48).fill(0xcc);

        const patched = patchLastErrorInlineStubs(
            code,
            codeBase,
            codeBase,
            codeBase + 16,
            hpBase,
        );

        expect(patched).toEqual({ getLastError: true, setLastError: true });
        expect(Array.from(code.subarray(0, 16))).toEqual([
            0xa1, 0x24, 0x20, 0x00, 0x22, 0xc3,
            0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90,
        ]);
        expect(Array.from(code.subarray(16, 32))).toEqual([
            0x8b, 0x44, 0x24, 0x04,
            0xa3, 0x24, 0x20, 0x00, 0x22,
            0x31, 0xc0,
            0xc2, 0x04, 0x00,
            0x90, 0x90,
        ]);
        expect(Array.from(code.subarray(32))).toEqual(new Array(16).fill(0xcc));
    });

    it('does not touch reused or unavailable stubs outside the current batch', () => {
        const code = new Uint8Array(16).fill(0xcc);
        expect(patchLastErrorInlineStubs(code, 0x2000, 0x1000, 0x3000, 0x4000))
            .toEqual({ getLastError: false, setLastError: false });
        expect(Array.from(code)).toEqual(new Array(16).fill(0xcc));
    });
});
