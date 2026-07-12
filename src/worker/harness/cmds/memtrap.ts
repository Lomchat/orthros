/**
 * Memory write-trap commands — diagnose "the guest never writes here" mysteries
 * (a DDraw surface whose CPU pixels stay zero despite a Lock/fill). Built on the
 * recoverable #PF handler: trapWrites() flips pages to read-only, the first guest
 * store to each page faults → we record the writer EIP, un-protect the page so
 * the store lands, and the guest continues unaware.
 *
 *   trapWrites(addr, len?, label?) — arm over [addr, addr+len) (default 4KB).
 *   memTrapReport()                — list recorded writer EIPs (module+offset).
 *   memTrapClear()                 — restore RW and stop trapping.
 *
 * Decisive: hits.length>0 → the guest DOES write here (resolve the EIPs via `re`).
 * hits.length==0 after the fill window → it writes elsewhere (wrong lpSurface /
 * different surface / GPU-filled). No JIT-off required.
 */

import type { HarnessService } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { memWriteTrap } from "../../core/memory/mem-write-trap";

function toAddr(x: unknown): number {
    if (typeof x === "number") return x >>> 0;
    const s = String(x ?? "").trim();
    if (!s) throw new HarnessError("expected an address", HarnessErrorCode.BAD_ARGS);
    return (s.startsWith("0x") || s.startsWith("0X") ? parseInt(s.slice(2), 16) : parseInt(s, 16)) >>> 0;
}

export function registerMemTrapCommands(svc: HarnessService): void {
    svc.register("trapWrites", (args) => {
        const addr = toAddr(args[0]);
        const len = args[1] != null ? Math.max(1, Number(args[1]) | 0) : 0x1000;
        const label = args[2] != null ? String(args[2]) : "";
        const opts = (args[3] ?? {}) as { trace?: boolean; watch?: boolean; recordAddr?: number; recordLen?: number };
        const res = memWriteTrap.arm(addr, len, label, opts);
        return {
            ...res,
            note: opts.watch
                ? "WATCH mode: pages RO + re-arm; EVERY write to the trapped page(s) faults and re-arms, but ONLY writes landing in [addr,addr+len) are recorded (with writer EIP). Catches repeated writers of ONE field on a busy page — no read-flood, no eviction, no JIT-off. memTrapReport() to read."
                : opts.trace
                ? "TRACE mode: pages NO-ACCESS; EVERY guest read+write is recorded in order (re-arm scheme) — captures the write→reuse→read sequence on a buffer. Keep the range SMALL (a few pages)."
                : "pages are read-only; first guest store to each faults and is recorded, then the page goes RW and the store lands. memTrapReport() to read; memTrapClear() to restore.",
        };
    });

    svc.register("memTrapReport", () => memWriteTrap.report());

    svc.register("memTrapClear", () => memWriteTrap.disarm());
}
