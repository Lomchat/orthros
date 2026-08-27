import { describe, expect, test } from 'bun:test';
import { bfmeFold33HashKernel } from '../../src/worker/core/hle-lib/libs/bfme/hash';
import { lowerUniqueStringbase } from '../../src/worker/core/hle-lib/libs/bfme/string-lower';
import { assembleBfmeStringLowerFilter } from '../../src/worker/core/hle-lib/libs/bfme/string-lower-filter';
import {
    assignSharedStringbase,
    copyStringbaseRef,
    releaseSharedStringbase,
} from '../../src/worker/core/hle-lib/libs/bfme/string-ref';
import {
    assembleBfmeStringRefFilter,
    buildBfmeStringReleaseFilter,
} from '../../src/worker/core/hle-lib/libs/bfme/string-ref-filter';
import { findBfmeStringNode } from '../../src/worker/core/hle-lib/libs/bfme/string-find';
import { ftol2SseHalves } from '../../src/worker/core/hle-lib/libs/bfme/ftol2';
import {
    popBfmeMatrix,
    popBfmeTransform,
    pushBfmeMatrix,
    pushBfmeTransform,
} from '../../src/worker/core/hle-lib/libs/bfme/matrix-stack';
import { adjustBfmeMatrix, multiplyBfmeAffine } from '../../src/worker/core/hle-lib/libs/bfme/matrix-multiply';
import {
    assembleMatrixAdjustWrapper,
    assembleTransformPopWrapper,
} from '../../src/worker/core/hle-lib/libs/bfme/matrix-callback-wrappers';
import {
    assembleBfmeSmallPoolInline,
    buildBfmeSmallPoolAllocInline,
    popBfmeSmallPool,
    pushBfmeSmallPool,
} from '../../src/worker/core/hle-lib/libs/bfme/small-pool-inline';
import { assembleBfmeVertexBlendWrapper } from '../../src/worker/core/hle-lib/libs/bfme/vertex-blend';
import { bfmeJpegIdctIslow, bfmeJpegIdctShadow } from '../../src/worker/core/hle-lib/libs/bfme/jpeg-idct-islow';
import {
    assembleBfmeVectorCtorFilter,
    BFME_NOOP_VECTOR_CTORS,
} from '../../src/worker/core/hle-lib/libs/bfme/vector-ctor-filter';
import { blendBfmePixels, bfmePixelAlphaBlendShadow } from '../../src/worker/core/hle-lib/libs/bfme/pixel-alpha-blend';
import {
    assembleBfmeMemoryStreamRead1Filter,
    readBfmeMemoryStream1,
} from '../../src/worker/core/hle-lib/libs/bfme/memory-stream-read';
import { decodeBfmeBc1ColorBlock } from '../../src/worker/core/hle-lib/libs/bfme/bc1-color-block';
import { assembleBfmeDxtEncodeCacheWrapper } from '../../src/worker/core/hle-lib/libs/bfme/dxt-encode-cache';
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

    test('all filters complete accepted operations inline and retain the exact original decline path', () => {
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
            expect(destinations).not.toContain(stub);
            expect(destinations).toContain(trampoline);
        }
        expect(validatePrologueBytes(Uint8Array.from([0x56, 0x8b, 0xf1, 0x8a, 0x0d, 0x2c, 0x6e, 0x33, 0x01]))).toBeNull();
    });

    test('registers the generated refcount transaction as scheduler non-preemptible', () => {
        const memory = new Uint8Array(0x5000);
        const ranges: Array<[number, number]> = [];
        const address = buildBfmeStringReleaseFilter({
            mem: memory,
            targetAddress: 0x500,
            stubAddress: 0x2400,
            trampolineAddress: 0x3500,
            allocCode: () => 0x1000,
            markNonPreemptible: (base, end) => ranges.push([base, end]),
        });
        expect(address).toBe(0x1000);
        expect(ranges).toEqual([[0x1000, 0x1000 + assembleBfmeStringRefFilter('release', 0x1000, 0x2400, 0x3500).length]]);
    });
});

