/**
 * D3D9 Device functions
 *
 * Atomic implementation for Direct3D device operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { EmulatorConfig } from '../../core/emulator-config-manager';
import { gammaService } from '../../core/gamma-service';
import { D3D9Device } from '../../backends/webgpu/d3d9/d3d9-device';
import { WebGPUBackend } from '../../backends/webgpu/webgpu-backend';
import { writeDeviceCaps9 } from './caps';
import { getVTables, devices, createComObject, resourceToDevice, deviceToD3D9 } from './shared-state';
import {
    deviceBoundDepthStencil,
    deviceBoundRenderTargets,
    deviceImplicitBackBuffer,
    deviceSoftwareVertexProcessing,
    surfaceMeta,
} from './resource-registry';
import { syncExclusiveDisplayWindow } from '../user32/shared-state';

const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;

const D3DRTYPE_SURFACE = 1;
const D3DUSAGE_DEPTHSTENCIL = 0x2;
const D3DPOOL_DEFAULT = 0;
const D3DFMT_D24S8 = 75;

// D3DPRESENT_PARAMETERS field offsets.
const PP_BACKBUFFER_WIDTH = 0;
const PP_BACKBUFFER_HEIGHT = 4;
const PP_BACKBUFFER_FORMAT = 8;
const PP_MULTISAMPLE_TYPE = 16;
const PP_MULTISAMPLE_QUALITY = 20;
const PP_DEVICE_WINDOW = 28;
const PP_WINDOWED = 32;
const PP_ENABLE_AUTO_DEPTHSTENCIL = 36;
const PP_AUTO_DEPTHSTENCIL_FORMAT = 40;

function formatForBpp(bpp: number): number {
    return bpp <= 16 ? D3DFMT_R5G6B5 : D3DFMT_X8R8G8B8;
}

/**
 * Create the swap-chain's implicit render-target surface. D3D9 exposes this as
 * a real IDirect3DSurface9 from both GetBackBuffer and GetRenderTarget(0).
 * Keeping one stable COM pointer is important: games save it, render to an
 * off-screen texture, then pass the saved surface back to SetRenderTarget.
 */
function bindImplicitBackBuffer(device: D3D9Device, devicePtr: number, mem: Uint8Array, pPresentationParameters: number): void {
    const oldPtr = deviceImplicitBackBuffer.get(devicePtr);
    if (oldPtr) {
        surfaceMeta.delete(oldPtr);
        resourceToDevice.delete(oldPtr);
    }

    const vtableAddr = getVTables()['IDirect3DSurface9']?.address;
    if (!vtableAddr) {
        Logger.error(LogCategory.D3D9, 'implicit backbuffer: IDirect3DSurface9 vtable not found');
        return;
    }

    let width = 800;
    let height = 600;
    let format = D3DFMT_X8R8G8B8;
    let multiSampleType = 0;
    let multiSampleQuality = 0;
    if (pPresentationParameters) {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        width = Math.max(1, view.getUint32(pPresentationParameters + PP_BACKBUFFER_WIDTH, true) || width);
        height = Math.max(1, view.getUint32(pPresentationParameters + PP_BACKBUFFER_HEIGHT, true) || height);
        format = view.getUint32(pPresentationParameters + PP_BACKBUFFER_FORMAT, true) || format;
        multiSampleType = view.getUint32(pPresentationParameters + PP_MULTISAMPLE_TYPE, true);
        multiSampleQuality = view.getUint32(pPresentationParameters + PP_MULTISAMPLE_QUALITY, true);
    }

    const surfacePtr = createComObject(vtableAddr);
    resourceToDevice.set(surfacePtr, device);
    surfaceMeta.set(surfacePtr, {
        format,
        type: D3DRTYPE_SURFACE,
        usage: 0x1, // D3DUSAGE_RENDERTARGET
        pool: D3DPOOL_DEFAULT,
        multiSampleType,
        multiSampleQuality,
        width,
        height,
    });
    deviceImplicitBackBuffer.set(devicePtr, surfacePtr);
    deviceBoundRenderTargets.set(devicePtr, new Map([[0, surfacePtr]]));
    Logger.log(LogCategory.D3D9, `implicit backbuffer ${width}x${height} fmt=${format} -> 0x${surfacePtr.toString(16)} (RT0)`);
}

