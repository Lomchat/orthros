import { describe, expect, test } from "bun:test";
import {
    buildColorTargetState, computeBlendKey,
    D3DRS_SRCBLEND, D3DRS_DESTBLEND, D3DRS_ALPHABLENDENABLE, D3DRS_BLENDOP,
    D3DRS_COLORWRITEENABLE, D3DRS_SEPARATEALPHABLENDENABLE,
    D3DRS_SRCBLENDALPHA, D3DRS_DESTBLENDALPHA, D3DRS_BLENDOPALPHA,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-blend";

// D3D9 default render states the state tracker seeds (see d3d9-state-tracker
// seedRenderStateDefaults). The blend helpers read raw render states, so tests
// start from these defaults and override per case.
function defaults(): Record<number, number> {
    return {
        [D3DRS_SRCBLEND]: 2,        // D3DBLEND_ONE
        [D3DRS_DESTBLEND]: 1,       // D3DBLEND_ZERO
        [D3DRS_BLENDOP]: 1,         // D3DBLENDOP_ADD
        [D3DRS_SRCBLENDALPHA]: 2,   // D3DBLEND_ONE
        [D3DRS_DESTBLENDALPHA]: 1,  // D3DBLEND_ZERO
        [D3DRS_BLENDOPALPHA]: 1,    // D3DBLENDOP_ADD
        [D3DRS_COLORWRITEENABLE]: 0xf,
        [D3DRS_ALPHABLENDENABLE]: 0,
        [D3DRS_SEPARATEALPHABLENDENABLE]: 0,
    };
}
const get = (m: Record<number, number>) => (state: number) => m[state] ?? 0;
const FMT: GPUTextureFormat = "bgra8unorm";

describe("buildColorTargetState — blend disabled (default)", () => {
    test("no blend object, full write mask", () => {
        const t = buildColorTargetState(FMT, get(defaults()));
        expect(t.blend).toBeUndefined();
        expect(t.writeMask).toBe(0xf);
        expect(t.format).toBe(FMT);
    });

    test("COLORWRITEENABLE=0 disables all channel writes (z/stencil-only pass)", () => {
        const m = defaults(); m[D3DRS_COLORWRITEENABLE] = 0;
        expect(buildColorTargetState(FMT, get(m)).writeMask).toBe(0);
    });
});

describe("buildColorTargetState — standard alpha blend", () => {
    test("SRCALPHA / INVSRCALPHA + ADD (the classic transparency setup)", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 5;   // D3DBLEND_SRCALPHA
        m[D3DRS_DESTBLEND] = 6;  // D3DBLEND_INVSRCALPHA
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color).toEqual({ srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" });
        // Without separate-alpha, the alpha op mirrors the colour op.
        expect(blend.alpha).toEqual({ srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" });
    });

    test("additive (ONE / ONE)", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 2; m[D3DRS_DESTBLEND] = 2; // ONE / ONE
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color.srcFactor).toBe("one");
        expect(blend.color.dstFactor).toBe("one");
    });

    test("REVSUBTRACT blend op maps", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1; m[D3DRS_BLENDOP] = 3; // REVSUBTRACT
        expect(buildColorTargetState(FMT, get(m)).blend!.color.operation).toBe("reverse-subtract");
    });
});

describe("buildColorTargetState — DirectX-6 BOTH*SRCALPHA fixup", () => {
    test("BOTHSRCALPHA as src forces dst = INVSRCALPHA", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 12; // D3DBLEND_BOTHSRCALPHA
        m[D3DRS_DESTBLEND] = 2; // ignored — overridden by fixup
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color.srcFactor).toBe("src-alpha");
        expect(blend.color.dstFactor).toBe("one-minus-src-alpha");
    });

    test("BOTHINVSRCALPHA as src forces the inverse pair", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1; m[D3DRS_SRCBLEND] = 13; // BOTHINVSRCALPHA
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color.srcFactor).toBe("one-minus-src-alpha");
        expect(blend.color.dstFactor).toBe("src-alpha");
    });
});

describe("buildColorTargetState — separate alpha blend", () => {
    test("alpha channel uses its own factors/op", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 5; m[D3DRS_DESTBLEND] = 6;       // colour: SRCALPHA/INVSRCALPHA
        m[D3DRS_SEPARATEALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLENDALPHA] = 2; m[D3DRS_DESTBLENDALPHA] = 1; // alpha: ONE/ZERO
        m[D3DRS_BLENDOPALPHA] = 5;                             // alpha: MAX
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color).toEqual({ srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" });
        expect(blend.alpha).toEqual({ srcFactor: "one", dstFactor: "zero", operation: "max" });
    });
});

describe("computeBlendKey", () => {
    test("disabled state keys differ only by write mask", () => {
        const m = defaults();
        const k1 = computeBlendKey(get(m));
        m[D3DRS_COLORWRITEENABLE] = 0x7;
        expect(computeBlendKey(get(m))).not.toBe(k1);
    });

    test("enabling blend changes the key (forces a fresh pipeline)", () => {
        const m = defaults();
        const off = computeBlendKey(get(m));
        m[D3DRS_ALPHABLENDENABLE] = 1; m[D3DRS_SRCBLEND] = 5; m[D3DRS_DESTBLEND] = 6;
        expect(computeBlendKey(get(m))).not.toBe(off);
    });

    test("identical blend state yields identical keys (cache hit)", () => {
        const a = defaults(); a[D3DRS_ALPHABLENDENABLE] = 1; a[D3DRS_SRCBLEND] = 5; a[D3DRS_DESTBLEND] = 6;
        const b = defaults(); b[D3DRS_ALPHABLENDENABLE] = 1; b[D3DRS_SRCBLEND] = 5; b[D3DRS_DESTBLEND] = 6;
        expect(computeBlendKey(get(a))).toBe(computeBlendKey(get(b)));
    });
});
