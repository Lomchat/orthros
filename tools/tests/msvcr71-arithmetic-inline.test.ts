import { describe, expect, test } from 'bun:test';
import {
    assembleMsvcr71AddCarryInline,
    assembleMsvcr71Add96Inline,
    assembleMsvcr71Shift96Inline,
    buildMsvcr71AddCarryInline,
    buildMsvcr71Add96Inline,
    buildMsvcr71Shift96Inline,
    msvcr71AddCarry,
    msvcr71Add96,
    msvcr71Shift96,
} from '../../src/worker/core/hle-lib/libs/msvcr71/arithmetic-inline';
import { msvcr71Descriptor } from '../../src/worker/core/hle-lib/libs/msvcr71/descriptor';
import { msvcr71StricmpKernel } from '../../src/worker/core/hle-lib/libs/msvcr71/string-compare';
import { assembleMsvcr71SscanfScalarFilter } from '../../src/worker/core/hle-lib/libs/msvcr71/scanf-scalar';
import type { ShadowView } from '../../src/worker/core/hle-lib/types';

function stringView(memory: Uint8Array): ShadowView {
    return {
        readU8: (addr) => memory[addr] ?? 0,
        readU16: () => 0, readU32: () => 0, readF32: () => 0, readF64: () => 0,
        readBytes: (addr, len) => memory.slice(addr, addr + len),
        writeU8: () => {}, writeU16: () => {}, writeU32: () => {},
        writeF32: () => {}, writeF64: () => {}, writeBytes: () => {},
    };
}

