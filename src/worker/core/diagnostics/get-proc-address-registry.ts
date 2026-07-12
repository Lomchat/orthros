/**
 * GetProcAddress registry — deduplicated record of export lookups the guest has
 * performed. NOT FOUND (address=0) entries are the bring-up signal: a game that
 * LoadLibrary'd a DLL then bailed on a missing export shows up here the same way
 * stubRegistry surfaces unimplemented thunks, without grepping the log firehose.
 *
 * Zero-alloc on repeat: a repeated lookup just bumps count.
 */

import { TimeService } from "../../runtime/time";

export interface GetProcAddressHit {
    /** Stable key: "0x<hModule>:<procName>". */
    key: string;
    hModule: number;
    procName: string;
    /** Resolved address; 0 = ERROR_PROC_NOT_FOUND. */
    address: number;
    count: number;
    firstCaller: number;
    lastCaller: number;
    firstTs: number;
    lastTs: number;
}

export interface GetProcAddressRecent {
    hModule: number;
    procName: string;
    address: number;
    caller: number;
    ts: number;
}

const RING_SIZE = 32;

class GetProcAddressRegistry {
    private map = new Map<string, GetProcAddressHit>();
    private ring: GetProcAddressRecent[] = new Array(RING_SIZE);
    private ringWrite = 0;
    private ringCount = 0;

    record(hModule: number, procName: string, address: number, caller: number): void {
        const mod = hModule >>> 0;
        const addr = address >>> 0;
        const ret = caller >>> 0;
        const key = `0x${mod.toString(16)}:${procName}`;
        const ts = TimeService.getInstance().nowMs();

        const slot = this.ringWrite;
        this.ring[slot] = { hModule: mod, procName, address: addr, caller: ret, ts };
        this.ringWrite = (slot + 1) % RING_SIZE;
        if (this.ringCount < RING_SIZE) this.ringCount++;

        const existing = this.map.get(key);
        if (existing) {
            existing.count++;
            existing.lastCaller = ret;
            existing.lastTs = ts;
            return;
        }
        this.map.set(key, {
            key,
            hModule: mod,
            procName,
            address: addr,
            count: 1,
            firstCaller: ret,
            lastCaller: ret,
            firstTs: ts,
            lastTs: ts,
        });
    }

    /** Distinct lookups that returned NULL (ERROR_PROC_NOT_FOUND), newest first. */
    misses(): GetProcAddressHit[] {
        return [...this.map.values()]
            .filter((h) => h.address === 0)
            .sort((a, b) => b.lastTs - a.lastTs);
    }

    /** All distinct lookups, newest first. */
    list(): GetProcAddressHit[] {
        return [...this.map.values()].sort((a, b) => b.lastTs - a.lastTs);
    }

    /** Chronological tail of individual lookups (not deduped), oldest..newest. */
    recent(count = 16): GetProcAddressRecent[] {
        const n = Math.min(count, this.ringCount);
        if (n <= 0) return [];
        const out: GetProcAddressRecent[] = [];
        for (let i = 0; i < n; i++) {
            const idx = (this.ringWrite - n + i + RING_SIZE) % RING_SIZE;
            const entry = this.ring[idx];
            if (entry) out.push(entry);
        }
        return out;
    }

    clear(): void {
        this.map.clear();
        this.ring.fill(undefined as unknown as GetProcAddressRecent);
        this.ringWrite = 0;
        this.ringCount = 0;
    }
}

export const getProcAddressRegistry = new GetProcAddressRegistry();
