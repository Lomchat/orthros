/**
 * D3D8 texture-stage sampler decode → shared SamplerSpec.
 * D3D8 uses SetTextureStageState (TSS) instead of D3D9 SetSamplerState.
 */

import type { SamplerSpec } from "../shared/dx-sampler";
import {
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTSS_MAGFILTER,
    D3DTSS_MINFILTER,
    D3DTSS_MIPFILTER,
} from "../../../modules/ddraw/constants";

// D3DTEXTUREFILTERTYPE (D3D7/D3D8 numbering)
const D3DTFG_NONE = 1;
const D3DTFG_POINT = 2;
const D3DTFG_LINEAR = 3;
const D3DTFG_ANISOTROPIC = 4;

const D3DTADDRESS_WRAP = 1;
const D3DTADDRESS_MIRROR = 2;
const D3DTADDRESS_CLAMP = 3;
const D3DTADDRESS_BORDER = 4;
const D3DTADDRESS_MIRRORONCE = 5;

function minMagFilter(v: number): GPUFilterMode {
    return v === D3DTFG_LINEAR || v === D3DTFG_ANISOTROPIC ? "linear" : "nearest";
}

function mipFilter(v: number): GPUMipmapFilterMode {
    return v === D3DTFG_LINEAR ? "linear" : "nearest";
}

function addressMode(v: number): GPUAddressMode {
    switch (v) {
        case D3DTADDRESS_MIRROR:
        case D3DTADDRESS_MIRRORONCE:
            return "mirror-repeat";
        case D3DTADDRESS_CLAMP:
        case D3DTADDRESS_BORDER:
            return "clamp-to-edge";
        default:
            return "repeat";
    }
}

/** Decode TSS state for one stage from a flat D3D8 textureStates array. */
export function decodeD3d8TssSampler(
    textureStates: Int32Array,
    stage: number,
): SamplerSpec {
    const base = stage * 32;
    const get = (type: number) => textureStates[base + type] ?? 0;
    const minV = get(D3DTSS_MINFILTER);
    const magV = get(D3DTSS_MAGFILTER);
    const mipV = get(D3DTSS_MIPFILTER);
    const anisoRequested = minV === D3DTFG_ANISOTROPIC || magV === D3DTFG_ANISOTROPIC;
    return {
        min: minMagFilter(minV || D3DTFG_POINT),
        mag: minMagFilter(magV || D3DTFG_POINT),
        mip: mipFilter(mipV || D3DTFG_NONE),
        mipNone: mipV === D3DTFG_NONE,
        addressU: addressMode(get(D3DTSS_ADDRESSU) || D3DTADDRESS_WRAP),
        addressV: addressMode(get(D3DTSS_ADDRESSV) || D3DTADDRESS_WRAP),
        addressW: addressMode(D3DTADDRESS_WRAP),
        gameAnisotropy: anisoRequested ? 16 : 1,
        maxMipLevel: 0,
    };
}
