import type { ShadowSpec, ShadowView } from '../../types';

function foldAscii(byte: number): number {
    return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

/** Exact MSVCR71 7.10 `_stricmp` result semantics: ASCII folding and a
 * normalized -1/0/+1 result. The C API leaves null pointers undefined. */
export function msvcr71StricmpKernel(view: ShadowView, args: number[]): number {
    let left = args[0] >>> 0;
    let right = args[1] >>> 0;
    for (let i = 0; i < 16_384; i++, left = (left + 1) >>> 0, right = (right + 1) >>> 0) {
        const a = view.readU8(left);
        const b = view.readU8(right);
        if (a === b) {
            if (a === 0) return 0;
            continue;
        }
        const foldedA = foldAscii(a);
        const foldedB = foldAscii(b);
        if (foldedA === foldedB) continue;
        return foldedA < foldedB ? -1 : 1;
    }
    throw new Error('MSVCR71 _stricmp input exceeds 16384 bytes');
}

export const msvcr71StricmpShadow: ShadowSpec = {
    ranges: () => [],
    guard: (args) => (args[0] >>> 0) !== 0 && (args[1] >>> 0) !== 0,
    kernel: msvcr71StricmpKernel,
    n: 64,
};
