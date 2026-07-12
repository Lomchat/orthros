/**
 * Log hub — the multi-session log-intelligence layer. The emulator can
 * emit megabytes/sec; the firehose must NOT be shipped wholesale. The hub owns a
 * single zero-cost Logger TAP (installed only while watchers/aggregation are
 * active) and turns the stream into:
 *
 *  - watchLog(pattern): the inverse of streaming — subscribe to SIGNAL (an error
 *    class, a specific unimplemented stub, a state value) → emit a `logMatch`
 *    event the agent can waitForEvent() on, ignoring the noise.
 *  - aggregation: full-session counters (levelHist + unimplemented/unknown-args +
 *    bounded template top-N) maintained live — valuable because the in-memory ring
 *    is tiny (50). On-demand logStats() (cmds/logs.ts) covers the recent ring;
 *    this covers the whole session, opt-in (the per-entry template normalize costs
 *    regex, so it's off by default).
 *
 * The durable archive (the log-server :3001) stays the persistence tier — the hub
 * feeds it summaries/triggered dumps, never the raw firehose by default.
 */

import { Logger, LogCategory } from "../core/logger";
import { harnessBus } from "./event-bus";

/** Structural shape of a log entry (avoids a hard type dep on Logger's internal
 *  LogEntry so this module is self-contained). */
interface LogEntry {
    timestamp: number;
    category: number;
    level: number;
    message: string;
}

/** Logger gained addLogTap/removeLogTap in the harness hooks; access dynamically
 *  so this module compiles+no-ops even before that landed. */
const loggerTaps = Logger as unknown as {
    addLogTap?: (fn: (e: LogEntry) => void) => void;
    removeLogTap?: (fn: (e: LogEntry) => void) => void;
};

interface Watcher {
    id: number;
    pattern: string;
    regex: RegExp;
    runId: number | null;
    once: boolean;
    hits: number;
}

const TEMPLATE_CAP = 1000;

function normalizeTemplate(msg: string): string {
    return msg
        .replace(/0x[0-9a-fA-F]+/g, "0x?")
        .replace(/\b\d+\b/g, "#")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}

class LogHub {
    private watchers: Watcher[] = [];
    private nextId = 1;
    private tapInstalled = false;
    private aggregating = false;
    private tap = (e: LogEntry) => this.onEntry(e);

    // Aggregation state (full-session, while aggregating).
    private levelHist: Record<string, number> = {};
    private templates = new Map<string, { count: number; category: string; sample: string }>();
    private unimplemented = 0;
    private unknownArgs = 0;
    private total = 0;

    private ensureTap(): void {
        const needed = this.watchers.length > 0 || this.aggregating;
        if (needed && !this.tapInstalled) {
            loggerTaps.addLogTap?.(this.tap);
            this.tapInstalled = true;
        } else if (!needed && this.tapInstalled) {
            loggerTaps.removeLogTap?.(this.tap);
            this.tapInstalled = false;
        }
    }

    private onEntry(e: LogEntry): void {
        if (this.watchers.length) {
            for (const w of [...this.watchers]) {
                if (!w.regex.test(e.message)) continue;
                w.hits++;
                harnessBus.emit("logMatch", {
                    pattern: w.pattern,
                    category: (LogCategory as any)[e.category] ?? String(e.category),
                    level: e.level,
                    message: e.message,
                    timestamp: e.timestamp,
                }, w.runId);
                if (w.once) this.unwatch(w.id);
            }
        }
        if (this.aggregating) {
            this.total++;
            const lvl = String(e.level);
            this.levelHist[lvl] = (this.levelHist[lvl] ?? 0) + 1;
            const m = e.message.toLowerCase();
            if (m.includes("unimplemented") || m.includes("not implemented") || m.includes("stub")) this.unimplemented++;
            if (m.includes("unknown arg") || m.includes("arg count") || m.includes("argcount")) this.unknownArgs++;
            const t = normalizeTemplate(e.message);
            const cur = this.templates.get(t);
            if (cur) cur.count++;
            else if (this.templates.size < TEMPLATE_CAP) this.templates.set(t, { count: 1, category: (LogCategory as any)[e.category] ?? String(e.category), sample: e.message });
        }
    }

    watch(pattern: string, opts: { runId?: number | null; once?: boolean } = {}): number {
        const id = this.nextId++;
        this.watchers.push({ id, pattern, regex: new RegExp(pattern, "i"), runId: opts.runId ?? null, once: opts.once ?? false, hits: 0 });
        this.ensureTap();
        return id;
    }

    unwatch(id: number): void {
        this.watchers = this.watchers.filter((w) => w.id !== id);
        this.ensureTap();
    }

    clearWatches(): number {
        const n = this.watchers.length;
        this.watchers = [];
        this.ensureTap();
        return n;
    }

    listWatches(): Array<{ id: number; pattern: string; hits: number; once: boolean }> {
        return this.watchers.map((w) => ({ id: w.id, pattern: w.pattern, hits: w.hits, once: w.once }));
    }

    setAggregating(on: boolean): void {
        if (on && !this.aggregating) {
            this.levelHist = {}; this.templates.clear(); this.unimplemented = 0; this.unknownArgs = 0; this.total = 0;
        }
        this.aggregating = on;
        this.ensureTap();
    }

    aggStats(top = 30): unknown {
        const ranked = [...this.templates.entries()]
            .map(([template, v]) => ({ template, ...v }))
            .sort((a, b) => b.count - a.count)
            .slice(0, top);
        return { aggregating: this.aggregating, total: this.total, distinct: this.templates.size, capped: this.templates.size >= TEMPLATE_CAP, levelHist: this.levelHist, unimplemented: this.unimplemented, unknownArgs: this.unknownArgs, top: ranked };
    }
}

export const logHub = new LogHub();
