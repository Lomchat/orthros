/**
 * Glide color/alpha combine unit (CCU) — constants, descriptor packing, the
 * reference combine equation (TS), and GR_BLEND_* -> WebGPU blend-factor mapping.
 *
 * The combine equation here is the GROUND TRUTH: the WGSL in glide-shader-generator.ts
 * mirrors it arm-for-arm, and glide-combine.test.ts validates it against hand-computed
 * vectors and against the modulate cases the old draw.ts masking hack used to cover.
 *
 * Values are from vendor/3dfx-Glide-API/glide2x/h3/glide/src/glide.h.
 */

/// <reference types="@webgpu/types" />

// ---- Combine FUNCTION (GrCombineFunction_t) ----
export const GR_COMBINE_FUNCTION_ZERO = 0x0;
export const GR_COMBINE_FUNCTION_LOCAL = 0x1;
export const GR_COMBINE_FUNCTION_LOCAL_ALPHA = 0x2;
export const GR_COMBINE_FUNCTION_SCALE_OTHER = 0x3; // == BLEND_OTHER
export const GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL = 0x4;
export const GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL_ALPHA = 0x5;
export const GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL = 0x6;
export const GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL = 0x7; // == BLEND
export const GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL_ALPHA = 0x8;
export const GR_COMBINE_FUNCTION_SCALE_MINUS_LOCAL_ADD_LOCAL = 0x9; // == BLEND_LOCAL
export const GR_COMBINE_FUNCTION_SCALE_MINUS_LOCAL_ADD_LOCAL_ALPHA = 0x10;

// ---- Combine FACTOR (GrCombineFactor_t) ----
export const GR_COMBINE_FACTOR_ZERO = 0x0;
export const GR_COMBINE_FACTOR_LOCAL = 0x1;
export const GR_COMBINE_FACTOR_OTHER_ALPHA = 0x2;
export const GR_COMBINE_FACTOR_LOCAL_ALPHA = 0x3;
export const GR_COMBINE_FACTOR_TEXTURE_ALPHA = 0x4;
export const GR_COMBINE_FACTOR_TEXTURE_RGB = 0x5; // (alpha path: LOD_FRACTION)
export const GR_COMBINE_FACTOR_ONE = 0x8;
export const GR_COMBINE_FACTOR_ONE_MINUS_LOCAL = 0x9;
export const GR_COMBINE_FACTOR_ONE_MINUS_OTHER_ALPHA = 0xa;
export const GR_COMBINE_FACTOR_ONE_MINUS_LOCAL_ALPHA = 0xb;
export const GR_COMBINE_FACTOR_ONE_MINUS_TEXTURE_ALPHA = 0xc;
export const GR_COMBINE_FACTOR_ONE_MINUS_TEXTURE_RGB = 0xd;

// ---- Combine LOCAL (GrCombineLocal_t) ----
export const GR_COMBINE_LOCAL_ITERATED = 0x0;
export const GR_COMBINE_LOCAL_CONSTANT = 0x1; // == NONE
export const GR_COMBINE_LOCAL_DEPTH = 0x2;

// ---- Combine OTHER (GrCombineOther_t) ----
export const GR_COMBINE_OTHER_ITERATED = 0x0;
export const GR_COMBINE_OTHER_TEXTURE = 0x1;
export const GR_COMBINE_OTHER_CONSTANT = 0x2; // == NONE

// ---- GR_BLEND_* (alpha blend factors) ----
export const GR_BLEND_ZERO = 0x0;
export const GR_BLEND_SRC_ALPHA = 0x1;
export const GR_BLEND_SRC_COLOR = 0x2; // == GR_BLEND_DST_COLOR (meaning depends on src vs dst slot)
export const GR_BLEND_DST_ALPHA = 0x3;
export const GR_BLEND_ONE = 0x4;
export const GR_BLEND_ONE_MINUS_SRC_ALPHA = 0x5;
export const GR_BLEND_ONE_MINUS_SRC_COLOR = 0x6; // == GR_BLEND_ONE_MINUS_DST_COLOR
export const GR_BLEND_ONE_MINUS_DST_ALPHA = 0x7;
export const GR_BLEND_ALPHA_SATURATE = 0xf; // == GR_BLEND_PREFOG_COLOR