describe('BFME STLPort small-pool inline fast paths', () => {
    test('pops and pushes the exact eight-byte size class while restoring the lock', () => {
        const memory = new Uint8Array(512);
        const view = new DataView(memory.buffer);
        const pool = 64;
        const lock = 32;
        const size = 17; // (17-1)>>3 = class 2
        const headAddress = pool + 2 * 4;
        view.setUint32(headAddress, 160, true);
        view.setUint32(160, 224, true);
        view.setUint32(224, 0, true);

        expect(popBfmeSmallPool(memory, size, pool, lock)).toBe(160);
        expect(view.getUint32(headAddress, true)).toBe(224);
        expect(view.getUint32(lock, true)).toBe(0);
        expect(pushBfmeSmallPool(memory, 160, size, pool, lock)).toBe(true);
        expect(view.getUint32(160, true)).toBe(224);
        expect(view.getUint32(headAddress, true)).toBe(160);
        expect(view.getUint32(lock, true)).toBe(0);
    });

    test('declines busy/empty pools without modifying guest memory', () => {
        const memory = new Uint8Array(256);
        const view = new DataView(memory.buffer);
        const pool = 64;
        const lock = 32;
        const before = memory.slice();
        expect(popBfmeSmallPool(memory, 8, pool, lock)).toBeNull();
        expect(memory).toEqual(before);
        view.setUint32(lock, 1, true);
        const busy = memory.slice();
        expect(pushBfmeSmallPool(memory, 128, 8, pool, lock)).toBe(false);
        expect(memory).toEqual(busy);
    });

    test('emits direct RET fast paths and relocates every decline to the original', () => {
        const base = 0x1000;
        const trampoline = 0x5000;
        for (const op of ['alloc', 'free'] as const) {
            const code = assembleBfmeSmallPoolInline(op, base, trampoline);
            expect([...code].filter((byte) => byte === 0xc3).length).toBe(1);
            expect(code.includes(0xee)).toBe(false); // no OUT/host transition
            expect(code[code.length - 5]).toBe(0xe9);
            const rel = new DataView(code.buffer, code.byteOffset + code.length - 4, 4).getInt32(0, true);
            expect((base + code.length + rel) >>> 0).toBe(trampoline);
        }
    });

    test('registers the allocator RMW wrapper as scheduler non-preemptible', () => {
        const memory = new Uint8Array(0x6000);
        const ranges: Array<[number, number]> = [];
        const address = buildBfmeSmallPoolAllocInline({
            mem: memory,
            targetAddress: 0x500,
            stubAddress: 0x2400,
            trampolineAddress: 0x5000,
            allocCode: () => 0x1000,
            markNonPreemptible: (base, end) => ranges.push([base, end]),
        });
        expect(address).toBe(0x1000);
        expect(ranges).toEqual([[0x1000, 0x1000 + assembleBfmeSmallPoolInline('alloc', 0x1000, 0x5000).length]]);
    });
});

