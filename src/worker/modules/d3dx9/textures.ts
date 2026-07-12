/**
 * D3DX texture loaders and mip filtering.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import {
    createGuestTexture,
    D3D_OK,
    D3DERR_INVALIDCALL,
    D3DFMT_A8R8G8B8,
} from '../d3d9/resource-registry';
import { d3dxFilterTexture, uploadRgbaToTexture } from '../d3d9/d3dx-bridge';
import { decodeImageBytes, loadImageFromVfs } from './image-decode';

const D3DPOOL_MANAGED = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DXIFF_FORCE_DWORD = 0xffffffff;
const D3DX_DEFAULT = 0xffffffff;

type DecodedImage = { width: number; height: number; rgba: Uint8Array; mipLevels: number };

/** Apply the *Ex MipLevels argument: 0 / D3DX_DEFAULT → full chain (decoded default); N → min(N, full). */
function withMipLevels(decoded: DecodedImage, mipLevelsArg: number): DecodedImage {
    if (mipLevelsArg === 0 || mipLevelsArg === D3DX_DEFAULT) return decoded;
    return { ...decoded, mipLevels: Math.max(1, Math.min(mipLevelsArg, decoded.mipLevels)) };
}
function writeImageInfo(ptr: number, width: number, height: number, mipLevels: number): boolean {
    if (!ptr) return false;
    return Mem.writeUint32(ptr + 0, width)
        && Mem.writeUint32(ptr + 4, height)
        && Mem.writeUint32(ptr + 8, 1)
        && Mem.writeUint32(ptr + 12, mipLevels)
        && Mem.writeUint32(ptr + 16, D3DFMT_A8R8G8B8)
        && Mem.writeUint32(ptr + 20, D3DRTYPE_TEXTURE)
        && Mem.writeUint32(ptr + 24, D3DPOOL_MANAGED)
        && Mem.writeUint32(ptr + 28, D3DXIFF_FORCE_DWORD);
}

async function createTextureFromDecoded(
    devicePtr: number,
    ppTexture: number,
    decoded: { width: number; height: number; rgba: Uint8Array; mipLevels: number },
): Promise<number> {
    const hr = createGuestTexture(
        devicePtr,
        decoded.width,
        decoded.height,
        decoded.mipLevels,
        0,
        D3DFMT_A8R8G8B8,
        D3DPOOL_MANAGED,
        ppTexture,
    );
    if (hr !== D3D_OK || !ppTexture) return hr;

    const texPtr = Mem.readUint32(ppTexture) ?? 0;
    if (!texPtr || !uploadRgbaToTexture(texPtr, decoded.width, decoded.height, decoded.rgba)) {
        return D3DERR_INVALIDCALL;
    }

    const filterHr = d3dxFilterTexture(texPtr, 0, 0);
    if (filterHr !== D3D_OK) {
        Logger.warn(LogCategory.D3D9, `d3dx9: mip filter after load returned 0x${filterHr.toString(16)}`);
    }
    return D3D_OK;
}

