/**
 * Glide fragment pipeline -> WGSL.
 *
 * Implements the Glide color/alpha combine unit, fog, alpha test (GR_CMP_*), and
 * chroma-key. The combine algebra mirrors glide-combine.ts (evalColorCombine /
 * evalAlphaCombine) arm-for-arm; that TS reference is unit-tested. Combine/fog/
 * alpha-test/chroma are all uniform-driven, so the only shader-structural variant
 * is whether a texture is bound.
 */

export interface GlideShaderConfig {
    useTexture: boolean;
}

export function generateGlideShader(config: GlideShaderConfig): string {
    const textureBindings = config.useTexture
        ? `
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;`
        : "";

    const textureSample = config.useTexture
        ? `var texColor = textureSample(tex, texSampler, texUv);
    // TMU gamma correction (grGammaCorrectionValue / hwcGammaRGB): pow per channel.
    texColor = vec4f(pow(max(texColor.rgb, vec3f(0.0)), vec3f(uniforms.gammaCorrection)), texColor.a);
    // TMU chroma-key rejects matching texels before the combine unit (gglide.c / chromaKey reg).
    if (uniforms.chromaEnabled != 0u) {
        if (distance(texColor.rgb, uniforms.chromaKey.rgb) < (1.0 / 255.0)) {
            discard;
        }
    }`
        : "let texColor = vec4f(1.0, 1.0, 1.0, 1.0);";

    return `
struct Globals {
    resolution: vec2f,
    alphaRef: f32,
    alphaTestFunc: u32,
    constantColor: vec4f,
    chromaKey: vec4f,
    texCoordScale: vec2f,
    chromaEnabled: u32,
    fogMode: u32,
    fogColor: vec4f,
    colorCombine: u32,
    alphaCombine: u32,
    gammaCorrection: f32,
    _pad0: u32,
    fogTable: array<vec4f, 16>,
};

struct VsInput {
    @location(0) position: vec3f,
    @location(1) uv: vec2f,
    @location(2) oow: f32,
    @location(3) color: vec4f,
};

struct VsOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) oow: f32,
    @location(2) color: vec4f,
};

@group(0) @binding(0) var<uniform> uniforms: Globals;
${textureBindings}

@vertex
fn vs_main(input: VsInput) -> VsOutput {
    var out: VsOutput;
    let x = (input.position.x / max(uniforms.resolution.x, 1.0)) * 2.0 - 1.0;
    let y = 1.0 - (input.position.y / max(uniforms.resolution.y, 1.0)) * 2.0;
    let z = clamp(input.position.z, 0.0, 1.0);
    out.position = vec4f(x, y, z, 1.0);
    out.uv = input.uv;
    out.oow = input.oow;
    out.color = input.color;
    return out;
}

// ---- Combine descriptor unpacking (matches packCombine in glide-combine.ts) ----
fn cmbFunc(p: u32) -> u32 { return p & 0x1fu; }
fn cmbFactor(p: u32) -> u32 { return (p >> 5u) & 0xfu; }
fn cmbLocal(p: u32) -> u32 { return (p >> 9u) & 0x3u; }
fn cmbOther(p: u32) -> u32 { return (p >> 11u) & 0x3u; }
fn cmbInvert(p: u32) -> u32 { return (p >> 13u) & 0x1u; }

// local / other source selection (GR_COMBINE_LOCAL_*/OTHER_*)
fn selLocalRgb(local: u32, iter: vec4f, cc: vec4f) -> vec3f {
    if (local == 0u) { return iter.rgb; } // ITERATED
    return cc.rgb;                          // CONSTANT / NONE / DEPTH
}
fn selLocalAlpha(local: u32, iter: vec4f, cc: vec4f) -> f32 {
    if (local == 0u) { return iter.a; }
    return cc.a;
}
fn selOtherRgb(other: u32, iter: vec4f, texc: vec4f, cc: vec4f) -> vec3f {
    if (other == 0u) { return iter.rgb; }   // ITERATED
    if (other == 1u) { return texc.rgb; }    // TEXTURE
    return cc.rgb;                            // CONSTANT / NONE
}
fn selOtherAlpha(other: u32, iter: vec4f, texc: vec4f, cc: vec4f) -> f32 {
    if (other == 0u) { return iter.a; }
    if (other == 1u) { return texc.a; }
    return cc.a;
}

// GR_COMBINE_FACTOR_* -> per-channel vec3 scale
fn colorFactor(factor: u32, lRgb: vec3f, lA: f32, oA: f32, texc: vec4f) -> vec3f {
    switch (factor) {
        case 0u: { return vec3f(0.0); }                 // ZERO
        case 1u: { return lRgb; }                        // LOCAL
        case 2u: { return vec3f(oA); }                   // OTHER_ALPHA
        case 3u: { return vec3f(lA); }                   // LOCAL_ALPHA
        case 4u: { return vec3f(texc.a); }               // TEXTURE_ALPHA
        case 5u: { return texc.rgb; }                    // TEXTURE_RGB
        case 8u: { return vec3f(1.0); }                  // ONE
        case 9u: { return vec3f(1.0) - lRgb; }           // ONE_MINUS_LOCAL
        case 10u: { return vec3f(1.0 - oA); }            // ONE_MINUS_OTHER_ALPHA
        case 11u: { return vec3f(1.0 - lA); }            // ONE_MINUS_LOCAL_ALPHA
        case 12u: { return vec3f(1.0 - texc.a); }        // ONE_MINUS_TEXTURE_ALPHA
        case 13u: { return vec3f(1.0) - texc.rgb; }      // ONE_MINUS_TEXTURE_RGB
        default: { return vec3f(0.0); }
    }
}

fn applyFuncRgb(fn_: u32, f: vec3f, other: vec3f, local: vec3f, localA: f32) -> vec3f {
    let fo = f * other;
    switch (fn_) {
        case 0u: { return vec3f(0.0); }                          // ZERO
        case 1u: { return local; }                                // LOCAL
        case 2u: { return vec3f(localA); }                        // LOCAL_ALPHA
        case 3u: { return fo; }                                   // SCALE_OTHER
        case 4u: { return fo + local; }                           // SCALE_OTHER_ADD_LOCAL
        case 5u: { return fo + vec3f(localA); }                   // SCALE_OTHER_ADD_LOCAL_ALPHA
        case 6u: { return fo - local; }                           // SCALE_OTHER_MINUS_LOCAL
        case 7u: { return f * (other - local) + local; }          // ..._MINUS_LOCAL_ADD_LOCAL (BLEND)
        case 8u: { return f * (other - local) + vec3f(localA); }  // ..._MINUS_LOCAL_ADD_LOCAL_ALPHA
        case 9u: { return -f * local + local; }                   // SCALE_MINUS_LOCAL_ADD_LOCAL
        case 16u: { return -f * local + vec3f(localA); }          // SCALE_MINUS_LOCAL_ADD_LOCAL_ALPHA
        default: { return vec3f(0.0); }
    }
}

fn evalColorCombine(p: u32, texc: vec4f, iter: vec4f, cc: vec4f) -> vec3f {
    let lRgb = selLocalRgb(cmbLocal(p), iter, cc);
    let lA = selLocalAlpha(cmbLocal(p), iter, cc);
    let oRgb = selOtherRgb(cmbOther(p), iter, texc, cc);
    let oA = selOtherAlpha(cmbOther(p), iter, texc, cc);
    let f = colorFactor(cmbFactor(p), lRgb, lA, oA, texc);
    var outc = clamp(applyFuncRgb(cmbFunc(p), f, oRgb, lRgb, lA), vec3f(0.0), vec3f(1.0));
    if (cmbInvert(p) == 1u) { outc = vec3f(1.0) - outc; }
    return outc;
}

fn alphaFactor(factor: u32, lA: f32, oA: f32, texA: f32) -> f32 {
    switch (factor) {
        case 0u: { return 0.0; }
        case 1u: { return lA; }
        case 2u: { return oA; }
        case 3u: { return lA; }
        case 4u: { return texA; }
        case 5u: { return texA; }
        case 8u: { return 1.0; }
        case 9u: { return 1.0 - lA; }
        case 10u: { return 1.0 - oA; }
        case 11u: { return 1.0 - lA; }
        case 12u: { return 1.0 - texA; }
        case 13u: { return 1.0 - texA; }
        default: { return 0.0; }
    }
}

fn applyFuncAlpha(fn_: u32, f: f32, other: f32, local: f32) -> f32 {
    let fo = f * other;
    switch (fn_) {
        case 0u: { return 0.0; }
        case 1u: { return local; }
        case 2u: { return local; }
        case 3u: { return fo; }
        case 4u: { return fo + local; }
        case 5u: { return fo + local; }
        case 6u: { return fo - local; }
        case 7u: { return f * (other - local) + local; }
        case 8u: { return f * (other - local) + local; }
        case 9u: { return -f * local + local; }
        case 16u: { return -f * local + local; }
        default: { return 0.0; }
    }
}

fn evalAlphaCombine(p: u32, texc: vec4f, iter: vec4f, cc: vec4f) -> f32 {
    let lA = selLocalAlpha(cmbLocal(p), iter, cc);
    let oA = selOtherAlpha(cmbOther(p), iter, texc, cc);
    let f = alphaFactor(cmbFactor(p), lA, oA, texc.a);
    var outa = clamp(applyFuncAlpha(cmbFunc(p), f, oA, lA), 0.0, 1.0);
    if (cmbInvert(p) == 1u) { outa = 1.0 - outa; }
    return outa;
}

// Maps eye-space w to a fractional fog-table index (exact inverse of the 3dfx
// guFogTableIndexToW: idxToW(i) = 2^(3 + i/4) / (8 - i%4)).
fn fogIndexFromW(w: f32) -> f32 {
    let cw = clamp(w, 1.0, 65535.0);
    let e = clamp(floor(log2(cw)), 0.0, 15.0);
    let r = cw / exp2(e);              // [1, 2)
    let mf = clamp(8.0 - 8.0 / r, 0.0, 3.9999); // == m at table points
    return clamp(4.0 * e + mf, 0.0, 63.0);
}

fn fogTableLookup(fidx: f32) -> f32 {
    let c = clamp(fidx, 0.0, 63.0);
    let i0 = u32(floor(c));
    let i1 = min(i0 + 1u, 63u);
    let frac = c - floor(c);
    let v0 = uniforms.fogTable[i0 >> 2u][i0 & 3u];
    let v1 = uniforms.fogTable[i1 >> 2u][i1 & 3u];
    return mix(v0, v1, frac);
}

// GR_CMP_* alpha test: returns true when the fragment should be KEPT.
fn alphaTestPass(a: f32, refV: f32, fn_: u32) -> bool {
    switch (fn_) {
        case 0u: { return false; }       // NEVER
        case 1u: { return a < refV; }    // LESS
        case 2u: { return a == refV; }   // EQUAL
        case 3u: { return a <= refV; }   // LEQUAL
        case 4u: { return a > refV; }    // GREATER
        case 5u: { return a != refV; }   // NOTEQUAL
        case 6u: { return a >= refV; }   // GEQUAL
        default: { return true; }        // ALWAYS
    }
}

@fragment
fn fs_main(in: VsOutput) -> @location(0) vec4f {
    let safeOow = max(abs(in.oow), 1.0e-8);
    let texUv = (in.uv / safeOow) * uniforms.texCoordScale;
    ${textureSample}

    let iter = in.color;
    let cc = uniforms.constantColor;

    var rgb = evalColorCombine(uniforms.colorCombine, texColor, iter, cc);
    let a = evalAlphaCombine(uniforms.alphaCombine, texColor, iter, cc);

    // Alpha test against the combined alpha (alphaRef is 0..255).
    if (!alphaTestPass(a * 255.0, uniforms.alphaRef, uniforms.alphaTestFunc)) {
        discard;
    }

    // Fog blends the post-combine RGB toward the fog color.
    let fogSel = uniforms.fogMode & 0x7u;
    if (fogSel != 0u) {
        var fogFactor = 0.0;
        if (fogSel == 1u) {
            fogFactor = clamp(iter.a, 0.0, 1.0);             // GR_FOG_WITH_ITERATED_ALPHA
        } else {
            let w = 1.0 / safeOow;                            // table / iterated-Z modes
            fogFactor = clamp(fogTableLookup(fogIndexFromW(w)), 0.0, 1.0);
        }
        rgb = mix(rgb, uniforms.fogColor.rgb, fogFactor);
    }

    return vec4f(rgb, a);
}
`;
}
