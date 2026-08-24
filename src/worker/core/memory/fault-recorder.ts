/**
 * Durable guest-fault recorder.
 *
 * Intermittent guest crashes (a thread derailing to a near-NULL deref, a wild
 * jump, a stack/context corruption) are hard to catch: the streamed log is a
 * firehose that routinely drops the crash line, and post-mortem register dumps
 * only show the wreckage. This keeps a small ring of the last N guest faults —
 * faulting EIP, fault address (CR2), error code, owning thread, the last WinAPI
 * thunk, and the live (non-clobbered) registers — populated straight from the
 * #PF handler. Read it live via the harness `faults()` verb with ZERO log
 * firehose and ZERO perturbation (it's a plain array push on the fault path).
 *
 * This is the observability that turns "the emulator froze, wtf" into "thread T7
 * faulted reading 0x<addr> at EIP=0x<eip>, last thunk dsound:…" — diagnosable.
 */

export interface FaultRecord {
    /** performance.now()-ish timestamp (ms). */
    ts: number;
    /** Faulting instruction pointer (guest EIP). */
    eip: number;
    /** Faulting linear address (CR2). */
    faultAddr: number;
    /** #PF error code (bit0 present, bit1 write, bit2 user). */
    errorCode: number;
    /** Owning guest thread id, or null if unknown. */
    threadId: number | null;
    /** Last WinAPI thunk before the fault (breadcrumb). */
    lastThunk: string;
    /** Recoverable (CoW/decommit/write-trap) vs delivered-as-AV. */
    kind: "recoverable" | "unhandled";
    /** Live guest registers at the fault (EAX/EDX may be clobbered by the #PF stub). */
    regs: { ecx: number; ebx: number; esp: number; ebp: number; esi: number; edi: number };
    /** Tail of the WinAPI call ring leading up to the fault (newest last). */
    recentCalls: string[];
    /** Raw thunk entry ESP/return-address pairs, frozen at the fault. */
    recentCallDetails?: Array<{ id: number; name: string; esp: number; retAddrBefore: number; stackHash: number }>;
    /** Scheduler save/restore trace frozen at the fault, before an error UI can overwrite it. */
    schedulerTrace?: string[];
    /** Guest ESP at the fault (above the #PF interrupt frame). */
    gameEsp: number;
    /** 32 stack words from gameEsp (return-address chain + locals/args). */
    stackDump: number[];
}

const MAX_RECORDS = 64;

class FaultRecorder {
    private ring: FaultRecord[] = [];

    record(r: FaultRecord): void {
        this.ring.push(r);
        if (this.ring.length > MAX_RECORDS) this.ring.shift();
    }

    /** Most recent fault, or null. */
    last(): FaultRecord | null {
        return this.ring.length ? this.ring[this.ring.length - 1] : null;
    }

    /** Last `n` faults, newest last. */
    recent(n = 16): FaultRecord[] {
        return this.ring.slice(-Math.max(1, n));
    }

    clear(): void {
        this.ring = [];
    }
}

/** Worker-wide singleton — imported by the #PF handler and the harness. */
export const faultRecorder = new FaultRecorder();