describe('BFME stringbase node lookup HLE', () => {
    const putString = (memory: Uint8Array, object: number, storage: number, text: string) => {
        const dv = new DataView(memory.buffer);
        dv.setUint32(object, storage, true);
        dv.setUint32(storage, 1, true);
        dv.setUint16(storage + 4, text.length, true);
        dv.setUint16(storage + 6, text.length + 1, true);
        memory.set(new TextEncoder().encode(text), storage + 8);
        memory[storage + 8 + text.length] = 0;
    };

    test('finds the first and later matching nodes and returns zero on a miss', () => {
        const memory = new Uint8Array(1024);
        const dv = new DataView(memory.buffer);
        const container = 16;
        const keyObject = 80;
        const firstNode = 160;
        const secondNode = 320;
        dv.setUint32(container + 0x2c, firstNode, true);
        dv.setUint32(firstNode + 0x60, secondNode, true);
        dv.setUint32(secondNode + 0x60, 0, true);
        putString(memory, keyObject, 560, 'Dunharrow');
        putString(memory, firstNode + 0x0c, 640, 'Fangorn');
        putString(memory, secondNode + 0x0c, 720, 'Dunharrow');
        expect(findBfmeStringNode(memory, container, keyObject)).toBe(secondNode);

        putString(memory, firstNode + 0x0c, 640, 'Dunharrow');
        expect(findBfmeStringNode(memory, container, keyObject)).toBe(firstNode);
        putString(memory, keyObject, 560, 'Moria');
        expect(findBfmeStringNode(memory, container, keyObject)).toBe(0);
    });

    test('matches empty strings and distinguishes equal prefixes by length', () => {
        const memory = new Uint8Array(512);
        const dv = new DataView(memory.buffer);
        const container = 8;
        const keyObject = 64;
        const node = 128;
        dv.setUint32(container + 0x2c, node, true);
        dv.setUint32(node + 0x60, 0, true);
        dv.setUint32(keyObject, 0, true);
        dv.setUint32(node + 0x0c, 0, true);
        expect(findBfmeStringNode(memory, container, keyObject)).toBe(node);

        putString(memory, keyObject, 256, 'Ent');
        putString(memory, node + 0x0c, 320, 'Ents');
        expect(findBfmeStringNode(memory, container, keyObject)).toBe(0);
    });

    test('declines malformed pointers instead of reading outside guest memory', () => {
        const memory = new Uint8Array(128);
        const dv = new DataView(memory.buffer);
        dv.setUint32(8 + 0x2c, 120, true);
        dv.setUint32(16, 64, true);
        dv.setUint16(68, 1, true);
        expect(findBfmeStringNode(memory, 8, 16)).toBeNull();
        expect(findBfmeStringNode(memory, 0, 16)).toBeNull();
    });
});

describe('BFME _ftol2_sse fallback semantics', () => {
    test('truncates toward zero and returns the full EDX:EAX pair', () => {
        expect(ftol2SseHalves(3.9)).toEqual({ low: 3, high: 0 });
        expect(ftol2SseHalves(-3.9)).toEqual({ low: 0xffff_fffd, high: -1 });
        expect(ftol2SseHalves(4_294_967_297)).toEqual({ low: 1, high: 1 });
    });

    test('uses the x87 indefinite integer for invalid and overflowing values', () => {
        const indefinite = { low: 0, high: -0x8000_0000 };
        expect(ftol2SseHalves(Number.NaN)).toEqual(indefinite);
        expect(ftol2SseHalves(Number.POSITIVE_INFINITY)).toEqual(indefinite);
        expect(ftol2SseHalves(9_223_372_036_854_775_808)).toEqual(indefinite);
    });
});

describe('BFME matrix stack inner-loop HLE', () => {
    test('round-trips nested 32-byte states and preserves the original return values', () => {
        const memory = new Uint8Array(2048);
        const object = 32;
        const depth = object + 0x3b8;
        const original = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
        memory.set(original, object);

        expect(pushBfmeMatrix(memory, object)).toBe(object);
        expect(new DataView(memory.buffer).getInt32(depth, true)).toBe(1);
        memory.fill(0xa5, object, object + 32);
        expect(pushBfmeMatrix(memory, object)).toBe(object);
        expect(new DataView(memory.buffer).getInt32(depth, true)).toBe(2);

        memory.fill(0, object, object + 32);
        expect(popBfmeMatrix(memory, object)).toBe(32);
        expect([...memory.slice(object, object + 32)]).toEqual(Array(32).fill(0xa5));
        expect(popBfmeMatrix(memory, object)).toBe(0);
        expect(memory.slice(object, object + 32)).toEqual(original);
    });

    test('declines invalid objects without modifying memory', () => {
        const memory = new Uint8Array(128);
        const before = memory.slice();
        expect(pushBfmeMatrix(memory, 0)).toBeNull();
        expect(popBfmeMatrix(memory, 64)).toBeNull();
        expect(memory).toEqual(before);
    });

    test('pushes nested 24-byte transform states and returns each destination', () => {
        const memory = new Uint8Array(2048);
        const view = new DataView(memory.buffer);
        const object = 32;
        const source = object + 0x20;
        const firstDestination = object + 0x238;
        const initial = Uint8Array.from({ length: 24 }, (_, i) => 0x40 + i);
        memory.set(initial, source);
        expect(pushBfmeTransform(memory, object)).toBe(firstDestination);
        expect(view.getInt32(object + 0x3bc, true)).toBe(1);
        expect(memory.slice(firstDestination, firstDestination + 24)).toEqual(initial);

        const next = Uint8Array.from({ length: 24 }, (_, i) => 0x80 + i);
        memory.set(next, source);
        expect(pushBfmeTransform(memory, object)).toBe(firstDestination + 24);
        expect(view.getInt32(object + 0x3bc, true)).toBe(2);
        expect(memory.slice(firstDestination + 24, firstDestination + 48)).toEqual(next);

        memory.fill(0, source, source + 24);
        expect(popBfmeTransform(memory, object)).toBe(source);
        expect(memory.slice(source, source + 24)).toEqual(next);
        expect(popBfmeTransform(memory, object)).toBe(source);
        expect(memory.slice(source, source + 24)).toEqual(initial);
    });
});

