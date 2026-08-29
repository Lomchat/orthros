/**
 * D3D9 Resource functions
 *
 * Atomic implementation for Direct3D resource operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory, LogLevel } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { devices, getVTables, createComObject, resourceToDevice } from './shared-state';
import {
    textureMeta,
    surfaceMeta,
    computeMipLevelCount,
    getTextureLevelDims,
    ensureTextureLevelSurface,
    ensureCubeFaceSurface,
    precreateTextureLevelSurfaces,
    precreateCubeFaceSurfaces,
    clearTextureSubresourceSurfaces,
    type SurfaceMeta,
} from './resource-registry';
import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';
import { getD3D9TextureLockRegion } from '../../backends/webgpu/d3d9/d3d9-resources';
import {
    initReturnPtr,
    D3DFMT_UNKNOWN,
    normalizePalettizedTexturePool,
} from '../../backends/webgpu/shared/dx-com-helpers';
import { isDxExclusiveFormat } from '../../backends/webgpu/shared/dx-format-support';
import { injectBfmeVp6Frame } from './bfme-vp6-bridge';
import { recordGraphicsHresultFailure } from '../../core/diagnostics/graphics-hresult-recorder';
import { registerSurfaceLockInlineMapping } from './capture-trampolines';

const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DFMT_A8R8G8B8 = 21;
const D3DRTYPE_UNKNOWN = 0;
const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DPOOL_DEFAULT = 0;
const D3DMULTISAMPLE_NONE = 0;
const D3DUSAGE_RENDERTARGET = 0x00000001;
const D3DUSAGE_DEPTHSTENCIL = 0x00000002;
const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

interface SurfaceLockDiagRow {
    surface: number;
    texture: number;
    width: number;
    height: number;
    format: number;
    pool: number;
    usage: number;
    locks: number;
    fullLocks: number;
    partialLocks: number;
    bytesPerLock: number;
    rectangleCopyBytes: number;
    flags: Map<number, number>;
    callers: Map<number, number>;
}

let surfaceLockDiagEnabled = false;
let surfaceLockDiagTotal = 0;
let surfaceUnlockDiagTotal = 0;
let surfaceLockDiagOverflow = 0;
const surfaceLockDiagRows = new Map<number, SurfaceLockDiagRow>();

function resetSurfaceLockDiagnostics(): void {
    surfaceLockDiagTotal = 0;
    surfaceUnlockDiagTotal = 0;
    surfaceLockDiagOverflow = 0;
    surfaceLockDiagRows.clear();
}

export function setSurfaceLockDiagnostics(enabled: boolean, reset = true): unknown {
    if (reset) resetSurfaceLockDiagnostics();
    surfaceLockDiagEnabled = enabled;
    return getSurfaceLockDiagnostics();
}

export function getSurfaceLockDiagnostics(): unknown {
    const rows = [...surfaceLockDiagRows.values()]
        .sort((a, b) => b.locks - a.locks)
        .slice(0, 64)
        .map((row) => ({
            surface: `0x${row.surface.toString(16)}`,
            texture: `0x${row.texture.toString(16)}`,
            width: row.width,
            height: row.height,
            format: `0x${row.format.toString(16)}`,
            pool: row.pool,
            usage: `0x${row.usage.toString(16)}`,
            locks: row.locks,
            fullLocks: row.fullLocks,
            partialLocks: row.partialLocks,
            bytesPerLock: row.bytesPerLock,
            copiedBytesIfFullRoundTrip: row.bytesPerLock * row.locks * 2,
            copiedBytesWithRectangles: row.rectangleCopyBytes,
            flags: Object.fromEntries(
                [...row.flags.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([flags, count]) => [`0x${flags.toString(16)}`, count]),
            ),
            callers: [...row.callers.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([caller, count]) => ({ caller: `0x${caller.toString(16)}`, count })),
        }));
    return {
        enabled: surfaceLockDiagEnabled,
        totalLocks: surfaceLockDiagTotal,
        totalUnlocks: surfaceUnlockDiagTotal,
        uniqueSurfaces: surfaceLockDiagRows.size,
        overflow: surfaceLockDiagOverflow,
        rows,
    };
}

function recordSurfaceLock(
    pSurface: number,
    meta: SurfaceMeta,
    pRect: number,
    flags: number,
    caller: number,
    mem: Uint8Array,
    view: DataView,
): void {
    if (!surfaceLockDiagEnabled) return;
    surfaceLockDiagTotal++;
    let row = surfaceLockDiagRows.get(pSurface);
    if (!row) {
        if (surfaceLockDiagRows.size >= 512) {
            surfaceLockDiagOverflow++;
            return;
        }
        row = {
            surface: pSurface >>> 0,
            texture: (meta.texturePtr ?? 0) >>> 0,
            width: meta.width,
            height: meta.height,
            format: meta.format >>> 0,
            pool: meta.pool,
            usage: meta.usage >>> 0,
            locks: 0,
            fullLocks: 0,
            partialLocks: 0,
            bytesPerLock: getD3DTextureLayout(meta.format, meta.width, meta.height).bytes,
            rectangleCopyBytes: 0,
            flags: new Map(),
            callers: new Map(),
        };
        surfaceLockDiagRows.set(pSurface, row);
    }
    row.locks++;
    row.flags.set(flags >>> 0, (row.flags.get(flags >>> 0) ?? 0) + 1);
    row.callers.set(caller >>> 0, (row.callers.get(caller >>> 0) ?? 0) + 1);
    if (!pRect) {
        row.fullLocks++;
        const region = getD3D9TextureLockRegion(meta.format, meta.width, meta.height, null);
        if (region) {
            const directions = ((flags & 0x2000) === 0 ? 1 : 0) + ((flags & 0x10) === 0 ? 1 : 0);
            row.rectangleCopyBytes += region.rowBytes * region.rows * directions;
        }
    } else if (pRect <= mem.length - 16) {
        const left = view.getInt32(pRect, true);
        const top = view.getInt32(pRect + 4, true);
        const right = view.getInt32(pRect + 8, true);
        const bottom = view.getInt32(pRect + 12, true);
        if (left === 0 && top === 0 && right === meta.width && bottom === meta.height) row.fullLocks++;
        else row.partialLocks++;
        const region = getD3D9TextureLockRegion(meta.format, meta.width, meta.height, { left, top, right, bottom });
        if (region) {
            const directions = ((flags & 0x2000) === 0 ? 1 : 0) + ((flags & 0x10) === 0 ? 1 : 0);
            row.rectangleCopyBytes += region.rowBytes * region.rows * directions;
        }
    } else {
        row.partialLocks++;
    }
}

function writeSurfaceDesc(pDesc: number, meta: SurfaceMeta): boolean {
    return (
        Mem.writeUint32(pDesc + 0, meta.format >>> 0) &&
        Mem.writeUint32(pDesc + 4, meta.type >>> 0) &&
        Mem.writeUint32(pDesc + 8, meta.usage >>> 0) &&
        Mem.writeUint32(pDesc + 12, meta.pool >>> 0) &&
        Mem.writeUint32(pDesc + 16, meta.multiSampleType >>> 0) &&
        Mem.writeUint32(pDesc + 20, meta.multiSampleQuality >>> 0) &&
        Mem.writeUint32(pDesc + 24, meta.width >>> 0) &&
        Mem.writeUint32(pDesc + 28, meta.height >>> 0)
    );
}

function resolveDevicePtr(deviceInstance: unknown): number {
    for (const [devicePtr, device] of devices.entries()) {
        if (device === deviceInstance) {
            return devicePtr >>> 0;
        }
    }
    return 0;
}

function computeLockRectOffset(format: number, width: number, height: number, pitch: number, left: number, top: number): number {
    const layout = getD3DTextureLayout(format, width, height);
    if (layout.compressed) {
        return ((top >> 2) * pitch + (left >> 2) * layout.blockBytes) >>> 0;
    }
    const bytesPerPixel = Math.max(1, Math.floor(layout.pitch / Math.max(1, width | 0)));
    return (top * pitch + left * bytesPerPixel) >>> 0;
}

/** Shared Surface9 LockRect body used by both the ordinary thunk and its direct
 * FastPath. Keeping one implementation matters here: BFME calls this dozens of
 * times per frame, while movie surfaces still need the exact VP6-aware unlock. */
