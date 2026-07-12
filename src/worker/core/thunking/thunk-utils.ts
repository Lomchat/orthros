// thunk-utils.ts
// Utility functions for stack manipulation and CPU state restoration

/**
 * Calculate new ESP after RET N instruction (stdcall cleanup)
 * Formula: NewESP = OldESP + 4 (return address) + cleanup (stack args)
 * 
 * @param esp - Current stack pointer (points to return address)
 * @param cleanup - Number of bytes to pop from stack (stack cleanup)
 * @returns New stack pointer after RET N
 */
export function calculateStackRestore(esp: number, cleanup: number): number {
    return (esp + 4 + cleanup) >>> 0;  // >>> 0 ensures unsigned 32-bit
}

/**
 * Validate that an address is within memory bounds
 * 
 * @param address - Address to validate
 * @param memorySize - Size of memory buffer
 * @param minimumSafe - Minimum safe address (e.g., 0x1000 for code sections)
 * @returns true if address is valid
 */
export function isValidAddress(address: number, memorySize: number, minimumSafe: number = 0x1000): boolean {
    return address >= minimumSafe && address < memorySize;
}

/**
 * Calculate linear address from segment:offset
 * In protected mode, linear = segmentBase + offset
 * 
 * @param offset - Segment offset (EIP)
 * @param segmentBase - Segment base address (from get_seg_base)
 * @returns Linear address (unsigned 32-bit)
 */
export function toLinearAddress(offset: number, segmentBase: number): number {
    return (segmentBase + offset) >>> 0;
}

/**
 * Get CPU object from v86 emulator (handles both direct and nested access patterns)
 * 
 * @param v86 - v86 emulator instance
 * @returns CPU object or null if not found
 */
export function getCPU(v86: any): any | null {
    return v86?.cpu || (v86?.v86 && v86.v86.cpu) || null;
}

/**
 * Get memory array from v86 emulator (handles both direct and nested access patterns)
 *
 * @param v86 - v86 emulator instance
 * @returns Memory array or null if not found
 */
export function getMemory(v86: any): Uint8Array | null {
    return v86?.mem8 || (v86?.v86 && v86.v86.cpu?.mem8) || null;
}

/**
 * Parse stack cleanup from stdcall function name decoration (@N suffix).
 * Example: "_AIL_waveOutOpen@16" -> 16 bytes cleanup
 *
 * @param functionName Function name (may include @N decoration)
 * @returns Stack cleanup in bytes, or null if no decoration found
 */
export function parseStdcallCleanup(functionName: string): number | null {
    const match = functionName.match(/@(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
}

/** Strip leading `_` and trailing `@N` to normalize decorated names (e.g. `_AIL_startup@0` > `ail_startup`). */
export function normalizeApiName(name: string): string {
    return name.toLowerCase().replace(/^_/, '').replace(/@\d+$/, '');
}