export interface CombineDescriptor {
    function: number;
    factor: number;
    local: number;
    other: number;
    invert: number;
}

// ---- Descriptor packing (transported per-draw through the flat command stream) ----
// 14 bits: fn[0:5] factor[5:9] local[9:11] other[11:13] invert[13]
export function packCombine(c: CombineDescriptor): number {
    return (
        ((c.function & 0x1f)) |
        ((c.factor & 0xf) << 5) |
        ((c.local & 0x3) << 9) |
        ((c.other & 0x3) << 11) |
        ((c.invert ? 1 : 0) << 13)
    ) >>> 0;
}

export function unpackCombine(p: number): CombineDescriptor {
    return {
        function: p & 0x1f,
        factor: (p >>> 5) & 0xf,
        local: (p >>> 9) & 0x3,
        other: (p >>> 11) & 0x3,
        invert: (p >>> 13) & 0x1,
    };
}

// 16 bits: rgbSf[0:4] rgbDf[4:8] alphaSf[8:12] alphaDf[12:16]
export function packBlend(rgbSf: number, rgbDf: number, alphaSf: number, alphaDf: number): number {
    return (
        ((rgbSf & 0xf)) |
        ((rgbDf & 0xf) << 4) |
        ((alphaSf & 0xf) << 8) |
        ((alphaDf & 0xf) << 12)
    ) >>> 0;
}

export function unpackBlend(p: number): { rgbSf: number; rgbDf: number; alphaSf: number; alphaDf: number } {
    return {
        rgbSf: p & 0xf,
        rgbDf: (p >>> 4) & 0xf,
        alphaSf: (p >>> 8) & 0xf,
        alphaDf: (p >>> 12) & 0xf,
    };
}

/**
 * Is this RGB/A combine the no-op opaque default (out = local, local = iterated)?
 * Used to decide whether the constant-color or texture inputs are even referenced.
 */
export function combineReferencesTexture(cc: CombineDescriptor, ac: CombineDescriptor): boolean {
    const usesTex = (d: CombineDescriptor): boolean =>
        d.other === GR_COMBINE_OTHER_TEXTURE ||
        d.factor === GR_COMBINE_FACTOR_TEXTURE_ALPHA ||
        d.factor === GR_COMBINE_FACTOR_ONE_MINUS_TEXTURE_ALPHA ||
        d.factor === GR_COMBINE_FACTOR_TEXTURE_RGB ||
        d.factor === GR_COMBINE_FACTOR_ONE_MINUS_TEXTURE_RGB;
    return usesTex(cc) || usesTex(ac);
}

// ---------------------------------------------------------------------------
// Reference combine equation (mirrored exactly by the WGSL).
// All colors are RGBA in [0,1]. Returns RGBA in [0,1].
// ---------------------------------------------------------------------------

