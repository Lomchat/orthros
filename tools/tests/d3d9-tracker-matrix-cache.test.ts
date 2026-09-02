import { describe, expect, test } from "bun:test";
import { D3D9StateTracker } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";

const D3DTS_VIEW = 2, D3DTS_PROJECTION = 3, D3DTS_TEXTURE0 = 16, D3DTS_WORLD = 0x100;

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

const same = (a: Float32Array, b: Float32Array) => Buffer.from(a.buffer, a.byteOffset, 64).equals(Buffer.from(b.buffer, b.byteOffset, 64));

describe("D3D9StateTracker matrix products", () => {
    test("MVP and worldView follow every transform change and only those", () => {
        const t = new D3D9StateTracker();
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        expect(same(t.getMVP(), identity)).toBe(true);
        expect(same(t.getWorldView(), identity)).toBe(true);

        let world = seeded(1), view = seeded(2), proj = seeded(3);
        t.setTransform(D3DTS_WORLD, world);
        t.setTransform(D3DTS_VIEW, view);
        t.setTransform(D3DTS_PROJECTION, proj);
        expect(same(t.getWorldView(), mul(world, view))).toBe(true);
        expect(same(t.getMVP(), mul(mul(world, view), proj))).toBe(true);

        // Per-object world change: the common case between two draws.
        const v0 = t.version, w0 = t.worldVersion;
        world = seeded(4);
        t.setTransform(D3DTS_WORLD, world);
        expect(t.worldVersion).toBe(w0 + 1);
        expect(t.version).toBe(v0);
        expect(same(t.getWorldView(), mul(world, view))).toBe(true);
        expect(same(t.getMVP(), mul(mul(world, view), proj))).toBe(true);

        // View change reaches both products and bumps the general version.
        view = seeded(5);
        t.setTransform(D3DTS_VIEW, view);
        expect(t.version).toBe(v0 + 1);
        expect(same(t.getWorldView(), mul(world, view))).toBe(true);
        expect(same(t.getMVP(), mul(mul(world, view), proj))).toBe(true);

        // Projection change reaches only the MVP.
        proj = seeded(6);
        const wv = t.getWorldView();
        t.setTransform(D3DTS_PROJECTION, proj);
        expect(t.getWorldView()).toBe(wv);
        expect(same(t.getMVP(), mul(mul(world, view), proj))).toBe(true);

        // A texture matrix touches neither product; the same buffers come back.
        const mvp = t.getMVP();
        t.setTransform(D3DTS_TEXTURE0 + 1, seeded(7));
        expect(t.getMVP()).toBe(mvp);
        expect(same(t.getMVP(), mul(mul(world, view), proj))).toBe(true);

        // Setting the same matrix again is a no-op for versions and products.
        const v1 = t.version, w1 = t.worldVersion;
        expect(t.setTransform(D3DTS_WORLD, world)).toBe(false);
        expect(t.version).toBe(v1);
        expect(t.worldVersion).toBe(w1);

        t.reset();
        expect(same(t.getMVP(), identity)).toBe(true);
        expect(same(t.getWorldView(), identity)).toBe(true);
    });

    test("only the state the fixed-function block reads invalidates it", () => {
        const t = new D3D9StateTracker();
        const v = () => t.version;
        let v0 = v();
        // Pipeline-key states: depth, blending, culling.
        expect(t.setRenderState(7, 1)).toBe(true);     // D3DRS_ZENABLE
        expect(t.setRenderState(27, 1)).toBe(true);    // D3DRS_ALPHABLENDENABLE
        expect(t.setRenderState(22, 2)).toBe(true);    // D3DRS_CULLMODE
        expect(v()).toBe(v0);
        // Block inputs.
        for (const rs of [29, 60, 134, 137, 139, 142, 145, 146, 147, 148, 152]) {
            v0 = v();
            expect(t.setRenderState(rs, 0x1234)).toBe(true);
            expect(v()).toBe(v0 + 1);
        }
        // Geometry sources feed the draw, not the block.
        v0 = v();
        t.setStreamSource(0, 0, 32);
        t.setIndexSource(5);
        t.clearStreamSource();
        expect(v()).toBe(v0);
        // FVF and bound textures are block inputs (normal presence, hasTexture).
        t.setFVF(0x112);
        expect(v()).toBe(v0 + 1);
        t.setTexture(0, 7);
        expect(v()).toBe(v0 + 2);
        // Another texture on the same stage: same block, different bind group.
        expect(t.setTexture(0, 9)).toBe(true);
        expect(v()).toBe(v0 + 2);
        expect(t.setTexture(0, null)).toBe(true);
        expect(v()).toBe(v0 + 3);
    });
});
