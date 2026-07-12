/**
 * IDirectDrawSurface7 stub methods and delegate lists.
 * Real implementations (IsLost, Restore, etc.) live in surface.ts.
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { DD_OK, DDSCAPS_TEXTURE, DDGAMMARAMP_SIZE } from "./constants";
import { DirectDrawSurfaceObject } from "./com-objects";
import { isValidAddress } from "../../core/memory/address-guard";
import { gammaService } from "../../core/gamma-service";
import type { DDrawContext } from "./context";

export function createSurfaceStubsExports(context: DDrawContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const stubMethods = [
        "AddOverlayDirtyRect",
        "BltBatch",
        "DeleteAttachedSurface",
        "EnumOverlayZOrders",
        "GetOverlayPosition",
        "GetPalette",
        "Initialize",
        "SetOverlayPosition",
        "UpdateOverlay",
        "UpdateOverlayDisplay",
        "UpdateOverlayZOrder",
        "GetDDInterface",
        "PageLock",
        "PageUnlock",
        "SetPrivateData",
        "GetPrivateData",
        "FreePrivateData",
        "GetUniquenessValue",
        "ChangeUniquenessValue",
        "SetPriority",
        "GetPriority",
        "SetLOD",
        "GetLOD",
    ];

    for (const method of stubMethods) {
        if (method === "BltBatch") {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                Logger.log(LogCategory.SYSTEM, `IDirectDrawSurface7_BltBatch: this=0x${args[0].toString(16)}`);
                return DD_OK;
            };
        } else if (method === "GetPalette" || method === "SetLOD" || method === "GetLOD") {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                const thisPtr = args[0];
                const obj = context.resourceProvider.getComObjectByAddress(thisPtr) as DirectDrawSurfaceObject | null;
                const isTexture = obj ? (obj.getState().caps & DDSCAPS_TEXTURE) !== 0 : false;
                const msg = `IDirectDrawSurface7_${method}: this=0x${thisPtr.toString(16)}${isTexture ? " [TEXTURE]" : ""}`;
                Logger.log(LogCategory.SYSTEM, msg);
                if (isTexture) {
                    Logger.log(LogCategory.DDRAW, msg);
                }
                return DD_OK;
            };
        } else {
            exports[`IDirectDrawSurface7_${method}`] = (ctx, mem, args) => {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
                Logger.verbose(LogCategory.SYSTEM, `IDirectDrawSurface7_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
                return DD_OK;
            };
        }
    }

    // =========================================================================
    // IDirectDrawGammaControl stubs
    // =========================================================================

    exports["IDirectDrawGammaControl_QueryInterface"] = (ctx, mem, args) => {
        Logger.log(LogCategory.COM, `IDirectDrawGammaControl_QueryInterface: this=0x${args[0].toString(16)} (stub)`);
        return 0x80004002; // E_NOINTERFACE
    };

    exports["IDirectDrawGammaControl_AddRef"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.addRef() : 0;
    };

    exports["IDirectDrawGammaControl_Release"] = (ctx, mem, args) => {
        const obj = context.resourceProvider.getComObjectByAddress(args[0]);
        return obj ? obj.release() : 0;
    };

    // GetGammaRamp(dwFlags, lpRampData) — write the current ramp (or linear identity) back to the guest.
    exports["IDirectDrawGammaControl_GetGammaRamp"] = (_ctx, mem, args) => {
        const lpRampData = args[2];
        if (!lpRampData || !isValidAddress(mem, lpRampData, DDGAMMARAMP_SIZE)) {
            return 0x80070057; // E_INVALIDARG
        }
        gammaService.writeToGuest(mem, lpRampData);
        return DD_OK;
    };

    // SetGammaRamp(dwFlags, lpRampData) — read the ramp from guest memory and apply via the shared sink.
    exports["IDirectDrawGammaControl_SetGammaRamp"] = (_ctx, mem, args) => {
        const lpRampData = args[2];
        if (!lpRampData || !isValidAddress(mem, lpRampData, DDGAMMARAMP_SIZE)) {
            return 0x80070057; // E_INVALIDARG
        }
        gammaService.applyFromGuest(mem, lpRampData);
        Logger.verbose(LogCategory.DDRAW, "IDirectDrawGammaControl_SetGammaRamp: applied");
        return DD_OK;
    };

    return exports;
}
