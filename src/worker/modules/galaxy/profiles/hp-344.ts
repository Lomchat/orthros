/** Galaxy.dll profile (344064 bytes) — offsets from disasm (RegisterSound @ 0x6b90). */

import { DEFAULT_USOUND_LAYOUT } from '../structs';
import type { GalaxyProfile } from './types';

export const HP344_PROFILE: GalaxyProfile = {
    id: 'hp-344',
    dllSize: 344064,
    bannerNeedle: 'Galaxy Music System compiled at',
    usoundLayout: {
        ...DEFAULT_USOUND_LAYOUT,
        confirmed: true,
    },
    // Init body @ rva 0x5820 — only image-independent prefix (push imm32 varies with base).
    initPrologue: new Uint8Array([0x55, 0x8b, 0xec, 0x6a, 0xff]),
    subsystemLayout: {
        fPlayingSoundBase: 0x80,
        fPlayingSoundStride: 0x34,
        voiceIdTable: 0x90,
        voiceIdStride: 0x34,
        voiceCount: 32,
        musicHandle: 0x784,
    },
    mixer: {
        mixKernelPtrRva: 0x7d0b4,
        convertKernelPtrRva: 0x7ca04,
        volumeTablePtrRva: 0x7d0a4,
        panTableRva: 0x48d98,
        mixMasterRva: 0x12250,
        timerCallbackRva: 0x11bd0,
    },
};
