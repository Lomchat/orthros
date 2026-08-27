import type { ShadowSpec, ShadowView } from '../../types';

const DCT_SIZE = 8;
const CONST_BITS = 13;
const PASS1_BITS = 2;
const RANGE_MASK = 1023;

const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;

const add = (a: number, b: number): number => (a + b) | 0;
const sub = (a: number, b: number): number => (a - b) | 0;
const mul = (a: number, b: number): number => Math.imul(a, b);
const shl = (a: number, bits: number): number => a << bits;
const descale = (a: number, bits: number): number => add(a, 1 << (bits - 1)) >> bits;
const i16 = (value: number): number => (value << 16) >> 16;

/** IJG's exact 8-bit integer slow IDCT used by BFME's statically linked JPEG. */
export function bfmeJpegIdctIslow(view: ShadowView, args: number[]): number {
    const cinfo = args[0] >>> 0;
    const component = args[1] >>> 0;
    const coefficients = args[2] >>> 0;
    const outputRows = args[3] >>> 0;
    const outputColumn = args[4] >>> 0;
    const rangeLimit = (view.readU32(cinfo + 0x148) + 0x80) >>> 0;
    const quantization = view.readU32(component + 0x50) >>> 0;
    const workspace = new Int32Array(64);

    const coef = (index: number): number => i16(view.readU16(coefficients + index * 2));
    const quant = (index: number): number => i16(view.readU16(quantization + index * 2));

    for (let column = 0; column < DCT_SIZE; column++) {
        if (coef(column + 8) === 0 && coef(column + 16) === 0
            && coef(column + 24) === 0 && coef(column + 32) === 0
            && coef(column + 40) === 0 && coef(column + 48) === 0
            && coef(column + 56) === 0) {
            const dc = shl(mul(coef(column), quant(column)), PASS1_BITS);
            for (let row = 0; row < DCT_SIZE; row++) workspace[row * 8 + column] = dc;
            continue;
        }

        let z2 = mul(coef(column + 16), quant(column + 16));
        let z3 = mul(coef(column + 48), quant(column + 48));
        let z1 = mul(add(z2, z3), FIX_0_541196100);
        let tmp2 = sub(z1, mul(z3, FIX_1_847759065));
        let tmp3 = add(z1, mul(z2, FIX_0_765366865));
        z2 = mul(coef(column), quant(column));
        z3 = mul(coef(column + 32), quant(column + 32));
        let tmp0 = shl(add(z2, z3), CONST_BITS);
        let tmp1 = shl(sub(z2, z3), CONST_BITS);
        const tmp10 = add(tmp0, tmp3);
        const tmp13 = sub(tmp0, tmp3);
        const tmp11 = add(tmp1, tmp2);
        const tmp12 = sub(tmp1, tmp2);

        tmp0 = mul(coef(column + 56), quant(column + 56));
        tmp1 = mul(coef(column + 40), quant(column + 40));
        tmp2 = mul(coef(column + 24), quant(column + 24));
        tmp3 = mul(coef(column + 8), quant(column + 8));
        z1 = add(tmp0, tmp3);
        z2 = add(tmp1, tmp2);
        z3 = add(tmp0, tmp2);
        let z4 = add(tmp1, tmp3);
        const z5 = mul(add(z3, z4), FIX_1_175875602);
        tmp0 = mul(tmp0, FIX_0_298631336);
        tmp1 = mul(tmp1, FIX_2_053119869);
        tmp2 = mul(tmp2, FIX_3_072711026);
        tmp3 = mul(tmp3, FIX_1_501321110);
        z1 = mul(z1, -FIX_0_899976223);
        z2 = mul(z2, -FIX_2_562915447);
        z3 = add(mul(z3, -FIX_1_961570560), z5);
        z4 = add(mul(z4, -FIX_0_390180644), z5);
        tmp0 = add(tmp0, add(z1, z3));
        tmp1 = add(tmp1, add(z2, z4));
        tmp2 = add(tmp2, add(z2, z3));
        tmp3 = add(tmp3, add(z1, z4));

        workspace[column] = descale(add(tmp10, tmp3), CONST_BITS - PASS1_BITS);
        workspace[56 + column] = descale(sub(tmp10, tmp3), CONST_BITS - PASS1_BITS);
        workspace[8 + column] = descale(add(tmp11, tmp2), CONST_BITS - PASS1_BITS);
        workspace[48 + column] = descale(sub(tmp11, tmp2), CONST_BITS - PASS1_BITS);
        workspace[16 + column] = descale(add(tmp12, tmp1), CONST_BITS - PASS1_BITS);
        workspace[40 + column] = descale(sub(tmp12, tmp1), CONST_BITS - PASS1_BITS);
        workspace[24 + column] = descale(add(tmp13, tmp0), CONST_BITS - PASS1_BITS);
        workspace[32 + column] = descale(sub(tmp13, tmp0), CONST_BITS - PASS1_BITS);
    }

    const sample = (value: number): number => view.readU8(rangeLimit + (value & RANGE_MASK));
    for (let row = 0; row < DCT_SIZE; row++) {
        const base = row * 8;
        const destination = (view.readU32(outputRows + row * 4) + outputColumn) >>> 0;
        if (workspace[base + 1] === 0 && workspace[base + 2] === 0
            && workspace[base + 3] === 0 && workspace[base + 4] === 0
            && workspace[base + 5] === 0 && workspace[base + 6] === 0
            && workspace[base + 7] === 0) {
            const value = sample(descale(workspace[base], PASS1_BITS + 3));
            for (let x = 0; x < 8; x++) view.writeU8(destination + x, value);
            continue;
        }

        let z2 = workspace[base + 2];
        let z3 = workspace[base + 6];
        let z1 = mul(add(z2, z3), FIX_0_541196100);
        let tmp2 = sub(z1, mul(z3, FIX_1_847759065));
        let tmp3 = add(z1, mul(z2, FIX_0_765366865));
        let tmp0 = shl(add(workspace[base], workspace[base + 4]), CONST_BITS);
        let tmp1 = shl(sub(workspace[base], workspace[base + 4]), CONST_BITS);
        const tmp10 = add(tmp0, tmp3);
        const tmp13 = sub(tmp0, tmp3);
        const tmp11 = add(tmp1, tmp2);
        const tmp12 = sub(tmp1, tmp2);

        tmp0 = workspace[base + 7];
        tmp1 = workspace[base + 5];
        tmp2 = workspace[base + 3];
        tmp3 = workspace[base + 1];
        z1 = add(tmp0, tmp3);
        z2 = add(tmp1, tmp2);
        z3 = add(tmp0, tmp2);
        let z4 = add(tmp1, tmp3);
        const z5 = mul(add(z3, z4), FIX_1_175875602);
        tmp0 = mul(tmp0, FIX_0_298631336);
        tmp1 = mul(tmp1, FIX_2_053119869);
        tmp2 = mul(tmp2, FIX_3_072711026);
        tmp3 = mul(tmp3, FIX_1_501321110);
        z1 = mul(z1, -FIX_0_899976223);
        z2 = mul(z2, -FIX_2_562915447);
        z3 = add(mul(z3, -FIX_1_961570560), z5);
        z4 = add(mul(z4, -FIX_0_390180644), z5);
        tmp0 = add(tmp0, add(z1, z3));
        tmp1 = add(tmp1, add(z2, z4));
        tmp2 = add(tmp2, add(z2, z3));
        tmp3 = add(tmp3, add(z1, z4));

        const shift = CONST_BITS + PASS1_BITS + 3;
        view.writeU8(destination, sample(descale(add(tmp10, tmp3), shift)));
        view.writeU8(destination + 7, sample(descale(sub(tmp10, tmp3), shift)));
        view.writeU8(destination + 1, sample(descale(add(tmp11, tmp2), shift)));
        view.writeU8(destination + 6, sample(descale(sub(tmp11, tmp2), shift)));
        view.writeU8(destination + 2, sample(descale(add(tmp12, tmp1), shift)));
        view.writeU8(destination + 5, sample(descale(sub(tmp12, tmp1), shift)));
        view.writeU8(destination + 3, sample(descale(add(tmp13, tmp0), shift)));
        view.writeU8(destination + 4, sample(descale(sub(tmp13, tmp0), shift)));
    }
    return 0;
}

export const bfmeJpegIdctShadow: ShadowSpec = {
    n: 64,
    validateInGame: true,
    ignoreEax: true,
    guard(args, view) {
        const cinfo = args[0] >>> 0;
        const component = args[1] >>> 0;
        const coefficients = args[2] >>> 0;
        const outputRows = args[3] >>> 0;
        const outputColumn = args[4] >>> 0;
        if (!cinfo || !component || !coefficients || !outputRows || outputColumn > 0x100000) return false;
        try {
            const range = view.readU32(cinfo + 0x148) >>> 0;
            const quant = view.readU32(component + 0x50) >>> 0;
            if (!range || !quant) return false;
            for (let row = 0; row < 8; row++) if (!(view.readU32(outputRows + row * 4) >>> 0)) return false;
            return true;
        } catch { return false; }
    },
    ranges(args, view) {
        const rows = args[3] >>> 0;
        const column = args[4] >>> 0;
        return Array.from({ length: 8 }, (_, row) => ({
            addr: ((view.readU32(rows + row * 4) >>> 0) + column) >>> 0,
            len: 8,
        }));
    },
    kernel: bfmeJpegIdctIslow,
};
