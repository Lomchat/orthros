/**
 * SEH chain self-loop repair.
 *
 * Some titles (observed: OldUnreal 227 / unreal-gold) corrupt an EXCEPTION_REGISTRATION
 * frame's `next` pointer to point at itself between two *sequential* SEH catches: after a
 * guard handler catches throw N and resumes, the guest re-establishes the same stack-slot
 * frame while FS:[0] still equals that frame, producing `[frame].next == frame`. The
 * self-loop truncates the SEH chain, so throw N+1 can no longer reach the outer guard
 * handlers that would catch it → UnhandledExceptionFilter → NULL-deref → halt/derail.
 *
 * Real Windows never sees this because the catch resumes directly inside the __except
 * block without re-pushing the frame; the corruption is specific to how HLE dispatch
 * returns control. We verified (RtlUnwind probe) the chain is healthy right after the
 * catch and only self-loops once the guest re-enters.
 *
 * Recovery: remember each frame's last KNOWN-GOOD `next` during a healthy chain walk,
 * keyed by frame address AND handler (so a reused stack slot belonging to a different
 * function can't be mis-repaired). When a later walk hits a self-loop, splice the good
 * `next` back into guest memory and continue the walk. The write persists, so every
 * subsequent walk (JS C++ dispatch, x86 SEH stub, AV dispatch) sees the fixed chain.
 */
import { Logger, LogCategory } from '../logger';

interface FrameRecord { next: number; handler: number; }

// Bounded cache keyed by frame guest-address. Records survive across boots harmlessly:
// the handler check rejects a stale slot reused by a different function, and the same
// game re-booting re-uses the same (deterministic) address + handler, so the record
// stays valid.
const MAX_RECORDS = 256;
const records = new Map<number, FrameRecord>();

/** Record a frame's healthy `next` pointer (call during a non-looping chain walk). */
export function recordSehFrame(frameAddr: number, next: number, handler: number): void {
    const fa = frameAddr >>> 0;
    const nx = next >>> 0;
    // Only record plausible, non-self links. A valid outer frame is at a higher stack
    // address (the chain walks upward) or the 0xFFFFFFFF end sentinel.
    if (nx === fa) return;
    if (nx !== 0xFFFFFFFF && nx <= fa) return;
    if (records.size >= MAX_RECORDS && !records.has(fa)) {
        const firstKey = records.keys().next().value;
        if (firstKey !== undefined) records.delete(firstKey);
    }
    records.set(fa, { next: nx, handler: handler >>> 0 });
}

/**
 * If `frameAddr` self-loops (`[frameAddr].next == frameAddr`), repair it from the
 * recorded known-good `next` — but only when the recorded handler matches the current
 * frame's handler. Writes the repair into guest memory and returns the repaired `next`,
 * or null if no safe repair is available.
 */
export function repairSehSelfLoop(
    view: DataView,
    frameAddr: number,
    currentHandler: number,
    memLength: number,
): number | null {
    const fa = frameAddr >>> 0;
    if (fa + 8 > memLength) return null;
    const rec = records.get(fa);
    if (!rec) return null;
    if (rec.handler !== (currentHandler >>> 0)) return null;
    if ((rec.next >>> 0) === fa) return null;
    view.setUint32(fa, rec.next >>> 0, true);
    Logger.warn(LogCategory.SYSTEM,
        `SEH chain repair: frame 0x${fa.toString(16)} (handler 0x${(currentHandler >>> 0).toString(16)}) ` +
        `was self-looped — restored next=0x${(rec.next >>> 0).toString(16)} from last known-good walk`);
    return rec.next >>> 0;
}

/** Clear all recorded frames (optional; safe to leave between boots). */
export function clearSehChainRecords(): void {
    records.clear();
}
