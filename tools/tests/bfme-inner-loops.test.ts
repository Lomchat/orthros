import { describe, expect, test } from 'bun:test';
import { bfmeFold33HashKernel } from '../../src/worker/core/hle-lib/libs/bfme/hash';
import { lowerUniqueStringbase } from '../../src/worker/core/hle-lib/libs/bfme/string-lower';
import { assembleBfmeStringLowerFilter } from '../../src/worker/core/hle-lib/libs/bfme/string-lower-filter';
import {
    assignSharedStringbase,
    copyStringbaseRef,
    releaseSharedStringbase,
} from '../../src/worker/core/hle-lib/libs/bfme/string-ref';
import { assembleBfmeStringRefFilter } from '../../src/worker/core/hle-lib/libs/bfme/string-ref-filter';
import { validatePrologueBytes } from '../../src/worker/core/hle-lib/lib-patcher';
import type { ShadowView } from '../../src/worker/core/hle-lib/types';

function viewFor(bytes: Uint8Array): ShadowView {
    return {
        readU8: (addr) => bytes[addr] ?? 0,
        readU16: () => 0,
        readU32: () => 0,
        readF32: () => 0,
        readF64: () => 0,
        readBytes: (addr, len) => bytes.slice(addr, addr + len),
        writeU8: () => {},
        writeU16: () => {},
        writeU32: () => {},
        writeF32: () => {},
        writeF64: () => {},
        writeBytes: () => {},
    };
}

function reference(input: number[]): number {
    let hash = 0;
    for (const byte of input) {
        if (byte === 0) break;
        let folded = byte >= 0x80 ? byte - 0x100 : byte;
        if (folded >= 0x41 && folded <= 0x5a) folded += 0x20;
        hash = (Math.imul(hash, 33) + folded) | 0;
    }
    return hash >>> 0;
}

describe('BFME fold33 inner-loop HLE', () => {
    test('is ASCII case-insensitive and wraps exactly at u32', () => {
        const upper = new TextEncoder().encode('Data\\INI\\Object.ini\0');
        const lower = new TextEncoder().encode('data\\ini\\object.ini\0');
        expect(bfmeFold33HashKernel(viewFor(upper), [0])).toBe(reference([...upper]));
        expect(bfmeFold33HashKernel(viewFor(lower), [0])).toBe(reference([...lower]));
        expect(bfmeFold33HashKernel(viewFor(upper), [0])).toBe(bfmeFold33HashKernel(viewFor(lower), [0]));
    });

    test('preserves the original MOVSX behavior for bytes >= 0x80', () => {
        const bytes = new Uint8Array([0xc9, 0x41, 0xff, 0]);
        expect(bfmeFold33HashKernel(viewFor(bytes), [0])).toBe(reference([...bytes]));
    });

    test('reads from the supplied guest pointer', () => {
        const bytes = new Uint8Array([9, 9, 0x41, 0x62, 0]);
        expect(bfmeFold33HashKernel(viewFor(bytes), [2])).toBe(reference([0x41, 0x62, 0]));
    });
});

describe('BFME stringbase lowercase inner-loop HLE', () => {
    test('lowers ASCII in place and preserves high bytes', () => {
        const memory = new Uint8Array(256);
        const dv = new DataView(memory.buffer);
        dv.setUint32(16, 64, true);       // object -> storage
        dv.setUint32(64, 1, true);        // unique
        dv.setUint16(68, 5, true);        // length
        dv.setUint16(70, 12, true);       // capacity
        memory.set([0x41, 0x62, 0x5a, 0xc9, 0x21], 72);
        expect(lowerUniqueStringbase(memory, 16)).toBe(0x21);
        expect([...memory.slice(72, 78)]).toEqual([0x61, 0x62, 0x7a, 0xc9, 0x21, 0]);
    });

    test('declines shared or full buffers without modifying them', () => {
        const memory = new Uint8Array(128);
        const dv = new DataView(memory.buffer);
        dv.setUint32(8, 32, true);
        dv.setUint32(32, 2, true);
        dv.setUint16(36, 1, true);
        dv.setUint16(38, 2, true);
        memory[40] = 0x41;
        expect(lowerUniqueStringbase(memory, 8)).toBeNull();
        expect(memory[40]).toBe(0x41);
        dv.setUint32(32, 1, true);
        dv.setUint16(38, 1, true);
        expect(lowerUniqueStringbase(memory, 8)).toBeNull();
        expect(memory[40]).toBe(0x41);
    });

    test('filter routes four guard failures to the trampoline and success to the stub', () => {
        const base = 0x1000, stub = 0x2300, trampoline = 0x3400;
        const code = assembleBfmeStringLowerFilter(base, stub, trampoline);
        const destinations: number[] = [];
        for (let i = 0; i < code.length;) {
            if (code[i] === 0x0f && (code[i + 1] & 0xf0) === 0x80) {
                const rel = new DataView(code.buffer, code.byteOffset + i + 2, 4).getInt32(0, true);
                destinations.push((base + i + 6 + rel) >>> 0);
                i += 6;
            } else if (code[i] === 0xe9) {
                const rel = new DataView(code.buffer, code.byteOffset + i + 1, 4).getInt32(0, true);
                destinations.push((base + i + 5 + rel) >>> 0);
                i += 5;
            } else {
                i++;
            }
        }
        expect(destinations.filter(x => x === trampoline).length).toBe(1);
        expect(destinations.filter(x => x === stub).length).toBe(1);
        // The four Jccs share an internal .orig label, followed by its JMP.
        expect(destinations.length).toBe(6);
        expect(validatePrologueBytes(Uint8Array.from([0x51, 0x53, 0x8b, 0xd9, 0x8b, 0x03]))).toBeNull();
    });
});

