/**
 * VC9 _except_handler4_common — XOR-decoded scope table walk.
 */

import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { evaluateSimpleFilter } from "../core/seh-dispatch";
import type { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { getCPU } from "../core/thunking/thunk-utils";
import type { Process } from "../core/process";

const DEFAULT_SECURITY_COOKIE = 0xbb40e64e;

export interface Vc9SehHost {
    process: Process;
    notifySehAborted: (reason: string) => void;
}

function readSecurityCookie(mem: Uint8Array): number {
    // Scan for __security_cookie in .data — fallback to default
    for (let addr = 0x10000000; addr < 0x18000000 && addr + 4 <= mem.length; addr += 4) {
        const v = Mem.readUint32(addr) ?? 0;
        if (v !== 0 && v !== 0xffffffff && (v & 0xffff0000) === 0xbb400000) return v >>> 0;
    }
    return DEFAULT_SECURITY_COOKIE;
}

function decodeDword(encoded: number, cookie: number): number {
    return (encoded ^ cookie) >>> 0;
}

export function registerVc9SehExports(exports: Record<string, ThunkImplementation>, host: Vc9SehHost): void {
    exports["_except_handler4_common"] = (_ctx, mem, args): ThunkResult | number => {
        const pExcRec = args[0] >>> 0;
        const frameAddr = args[1] >>> 0;
        const pContext = args[2] >>> 0;

        const cpu = getCPU(host.process.v86);
        if (!cpu) return 1;

        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const excFlags = pExcRec + 4 < mem.length ? dv.getUint32(pExcRec + 4, true) : 0;
        if (excFlags & 0x06) return 1; // unwind — ContinueSearch

        if (frameAddr + 16 > mem.length) return 1;

        const scopeTable = dv.getUint32(frameAddr + 8, true);
        let trylevel = dv.getInt32(frameAddr + 12, true);
        const frameEbp = frameAddr + 16;

        if (scopeTable < 0x1000 || scopeTable + 28 > mem.length) {
            Logger.warn(LogCategory.SYSTEM,
                `_except_handler4_common: bad scopeTable=0x${scopeTable.toString(16)}`);
            return 1;
        }

        const cookie = readSecurityCookie(mem);
        const entriesBase = scopeTable + 16;

        Logger.verbose(LogCategory.SYSTEM,
            `_except_handler4_common: frame=0x${frameAddr.toString(16)} scope=0x${scopeTable.toString(16)} ` +
            `trylevel=${trylevel} cookie=0x${cookie.toString(16)}`);

        const epAddr = (frameAddr - 12) >>> 0;
        if (epAddr >= 4 && frameAddr <= mem.length) {
            dv.setUint32(epAddr, pExcRec, true);
            dv.setUint32(epAddr + 4, pContext, true);
            dv.setUint32((frameAddr - 4) >>> 0, epAddr, true);
        }
        cpu.reg32[5] = frameEbp | 0;

        let safety = 0;
        while (trylevel >= 0 && safety < 256) {
            safety++;
            const entryBase = entriesBase + trylevel * 12;
            if (entryBase + 12 > mem.length) break;

            const previousTryLevel = (dv.getUint32(entryBase, true) ^ cookie) | 0;
            const prevSigned = previousTryLevel > 0x7fffffff ? previousTryLevel - 0x100000000 : previousTryLevel;
            const filterEnc = dv.getUint32(entryBase + 4, true);
            const handlerEnc = dv.getUint32(entryBase + 8, true);
            const filterAddr = decodeDword(filterEnc, cookie);
            const handlerAddr = decodeDword(handlerEnc, cookie);

            if (filterAddr === 0 || filterAddr + 6 > mem.length) {
                trylevel = prevSigned;
                continue;
            }

            const exceptionCode = pExcRec !== 0 && pExcRec + 4 <= mem.length
                ? dv.getUint32(pExcRec, true)
                : 0xc0000005;
            const filterResult = evaluateSimpleFilter(mem, filterAddr, mem.length, exceptionCode);

            if (filterResult === 1) {
                dv.setInt32(frameAddr + 12, prevSigned, true);
                cpu.reg32[5] = frameEbp | 0;
                const adjustedEsp = (frameAddr - 4) >>> 0;
                cpu.reg32[4] = adjustedEsp;
                dv.setUint32(adjustedEsp, handlerAddr, true);
                host.notifySehAborted("eh4_execute_handler");
                return { value: 0, skipStackCheck: true };
            }
            if (filterResult === 0) {
                trylevel = prevSigned;
                continue;
            }
            if (filterResult === -1) return 0;
            // Complex filter — ContinueSearch (Stage B: static stub)
            Logger.warn(LogCategory.SYSTEM, `_except_handler4_common: complex filter 0x${filterAddr.toString(16)}`);
            return 1;
        }
        return 1;
    };
}
