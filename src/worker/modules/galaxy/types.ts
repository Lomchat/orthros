import type { GuestWaveInfo } from './structs';
import type { GalaxyMixerProbe } from './mixer-probe';
export interface GalaxySoundEntry {
    id: number;
    usoundPtr: number;
    audioId: number;
    isPlaying: boolean;
    loop: boolean;
    volume: number;
    channel: number;
    actorPtr: number;
    cachedWave: GuestWaveInfo | null;
    isMusic: boolean;
    glxSamplePtr: number;
}

export type GalaxyPatchMode = 'perf' | 'full' | 'audio';

export interface GalaxyPatchStats {
    patchedExports: string[];
    patchedVtableSlots: number;
    profile: string;
    integration: string;
    mode: GalaxyPatchMode;
    mixerProbe: GalaxyMixerProbe | null;
    mixerHookInstalled?: boolean;
    mixerHookedPtr?: number;
    mixKernelHits?: number;
}
