/**
 * Cold-start timing instrumentation. Captures timestamps at major boot phase
 * boundaries and logs a breakdown table once the emulator is ready.
 *
 * All marks are also emitted as `performance.mark("bs:<name>")` so they appear
 * inline in Chrome DevTools traces next to the CPU profile.
 *
 * Use `bootMark(name)` at the boundary; call `dumpBootTimeline()` at the end
 * of cold-start to print the per-phase breakdown.
 */

interface BootMark {
    name: string;
    ts: number;
}

const _marks: BootMark[] = [];
let _dumped = false;

export function bootMark(name: string): void {
    const ts = performance.now();
    _marks.push({ name, ts });
    try {
        performance.mark(`bs:${name}`);
    } catch {
        // performance.mark can throw on invalid names — silently ignore
    }
}

export function dumpBootTimeline(): void {
    if (_dumped || _marks.length < 2) return;
    _dumped = true;

    const first = _marks[0]!.ts;
    const last = _marks[_marks.length - 1]!.ts;
    const rows: Array<{ phase: string; elapsed: string; sinceBoot: string }> = [];

    for (let i = 1; i < _marks.length; i++) {
        const prev = _marks[i - 1]!;
        const cur = _marks[i]!;
        rows.push({
            phase: `${prev.name} → ${cur.name}`,
            elapsed: `${(cur.ts - prev.ts).toFixed(1)} ms`,
            sinceBoot: `${(cur.ts - first).toFixed(1)} ms`,
        });
    }

    console.log(`[BOOT] Cold-start timeline — total ${(last - first).toFixed(1)} ms`);
    console.table(rows);
}

/** Retrieve raw marks for programmatic access (e.g. from console). */
export function getBootMarks(): ReadonlyArray<BootMark> {
    return _marks;
}
