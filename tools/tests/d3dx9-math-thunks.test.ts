import { beforeEach, describe, expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { createMathExports } from '../../src/worker/modules/d3dx9/math';

const floatBits = (f: number): number => {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, f, true);
    return dv.getUint32(0, true);
};

function matrixAt(mem: Uint8Array, addr: number): number[] {
    return Array.from(new Float32Array(mem.buffer, mem.byteOffset + addr, 16));
}

describe('D3DX matrix thunks over guest memory', () => {
    const exports = createMathExports();
    const ctx = {} as never;
    beforeEach(() => Mem.clearWatchRanges());

    test('D3DXMatrixRotationZ writes the rotation in one validated range', () => {
        const mem = new Uint8Array(0x2000);
        Mem.bind(() => mem);
        const out = 0x1000;
        expect(exports['D3DXMatrixRotationZ']!(ctx, mem, [out, floatBits(Math.PI / 2)])).toBe(out);
        const m = matrixAt(mem, out);
        expect(Math.abs(m[0]!)).toBeLessThan(1e-6);
        expect(m[1]).toBeCloseTo(1, 6);
        expect(m[4]).toBeCloseTo(-1, 6);
        expect(m[10]).toBe(1);
        expect(m[15]).toBe(1);
    });

    test('D3DXMatrixMultiply reads both operands and writes the product', () => {
        const mem = new Uint8Array(0x2000);
        Mem.bind(() => mem);
        const a = 0x100, b = 0x200, out = 0x300;
        const av = new Float32Array(mem.buffer, a, 16);
        const bv = new Float32Array(mem.buffer, b, 16);
        av.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);   // translation (5,6,7)
        bv.set([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);   // scale 2
        expect(exports['D3DXMatrixMultiply']!(ctx, mem, [out, a, b])).toBe(out);
        const m = matrixAt(mem, out);
        expect(m[0]).toBe(2);
        expect(m[12]).toBe(10);
        expect(m[13]).toBe(12);
        expect(m[14]).toBe(14);
        expect(m[15]).toBe(1);
    });

    test('an output range the address space rejects fails without writing', () => {
        const mem = new Uint8Array(0x2000);
        Mem.bind(() => mem, (address, size) => address + size <= 0x800);
        expect(exports['D3DXMatrixRotationZ']!(ctx, mem, [0x900, floatBits(1)])).toBe(0);
        expect(matrixAt(mem, 0x900).every((v) => v === 0)).toBe(true);
        expect(exports['D3DXMatrixRotationZ']!(ctx, mem, [0x700, floatBits(1)])).toBe(0x700);
    });
});
