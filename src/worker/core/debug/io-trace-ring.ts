/**
 * Opt-in file-I/O trace ring — shared singleton between the kernel32 file-I/O fast paths
 * (the producer) and the present-stall freeze watchdog (the consumer). DISABLED by default: when off,
 * the only cost at a call site is one `isEnabled()` boolean check, so there is zero overhead
 * in normal runs. The watchdog enables it on arm() and reads snapshot() at the moment of a
 * freeze to answer "which file + offset is the spinning script hammering?" — e.g. a tight
 * SetFilePointer/ReadFile loop that dominates a livelock.
 */

export interface IoTraceEntry {
    wall: number;   // performance.now()
    op: string;     // 'read' | 'seek'
    handle: number;
    path: string;
    pos: number;    // read-start offset (read) or resulting position (seek)
    size: number;   // bytes requested (read) / 0 (seek)
    ret: number;    // bytes actually read (read) / 0 (seek)
}

class IoTraceRing {
    private enabled = false;
    private buf: IoTraceEntry[] = [];
    private cap = 1024;

    enable(cap = 1024): void { this.cap = cap; this.buf = []; this.enabled = true; }
    disable(): void { this.enabled = false; this.buf = []; }
    isEnabled(): boolean { return this.enabled; }

    /** Record one I/O op. Call site MUST guard with isEnabled() so args aren't built when off. */
    record(op: string, handle: number, path: string, pos: number, size: number, ret = 0): void {
        if (!this.enabled) return;
        this.buf.push({ wall: performance.now(), op, handle, path, pos, size, ret });
        if (this.buf.length > this.cap) this.buf.shift();
    }

    snapshot(): IoTraceEntry[] { return this.buf.slice(); }
    clear(): void { this.buf = []; }
}

export const ioTraceRing = new IoTraceRing();
