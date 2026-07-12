import { describe, expect, test } from "bun:test";
import {
    CombineInputs,
    evalColorCombine,
    evalAlphaCombine,
    packCombine,
    unpackCombine,
    packBlend,
    unpackBlend,
    glideSrcFactorToGpu,
    glideDstFactorToGpu,
    blendIsOpaque,
    GR_COMBINE_FUNCTION_ZERO,
    GR_COMBINE_FUNCTION_LOCAL,
    GR_COMBINE_FUNCTION_SCALE_OTHER,
    GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL,
    GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL,
    GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL,
    GR_COMBINE_FACTOR_ZERO,
    GR_COMBINE_FACTOR_LOCAL,
    GR_COMBINE_FACTOR_ONE,
    GR_COMBINE_FACTOR_TEXTURE_ALPHA,
    GR_COMBINE_LOCAL_ITERATED,
    GR_COMBINE_LOCAL_CONSTANT,
    GR_COMBINE_OTHER_ITERATED,
    GR_COMBINE_OTHER_TEXTURE,
    GR_BLEND_ONE,
    GR_BLEND_ZERO,
    GR_BLEND_SRC_ALPHA,
    GR_BLEND_ONE_MINUS_SRC_ALPHA,
    GR_BLEND_SRC_COLOR,
    GR_BLEND_ONE_MINUS_SRC_COLOR,
} from "../../src/worker/backends/webgpu/glide/glide-combine";

const inp = (
    texture: [number, number, number, number],
    iterated: [number, number, number, number],
    constant: [number, number, number, number],
): CombineInputs => ({ texture, iterated, constant });

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-5);
const closeRgb = (a: [number, number, number], b: [number, number, number]) => {
    close(a[0], b[0]); close(a[1], b[1]); close(a[2], b[2]);
};

describe("glide-combine descriptor packing", () => {
    test("packCombine/unpackCombine round-trips all fields", () => {
        const d = { function: 0x10, factor: 0xd, local: 0x2, other: 0x2, invert: 1 };
        const r = unpackCombine(packCombine(d));
        expect(r).toEqual(d);
    });
    test("packBlend/unpackBlend round-trips", () => {
        const r = unpackBlend(packBlend(0x1, 0x5, 0x4, 0x0));
        expect(r).toEqual({ rgbSf: 0x1, rgbDf: 0x5, alphaSf: 0x4, alphaDf: 0x0 });
    });
});

describe("glide color combine equation", () => {
    const tex: [number, number, number, number] = [0.8, 0.4, 0.2, 0.5];
    const it: [number, number, number, number] = [0.5, 0.5, 0.5, 1.0];
    const cc: [number, number, number, number] = [1.0, 0.0, 0.0, 1.0];

    test("TEXTURE_TIMES_ITRGB = iterated * texture (modulate)", () => {
        // SCALE_OTHER, factor=LOCAL, local=ITERATED, other=TEXTURE
        const out = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_SCALE_OTHER, factor: GR_COMBINE_FACTOR_LOCAL, local: GR_COMBINE_LOCAL_ITERATED, other: GR_COMBINE_OTHER_TEXTURE, invert: 0 },
            inp(tex, it, cc),
        );
        closeRgb(out, [it[0] * tex[0], it[1] * tex[1], it[2] * tex[2]]);
    });

    test("DECAL_TEXTURE = texture only", () => {
        // SCALE_OTHER, factor=ONE, local=CONSTANT, other=TEXTURE
        const out = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_SCALE_OTHER, factor: GR_COMBINE_FACTOR_ONE, local: GR_COMBINE_LOCAL_CONSTANT, other: GR_COMBINE_OTHER_TEXTURE, invert: 0 },
            inp(tex, it, cc),
        );
        closeRgb(out, [tex[0], tex[1], tex[2]]);
    });

    test("TEXTURE_ADD_ITRGB = texture + iterated (additive, clamped)", () => {
        // SCALE_OTHER_ADD_LOCAL, factor=ONE, local=ITERATED, other=TEXTURE
        const out = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL, factor: GR_COMBINE_FACTOR_ONE, local: GR_COMBINE_LOCAL_ITERATED, other: GR_COMBINE_OTHER_TEXTURE, invert: 0 },
            inp(tex, it, cc),
        );
        closeRgb(out, [Math.min(1, tex[0] + it[0]), Math.min(1, tex[1] + it[1]), Math.min(1, tex[2] + it[2])]);
    });

    test("TEXTURE_SUB_ITRGB = texture - iterated (clamped at 0)", () => {
        const out = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL, factor: GR_COMBINE_FACTOR_ONE, local: GR_COMBINE_LOCAL_ITERATED, other: GR_COMBINE_OTHER_TEXTURE, invert: 0 },
            inp(tex, it, cc),
        );
        closeRgb(out, [Math.max(0, tex[0] - it[0]), Math.max(0, tex[1] - it[1]), Math.max(0, tex[2] - it[2])]);
    });

    test("BLEND (lerp) with TEXTURE_ALPHA factor blends local<->other by texAlpha", () => {
        // SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL, factor=TEXTURE_ALPHA, local=ITERATED, other=TEXTURE
        // out = texAlpha*(tex - it) + it = lerp(it, tex, texAlpha)
        const out = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL, factor: GR_COMBINE_FACTOR_TEXTURE_ALPHA, local: GR_COMBINE_LOCAL_ITERATED, other: GR_COMBINE_OTHER_TEXTURE, invert: 0 },
            inp(tex, it, cc),
        );
        const a = tex[3];
        closeRgb(out, [a * (tex[0] - it[0]) + it[0], a * (tex[1] - it[1]) + it[1], a * (tex[2] - it[2]) + it[2]]);
    });

    test("FUNCTION_ZERO produces black, not white", () => {
        const out = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_ZERO, factor: GR_COMBINE_FACTOR_ZERO, local: GR_COMBINE_LOCAL_CONSTANT, other: GR_COMBINE_OTHER_TEXTURE, invert: 0 },
            inp(tex, it, cc),
        );
        closeRgb(out, [0, 0, 0]);
    });

    test("invert flag 1's-complements the output", () => {
        const base = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_LOCAL, factor: GR_COMBINE_FACTOR_ZERO, local: GR_COMBINE_LOCAL_ITERATED, other: GR_COMBINE_OTHER_ITERATED, invert: 0 },
            inp(tex, it, cc),
        );
        const inv = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_LOCAL, factor: GR_COMBINE_FACTOR_ZERO, local: GR_COMBINE_LOCAL_ITERATED, other: GR_COMBINE_OTHER_ITERATED, invert: 1 },
            inp(tex, it, cc),
        );
        closeRgb(inv, [1 - base[0], 1 - base[1], 1 - base[2]]);
    });

    test("CCRGB (constant color) = LOCAL with local=CONSTANT", () => {
        const out = evalColorCombine(
            { function: GR_COMBINE_FUNCTION_LOCAL, factor: GR_COMBINE_FACTOR_ZERO, local: GR_COMBINE_LOCAL_CONSTANT, other: GR_COMBINE_OTHER_ITERATED, invert: 0 },
            inp(tex, it, cc),
        );
        closeRgb(out, [cc[0], cc[1], cc[2]]);
    });
});

