export const SEH_SCRATCH_TOTAL_SIZE = 0x4000;
export const SEH_FRAME_LIST_MAX = 64;
export const SEH_SCRATCH_STACK_SIZE = 0x1000;
export const SEH_SCRATCH_STACK_GUARD = 0x20;

export const SEH_SCRATCH_LAYOUT = {
    EXCEPTION_RECORD: 0x000,
    CONTEXT: 0x050,
    EXCEPTION_POINTERS: 0x31C,
    DISPATCH_RESULT: 0x324,
    FAULT_EIP: 0x328,
    SAFE_ESP: 0x32C,
    FRAME_LIST: 0x330,
    LAST_HANDLER_RESULT: 0x580,
    LAST_HANDLER_FRAME: 0x584,
    LAST_HANDLER_ADDR: 0x588,
    EH3_FILTER_CTX: 0x600,
} as const;

export const EH3_FILTER_CTX_LAYOUT = {
    FILTER_ADDR: 0x00,
    FRAME_ADDR: 0x04,
    PREV_TRY_LEVEL: 0x08,
    HANDLER_ADDR: 0x0C,
    FRAME_EBP: 0x10,
    CONTINUATION_EIP: 0x14,
    CURRENT_TRY_LEVEL: 0x18,
    SIZE: 0x20,
} as const;

export interface SehScratchLayoutInfo {
    stackBase: number;
    stackTop: number;
}

export function computeSehScratchLayout(
    scratchAddr: number,
    scratchSize: number = SEH_SCRATCH_TOTAL_SIZE,
): SehScratchLayoutInfo {
    const stackTop = (scratchAddr + scratchSize - SEH_SCRATCH_STACK_GUARD) >>> 0;
    const stackBase = (stackTop - SEH_SCRATCH_STACK_SIZE) >>> 0;
    return { stackBase, stackTop };
}