export function createTextureExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['D3DXFilterTexture'] = (_ctx, _mem, args) => {
        return d3dxFilterTexture(args[0] >>> 0, args[2] >>> 0, args[3] >>> 0);
    };

    exports['D3DXGetImageInfoFromFileA'] = async (_ctx, mem, args) => {
        const pathPtr = args[0] >>> 0;
        const pInfo = args[1] >>> 0;
        if (!pathPtr || !pInfo) return D3DERR_INVALIDCALL;
        const path = Marshaler.readString(mem, pathPtr);
        const decoded = await loadImageFromVfs(path);
        if (!decoded) return D3DERR_INVALIDCALL;
        return writeImageInfo(pInfo, decoded.width, decoded.height, decoded.mipLevels) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['D3DXGetImageInfoFromFileW'] = async (_ctx, mem, args) => {
        const pathPtr = args[0] >>> 0;
        const pInfo = args[1] >>> 0;
        if (!pathPtr || !pInfo) return D3DERR_INVALIDCALL;
        const path = Marshaler.readWideString(mem, pathPtr);
        const decoded = await loadImageFromVfs(path);
        if (!decoded) return D3DERR_INVALIDCALL;
        return writeImageInfo(pInfo, decoded.width, decoded.height, decoded.mipLevels) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['D3DXCreateTextureFromFileA'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pathPtr = args[1] >>> 0;
        const ppTexture = args[2] >>> 0;
        if (!devicePtr || !pathPtr || !ppTexture) return D3DERR_INVALIDCALL;
        const path = Marshaler.readString(mem, pathPtr);
        const decoded = await loadImageFromVfs(path);
        if (!decoded) return D3DERR_INVALIDCALL;
        return createTextureFromDecoded(devicePtr, ppTexture, decoded);
    };

    exports['D3DXCreateTextureFromFileW'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pathPtr = args[1] >>> 0;
        const ppTexture = args[2] >>> 0;
        if (!devicePtr || !pathPtr || !ppTexture) return D3DERR_INVALIDCALL;
        const path = Marshaler.readWideString(mem, pathPtr);
        const decoded = await loadImageFromVfs(path);
        if (!decoded) return D3DERR_INVALIDCALL;
        return createTextureFromDecoded(devicePtr, ppTexture, decoded);
    };

    exports['D3DXCreateTextureFromFileInMemory'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pSrc = args[1] >>> 0;
        const srcLen = args[2] >>> 0;
        const ppTexture = args[3] >>> 0;
        if (!devicePtr || !pSrc || !srcLen || !ppTexture) return D3DERR_INVALIDCALL;
        const data = mem.subarray(pSrc, pSrc + srcLen);
        const decoded = await decodeImageBytes(data);
        if (!decoded) return D3DERR_INVALIDCALL;
        return createTextureFromDecoded(devicePtr, ppTexture, decoded);
    };

    // ---- *Ex variants ----
    // Many games call only the Ex forms; they previously fell through to D3DERR_INVALIDCALL (texture
    // never created → missing textures / load-failure branches). We honor MipLevels and fill pSrcInfo;
    // explicit Width/Height resize and Format/ColorKey override are not yet applied (the source size and
    // RGBA8 are used — sufficient for the common D3DX_DEFAULT call pattern).
    // D3DXCreateTextureFromFileEx(A/W): (Device, SrcFile, W, H, MipLevels, Usage, Format, Pool,
    //   Filter, MipFilter, ColorKey, pSrcInfo, pPalette, ppTexture)
    exports['D3DXCreateTextureFromFileExA'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pathPtr = args[1] >>> 0;
        const mipLevelsArg = args[4] >>> 0;
        const pSrcInfo = args[11] >>> 0;
        const ppTexture = args[13] >>> 0;
        if (!devicePtr || !pathPtr || !ppTexture) return D3DERR_INVALIDCALL;
        const decoded = await loadImageFromVfs(Marshaler.readString(mem, pathPtr));
        if (!decoded) return D3DERR_INVALIDCALL;
        if (pSrcInfo) writeImageInfo(pSrcInfo, decoded.width, decoded.height, decoded.mipLevels);
        return createTextureFromDecoded(devicePtr, ppTexture, withMipLevels(decoded, mipLevelsArg));
    };

    exports['D3DXCreateTextureFromFileExW'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pathPtr = args[1] >>> 0;
        const mipLevelsArg = args[4] >>> 0;
        const pSrcInfo = args[11] >>> 0;
        const ppTexture = args[13] >>> 0;
        if (!devicePtr || !pathPtr || !ppTexture) return D3DERR_INVALIDCALL;
        const decoded = await loadImageFromVfs(Marshaler.readWideString(mem, pathPtr));
        if (!decoded) return D3DERR_INVALIDCALL;
        if (pSrcInfo) writeImageInfo(pSrcInfo, decoded.width, decoded.height, decoded.mipLevels);
        return createTextureFromDecoded(devicePtr, ppTexture, withMipLevels(decoded, mipLevelsArg));
    };

    // D3DXCreateTextureFromFileInMemoryEx: (Device, SrcData, SrcSize, W, H, MipLevels, Usage, Format,
    //   Pool, Filter, MipFilter, ColorKey, pSrcInfo, pPalette, ppTexture)
    exports['D3DXCreateTextureFromFileInMemoryEx'] = async (_ctx, mem, args) => {
        const devicePtr = args[0] >>> 0;
        const pSrc = args[1] >>> 0;
        const srcLen = args[2] >>> 0;
        const mipLevelsArg = args[5] >>> 0;
        const pSrcInfo = args[12] >>> 0;
        const ppTexture = args[14] >>> 0;
        if (!devicePtr || !pSrc || !srcLen || !ppTexture) return D3DERR_INVALIDCALL;
        const decoded = await decodeImageBytes(mem.subarray(pSrc, pSrc + srcLen));
        if (!decoded) return D3DERR_INVALIDCALL;
        if (pSrcInfo) writeImageInfo(pSrcInfo, decoded.width, decoded.height, decoded.mipLevels);
        return createTextureFromDecoded(devicePtr, ppTexture, withMipLevels(decoded, mipLevelsArg));
    };

    return exports;
}
