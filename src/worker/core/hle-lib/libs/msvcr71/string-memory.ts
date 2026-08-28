import type { ShadowSpec, ShadowView } from '../../types';

export function msvcr71MemcmpKernel(view: ShadowView, args: number[]): number {
    const left = args[0] >>> 0;
    const right = args[1] >>> 0;
    const length = args[2] >>> 0;
    for (let offset = 0; offset < length; offset++) {
        const a = view.readU8((left + offset) >>> 0);
        const b = view.readU8((right + offset) >>> 0);
        if (a !== b) return a < b ? -1 : 1;
    }
    return 0;
}

export function msvcr71StrlenKernel(view: ShadowView, args: number[]): number {
    const string = args[0] >>> 0;
    for (let length = 0; length < 0x10_0000; length++) {
        if (view.readU8((string + length) >>> 0) === 0) return length;
    }
    throw new Error('MSVCR71 strlen input exceeds validation bound');
}

export function msvcr71StrncpyKernel(view: ShadowView, args: number[]): number {
    const destination = args[0] >>> 0;
    const source = args[1] >>> 0;
    const count = args[2] >>> 0;
    let terminated = false;
    for (let offset = 0; offset < count; offset++) {
        const byte = terminated ? 0 : view.readU8((source + offset) >>> 0);
        view.writeU8((destination + offset) >>> 0, byte);
        if (byte === 0) terminated = true;
    }
    return destination;
}

export function msvcr71StrnicmpKernel(view: ShadowView, args: number[]): number {
    let left = args[0] >>> 0;
    let right = args[1] >>> 0;
    const count = args[2] >>> 0;
    for (let offset = 0; offset < count; offset++, left++, right++) {
        const a = view.readU8(left >>> 0);
        const b = view.readU8(right >>> 0);
        if (a === b) {
            if (a === 0) return 0;
            continue;
        }
        const foldedA = a >= 0x41 && a <= 0x5a ? a + 0x20 : a;
        const foldedB = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
        if (foldedA !== foldedB) return foldedA < foldedB ? -1 : 1;
    }
    return 0;
}

export function msvcr71StrcmpKernel(view: ShadowView, args: number[]): number {
    let left = args[0] >>> 0;
    let right = args[1] >>> 0;
    for (let length = 0; length < 0x10_0000; length++, left++, right++) {
        const a = view.readU8(left >>> 0);
        const b = view.readU8(right >>> 0);
        if (a !== b) return a < b ? -1 : 1;
        if (a === 0) return 0;
    }
    throw new Error('MSVCR71 strcmp input exceeds validation bound');
}

export function msvcr71StrstrKernel(view: ShadowView, args: number[]): number {
    const haystack = args[0] >>> 0;
    const needle = args[1] >>> 0;
    const first = view.readU8(needle);
    if (first === 0) return haystack;
    for (let i = 0; i < 0x10_0000; i++) {
        const candidate = view.readU8((haystack + i) >>> 0);
        if (candidate === 0) return 0;
        if (candidate !== first) continue;
        for (let j = 1; j < 0x10_0000; j++) {
            const expected = view.readU8((needle + j) >>> 0);
            if (expected === 0) return (haystack + i) >>> 0;
            if (view.readU8((haystack + i + j) >>> 0) !== expected) break;
        }
    }
    throw new Error('MSVCR71 strstr input exceeds validation bound');
}

export const msvcr71MemcmpShadow: ShadowSpec = {
    ranges: () => [],
    guard: (args) => (args[2] >>> 0) <= 0x10_0000
        && ((args[2] >>> 0) === 0 || ((args[0] >>> 0) !== 0 && (args[1] >>> 0) !== 0)),
    kernel: msvcr71MemcmpKernel,
    n: 64,
};

export const msvcr71StrlenShadow: ShadowSpec = {
    ranges: () => [],
    guard: (args) => (args[0] >>> 0) !== 0,
    kernel: msvcr71StrlenKernel,
    n: 64,
};

export const msvcr71StrncpyShadow: ShadowSpec = {
    ranges: (args) => [{ addr: args[0] >>> 0, len: args[2] >>> 0 }],
    guard: (args) => (args[2] >>> 0) <= 0x10_0000
        && ((args[2] >>> 0) === 0 || ((args[0] >>> 0) !== 0 && (args[1] >>> 0) !== 0)),
    kernel: msvcr71StrncpyKernel,
    n: 64,
};

export const msvcr71StrnicmpShadow: ShadowSpec = {
    ranges: () => [],
    guard: (args) => (args[2] >>> 0) <= 0x10_0000
        && ((args[2] >>> 0) === 0 || ((args[0] >>> 0) !== 0 && (args[1] >>> 0) !== 0)),
    kernel: msvcr71StrnicmpKernel,
    n: 64,
};

export const msvcr71StrcmpShadow: ShadowSpec = {
    ranges: () => [],
    guard: (args) => (args[0] >>> 0) !== 0 && (args[1] >>> 0) !== 0,
    kernel: msvcr71StrcmpKernel,
    n: 64,
};

export const msvcr71StrstrShadow: ShadowSpec = {
    ranges: () => [],
    guard: (args) => (args[0] >>> 0) !== 0 && (args[1] >>> 0) !== 0,
    kernel: msvcr71StrstrKernel,
    n: 64,
};