/**
 * Faithful auto depth-stencil: a device created (or Reset) with
 * EnableAutoDepthStencil=TRUE gets an IMPLICIT depth-stencil surface that
 * IDirect3DDevice9::GetDepthStencilSurface returns. Games retrieve it (e.g. to
 * Release it during a mode-switch teardown) and assume it is non-NULL — without
 * it GetDepthStencilSurface returns 0 and the game's teardown loop calls Release
 * on a NULL pointer → access violation (NFSU's resolution-change crash). Creates
 * a surface object identical to CreateDepthStencilSurface and binds it as the
 * device's current depth-stencil.
 */
function bindAutoDepthStencil(device: D3D9Device, devicePtr: number, mem: Uint8Array, pPresentationParameters: number): void {
    if (!pPresentationParameters) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const enableAutoDS = view.getUint32(pPresentationParameters + PP_ENABLE_AUTO_DEPTHSTENCIL, true);
    if (!enableAutoDS) {
        // No implicit DS — clear any stale binding so Get returns NULL faithfully.
        deviceBoundDepthStencil.delete(devicePtr);
        return;
    }
    const vtableAddr = getVTables()['IDirect3DSurface9']?.address;
    if (!vtableAddr) {
        Logger.error(LogCategory.D3D9, 'auto depth-stencil: IDirect3DSurface9 vtable not found');
        return;
    }
    const w = Math.max(1, view.getUint32(pPresentationParameters + PP_BACKBUFFER_WIDTH, true) || 800);
    const h = Math.max(1, view.getUint32(pPresentationParameters + PP_BACKBUFFER_HEIGHT, true) || 600);
    const format = view.getUint32(pPresentationParameters + PP_AUTO_DEPTHSTENCIL_FORMAT, true) || D3DFMT_D24S8;

    const surfacePtr = createComObject(vtableAddr);
    resourceToDevice.set(surfacePtr, device);
    surfaceMeta.set(surfacePtr, {
        format,
        type: D3DRTYPE_SURFACE,
        usage: D3DUSAGE_DEPTHSTENCIL,
        pool: D3DPOOL_DEFAULT,
        multiSampleType: 0,
        multiSampleQuality: 0,
        width: w,
        height: h,
    });
    deviceBoundDepthStencil.set(devicePtr, surfacePtr);
    Logger.log(LogCategory.D3D9, `auto depth-stencil ${w}x${h} fmt=${format} -> 0x${surfacePtr.toString(16)} (bound)`);
}

