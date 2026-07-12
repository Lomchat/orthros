/**
 * EAGL shader-constant converter kernel — correctness against the RE-verified
 * guest semantics (speed.dll FUN_005cbd17, disassembled 2026-07-10).
 *
 * This is the offline validation gate for the direct-kernel production path
 * (the in-game trampoline round-trip is deferred; see ShadowSpec.validateInGame).
 * A reference implementation transcribed straight from the guest loops runs
 * against the kernel over the real observed shape (mode 3, 4×4, count 1) plus
 * modes 1/2 and non-square dims.
 */

import { describe, expect, test } from 'bun:test';
import { convertKernel, ftolExact } from '../../src/worker/core/hle-lib/libs/eagl/kernel';
import { LiveShadowView } from '../../src/worker/core/hle-lib/shadow-validator';

const MEM = 0x40000;
const DESC = 0x1000;
const SRC = 0x2000;
const DST = 0x8000;

function mkView(mode: number, rows: number, cols: number): { mem: Uint8Array; view: LiveShadowView; dv: DataView } {
    const mem = new Uint8Array(MEM);
    const dv = new DataView(mem.buffer);
    dv.setUint32(DESC + 0x00, mode, true);
    dv.setUint32(DESC + 0x14, rows, true);
    dv.setUint32(DESC + 0x18, cols, true);
    return { mem, view: new LiveShadowView(mem), dv };
}

/** Reference transcribed 1:1 from the disassembly (independent of the kernel). */
function referenceConvert(dv: DataView, mode: number, rows: number, cols: number, count: number): number {
    if (mode < 1 || mode > 3) return 0x8876086C;
    const r = Math.min(rows, 4), c = Math.min(cols, 4);
    for (let i = 0; i < count; i++) {
        for (let rr = 0; rr < r; rr++) {
            for (let cc = 0; cc < c; cc++) {
                const s = SRC + i * 0x40 + rr * 0x10 + cc * 4;
                const d = DST + i * rows * cols * 4 + rr * cols * 4 + cc * 4;
                if (mode === 3) {
                    dv.setUint32(d, dv.getUint32(s, true), true);
                } else if (mode === 2) {
                    dv.setUint32(d, ftolExact(dv.getFloat32(s, true)) >>> 0, true);
                } else {
                    dv.setUint32(d, ftolExact(dv.getFloat32(s, true)) !== 0 ? 1 : 0, true);
                }
            }
        }
    }
    return 0;
}

function fillSrc(dv: DataView, values: number[], asFloat: boolean): void {
    for (let i = 0; i < values.length; i++) {
        const a = SRC + Math.floor(i / 4) * 0x10 + (i % 4) * 4;
        if (asFloat) dv.setFloat32(a, values[i], true);
        else dv.setUint32(a, values[i] >>> 0, true);
    }
}

describe('ftolExact', () => {
    test('truncates toward zero', () => {
        expect(ftolExact(3.9)).toBe(3);
        expect(ftolExact(-3.9)).toBe(-3);
        expect(ftolExact(0)).toBe(0);
    });
    test('NaN / overflow → 0 (FPU integer-indefinite low32)', () => {
        expect(ftolExact(NaN)).toBe(0);
        expect(ftolExact(1e30)).toBe(0);
        expect(ftolExact(-1e30)).toBe(0);
    });
    test('large-but-in-range wraps to low 32 bits', () => {
        expect(ftolExact(3000000000) >>> 0).toBe(3000000000);
    });
});

describe('convertKernel vs reference', () => {
    const cases: Array<{ mode: number; rows: number; cols: number; count: number }> = [
        { mode: 3, rows: 4, cols: 4, count: 1 },   // the observed in-game shape
        { mode: 2, rows: 4, cols: 4, count: 3 },
        { mode: 1, rows: 4, cols: 4, count: 2 },
        { mode: 2, rows: 2, cols: 3, count: 4 },   // non-square, packed dst stride
        { mode: 1, rows: 3, cols: 1, count: 1 },
        { mode: 3, rows: 1, cols: 4, count: 5 },
    ];
    for (const { mode, rows, cols, count } of cases) {
        test(`mode ${mode} ${rows}x${cols} ×${count}`, () => {
            const k = mkView(mode, rows, cols);
            const ref = mkView(mode, rows, cols);
            // Deterministic mixed float payload: positives, negatives, zero, sub-1.
            const floats: number[] = [];
            for (let i = 0; i < count * 16; i++) floats.push((((i * 37) % 400) - 200) / 8);
            fillSrc(k.dv, mode === 3 ? floats.map((_, i) => 0xA0000000 + i) : floats, mode !== 3);
            fillSrc(ref.dv, mode === 3 ? floats.map((_, i) => 0xA0000000 + i) : floats, mode !== 3);

            const eax = convertKernel(k.view, [DESC, DST, SRC, count]);
            const refEax = referenceConvert(ref.dv, mode, rows, cols, count);

            expect(eax >>> 0).toBe(refEax >>> 0);
            expect(k.mem).toEqual(ref.mem); // whole memory image identical
        });
    }

    test('unknown mode → D3DERR_INVALIDCALL, no writes', () => {
        const k = mkView(7, 4, 4);
        const before = k.mem.slice(DST, DST + 256);
        const eax = convertKernel(k.view, [DESC, DST, SRC, 4]);
        expect(eax >>> 0).toBe(0x8876086C);
        expect(k.mem.slice(DST, DST + 256)).toEqual(before);
    });

    test('mode 1 collapses truncated value to 0/1', () => {
        const k = mkView(1, 1, 4);
        fillSrc(k.dv, [0.4, -0.9, 5.0, 0.0], true); // ftol → 0,0,5,0 → bool 0,0,1,0
        convertKernel(k.view, [DESC, DST, SRC, 1]);
        expect(k.dv.getUint32(DST + 0, true)).toBe(0);
        expect(k.dv.getUint32(DST + 4, true)).toBe(0);
        expect(k.dv.getUint32(DST + 8, true)).toBe(1);
        expect(k.dv.getUint32(DST + 12, true)).toBe(0);
    });
});
