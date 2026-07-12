/**
 * Surface state factory for D3D8/D3D9.
 *
 * Creates DirectDrawSurfaceState objects that the shared FFP renderer
 * (DDrawWebGPUExecutor) can consume. This decouples D3D8/D3D9 from
 * DDraw-specific surface creation logic.
 */

import type {
    RenderSurface,
    BitmapTextureSurface,
} from '../../../modules/ddraw/com-objects';
import {
    D3DFMT_A8R8G8B8,
    D3DFMT_X8R8G8B8,
    d3dFormatToSurfaceFormat,
    getD3DTextureLayout,
    isDxtFormat,
} from './texture-formats';

export {
    d3dFormatBpp,
    d3dFormatToSurfaceFormat,
} from './texture-formats';

// DDSCAPS
const DDSCAPS_TEXTURE       = 0x00001000;
const DDSCAPS_3DDEVICE      = 0x00002000;
const DDSCAPS_ZBUFFER       = 0x00000020;

/**
 * Create a RenderSurface for use as a D3D8/D3D9 render target or backbuffer.
 * Mode is GPU_ONLY — the executor manages the GPU texture lazily.
 */
export function createRenderTarget(
    width: number,
    height: number,
    format: number = D3DFMT_X8R8G8B8,
): RenderSurface {
    const sf = d3dFormatToSurfaceFormat(format);
    return {
        surfaceType: "render_surface",
        mode: "GPU_ONLY",
        width,
        height,
        pitch: width * (sf.bpp / 8),
        caps: DDSCAPS_3DDEVICE | DDSCAPS_TEXTURE,
        surfacePtr: 0,
        format: sf,
        attachedSurfaceAddr: 0,
        version: 0,
        gpuDirty: false,
        everLocked: false,
        lastUploadVersion: 0,
        writeGeneration: 0,
    };
}

/**
 * Create a BitmapTextureSurface for a D3D8/D3D9 texture with CPU pixel backing.
 */
export function createTextureSurface(
    width: number,
    height: number,
    format: number = D3DFMT_A8R8G8B8,
): BitmapTextureSurface {
    const sf = d3dFormatToSurfaceFormat(format);
    const rgbaSize = width * height * 4; // Always RGBA internally
    // DXT/BC surfaces: the guest LockRect pitch is the compressed block-row pitch
    // (DXT1 = width*2, DXT3/5 = width*4), NOT width*bpp. The bytes are decoded to
    // rgbaScratch on sync — see syncBitmapSurfaceFromGuest / dxt.ts.
    const dxt = isDxtFormat(format);
    const layout = getD3DTextureLayout(format, width, height);
    return {
        surfaceType: "bitmap_texture",
        width,
        height,
        pitch: layout.pitch,
        caps: DDSCAPS_TEXTURE,
        surfacePtr: 0,  // Set by caller after guest memory allocation
        format: sf,
        attachedSurfaceAddr: 0,
        rgbaScratch: new Uint8Array(rgbaSize),
        gpuNeedsUpload: false,
        writeGeneration: 0,
        d3dFormat: format,
        ...(dxt ? { dxtFormat: format } : {}),
    };
}

/**
 * Create a RenderSurface for a depth/stencil buffer.
 */
export function createDepthStencil(
    width: number,
    height: number,
): RenderSurface {
    return {
        surfaceType: "render_surface",
        mode: "GPU_ONLY",
        width,
        height,
        pitch: width * 4,
        caps: DDSCAPS_ZBUFFER,
        surfacePtr: 0,
        format: { flags: 0, bpp: 32, rMask: 0, gMask: 0, bMask: 0, aMask: 0 },
        attachedSurfaceAddr: 0,
        version: 0,
        gpuDirty: false,
        everLocked: false,
        lastUploadVersion: 0,
        writeGeneration: 0,
    };
}
