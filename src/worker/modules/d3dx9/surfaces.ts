/**
 * D3DX surface operations.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Mem } from '../../core/memory/mem-accessor';
import { d3dxLoadSurfaceFromMemory, d3dxLoadSurfaceFromRgba, d3dxLoadSurfaceFromSurface } from '../d3d9/d3dx-bridge';
import { decodeImageBytes } from './image-decode';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DFMT_A8R8G8B8 = 21;
const D3DPOOL_MANAGED = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DXIFF_FORCE_DWORD = 0xffffffff;

function writeImageInfo(ptr: number, width: number, height: number, mipLevels: number): boolean {
    if (!ptr) return true;
    return Mem.writeUint32(ptr + 0, width)
        && Mem.writeUint32(ptr + 4, height)
        && Mem.writeUint32(ptr + 8, 1)
        && Mem.writeUint32(ptr + 12, mipLevels)
        && Mem.writeUint32(ptr + 16, D3DFMT_A8R8G8B8)
        && Mem.writeUint32(ptr + 20, D3DRTYPE_TEXTURE)
        && Mem.writeUint32(ptr + 24, D3DPOOL_MANAGED)
        && Mem.writeUint32(ptr + 28, D3DXIFF_FORCE_DWORD);
}

export function createSurfaceExports(): Record<string, ThunkImplementation> {
    return {
        D3DXLoadSurfaceFromSurface: (_ctx, mem, args) => {
            return d3dxLoadSurfaceFromSurface(
                mem,
                args[0] >>> 0,
                args[2] >>> 0,
                args[3] >>> 0,
                args[5] >>> 0,
                args[6] >>> 0,
                args[7] >>> 0,
            );
        },
        D3DXLoadSurfaceFromMemory: (_ctx, mem, args) => {
            return d3dxLoadSurfaceFromMemory(
                mem,
                args[0] >>> 0,
                args[2] >>> 0,
                args[3] >>> 0,
                args[4] >>> 0,
                args[5] >>> 0,
                args[7] >>> 0,
                args[8] >>> 0,
                args[9] >>> 0,
            );
        },
        D3DXLoadSurfaceFromFileInMemory: async (_ctx, mem, args) => {
            const destSurface = args[0] >>> 0;
            const destRect = args[2] >>> 0;
            const srcData = args[3] >>> 0;
            const srcSize = args[4] >>> 0;
            const srcRect = args[5] >>> 0;
            const filter = args[6] >>> 0;
            const colorKey = args[7] >>> 0;
            const srcInfo = args[8] >>> 0;
            if (!destSurface || !srcData || !srcSize || srcData + srcSize > mem.length) {
                return D3DERR_INVALIDCALL;
            }
            const decoded = await decodeImageBytes(mem.subarray(srcData, srcData + srcSize));
            if (!decoded) return D3DERR_INVALIDCALL;
            if (!writeImageInfo(srcInfo, decoded.width, decoded.height, decoded.mipLevels)) {
                return D3DERR_INVALIDCALL;
            }
            const hr = d3dxLoadSurfaceFromRgba(
                mem,
                destSurface,
                destRect,
                decoded.rgba,
                decoded.width,
                decoded.height,
                srcRect,
                filter,
                colorKey,
            );
            return hr === D3D_OK ? D3D_OK : D3DERR_INVALIDCALL;
        },
    };
}
