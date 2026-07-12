/**
 * Kernel32 FLS (Fiber Local Storage) functions
 *
 * Simple in-memory FLS; callback ignored. Per-slot storage for CRT init, etc.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { hypercallDataManager } from '../../core/cpu/hypercall-data';

const FLS_OUT_OF_INDEXES = 0xffffffff;
const MAX_SLOTS = 128;

const slots = new Map<number, number>();
let nextSlot = 1;
let flsOwnerProcess: unknown = null;

function ensureProcessLocalFls(): void {
    const process = System.getInstance().process;
    if (process === flsOwnerProcess) return;
    flsOwnerProcess = process;
    slots.clear();
    nextSlot = 1;
    hypercallDataManager.clearFlsSlots();
}

export const exports: Record<string, ThunkImplementation> = {
    FlsAlloc(ctx, mem, args) {
        ensureProcessLocalFls();
        const lpCallback = args[0];
        //Logger.verbose(LogCategory.KERNEL32, `FlsAlloc(0x${lpCallback.toString(16)})`);
        if (nextSlot > MAX_SLOTS) return FLS_OUT_OF_INDEXES;
        const index = nextSlot++;
        slots.set(index, 0);
        hypercallDataManager.setFlsSlot(index, true, 0);
        return index;
    },

    FlsGetValue(ctx, mem, args) {
        ensureProcessLocalFls();
        const dwFlsIndex = args[0];
        //Logger.verbose(LogCategory.KERNEL32, `FlsGetValue(${dwFlsIndex})`);
        const v = slots.get(dwFlsIndex);
        return v !== undefined ? v : 0;
    },

    FlsSetValue(ctx, mem, args) {
        ensureProcessLocalFls();
        const dwFlsIndex = args[0];
        const lpFlsData = args[1];
        //Logger.verbose(LogCategory.KERNEL32, `FlsSetValue(${dwFlsIndex}, 0x${lpFlsData.toString(16)})`);
        if (!slots.has(dwFlsIndex)) return 0;
        slots.set(dwFlsIndex, lpFlsData);
        hypercallDataManager.setFlsSlot(dwFlsIndex, true, lpFlsData);
        return 1;
    },

    FlsFree(ctx, mem, args) {
        ensureProcessLocalFls();
        const dwFlsIndex = args[0];
        //Logger.verbose(LogCategory.KERNEL32, `FlsFree(${dwFlsIndex})`);
        if (!slots.delete(dwFlsIndex)) return 0;
        hypercallDataManager.setFlsSlot(dwFlsIndex, false, 0);
        return 1;
    },
};
