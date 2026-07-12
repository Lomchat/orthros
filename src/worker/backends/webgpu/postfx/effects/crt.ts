/**
 * crt — the "real template" example effect: barrel curvature + scanlines + RGB aperture
 * mask + edge vignette. Demonstrates sampling with a transformed UV and per-frame uniforms.
 */

import { PostEffect, PostFrameContext } from "../post-effect";
import { QualityConfig } from "../../../../core/quality-config";

// Private uniforms (binding 3): curvature, scanlineDepth, maskDepth, _pad.
const UNIFORM_SIZE = 16;

const FRAGMENT = /* wgsl */ `
struct CrtParams {
    curvature: f32,
    scanlineDepth: f32,
    maskDepth: f32,
    _pad: f32,
}
@group(0) @binding(3) var<uniform> crt: CrtParams;

fn curve(uv: vec2f, amount: f32) -> vec2f {
    var c = uv * 2.0 - 1.0;          // -1..1
    let off = abs(c.yx) / vec2f(3.0, 2.5);
    c = c + c * off * off * amount;
    return c * 0.5 + 0.5;            // back to 0..1
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
    let uv = curve(in.uv, crt.curvature);
    // Sample unconditionally at a clamped UV (keeps textureSample in uniform control flow),
    // then black out the curved-past-the-edge bezel afterwards.
    let uvc = clamp(uv, vec2f(0.0), vec2f(1.0));
    var rgb = textureSample(inputTex, inputSampler, uvc).rgb;
    let inBounds = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
    if (!inBounds) {
        rgb = vec3f(0.0);
    }

    // Scanlines.
    let line = uv.y * uCommon.resolution.y;
    let s = 0.5 + 0.5 * cos(line * 6.2831853);
    rgb = rgb * (1.0 - crt.scanlineDepth * (1.0 - s));

    // RGB aperture mask (every 3rd output column emphasises one channel).
    let col = u32(in.uv.x * uCommon.outputAspect * uCommon.resolution.y) % 3u;
    var mask = vec3f(1.0 - crt.maskDepth);
    if (col == 0u) { mask.r = 1.0; } else if (col == 1u) { mask.g = 1.0; } else { mask.b = 1.0; }
    rgb = rgb * mask;

    // Soft edge vignette.
    let d = uv - vec2f(0.5);
    rgb = rgb * (1.0 - smoothstep(0.4, 0.75, dot(d, d)) * 0.6);

    return vec4f(rgb, 1.0);
}
`;

export class CrtEffect implements PostEffect {
    readonly id = "crt";
    readonly uniformSize = UNIFORM_SIZE;

    enabled(q: QualityConfig): boolean {
        return q.crt;
    }

    /** Scanlines + aperture mask track the display resolution → must run at output res. */
    needsOutputRes(): boolean {
        return true;
    }

    fragmentSource(): string {
        return FRAGMENT;
    }

    writeUniforms(dv: DataView, _ctx: PostFrameContext): void {
        dv.setFloat32(0, 0.12, true);  // curvature
        dv.setFloat32(4, 0.35, true);  // scanlineDepth
        dv.setFloat32(8, 0.30, true);  // maskDepth
        dv.setFloat32(12, 0, true);
    }
}
