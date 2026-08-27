import type { ShadowSpec, ShadowView } from '../../types';

/**
 * lotrbfme.exe 1.03 FR @ 0x00b47940.
 *
 * Blend the B, G and R bytes from `source` over `destination`, using the low
 * byte of every dword in `alpha`. The destination alpha byte is preserved.
 * The operation order mirrors the original integer x86 loop exactly.
 */
export function blendBfmePixels(view: ShadowView, args: number[]): number {
    const source = args[0] >>> 0;
    const destination = args[1] >>> 0;
    const alpha = args[2] >>> 0;
    const count = args[3] | 0;

    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        const src = view.readU32((source + offset) >>> 0);
        const old = view.readU32((destination + offset) >>> 0);
        const opacity = view.readU8((alpha + offset) >>> 0);
        const inverse = 255 - opacity;
        let result = old & 0xff000000;
        for (let shift = 0; shift < 24; shift += 8) {
            const srcByte = (src >>> shift) & 0xff;
            const dstByte = (old >>> shift) & 0xff;
            const blended = ((Math.imul(srcByte, opacity) >> 8)
                + (Math.imul(dstByte, inverse) >> 8)) & 0xff;
            result |= blended << shift;
        }
        view.writeU32((destination + offset) >>> 0, result >>> 0);
    }
    return count > 0 ? 0 : count;
}

export const bfmePixelAlphaBlendShadow: ShadowSpec = {
    n: 64,
    validateInGame: true,
    ignoreEax: true,
    guard(args, view) {
        const source = args[0] >>> 0;
        const destination = args[1] >>> 0;
        const alpha = args[2] >>> 0;
        const count = args[3] | 0;
        if (!source || !destination || !alpha || count <= 0 || count > 0x100000) return false;
        const last = (count - 1) * 4;
        if (source + last + 4 > 0x1_0000_0000
            || destination + last + 4 > 0x1_0000_0000
            || alpha + last + 1 > 0x1_0000_0000) return false;
        try {
            view.readU32(source);
            view.readU32((source + last) >>> 0);
            view.readU32(destination);
            view.readU32((destination + last) >>> 0);
            view.readU8(alpha);
            view.readU8((alpha + last) >>> 0);
            return true;
        } catch {
            return false;
        }
    },
    ranges(args) {
        return [{ addr: args[1] >>> 0, len: (args[3] | 0) * 4 }];
    },
    kernel: blendBfmePixels,
};
