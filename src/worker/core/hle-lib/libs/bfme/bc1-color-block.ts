import type { ShadowSpec, ShadowView } from '../../types';

const SCALE_5 = Math.fround(1 / 31);
const SCALE_6 = Math.fround(1 / 63);
const HALF = Math.fround(0.5);
const THIRD = Math.fround(1 / 3);
const TWO_THIRDS = Math.fround(2 / 3);

function interpolate(left: number, right: number, scale: number): number {
    // The original x87 helper loads binary32 inputs/constants, performs the
    // subtract/multiply/add in extended precision, then stores binary32.
    return Math.fround((right - left) * scale + left);
}

function endpoint565(value: number): [number, number, number, number] {
    return [
        Math.fround(((value >>> 11) & 0x1f) * SCALE_5),
        Math.fround(((value >>> 5) & 0x3f) * SCALE_6),
        Math.fround((value & 0x1f) * SCALE_5),
        1,
    ];
}

/** lotrbfme.exe 1.03 FR @ 0x00e679a5: expand the colour half of a BC1 block
 * to BFME's sixteen RGBA-float texels. */
export function decodeBfmeBc1ColorBlock(view: ShadowView, args: number[]): number {
    const output = args[0] >>> 0;
    const input = args[1] >>> 0;
    const color0 = view.readU16(input);
    const color1 = view.readU16((input + 2) >>> 0);
    const selectors = view.readU32((input + 4) >>> 0);
    const palette: Array<[number, number, number, number]> = [
        endpoint565(color0),
        endpoint565(color1),
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ];
    if (color0 <= color1) {
        for (let lane = 0; lane < 4; lane++) {
            palette[2][lane] = interpolate(palette[0][lane], palette[1][lane], HALF);
        }
    } else {
        for (let lane = 0; lane < 4; lane++) {
            palette[2][lane] = interpolate(palette[0][lane], palette[1][lane], THIRD);
            palette[3][lane] = interpolate(palette[0][lane], palette[1][lane], TWO_THIRDS);
        }
    }
    for (let pixel = 0; pixel < 16; pixel++) {
        const color = palette[(selectors >>> (pixel * 2)) & 3];
        const destination = (output + pixel * 16) >>> 0;
        for (let lane = 0; lane < 4; lane++) view.writeF32(destination + lane * 4, color[lane]);
    }
    return 0;
}

export const bfmeBc1ColorBlockShadow: ShadowSpec = {
    n: 64,
    validateInGame: true,
    // v86's x87 path can retain one more intermediate precision bit than the
    // scalar WASM kernel. The decoded normalized channel may consequently
    // differ by one binary32 ULP; larger deviations still disable the hook.
    f32UlpTolerance: 1,
    guard(args, view) {
        const output = args[0] >>> 0;
        const input = args[1] >>> 0;
        if (!output || !input || output > 0xffff_ff00 || input > 0xffff_fff7) return false;
        try {
            view.readU32(input);
            view.readU32((input + 4) >>> 0);
            view.readU32(output);
            view.readU32((output + 252) >>> 0);
            return true;
        } catch {
            return false;
        }
    },
    ranges(args) {
        return [{ addr: args[0] >>> 0, len: 256 }];
    },
    kernel: decodeBfmeBc1ColorBlock,
};