export function createDeviceExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const D3D_OK = 0;
    const D3DERR_INVALIDCALL = 0x8876086c;

    // Gamma — SetGammaRamp(iSwapChain, Flags, pRamp); GetGammaRamp(iSwapChain, pRamp).
    // Routed to the shared RAMDAC LUT sink so the D3D9 brightness slider actually works.
    exports['IDirect3DDevice9_SetGammaRamp'] = (_ctx, mem, args) => {
        gammaService.applyFromGuest(mem, args[3]);
        return D3D_OK;
    };
    exports['IDirect3DDevice9_GetGammaRamp'] = (_ctx, mem, args) => {
        gammaService.writeToGuest(mem, args[2]);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_TestCooperativeLevel'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        return devices.has(pDevice) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_GetAvailableTextureMem'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        if (!devices.has(pDevice)) return 0;
        // Report a stable non-zero budget to satisfy legacy probes.
        return 256 * 1024 * 1024;
    };

    exports['IDirect3DDevice9_EvictManagedResources'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        return devices.has(pDevice) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetSoftwareVertexProcessing'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        if (!devices.has(pDevice)) return D3DERR_INVALIDCALL;
        deviceSoftwareVertexProcessing.set(pDevice, args[1] !== 0);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetSoftwareVertexProcessing'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        return devices.has(pDevice) && deviceSoftwareVertexProcessing.get(pDevice) ? 1 : 0;
    };

    exports['IDirect3D9_CreateDevice'] = async (ctx, mem, args) => {
        const pD3D9 = args[0];
        const Adapter = args[1];
        const DeviceType = args[2];
        const hFocusWindow = args[3];
        const BehaviorFlags = args[4];
        const pPresentationParameters = args[5];
        const ppReturnedDeviceInterface = args[6];

        Logger.log(LogCategory.D3D9, `IDirect3D9_CreateDevice(Adapter=${Adapter}, DeviceType=${DeviceType})`);

        try {
            const system = System.getInstance();
            const process = system.process;
            if (!process || !process.canvas) {
                Logger.error(LogCategory.D3D9, 'CreateDevice: Process or canvas not available');
                return D3DERR_INVALIDCALL;
            }

            // Get or create WebGPU backend
            let backend = system.services.render.getBackend() as WebGPUBackend | null;
            if (!backend || backend.kind !== 'webgpu') {
                backend = new WebGPUBackend();
                await backend.initialize(process.canvas);
                system.services.render.setBackend(backend);
            }

            // Create D3D9Device instance
            const device = new D3D9Device(backend, process.getCurrentMemory());

            // Establish backbuffer size from present params (single source of truth
            // for resolution: host canvas + viewport + XYZRHW NDC divisor must agree).
            // Mirrors the D3D8 CreateDevice path; without it the device kept its
            // 800x600 default while the canvas was sized elsewhere -> 2D squish.
            if (pPresentationParameters) {
                const ppView = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const bbWidth = ppView.getUint32(pPresentationParameters + 0, true);
                const bbHeight = ppView.getUint32(pPresentationParameters + 4, true);
                const deviceWindow = ppView.getUint32(pPresentationParameters + PP_DEVICE_WINDOW, true) || hFocusWindow;
                const windowed = ppView.getUint32(pPresentationParameters + PP_WINDOWED, true) !== 0;
                Logger.log(LogCategory.D3D9, `CreateDevice backbuffer ${bbWidth}x${bbHeight}`);
                device.setBackBufferSize(bbWidth, bbHeight);
                if (!windowed && bbWidth > 0 && bbHeight > 0) {
                    const targetWindow = deviceWindow || system.windowManager.getActiveHwnd();
                    syncExclusiveDisplayWindow(targetWindow, bbWidth, bbHeight);
                }
            }

            // Get or create vtables
            const vtables = getVTables();
            
            // Get IDirect3DDevice9 vtable address
            const vtableAddr = vtables['IDirect3DDevice9']?.address;
            if (!vtableAddr) {
                Logger.error(LogCategory.D3D9, 'IDirect3DDevice9 vtable not found!');
                return D3DERR_INVALIDCALL;
            }

            // Create COM object in memory for device
            const devicePtr = createComObject(vtableAddr);
            
            // Store device instance mapped to COM object pointer
            devices.set(devicePtr, device);
            deviceToD3D9.set(devicePtr, pD3D9);

            // Bind this device as the active owner of the guest-side setter-shadow trampolines and
            // re-sentinel their shadow tables: a fresh device has a fresh JS state-of-record, so a
            // stale shadow left over from a prior device would wrongly skip a needed set. (Coherence
            // invariant for dispatcher.registerShadowedWriteBufferFunction / writeShadowTrampoline.)
            try {
                const disp = System.getInstance().process?.dispatcher as {
                    setShadowOwner?: (p: number) => void;
                    resetShadow?: (dll: string, fn: string) => void;
                } | undefined;
                disp?.setShadowOwner?.(devicePtr);
                disp?.resetShadow?.('d3d9', 'IDirect3DDevice9_SetRenderState');
                disp?.resetShadow?.('d3d9', 'IDirect3DDevice9_SetSamplerState');
                disp?.resetShadow?.('d3d9', 'IDirect3DDevice9_SetTextureStageState');
                disp?.resetShadow?.('d3d9', 'IDirect3DDevice9_SetTexture');
                disp?.resetShadow?.('d3d9', 'IDirect3DDevice9_SetFVF');
            } catch { /* non-fatal */ }

            // Return device interface pointer
            if (ppReturnedDeviceInterface) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppReturnedDeviceInterface, devicePtr, true);
            }

            // Implicit depth-stencil (EnableAutoDepthStencil) — see bindAutoDepthStencil.
            bindImplicitBackBuffer(device, devicePtr, mem, pPresentationParameters);
            bindAutoDepthStencil(device, devicePtr, mem, pPresentationParameters);

            Logger.log(LogCategory.D3D9, `Created device at 0x${devicePtr.toString(16)}`);
            return D3D_OK;
        } catch (error) {
            Logger.error(LogCategory.D3D9, `CreateDevice failed: ${error}`);
            return D3DERR_INVALIDCALL;
        }
    };

    exports['IDirect3DDevice9_Reset'] = (_ctx, mem, args) => {
        const pDevice = args[0];
        const pPresentationParameters = args[1];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Reset: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        // Reset destroys the implicit depth-stencil and re-creates it from the new
        // present parameters (when EnableAutoDepthStencil is still set).
        deviceBoundDepthStencil.delete(pDevice);
        const hr = device.reset(pPresentationParameters, mem);
        if (pPresentationParameters) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const width = view.getUint32(pPresentationParameters + PP_BACKBUFFER_WIDTH, true);
            const height = view.getUint32(pPresentationParameters + PP_BACKBUFFER_HEIGHT, true);
            const windowed = view.getUint32(pPresentationParameters + PP_WINDOWED, true) !== 0;
            if (!windowed && width > 0 && height > 0) {
                const targetWindow = view.getUint32(pPresentationParameters + PP_DEVICE_WINDOW, true)
                    || System.getInstance().windowManager.getActiveHwnd();
                syncExclusiveDisplayWindow(targetWindow, width, height);
            }
        }
        bindImplicitBackBuffer(device, pDevice, mem, pPresentationParameters);
        bindAutoDepthStencil(device, pDevice, mem, pPresentationParameters);
        return hr;
    };

    exports['IDirect3DDevice9_SetViewport'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        if (!device) return D3DERR_INVALIDCALL;
        return device.setViewport(args[1], mem);
    };

    exports['IDirect3DDevice9_GetViewport'] = (_ctx, mem, args) => {
        const device = devices.get(args[0]);
        const pViewport = args[1];
        if (!device || !pViewport) return D3DERR_INVALIDCALL;

        const vp = device.getViewport();
        const ok =
            Mem.writeUint32(pViewport + 0, vp.x) &&
            Mem.writeUint32(pViewport + 4, vp.y) &&
            Mem.writeUint32(pViewport + 8, vp.width) &&
            Mem.writeUint32(pViewport + 12, vp.height) &&
            Mem.writeFloat32(pViewport + 16, vp.minZ) &&
            Mem.writeFloat32(pViewport + 20, vp.maxZ);
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetRenderTarget'] = (_ctx, _mem, args) => {
        const pDevice = args[0] >>> 0;
        const device = devices.get(pDevice);
        if (!device) return D3DERR_INVALIDCALL;
        const index = args[1] >>> 0;
        let surfacePtr = args[2] >>> 0;
        if (!surfacePtr && index === 0) {
            surfacePtr = deviceImplicitBackBuffer.get(pDevice) ?? 0;
        }
        if (!surfacePtr || resourceToDevice.get(surfacePtr) !== device) {
            return D3DERR_INVALIDCALL;
        }
        // Resolve the render-target SURFACE → its parent TEXTURE (GetSurfaceLevel recorded the link
        // in surfaceMeta). A surface with no texture parent (the implicit backbuffer from
        // GetBackBuffer / a NULL restore) → texturePtr 0 = render to the swap-chain.
        const meta = surfacePtr ? surfaceMeta.get(surfacePtr) : undefined;
        const texturePtr = surfacePtr ? (meta?.texturePtr ?? 0) : 0;
        // A cube-face surface carries its face index (GetCubeMapSurface recorded it); -1 = 2D RT.
        const face = meta?.face ?? -1;
        device.noteRtResolve(surfacePtr, !!meta, texturePtr);
        let bindings = deviceBoundRenderTargets.get(pDevice);
        if (!bindings) {
            bindings = new Map();
            deviceBoundRenderTargets.set(pDevice, bindings);
        }
        bindings.set(index, surfacePtr);
        Logger.verbose(LogCategory.D3D9, `SetRenderTarget(index=${index}, surface=0x${surfacePtr.toString(16)} -> tex=0x${texturePtr.toString(16)} face=${face})`);
        device.setRenderTarget(index, texturePtr >>> 0, face);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetRenderTarget'] = (_ctx, mem, args) => {
        const pDevice = args[0] >>> 0;
        const device = devices.get(pDevice);
        const index = args[1] >>> 0;
        const ppRenderTarget = args[2];
        if (!device || !ppRenderTarget) return D3DERR_INVALIDCALL;
        const surfacePtr = deviceBoundRenderTargets.get(pDevice)?.get(index) ?? 0;
        if (!Mem.writeUint32(ppRenderTarget, surfacePtr)) return D3DERR_INVALIDCALL;
        return surfacePtr ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_BeginScene'] = (ctx, mem, args) => {
        const pDevice = args[0];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `BeginScene: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'BeginScene');
        device.beginScene();
        return D3D_OK;
    };

    exports['IDirect3DDevice9_EndScene'] = (ctx, mem, args) => {
        const pDevice = args[0];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `EndScene: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'EndScene');
        device.endScene();
        return D3D_OK;
    };

    exports['IDirect3DDevice9_Clear'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const Count = args[1];
        const pRects = args[2];
        const Flags = args[3];
        const Color = args[4];
        
        // Bitcast u32 to f32 for the Z parameter
        const zBuffer = new Uint32Array(1);
        zBuffer[0] = args[5];
        const Z = new Float32Array(zBuffer.buffer)[0];
        
        const Stencil = args[6];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Clear: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `Clear(Count=${Count}, Flags=0x${Flags.toString(16)}, Color=0x${Color.toString(16)}, Z=${Z}, Stencil=${Stencil})`);

        // Clear expects ARGB color as single number
        device.clear(Flags, Color, Z, Stencil);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_Present'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const pSourceRect = args[1];
        const pDestRect = args[2];
        const hDestWindowOverride = args[3];
        const pDirtyRegion = args[4];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `Present: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, 'Present');
        // Return Promise so dispatcher awaits → guest blocks during throttle wait (no "infinite FPS" spin).
        return device.present();
    };

    exports['IDirect3DDevice9_DrawPrimitive'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const PrimitiveType = args[1];
        const StartVertex = args[2];
        const PrimitiveCount = args[3];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `DrawPrimitive: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `DrawPrimitive(Type=${PrimitiveType}, Start=${StartVertex}, Count=${PrimitiveCount})`);
        device.drawPrimitive(PrimitiveType, StartVertex, PrimitiveCount);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_DrawIndexedPrimitive'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const PrimitiveType = args[1];
        const BaseVertexIndex = args[2];
        const MinVertexIndex = args[3];
        const NumVertices = args[4];
        const startIndex = args[5];
        const primCount = args[6];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `DrawIndexedPrimitive: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `DrawIndexedPrimitive(Type=${PrimitiveType}, Base=${BaseVertexIndex}, Start=${startIndex}, Count=${primCount})`);
        device.drawIndexedPrimitive(PrimitiveType, BaseVertexIndex, MinVertexIndex, NumVertices, startIndex, primCount);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_DrawPrimitiveUP'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const PrimitiveType = args[1];
        const PrimitiveCount = args[2];
        const pVertexStreamZeroData = args[3];
        const VertexStreamZeroStride = args[4];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `DrawPrimitiveUP: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        Logger.verbose(LogCategory.D3D9, `DrawPrimitiveUP(Type=${PrimitiveType}, Count=${PrimitiveCount}, Stride=${VertexStreamZeroStride})`);

        // drawPrimitiveUP expects pointer to vertex data, not array
        device.drawPrimitiveUP(PrimitiveType, PrimitiveCount, pVertexStreamZeroData, VertexStreamZeroStride);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetDeviceCaps'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pCaps = args[1];

        const device = devices.get(pDevice);
        if (!device || !pCaps) {
            Logger.error(LogCategory.D3D9, `GetDeviceCaps: invalid args device=${pDevice} pCaps=0x${(pCaps ?? 0).toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        return writeDeviceCaps9(pCaps) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_GetDirect3D'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const ppD3D9 = args[1];

        const device = devices.get(pDevice);
        if (!device || !ppD3D9) {
            return D3DERR_INVALIDCALL;
        }

        let parentPtr = deviceToD3D9.get(pDevice) ?? 0;
        if (!parentPtr) {
            const vtables = getVTables();
            const d3d9VtableAddr = vtables['IDirect3D9']?.address;
            if (!d3d9VtableAddr) {
                return D3DERR_INVALIDCALL;
            }
            parentPtr = createComObject(d3d9VtableAddr);
            deviceToD3D9.set(pDevice, parentPtr);
        }

        return Mem.writeUint32(ppD3D9, parentPtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_GetDisplayMode'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const _iSwapChain = args[1];
        const pMode = args[2];
        const device = devices.get(pDevice);
        if (!device || !pMode) {
            return D3DERR_INVALIDCALL;
        }

        const cfg = EmulatorConfig.getInstance().screenResolution;
        const ok =
            Mem.writeUint32(pMode + 0, cfg.width >>> 0) &&
            Mem.writeUint32(pMode + 4, cfg.height >>> 0) &&
            Mem.writeUint32(pMode + 8, cfg.refreshRate || 60) &&
            Mem.writeUint32(pMode + 12, formatForBpp(cfg.bpp));
        return ok ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_GetBackBuffer'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const iSwapChain = args[1];
        const iBackBuffer = args[2];
        const Type = args[3];
        const ppBackBuffer = args[4];

        const device = devices.get(pDevice);
        if (!device) {
            Logger.error(LogCategory.D3D9, `GetBackBuffer: invalid device ${pDevice}`);
            return D3DERR_INVALIDCALL;
        }

        if (!ppBackBuffer || iSwapChain !== 0 || iBackBuffer !== 0 || Type !== 0) {
            return D3DERR_INVALIDCALL;
        }
        const surfacePtr = deviceImplicitBackBuffer.get(pDevice) ?? 0;
        return surfacePtr && Mem.writeUint32(ppBackBuffer, surfacePtr) ? D3D_OK : D3DERR_INVALIDCALL;
    };

    exports['IDirect3DDevice9_SetDepthStencilSurface'] = (_ctx, _mem, args) => {
        const pDevice = args[0];
        const pNewZStencil = args[1] >>> 0;

        const device = devices.get(pDevice);
        if (!device) {
            return D3DERR_INVALIDCALL;
        }

        if (pNewZStencil !== 0) {
            const owner = resourceToDevice.get(pNewZStencil);
            if (owner !== device) {
                Logger.error(LogCategory.D3D9, `SetDepthStencilSurface: surface 0x${pNewZStencil.toString(16)} not owned by device`);
                return D3DERR_INVALIDCALL;
            }
        }

        deviceBoundDepthStencil.set(pDevice, pNewZStencil);
        Logger.verbose(LogCategory.D3D9, `SetDepthStencilSurface(0x${pNewZStencil.toString(16)})`);
        return D3D_OK;
    };

    exports['IDirect3DDevice9_GetDepthStencilSurface'] = (ctx, mem, args) => {
        const pDevice = args[0];
        const ppZStencilSurface = args[1];

        const device = devices.get(pDevice);
        if (!device || !ppZStencilSurface) {
            Logger.error(LogCategory.D3D9, `GetDepthStencilSurface: invalid args device=${pDevice} pp=0x${(ppZStencilSurface ?? 0).toString(16)}`);
            return D3DERR_INVALIDCALL;
        }

        const bound = deviceBoundDepthStencil.get(pDevice) ?? 0;
        if (!Mem.writeUint32(ppZStencilSurface, bound)) {
            return D3DERR_INVALIDCALL;
        }

        return D3D_OK;
    };

    return exports;
}