export function lockSurfaceRectDirect(
    mem: Uint8Array,
    view: DataView,
    pSurface: number,
    pLockedRect: number,
    pRect: number,
    flags = 0,
    caller = 0,
): number {
    const meta = surfaceMeta.get(pSurface);
    const device = resourceToDevice.get(pSurface);
    if (!meta || !device || !meta.texturePtr || !pLockedRect || pLockedRect > mem.length - 8) {
        return D3DERR_INVALIDCALL;
    }

    const level = meta.level ?? 0;
    recordSurfaceLock(pSurface, meta, pRect, flags, caller, mem, view);
    if (pRect && pRect > mem.length - 16) return D3DERR_INVALIDCALL;
    const rect = pRect ? {
        left: view.getInt32(pRect, true),
        top: view.getInt32(pRect + 4, true),
        right: view.getInt32(pRect + 8, true),
        bottom: view.getInt32(pRect + 12, true),
    } : null;
    const lockInfo = device.lockTexture(meta.texturePtr, level, rect, flags);
    if (!lockInfo) return D3DERR_INVALIDCALL;

    let pBits = lockInfo.ptr >>> 0;
    if (pRect) {
        const left = pRect <= mem.length - 4 ? view.getInt32(pRect, true) : 0;
        const top = pRect <= mem.length - 8 ? view.getInt32(pRect + 4, true) : 0;
        pBits = (pBits + computeLockRectOffset(meta.format, meta.width, meta.height, lockInfo.pitch, left, top)) >>> 0;
    }

    view.setUint32(pLockedRect, lockInfo.pitch >>> 0, true);
    view.setUint32(pLockedRect + 4, pBits, true);
    return D3D_OK;
}

export function unlockSurfaceRectDirect(mem: Uint8Array, pSurface: number): number {
    const meta = surfaceMeta.get(pSurface);
    const device = resourceToDevice.get(pSurface);
    if (!meta || !device || !meta.texturePtr) return D3DERR_INVALIDCALL;
    if (surfaceLockDiagEnabled) surfaceUnlockDiagTotal++;

    const level = meta.level ?? 0;
    const lockInfo = device.lockTexture(meta.texturePtr, level);
    if (lockInfo && level === 0) {
        injectBfmeVp6Frame(mem, lockInfo.ptr, lockInfo.pitch, meta.width, meta.height, meta.format);
    }
    device.unlockTexture(meta.texturePtr, level, mem);
    if (level === 0) {
        const backing = device.getLevel0LockBacking?.(meta.texturePtr);
        const layout = getD3DTextureLayout(meta.format, meta.width, meta.height);
        if (backing && !layout.compressed) {
            const bytesPerPixel = Math.max(1, Math.floor(layout.pitch / Math.max(1, meta.width)));
            registerSurfaceLockInlineMapping(
                pSurface,
                meta.texturePtr,
                backing.guestPtr,
                backing.pitch,
                bytesPerPixel,
                meta.width,
                meta.height,
            );
        }
    }
    return D3D_OK;
}