describe('BFME stringbase reference fast paths', () => {
    test('releases null/shared stores and declines the unique free case', () => {
        const memory = new Uint8Array(128);
        const dv = new DataView(memory.buffer);
        dv.setUint32(8, 0, true);
        expect(releaseSharedStringbase(memory, 8)).toBe(0);
        dv.setUint32(8, 32, true);
        dv.setUint32(32, 3, true);
        expect(releaseSharedStringbase(memory, 8)).toBe(0);
        expect(dv.getUint32(8, true)).toBe(0);
        expect(dv.getUint32(32, true)).toBe(2);
        dv.setUint32(8, 32, true);
        dv.setUint32(32, 1, true);
        expect(releaseSharedStringbase(memory, 8)).toBeNull();
        expect(dv.getUint32(8, true)).toBe(32);
    });

    test('copies and assigns refcounts without losing aliases', () => {
        const memory = new Uint8Array(160);
        const dv = new DataView(memory.buffer);
        dv.setUint32(16, 80, true);  // source -> new storage
        dv.setUint32(80, 2, true);
        expect(copyStringbaseRef(memory, 24, 16)).toBe(24);
        expect(dv.getUint32(24, true)).toBe(80);
        expect(dv.getUint32(80, true)).toBe(3);

        dv.setUint32(32, 96, true);  // destination -> old shared storage
        dv.setUint32(96, 4, true);
        expect(assignSharedStringbase(memory, 32, 16)).toBe(32);
        expect(dv.getUint32(32, true)).toBe(80);
        expect(dv.getUint32(96, true)).toBe(3);
        expect(dv.getUint32(80, true)).toBe(4);

        // Two objects already aliasing the same storage are a semantic no-op.
        dv.setUint32(40, 80, true);
        expect(assignSharedStringbase(memory, 40, 16)).toBe(40);
        expect(dv.getUint32(80, true)).toBe(4);
        dv.setUint32(32, 96, true);
        dv.setUint32(96, 1, true);
        expect(assignSharedStringbase(memory, 32, 16)).toBeNull();
    });

    test('all filters retain both a native fast path and exact original decline path', () => {
        for (const kind of ['release', 'copy', 'assign'] as const) {
            const base = 0x1000, stub = 0x2400, trampoline = 0x3500;
            const code = assembleBfmeStringRefFilter(kind, base, stub, trampoline);
            const destinations: number[] = [];
            for (let i = 0; i < code.length;) {
                if (code[i] === 0x0f && (code[i + 1] & 0xf0) === 0x80) {
                    const rel = new DataView(code.buffer, code.byteOffset + i + 2, 4).getInt32(0, true);
                    destinations.push((base + i + 6 + rel) >>> 0);
                    i += 6;
                } else if (code[i] === 0xe9) {
                    const rel = new DataView(code.buffer, code.byteOffset + i + 1, 4).getInt32(0, true);
                    destinations.push((base + i + 5 + rel) >>> 0);
                    i += 5;
                } else i++;
            }
            expect(destinations).toContain(stub);
            expect(destinations).toContain(trampoline);
        }
        expect(validatePrologueBytes(Uint8Array.from([0x56, 0x8b, 0xf1, 0x8a, 0x0d, 0x2c, 0x6e, 0x33, 0x01]))).toBeNull();
    });
});
