/**
 * Surfaces guest file activity to the host loading overlay during the final
 * "booting" phase (PE loaded → first composite).
 *
 * In that window the guest runs its own CRT/DirectX init and asset loading with
 * no phase signals of its own, so the overlay would otherwise show only a bare
 * indeterminate shimmer. We report the basename of each ROM (game-data) file the
 * guest opens as a sub-status line ("Starting <game> · <file>"), giving the user
 * a concrete, faithful "it's reading its assets" signal — no per-game logic.
 *
 * Active ONLY between setBootOverlayActive(true) (the loader posts "done") and
 * setBootOverlayActive(false) (first_present). Outside that window every call is
 * a single-boolean no-op, so it is safe to call from the hot file-open path.
 */

let active = false;
let lastPostTs = 0;
let lastName = "";

/** Min gap between posts — keeps fast asset bursts from spilling a message per open. */
const THROTTLE_MS = 100;

/** Toggle the boot-overlay window. Resets the throttle/dedupe state on each edge. */
export function setBootOverlayActive(on: boolean): void {
    active = on;
    lastPostTs = 0;
    lastName = "";
}

/**
 * Note that the guest opened a file. No-op unless the boot overlay is active.
 * Only ROM-sourced (game-content) opens are surfaced — overlay-sourced opens are
 * saves/config/temp writes, not "loading".
 */
export function noteBootFileActivity(path: string, source: string): void {
    if (!active) return;
    if (source !== "rom") return;

    const base = (path.split(/[\\/]/).pop() || path).trim();
    if (!base || base === lastName) return;

    const now = performance.now();
    if (now - lastPostTs < THROTTLE_MS) return;
    lastPostTs = now;
    lastName = base;

    self.postMessage({ type: "loading_progress", phase: "booting", label: base });
}
