/**
 * PostFX contract — the tiny, stable interface a contributor implements to add a
 * present-time post-process effect (CRT, scanlines, LUT grade, vignette, …).
 *
 * Add an effect by dropping ONE file in effects/ + registering it in registry.ts.
 * You never touch presenter.ts / webgpu-backend.ts / the per-API backends.
 */

import { QualityConfig } from "../../../core/quality-config";

/**
 * Read-only per-frame context handed to every effect. `time`/`frame` come from the
 * chain (a monotonic frame counter) — NOT Date.now()/Math.random(), which are banned
 * in the worker hot path.
 */
export interface PostFrameContext {
    /** Pixel size of the pass input (binding 0) the effect samples. */
    resolution: { width: number; height: number };
    /** Final output (canvas) pixel size. */
    outputSize: { width: number; height: number };
    /** Monotonic seconds since chain start. */
    time: number;
    /** Monotonic frame counter. */
    frame: number;
    /** Effective quality config for this frame. */
    quality: QualityConfig;
    /** Current gamma LUT: 768 normalized floats [R0..R255,G0..G255,B0..B255], or null = identity. */
    gammaLut: Float32Array | null;
    /** outputSize.width / outputSize.height. */
    outputAspect: number;
}

/**
 * A single post-process pass.
 *
 * The chain provides the STANDARD bind group + a standard vertex shader, so the author
 * writes only the WGSL fragment math (+ optional per-frame uniforms). Available in WGSL
 * (injected by the chain before your fragmentSource via POSTFX_WGSL_PRELUDE):
 *
 *   struct VSOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
 *   @group(0) @binding(0) var inputTex: texture_2d<f32>;     // previous pass / source frame
 *   @group(0) @binding(1) var inputSampler: sampler;          // linear, clamp-to-edge
 *   @group(0) @binding(2) var<uniform> uCommon: CommonUniforms; // resolution/texel/time/frame/outputAspect
 *      ('common' is a WGSL reserved keyword — the var is named uCommon)
 *
 * If `uniformSize > 0`, ALSO declare your private block yourself:
 *   @group(0) @binding(3) var<uniform> params: MyParams;
 *
 * Your fragment entry point MUST be: `fn fs_main(in: VSOut) -> @location(0) vec4f`.
 */
export interface PostEffect {
    /** Stable id ('color-grade', 'scanlines', 'crt', …). Also the pipeline-cache key. */
    readonly id: string;
    /** Is this effect active for the current quality config? (cheap, called every frame) */
    enabled(q: QualityConfig): boolean;
    /** WGSL fragment shader source (without the prelude — the chain prepends it). */
    fragmentSource(): string;
    /** Bytes of effect-private uniforms (binding 3). 0 = none. Rounded up to 16 by the chain. */
    readonly uniformSize: number;
    /** Fill per-frame private uniforms (only called when uniformSize > 0). */
    writeUniforms?(dv: DataView, ctx: PostFrameContext): void;
    /**
     * Does this effect need to run at OUTPUT (display content) resolution rather than the
     * guest source resolution? True for resolution-dependent effects (scanlines/CRT) and
     * neighbor-tap effects (FXAA) — they look wrong if run at source res and then upscaled.
     * When any active effect returns true, the chain first upscales the source to the
     * display content size and runs the whole chain there. Default: false (cheap, source-res).
     */
    needsOutputRes?(q: QualityConfig): boolean;
}

/** CommonUniforms (binding 2) std140 size, written by the chain. */
export const COMMON_UNIFORM_SIZE = 32;

/** Standard vertex shader + shared declarations prepended to every effect's fragmentSource(). */
export const POSTFX_WGSL_PRELUDE = `
struct VSOut {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs_main(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VSOut {
    var out: VSOut;
    out.position = vec4f(pos, 0.0, 1.0);
    out.uv = uv;
    return out;
}

struct CommonUniforms {
    resolution: vec2f,   // working-pass pixel size
    texel: vec2f,        // 1.0 / resolution
    time: f32,           // monotonic seconds
    frame: f32,          // frame counter
    outputAspect: f32,   // output width / height
    _pad0: f32,
}

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
// NOTE: 'common' is a RESERVED keyword in WGSL — the uniform var MUST NOT be named 'common'
// (a parse error there makes EVERY postfx shader, incl. passthrough, an invalid pipeline → black present).
@group(0) @binding(2) var<uniform> uCommon: CommonUniforms;
`;

/** Write the CommonUniforms block (32 bytes) at `byteOffset` in `dv`. */
export function writeCommonUniforms(dv: DataView, byteOffset: number, ctx: PostFrameContext): void {
    const w = Math.max(1, ctx.resolution.width);
    const h = Math.max(1, ctx.resolution.height);
    dv.setFloat32(byteOffset + 0, w, true);
    dv.setFloat32(byteOffset + 4, h, true);
    dv.setFloat32(byteOffset + 8, 1 / w, true);
    dv.setFloat32(byteOffset + 12, 1 / h, true);
    dv.setFloat32(byteOffset + 16, ctx.time, true);
    dv.setFloat32(byteOffset + 20, ctx.frame, true);
    dv.setFloat32(byteOffset + 24, ctx.outputAspect, true);
    dv.setFloat32(byteOffset + 28, 0, true);
}