describe('BFME affine-matrix multiply inner-loop HLE', () => {
    const writeMatrix = (view: DataView, address: number, values: number[]) => {
        values.forEach((value, i) => view.setFloat32(address + i * 4, value, true));
    };
    const readMatrix = (view: DataView, address: number) =>
        Array.from({ length: 6 }, (_, i) => view.getFloat32(address + i * 4, true));

    test('composes the six coefficients and returns the output pointer', () => {
        const memory = new Uint8Array(256);
        const view = new DataView(memory.buffer);
        writeMatrix(view, 16, [2, 3, 5, 7, 11, 13]);
        writeMatrix(view, 64, [17, 19, 23, 29, 31, 37]);
        expect(multiplyBfmeAffine(memory, 16, 64, 128)).toBe(128);
        expect(readMatrix(view, 128)).toEqual([129, 184, 191, 272, 258, 365]);
    });

    test('snapshots both inputs so output may alias either one', () => {
        const initial = [1.25, -2.5, 3.75, 4.5, -5.25, 6.5];
        const right = [-0.5, 2, 1.5, -3, 4, -1.25];
        const expectedMemory = new Uint8Array(256);
        const expectedView = new DataView(expectedMemory.buffer);
        writeMatrix(expectedView, 16, initial);
        writeMatrix(expectedView, 64, right);
        multiplyBfmeAffine(expectedMemory, 16, 64, 128);
        const expected = readMatrix(expectedView, 128);

        const leftAliased = new Uint8Array(256);
        const leftView = new DataView(leftAliased.buffer);
        writeMatrix(leftView, 16, initial);
        writeMatrix(leftView, 64, right);
        expect(multiplyBfmeAffine(leftAliased, 16, 64, 16)).toBe(16);
        expect(readMatrix(leftView, 16)).toEqual(expected);

        const rightAliased = new Uint8Array(256);
        const rightView = new DataView(rightAliased.buffer);
        writeMatrix(rightView, 16, initial);
        writeMatrix(rightView, 64, right);
        expect(multiplyBfmeAffine(rightAliased, 16, 64, 64)).toBe(64);
        expect(readMatrix(rightView, 64)).toEqual(expected);
    });

    test('declines null or out-of-range matrices without writing', () => {
        const memory = new Uint8Array(64);
        const before = memory.slice();
        expect(multiplyBfmeAffine(memory, 0, 16, 32)).toBeNull();
        expect(multiplyBfmeAffine(memory, 16, 48, 32)).toBeNull();
        expect(memory).toEqual(before);
    });

    test('applies scale and translation fields with alias-safe binary32 stores', () => {
        const memory = new Uint8Array(192);
        const view = new DataView(memory.buffer);
        writeMatrix(view, 16, [2, 3, 4, 5, 6, 7]);
        view.setFloat32(16 + 24, 8, true);
        view.setFloat32(16 + 28, 9, true);
        writeMatrix(view, 80, [10, 11, 12, 13, 14, 15]);
        view.setFloat32(80 + 24, 16, true);
        view.setFloat32(80 + 28, 17, true);
        expect(adjustBfmeMatrix(memory, 16, 80)).toBe(16);
        expect(Array.from({ length: 8 }, (_, i) => view.getFloat32(16 + i * 4, true)))
            .toEqual([20, 33, 48, 65, 20, 22, 24, 26]);
    });

    test('callback wrappers call the stub and retain the exact guest callbacks/returns', () => {
        const base = 0x1000;
        const stub = 0x2400;
        const pop = assembleTransformPopWrapper(base, stub);
        const popRel = new DataView(pop.buffer).getInt32(1, true);
        expect((base + 5 + popRel) >>> 0).toBe(stub);
        expect([...pop.slice(-4)]).toEqual([0x83, 0xc4, 0x04, 0xc3]);
        expect([...pop]).toContain(0xa0); // IAT 0x013378a0

        const adjust = assembleMatrixAdjustWrapper(base, stub);
        const adjustRel = new DataView(adjust.buffer).getInt32(5, true);
        expect((base + 9 + adjustRel) >>> 0).toBe(stub);
        expect([...adjust.slice(-3)]).toEqual([0xc2, 0x04, 0x00]);
        expect([...adjust]).toContain(0xa4); // IAT 0x013378a4
        expect(validatePrologueBytes(Uint8Array.from([0x8b, 0x91, 0xbc, 0x03, 0x00, 0x00]))).toBeNull();
        expect(validatePrologueBytes(Uint8Array.from([0x8b, 0x44, 0x24, 0x04, 0xd9, 0x00]))).toBeNull();
        expect(validatePrologueBytes(Uint8Array.from([
            0x8b, 0x45, 0xf0,
            0xd9, 0x05, 0x6c, 0x3b, 0x08, 0x01,
        ]))).toBeNull();
    });
});

