import type { Process } from '../../core/process';
import type { GalaxyPatchStats, GalaxySoundEntry } from './types';
import type { GalaxyProfile } from './profiles/types';
import type { GalaxyMixerProbe } from './mixer-probe';
import type { LoadedPEModule } from '../../core/module-registry';
export interface GalaxyContext {
    process: Process;
    initialized: boolean;
    subsystemThis: number;
    nextSoundId: number;
    nextHandle: number;
    sounds: Map<number, GalaxySoundEntry>;
    usoundToEntry: Map<number, GalaxySoundEntry>;
    musicAudioId: number;
    musicHandle: number;
    musicSlot: number;
    patchStats: GalaxyPatchStats | null;
    activeProfile: GalaxyProfile | null;
    galaxyModule: LoadedPEModule | null;
    mixerProbe: GalaxyMixerProbe | null;
    mixerProbeAttempts: number;
    mixerHookInstalled: boolean;
    mixerHookedPtr: number;
}

export function createGalaxyContext(process: Process): GalaxyContext {
    return {
        process,
        initialized: false,
        subsystemThis: 0,
        nextSoundId: 0x70000,
        nextHandle: 1,
        sounds: new Map(),
        usoundToEntry: new Map(),
        musicAudioId: 0,
        musicHandle: 0,
        musicSlot: 0,
        patchStats: null,
        activeProfile: null,
        galaxyModule: null,
        mixerProbe: null,
        mixerProbeAttempts: 0,
        mixerHookInstalled: false,
        mixerHookedPtr: 0,
    };
}
