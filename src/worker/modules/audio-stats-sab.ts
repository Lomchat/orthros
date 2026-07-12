/**
 * Worker-side singleton for the AudioWorklet signal-stats SAB.
 *
 * Any audio-producing module (dsound, winmm waveOut, mss32, openal) calls
 * ensureAudioStatsSab() once; the first call allocates the SAB, posts it to the
 * main thread (App.tsx → AudioEngine → worklet "register_stats"), and parks a
 * reference on globalThis.__audioStatsSab so dbg.audio() can read the counters
 * without an import cycle.
 */

import { createStatsSab } from "../../audio/audio-ring-buffer";

let statsSab: SharedArrayBuffer | null = null;

export function ensureAudioStatsSab(): SharedArrayBuffer {
    if (!statsSab) {
        statsSab = createStatsSab();
        (globalThis as any).__audioStatsSab = statsSab;
        self.postMessage({ type: "audio_stats_sab", payload: { sab: statsSab } });
    }
    return statsSab;
}
