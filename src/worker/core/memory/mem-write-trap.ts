/**
 * MemWriteTrap — page-protection WRITE trap for diagnosing "the guest never
 * writes here" mysteries (e.g. a DDraw surface whose CPU pixels stay zero even
 * though the game Locked it and supposedly filled it).
 *
 * Mechanism: arm() flips the target pages to PAGE_READONLY in the guest page
 * tables. A subsequent guest CPU store to those pages raises a real #PF
 * (protection violation), which our recoverable #PF handler routes to JS via
 * OUT 0xB077,0xDEAD000E → ThunkDispatcher._handleRecoverablePageFault. That
 * handler calls tryHandle() FIRST (before SEH/halt logic): we record the
 * faulting EIP (the actual writer), flip just that page back to RW so the IRET
 * retry of the store lands, and return — the guest never sees the fault.
 *
 * This is single-shot per page (first write to a page un-protects it), which is
 * exactly what we want: it yields up-to-one distinct writer EIP per page across
 * the armed range without single-stepping, and it lets the real fill complete.
 *
 * Decisive answers it gives:
 *   - hits.length > 0  → the guest DOES write to these pages; here are the EIPs.
 *   - hits.length == 0 → the guest never writes here; the fill targets another
 *     address (wrong lpSurface, different surface, or GPU/Blt-filled).
 *
 * Diagnostic only — arm via the harness (trapWrites), never on a hot path.
 */

import { Logger, LogCategory } from "../logger";
import { System } from "../system";

const PAGE_SIZE = 0x1000;
const PAGE_NOACCESS = 0x01;
const PAGE_READONLY = 0x02;
const PAGE_READWRITE = 0x04;
const MAX_HITS = 512; // bound the record; pages are single-shot so this is plenty

export interface MemWriteTrapHit {
    /** Faulting linear address (CR2). */
    addr: number;
    /** Page base that was un-protected. */
    page: number;
    /** EIP of the instruction that performed the store. */
    eip: number;
    /** Module+offset annotation for eip, if resolvable. */
    module: string;
    /** Thunk name in flight at fault time (context). */
    thunk: string;
    /** Current guest thread id at fault time (to spot cross-thread races). */
    tid: number | string;
    /** Guest GP registers at fault [eax,ecx,edx,ebx,esp,ebp,esi,edi] (for tracing
     *  the data source of a copy loop — e.g. which reg holds the source pointer). */
    regs: number[];
    /** Return-address chain walked from EBP (resolve via the live module map to
     *  identify the calling functions — e.g. the texture loader above a copier). */
    stack: number[];
    /** Dense-data blocks found near ESI (offset:nonZeroCount) — locates where the
     *  real pixel data lives vs where the source pointer points. */
    srcScan: string[];
    /** Heuristic stack scan: code-pointer-looking values on the guest stack,
     *  resolved to module+offset. Works for FPO frames where EBP-walk fails. */
    rawStack: string[];
    /** Access kind in trace mode: 'R' (read) or 'W' (write). */
    rw: string;
    /** Order of first observation. */
    seq: number;
}

class MemWriteTrap {
    private base = 0;
    private end = 0;
    private armed = false;
    private hits: MemWriteTrapHit[] = [];
    private seenPages = new Set<number>();
    private seq = 0;
    private label = "";
    /** Trace mode: NO-ACCESS pages, record EVERY read+write (re-arm previous page
     *  on each fault) — captures the full write/read SEQUENCE on a buffer. */
    private trace = false;
    /** Watch mode: RO pages + re-arm (like trace but writes-only, and RECORD only
     *  faults whose addr lands in the precise [base,end) window). Every store to the
     *  trapped pages faults → we un-protect+re-arm so the NEXT store re-faults, but
     *  only writes to the watched bytes are recorded. Catches EVERY writer of one
     *  field on a busy page with no read-flood, no MAX_HITS eviction, no JIT-off. */
    private watch = false;
    private pageBase = 0;
    private pageEnd = 0;
    /** Watch mode record window (narrow — the one field). Protection spans whole
     *  pages [pageBase,pageEnd) so re-arm can ALTERNATE across pages (the single-page
     *  re-arm gap: after un-protecting one page for a store, a same-page store won't
     *  re-fault; trapping a few neighbour pages keeps writes ping-ponging so the
     *  field's page gets re-protected by a neighbour fault before the next field
     *  write). Recording is filtered to [recBase,recEnd) so no flood/eviction. */
    private recBase = 0;
    private recEnd = 0;
    private pendingReArm: number[] = [];