export interface CombineInputs {
    texture: [number, number, number, number]; // texColor rgba
    iterated: [number, number, number, number]; // per-vertex iterated rgba
    constant: [number, number, number, number]; // grConstantColorValue rgba
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function localRgb(local: number, inp: CombineInputs): [number, number, number] {
    // ITERATED -> iterated; CONSTANT/NONE/DEPTH -> constant.
    const s = local === GR_COMBINE_LOCAL_ITERATED ? inp.iterated : inp.constant;
    return [s[0], s[1], s[2]];
}

function localAlpha(local: number, inp: CombineInputs): number {
    return (local === GR_COMBINE_LOCAL_ITERATED ? inp.iterated : inp.constant)[3];
}

function otherRgb(other: number, inp: CombineInputs): [number, number, number] {
    const s =
        other === GR_COMBINE_OTHER_ITERATED ? inp.iterated :
        other === GR_COMBINE_OTHER_TEXTURE ? inp.texture :
        inp.constant; // CONSTANT / NONE
    return [s[0], s[1], s[2]];
}

function otherAlpha(other: number, inp: CombineInputs): number {
    const s =
        other === GR_COMBINE_OTHER_ITERATED ? inp.iterated :
        other === GR_COMBINE_OTHER_TEXTURE ? inp.texture :
        inp.constant;
    return s[3];
}

// Color combine factor -> per-channel vec3 scale.
function colorFactor(
    factor: number,
    lRgb: [number, number, number],
    lA: number,
    oA: number,
    tex: [number, number, number, number],
): [number, number, number] {
    switch (factor) {
        case GR_COMBINE_FACTOR_ZERO: return [0, 0, 0];
        case GR_COMBINE_FACTOR_LOCAL: return [lRgb[0], lRgb[1], lRgb[2]];
        case GR_COMBINE_FACTOR_OTHER_ALPHA: return [oA, oA, oA];
        case GR_COMBINE_FACTOR_LOCAL_ALPHA: return [lA, lA, lA];
        case GR_COMBINE_FACTOR_TEXTURE_ALPHA: return [tex[3], tex[3], tex[3]];
        case GR_COMBINE_FACTOR_TEXTURE_RGB: return [tex[0], tex[1], tex[2]];
        case GR_COMBINE_FACTOR_ONE: return [1, 1, 1];
        case GR_COMBINE_FACTOR_ONE_MINUS_LOCAL: return [1 - lRgb[0], 1 - lRgb[1], 1 - lRgb[2]];
        case GR_COMBINE_FACTOR_ONE_MINUS_OTHER_ALPHA: return [1 - oA, 1 - oA, 1 - oA];
        case GR_COMBINE_FACTOR_ONE_MINUS_LOCAL_ALPHA: return [1 - lA, 1 - lA, 1 - lA];
        case GR_COMBINE_FACTOR_ONE_MINUS_TEXTURE_ALPHA: return [1 - tex[3], 1 - tex[3], 1 - tex[3]];
        case GR_COMBINE_FACTOR_ONE_MINUS_TEXTURE_RGB: return [1 - tex[0], 1 - tex[1], 1 - tex[2]];
        default: return [0, 0, 0];
    }
}

function applyFunctionRgb(
    fn: number,
    f: [number, number, number],
    other: [number, number, number],
    local: [number, number, number],
    localA: number,
): [number, number, number] {
    const fo: [number, number, number] = [f[0] * other[0], f[1] * other[1], f[2] * other[2]];
    switch (fn) {
        case GR_COMBINE_FUNCTION_ZERO: return [0, 0, 0];
        case GR_COMBINE_FUNCTION_LOCAL: return [local[0], local[1], local[2]];
        case GR_COMBINE_FUNCTION_LOCAL_ALPHA: return [localA, localA, localA];
        case GR_COMBINE_FUNCTION_SCALE_OTHER: return fo;
        case GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL:
            return [fo[0] + local[0], fo[1] + local[1], fo[2] + local[2]];
        case GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL_ALPHA:
            return [fo[0] + localA, fo[1] + localA, fo[2] + localA];
        case GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL:
            return [fo[0] - local[0], fo[1] - local[1], fo[2] - local[2]];
        case GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL:
            return [f[0] * (other[0] - local[0]) + local[0], f[1] * (other[1] - local[1]) + local[1], f[2] * (other[2] - local[2]) + local[2]];
        case GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL_ALPHA:
            return [f[0] * (other[0] - local[0]) + localA, f[1] * (other[1] - local[1]) + localA, f[2] * (other[2] - local[2]) + localA];
        case GR_COMBINE_FUNCTION_SCALE_MINUS_LOCAL_ADD_LOCAL:
            return [-f[0] * local[0] + local[0], -f[1] * local[1] + local[1], -f[2] * local[2] + local[2]];
        case GR_COMBINE_FUNCTION_SCALE_MINUS_LOCAL_ADD_LOCAL_ALPHA:
            return [-f[0] * local[0] + localA, -f[1] * local[1] + localA, -f[2] * local[2] + localA];
        default: return [0, 0, 0];
    }
}

export function evalColorCombine(cc: CombineDescriptor, inp: CombineInputs): [number, number, number] {
    const lRgb = localRgb(cc.local, inp);
    const lA = localAlpha(cc.local, inp);
    const oRgb = otherRgb(cc.other, inp);
    const oA = otherAlpha(cc.other, inp);
    const f = colorFactor(cc.factor, lRgb, lA, oA, inp.texture);
    let out = applyFunctionRgb(cc.function, f, oRgb, lRgb, lA);
    out = [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])];
    if (cc.invert) out = [1 - out[0], 1 - out[1], 1 - out[2]];
    return out;
}

