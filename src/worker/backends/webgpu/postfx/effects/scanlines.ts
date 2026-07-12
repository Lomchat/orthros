/**
 * scanlines — the MINIMAL "hello world" example effect. Copy this file to author a
 * new effect. No private uniforms; uses only the standard bind group (uCommon.resolution).
 */

import { PostEffect } from "../post-effect";
import { QualityConfig } from "../../../../core/quality-config";

const FRAGMENT = /* wgsl */ `
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
    var c = textureSample(inputTex, inputSampler, in.uv);
    // One dark band per source scanline.
    let line = in.uv.y * uCommon.resolution.y;
    let s = 0.5 + 0.5 * cos(line * 6.2831853);
    c = vec4f(c.rgb * mix(0.65, 1.0, s), c.a);
    return c;
}
`;

export class ScanlinesEffect implements PostEffect {
    readonly id = "scanlines";
    readonly uniformSize = 0;

    enabled(q: QualityConfig): boolean {
        return q.scanlines;
    }

    /** Scanline count tracks the display resolution → must run at output res. */
    needsOutputRes(): boolean {
        return true;
    }

    fragmentSource(): string {
        return FRAGMENT;
    }
}
