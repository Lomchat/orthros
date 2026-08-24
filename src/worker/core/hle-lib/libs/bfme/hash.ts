import type { ShadowView } from '../../types';

/** BFME's case-insensitive `hash = hash * 33 + tolower((signed char)c)`.
 * The signed-byte step is intentional: the original passes MOVSX(AL) to the
 * VC7 CRT. Under its default C locale, bytes outside ASCII A-Z pass through. */
export function bfmeFold33HashKernel(view: ShadowView, args: number[]): number {
    let ptr = args[0] >>> 0;
    let hash = 0;
    for (let i = 0; i < 4096; i++, ptr = (ptr + 1) >>> 0) {
        const byte = view.readU8(ptr);
        if (byte === 0) return hash >>> 0;
        let folded = byte >= 0x80 ? byte - 0x100 : byte;
        if (folded >= 0x41 && folded <= 0x5a) folded += 0x20;
        hash = (Math.imul(hash, 33) + folded) | 0;
    }
    throw new Error('BFME fold33 string exceeds 4096 bytes');
}