// Alpha combine factor -> scalar.
function alphaFactor(factor: number, lA: number, oA: number, texA: number): number {
    switch (factor) {
        case GR_COMBINE_FACTOR_ZERO: return 0;
        case GR_COMBINE_FACTOR_LOCAL: return lA;
        case GR_COMBINE_FACTOR_OTHER_ALPHA: return oA;
        case GR_COMBINE_FACTOR_LOCAL_ALPHA: return lA;
        case GR_COMBINE_FACTOR_TEXTURE_ALPHA: return texA;
        case GR_COMBINE_FACTOR_TEXTURE_RGB: return texA; // LOD_FRACTION on alpha path; approximate
        case GR_COMBINE_FACTOR_ONE: return 1;
        case GR_COMBINE_FACTOR_ONE_MINUS_LOCAL: return 1 - lA;
        case GR_COMBINE_FACTOR_ONE_MINUS_OTHER_ALPHA: return 1 - oA;
        case GR_COMBINE_FACTOR_ONE_MINUS_LOCAL_ALPHA: return 1 - lA;
        case GR_COMBINE_FACTOR_ONE_MINUS_TEXTURE_ALPHA: return 1 - texA;
        case GR_COMBINE_FACTOR_ONE_MINUS_TEXTURE_RGB: return 1 - texA;
        default: return 0;
    }
}

function applyFunctionAlpha(fn: number, f: number, other: number, local: number): number {
    const fo = f * other;
    switch (fn) {
        case GR_COMBINE_FUNCTION_ZERO: return 0;
        case GR_COMBINE_FUNCTION_LOCAL: return local;
        case GR_COMBINE_FUNCTION_LOCAL_ALPHA: return local;
        case GR_COMBINE_FUNCTION_SCALE_OTHER: return fo;
        case GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL: return fo + local;
        case GR_COMBINE_FUNCTION_SCALE_OTHER_ADD_LOCAL_ALPHA: return fo + local;
        case GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL: return fo - local;
        case GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL: return f * (other - local) + local;
        case GR_COMBINE_FUNCTION_SCALE_OTHER_MINUS_LOCAL_ADD_LOCAL_ALPHA: return f * (other - local) + local;
        case GR_COMBINE_FUNCTION_SCALE_MINUS_LOCAL_ADD_LOCAL: return -f * local + local;
        case GR_COMBINE_FUNCTION_SCALE_MINUS_LOCAL_ADD_LOCAL_ALPHA: return -f * local + local;
        default: return 0;
    }
}

export function evalAlphaCombine(ac: CombineDescriptor, inp: CombineInputs): number {
    const lA = localAlpha(ac.local, inp);
    const oA = otherAlpha(ac.other, inp);
    const f = alphaFactor(ac.factor, lA, oA, inp.texture[3]);
    let out = clamp01(applyFunctionAlpha(ac.function, f, oA, lA));
    if (ac.invert) out = 1 - out;
    return out;
}