describe('BFME cold-load float4 blend loop HLE', () => {
    test('calls the WASM bulk stub, restores ESI and resumes after the x87 loop', () => {
        const base = 0x1800;
        const stub = 0x2400;
        const continuation = 0x3200;
        const code = assembleBfmeVertexBlendWrapper(base, stub, continuation);
        const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
        expect(code.length).toBe(13);
        expect(code[0]).toBe(0xe8);
        expect((base + 5 + view.getInt32(1, true)) >>> 0).toBe(stub);
        expect([...code.slice(5, 8)]).toEqual([0x8b, 0x75, 0xfc]);
        expect(code[8]).toBe(0xe9);
        expect((base + 13 + view.getInt32(9, true)) >>> 0).toBe(continuation);
    });
});

describe('BFME IJG jpeg_idct_islow HLE', () => {
    function makeFixture(): { memory: Uint8Array; view: ShadowView; args: number[] } {
        const memory = new Uint8Array(0x4000);
        const data = new DataView(memory.buffer);
        const cinfo = 0x100;
        const component = 0x300;
        const coefficients = 0x500;
        const quantization = 0x600;
        const outputRows = 0x800;
        const rangeBase = 0x2000;
        data.setUint32(cinfo + 0x148, rangeBase, true);
        data.setUint32(component + 0x50, quantization, true);
        for (let i = 0; i < 64; i++) data.setInt16(quantization + i * 2, 1, true);
        for (let i = 0; i < 1024; i++) memory[rangeBase + 0x80 + i] = i & 0xff;
        for (let row = 0; row < 8; row++) data.setUint32(outputRows + row * 4, 0x1000 + row * 16, true);
        const view: ShadowView = {
            readU8: (addr) => data.getUint8(addr),
            readU16: (addr) => data.getUint16(addr, true),
            readU32: (addr) => data.getUint32(addr, true),
            readF32: (addr) => data.getFloat32(addr, true),
            readF64: (addr) => data.getFloat64(addr, true),
            readBytes: (addr, len) => memory.slice(addr, addr + len),
            writeU8: (addr, value) => data.setUint8(addr, value),
            writeU16: (addr, value) => data.setUint16(addr, value, true),
            writeU32: (addr, value) => data.setUint32(addr, value, true),
            writeF32: (addr, value) => data.setFloat32(addr, value, true),
            writeF64: (addr, value) => data.setFloat64(addr, value, true),
            writeBytes: (addr, value) => memory.set(value, addr),
        };
        return { memory, view, args: [cinfo, component, coefficients, outputRows, 3] };
    }

    test('takes the exact DC-only shortcut and writes eight independent rows', () => {
        const { memory, view, args } = makeFixture();
        new DataView(memory.buffer).setInt16(args[2], 8, true);
        expect(bfmeJpegIdctIslow(view, args)).toBe(0);
        for (let row = 0; row < 8; row++) {
            expect([...memory.slice(0x1000 + row * 16 + 3, 0x1000 + row * 16 + 11)])
                .toEqual(new Array(8).fill(1));
        }
    });

    test('declares only the 64 output bytes for differential validation', () => {
        const { view, args } = makeFixture();
        expect(bfmeJpegIdctShadow.guard?.(args, view)).toBe(true);
        expect(bfmeJpegIdctShadow.ranges(args, view)).toEqual(
            Array.from({ length: 8 }, (_, row) => ({ addr: 0x1003 + row * 16, len: 8 })),
        );
    });
});

