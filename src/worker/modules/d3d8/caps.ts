import { Mem } from '../../core/memory/mem-accessor';
import { D3D8_VS_VERSION, D3D8_PS_VERSION, D3D8_MAX_VS_CONST } from '../../backends/webgpu/d3d8/vsd-constants';

// ============================================================================
// Single source of truth for D3DCAPS8 (212 bytes — NOT D3DCAPS9's 304/332).
// Zeroed caps are not "neutral": engines take capability FALLBACK paths off
// them (e.g. ShadeCaps=0 / no D3DPSHADECAPS_ALPHAGOURAUDBLEND → LIT
// semi-transparent quads drawn with alpha blending disabled).
//
// Values are a DX8-era GeForce-class HAL profile, cross-checked against DXVK's
// d3d9_adapter.cpp caps (same fields/semantics for the shared prefix) and the
// real-hardware D3DCAPS9 dump in ../d3d9/caps.ts. Only capabilities our
// FFP/WebGPU backend actually implements are advertised (no BORDER-only lies:
// address caps 0x3F matches the d3d9 path's real-dump behavior; unsupported
// modes clamp at sampler translation).
//
// D3DCAPS8 layout (d3d8caps.h), byte offsets:
//   0 DeviceType            56 ShadeCaps                136 StencilCaps
//   4 AdapterOrdinal        60 TextureCaps              140 FVFCaps
//   8 Caps                  64 TextureFilterCaps        144 TextureOpCaps
//  12 Caps2                 68 CubeTextureFilterCaps    148 MaxTextureBlendStages
//  16 Caps3                 72 VolumeTextureFilterCaps  152 MaxSimultaneousTextures
//  20 PresentationIntervals 76 TextureAddressCaps       156 VertexProcessingCaps
//  24 CursorCaps            80 VolumeTextureAddressCaps 160 MaxActiveLights
//  28 DevCaps               84 LineCaps                 164 MaxUserClipPlanes
//  32 PrimitiveMiscCaps     88 MaxTextureWidth          168 MaxVertexBlendMatrices
//  36 RasterCaps            92 MaxTextureHeight         172 MaxVertexBlendMatrixIndex
//  40 ZCmpCaps              96 MaxVolumeExtent          176 MaxPointSize (float)
//  44 SrcBlendCaps         100 MaxTextureRepeat         180 MaxPrimitiveCount
//  48 DestBlendCaps        104 MaxTextureAspectRatio    184 MaxVertexIndex
//  52 AlphaCmpCaps         108 MaxAnisotropy            188 MaxStreams
//                          112 MaxVertexW (float)       192 MaxStreamStride
//                          116..131 GuardBand L/T/R/B   196 VertexShaderVersion
//                          132 ExtentsAdjust (float)    200 MaxVertexShaderConst
//                                                       204 PixelShaderVersion
//                                                       208 MaxPixelShaderValue (float)
// ============================================================================

const D3DCAPS8_SIZE = 212;

