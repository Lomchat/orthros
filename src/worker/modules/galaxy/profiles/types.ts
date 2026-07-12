import type { USoundLayout } from '../structs';

/** Guest UGalaxyAudioSubsystem field layout (HP 344064 B — disasm @ GetMusicChannel 0x4720). */
export interface SubsystemLayout {
    fPlayingSoundBase: number;
    fPlayingSoundStride: number;
    voiceIdTable: number;
    voiceIdStride: number;
    voiceCount: number;
    musicHandle: number;
}

export interface GalaxyProfile {
    id: 'hp-344' | 'ut-348';
    dllSize: number;
    bannerNeedle: string;
    usoundLayout: USoundLayout;
    /** First bytes of Init body after export jmp chain (fail-closed gate). */
    initPrologue: Uint8Array;
    subsystemLayout: SubsystemLayout;
    /** Global mixer function-pointer slots + hot RVAs (HP Ghidra @ logs/galaxy_kernels.txt). */
    mixer: GalaxyMixerLayout;
}

export interface GalaxyMixerLayout {
    /** DAT_1067d0b4 — indirect mix kernel (14-arg leaf). */
    mixKernelPtrRva: number;
    /** DAT_1067ca04 — output convert kernel. */
    convertKernelPtrRva: number;
    /** DAT_1067d0a4 — pointer to volume lookup table base. */
    volumeTablePtrRva: number;
    /** DAT_10648d98 — pan index table for mix kernel. */
    panTableRva: number;
    /** FUN_10612250 master mix (stateful — do not patch wholesale). */
    mixMasterRva: number;
    /** timeSetEvent callback LAB_10611bd0. */
    timerCallbackRva: number;
}
