/**
 * DebugSession — AI-driven runtime observation system.
 *
 * Workflow:
 *   1. AI writes debug-config.json (or calls debugStart() in DevTools)
 *   2. Game runs, events captured to ring buffer
 *   3. AI calls debugExport() to read JSONL from console
 *
 * Zero-cost when disabled: all hot paths check a single boolean.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemWatchMode = "poll" | "pte";
export type ValueWatchTrigger = "change" | "equals" | "gt" | "lt" | "gte" | "lte";

export interface MemWatch {
    addr: number;
    size: 1 | 2 | 4;
    mode: MemWatchMode;
    label: string;
    /** internal: last polled value */
    _last?: number;
}

export interface SurfaceWatch {
    label: string;
    /** optional: filter by surface address */
    surfAddr?: number;
}

export interface ValueWatch {
    addr: number;
    size: 1 | 2 | 4;
    trigger: ValueWatchTrigger;
    value?: number;
    label: string;
    /** internal */
    _last?: number;
    _fired?: boolean;
}

export interface DebugSessionConfig {
    enabled?: boolean;
    preset?: string;
    watches?: string[];
    surfaceWatches?: SurfaceWatch[];
    memWatches?: MemWatch[];
    valueWatches?: ValueWatch[];
    outputFile?: string;
    maxEvents?: number;
    stopAfterMs?: number;
    captureArgs?: boolean;
    /** Capture SEH dispatch (C++ exception transfer) telemetry. Off unless preset enables it. */
    captureSeh?: boolean;
}

export type SehDispatchStage = "match" | "copy-action" | "trampoline" | "simple-dispatch" | "dispatch-emit";

export interface SehDispatchPayload {
    [key: string]: number | string | boolean | undefined;
}

export interface WatchEvent {
    t: number;
    kind: "thunk" | "mem_change" | "surf_lock" | "surf_unlock" | "surf_blt" | "surf_flip" | "value_trigger" | "session_start" | "session_stop" | "seh_dispatch";
    name?: string;
    thread?: number;
    eip?: number;
    esp?: number;
    args?: number[];
    label?: string;
    addr?: number;
    from?: number;
    to?: number;
    value?: number;
    surfAddr?: number;
    rect?: number[];
    /** seh_dispatch only */
    stage?: SehDispatchStage;
    /** seh_dispatch only — opaque structured payload */
    seh?: SehDispatchPayload;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const PRESETS: Record<string, Partial<DebugSessionConfig>> = {
    "ddraw-surface": {
        watches: ["*Flip*", "Lock", "Unlock", "Blt"],
        maxEvents: 5000,
    },
    "crash-trace": {
        watches: ["*"],
        maxEvents: 1000,
        captureArgs: false,
    },
    "d3d-draw": {
        watches: ["BeginScene", "EndScene", "*DrawPrimitive*", "SetTexture", "SetRenderState"],
        maxEvents: 5000,
    },
    "fpu-trace": {
        watches: ["_ftol", "_CI*", "_controlfp"],
        maxEvents: 3000,
        captureArgs: true,
    },
    "mem-corruption": {
        watches: [],
        maxEvents: 2000,
    },
    "seh-cxx": {
        watches: ["kernel32:RaiseException", "kernel32:RtlUnwind", "msvcrt:_CxxThrowException", "kernel32:WriteFile"],
        captureArgs: true,
        captureSeh: true,
        maxEvents: 5000,
    },
    "narr-diag": {
        memWatches: [
            { addr: 0x0069954c, size: 4, mode: "poll", label: "sess_connected" },
            { addr: 0x0069d808, size: 4, mode: "poll", label: "CNetManager" },
            { addr: 0x0069ccb0, size: 4, mode: "poll", label: "narr_guard_ccb0" },
            { addr: 0x006993c4, size: 4, mode: "poll", label: "snd_mgr_ptr" },
            { addr: 0x00699290, size: 4, mode: "poll", label: "no_sound" },
            { addr: 0x00698764, size: 4, mode: "poll", label: "master_vol" },
            { addr: 0x0069d7b8, size: 4, mode: "poll", label: "narr_q_count" },
            { addr: 0x0069fbe8, size: 4, mode: "poll", label: "campaign_obj" },
            { addr: 0x0069d638, size: 4, mode: "poll", label: "narr_timer_d638" },
            { addr: 0x0069d634, size: 4, mode: "poll", label: "narr_timer_d634" },
            { addr: 0x0069774c, size: 1, mode: "poll", label: "speed_mode" },
            { addr: 0x00691209, size: 1, mode: "poll", label: "effects_flag" },
        ],
        maxEvents: 10000,
    },
};

// ---------------------------------------------------------------------------
// Glob → RegExp helper
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
}

