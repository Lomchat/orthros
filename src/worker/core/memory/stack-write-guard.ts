/**
 * Parked-stack write guard — a plant-time tripwire for the "0x7c07 escape" corruption class.
 *
 * Invariant: JS-side machinery (thunk return paths, async park/restore, callback frame
 * building, SEH trampoline emission) may write to guest stacks ONLY in the dead zone at or
 * below the owning thread's ESP. A write into the LIVE range [savedEsp+4, stackTop) of a
 * PARKED (non-running) thread is corruption being planted: it will detonate later as a
 * wild RET / #GP far from the cause.
 *
 * The guard is LOG-ONLY (never blocks the write): the goal is that the FIRST natural
 * occurrence names the culprit with a JS stack trace at write time, instead of a
 * post-mortem that cannot (the #GP frame destroys the corrupted slot and previous_ip).
 *
 * Zero-alloc on the check path: the scheduler registers a visitor-based provider that
 * iterates its thread table without building arrays; scratch state lives in module vars.
 * Violations are rare by definition — those pay for an Error().stack capture.
 */

import { Logger, LogCategory } from '../logger';

/** Visit one parked thread's live stack range. Return true to stop iteration. */
export type ParkedRangeVisitor = (
    tid: number,
    liveLo: number,
    liveHi: number,
    savedEsp: number,
    state: string,
) => boolean;

export type ParkedRangeProvider = (visit: ParkedRangeVisitor) => void;

let provider: ParkedRangeProvider | null = null;
let currentTidProvider: (() => number) | null = null;

/** Registered by the scheduler (the only component that knows thread states + stacks). */
export function setParkedStackProvider(p: ParkedRangeProvider, currentTid: () => number): void {
    provider = p;
    currentTidProvider = currentTid;
}

const MAX_VIOLATIONS = 16;
const violations: string[] = [];
let totalViolations = 0;

// Scratch state for the zero-alloc visitor (module-level to avoid closures per check).
let scratchAddr = 0;
let scratchEnd = 0;
let hitFound = false;
let hitTid = 0;
let hitLo = 0;
let hitHi = 0;
let hitEsp = 0;
let hitState = '';

const visitor: ParkedRangeVisitor = (tid, lo, hi, esp, state) => {
    if (scratchEnd > lo && scratchAddr < hi) {
        hitFound = true;
        hitTid = tid; hitLo = lo; hitHi = hi; hitEsp = esp; hitState = state;
        return true;
    }
    return false;
};

// Bootloader byte range: a machinery write carrying a VALUE in this range is planting a
// "escape to 0x7c07" detonator (the only legit 0x7cXX writes are the boot-time image
// itself, which does not go through guardStackWrite). Checked regardless of target —
// this also covers CURRENT-thread stack targets, which the parked-range check exempts.
const BOOT_RANGE_LO = 0x7c00;
const BOOT_RANGE_HI = 0x9000;

/**
 * Assert a machinery write does not land in a parked thread's live stack range and does
 * not carry a bootloader-region value (the 0x7c07-escape detonator).
 * Returns false on violation (callers still perform the write — log-only tripwire).
 */
export function guardStackWrite(addr: number, size: number, who: string, value?: number): boolean {
    if (!provider) return true;
    scratchAddr = addr >>> 0;
    scratchEnd = (scratchAddr + (size >>> 0)) >>> 0;
    hitFound = false;
    provider(visitor);
    if (!hitFound) {
        if (value !== undefined && (value >>> 0) >= BOOT_RANGE_LO && (value >>> 0) < BOOT_RANGE_HI) {
            totalViolations++;
            const jsStack0 = (new Error().stack || '')
                .split('\n').slice(2, 9).map((s) => s.trim()).join(' <- ');
            const line0 =
                `#${totalViolations} t=${Math.round(performance.now())}ms ${who}: ` +
                `BOOT-RANGE VALUE write 0x${scratchAddr.toString(16)}+${size}=0x${(value >>> 0).toString(16)} ` +
                `(0x7c00..0x9000 detonator) @ ${jsStack0}`;
            if (violations.length >= MAX_VIOLATIONS) violations.shift();
            violations.push(line0);
            if (totalViolations <= 8 || totalViolations % 256 === 0) {
                Logger.error(LogCategory.SYSTEM, `[STACK-GUARD] ${line0}`);
            }
            return false;
        }
        return true;
    }

    totalViolations++;
    const writerTid = currentTidProvider ? currentTidProvider() : -1;
    // Trim the JS stack to the interesting middle (skip Error + guardStackWrite frames).
    const jsStack = (new Error().stack || '')
        .split('\n').slice(2, 9).map((s) => s.trim()).join(' <- ');
    const line =
        `#${totalViolations} t=${Math.round(performance.now())}ms ${who}: ` +
        `write 0x${scratchAddr.toString(16)}+${size}` +
        (value !== undefined ? `=0x${(value >>> 0).toString(16)}` : '') +
        ` hits PARKED T${hitTid}(${hitState}) live=[0x${hitLo.toString(16)},0x${hitHi.toString(16)})` +
        ` savedEsp=0x${hitEsp.toString(16)} writer=T${writerTid} @ ${jsStack}`;
    if (violations.length >= MAX_VIOLATIONS) violations.shift();
    violations.push(line);
    // Full log for the first few; then throttle (a storming writer would flood the log).
    if (totalViolations <= 8 || totalViolations % 256 === 0) {
        Logger.error(LogCategory.SYSTEM, `[STACK-GUARD] ${line}`);
    }
    return false;
}

/** Violation ring (newest last) for the crash report. */
export function getStackGuardViolations(): string[] {
    return violations.slice();
}

export function getStackGuardViolationCount(): number {
    return totalViolations;
}
