/**
 * Lock Tracker - отслеживает Lock/Unlock паттерны для оптимизации
 */

import { Logger, LogCategory } from "./logger";

interface LockInfo {
    surfacePtr: number;
    lockTime: number;
    flags: number;
    didReadback: boolean;
    readbackTime?: number;
}

// Per-surface readback skip heuristic.
// If a surface has been Locked N+ times and NEVER with READONLY flag,
// the game is treating it as write-only and readback can be skipped.
const DDLOCK_READONLY = 0x00000010;
const DDLOCK_WRITEONLY = 0x00000020;
const WRITEONLY_LEARN_THRESHOLD = 3; // Skip readback after N consecutive non-readonly locks

interface SurfaceLockProfile {
    /** Number of consecutive locks without READONLY flag */
    consecutiveNonReadonly: number;
    /** True if the game ever used READONLY on this surface */
    everUsedReadonly: boolean;
    /** True if we've decided this surface is write-only (stable after threshold) */
    assumeWriteOnly: boolean;
}

class LockTracker {
    private activeLocks = new Map<number, LockInfo>();
    private lockHistory: Array<{
        surfacePtr: number;
        duration: number;
        didReadback: boolean;
        readbackTime?: number;
        dataAccessed: boolean;
    }> = [];
    /** Per-surface write-only heuristic profiles */
    private surfaceProfiles = new Map<number, SurfaceLockProfile>();

    startLock(surfacePtr: number, flags: number, didReadback: boolean, readbackTime?: number): void {
        this.activeLocks.set(surfacePtr, {
            surfacePtr,
            lockTime: performance.now(),
            flags,
            didReadback,
            readbackTime,
        });

        // Update per-surface write-only profile
        let profile = this.surfaceProfiles.get(surfacePtr);
        if (!profile) {
            profile = { consecutiveNonReadonly: 0, everUsedReadonly: false, assumeWriteOnly: false };
            this.surfaceProfiles.set(surfacePtr, profile);
        }
        if (flags & DDLOCK_READONLY) {
            profile.everUsedReadonly = true;
            profile.consecutiveNonReadonly = 0;
            profile.assumeWriteOnly = false;
        } else {
            profile.consecutiveNonReadonly++;
            if (!profile.everUsedReadonly && profile.consecutiveNonReadonly >= WRITEONLY_LEARN_THRESHOLD) {
                profile.assumeWriteOnly = true;
            }
        }
    }

    /**
     * Returns true if this surface has been consistently Locked without READONLY,
     * suggesting the game only writes and readback can be skipped.
     */
    shouldSkipReadback(surfacePtr: number): boolean {
        const profile = this.surfaceProfiles.get(surfacePtr);
        return profile?.assumeWriteOnly ?? false;
    }

    endLock(surfacePtr: number, dataAccessed: boolean): void {
        const info = this.activeLocks.get(surfacePtr);
        if (!info) {
            Logger.warn(LogCategory.DDRAW, `LockTracker: Unlock without Lock for surface 0x${surfacePtr.toString(16)}`);
            return;
        }

        const duration = performance.now() - info.lockTime;
        this.activeLocks.delete(surfacePtr);

        this.lockHistory.push({
            surfacePtr: info.surfacePtr,
            duration,
            didReadback: info.didReadback,
            readbackTime: info.readbackTime,
            dataAccessed,
        });

        // Keep only last 100 locks
        if (this.lockHistory.length > 100) {
            this.lockHistory.shift();
        }

        // Log expensive readbacks that weren't used
        if (info.didReadback && info.readbackTime && info.readbackTime > 50 && !dataAccessed) {
            Logger.warn(LogCategory.DDRAW,
                `⚠️ WASTED READBACK! Surface 0x${surfacePtr.toString(16)} readback took ${info.readbackTime.toFixed(2)}ms ` +
                `but data was NOT accessed during Lock! (locked for ${duration.toFixed(2)}ms) ` +
                `→ Can optimize by skipping readback!`
            );
        }
    }

    getStats(): {
        totalLocks: number;
        expensiveReadbacks: number;
        wastedReadbacks: number;
        avgReadbackTime: number;
    } {
        const expensiveReadbacks = this.lockHistory.filter(l => l.didReadback && l.readbackTime && l.readbackTime > 50);
        const wastedReadbacks = expensiveReadbacks.filter(l => !l.dataAccessed);
        const totalReadbackTime = expensiveReadbacks.reduce((sum, l) => sum + (l.readbackTime || 0), 0);

        return {
            totalLocks: this.lockHistory.length,
            expensiveReadbacks: expensiveReadbacks.length,
            wastedReadbacks: wastedReadbacks.length,
            avgReadbackTime: expensiveReadbacks.length > 0 ? totalReadbackTime / expensiveReadbacks.length : 0,
        };
    }

    logSummary(): void {
        const stats = this.getStats();
        if (stats.expensiveReadbacks === 0) return;

        Logger.log(LogCategory.DDRAW,
            `\n📊 Lock/Readback Summary:\n` +
            `  Total locks: ${stats.totalLocks}\n` +
            `  Expensive readbacks (>50ms): ${stats.expensiveReadbacks}\n` +
            `  Wasted readbacks (data not accessed): ${stats.wastedReadbacks}\n` +
            `  Avg readback time: ${stats.avgReadbackTime.toFixed(2)}ms\n` +
            `  ${stats.wastedReadbacks > 0 ? '⚠️ Can optimize by skipping unused readbacks!' : '✅ All readbacks were used'}`
        );
    }
}

export const lockTracker = new LockTracker();
