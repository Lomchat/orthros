/** Unreal Tournament Galaxy.dll (348160 B) — same UE1 layout until UT-specific disasm lands. */

import { DEFAULT_USOUND_LAYOUT } from '../structs';
import type { GalaxyProfile } from './types';

export const UT348_PROFILE: GalaxyProfile = {
    id: 'ut-348',
    dllSize: 348160,
    bannerNeedle: 'Galaxy Music System compiled at',
    usoundLayout: {
        ...DEFAULT_USOUND_LAYOUT,
        confirmed: false,
    },
    initPrologue: new Uint8Array([
        0x55, 0x8b, 0xec, 0x6a, 0xff,
    ]),
    subsystemLayout: {
        fPlayingSoundBase: 0x80,
        fPlayingSoundStride: 0x34,
        voiceIdTable: 0x90,
        voiceIdStride: 0x34,
        voiceCount: 32,
        musicHandle: 0x784,
    },
    // Tentative — same Galaxy family; confirm before enabling UT patches.
    mixer: {
        mixKernelPtrRva: 0x7d0b4,
        convertKernelPtrRva: 0x7ca04,
        volumeTablePtrRva: 0x7d0a4,
        panTableRva: 0x48d98,
        mixMasterRva: 0x12250,
        timerCallbackRva: 0x11bd0,
    },
};
