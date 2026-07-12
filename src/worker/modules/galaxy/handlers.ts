import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

import { Logger, LogCategory } from '../../core/logger';

import { Mem } from '../../core/memory/mem-accessor';

import type { GalaxyContext } from './context';

import { GALAXY_EXPORT } from './export-names';

import { HP344_PROFILE } from './profiles/hp-344';

import { UT348_PROFILE } from './profiles/ut-348';

import type { GalaxyProfile } from './profiles/types';

import { probeUSoundWave, allocGlxSample, bindGlxSampleToUSound } from './structs';

import { stopGalaxyAudio } from './playback';
import { probeGalaxyMixerKernels } from './mixer-probe';

import { ensureAudioStatsSab } from '../audio-stats-sab';

import type { GalaxySoundEntry } from './types';

import type { GuestWaveInfo } from './structs';



function profileForCtx(ctx: GalaxyContext): GalaxyProfile {
    if (ctx.activeProfile) return ctx.activeProfile;
    return HP344_PROFILE;
}

/** Raw guest dword → IEEE754 float (thunk args are not JS numbers). */
function guestF32(raw: number): number {

    const v = new DataView(new ArrayBuffer(4));

    v.setUint32(0, raw >>> 0, true);

    return v.getFloat32(0, true);

}



function syncMusicChannelGuest(ctx: GalaxyContext, entry: GalaxySoundEntry): void {

    const thisPtr = ctx.subsystemThis;

    if (!thisPtr || !entry.isMusic) return;

    const layout = profileForCtx(ctx).subsystemLayout;

    const slot = ctx.musicSlot;

    const handle = ctx.musicHandle || 1;



    Mem.writeUint32(thisPtr + layout.musicHandle, handle);

    Mem.writeUint32(thisPtr + layout.voiceIdTable + slot * layout.voiceIdStride, handle);

    if (entry.glxSamplePtr) {

        const fpsAddr = thisPtr + layout.fPlayingSoundBase + slot * layout.fPlayingSoundStride;

        Mem.writeUint32(fpsAddr, entry.glxSamplePtr >>> 0);

    }

}



function ensureSoundEntry(ctx: GalaxyContext, usound: number, isMusic = false): GalaxySoundEntry {

    let entry = ctx.usoundToEntry.get(usound);

    if (!entry) {

        const id = ctx.nextSoundId++;

        entry = {

            id,

            usoundPtr: usound,

            audioId: id,

            isPlaying: false,

            loop: isMusic,

            volume: 127,

            channel: isMusic ? 0 : 0,

            actorPtr: 0,

            cachedWave: null,

            isMusic,

            glxSamplePtr: 0,

        };

        ctx.usoundToEntry.set(usound, entry);

    } else if (isMusic) {

        entry.isMusic = true;

        entry.loop = true;

    }

    return entry;

}



function resolveWave(ctx: GalaxyContext, usound: number, entry: { cachedWave: GuestWaveInfo | null }): GuestWaveInfo | null {

    if (entry.cachedWave) return entry.cachedWave;

    const profile = profileForCtx(ctx);

    if (!profile.usoundLayout.confirmed) return null;

    const wave = probeUSoundWave(usound, profile.usoundLayout);

    if (wave) entry.cachedWave = wave;

    return wave;

}



function ensureGlxSample(ctx: GalaxyContext, usound: number, entry: GalaxySoundEntry): number {

    if (entry.glxSamplePtr) return entry.glxSamplePtr;

    const profile = profileForCtx(ctx);

    const ptr = allocGlxSample(ctx.process);

    bindGlxSampleToUSound(usound, ptr, profile.usoundLayout);

    entry.glxSamplePtr = ptr;

    if (entry.isMusic) syncMusicChannelGuest(ctx, entry);

    return ptr;

}



function tryProbeMixer(ctx: GalaxyContext): void {
    if (!ctx.galaxyModule || !ctx.activeProfile) return;
    if (ctx.mixerProbeAttempts++ > 600) return;

    const probe = probeGalaxyMixerKernels(ctx.galaxyModule, ctx.activeProfile);
    if (!probe?.mixKernelPtr) return;

    ctx.mixerProbe = probe;
    if (ctx.patchStats) ctx.patchStats.mixerProbe = probe;
}