export function writeDeviceCaps8(pCaps: number, mem: Uint8Array): boolean {
    if (!pCaps) return false;
    mem.fill(0, pCaps, pCaps + D3DCAPS8_SIZE);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const u32 = (off: number, v: number) => view.setUint32(pCaps + off, v >>> 0, true);
    const f32 = (off: number, v: number) => view.setFloat32(pCaps + off, v, true);

    // A/B kill switch: revert to the pre-2026-07-08 minimal caps (most fields 0).
    // Set via harness `setWorkerFlag('__caps8Legacy', true)` BEFORE the game load —
    // engines read caps once at device init and pick render paths off them.
    if ((globalThis as Record<string, unknown>).__caps8Legacy) {
        u32(0, 1);
        u32(8, 0x00020000);
        u32(28, 0x001FFFFF);
        u32(32, 0x000000CF);
        u32(36, 0x00770077);
        u32(40, 0x000000FF);
        u32(44, 0x00001FFF);
        u32(48, 0x00001FFF);
        u32(60, 0x0001FFD3);
        u32(64, 0x07070700);
        u32(88, 4096);
        u32(92, 4096);
        u32(108, 16);
        u32(148, 8);
        u32(152, 8);
        u32(180, 0x0000FFFF);
        u32(184, 0x0000FFFF);
        u32(188, 16);
        u32(192, 256);
        u32(196, D3D8_VS_VERSION);
        u32(200, D3D8_MAX_VS_CONST);
        u32(204, D3D8_PS_VERSION);
        return true;
    }

    u32(0, 1);              // DeviceType = D3DDEVTYPE_HAL
    u32(8, 0x00020000);     // Caps = D3DCAPS_READ_SCANLINE
    u32(20, 0x80000001);    // PresentationIntervals = IMMEDIATE | ONE
    u32(24, 0x00000001);    // CursorCaps = D3DCURSORCAPS_COLOR
    u32(28, 0x001FFFFF);    // DevCaps
    u32(32, 0x000000CF);    // PrimitiveMiscCaps
    u32(36, 0x00770077);    // RasterCaps
    u32(40, 0x000000FF);    // ZCmpCaps: all compare funcs
    u32(44, 0x00001FFF);    // SrcBlendCaps: all D3D8 blend factors
    u32(48, 0x00001FFF);    // DestBlendCaps
    u32(52, 0x000000FF);    // AlphaCmpCaps = ZCmpCaps (full alpha-test support)
    // ShadeCaps: COLORGOURAUDRGB | SPECULARGOURAUDRGB | ALPHAGOURAUDBLEND | FOGGOURAUD.
    // ALPHAGOURAUDBLEND is load-bearing: engines gate lit-geometry transparency on it.
    u32(56, 0x00084208);
    u32(60, 0x0001FFD3);    // TextureCaps (no SQUAREONLY — real DX8 GPUs don't have it)
    // TextureFilterCaps: point+linear+anisotropic MIN/MAG, point+linear MIP —
    // honored by our sampler translation (D3DSAMP_MAXANISOTROPY respected).
    u32(64, 0x07070700);
    u32(68, 0x07070700);    // CubeTextureFilterCaps = TextureFilterCaps
    u32(72, 0x03030300);    // VolumeTextureFilterCaps (no aniso on volumes)
    u32(76, 0x0000003F);    // TextureAddressCaps: WRAP|MIRROR|CLAMP|BORDER|INDEPENDENTUV|MIRRORONCE
    u32(80, 0x0000003F);    // VolumeTextureAddressCaps
    u32(84, 0x0000001F);    // LineCaps: TEXTURE|ZTEST|BLEND|ALPHACMP|FOG
    u32(88, 4096);          // MaxTextureWidth
    u32(92, 4096);          // MaxTextureHeight
    u32(96, 2048);          // MaxVolumeExtent
    u32(100, 8192);         // MaxTextureRepeat
    u32(104, 8192);         // MaxTextureAspectRatio
    u32(108, 16);           // MaxAnisotropy
    f32(112, 1e10);         // MaxVertexW
    f32(116, -32768.0);     // GuardBandLeft
    f32(120, -32768.0);     // GuardBandTop
    f32(124, 32768.0);      // GuardBandRight
    f32(128, 32768.0);      // GuardBandBottom
    u32(136, 0x000000FF);   // StencilCaps: KEEP|ZERO|REPLACE|INCRSAT|DECRSAT|INVERT|INCR|DECR
    u32(140, 0x00100008);   // FVFCaps: 8 texcoord sets | PSIZE
    // TextureOpCaps: full GeForce-class op set minus PREMODULATE (matches the
    // real-hardware d3d9 dump; our shared FFP stage resolver implements these).
    u32(144, 0x03FEFFFF);
    u32(148, 8);            // MaxTextureBlendStages
    u32(152, 8);            // MaxSimultaneousTextures
    u32(156, 0x0000003B);   // VertexProcessingCaps: TEXGEN|MATERIALSOURCE7|DIR|POS lights|LOCALVIEWER
    u32(160, 8);            // MaxActiveLights (FFP supports 8)
    u32(164, 0);            // MaxUserClipPlanes: not implemented in WGSL — honest 0
    u32(168, 0);            // MaxVertexBlendMatrices: not implemented — honest 0
    u32(172, 0);            // MaxVertexBlendMatrixIndex
    f32(176, 1.0);          // MaxPointSize: 1.0 = no point sprites (honest minimum)
    u32(180, 0x0000FFFF);   // MaxPrimitiveCount
    u32(184, 0x0000FFFF);   // MaxVertexIndex
    u32(188, 16);           // MaxStreams (multi-stream D3DVSD supported)
    u32(192, 256);          // MaxStreamStride
    u32(196, D3D8_VS_VERSION);   // VertexShaderVersion = vs_1_1
    u32(200, D3D8_MAX_VS_CONST); // MaxVertexShaderConst
    u32(204, D3D8_PS_VERSION);   // PixelShaderVersion = ps_1_4
    f32(208, 8.0);          // MaxPixelShaderValue (ps_1_4 range)
    return true;
}