describe("glide alpha combine equation", () => {
    const tex: [number, number, number, number] = [0.8, 0.4, 0.2, 0.5];
    const it: [number, number, number, number] = [0.5, 0.5, 0.5, 0.8];
    const cc: [number, number, number, number] = [1, 0, 0, 0.25];

    test("alpha modulate: texAlpha * iteratedAlpha", () => {
        // SCALE_OTHER, factor=LOCAL(=localAlpha), local=ITERATED, other=TEXTURE
        const out = evalAlphaCombine(
            { function: GR_COMBINE_FUNCTION_SCALE_OTHER, factor: GR_COMBINE_FACTOR_LOCAL, local: GR_COMBINE_LOCAL_ITERATED, other: GR_COMBINE_OTHER_TEXTURE, invert: 0 },
            inp(tex, it, cc),
        );
        close(out, it[3] * tex[3]);
    });

    test("alpha LOCAL=iterated passes iterated alpha through", () => {
        const out = evalAlphaCombine(
            { function: GR_COMBINE_FUNCTION_LOCAL, factor: GR_COMBINE_FACTOR_ZERO, local: GR_COMBINE_LOCAL_ITERATED, other: GR_COMBINE_OTHER_ITERATED, invert: 0 },
            inp(tex, it, cc),
        );
        close(out, it[3]);
    });

    test("alpha texture-alpha factor (TEXTURE_TIMES_ALPHA path)", () => {
        const out = evalAlphaCombine(
            { function: GR_COMBINE_FUNCTION_SCALE_OTHER, factor: GR_COMBINE_FACTOR_TEXTURE_ALPHA, local: GR_COMBINE_LOCAL_CONSTANT, other: GR_COMBINE_OTHER_TEXTURE, invert: 0 },
            inp(tex, it, cc),
        );
        close(out, tex[3] * tex[3]);
    });
});

describe("GR_BLEND_* -> GPU blend factor mapping", () => {
    test("standard alpha blend (SRC_ALPHA / ONE_MINUS_SRC_ALPHA)", () => {
        expect(glideSrcFactorToGpu(GR_BLEND_SRC_ALPHA)).toBe("src-alpha");
        expect(glideDstFactorToGpu(GR_BLEND_ONE_MINUS_SRC_ALPHA)).toBe("one-minus-src-alpha");
    });
    test("additive (ONE / ONE)", () => {
        expect(glideSrcFactorToGpu(GR_BLEND_ONE)).toBe("one");
        expect(glideDstFactorToGpu(GR_BLEND_ONE)).toBe("one");
    });
    test("opaque (ONE / ZERO)", () => {
        expect(glideSrcFactorToGpu(GR_BLEND_ONE)).toBe("one");
        expect(glideDstFactorToGpu(GR_BLEND_ZERO)).toBe("zero");
        expect(blendIsOpaque(GR_BLEND_ONE, GR_BLEND_ZERO, GR_BLEND_ONE, GR_BLEND_ZERO)).toBe(true);
        expect(blendIsOpaque(GR_BLEND_SRC_ALPHA, GR_BLEND_ONE_MINUS_SRC_ALPHA, GR_BLEND_ONE, GR_BLEND_ZERO)).toBe(false);
    });
    test("0x2/0x6 src/dst color aliasing quirk", () => {
        // As a SOURCE factor, 0x2 means DST color; as a DEST factor it means SRC color.
        expect(glideSrcFactorToGpu(GR_BLEND_SRC_COLOR)).toBe("dst");
        expect(glideDstFactorToGpu(GR_BLEND_SRC_COLOR)).toBe("src");
        expect(glideSrcFactorToGpu(GR_BLEND_ONE_MINUS_SRC_COLOR)).toBe("one-minus-dst");
        expect(glideDstFactorToGpu(GR_BLEND_ONE_MINUS_SRC_COLOR)).toBe("one-minus-src");
    });
});
