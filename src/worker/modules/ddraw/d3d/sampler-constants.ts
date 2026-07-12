// Dependency-free Direct3D sampler ABI constants.
// Keep this module safe to import from state translators and unit tests.

// Retired texture sampler render states used by legacy interfaces (Device/Device2/Device3).
export const D3DRENDERSTATE_TEXTUREADDRESS = 3;
export const D3DRENDERSTATE_TEXTUREMAG = 17;
export const D3DRENDERSTATE_TEXTUREMIN = 18;
export const D3DRENDERSTATE_TEXTUREADDRESSU = 44;
export const D3DRENDERSTATE_TEXTUREADDRESSV = 45;
export const D3DRENDERSTATE_ANISOTROPY = 49;

// Texture stage sampler states (stage * 32 + type), per d3d7types.h / d3d8types.h.
// NOTE: MAGFILTER=16 / MINFILTER=17 (mag first), and MAXANISOTROPY is 21 —
// 19 is MIPMAPLODBIAS (a float; reading it as anisotropy yields garbage like
// 0x3E800000 and silently enables 15x aniso whenever a game sets LOD bias).
export const D3DTSS_TEXCOORDINDEX = 11;
export const D3DTSS_ADDRESS = 12; // combined: sets both ADDRESSU and ADDRESSV
export const D3DTSS_ADDRESSU = 13;
export const D3DTSS_ADDRESSV = 14;
export const D3DTSS_BORDERCOLOR = 15;
export const D3DTSS_MAGFILTER = 16;
export const D3DTSS_MINFILTER = 17;
export const D3DTSS_MIPFILTER = 18;
export const D3DTSS_MIPMAPLODBIAS = 19;
export const D3DTSS_MAXMIPLEVEL = 20;
export const D3DTSS_MAXANISOTROPY = 21;

// Texture address modes (D3DTADDRESS_*).
export const D3DTADDRESS_WRAP = 1;
export const D3DTADDRESS_MIRROR = 2;
export const D3DTADDRESS_CLAMP = 3;
export const D3DTADDRESS_BORDER = 4;

// Texture filter types for minification, magnification, and mip selection.
export const D3DTFN_POINT = 1;
export const D3DTFN_LINEAR = 2;
export const D3DTFN_ANISOTROPIC = 3;
export const D3DTFG_POINT = 1;
export const D3DTFG_LINEAR = 2;
export const D3DTFG_ANISOTROPIC = 3;
export const D3DTFP_NONE = 1;
export const D3DTFP_POINT = 2;
export const D3DTFP_LINEAR = 3;

// Legacy combined texture filter values (D3DTEXTUREFILTER / D3DFILTER_*).
export const D3DFILTER_NEAREST = 1;
export const D3DFILTER_LINEAR = 2;
export const D3DFILTER_MIPNEAREST = 3;
export const D3DFILTER_MIPLINEAR = 4;
export const D3DFILTER_LINEARMIPNEAREST = 5;
export const D3DFILTER_LINEARMIPLINEAR = 6;
