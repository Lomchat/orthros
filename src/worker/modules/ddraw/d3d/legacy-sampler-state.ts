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
} from "./sampler-constants";

const STAGE0_OFFSET = 0;

export function isLegacyTextureSamplerRenderState(state: number): boolean {
    return state === D3DRENDERSTATE_TEXTUREADDRESS ||
        state === D3DRENDERSTATE_TEXTUREADDRESSU ||
        state === D3DRENDERSTATE_TEXTUREADDRESSV ||
        state === D3DRENDERSTATE_TEXTUREMAG ||
        state === D3DRENDERSTATE_TEXTUREMIN ||
        state === D3DRENDERSTATE_ANISOTROPY;
}

/**
 * Map retired Device3 texture sampler render states to texture stage 0.
 * D3DTEXTUREFILTER combines minification and mip filtering in one legacy enum.
 */
export function translateLegacyTextureSamplerState(
    textureStageStates: Int32Array,
    state: number,
    value: number
): void {
    switch (state) {
        case D3DRENDERSTATE_TEXTUREADDRESS:
            textureStageStates[STAGE0_OFFSET + D3DTSS_ADDRESSU] = value;
            textureStageStates[STAGE0_OFFSET + D3DTSS_ADDRESSV] = value;
            break;
        case D3DRENDERSTATE_TEXTUREADDRESSU:
            textureStageStates[STAGE0_OFFSET + D3DTSS_ADDRESSU] = value;
            break;
        case D3DRENDERSTATE_TEXTUREADDRESSV:
            textureStageStates[STAGE0_OFFSET + D3DTSS_ADDRESSV] = value;
            break;
        case D3DRENDERSTATE_TEXTUREMAG:
            if (value === D3DFILTER_NEAREST) {
                textureStageStates[STAGE0_OFFSET + D3DTSS_MAGFILTER] = D3DTFG_POINT;
            } else if (value === D3DFILTER_LINEAR) {
                textureStageStates[STAGE0_OFFSET + D3DTSS_MAGFILTER] = D3DTFG_LINEAR;
            }
            break;
        case D3DRENDERSTATE_TEXTUREMIN:
            translateLegacyMinFilter(textureStageStates, value);
            break;
        case D3DRENDERSTATE_ANISOTROPY:
            textureStageStates[STAGE0_OFFSET + D3DTSS_MAXANISOTROPY] = Math.max(1, value);
            break;
    }
}

function translateLegacyMinFilter(textureStageStates: Int32Array, value: number): void {
    switch (value) {
        case D3DFILTER_NEAREST:
            textureStageStates[STAGE0_OFFSET + D3DTSS_MINFILTER] = D3DTFN_POINT;
            textureStageStates[STAGE0_OFFSET + D3DTSS_MIPFILTER] = D3DTFP_NONE;
            break;
        case D3DFILTER_LINEAR:
            textureStageStates[STAGE0_OFFSET + D3DTSS_MINFILTER] = D3DTFN_LINEAR;
            textureStageStates[STAGE0_OFFSET + D3DTSS_MIPFILTER] = D3DTFP_NONE;
            break;
        case D3DFILTER_MIPNEAREST:
            textureStageStates[STAGE0_OFFSET + D3DTSS_MINFILTER] = D3DTFN_POINT;
            textureStageStates[STAGE0_OFFSET + D3DTSS_MIPFILTER] = D3DTFP_POINT;
            break;
        case D3DFILTER_MIPLINEAR:
            textureStageStates[STAGE0_OFFSET + D3DTSS_MINFILTER] = D3DTFN_POINT;
            textureStageStates[STAGE0_OFFSET + D3DTSS_MIPFILTER] = D3DTFP_LINEAR;
            break;
        case D3DFILTER_LINEARMIPNEAREST:
            textureStageStates[STAGE0_OFFSET + D3DTSS_MINFILTER] = D3DTFN_LINEAR;
            textureStageStates[STAGE0_OFFSET + D3DTSS_MIPFILTER] = D3DTFP_POINT;
            break;
        case D3DFILTER_LINEARMIPLINEAR:
            textureStageStates[STAGE0_OFFSET + D3DTSS_MINFILTER] = D3DTFN_LINEAR;
            textureStageStates[STAGE0_OFFSET + D3DTSS_MIPFILTER] = D3DTFP_LINEAR;
            break;
    }
}
