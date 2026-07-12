/**
 * W32SKRNL.DLL — Win9x internal module-loader exports used by legacy engines.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { System } from "../core/system";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { Logger, LogCategory } from "../core/logger";

const DEFAULT_EXE_BASE = 0x00400000;

function resolveModuleImageBase(hModule: number): number {
    const h = hModule >>> 0;
    if (h === 0) return 0;

    const registry = System.getInstance().process?.moduleRegistry;
    if (registry) {
        const peBase = registry.resolvePeModuleBase(h) >>> 0;
        if (registry.getByBase(peBase) || registry.getModuleContainingAddress(peBase)) {
            return peBase;
        }
        if (Mem.readUint8(peBase) === 0x4d && Mem.readUint8(peBase + 1) === 0x5a) {
            return peBase;
        }
    }

    if (Mem.readUint8(h) === 0x4d && Mem.readUint8(h + 1) === 0x5a) {
        return h;
    }
    if (h === DEFAULT_EXE_BASE) {
        return registry?.getMainExecutableBase() ?? DEFAULT_EXE_BASE;
    }
    return 0;
}

export class W32skrnl implements IModule {
    name = "w32skrnl";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        this.exports["_ImteFromHModule@4"] = (_ctx, _mem, args) => {
            const hModule = args[0] ?? 0;
            const base = resolveModuleImageBase(hModule);
            Logger.verbose(
                LogCategory.KERNEL32,
                `_ImteFromHModule@4(0x${(hModule >>> 0).toString(16)}) -> 0x${base.toString(16)}`
            );
            return { value: base, stackCleanup: 4 };
        };

        // SS2 chains ImteFromHModule → BaseAddrFromImte; our IMTE token is the image base.
        this.exports["_BaseAddrFromImte@4"] = (_ctx, _mem, args) => {
            const imte = args[0] ?? 0;
            const base = resolveModuleImageBase(imte);
            Logger.verbose(
                LogCategory.KERNEL32,
                `_BaseAddrFromImte@4(0x${(imte >>> 0).toString(16)}) -> 0x${base.toString(16)}`
            );
            return { value: base, stackCleanup: 4 };
        };
    }

    reset(): void {}
}