export function createResourcesExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    /**
     * Surface-only D3D9 resources still need actual backing storage for LockRect,
     * ColorFill and render-target use. Model that storage as an internal one-level
     * texture, while exposing only its stable IDirect3DSurface9 to the guest.
     */
    const createStandaloneSurface = (
        pDevice: number,
        widthArg: number,
        heightArg: number,
        format: number,
        pool: number,
        usage: number,
        multiSampleType: number,
        multiSampleQuality: number,
        ppSurface: number,
    ): number => {
        const fail = (detail: string): number => {
            recordGraphicsHresultFailure(
                'd3d9:createStandaloneSurface#internal',
                D3DERR_INVALIDCALL,
                0,
                [pDevice, widthArg, heightArg, format, pool, ppSurface],
                6,
                detail,
            );
            return D3DERR_INVALIDCALL;
        };
        if (!ppSurface) return fail('null output pointer');
        initReturnPtr(ppSurface);
        if (format === D3DFMT_UNKNOWN || isDxExclusiveFormat(format, 9)) return fail(`unsupported format ${format >>> 0}`);

        const device = devices.get(pDevice);
        if (!device) return fail(`unknown device 0x${(pDevice >>> 0).toString(16)}`);
        const vtables = getVTables();
        const textureVtable = vtables['IDirect3DTexture9']?.address;
        const surfaceVtable = vtables['IDirect3DSurface9']?.address;
        if (!textureVtable || !surfaceVtable) return fail('missing texture or surface vtable');

        const width = Math.max(1, widthArg >>> 0);
        const height = Math.max(1, heightArg >>> 0);
        const normalizedPool = normalizePalettizedTexturePool(format, pool);
        const texturePtr = createComObject(textureVtable);
        if (!device.createTexture(texturePtr, width, height, 1, format, usage >>> 0)) {
            return fail(`backing texture creation failed: ${device.getLastTextureCreateFailure() ?? 'unknown reason'}`);
        }
        resourceToDevice.set(texturePtr, device);
        textureMeta.set(texturePtr, {
            width,
            height,
            levels: 1,
            usage: usage >>> 0,
            pool: normalizedPool,
            format,
        });

        const surfacePtr = createComObject(surfaceVtable);
        resourceToDevice.set(surfacePtr, device);
        surfaceMeta.set(surfacePtr, {
            format,
            type: D3DRTYPE_SURFACE,
            usage: usage >>> 0,
            pool: normalizedPool,
            multiSampleType,
            multiSampleQuality,
            width,
            height,
            texturePtr,
            level: 0,
        });
        return Mem.writeUint32(ppSurface, surfacePtr) ? D3D_OK : fail(`cannot write output pointer 0x${(ppSurface >>> 0).toString(16)}`);
    };

    exports['IDirect3DDevice9_CreateVertexBuffer'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Length = args[1];
        const Usage = args[2];
        const FVF = args[3];
        const Pool = args[4];
        const ppVertexBuffer = args[5];

        if (!ppVertexBuffer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppVertexBuffer);

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `CreateVertexBuffer: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DVertexBuffer9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DVertexBuffer9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const vbPtr = createComObject(vtableAddr);
        Logger.log(LogCategory.D3D9, `CreateVertexBuffer(Length=${Length}, FVF=0x${FVF.toString(16)}) -> 0x${vbPtr.toString(16)}`);

        const guestPtr = device.createVertexBuffer(vbPtr, Length, FVF);
        if (guestPtr === 0) {
            initReturnPtr(ppVertexBuffer);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(vbPtr, device);

        Mem.writeUint32(ppVertexBuffer, vbPtr);

        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateIndexBuffer'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Length = args[1];
        const Usage = args[2];
        const Format = args[3];
        const Pool = args[4];
        const ppIndexBuffer = args[5];

        if (!ppIndexBuffer) return D3DERR_INVALIDCALL;
        initReturnPtr(ppIndexBuffer);

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `CreateIndexBuffer: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DIndexBuffer9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DIndexBuffer9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const ibPtr = createComObject(vtableAddr);
        Logger.log(LogCategory.D3D9, `CreateIndexBuffer(Length=${Length}, Format=${Format}) -> 0x${ibPtr.toString(16)}`);

        const guestPtr = device.createIndexBuffer(ibPtr, Length, Format);
        if (guestPtr === 0) {
            initReturnPtr(ppIndexBuffer);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(ibPtr, device);

        Mem.writeUint32(ppIndexBuffer, ibPtr);

        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateTexture'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Width = args[1];
        const Height = args[2];
        const Levels = args[3];
        const Usage = args[4];
        const Format = args[5] >>> 0;
        const Pool = args[6];
        const ppTexture = args[7];

        if (!ppTexture) return D3DERR_INVALIDCALL;
        initReturnPtr(ppTexture);

        if (Format === D3DFMT_UNKNOWN || isDxExclusiveFormat(Format, 9)) {
            return D3DERR_INVALIDCALL;
        }

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `CreateTexture: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DTexture9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DTexture9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const width = Math.max(1, Width >>> 0);
        const height = Math.max(1, Height >>> 0);
        const levelCount = Levels !== 0 ? (Levels >>> 0) : computeMipLevelCount(width, height);
        const maxLevels = Math.max(1, levelCount);
        const normalizedPool = normalizePalettizedTexturePool(Format, Pool);

        const texPtr = createComObject(vtableAddr);
        Logger.log(LogCategory.D3D9, `CreateTexture(${Width}x${Height}, Levels=${Levels}, Usage=0x${(Usage>>>0).toString(16)}, Format=${Format}, Pool=${normalizedPool}) -> 0x${texPtr.toString(16)}`);

        const guestPtr = device.createTexture(texPtr, width, height, levelCount, Format, Usage >>> 0);
        if (guestPtr === 0) {
            initReturnPtr(ppTexture);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(texPtr, device);
        textureMeta.set(texPtr, {
            width,
            height,
            levels: maxLevels,
            usage: Usage >>> 0,
            pool: normalizedPool,
            format: Format,
        });

        if (!precreateTextureLevelSurfaces(texPtr, maxLevels)) {
            clearTextureSubresourceSurfaces(texPtr);
            resourceToDevice.delete(texPtr);
            textureMeta.delete(texPtr);
            initReturnPtr(ppTexture);
            return D3DERR_INVALIDCALL;
        }

        Mem.writeUint32(ppTexture, texPtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateCubeTexture'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const EdgeLength = args[1];
        const Levels = args[2];
        const Usage = args[3];
        const Format = args[4] >>> 0;
        const Pool = args[5];
        const ppCubeTexture = args[6];

        if (!ppCubeTexture) return D3DERR_INVALIDCALL;
        initReturnPtr(ppCubeTexture);

        if (Format === D3DFMT_UNKNOWN || isDxExclusiveFormat(Format, 9)) {
            return D3DERR_INVALIDCALL;
        }

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `CreateCubeTexture: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DCubeTexture9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'IDirect3DCubeTexture9 vtable not found!');
            return D3DERR_INVALIDCALL;
        }

        const edge = Math.max(1, EdgeLength >>> 0);
        const levelCount = Levels !== 0 ? (Levels >>> 0) : computeMipLevelCount(edge, edge);
        const maxLevels = Math.max(1, levelCount);
        const normalizedPool = normalizePalettizedTexturePool(Format, Pool);

        const cubePtr = createComObject(vtableAddr);
        Logger.log(LogCategory.D3D9, `CreateCubeTexture(edge=${edge}, Levels=${maxLevels}, Usage=0x${(Usage>>>0).toString(16)}, Format=${Format}, Pool=${normalizedPool}) -> 0x${cubePtr.toString(16)}`);

        const guestPtr = device.createCubeTexture(cubePtr, edge, levelCount, Format, Usage >>> 0);
        if (guestPtr === 0) {
            initReturnPtr(ppCubeTexture);
            return D3DERR_INVALIDCALL;
        }
        resourceToDevice.set(cubePtr, device);
        textureMeta.set(cubePtr, {
            width: edge,
            height: edge,
            levels: maxLevels,
            usage: Usage >>> 0,
            pool: normalizedPool,
            format: Format,
            isCube: true,
        });

        if (!precreateCubeFaceSurfaces(cubePtr, maxLevels)) {
            clearTextureSubresourceSurfaces(cubePtr);
            resourceToDevice.delete(cubePtr);
            textureMeta.delete(cubePtr);
            initReturnPtr(ppCubeTexture);
            return D3DERR_INVALIDCALL;
        }

        Mem.writeUint32(ppCubeTexture, cubePtr);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_CreateRenderTarget'] = (_ctx, _mem, args) => {
        const hr = createStandaloneSurface(
            args[0], args[1], args[2], args[3] >>> 0, D3DPOOL_DEFAULT,
            D3DUSAGE_RENDERTARGET, args[4] >>> 0, args[5] >>> 0, args[7],
        );
        if (hr === D3D_OK) {
            Logger.log(LogCategory.D3D9, `CreateRenderTarget(${args[1]}x${args[2]}, Format=${args[3] >>> 0})`);
        }
        return hr;
    };

    exports['IDirect3DDevice9_CreateOffscreenPlainSurface'] = (_ctx, _mem, args) => {
        const hr = createStandaloneSurface(
            args[0], args[1], args[2], args[3] >>> 0, args[4] >>> 0,
            0, D3DMULTISAMPLE_NONE, 0, args[5],
        );
        if (hr === D3D_OK) {
            Logger.log(LogCategory.D3D9, `CreateOffscreenPlainSurface(${args[1]}x${args[2]}, Format=${args[3] >>> 0}, Pool=${args[4] >>> 0})`);
        }
        return hr;
    };

    exports['IDirect3DDevice9_CreateDepthStencilSurface'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const width = args[1] >>> 0;
        const height = args[2] >>> 0;
        const format = args[3] >>> 0;
        const multiSampleType = args[4] >>> 0;
        const multiSampleQuality = args[5] >>> 0;
        const _discard = args[6];
        const ppSurface = args[7];
        const _pSharedHandle = args[8];

        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);

        const device = devices.get(pDevice);
        if (!device) {
            return D3DERR_INVALIDCALL;
        }

        const vtables = getVTables();
        const vtableAddr = vtables['IDirect3DSurface9']?.address;
        if (!vtableAddr) {
            Logger.error(LogCategory.D3D9, 'CreateDepthStencilSurface: IDirect3DSurface9 vtable not found');
            return D3DERR_INVALIDCALL;
        }

        const w = Math.max(1, width);
        const h = Math.max(1, height);
        const surfacePtr = createComObject(vtableAddr);
        resourceToDevice.set(surfacePtr, device);
        surfaceMeta.set(surfacePtr, {
            format,
            type: D3DRTYPE_SURFACE,
            usage: D3DUSAGE_DEPTHSTENCIL,
            pool: D3DPOOL_DEFAULT,
            multiSampleType,
            multiSampleQuality,
            width: w,
            height: h,
        });

        Logger.log(
            LogCategory.D3D9,
            `CreateDepthStencilSurface(${w}x${h}, Format=${format}, MS=${multiSampleType}) -> 0x${surfacePtr.toString(16)}`,
        );

        return Mem.writeUint32(ppSurface, surfacePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_UpdateSurface'] = (_ctx, _mem, args) => {
        const srcSurfacePtr = args[1] >>> 0;
        const srcRectPtr = args[2] >>> 0;
        const dstSurfacePtr = args[3] >>> 0;
        const dstPointPtr = args[4] >>> 0;
        const src = surfaceMeta.get(srcSurfacePtr);
        const dst = surfaceMeta.get(dstSurfacePtr);
        const srcDevice = resourceToDevice.get(srcSurfacePtr);
        const dstDevice = resourceToDevice.get(dstSurfacePtr);

        if (
            !src || !dst || !src.texturePtr || !dst.texturePtr ||
            !srcDevice || srcDevice !== dstDevice || src.face !== undefined || dst.face !== undefined ||
            src.format !== dst.format
        ) {
            return D3DERR_INVALIDCALL;
        }

        let left = srcRectPtr ? (Mem.readInt32(srcRectPtr) ?? 0) : 0;
        let top = srcRectPtr ? (Mem.readInt32(srcRectPtr + 4) ?? 0) : 0;
        let right = srcRectPtr ? (Mem.readInt32(srcRectPtr + 8) ?? src.width) : src.width;
        let bottom = srcRectPtr ? (Mem.readInt32(srcRectPtr + 12) ?? src.height) : src.height;
        let dstX = dstPointPtr ? (Mem.readInt32(dstPointPtr) ?? 0) : 0;
        let dstY = dstPointPtr ? (Mem.readInt32(dstPointPtr + 4) ?? 0) : 0;

        // Clip defensively. Native D3D rejects invalid rectangles, but clipping here
        // keeps old games from turning a harmless edge rectangle into a guest-memory
        // overrun while preserving the pixels that are inside both surfaces.
        if (left < 0) { dstX -= left; left = 0; }
        if (top < 0) { dstY -= top; top = 0; }
        right = Math.min(src.width, right);
        bottom = Math.min(src.height, bottom);
        if (dstX < 0) { left -= dstX; dstX = 0; }
        if (dstY < 0) { top -= dstY; dstY = 0; }
        const width = Math.min(right - left, dst.width - dstX);
        const height = Math.min(bottom - top, dst.height - dstY);
        if (width <= 0 || height <= 0) return D3D_OK;

        const srcLevel = src.level ?? 0;
        const dstLevel = dst.level ?? 0;
        const srcPixels = srcDevice.getTextureLevelPixels(src.texturePtr, srcLevel);
        const dstPixels = dstDevice.getTextureLevelPixels(dst.texturePtr, dstLevel);
        if (!srcPixels || !dstPixels) return D3DERR_INVALIDCALL;

        const srcLayout = getD3DTextureLayout(src.format, src.width, src.height);
        const dstLayout = getD3DTextureLayout(dst.format, dst.width, dst.height);
        if (srcLayout.compressed !== dstLayout.compressed) return D3DERR_INVALIDCALL;

        if (srcLayout.compressed) {
            if (srcLayout.blockBytes !== dstLayout.blockBytes) return D3DERR_INVALIDCALL;
            const blockBytes = srcLayout.blockBytes;
            const srcBlockX = left >> 2;
            const srcBlockY = top >> 2;
            const dstBlockX = dstX >> 2;
            const dstBlockY = dstY >> 2;
            const blockRows = (height + 3) >> 2;
            const rowBytes = ((width + 3) >> 2) * blockBytes;
            for (let row = 0; row < blockRows; row++) {
                const srcOffset = (srcBlockY + row) * srcPixels.pitch + srcBlockX * blockBytes;
                const dstOffset = (dstBlockY + row) * dstPixels.pitch + dstBlockX * blockBytes;
                const copy = srcPixels.data.slice(srcOffset, srcOffset + rowBytes);
                dstPixels.data.set(copy, dstOffset);
            }
        } else {
            const bytesPerPixel = Math.max(1, Math.floor(srcLayout.pitch / Math.max(1, src.width)));
            const rowBytes = width * bytesPerPixel;
            for (let row = 0; row < height; row++) {
                const srcOffset = (top + row) * srcPixels.pitch + left * bytesPerPixel;
                const dstOffset = (dstY + row) * dstPixels.pitch + dstX * bytesPerPixel;
                const copy = srcPixels.data.slice(srcOffset, srcOffset + rowBytes);
                dstPixels.data.set(copy, dstOffset);
            }
        }

        return dstDevice.setTextureLevelPixels(
            dst.texturePtr,
            dstLevel,
            dstPixels.data,
            dstPixels.pitch,
        ) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_CreateQuery'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const _type = args[1];
        const ppQuery = args[2];

        const device = devices.get(pDevice);
        if (!device || !ppQuery) {
            return D3DERR_INVALIDCALL;
        }

        // Query objects are not implemented yet. Report as unavailable instead of thunk-missing.
        Mem.writeUint32(ppQuery, 0);
        return D3DERR_NOTAVAILABLE;
    };

    exports['IDirect3DVertexBuffer9_Lock'] = (ctx, mem, args) => {
        const pVertexBuffer = args[0];
        const OffsetToLock = args[1];
        const SizeToLock = args[2];
        const ppbData = args[3];
        const Flags = args[4];

        const device = resourceToDevice.get(pVertexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Lock: invalid buffer ${pVertexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        if (Logger.isEnabled(LogCategory.D3D9, LogLevel.VERBOSE)) {
            Logger.verbose(LogCategory.D3D9, `VertexBuffer::Lock(Offset=${OffsetToLock}, Size=${SizeToLock})`);
        }

        const dataPtr = device.lockVertexBuffer(pVertexBuffer, OffsetToLock, SizeToLock);
        if (dataPtr === 0) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Lock failed for 0x${pVertexBuffer.toString(16)}`);
            if (ppbData) Mem.writeUint32(ppbData, 0);
            return D3DERR_INVALIDCALL;
        }
        if (Logger.isEnabled(LogCategory.D3D9, LogLevel.NORMAL)) {
            Logger.log(LogCategory.D3D9, `VertexBuffer::Lock -> guest ptr 0x${dataPtr.toString(16)}`);
        }

        if (ppbData) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppbData, dataPtr, true);
        }

        return D3D_OK;
    };

    exports['IDirect3DVertexBuffer9_Unlock'] = (ctx, mem, args) => {
        const pVertexBuffer = args[0];

        const device = resourceToDevice.get(pVertexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `VertexBuffer::Unlock: invalid buffer ${pVertexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'VertexBuffer::Unlock()');
        device.unlockVertexBuffer(pVertexBuffer, mem);
        return D3D_OK;
    };

    exports['IDirect3DIndexBuffer9_Lock'] = (ctx, mem, args) => {
        const pIndexBuffer = args[0];
        const OffsetToLock = args[1];
        const SizeToLock = args[2];
        const ppbData = args[3];
        const Flags = args[4];

        const device = resourceToDevice.get(pIndexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Lock: invalid buffer ${pIndexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        if (Logger.isEnabled(LogCategory.D3D9, LogLevel.VERBOSE)) {
            Logger.verbose(LogCategory.D3D9, `IndexBuffer::Lock(Offset=${OffsetToLock}, Size=${SizeToLock})`);
        }

        const dataPtr = device.lockIndexBuffer(pIndexBuffer, OffsetToLock, SizeToLock);
        if (dataPtr === 0) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Lock failed for 0x${pIndexBuffer.toString(16)}`);
            if (ppbData) Mem.writeUint32(ppbData, 0);
            return D3DERR_INVALIDCALL;
        }
        if (Logger.isEnabled(LogCategory.D3D9, LogLevel.NORMAL)) {
            Logger.log(LogCategory.D3D9, `IndexBuffer::Lock -> guest ptr 0x${dataPtr.toString(16)}`);
        }

        if (ppbData) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(ppbData, dataPtr, true);
        }

        return D3D_OK;
    };

    exports['IDirect3DIndexBuffer9_Unlock'] = (ctx, mem, args) => {
        const pIndexBuffer = args[0];

        const device = resourceToDevice.get(pIndexBuffer);
        if (!device) {
            Logger.error(LogCategory.D3D9, `IndexBuffer::Unlock: invalid buffer ${pIndexBuffer}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'IndexBuffer::Unlock()');
        device.unlockIndexBuffer(pIndexBuffer, mem);
        return D3D_OK;
    };

    exports['IDirect3DTexture9_LockRect'] = (ctx, mem, args) => {
        const pTexture = args[0];
        const Level = args[1];
        const pLockedRect = args[2];
        const pRect = args[3];
        const Flags = args[4];

        const device = resourceToDevice.get(pTexture);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Texture::LockRect: invalid texture ${pTexture}`);
            return D3DERR_INVALIDCALL;
        }
        if (!pLockedRect) {
            Logger.error(LogCategory.D3D9, `Texture::LockRect: pLockedRect is NULL (tex=0x${pTexture.toString(16)})`);
            return D3DERR_INVALIDCALL;
        }

        if (Logger.isEnabled(LogCategory.D3D9, LogLevel.VERBOSE)) {
            Logger.verbose(LogCategory.D3D9, `Texture::LockRect(Level=${Level})`);
        }

        if (pRect && pRect > mem.length - 16) return D3DERR_INVALIDCALL;
        const rect = pRect ? {
            left: Mem.readInt32(pRect) ?? 0,
            top: Mem.readInt32(pRect + 4) ?? 0,
            right: Mem.readInt32(pRect + 8) ?? 0,
            bottom: Mem.readInt32(pRect + 12) ?? 0,
        } : null;
        const lockInfo = device.lockTexture(pTexture, Level, rect, Flags);
        if (!lockInfo) {
            Logger.error(LogCategory.D3D9, `Texture::LockRect failed for 0x${pTexture.toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        let pBits = lockInfo.ptr >>> 0;
        if (pRect) {
            const meta = textureMeta.get(pTexture);
            const dims = meta
                ? getTextureLevelDims(meta.width, meta.height, Level)
                : { width: 1, height: 1 };
            const format = meta?.format ?? D3DFMT_A8R8G8B8;
            const left = Mem.readInt32(pRect) ?? 0;
            const top = Mem.readInt32(pRect + 4) ?? 0;
            pBits = (pBits + computeLockRectOffset(format, dims.width, dims.height, lockInfo.pitch, left, top)) >>> 0;
        }

        // Fill D3DLOCKED_RECT structure
        const wrotePitch = Mem.writeUint32(pLockedRect, lockInfo.pitch);
        const wroteBits = Mem.writeUint32(pLockedRect + 4, pBits);
        if (!wrotePitch || !wroteBits) {
            Logger.error(LogCategory.D3D9, `Texture::LockRect: failed to write D3DLOCKED_RECT @0x${pLockedRect.toString(16)}`);
            device.unlockTexture(pTexture, Level, mem);
            return D3DERR_INVALIDCALL;
        }

        return D3D_OK;
    };

    exports['IDirect3DTexture9_UnlockRect'] = (ctx, mem, args) => {
        const pTexture = args[0];
        const Level = args[1];

        const device = resourceToDevice.get(pTexture);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Texture::UnlockRect: invalid texture ${pTexture}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `Texture::UnlockRect(Level=${Level})`);
        device.unlockTexture(pTexture, Level, mem);
        return D3D_OK;
    };

    exports['IDirect3DTexture9_GetLevelCount'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        return textureMeta.get(pTexture)?.levels ?? 1;
    };

    exports['IDirect3DTexture9_GetType'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        return resourceToDevice.has(pTexture) ? D3DRTYPE_TEXTURE : D3DRTYPE_UNKNOWN;
    };

    exports['IDirect3DTexture9_GetLevelDesc'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        const level = args[1] >>> 0;
        const pDesc = args[2];
        if (!pDesc) return D3DERR_INVALIDCALL;

        const meta = textureMeta.get(pTexture);
        if (!meta || level >= meta.levels) {
            return D3DERR_INVALIDCALL;
        }

        const dims = getTextureLevelDims(meta.width, meta.height, level);
        const ok = writeSurfaceDesc(pDesc, {
            format: meta.format,
            type: D3DRTYPE_SURFACE,
            usage: meta.usage,
            pool: meta.pool,
            multiSampleType: D3DMULTISAMPLE_NONE,
            multiSampleQuality: 0,
            width: dims.width,
            height: dims.height,
        });
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DTexture9_GetSurfaceLevel'] = (_ctx, _mem, args) => {
        const pTexture = args[0];
        const level = args[1] >>> 0;
        const ppSurfaceLevel = args[2];
        if (!ppSurfaceLevel) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurfaceLevel);

        const meta = textureMeta.get(pTexture);
        if (!meta || meta.isCube || level >= meta.levels) {
            return D3DERR_INVALIDCALL;
        }

        const surfacePtr = ensureTextureLevelSurface(pTexture, level);
        if (!surfacePtr) return D3DERR_INVALIDCALL;

        return Mem.writeUint32(ppSurfaceLevel, surfacePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    // ── IDirect3DCubeTexture9 ────────────────────────────────────────────────
    // A cube texture is one resource with 6 faces (CubeMapFace 0..5). GetCubeMapSurface
    // hands back a per-face IDirect3DSurface9 (used as a render target for reflection probes);
    // LockRect/UnlockRect take an extra FaceType selector vs the 2D texture methods.

    exports['IDirect3DCubeTexture9_GetCubeMapSurface'] = (_ctx, _mem, args) => {
        const pCube = args[0];
        const faceType = args[1] >>> 0;
        const level = args[2] >>> 0;
        const ppSurface = args[3];
        if (!ppSurface) return D3DERR_INVALIDCALL;
        initReturnPtr(ppSurface);

        const meta = textureMeta.get(pCube);
        if (!meta || !meta.isCube || faceType > 5 || level >= meta.levels) {
            return D3DERR_INVALIDCALL;
        }

        const surfacePtr = ensureCubeFaceSurface(pCube, faceType, level);
        if (!surfacePtr) return D3DERR_INVALIDCALL;

        return Mem.writeUint32(ppSurface, surfacePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DCubeTexture9_LockRect'] = (_ctx, mem, args) => {
        const pCube = args[0];
        const faceType = args[1] >>> 0;
        const level = args[2] >>> 0;
        const pLockedRect = args[3];
        const pRect = args[4];

        const device = resourceToDevice.get(pCube);
        if (!device || !pLockedRect || faceType > 5) {
            return D3DERR_INVALIDCALL;
        }

        const lockInfo = device.lockCubeFace(pCube, faceType, level);
        if (!lockInfo) return D3DERR_INVALIDCALL;

        let pBits = lockInfo.ptr >>> 0;
        if (pRect) {
            const meta = textureMeta.get(pCube);
            const dim = Math.max(1, (meta?.width ?? 1) >>> level);
            const format = meta?.format ?? D3DFMT_A8R8G8B8;
            const left = Mem.readInt32(pRect) ?? 0;
            const top = Mem.readInt32(pRect + 4) ?? 0;
            pBits = (pBits + computeLockRectOffset(format, dim, dim, lockInfo.pitch, left, top)) >>> 0;
        }

        const wrotePitch = Mem.writeUint32(pLockedRect + 0, lockInfo.pitch >>> 0);
        const wroteBits = Mem.writeUint32(pLockedRect + 4, pBits);
        if (!wrotePitch || !wroteBits) {
            device.unlockCubeFace(pCube, faceType, level, mem);
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    exports['IDirect3DCubeTexture9_UnlockRect'] = (_ctx, mem, args) => {
        const pCube = args[0];
        const faceType = args[1] >>> 0;
        const level = args[2] >>> 0;

        const device = resourceToDevice.get(pCube);
        if (!device || faceType > 5) return D3DERR_INVALIDCALL;

        device.unlockCubeFace(pCube, faceType, level, mem);
        return D3D_OK;
    };

    exports['IDirect3DCubeTexture9_GetLevelCount'] = (_ctx, _mem, args) => {
        return textureMeta.get(args[0])?.levels ?? 1;
    };

    exports['IDirect3DCubeTexture9_GetType'] = (_ctx, _mem, args) => {
        const meta = textureMeta.get(args[0]);
        return meta?.isCube ? D3DRTYPE_CUBETEXTURE : D3DRTYPE_UNKNOWN;
    };

    exports['IDirect3DCubeTexture9_GetLevelDesc'] = (_ctx, _mem, args) => {
        const pCube = args[0];
        const level = args[1] >>> 0;
        const pDesc = args[2];
        if (!pDesc) return D3DERR_INVALIDCALL;

        const meta = textureMeta.get(pCube);
        if (!meta || !meta.isCube || level >= meta.levels) return D3DERR_INVALIDCALL;

        const dim = Math.max(1, meta.width >>> level);
        const ok = writeSurfaceDesc(pDesc, {
            format: meta.format,
            type: D3DRTYPE_SURFACE,
            usage: meta.usage,
            pool: meta.pool,
            multiSampleType: D3DMULTISAMPLE_NONE,
            multiSampleQuality: 0,
            width: dim,
            height: dim,
        });
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DCubeTexture9_GetDevice'] = (_ctx, _mem, args) => {
        const pCube = args[0];
        const ppDevice = args[1];
        if (!ppDevice) return D3DERR_INVALIDCALL;
        initReturnPtr(ppDevice);

        const device = resourceToDevice.get(pCube);
        if (!device) return D3DERR_INVALIDCALL;
        const devicePtr = resolveDevicePtr(device);
        if (!devicePtr) return D3DERR_INVALIDCALL;
        return Mem.writeUint32(ppDevice, devicePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DCubeTexture9_AddDirtyRect'] = () => D3D_OK;

    exports['IDirect3DSurface9_LockRect'] = (ctx, mem, args) => {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const esp = ctx?.esp >>> 0;
        const caller = esp <= mem.length - 4 ? view.getUint32(esp, true) : 0;
        return lockSurfaceRectDirect(mem, view, args[0], args[1], args[2], args[3], caller);
    };

    exports['IDirect3DSurface9_UnlockRect'] = (_ctx, mem, args) => {
        return unlockSurfaceRectDirect(mem, args[0]);
    };

    exports['IDirect3DSurface9_GetDesc'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const pDesc = args[1];

        Logger.verbose(LogCategory.D3D9, 'Surface::GetDesc()');

        // Fill D3DSURFACE_DESC structure
        if (pDesc) {
            const meta = surfaceMeta.get(pSurface);
            const ok = writeSurfaceDesc(pDesc, meta ?? {
                format: D3DFMT_A8R8G8B8,
                type: D3DRTYPE_SURFACE,
                usage: 0,
                pool: D3DPOOL_DEFAULT,
                multiSampleType: D3DMULTISAMPLE_NONE,
                multiSampleQuality: 0,
                width: 1024,
                height: 768,
            });
            if (!ok) return D3DERR_INVALIDCALL;
        }

        return D3D_OK;
    };

    exports['IDirect3DSurface9_GetDevice'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const ppDevice = args[1];

        Logger.verbose(LogCategory.D3D9, 'Surface::GetDevice()');

        if (!ppDevice) return D3DERR_INVALIDCALL;
        initReturnPtr(ppDevice);

        const device = resourceToDevice.get(pSurface);
        if (!device) return D3DERR_INVALIDCALL;

        const devicePtr = resolveDevicePtr(device);
        if (!devicePtr) return D3DERR_INVALIDCALL;

        return Mem.writeUint32(ppDevice, devicePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DSurface9_GetDC'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const phdc = args[1];

        Logger.verbose(LogCategory.D3D9, 'Surface::GetDC()');

        // Overlay should persist between frames and only be cleared on explicit Clear() calls
        // No need to clear overlay automatically here

        // Create a real DC on the overlay canvas for GDI compositing
        const gdiContext = System.getInstance().gdiContext;
        const hdc = gdiContext.createOverlayDC();

        if (hdc === 0) {
            Logger.error(LogCategory.D3D9, 'Surface::GetDC: Failed to create overlay DC');
            return D3DERR_INVALIDCALL;
        }

        if (phdc) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(phdc, hdc, true);
        }

        Logger.verbose(LogCategory.D3D9, `Surface::GetDC() -> HDC 0x${hdc.toString(16)}`);
        return D3D_OK;
    };

    exports['IDirect3DSurface9_ReleaseDC'] = (ctx, mem, args) => {
        const pSurface = args[0];
        const hdc = args[1];

        Logger.verbose(LogCategory.D3D9, `Surface::ReleaseDC(HDC=0x${hdc.toString(16)})`);

        // Release the DC
        const gdiContext = System.getInstance().gdiContext;
        gdiContext.releaseDC(hdc);

        return D3D_OK;
    };

    return exports;
}