// ---------------------------------------------------------------------------
// GR_BLEND_* -> WebGPU GPUBlendFactor. The value 0x2 / 0x6 are aliased: as a
// SOURCE factor they mean DST_COLOR / ONE_MINUS_DST_COLOR; as a DEST factor
// they mean SRC_COLOR / ONE_MINUS_SRC_COLOR (the classic Glide quirk).
// ---------------------------------------------------------------------------

export function glideSrcFactorToGpu(f: number): GPUBlendFactor {
    switch (f & 0xf) {
        case GR_BLEND_ZERO: return "zero";
        case GR_BLEND_SRC_ALPHA: return "src-alpha";
        case GR_BLEND_SRC_COLOR: return "dst"; // DST_COLOR for the source slot
        case GR_BLEND_DST_ALPHA: return "dst-alpha";
        case GR_BLEND_ONE: return "one";
        case GR_BLEND_ONE_MINUS_SRC_ALPHA: return "one-minus-src-alpha";
        case GR_BLEND_ONE_MINUS_SRC_COLOR: return "one-minus-dst"; // ONE_MINUS_DST_COLOR for source
        case GR_BLEND_ONE_MINUS_DST_ALPHA: return "one-minus-dst-alpha";
        case GR_BLEND_ALPHA_SATURATE: return "src-alpha-saturated";
        default: return "one";
    }
}

export function glideDstFactorToGpu(f: number): GPUBlendFactor {
    switch (f & 0xf) {
        case GR_BLEND_ZERO: return "zero";
        case GR_BLEND_SRC_ALPHA: return "src-alpha";
        case GR_BLEND_SRC_COLOR: return "src"; // SRC_COLOR for the dest slot
        case GR_BLEND_DST_ALPHA: return "dst-alpha";
        case GR_BLEND_ONE: return "one";
        case GR_BLEND_ONE_MINUS_SRC_ALPHA: return "one-minus-src-alpha";
        case GR_BLEND_ONE_MINUS_SRC_COLOR: return "one-minus-src"; // ONE_MINUS_SRC_COLOR for dest
        case GR_BLEND_ONE_MINUS_DST_ALPHA: return "one-minus-dst-alpha";
        // GR_BLEND_PREFOG_COLOR (0xf) has no GPU equivalent; "one" is the closest no-crash fallback.
        case GR_BLEND_ALPHA_SATURATE: return "one";
        default: return "zero";
    }
}

// WebGPU forbids "src"/"dst" (full color) factors on the ALPHA blend component.
// For the alpha channel, a color factor degenerates to its alpha equivalent.
export function glideSrcFactorToGpuAlpha(f: number): GPUBlendFactor {
    switch (f & 0xf) {
        case GR_BLEND_SRC_COLOR: return "dst-alpha";
        case GR_BLEND_ONE_MINUS_SRC_COLOR: return "one-minus-dst-alpha";
        default: return glideSrcFactorToGpu(f);
    }
}

export function glideDstFactorToGpuAlpha(f: number): GPUBlendFactor {
    switch (f & 0xf) {
        case GR_BLEND_SRC_COLOR: return "src-alpha";
        case GR_BLEND_ONE_MINUS_SRC_COLOR: return "one-minus-src-alpha";
        case GR_BLEND_ALPHA_SATURATE: return "one";
        default: return glideDstFactorToGpu(f);
    }
}

// Opaque default = (src ONE, dst ZERO) for both rgb and alpha.
export function blendIsOpaque(rgbSf: number, rgbDf: number, alphaSf: number, alphaDf: number): boolean {
    return (
        (rgbSf & 0xf) === GR_BLEND_ONE && (rgbDf & 0xf) === GR_BLEND_ZERO &&
        (alphaSf & 0xf) === GR_BLEND_ONE && (alphaDf & 0xf) === GR_BLEND_ZERO
    );
}
