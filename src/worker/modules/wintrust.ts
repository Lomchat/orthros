import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";

export class Wintrust implements IModule {
    name = "wintrust";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // LONG WinVerifyTrust(HWND hwnd, GUID *pgActionID, WINTRUST_DATA *pWVTData)
        // Always return 0 (success) — no real signature verification needed in HLE.
        this.exports["WinVerifyTrust"] = (ctx, mem, args) => {
            Logger.verbose(LogCategory.SYSTEM,
                `WinVerifyTrust(hwnd=0x${args[0].toString(16)}, pgActionID=0x${args[1].toString(16)}, pWVTData=0x${args[2].toString(16)}) -> 0 (trusted)`);
            return { value: 0, stackCleanup: 12 };
        };
    }
}