    /** Arm a trap over [addr, addr+len). Default: RO (catch first write per page).
     *  opts.trace: NO-ACCESS, catch EVERY read+write in order (re-arm scheme). */
    arm(addr: number, len: number, label = "", opts?: { trace?: boolean; watch?: boolean; recordAddr?: number; recordLen?: number }): { armed: boolean; pages: number; base: number; end: number; trace: boolean; watch: boolean } {
        const ptm = System.getInstance().process?.pageTableManager;
        if (!ptm?.isPagingEnabled()) {
            throw new Error("MemWriteTrap.arm: paging not enabled (no page tables to protect)");
        }
        // Restore any previous arming first.
        if (this.armed) this.disarm();

        this.trace = !!opts?.trace;
        this.watch = !!opts?.watch;
        this.base = addr >>> 0;
        this.end = (addr + Math.max(1, len | 0)) >>> 0;
        // Record window: defaults to the full armed range; in watch mode the caller
        // can pass a NARROW recordAddr/recordLen while arming a WIDE page span.
        this.recBase = (opts?.recordAddr != null ? opts.recordAddr : this.base) >>> 0;
        this.recEnd = (opts?.recordAddr != null ? (opts.recordAddr + Math.max(1, (opts.recordLen ?? 4) | 0)) : this.end) >>> 0;
        const pageBase = this.base & ~(PAGE_SIZE - 1);
        const pageEnd = (this.end + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
        this.pageBase = pageBase;
        this.pageEnd = pageEnd;
        const pageLen = pageEnd - pageBase;
        // watch mode uses RO (writes-only faults) + re-arm; trace uses NO-ACCESS.
        ptm.setProtection(pageBase, pageLen, this.trace ? PAGE_NOACCESS : PAGE_READONLY);

        this.armed = true;
        this.hits = [];
        this.seenPages.clear();
        this.pendingReArm = [];
        this.seq = 0;
        this.label = label;
        const pages = pageLen / PAGE_SIZE;
        Logger.log(LogCategory.SYSTEM,
            `[MemWriteTrap] armed ${this.trace ? "NO-ACCESS (trace)" : this.watch ? "RO (watch+rearm)" : "RO"} over 0x${pageBase.toString(16)}..0x${pageEnd.toString(16)} ` +
            `(${pages} pages, watch window 0x${this.base.toString(16)}..0x${this.end.toString(16)})${label ? ` [${label}]` : ""}`);
        return { armed: true, pages, base: pageBase, end: pageEnd, trace: this.trace, watch: this.watch };
    }

    isArmed(): boolean {
        return this.armed;
    }

    /**
     * Called from ThunkDispatcher._handleRecoverablePageFault BEFORE SEH/halt.
     * Returns true if this fault is one of ours (page un-protected, write
     * recorded) — caller must `return` so the IRET retries the store.
     */
    tryHandle(faultAddr: number, faultingEip: number, isWrite: boolean, isPresent: boolean, thunk: string, cpu?: any): boolean {
        if (!this.armed) return false;
        const a = faultAddr >>> 0;
        const ptm = System.getInstance().process?.pageTableManager;
        const page = a & ~(PAGE_SIZE - 1);

        if (this.watch) {
            // Watch mode: handle EVERY store to the trapped pages (so the busy heap
            // page keeps working), but RECORD only writes landing in the precise
            // [base,end) window. Un-protect this page for the retried store and
            // re-protect the previously-touched page so its NEXT store re-faults
            // (re-arm) — this catches repeated writes to the watched field.
            if (page < this.pageBase || page >= this.pageEnd) return false;
            if (!isWrite || !isPresent) return false;
            for (const p of this.pendingReArm) if (p !== page) ptm?.setProtection(p, PAGE_SIZE, PAGE_READONLY);
            this.pendingReArm = [page];
            ptm?.setProtection(page, PAGE_SIZE, PAGE_READWRITE);
            if (a >= this.recBase && a < this.recEnd && this.hits.length < MAX_HITS) {
                const hit = this._buildHit(a, page, faultingEip, thunk, cpu, "W");
                this.hits.push(hit);
                Logger.log(LogCategory.SYSTEM,
                    `[MemWriteTrap] WATCH WRITE #${hit.seq} addr=0x${a.toString(16)} ` +
                    `eip=0x${hit.eip.toString(16)}${hit.module ? ` (${hit.module})` : ""} thunk=${hit.thunk || "?"}`);
            }
            return true;
        }

        if (a < this.base || a >= this.end) return false;

        if (this.trace) {
            // Re-protect previously-touched pages so their NEXT access re-faults
            // (gives an ordered read/write trace across the buffer). Make THIS page
            // accessible so the faulting instruction completes.
            for (const p of this.pendingReArm) if (p !== page) ptm?.setProtection(p, PAGE_SIZE, PAGE_NOACCESS);
            this.pendingReArm = [page];
            ptm?.setProtection(page, PAGE_SIZE, PAGE_READWRITE);
            if (this.hits.length < MAX_HITS) {
                const hit = this._buildHit(a, page, faultingEip, thunk, cpu, isWrite ? "W" : "R");
                this.hits.push(hit);
            }
            return true;
        }

        if (!isWrite || !isPresent) return false;
        // Un-protect just this page so the retried store (and the rest of the
        // fill to this page) lands.
        ptm?.setProtection(page, PAGE_SIZE, PAGE_READWRITE);

        if (!this.seenPages.has(page) && this.hits.length < MAX_HITS) {
            this.seenPages.add(page);
            const hit = this._buildHit(a, page, faultingEip, thunk, cpu, "W");
            this.hits.push(hit);
            Logger.log(LogCategory.SYSTEM,
                `[MemWriteTrap] WRITE #${hit.seq} addr=0x${a.toString(16)} page=0x${page.toString(16)} ` +
                `eip=0x${hit.eip.toString(16)}${hit.module ? ` (${hit.module})` : ""} thunk=${hit.thunk || "?"}`);
        }
        return true;
    }

    private _buildHit(a: number, page: number, faultingEip: number, thunk: string, cpu: any, rw: string): MemWriteTrapHit {
        {
            let module = "";
            const mr = System.getInstance().process?.moduleRegistry;
            const mod = mr?.getModuleContainingAddress?.(faultingEip >>> 0);
            if (mod) module = `${mod.name}+0x${((faultingEip >>> 0) - mod.baseAddress).toString(16)}`;
            const regs: number[] = [];
            const r = cpu?.reg32;
            if (r) for (let i = 0; i < 8; i++) regs.push((r[i] >>> 0));
            // Walk the EBP chain for the call stack (best-effort; standard frames).
            const stack: number[] = [];
            try {
                const m = System.getInstance().process?.getCurrentMemory?.();
                if (m && r) {
                    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
                    let ebp = (r[5] >>> 0);
                    for (let i = 0; i < 12 && ebp > 0x1000 && ebp + 8 <= m.length; i++) {
                        stack.push(dv.getUint32(ebp + 4, true) >>> 0);
                        const next = dv.getUint32(ebp, true) >>> 0;
                        if (next <= ebp) break;
                        ebp = next;
                    }
                }
            } catch { /* best-effort */ }
            let tid: number | string = "?";
            try { tid = System.getInstance().scheduler?.getCurrentThread?.()?.id ?? "?"; } catch { /* ignore */ }
            // For a copy loop, scan around the source register (ESI=regs[6]) to find
            // where dense pixel data actually lives relative to the source pointer —
            // exposes a stale/offset source pointer (data present but N KB away).
            const srcScan: string[] = [];
            try {
                const m = System.getInstance().process?.getCurrentMemory?.();
                const esi = r ? (r[6] >>> 0) : 0;
                if (m && esi > 0x1000) {
                    const lo = Math.max(0, esi - 0x40000), hi = Math.min(m.length, esi + 0x40000);
                    for (let p = lo & ~0xfff; p + 0x1000 <= hi; p += 0x1000) {
                        let nz = 0; for (let i = 0; i < 0x1000; i += 7) if (m[p + i]) nz++;
                        if (nz > 100) srcScan.push(`${esi <= p ? "+" : "-"}0x${Math.abs(p - esi).toString(16)}:${nz}`);
                    }
                }
            } catch { /* best-effort */ }
            // Heuristic stack scan (FPO-proof): from the guest ESP, collect words
            // that resolve to a loaded module's code → the call chain. The #PF stub
            // pushed 24 bytes (saved EAX/EDX + errcode + EIP + CS + EFLAGS) over the
            // faulting frame, so the guest ESP = handler ESP + 24.
            const rawStack: string[] = [];
            try {
                const m = System.getInstance().process?.getCurrentMemory?.();
                const mr = System.getInstance().process?.moduleRegistry as any;
                if (m && r && mr?.getModuleContainingAddress) {
                    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
                    const gesp = ((r[4] >>> 0) + 24) >>> 0;
                    const seen = new Set<string>();
                    for (let off = 0; off < 0x300 && gesp + off + 4 <= m.length && rawStack.length < 16; off += 4) {
                        const v = dv.getUint32(gesp + off, true) >>> 0;
                        if (v < 0x400000) continue;
                        const mod = mr.getModuleContainingAddress(v);
                        if (!mod) continue;
                        const s = `${mod.name}+0x${(v - mod.baseAddress).toString(16)}`;
                        if (!seen.has(s)) { seen.add(s); rawStack.push(s); }
                    }
                }
            } catch { /* best-effort */ }
            const hit: MemWriteTrapHit = {
                addr: a, page, eip: faultingEip >>> 0, module, thunk: thunk || "", tid, regs, stack, srcScan, rawStack, rw, seq: this.seq++,
            };
            return hit;
        }
    }

    /** Snapshot of recorded writes. */
    report(): { armed: boolean; label: string; base: number; end: number; pagesHit: number; hits: MemWriteTrapHit[] } {
        return {
            armed: this.armed,
            label: this.label,
            base: this.base >>> 0,
            end: this.end >>> 0,
            pagesHit: this.trace ? new Set(this.hits.map(h => h.page)).size : this.seenPages.size,
            hits: this.hits.slice(),
        };
    }

    /** Restore RW over the whole armed range and stop trapping. */
    disarm(): { disarmed: boolean } {
        if (!this.armed) return { disarmed: false };
        const ptm = System.getInstance().process?.pageTableManager;
        const pageBase = this.base & ~(PAGE_SIZE - 1);
        const pageEnd = (this.end + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
        ptm?.setProtection(pageBase, pageEnd - pageBase, PAGE_READWRITE);
        this.armed = false;
        this.trace = false;
        this.watch = false;
        this.pendingReArm = [];
        Logger.log(LogCategory.SYSTEM,
            `[MemWriteTrap] disarmed; restored RW over 0x${pageBase.toString(16)}..0x${pageEnd.toString(16)}; ` +
            `${this.hits.length} write(s) recorded across ${this.seenPages.size} page(s)`);
        return { disarmed: true };
    }
}

export const memWriteTrap = new MemWriteTrap();