// ---------------------------------------------------------------------------
// DebugSession
// ---------------------------------------------------------------------------

class DebugSession {
    private _enabled = false;
    private _config: DebugSessionConfig | null = null;
    private _patterns: RegExp[] = [];
    private _events: WatchEvent[] = [];
    private _startTime = 0;
    private _stopTimer: ReturnType<typeof setTimeout> | null = null;
    private _mem8Getter: (() => Uint8Array | null) | null = null;

    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------

    start(cfg: DebugSessionConfig): void {
        // Merge preset if specified
        let merged: DebugSessionConfig = { ...cfg };
        if (cfg.preset && PRESETS[cfg.preset]) {
            merged = { ...PRESETS[cfg.preset], ...cfg };
            // watches: preset wins if caller didn't specify
            if (!cfg.watches && PRESETS[cfg.preset].watches) {
                merged.watches = PRESETS[cfg.preset].watches;
            }
        }

        // Defaults
        merged.maxEvents = merged.maxEvents ?? 5000;
        merged.captureArgs = merged.captureArgs ?? false;
        merged.enabled = true;

        // Compile watch patterns
        this._patterns = (merged.watches ?? []).map(globToRegex);

        // Initialize mem poll state
        if (merged.memWatches) {
            for (const w of merged.memWatches) {
                w._last = undefined;
            }
        }
        if (merged.valueWatches) {
            for (const v of merged.valueWatches) {
                v._last = undefined;
                v._fired = false;
            }
        }

        this._config = merged;
        this._events = [];
        this._startTime = performance.now();
        this._enabled = true;

        this._record({ kind: "session_start", t: 0 });

        if (merged.stopAfterMs && merged.stopAfterMs > 0) {
            this._stopTimer = setTimeout(() => this.stop(), merged.stopAfterMs);
        }

        console.log(`[DebugSession] Started. preset=${cfg.preset ?? "custom"}, watches=${this._patterns.length}, maxEvents=${merged.maxEvents}`);
    }

    stop(): void {
        if (!this._enabled) return;
        if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
        this._record({ kind: "session_stop", t: this._elapsed() });
        this._enabled = false;
        console.log(`[DebugSession] Stopped. ${this._events.length} events captured.`);
    }

    reset(): void {
        this.stop();
        this._events = [];
        this._patterns = [];
        this._config = null;
    }

    /** Wire up memory accessor for memWatch polling */
    setMemoryGetter(getter: () => Uint8Array | null): void {
        this._mem8Getter = getter;
    }

    // ---------------------------------------------------------------------------
    // Hot path hooks (zero-cost when disabled)
    // ---------------------------------------------------------------------------

    isEnabled(): boolean {
        return this._enabled;
    }

    /** True only when the session is running AND SEH telemetry is opted in. */
    isSehCaptureEnabled(): boolean {
        return this._enabled && this._config?.captureSeh === true;
    }

    /**
     * Record one SEH dispatch event. Caller must guard with isSehCaptureEnabled()
     * because building the payload object isn't free.
     */
    onSehDispatch(stage: SehDispatchStage, payload: SehDispatchPayload, threadId?: number): void {
        if (!this._enabled) return;
        this._record({
            kind: "seh_dispatch",
            t: this._elapsed(),
            stage,
            seh: payload,
            thread: threadId,
        });
    }

    onThunkCall(name: string, threadId: number, eip: number, esp: number, args?: number[]): void {
        if (!this._enabled) return;
        if (!this._matchesPatterns(name)) return;

        this._record({
            kind: "thunk",
            t: this._elapsed(),
            name,
            thread: threadId,
            eip,
            esp,
            args: this._config?.captureArgs ? args : undefined,
        });
    }

    onSurfaceEvent(
        kind: WatchEvent["kind"],
        surfAddr: number,
        rect?: number[],
        threadId?: number
    ): void {
        if (!this._enabled) return;
        const cfg = this._config;
        if (!cfg?.surfaceWatches?.length) return;

        const matches = cfg.surfaceWatches.some(
            w => !w.surfAddr || w.surfAddr === surfAddr
        );
        if (!matches) return;

        this._record({ kind, t: this._elapsed(), surfAddr, rect, thread: threadId });
    }