describe('MSVCR71 guest-native arithmetic leaves', () => {
    test('matches unsigned 32-bit add-with-carry edge cases', () => {
        expect(msvcr71AddCarry(0, 0)).toEqual({ sum: 0, carry: 0 });
        expect(msvcr71AddCarry(0xffffffff, 1)).toEqual({ sum: 0, carry: 1 });
        expect(msvcr71AddCarry(0x80000000, 0x80000000)).toEqual({ sum: 0, carry: 1 });
        expect(msvcr71AddCarry(0xffffffff, 0xffffffff)).toEqual({ sum: 0xfffffffe, carry: 1 });
        expect(msvcr71AddCarry(0x12345678, 0x11111111)).toEqual({ sum: 0x23456789, carry: 0 });
    });

    test('matches a little-endian 96-bit shift for carry edge cases', () => {
        expect(msvcr71Shift96([0, 0, 0])).toEqual([0, 0, 0]);
        expect(msvcr71Shift96([0x80000000, 0, 0])).toEqual([0, 1, 0]);
        expect(msvcr71Shift96([0xffffffff, 0xffffffff, 0xffffffff]))
            .toEqual([0xfffffffe, 0xffffffff, 0xffffffff]);
        expect(msvcr71Shift96([0x12345678, 0x89abcdef, 0x40000000]))
            .toEqual([0x2468acf0, 0x13579bde, 0x80000001]);
    });

    test('matches 96-bit addition and final carry edge cases', () => {
        expect(msvcr71Add96([0, 0, 0], [0, 0, 0]))
            .toEqual({ limbs: [0, 0, 0], carry: 0 });
        expect(msvcr71Add96([0xffffffff, 0xffffffff, 0], [1, 0, 0]))
            .toEqual({ limbs: [0, 0, 1], carry: 0 });
        expect(msvcr71Add96([0xffffffff, 0xffffffff, 0xffffffff], [1, 0, 0]))
            .toEqual({ limbs: [0, 0, 0], carry: 1 });
        expect(msvcr71Add96([0x12345678, 0x89abcdef, 0xf0000000], [0x11111111, 0x87654321, 0x20000000]))
            .toEqual({ limbs: [0x23456789, 0x11111110, 0x10000001], carry: 1 });
    });

    test('emits complete cdecl leaves with no OUT or host transition', () => {
        const add = assembleMsvcr71AddCarryInline();
        expect(add[add.length - 1]).toBe(0xc3);
        expect(add.includes(0xee)).toBe(false);
        expect([...add]).toEqual([
            0x8b, 0x4c, 0x24, 0x04, 0x03, 0x4c, 0x24, 0x08,
            0x0f, 0x92, 0xc0, 0x0f, 0xb6, 0xc0, 0x8b, 0x54,
            0x24, 0x0c, 0x89, 0x0a, 0xc3,
        ]);
        const shift = assembleMsvcr71Shift96Inline();
        expect([...shift]).toEqual([
            0x8b, 0x44, 0x24, 0x04,
            0xd1, 0x20,
            0xd1, 0x50, 0x04,
            0xd1, 0x50, 0x08,
            0xc3,
        ]);
        expect(shift.includes(0xee)).toBe(false);
        const add96 = assembleMsvcr71Add96Inline();
        expect([...add96]).toEqual([
            0x8b, 0x54, 0x24, 0x04, 0x8b, 0x44, 0x24, 0x08,
            0x8b, 0x08, 0x01, 0x0a, 0x83, 0x52, 0x04, 0x00,
            0x83, 0x52, 0x08, 0x00, 0x8b, 0x48, 0x04, 0x01,
            0x4a, 0x04, 0x83, 0x52, 0x08, 0x00, 0x8b, 0x48,
            0x08, 0x01, 0x4a, 0x08, 0x0f, 0x92, 0xc0, 0x0f,
            0xb6, 0xc0, 0xc3,
        ]);
        expect(add96.includes(0xee)).toBe(false);
    });

    test('allocates and writes the exact generated wrapper', () => {
        const memory = new Uint8Array(0x2000);
        const address = buildMsvcr71AddCarryInline({
            mem: memory,
            targetAddress: 0x200,
            stubAddress: 0x400,
            trampolineAddress: 0x600,
            allocCode: () => 0x1000,
            markNonPreemptible: () => {},
        });
        const expected = assembleMsvcr71AddCarryInline();
        expect(address).toBe(0x1000);
        expect(memory.slice(0x1000, 0x1000 + expected.length)).toEqual(expected);

        const shiftAddress = buildMsvcr71Shift96Inline({
            mem: memory,
            targetAddress: 0x300,
            stubAddress: 0x500,
            trampolineAddress: 0x700,
            allocCode: () => 0x1100,
            markNonPreemptible: () => {},
        });
        const expectedShift = assembleMsvcr71Shift96Inline();
        expect(shiftAddress).toBe(0x1100);
        expect(memory.slice(0x1100, 0x1100 + expectedShift.length)).toEqual(expectedShift);

        const add96Address = buildMsvcr71Add96Inline({
            mem: memory,
            targetAddress: 0x350,
            stubAddress: 0x550,
            trampolineAddress: 0x750,
            allocCode: () => 0x1200,
            markNonPreemptible: () => {},
        });
        const expectedAdd96 = assembleMsvcr71Add96Inline();
        expect(add96Address).toBe(0x1200);
        expect(memory.slice(0x1200, 0x1200 + expectedAdd96.length)).toEqual(expectedAdd96);
    });

    test('requires both exact helper signatures before detection', () => {
        expect(msvcr71Descriptor.minConfidence).toBe(16);
        expect(Object.values(msvcr71Descriptor.signatures).map(sig => sig.weight)).toEqual([8, 8, 8, 8, 8]);
        expect(Object.keys(msvcr71Descriptor.functions)).toEqual(['add_carry', 'add96', 'shift96', 'stricmp', 'sscanf_scalar']);
        expect(msvcr71Descriptor.functions.add_carry.required).toBe(true);
        expect(msvcr71Descriptor.functions.add96.required).toBe(true);
        expect(msvcr71Descriptor.functions.shift96.required).toBe(true);
        expect(msvcr71Descriptor.functions.stricmp.required).toBe(true);
        expect(msvcr71Descriptor.functions.sscanf_scalar.required).toBe(true);
        expect(msvcr71Descriptor.functions.sscanf_scalar.argCount).toBe(3);
    });

    test('emits a bounded scalar sscanf classifier with both exact exits', () => {
        const base = 0x1000;
        const stub = 0x2200;
        const trampoline = 0x3300;
        const code = assembleMsvcr71SscanfScalarFilter(base, stub, trampoline);
        expect(code.length).toBeLessThanOrEqual(64);
        expect(code.includes(0xee)).toBe(false);
        expect([...code.slice(0, 4)]).toEqual([0x8b, 0x44, 0x24, 0x04]);
        expect(code.filter(byte => byte === 0xe9)).toHaveLength(2);
        expect(Buffer.from(code).toString('hex')).toBe(
            '8b44240485c0742e8b54240885d274260fb70a81f9256400007410' +
            '81f925750000740881f925660000750b807a02007505e9ca110000e9c5220000',
        );
    });
});

describe('MSVCR71 ASCII case-insensitive comparison', () => {
    test('matches equality, folding, prefixes, ordering and high bytes', () => {
        const memory = new Uint8Array(0x100);
        const put = (addr: number, bytes: number[]) => memory.set([...bytes, 0], addr);
        put(0x10, [...Buffer.from('MapCache')]);
        put(0x30, [...Buffer.from('mapcache')]);
        put(0x50, [...Buffer.from('map')]);
        put(0x70, [0xc0]);
        put(0x80, [0xe0]);
        const view = stringView(memory);
        expect(msvcr71StricmpKernel(view, [0x10, 0x30])).toBe(0);
        expect(msvcr71StricmpKernel(view, [0x50, 0x10])).toBe(-1);
        expect(msvcr71StricmpKernel(view, [0x10, 0x50])).toBe(1);
        expect(msvcr71StricmpKernel(view, [0x70, 0x80])).toBe(-1);
    });
});
