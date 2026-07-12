import { describe, expect, test } from "bun:test";
import {
    D3DFILTER_LINEAR,
    D3DFILTER_LINEARMIPLINEAR,
    D3DFILTER_LINEARMIPNEAREST,
    D3DFILTER_MIPLINEAR,
    D3DFILTER_MIPNEAREST,
    D3DFILTER_NEAREST,
    D3DRENDERSTATE_ANISOTROPY,
    D3DRENDERSTATE_TEXTUREADDRESS,
    D3DRENDERSTATE_TEXTUREADDRESSU,
    D3DRENDERSTATE_TEXTUREADDRESSV,
    D3DRENDERSTATE_TEXTUREMAG,
    D3DRENDERSTATE_TEXTUREMIN,
    D3DTADDRESS_CLAMP,
    D3DTADDRESS_MIRROR,
    D3DTFG_LINEAR,
    D3DTFG_POINT,
    D3DTFN_LINEAR,
    D3DTFN_POINT,
    D3DTFP_LINEAR,
    D3DTFP_NONE,
    D3DTFP_POINT,
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTSS_MAGFILTER,
    D3DTSS_MAXANISOTROPY,
    D3DTSS_MINFILTER,
    D3DTSS_MIPFILTER,
} from "../../src/worker/modules/ddraw/d3d/sampler-constants";
import {
    isLegacyTextureSamplerRenderState,
    translateLegacyTextureSamplerState,
} from "../../src/worker/modules/ddraw/d3d/legacy-sampler-state";

function createStates(): Int32Array {
    return new Int32Array(8 * 32);
}

describe("legacy Device3 sampler render states", () => {
    test("maps combined and per-axis addressing to texture stage 0", () => {
        const states = createStates();

        translateLegacyTextureSamplerState(states, D3DRENDERSTATE_TEXTUREADDRESS, D3DTADDRESS_CLAMP);
        expect(states[D3DTSS_ADDRESSU]).toBe(D3DTADDRESS_CLAMP);
        expect(states[D3DTSS_ADDRESSV]).toBe(D3DTADDRESS_CLAMP);

        translateLegacyTextureSamplerState(states, D3DRENDERSTATE_TEXTUREADDRESSU, D3DTADDRESS_MIRROR);
        expect(states[D3DTSS_ADDRESSU]).toBe(D3DTADDRESS_MIRROR);
        expect(states[D3DTSS_ADDRESSV]).toBe(D3DTADDRESS_CLAMP);

        translateLegacyTextureSamplerState(states, D3DRENDERSTATE_TEXTUREADDRESSV, D3DTADDRESS_MIRROR);
        expect(states[D3DTSS_ADDRESSV]).toBe(D3DTADDRESS_MIRROR);
    });

    test("maps magnification filtering", () => {
        const states = createStates();

        translateLegacyTextureSamplerState(states, D3DRENDERSTATE_TEXTUREMAG, D3DFILTER_LINEAR);
        expect(states[D3DTSS_MAGFILTER]).toBe(D3DTFG_LINEAR);

        translateLegacyTextureSamplerState(states, D3DRENDERSTATE_TEXTUREMAG, D3DFILTER_NEAREST);
        expect(states[D3DTSS_MAGFILTER]).toBe(D3DTFG_POINT);
    });

    test.each([
        [D3DFILTER_NEAREST, D3DTFN_POINT, D3DTFP_NONE],
        [D3DFILTER_LINEAR, D3DTFN_LINEAR, D3DTFP_NONE],
        [D3DFILTER_MIPNEAREST, D3DTFN_POINT, D3DTFP_POINT],
        [D3DFILTER_MIPLINEAR, D3DTFN_POINT, D3DTFP_LINEAR],
        [D3DFILTER_LINEARMIPNEAREST, D3DTFN_LINEAR, D3DTFP_POINT],
        [D3DFILTER_LINEARMIPLINEAR, D3DTFN_LINEAR, D3DTFP_LINEAR],
    ])("maps legacy min filter %i to min=%i mip=%i", (legacy, minFilter, mipFilter) => {
        const states = createStates();

        translateLegacyTextureSamplerState(states, D3DRENDERSTATE_TEXTUREMIN, legacy);
        expect(states[D3DTSS_MINFILTER]).toBe(minFilter);
        expect(states[D3DTSS_MIPFILTER]).toBe(mipFilter);
    });

    test("maps anisotropy and recognizes only sampler states", () => {
        const states = createStates();

        translateLegacyTextureSamplerState(states, D3DRENDERSTATE_ANISOTROPY, 0);
        expect(states[D3DTSS_MAXANISOTROPY]).toBe(1);
        expect(isLegacyTextureSamplerRenderState(D3DRENDERSTATE_TEXTUREMIN)).toBe(true);
        expect(isLegacyTextureSamplerRenderState(27)).toBe(false);
    });
});
