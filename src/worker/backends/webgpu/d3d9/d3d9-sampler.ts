/**
 * D3D9-specific sampler-state decode → version-agnostic SamplerSpec.
 *
 * The D3D9 enum numbering differs from D3D7 (notably mip-filter: D3D9 D3DTEXF_NONE=0/POINT=1/LINEAR=2
 * vs D3D7 NONE=1/POINT=2/LINEAR=3), so the decode lives in the D3D9 backend; the resulting SamplerSpec
 * is handed to the shared DxSamplerCache that DX7/D3D8/D3D9 all use (see shared/dx-sampler.ts).
 */

import type { SamplerSpec } from "../shared/dx-sampler";

// D3DSAMPLERSTATETYPE
export const D3DSAMP_ADDRESSU = 1;
export const D3DSAMP_ADDRESSV = 2;
export const D3DSAMP_ADDRESSW = 3;
export const D3DSAMP_MAGFILTER = 5;
export const D3DSAMP_MINFILTER = 6;
export const D3DSAMP_MIPFILTER = 7;
export const D3DSAMP_MIPMAPLODBIAS = 8; // NOTE: not representable on a WebGPU sampler (no lodBias field)
export const D3DSAMP_MAXMIPLEVEL = 9;
export const D3DSAMP_MAXANISOTROPY = 10;

// D3DTEXTUREFILTERTYPE
const D3DTEXF_NONE = 0;
const D3DTEXF_POINT = 1;
const D3DTEXF_LINEAR = 2;
const D3DTEXF_ANISOTROPIC = 3;

// D3DTEXTUREADDRESS
const D3DTADDRESS_WRAP = 1;
const D3DTADDRESS_MIRROR = 2;
const D3DTADDRESS_CLAMP = 3;
const D3DTADDRESS_BORDER = 4;
const D3DTADDRESS_MIRRORONCE = 5;

/** D3D9 min/mag default is POINT, so an unset (0/NONE) value resolves to nearest. */
function minMagFilter(v: number): GPUFilterMode {
    return v === D3DTEXF_LINEAR || v === D3DTEXF_ANISOTROPIC ? "linear" : "nearest";
}

function mipFilter(v: number): GPUMipmapFilterMode {
    return v === D3DTEXF_LINEAR ? "linear" : "nearest";
}

/** D3D9 default address mode is WRAP, so an unset (0) value resolves to repeat. */
function addressMode(v: number): GPUAddressMode {
    switch (v) {
        case D3DTADDRESS_MIRROR:
        case D3DTADDRESS_MIRRORONCE: // WebGPU has no mirror-once; mirror-repeat is the closest approximation
            return "mirror-repeat";
        case D3DTADDRESS_CLAMP:
            return "clamp-to-edge";
        case D3DTADDRESS_BORDER: // WebGPU has no clamp-to-border; approximate with clamp-to-edge
            return "clamp-to-edge";
        case D3DTADDRESS_WRAP:
        default:
            return "repeat";
    }
}

/**
 * Decode the D3D9 sampler-state block for one stage into a SamplerSpec.
 * `get(type)` returns the raw D3DSAMP_* value (0 if the game never set it → D3D9 defaults apply).
 */
export function decodeD3d9Sampler(get: (type: number) => number): SamplerSpec {
    const minV = get(D3DSAMP_MINFILTER);
    const magV = get(D3DSAMP_MAGFILTER);
    const mipV = get(D3DSAMP_MIPFILTER);
    const anisoRequested = minV === D3DTEXF_ANISOTROPIC || magV === D3DTEXF_ANISOTROPIC;
    return {
        min: minMagFilter(minV),
        mag: minMagFilter(magV),
        mip: mipFilter(mipV),
        mipNone: mipV === D3DTEXF_NONE, // D3D9 MIPFILTER=NONE (0) → sample base level only
        addressU: addressMode(get(D3DSAMP_ADDRESSU)),
        addressV: addressMode(get(D3DSAMP_ADDRESSV)),
        addressW: addressMode(get(D3DSAMP_ADDRESSW)),
        gameAnisotropy: anisoRequested ? Math.max(1, get(D3DSAMP_MAXANISOTROPY)) : 1,
        maxMipLevel: get(D3DSAMP_MAXMIPLEVEL),
    };
}
