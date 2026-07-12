/**
 * MSIMG32.dll stubs.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";

const TRUE = 1;

export class Msimg32 implements IModule {
    name = "msimg32";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        // BOOL GradientFill(...)
        this.exports["GradientFill"] = () => TRUE;

        // BOOL AlphaBlend(...)
        this.exports["AlphaBlend"] = (ctx, mem, args) => {
            Logger.verbose(
                LogCategory.SYSTEM,
                `msimg32:AlphaBlend(dst=${args[3] >>> 0}x${args[4] >>> 0}, src=${args[8] >>> 0}x${args[9] >>> 0}) -> TRUE`
            );
            return TRUE;
        };

        // BOOL TransparentBlt(...)
        this.exports["TransparentBlt"] = () => TRUE;
    }

    reset(): void {}
}