describe('BFME MSVC vector-constructor filter', () => {
    test('returns directly for every proven no-op target and declines otherwise', () => {
        const base = 0x1000;
        const trampoline = 0x3000;
        const code = assembleBfmeVectorCtorFilter(base, trampoline);
        expect(code.length).toBe(BFME_NOOP_VECTOR_CTORS.length * 10 + 8);
        for (let i = 0; i < BFME_NOOP_VECTOR_CTORS.length; i++) {
            const offset = i * 10;
            expect([...code.slice(offset, offset + 4)]).toEqual([0x81, 0x7c, 0x24, 0x10]);
            expect(new DataView(code.buffer, code.byteOffset).getUint32(offset + 4, true))
                .toBe(BFME_NOOP_VECTOR_CTORS[i]);
            const fast = offset + 10 + new DataView(code.buffer, code.byteOffset).getInt8(offset + 9);
            expect([...code.slice(fast, fast + 3)]).toEqual([0xc2, 0x10, 0x00]);
        }
        const decline = BFME_NOOP_VECTOR_CTORS.length * 10;
        expect(code[decline]).toBe(0xe9);
        expect((base + decline + 5 + new DataView(code.buffer, code.byteOffset).getInt32(decline + 1, true)) >>> 0)
            .toBe(trampoline);
        expect(validatePrologueBytes(Uint8Array.from([0x8b, 0x44, 0x24, 0x0c, 0x48]))).toBeNull();
    });
});

describe('BFME bulk pixel alpha blend HLE', () => {
    function makeView(memory: Uint8Array): ShadowView {
        const data = new DataView(memory.buffer);
        return {
            readU8: (addr) => data.getUint8(addr),
            readU16: (addr) => data.getUint16(addr, true),
            readU32: (addr) => data.getUint32(addr, true),
            readF32: (addr) => data.getFloat32(addr, true),
            readF64: (addr) => data.getFloat64(addr, true),
            readBytes: (addr, len) => memory.slice(addr, addr + len),
            writeU8: (addr, value) => data.setUint8(addr, value),
            writeU16: (addr, value) => data.setUint16(addr, value, true),
            writeU32: (addr, value) => data.setUint32(addr, value, true),
            writeF32: (addr, value) => data.setFloat32(addr, value, true),
            writeF64: (addr, value) => data.setFloat64(addr, value, true),
            writeBytes: (addr, value) => memory.set(value, addr),
        };
    }

    test('matches the three-channel integer blend and preserves destination alpha', () => {
        const memory = new Uint8Array(0x400);
        const data = new DataView(memory.buffer);
        data.setUint32(0x100, 0x80402010, true);
        data.setUint32(0x104, 0xffabcdef, true);
        data.setUint32(0x180, 0x7fc08040, true);
        data.setUint32(0x184, 0x12345678, true);
        data.setUint32(0x200, 0x00000000, true);
        data.setUint32(0x204, 0x000000ff, true);
        const view = makeView(memory);

        expect(blendBfmePixels(view, [0x100, 0x180, 0x200, 2])).toBe(0);
        expect(data.getUint32(0x180, true)).toBe(0x7fbf7f3f);
        expect(data.getUint32(0x184, true)).toBe(0x12aaccee);
        expect(bfmePixelAlphaBlendShadow.ranges([0x100, 0x180, 0x200, 2], view))
            .toEqual([{ addr: 0x180, len: 8 }]);
    });

    test('retains streaming semantics when source aliases destination', () => {
        const memory = new Uint8Array(0x400);
        const data = new DataView(memory.buffer);
        data.setUint32(0x100, 0x7f123456, true);
        data.setUint32(0x180, 0x00000080, true);
        blendBfmePixels(makeView(memory), [0x100, 0x100, 0x180, 1]);
        expect(data.getUint32(0x100, true)).toBe(0x7f113355);
    });
});

