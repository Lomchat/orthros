/**
 * DWMAPI.dll stubs.
 * Keep Desktop Window Manager optional for legacy apps.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Logger, LogCategory } from "../core/logger";

const S_OK = 0;

export class Dwmapi implements IModule {
    name = "dwmapi";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        // HRESULT DwmIsCompositionEnabled(BOOL* pfEnabled)
        this.exports["DwmIsCompositionEnabled"] = (ctx, mem, args) => {
            const pfEnabled = args[0] >>> 0;
            if (pfEnabled !== 0) {
                Mem.writeUint32(pfEnabled, 0);
            }
            return S_OK;
        };

        // HRESULT DwmSetWindowAttribute(HWND hwnd, DWORD attr, LPCVOID value, DWORD cb)
        this.exports["DwmSetWindowAttribute"] = () => S_OK;

        // Vista-era ordinal import (commonly DwmEnableComposition(UINT action)).
        this.exports["ord_102"] = (ctx, mem, args) => {
            const action = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `dwmapi:ord_102(action=${action}) -> S_OK`);
            return S_OK;
        };
    }

    reset(): void {}
}
