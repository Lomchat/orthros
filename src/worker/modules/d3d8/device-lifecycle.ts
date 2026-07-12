/**
 * D3D8 device lifecycle helpers — implicit depth-stencil on CreateDevice/Reset.
 */

import { System } from '../../core/system';
import { Logger, LogCategory } from '../../core/logger';
import { windows as sharedWindows } from '../user32/shared-state';
import {
    createComObject,
    deviceBackBufferSurfaces,
    deviceBoundDepthStencil,
    deviceRenderTargetOverride,
    devices,
    forgetComObject,
    getVTables,
    implicitDepthStencils,
    resourceToDevice,
    surfaceInfo,
} from './shared-state';
import type { D3D8SurfaceInfo } from './shared-state';
import { D3D8DeviceAdapter } from '../../backends/webgpu/d3d8/d3d8-device-adapter';
import { createTextureSurface } from '../../backends/webgpu/shared/surface-factory';
import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';
import { isD3D8DepthStencilFormat } from './format-support';

const D3DFMT_D24S8 = 75;
const D3DFMT_X8R8G8B8 = 22;

/**
 * Return the stable IDirect3DSurface8 COM wrapper for a device's swap-chain back buffer.
 * The wrapper is cached per device; LockRect resolves the live GPU render target via role.
 */
export function ensureBackBufferSurface(devicePtr: number, device: D3D8DeviceAdapter): number {
    const existing = deviceBackBufferSurfaces.get(devicePtr >>> 0);
    if (existing !== undefined && surfaceInfo.has(existing)) {
        return existing;
    }

    const vtableAddr = getVTables()['IDirect3DSurface8']?.address;
    if (!vtableAddr) return 0;

    const rt = device.renderTarget;
    const surfPtr = createComObject(vtableAddr);
    deviceBackBufferSurfaces.set(devicePtr >>> 0, surfPtr);
    resourceToDevice.set(surfPtr, device);
    surfaceInfo.set(surfPtr, {
        texturePtr: 0,
        level: 0,
        surface: rt,
        d3dFormat: D3DFMT_X8R8G8B8,
        role: 'backbuffer',
    });
    Logger.log(LogCategory.SYSTEM,
        `D3D8 back buffer surface ${rt.width}x${rt.height} -> 0x${surfPtr.toString(16)}`);
    return surfPtr;
}

/** Drop cached presentation-surface state after Reset (back buffer is reallocated). */
export function invalidateDevicePresentationSurfaces(devicePtr: number): void {
    deviceRenderTargetOverride.delete(devicePtr >>> 0);
    const bb = deviceBackBufferSurfaces.get(devicePtr >>> 0);
    if (bb !== undefined) {
        surfaceInfo.delete(bb);
        resourceToDevice.delete(bb);
        forgetComObject(bb);
        deviceBackBufferSurfaces.delete(devicePtr >>> 0);
    }
}

/**
 * Release the implicit depth-stencil we previously created for this device, if any.
 * The implicit DS is device-owned and recreated on every CreateDevice/Reset; without
 * this, each Reset leaks a surfaceInfo/COM/resourceToDevice entry. Only ptrs we created
 * are destroyed — an app-set DS (via SetRenderTarget) is never touched.
 */
function destroyImplicitDepthStencil(devicePtr: number): void {
    const prev = deviceBoundDepthStencil.get(devicePtr) ?? 0;
    if (prev !== 0 && implicitDepthStencils.has(prev)) {
        surfaceInfo.delete(prev);
        resourceToDevice.delete(prev);
        forgetComObject(prev);
        implicitDepthStencils.delete(prev);
    }
}

