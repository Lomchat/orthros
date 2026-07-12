/** MSVC mangled export names for UGalaxyAudioSubsystem (HP Galaxy.dll). */

export const GALAXY_EXPORT = {
    init: '?Init@UGalaxyAudioSubsystem@@UAEHXZ',
    playSoundW: '?PlaySoundW@UGalaxyAudioSubsystem@@UAEHPAVAActor@@HPAVUSound@@VFVector@@MMM@Z',
    stopSoundActor: '?StopSound@UGalaxyAudioSubsystem@@UAEHPAVAActor@@HPAVUSound@@@Z',
    stopSoundHandle: '?StopSound@UGalaxyAudioSubsystem@@QAEXH@Z',
    update: '?Update@UGalaxyAudioSubsystem@@UAEXUFPointRegion@@AAVFCoords@@@Z',
    registerSound: '?RegisterSound@UGalaxyAudioSubsystem@@UAEXPAVUSound@@@Z',
    unregisterSound: '?UnregisterSound@UGalaxyAudioSubsystem@@UAEXPAVUSound@@@Z',
    registerMusic: '?RegisterMusic@UGalaxyAudioSubsystem@@UAEXPAVUMusic@@@Z',
    unregisterMusic: '?UnregisterMusic@UGalaxyAudioSubsystem@@UAEXPAVUMusic@@@Z',
    setVolumes: '?SetVolumes@UGalaxyAudioSubsystem@@QAEXXZ',
    getMusicChannel: '?GetMusicChannel@UGalaxyAudioSubsystem@@QAEPAVFPlayingSound@@XZ',
    purgeExistingHandle: '?PurgeExistingHandle@UGalaxyAudioSubsystem@@QAEXABVFPlayingSound@@@Z',
    shutdownAfterError: '?ShutdownAfterError@UGalaxyAudioSubsystem@@UAEXXZ',
    destroy: '?Destroy@UGalaxyAudioSubsystem@@UAEXXZ',
    getSound: '?GetSound@UGalaxyAudioSubsystem@@QAEPAUglxSample@@PAVUSound@@@Z',
    modifySound: '?ModifySound@UGalaxyAudioSubsystem@@UAEHPAVAActor@@HPAVUSound@@EM@Z',
    exec: '?Exec@UGalaxyAudioSubsystem@@UAEHPBGAAVFOutputDevice@@@Z',
    postRender: '?PostRender@UGalaxyAudioSubsystem@@UAEXPAUFSceneNode@@@Z',
    renderAudioGeometry: '?RenderAudioGeometry@UGalaxyAudioSubsystem@@UAEXPAUFSceneNode@@@Z',
    vtableUObject: '??_7UGalaxyAudioSubsystem@@6BUObject@@@',
    vtableFExec: '??_7UGalaxyAudioSubsystem@@6BFExec@@@',
} as const;

/**
 * CPU-only stubs safe alongside native Init + 20ms mixer timer → DirectSound.
 * Patching PlaySoundW/Register* while native mixer still runs causes double output
 * (browser SAB + DSound stream) and partial voice-table writes → crackle/garble.
 */
export const GALAXY_HLE_PERF_EXPORTS: readonly string[] = [
    GALAXY_EXPORT.update,
    GALAXY_EXPORT.modifySound,
    GALAXY_EXPORT.exec,
    GALAXY_EXPORT.postRender,
    GALAXY_EXPORT.renderAudioGeometry,
];

/**
 * glxSample-bypass play set: let the NATIVE Galaxy.dll decode each USound into its
 * internal glxSample (decoded PCM + format), then intercept only the play/stop methods
 * and route the already-decoded PCM into our SAB pipeline. RegisterSound/RegisterMusic/
 * GetSound stay native so we never have to reverse the per-UE1-version USound layout —
 * we read Galaxy's own glxSample struct, which is identical across all Galaxy games.
 */
export const GALAXY_HLE_PLAY_EXPORTS: readonly string[] = [
    GALAXY_EXPORT.playSoundW,
    GALAXY_EXPORT.stopSoundActor,
    GALAXY_EXPORT.stopSoundHandle,
];

/** Full audio replacement — enable only after native mixer timer is disabled. */
export const GALAXY_HLE_AUDIO_EXPORTS: readonly string[] = [
    GALAXY_EXPORT.playSoundW,
    GALAXY_EXPORT.stopSoundActor,
    GALAXY_EXPORT.stopSoundHandle,
    GALAXY_EXPORT.registerSound,
    GALAXY_EXPORT.unregisterSound,
    GALAXY_EXPORT.registerMusic,
    GALAXY_EXPORT.unregisterMusic,
    GALAXY_EXPORT.setVolumes,
    GALAXY_EXPORT.getMusicChannel,
    GALAXY_EXPORT.purgeExistingHandle,
    GALAXY_EXPORT.shutdownAfterError,
    GALAXY_EXPORT.destroy,
    GALAXY_EXPORT.getSound,
];

/** Default patch set — perf stubs only until mixer hook lands. */
export const GALAXY_HLE_EXPORTS: readonly string[] = GALAXY_HLE_PERF_EXPORTS;

/** All handler exports (signature validation; superset of what is patched by default). */
export const GALAXY_HLE_ALL_EXPORTS: readonly string[] = [
    ...GALAXY_HLE_PERF_EXPORTS,
    ...GALAXY_HLE_AUDIO_EXPORTS,
];
