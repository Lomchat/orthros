import { describe, expect, test } from "bun:test";
import {
    D3DLIGHT_POINT,
    D3DLIGHT_DIRECTIONAL,
    FFP_UNIFORM_FLOATS,
    packFfpUniforms,
    patchFfpWorldMatrices,
    type FfpUniformParams,
} from "../../src/worker/backends/webgpu/d3d9/ffp-lighting";

// Row-major D3D product a × b.
function mul(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        out[r * 4 + c] = s;
    }
    return out;
}

function seeded(seed: number): Float32Array {
    const m = new Float32Array(16);
    let x = seed >>> 0;
    for (let i = 0; i < 16; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        m[i] = ((x >>> 8) & 0xffff) / 4096 - 8;
    }
    return m;
}

const color = (r: number, g: number, b: number, a: number) => ({ r, g, b, a });

function params(world: Float32Array, view: Float32Array, proj: Float32Array): FfpUniformParams {
    const worldView = mul(world, view);
    return {
        viewportW: 800,
        viewportH: 600,
        mvp: mul(worldView, proj),
        worldView,
        view,
        world,
        clipPlanes: new Float32Array([...seeded(77), ...seeded(78).subarray(0, 8)]),
        clipPlaneEnable: 0b101,
        stages: [0, 1, 2, 3].map((i) => ({
            colorOp: 4 + i, alphaOp: 2, colorArg1: 2, colorArg2: 0, alphaArg1: 2, alphaArg2: 1,
            texCoordIndex: i, hasTexture: i < 2, transformFlags: i === 1 ? 2 : 0,
            textureMatrix: seeded(100 + i),
        })),
        textureFactor: color(0.1, 0.2, 0.3, 0.4),
        material: {
            diffuse: color(1, 0.5, 0.25, 1), ambient: color(0.2, 0.2, 0.2, 1),
            specular: color(0.9, 0.9, 0.8, 1), emissive: color(0, 0.1, 0, 1), power: 16,
        },
        globalAmbient: color(0.3, 0.3, 0.35, 1),
        lightingEnabled: true,
        specularEnable: true,
        localViewer: false,
        diffuseSrc: 1, ambientSrc: 0, specularSrc: 0, emissiveSrc: 0,
        hasNormal: true,
        lights: [
            { type: D3DLIGHT_DIRECTIONAL, diffuse: color(1, 1, 1, 1), specular: color(1, 1, 1, 1), ambient: color(0, 0, 0, 1),
              position: [0, 0, 0], direction: [0.3, -1, 0.2], range: 0, falloff: 0, att0: 1, att1: 0, att2: 0, theta: 0, phi: 0 },
            { type: D3DLIGHT_POINT, diffuse: color(1, 0.8, 0.6, 1), specular: color(0.5, 0.5, 0.5, 1), ambient: color(0, 0, 0, 1),
              position: [12, 3, -7], direction: [0, 0, 1], range: 100, falloff: 1, att0: 1, att1: 0.01, att2: 0.001, theta: 0.5, phi: 1 },
        ],
    };
}

describe("patchFfpWorldMatrices", () => {
    test("patching the world-dependent slots reproduces a full repack, bit for bit", () => {
        const view = seeded(1), proj = seeded(2);
        const p1 = params(seeded(10), view, proj);
        const p2 = params(seeded(11), view, proj);

        const full1 = new Float32Array(FFP_UNIFORM_FLOATS);
        const full2 = new Float32Array(FFP_UNIFORM_FLOATS);
        packFfpUniforms(full1, p1);
        packFfpUniforms(full2, p2);
        // The two worlds differ, so the blocks must differ before the patch.
        expect(Buffer.from(full1.buffer).equals(Buffer.from(full2.buffer))).toBe(false);

        const patched = full1.slice();
        patchFfpWorldMatrices(patched, p2.mvp, p2.worldView, p2.world);
        expect(Buffer.from(patched.buffer).equals(Buffer.from(full2.buffer))).toBe(true);

        // And back: the patch is a pure function of the three matrices.
        patchFfpWorldMatrices(patched, p1.mvp, p1.worldView, p1.world);
        expect(Buffer.from(patched.buffer).equals(Buffer.from(full1.buffer))).toBe(true);
    });

    test("a view change is not covered by the patch (lights live in view space)", () => {
        const proj = seeded(2);
        const p1 = params(seeded(10), seeded(1), proj);
        const p2 = params(seeded(10), seeded(3), proj);
        const full1 = new Float32Array(FFP_UNIFORM_FLOATS);
        const full2 = new Float32Array(FFP_UNIFORM_FLOATS);
        packFfpUniforms(full1, p1);
        packFfpUniforms(full2, p2);
        const patched = full1.slice();
        patchFfpWorldMatrices(patched, p2.mvp, p2.worldView, p2.world);
        // Documents why the device only takes the patch path for a world-only change.
        expect(Buffer.from(patched.buffer).equals(Buffer.from(full2.buffer))).toBe(false);
    });
});
