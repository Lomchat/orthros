import { GALAXY_HLE_PLAY_EXPORTS, GALAXY_HLE_PERF_EXPORTS } from './export-names';
import type { GalaxyPatchMode } from './types';

export interface GalaxyPatchPlan {
    mode: GalaxyPatchMode;
    exports: readonly string[];
}

/** Select export bodies to patch. Audio exports require mixer hook (not wired yet). */
export function resolveGalaxyPatchPlan(cfg: {
    hleAudio?: boolean;
    hleMixer?: boolean;
}): GalaxyPatchPlan {
    const wantAudio = cfg.hleAudio === true;

    // SAB-bypass: replace the UGalaxyAudioSubsystem audio methods (PlaySound/Register/
    // Music/Stop/Get) with our SAB pipeline. Our handlers REPLACE the native export
    // bodies, so no native voices are ever registered → the native 20ms mixer
    // (FUN_10612250) mixes an empty voice table (cheap) and there is no double-feed.
    // The mixer-kernel JS hook (hleMixer) is a dead end — self-modifying multi-variant
    // runtime-generated kernel, and a per-call OUT-trap on the hot path is a slowdown —
    // so it is not used here; the perf win comes from the native mixer having nothing
    // to mix. Patching is by mangled export name, so this is version-independent across
    // all Galaxy games (HP/UT/Deus Ex/Unreal); no per-game RVA profiles needed.
    if (wantAudio) {
        return { mode: 'audio', exports: GALAXY_HLE_PLAY_EXPORTS };
    }

    return { mode: 'perf', exports: GALAXY_HLE_PERF_EXPORTS };
}

export const GALAXY_PERF_PATCH_COUNT = GALAXY_HLE_PERF_EXPORTS.length;