export function createGalaxyHandlers(ctx: GalaxyContext): Record<string, ThunkImplementation> {

    const handlers: Record<string, ThunkImplementation> = {};



    handlers[GALAXY_EXPORT.init] = (xctx, _mem, _args) => {
        ctx.subsystemThis = xctx.ecx >>> 0;
        ctx.initialized = true;
        ensureAudioStatsSab();
        // Do not touch guest subsystem memory here — native ctor already ran; mass zeroing broke HP boot.
        Logger.log(LogCategory.SYSTEM, `[Galaxy] Init HLE this=0x${ctx.subsystemThis.toString(16)} (no timer, no guest writes)`);
        return 1;
    };

    handlers[GALAXY_EXPORT.destroy] = (_xctx, _mem, _args) => {
        for (const entry of ctx.sounds.values()) stopGalaxyAudio(entry.audioId);
        ctx.sounds.clear();
        ctx.usoundToEntry.clear();
        ctx.initialized = false;
        ctx.musicHandle = 0;
        return 0;
    };



    handlers[GALAXY_EXPORT.shutdownAfterError] = handlers[GALAXY_EXPORT.destroy];



    handlers[GALAXY_EXPORT.registerSound] = (_xctx, _mem, args) => {

        const usound = args[0] >>> 0;

        if (!usound) return 0;

        const entry = ensureSoundEntry(ctx, usound, false);

        resolveWave(ctx, usound, entry);

        ensureGlxSample(ctx, usound, entry);

        return 0;

    };



    handlers[GALAXY_EXPORT.unregisterSound] = (_xctx, _mem, args) => {

        const usound = args[0] >>> 0;

        const entry = ctx.usoundToEntry.get(usound);

        if (entry) {

            stopGalaxyAudio(entry.audioId);

            ctx.sounds.delete(entry.id);

            ctx.usoundToEntry.delete(usound);

        }

        return 0;

    };



    handlers[GALAXY_EXPORT.registerMusic] = (_xctx, _mem, args) => {

        const umusic = args[0] >>> 0;

        if (!umusic) return 0;

        ctx.musicHandle = ctx.nextHandle++;

        ctx.musicSlot = 0;

        const entry = ensureSoundEntry(ctx, umusic, true);

        resolveWave(ctx, umusic, entry);

        ensureGlxSample(ctx, umusic, entry);

        ctx.musicAudioId = entry.audioId;

        syncMusicChannelGuest(ctx, entry);

        return 0;

    };



    handlers[GALAXY_EXPORT.unregisterMusic] = handlers[GALAXY_EXPORT.unregisterSound];



    handlers[GALAXY_EXPORT.getSound] = (_xctx, _mem, args) => {

        const usound = args[0] >>> 0;

        if (!usound) return 0;

        const profile = profileForCtx(ctx);

        const entry = ctx.usoundToEntry.get(usound);

        if (entry?.glxSamplePtr) return entry.glxSamplePtr;

        const existing = Mem.readUint32(usound + profile.usoundLayout.glxSample) ?? 0;

        if (existing) return existing;

        const e = ensureSoundEntry(ctx, usound, false);

        return ensureGlxSample(ctx, usound, e);

    };



    handlers[GALAXY_EXPORT.getMusicChannel] = (_xctx, _mem, _args) => {

        const thisPtr = ctx.subsystemThis;

        if (!thisPtr || !ctx.musicHandle) return 0;

        const layout = profileForCtx(ctx).subsystemLayout;

        return thisPtr + layout.fPlayingSoundBase + ctx.musicSlot * layout.fPlayingSoundStride;

    };



    // RE PHASE (glxSample-bypass bring-up): RegisterSound runs NATIVE, so each USound
    // already holds a native glxSample (decoded PCM + format). This handler only records
    // the USound ptr — no clobber, no extraction — so the native glxSample stays intact
    // for layout reverse-engineering via dbg/worker-eval. The real SAB playback (read
    // glxSample PCM → SAB) replaces this once the glxSample layout is confirmed.
    handlers[GALAXY_EXPORT.playSoundW] = (xctx, _mem, args) => {
        if (!ctx.initialized) ctx.subsystemThis = xctx.ecx >>> 0;
        const usound = args[2] >>> 0;
        if (!usound) return 0;
        ensureSoundEntry(ctx, usound, false);
        return 1;
    };



    handlers[GALAXY_EXPORT.stopSoundHandle] = (_xctx, _mem, args) => {

        const handle = args[0] | 0;

        for (const entry of ctx.sounds.values()) {

            if (entry.channel === handle || entry.id === handle) {

                stopGalaxyAudio(entry.audioId);

                entry.isPlaying = false;

            }

        }

        return 0;

    };



    handlers[GALAXY_EXPORT.stopSoundActor] = (_xctx, _mem, args) => {

        const actor = args[0] >>> 0;

        const channel = args[1] | 0;

        const usound = args[2] >>> 0;

        void channel;

        for (const entry of ctx.sounds.values()) {

            if ((!actor || entry.actorPtr === actor) && (!usound || entry.usoundPtr === usound)) {

                stopGalaxyAudio(entry.audioId);

                entry.isPlaying = false;

            }

        }

        return 1;

    };



    handlers[GALAXY_EXPORT.update] = (xctx, _mem, _args) => {
        ctx.subsystemThis = xctx.ecx >>> 0;
        ctx.initialized = true;
        tryProbeMixer(ctx);
        return 0;
    };



    handlers[GALAXY_EXPORT.setVolumes] = (_xctx, _mem, _args) => 0;



    handlers[GALAXY_EXPORT.purgeExistingHandle] = (_xctx, _mem, _args) => 0;



    handlers[GALAXY_EXPORT.modifySound] = () => 1;



    handlers[GALAXY_EXPORT.exec] = () => 0;

    handlers[GALAXY_EXPORT.postRender] = () => 0;

    handlers[GALAXY_EXPORT.renderAudioGeometry] = () => 0;



    return handlers;

}



/** @deprecated Use detect.verifyProfileInitPrologue */

export function verifyInitPrologue(moduleBase: number, initExportAddr: number, profileId: string): boolean {

    void moduleBase;

    void initExportAddr;

    const profile = profileId === 'ut-348' ? UT348_PROFILE : HP344_PROFILE;

    return profile.initPrologue.length > 0;

}

