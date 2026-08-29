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
import {
    msvcr71MemcmpKernel,
    msvcr71StrlenKernel,
    msvcr71StrncpyKernel,
    msvcr71StrnicmpKernel,
    msvcr71StrcmpKernel,
    msvcr71StrstrKernel,
} from '../../src/worker/core/hle-lib/libs/msvcr71/string-memory';
import { assembleMsvcr71SscanfScalarFilter } from '../../src/worker/core/hle-lib/libs/msvcr71/scanf-scalar';
import {
    assembleMsvcr71GetPtdInline,
    buildMsvcr71GetPtdInline,
    MSVCR71_GETPTD_TLS_INDEX_DELTA,
} from '../../src/worker/core/hle-lib/libs/msvcr71/getptd-inline';
import {
    assembleMsvcr71LocaleStricmpFilter,
    MSVCR71_STRICMP_TLS_INDEX_DELTA,
} from '../../src/worker/core/hle-lib/libs/msvcr71/locale-compare-inline';
import { msvcr71VsnprintfKernel, msvcr71VsnprintfShadow } from '../../src/worker/core/hle-lib/libs/msvcr71/vsnprintf';
import type { ShadowView } from '../../src/worker/core/hle-lib/types';

function stringView(memory: Uint8Array): ShadowView {
    const data = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    return {
        readU8: (addr) => memory[addr] ?? 0,
        readU16: (addr) => data.getUint16(addr, true),
        readU32: (addr) => data.getUint32(addr, true),
        readF32: (addr) => data.getFloat32(addr, true),
        readF64: (addr) => data.getFloat64(addr, true),
        readBytes: (addr, len) => memory.slice(addr, addr + len),
        writeU8: (addr, value) => { memory[addr] = value; },
        writeU16: (addr, value) => data.setUint16(addr, value, true),
        writeU32: (addr, value) => data.setUint32(addr, value, true),
        writeF32: (addr, value) => data.setFloat32(addr, value, true),
        writeF64: (addr, value) => data.setFloat64(addr, value, true),
        writeBytes: (addr, bytes) => memory.set(bytes, addr),
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
        expect(Object.values(msvcr71Descriptor.signatures).every(sig => sig.weight === 8)).toBe(true);
        const getptdSignature = msvcr71Descriptor.signatures.getptd;
        expect(getptdSignature.kind).toBe('bytes');
        if (getptdSignature.kind === 'bytes') {
            expect(getptdSignature.mask).toHaveLength(getptdSignature.pattern.length);
        }
        for (const signature of Object.values(msvcr71Descriptor.signatures)) {
            if (signature.kind === 'bytes') {
                expect(signature.mask).toHaveLength(signature.pattern.length);
            }
        }
        expect(Object.keys(msvcr71Descriptor.functions)).toEqual([
            'add_carry', 'add96', 'shift96', 'stricmp', 'sscanf_scalar',
            'vsnprintf', 'memcmp', 'strlen', 'strncpy', 'strnicmp_ascii',
            'strcmp', 'strstr', 'getptd', 'stricmp_locale', 'ceil_x87',
            'floor_x87',
        ]);
        expect(msvcr71Descriptor.functions.add_carry.required).toBe(true);
        expect(msvcr71Descriptor.functions.add96.required).toBe(true);
        expect(msvcr71Descriptor.functions.shift96.required).toBe(true);
        expect(msvcr71Descriptor.functions.stricmp.required).toBe(true);
        expect(msvcr71Descriptor.functions.sscanf_scalar.required).toBe(true);
        expect(msvcr71Descriptor.functions.sscanf_scalar.argCount).toBe(3);
        expect(msvcr71Descriptor.functions.vsnprintf.required).toBe(false);
        expect(msvcr71Descriptor.functions.vsnprintf.argCount).toBe(4);
        expect(msvcr71Descriptor.functions.ceil_x87.required).toBe(false);
        expect(msvcr71Descriptor.functions.floor_x87.required).toBe(false);
    });

    test('guards the locale-aware stricmp wrapper and preserves its original route', () => {
        const base = 0x1000;
        const target = 0x130105dc;
        const stub = 0x2200;
        const trampoline = 0x3300;
        const code = assembleMsvcr71LocaleStricmpFilter(base, target, stub, trampoline);
        const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
        expect([...code.slice(0, 8)]).toEqual([0x64, 0xa1, 0x2c, 0, 0, 0, 0x85, 0xc0]);
        expect(dv.getUint32(16, true)).toBe((target + MSVCR71_STRICMP_TLS_INDEX_DELTA) >>> 0);
        expect(code.includes(0xee)).toBe(false);
        const firstJmp = code.length - 10;
        const originalJmp = code.length - 5;
        expect(base + firstJmp + 5 + dv.getInt32(firstJmp + 1, true)).toBe(stub);
        expect(base + code.length + dv.getInt32(originalJmp + 1, true)).toBe(trampoline);
    });

    test('emits a direct TEB TLS lookup with exact original fallbacks', () => {
        const base = 0x1000;
        const target = 0x13009636;
        const trampoline = 0x3000;
        const code = assembleMsvcr71GetPtdInline(base, target, trampoline);
        expect(code.includes(0xee)).toBe(false);
        expect([...code.slice(0, 8)]).toEqual([0x64, 0xa1, 0x2c, 0, 0, 0, 0x85, 0xc0]);

        const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
        expect(dv.getUint32(16, true)).toBe((target + MSVCR71_GETPTD_TLS_INDEX_DELTA) >>> 0);
        const originalOffset = 41;
        for (const patch of [10, 25, 36]) {
            expect(base + patch + 4 + dv.getInt32(patch, true)).toBe(base + originalOffset);
        }
        expect(base + 46 + dv.getInt32(42, true)).toBe(trampoline);
        expect(Buffer.from(code).includes(Buffer.from([0x89, 0x14, 0x88]))).toBe(true);
        expect(code[code.length - 1]).toBe(0xc3);

        const memory = new Uint8Array(0x4000);
        const address = buildMsvcr71GetPtdInline({
            mem: memory,
            targetAddress: target,
            stubAddress: 0x2000,
            trampolineAddress: trampoline,
            allocCode: () => base,
            markNonPreemptible: () => {},
        });
        expect(address).toBe(base);
        expect(memory.slice(base, base + code.length)).toEqual(code);
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

describe('MSVCR71 hot memory/string leaves', () => {
    test('preserves normalized memcmp ordering and bounded strlen', () => {
        const memory = new Uint8Array(0x100);
        memory.set([1, 2, 3, 4], 0x10);
        memory.set([1, 2, 9, 4], 0x20);
        memory.set(Buffer.from('Roi-Sorcier\0'), 0x40);
        const view = stringView(memory);

        expect(msvcr71MemcmpKernel(view, [0x10, 0x20, 2])).toBe(0);
        expect(msvcr71MemcmpKernel(view, [0x10, 0x20, 4])).toBe(-1);
        expect(msvcr71MemcmpKernel(view, [0x20, 0x10, 4])).toBe(1);
        expect(msvcr71StrlenKernel(view, [0x40])).toBe(11);

        memory.set(Buffer.from('AbCd\0'), 0x60);
        memory.set(Buffer.from('aBcE\0'), 0x70);
        expect(msvcr71StrnicmpKernel(view, [0x60, 0x70, 3])).toBe(0);
        expect(msvcr71StrnicmpKernel(view, [0x60, 0x70, 5])).toBe(-1);

        memory.fill(0xaa, 0x80, 0x88);
        memory.set(Buffer.from('xy\0'), 0x90);
        expect(msvcr71StrncpyKernel(view, [0x80, 0x90, 8])).toBe(0x80);
        expect([...memory.subarray(0x80, 0x88)]).toEqual([0x78, 0x79, 0, 0, 0, 0, 0, 0]);

        memory.set(Buffer.from('Upgrade_AngmarFaction\0'), 0xa0);
        memory.set(Buffer.from('Upgrade_AngmarFactions\0'), 0xc0);
        memory.set(Buffer.from('Angmar\0'), 0xe0);
        memory.set(Buffer.from('missing\0'), 0xf0);
        expect(msvcr71StrcmpKernel(view, [0xa0, 0xa0])).toBe(0);
        expect(msvcr71StrcmpKernel(view, [0xa0, 0xc0])).toBe(-1);
        expect(msvcr71StrcmpKernel(view, [0xc0, 0xa0])).toBe(1);
        expect(msvcr71StrstrKernel(view, [0xa0, 0xe0])).toBe(0xa8);
        expect(msvcr71StrstrKernel(view, [0xa0, 0xf0])).toBe(0);
    });
});

describe('MSVCR71 bounded _vsnprintf', () => {
    test('formats guest va_list values and preserves VC71 truncation semantics', () => {
        const memory = new Uint8Array(0x400);
        const dv = new DataView(memory.buffer);
        memory.set(Buffer.from('value=%d/%s\0'), 0x20);
        memory.set(Buffer.from('map\0'), 0x60);
        dv.setUint32(0x80, 42, true);
        dv.setUint32(0x84, 0x60, true);
        const view: ShadowView = {
            readU8: (addr) => memory[addr] ?? 0,
            readU16: (addr) => dv.getUint16(addr, true),
            readU32: (addr) => dv.getUint32(addr, true),
            readF32: (addr) => dv.getFloat32(addr, true),
            readF64: (addr) => dv.getFloat64(addr, true),
            readBytes: (addr, len) => memory.slice(addr, addr + len),
            writeU8: (addr, value) => { memory[addr] = value; },
            writeU16: (addr, value) => dv.setUint16(addr, value, true),
            writeU32: (addr, value) => dv.setUint32(addr, value, true),
            writeF32: (addr, value) => dv.setFloat32(addr, value, true),
            writeF64: (addr, value) => dv.setFloat64(addr, value, true),
            writeBytes: (addr, bytes) => memory.set(bytes, addr),
        };

        expect(msvcr71VsnprintfKernel(view, [0x100, 32, 0x20, 0x80])).toBe(12);
        expect(Buffer.from(memory.subarray(0x100, 0x10d)).toString()).toBe('value=42/map\0');
        expect(msvcr71VsnprintfKernel(view, [0x140, 5, 0x20, 0x80])).toBe(-1);
        expect(Buffer.from(memory.subarray(0x140, 0x145)).toString()).toBe('value');
        expect(msvcr71VsnprintfShadow.guard?.([0x180, 32, 0x20, 0x80], view)).toBe(true);
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
