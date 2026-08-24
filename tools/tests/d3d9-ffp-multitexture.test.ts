import { describe, expect, test } from "bun:test";
import {
    FFP_MAX_TEXTURE_STAGES,
    FFP_UNIFORM_FLOATS,
    FFP_UNIFORM_STRUCT_WGSL,
    packFfpUniforms,
    type FfpUniformParams,
} from "../../src/worker/backends/webgpu/d3d9/ffp-lighting";

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const white = { r: 1, g: 1, b: 1, a: 1 };

function params(): FfpUniformParams {
    return {
        viewportW: 800, viewportH: 600,
        mvp: identity, worldView: identity, view: identity, world: identity,
        clipPlanes: new Float32Array(24), clipPlaneEnable: 0,
        stages: Array.from({ length: FFP_MAX_TEXTURE_STAGES }, (_, stage) => ({
            colorOp: stage === 0 ? 5 : stage === 1 ? 13 : 1,
            alphaOp: 2,
            colorArg1: 2,
            colorArg2: stage === 0 ? 0 : 1,
            alphaArg1: 2,
            alphaArg2: 1,
            texCoordIndex: stage === 1 ? 0x20000 : stage,
            hasTexture: stage < 2,
            transformFlags: stage === 1 ? 2 : 0,
            textureMatrix: identity,
        })),
        textureFactor: white,
        material: { diffuse: white, ambient: white, specular: white, emissive: white, power: 1 },
        globalAmbient: white,
        lightingEnabled: false, specularEnable: false, localViewer: false,
        diffuseSrc: 0, ambientSrc: 0, specularSrc: 0, emissiveSrc: 0,
        hasNormal: true, lights: [],
    };
}

describe("D3D9 FFP multi-texture uniforms", () => {
    test("packs four independent stages at the WGSL-aligned offsets", () => {
        const out = new Float32Array(FFP_UNIFORM_FLOATS);
        packFfpUniforms(out, params());

        // Header/lights/world/planes end at float 332. Ops occupy 332..347,
        // args/tci/packed flags occupy 348..363, followed by four matrices and tfactor.
        expect(out.length).toBe(432);
        expect(Array.from(out.slice(332, 340))).toEqual([5, 2, 2, 0, 13, 2, 2, 1]);
        expect(Array.from(out.slice(348, 356))).toEqual([2, 1, 0, 512, 2, 1, 0x20000, 514]);
        expect(Array.from(out.slice(428, 432))).toEqual([1, 1, 1, 1]);
    });

    test("WGSL contract exposes the same four-stage arrays", () => {
        expect(FFP_UNIFORM_STRUCT_WGSL).toContain("stageOps: array<vec4<f32>, 4>");
        expect(FFP_UNIFORM_STRUCT_WGSL).toContain("stageArgs: array<vec4<f32>, 4>");
        expect(FFP_UNIFORM_STRUCT_WGSL).toContain("textureMatrices: array<mat4x4<f32>, 4>");
    });
});
