/**
 * IDirectDraw7 stub methods (Compact, EnumSurfaces, etc.).
 */
import type { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { DD_OK } from "./constants";
import { isValidAddress } from "../../core/memory/address-guard";
import type { DDrawContext } from "./context";
import { System } from "../../core/system";
import { restoreDisplayModeToDesktop } from "./directdraw";

export function createDirectDrawStubsExports(context: DDrawContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    const stubMethods = [
        "Compact",
        "DuplicateSurface",
        "GetFourCCCodes",
        "GetMonitorFrequency",
        "RestoreDisplayMode",
        "GetSurfaceFromDC",
        "RestoreAllSurfaces",
        "StartModeTest",
        "EvaluateMode",
    ];

    for (const method of stubMethods) {
        exports[`IDirectDraw7_${method}`] = (ctx, mem, args) => {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const retAddr = isValidAddress(mem, ctx.esp, 4) ? view.getUint32(ctx.esp, true) : 0;
            Logger.log(LogCategory.SYSTEM, `IDirectDraw7_${method} stub called: this=0x${args[0].toString(16)}, ret=0x${retAddr.toString(16)}`);
            if (method === "RestoreDisplayMode") {
                // Faithful: revert the current display mode back to the saved desktop mode,
                // resize the host, and broadcast WM_DISPLAYCHANGE. Leaving exclusive returns
                // the screen to GDI.
                restoreDisplayModeToDesktop(System.getInstance(), context);
                context.cooperative.exclusive = false;
                context.gdiSurfaceVisible = true;
            }
            return DD_OK;
        };
    }

    return exports;
}