    /** Call periodically (e.g., from Flip hook) to poll memWatches */
    pollMemWatches(): void {
        if (!this._enabled) return;
        const cfg = this._config;
        if (!cfg?.memWatches?.length && !cfg?.valueWatches?.length) return;

        const mem8 = this._mem8Getter?.();
        if (!mem8 || mem8.byteLength === 0) return;
        const dv = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);

        if (cfg.memWatches) {
            for (const w of cfg.memWatches) {
                if (w.mode !== "poll") continue;
                const cur = this._readMem(dv, w.addr, w.size);
                if (cur === undefined) continue;
                if (w._last === undefined) {
                    // First read: record initial snapshot (no previous value)
                    this._record({
                        kind: "mem_change",
                        t: this._elapsed(),
                        label: w.label,
                        addr: w.addr,
                        from: undefined,
                        to: cur,
                    });
                } else if (cur !== w._last) {
                    this._record({
                        kind: "mem_change",
                        t: this._elapsed(),
                        label: w.label,
                        addr: w.addr,
                        from: w._last,
                        to: cur,
                    });
                }
                w._last = cur;
            }
        }

        if (cfg.valueWatches) {
            for (const v of cfg.valueWatches) {
                const cur = this._readMem(dv, v.addr, v.size);
                if (cur === undefined) continue;
                let fire = false;
                switch (v.trigger) {
                    case "change": fire = v._last !== undefined && cur !== v._last; break;
                    case "equals": fire = cur === (v.value ?? 0); break;
                    case "gt":     fire = cur > (v.value ?? 0); break;
                    case "lt":     fire = cur < (v.value ?? 0); break;
                    case "gte":    fire = cur >= (v.value ?? 0); break;
                    case "lte":    fire = cur <= (v.value ?? 0); break;
                }
                if (fire) {
                    this._record({
                        kind: "value_trigger",
                        t: this._elapsed(),
                        label: v.label,
                        addr: v.addr,
                        value: cur,
                        from: v._last,
                    });
                }
                v._last = cur;
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Export / Console API
    // ---------------------------------------------------------------------------

    dump(): void {
        if (!this._events.length) {
            console.log("[DebugSession] No events captured yet.");
            return;
        }
        console.log(`[DebugSession] ${this._events.length} events (showing last 100):`);
        const slice = this._events.slice(-100);
        console.table(slice.map(e => ({
            t: e.t.toFixed(1) + "ms",
            kind: e.kind,
            name: e.name ?? e.label ?? "",
            thread: e.thread ?? "",
            eip: e.eip ? `0x${e.eip.toString(16)}` : "",
            esp: e.esp ? `0x${e.esp.toString(16)}` : "",
        })));
    }

    export(): string {
        const lines = this._events.map(e => JSON.stringify(e));
        const out = lines.join("\n");
        console.log(`[DebugSession] Exported ${this._events.length} events (JSONL):`);
        console.log(out.slice(0, 20000)); // log up to 20KB so AI can read it
        return out;
    }

    getEvents(): WatchEvent[] {
        return this._events;
    }

    getConfig(): DebugSessionConfig | null {
        return this._config;
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private _elapsed(): number {
        return performance.now() - this._startTime;
    }

    private _matchesPatterns(name: string): boolean {
        if (this._patterns.length === 0) return false;
        for (const re of this._patterns) {
            if (re.test(name)) return true;
        }
        return false;
    }

    private _record(event: WatchEvent): void {
        const max = this._config?.maxEvents ?? 5000;
        if (this._events.length >= max) {
            // Ring: drop oldest
            this._events.shift();
        }
        this._events.push(event);
    }

    private _readMem(dv: DataView, addr: number, size: 1 | 2 | 4): number | undefined {
        try {
            if (addr + size > dv.byteLength) return undefined;
            if (size === 1) return dv.getUint8(addr);
            if (size === 2) return dv.getUint16(addr, true);
            return dv.getUint32(addr, true);
        } catch {
            return undefined;
        }
    }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const debugSession = new DebugSession();

/** Convenience: call from DevTools console */
export function watchThunk(pattern: string, opts?: { captureArgs?: boolean; maxEvents?: number }): void {
    debugSession.start({
        enabled: true,
        watches: [pattern],
        captureArgs: opts?.captureArgs ?? false,
        maxEvents: opts?.maxEvents ?? 3000,
    });
}