/**
 * Resize the device's focus/device window to the back-buffer size for a FULLSCREEN device.
 *
 * Faithful to real D3D8: creating a device with Windowed==FALSE puts the focus window into
 * the device's display mode — Windows resizes the window's client area to the back-buffer
 * resolution. Apps rely on this (they create a small/default window, then GetClientRect /
 * GetWindowRect to read the now-fullscreen size). GTA III's RenderWare camera frame-buffer
 * raster create (_rwD3D8RasterCreate, rwRASTERTYPECAMERA) rejects a camera larger than the
 * client rect: GetClientRect(hwnd) < cameraSize -> RwRasterCreate FALSE -> CreateCamera fails
 * -> Initialise3D returns 0 -> the game DestroyWindow()s and ExitProcess(0)es at startup.
 *
 * We only resized the host canvas (requestHostResize) on CreateDevice, never the tracked
 * window rect that GetClientRect reads, so a fullscreen game's window stayed at its small
 * creation size. This mirrors DDraw's resizeFullscreenWindow (directdraw.ts): update the
 * WindowManager rect + the shared-state WindowInfo (read by GetClientRect) + post WM_SIZE.
 * Generic across every fullscreen D3D8 title — never a per-game branch.
 */
export function resizeFullscreenDeviceWindow(hwnd: number, width: number, height: number): void {
    if (!hwnd || width <= 0 || height <= 0) return;
    const system = System.getInstance();

    const winObj = system.windowManager?.getWindow(hwnd);
    if (winObj) {
        winObj.rect.x = 0;
        winObj.rect.y = 0;
        winObj.rect.w = width;
        winObj.rect.h = height;
    }

    // The map GetClientRect/GetWindowRect actually read (user32 shared-state WindowInfo).
    const sharedWin = sharedWindows.get(hwnd);
    if (sharedWin) {
        sharedWin.x = 0;
        sharedWin.y = 0;
        sharedWin.width = width;
        sharedWin.height = height;
    }

    if (!winObj && !sharedWin) return;

    // Let the game update its viewport/projection (mirrors real Windows fullscreen switch).
    system.windowManager?.postMessage(hwnd, 0x0005 /* WM_SIZE */, 0 /* SIZE_RESTORED */,
        ((width & 0xFFFF) | ((height & 0xFFFF) << 16)) >>> 0);
    Logger.log(LogCategory.SYSTEM,
        `D3D8 fullscreen window resize: hwnd=0x${hwnd.toString(16)} -> ${width}x${height}`);
}

/** Bind the implicit depth-stencil surface when EnableAutoDepthStencil is set. */
export function bindAutoDepthStencil(devicePtr: number, mem: Uint8Array, pPresentationParameters: number): void {
    if (!pPresentationParameters) return;

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const enableAutoDS = view.getUint32(pPresentationParameters + 32, true);
    const device = devices.get(devicePtr);
    if (!device) return;

    destroyImplicitDepthStencil(devicePtr);

    if (!enableAutoDS) {
        device.depthStencilSurfacePtr = 0;
        deviceBoundDepthStencil.delete(devicePtr);
        return;
    }

    const vtableAddr = getVTables()['IDirect3DSurface8']?.address;
    if (!vtableAddr) {
        Logger.error(LogCategory.SYSTEM, 'D3D8 auto depth-stencil: IDirect3DSurface8 vtable not found');
        return;
    }

    const w = Math.max(1, view.getUint32(pPresentationParameters + 0, true) || 800);
    const h = Math.max(1, view.getUint32(pPresentationParameters + 4, true) || 600);
    let format = view.getUint32(pPresentationParameters + 36, true) >>> 0;
    if (!isD3D8DepthStencilFormat(format)) format = D3DFMT_D24S8;

    const process = System.getInstance().process;
    if (!process) return;

    const surface = createTextureSurface(w, h, format);
    surface.surfacePtr = process.memory.alloc(getD3DTextureLayout(format, w, h).bytes);

    const surfPtr = createComObject(vtableAddr);
    resourceToDevice.set(surfPtr, device);
    const info: D3D8SurfaceInfo = {
        texturePtr: 0,
        level: 0,
        surface,
        d3dFormat: format,
    };
    surfaceInfo.set(surfPtr, info);

    device.depthStencilSurfacePtr = surfPtr;
    deviceBoundDepthStencil.set(devicePtr, surfPtr);
    implicitDepthStencils.add(surfPtr);
    Logger.log(LogCategory.SYSTEM, `D3D8 auto depth-stencil ${w}x${h} fmt=${format} -> 0x${surfPtr.toString(16)}`);
}