describe('BFME one-byte memory-stream read HLE', () => {
    test('copies one byte, advances the cursor, and preserves EOF/null behavior', () => {
        const memory = new Uint8Array(0x1000);
        const view = new DataView(memory.buffer);
        const object = 0x100;
        view.setUint32(object + 0x14, 0x400, true);
        view.setInt32(object + 0x18, 3, true);
        view.setInt32(object + 0x1c, 8, true);
        memory[0x403] = 0xa7;

        expect(readBfmeMemoryStream1(memory, [object, 0x600, 1])).toBe(1);
        expect(memory[0x600]).toBe(0xa7);
        expect(view.getInt32(object + 0x18, true)).toBe(4);

        view.setInt32(object + 0x18, 8, true);
        expect(readBfmeMemoryStream1(memory, [object, 0x601, 1])).toBe(0);
        expect(view.getInt32(object + 0x18, true)).toBe(8);

        view.setUint32(object + 0x14, 0, true);
        expect(readBfmeMemoryStream1(memory, [object, 0x601, 1])).toBe(-1);
    });

    test('routes one-byte reads through the guarded WASM stub and other sizes to original', () => {
        const base = 0x1000;
        const stub = 0x2000;
        const trampoline = 0x3000;
        const code = assembleBfmeMemoryStreamRead1Filter(base, stub, trampoline);
        const data = new DataView(code.buffer, code.byteOffset, code.byteLength);

        expect([...code.slice(0, 5)]).toEqual([0x83, 0x7c, 0x24, 0x08, 0x01]);
        const originalAt = 28;
        const originalFromJne = (base + 11 + data.getInt32(7, true)) >>> 0;
        expect(originalFromJne).toBe(base + originalAt);
        expect((base + originalAt + 5 + data.getInt32(originalAt + 1, true)) >>> 0).toBe(trampoline);
        expect((base + 25 + data.getInt32(21, true)) >>> 0).toBe(stub);
        expect([...code.slice(11, 21)]).toEqual([
            0xff, 0x74, 0x24, 0x08, 0xff, 0x74, 0x24, 0x08, 0x51, 0xe8,
        ]);
        expect([...code.slice(25, 28)]).toEqual([0xc2, 0x08, 0x00]);
        expect(validatePrologueBytes(Uint8Array.from([0x8b, 0xd1, 0x53, 0x8b, 0x5a, 0x14]))).toBeNull();
    });
});

