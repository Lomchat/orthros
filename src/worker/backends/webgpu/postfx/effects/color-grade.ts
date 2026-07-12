/**
 * color-grade — the BUILT-IN consolidated present effect.
 *
 * One pass folds: game gamma ramp (LUT) ⊕ user brightness/contrast/saturation
 * ⊕ optional FXAA ⊕ optional filmic tonemap ⊕ optional vignette. This uber-shader is
 * kept as ONE effect so the common case stays a single pass. When this effect is the
 * only active one (the default), the chain runs exactly one present pass, byte-identical
 * to the pre-feature path once the uniforms are neutral.
 *
 * Shader order: sample → FXAA → tonemap → gamma LUT → brightness/contrast/sat → vignette.
 */

import { PostEffect, PostFrameContext } from "../post-effect";
import { QualityConfig, colorGradeActive } from "../../../../core/quality-config";

// Private uniform layout (binding 3):
//   f32 brightness, contrast, saturation, fxaa      (offset 0,  16 bytes)
//   f32 tonemap, vignette, gammaEnabled, _pad       (offset 16, 16 bytes)
//   array<vec4f,192> lut                            (offset 32, 3072 bytes)  -> 768 floats, tightly packed
const PARAMS_HEADER_SIZE = 32;
const LUT_FLOAT_COUNT = 768;
const UNIFORM_SIZE = PARAMS_HEADER_SIZE + LUT_FLOAT_COUNT * 4; // 3104

const FRAGMENT = /* wgsl */ `
struct CGParams {
    brightness: f32,
    contrast: f32,
    saturation: f32,
    fxaa: f32,
    tonemap: f32,
    vignette: f32,
    gammaEnabled: f32,
    _pad: f32,
    lut: array<vec4f, 192>,
}
@group(0) @binding(3) var<uniform> params: CGParams;

fn luma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// Explicit-LOD sample. WGSL forbids textureSample() (implicit derivatives) in non-uniform
// control flow — fxaa() samples after a conditional early-return, which is exactly that case.
// textureSampleLevel needs no derivatives and is legal anywhere; the present source is mip-less
// so LOD 0 is identical to the implicit-LOD result.
fn tex(uv: vec2f) -> vec4f {
    return textureSampleLevel(inputTex, inputSampler, uv, 0.0);
}

// Cheap FXAA: luma-edge-aware diagonal blend (FXAA3-lite). Works on everything incl. 2D.
fn fxaa(uv: vec2f) -> vec3f {
    let t = uCommon.texel;
    let m  = tex(uv).rgb;
    let nw = tex(uv + vec2f(-t.x, -t.y)).rgb;
    let ne = tex(uv + vec2f( t.x, -t.y)).rgb;
    let sw = tex(uv + vec2f(-t.x,  t.y)).rgb;
    let se = tex(uv + vec2f( t.x,  t.y)).rgb;
    let lM = luma(m); let lNW = luma(nw); let lNE = luma(ne); let lSW = luma(sw); let lSE = luma(se);
    let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    let range = lMax - lMin;
    if (range < 0.05) { return m; }                 // flat area: no AA
    var dir = vec2f(
        -((lNW + lNE) - (lSW + lSE)),
        ((lNW + lSW) - (lNE + lSE))
    );
    let dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    let rcpDir = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDir, vec2f(-8.0), vec2f(8.0)) * t;
    let a = 0.5 * (tex(uv + dir * (1.0/3.0 - 0.5)).rgb
                 + tex(uv + dir * (2.0/3.0 - 0.5)).rgb);
    let b = a * 0.5 + 0.25 * (tex(uv + dir * -0.5).rgb
                            + tex(uv + dir *  0.5).rgb);
    let lB = luma(b);
    if (lB < lMin || lB > lMax) { return a; }
    return b;
}

// ACES filmic approximation (Narkowicz).
fn aces(x: vec3f) -> vec3f {
    let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn gammaLookup(c: vec3f) -> vec3f {
    let ri = min(u32(c.r * 255.0 + 0.5), 255u);
    let gi = min(u32(c.g * 255.0 + 0.5), 255u);
    let bi = min(u32(c.b * 255.0 + 0.5), 255u);
    let r = params.lut[ri / 4u][ri % 4u];
    let g = params.lut[64u + gi / 4u][gi % 4u];
    let b = params.lut[128u + bi / 4u][bi % 4u];
    return vec3f(r, g, b);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
    let src = tex(in.uv);
    var rgb = src.rgb;

    if (params.fxaa > 0.5) {
        rgb = fxaa(in.uv);
    }
    if (params.tonemap > 0.5) {
        rgb = aces(rgb);
    }
    if (params.gammaEnabled > 0.5) {
        rgb = gammaLookup(rgb);
    }

    // brightness (multiply) → contrast (around mid-grey) → saturation (toward luma)
    rgb = rgb * params.brightness;
    rgb = (rgb - vec3f(0.5)) * params.contrast + vec3f(0.5);
    let l = luma(rgb);
    rgb = mix(vec3f(l), rgb, params.saturation);

    if (params.vignette > 0.0) {
        let d = in.uv - vec2f(0.5);
        // aspect-correct radial falloff
        let dd = vec2f(d.x * uCommon.outputAspect, d.y);
        let v = 1.0 - params.vignette * smoothstep(0.25, 0.75, dot(dd, dd));
        rgb = rgb * v;
    }

    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), src.a);
}
`;

export class ColorGradeEffect implements PostEffect {
    readonly id = "color-grade";
    readonly uniformSize = UNIFORM_SIZE;

    /**
     * color-grade is active when there's color work to do OR a gamma ramp is present.
     * Gamma presence is encoded into the quality view by the chain (see note below) —
     * here we cover the user-color side; the chain additionally forces this effect on
     * when a gamma LUT exists.
     */
    enabled(q: QualityConfig): boolean {
        return colorGradeActive(q);
    }

    /** FXAA needs real output-res neighbors; the per-pixel grade does not. */
    needsOutputRes(q: QualityConfig): boolean {
        return q.postAA === "fxaa";
    }

    fragmentSource(): string {
        return FRAGMENT;
    }

    writeUniforms(dv: DataView, ctx: PostFrameContext): void {
        const q = ctx.quality;
        dv.setFloat32(0, q.brightness, true);
        dv.setFloat32(4, q.contrast, true);
        dv.setFloat32(8, q.saturation, true);
        dv.setFloat32(12, q.postAA === "fxaa" ? 1 : 0, true);
        dv.setFloat32(16, q.tonemap === "aces" ? 1 : 0, true);
        dv.setFloat32(20, q.vignette, true);
        dv.setFloat32(24, ctx.gammaLut ? 1 : 0, true);
        dv.setFloat32(28, 0, true);
        if (ctx.gammaLut) {
            const lut = ctx.gammaLut;
            const n = Math.min(LUT_FLOAT_COUNT, lut.length);
            for (let i = 0; i < n; i++) {
                dv.setFloat32(PARAMS_HEADER_SIZE + i * 4, lut[i], true);
            }
        }
    }
}
