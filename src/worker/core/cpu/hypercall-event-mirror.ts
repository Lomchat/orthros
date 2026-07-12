/**
 * Mirrored kernel event table layout — must match hypercall.rs.
 * Shared between hypercall-data.ts and wait-engine mirror sync.
 */

export const KERNEL_EVENT_HANDLE_BASE = 0x30000;
export const EVENT_TABLE_SLOTS = 2048;
export const OFF_HC_EVENT_TABLE = 0x1448;
export const OFF_HC_EVENT_STARVATION_COUNTER = 0x1C48;
export const OFF_HC_EVENT_STARVATION_LIMIT = 0x1C4C;

export const EVT_VALID = 0x01;
export const EVT_SIGNALED = 0x02;
export const EVT_MANUAL = 0x04;
export const EVT_HAS_WAITERS = 0x08;
export const EVT_PENDING_WAKE = 0x10;

/** Mutex mirror word layout — must match hypercall.rs MUX_* constants. */
export const OFF_HC_MUTEX_MIRROR_PTR = 0x1c50;
export const MUX_VALID = 0x8000_0000;
export const MUX_HAS_WAITERS = 0x4000_0000;
export const MUX_ABANDONED = 0x2000_0000;
export const MUX_OWNER_MASK = 0x0000_ffff;
export const MUX_REC_SHIFT = 16;
export const MUX_REC_MASK = 0x00ff_0000;

/** Owner/recursion must fit mirror word — otherwise WASM fast-path must fall through to JS. */
export function mutexMirrorValuesInRange(owner: number | null, recursion: number): boolean {
    if (owner !== null && owner > MUX_OWNER_MASK) return false;
    if (recursion > 0xff) return false;
    return true;
}

export function packMutexMirrorWord(
    owner: number,
    recursion: number,
    valid: boolean,
    hasWaiters: boolean,
    abandoned = false,
): number {
    let w = (owner & MUX_OWNER_MASK) | ((recursion & 0xff) << MUX_REC_SHIFT);
    if (valid) w |= MUX_VALID;
    if (hasWaiters) w |= MUX_HAS_WAITERS;
    if (abandoned) w |= MUX_ABANDONED;
    return w >>> 0;
}

export function unpackMutexMirrorWord(word: number): {
    valid: boolean;
    hasWaiters: boolean;
    abandoned: boolean;
    owner: number | null;
    recursion: number;
} {
    const w = word >>> 0;
    return {
        valid: (w & MUX_VALID) !== 0,
        hasWaiters: (w & MUX_HAS_WAITERS) !== 0,
        abandoned: (w & MUX_ABANDONED) !== 0,
        owner: (w & MUX_OWNER_MASK) || null,
        recursion: (w & MUX_REC_MASK) >>> MUX_REC_SHIFT,
    };
}

export function eventSlotForKernelHandle(handle: number): number | null {
    const h = handle >>> 0;
    if (h < KERNEL_EVENT_HANDLE_BASE) return null;
    const slot = (h - KERNEL_EVENT_HANDLE_BASE) >> 2;
    if (slot >= EVENT_TABLE_SLOTS) return null;
    return slot;
}