describe('BFME BC1 colour-block HLE', () => {
    test('expands four-colour blocks to the exact sixteen RGBA-float texels', () => {
        const memory = new Uint8Array(0x1000);
        const data = new DataView(memory.buffer);
        const input = 0x100;
        const output = 0x200;
        data.setUint16(input, 0xf800, true); // red
        data.setUint16(input + 2, 0x001f, true); // blue; color0 > color1
        data.setUint32(input + 4, 0xe4e4e4e4, true); // selectors 0,1,2,3 repeated
        const view = {
            readU8: (a: number) => data.getUint8(a), readU16: (a: number) => data.getUint16(a, true),
            readU32: (a: number) => data.getUint32(a, true), readI32: (a: number) => data.getInt32(a, true),
            readF32: (a: number) => data.getFloat32(a, true), readF64: (a: number) => data.getFloat64(a, true),
            writeU8: (a: number, v: number) => data.setUint8(a, v), writeU16: (a: number, v: number) => data.setUint16(a, v, true),
            writeU32: (a: number, v: number) => data.setUint32(a, v, true), writeI32: (a: number, v: number) => data.setInt32(a, v, true),
            writeF32: (a: number, v: number) => data.setFloat32(a, v, true), writeF64: (a: number, v: number) => data.setFloat64(a, v, true),
        } as ShadowView;
        expect(decodeBfmeBc1ColorBlock(view, [output, input])).toBe(0);
        expect([0, 1, 2, 3].map(pixel => [0, 1, 2, 3].map(lane => data.getUint32(output + pixel * 16 + lane * 4, true)))).toEqual([
            [0x3f800000, 0, 0, 0x3f800000],
            [0, 0, 0x3f800000, 0x3f800000],
            [0x3f2aaaaa, 0, 0x3eaaaaab, 0x3f800000],
            [0x3eaaaaaa, 0, 0x3f2aaaab, 0x3f800000],
        ]);
    });

    test('uses BC1 transparent black when color0 is not greater than color1', () => {
        const memory = new Uint8Array(0x400);
        const data = new DataView(memory.buffer);
        data.setUint16(0x20, 0, true);
        data.setUint16(0x22, 0xffff, true);
        data.setUint32(0x24, 0xffff_ffff, true); // selector 3 everywhere
        const view = {
            readU16: (a: number) => data.getUint16(a, true), readU32: (a: number) => data.getUint32(a, true),
            writeF32: (a: number, v: number) => data.setFloat32(a, v, true),
        } as ShadowView;
        decodeBfmeBc1ColorBlock(view, [0x100, 0x20]);
        expect([...memory.slice(0x100, 0x200)].every(value => value === 0)).toBe(true);
    });
});

describe('BFME DXT encode exact cache wrapper', () => {
    test('preserves the implicit source and calls lookup, original, then record', () => {
        const base = 0x1000;
        const stub = 0x2800;
        const trampoline = 0x3400;
        const code = assembleBfmeDxtEncodeCacheWrapper(base, stub, trampoline);
        const data = new DataView(code.buffer, code.byteOffset, code.byteLength);

        expect([...code.slice(0, 17)]).toEqual([
            0x53, 0x56, 0x57, 0x89, 0xc6,
            0x8b, 0x7c, 0x24, 0x10,
            0x8b, 0x5c, 0x24, 0x14,
            0xff, 0x74, 0x24, 0x18,
        ]);
        expect(code[26]).toBe(0xe8);
        expect(code[42]).toBe(0xe8);
        expect(code[56]).toBe(0xe8);
        expect((base + 31 + data.getInt32(27, true)) >>> 0).toBe(stub);
        expect((base + 47 + data.getInt32(43, true)) >>> 0).toBe(trampoline);
        expect((base + 61 + data.getInt32(57, true)) >>> 0).toBe(stub);
        expect([...code.slice(31, 35)]).toEqual([0x85, 0xc0, 0x75, 0x1a]);
        expect([...code.slice(-11)]).toEqual([
            0x83, 0xc4, 0x04, 0x5f, 0x5e, 0x5b, 0x31, 0xc0, 0xc2, 0x0c, 0x00,
        ]);
        expect(validatePrologueBytes(Uint8Array.from([
            0x55, 0x8d, 0x6c, 0x24, 0x94, 0x81, 0xec, 0xdc, 0x02, 0x00, 0x00,
        ]))).toBeNull();
    });

    test('routes the cache handler through the BFME WASM handler band', async () => {
        const source = await Bun.file(new URL('../../vendor/v86/src/rust/cpu/hypercall.rs', import.meta.url)).text();
        expect(source).toContain('135..=155 => super::hypercall_bfme::dispatch_inner_loop(handler_id)');
        expect(source).toContain('156..=255 => false');
    });
});
