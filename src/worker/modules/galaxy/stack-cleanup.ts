import { GALAXY_EXPORT } from './export-names';

/**
 * Callee stack cleanup (thiscall RET N) for HP Galaxy.dll (344064 B).
 * Measured from native function bodies (tools/tmp-galaxy-prologue.py).
 */
export const GALAXY_STACK_CLEANUP: Record<string, number> = {
    [GALAXY_EXPORT.init]: 0,
    [GALAXY_EXPORT.destroy]: 0,
    [GALAXY_EXPORT.shutdownAfterError]: 0,
    [GALAXY_EXPORT.registerSound]: 4,
    [GALAXY_EXPORT.unregisterSound]: 4,
    [GALAXY_EXPORT.registerMusic]: 4,
    [GALAXY_EXPORT.unregisterMusic]: 4,
    [GALAXY_EXPORT.getSound]: 4,
    [GALAXY_EXPORT.playSoundW]: 36,
    [GALAXY_EXPORT.stopSoundHandle]: 4,
    /** StopSound(AActor*, int Id, USound*) */
    [GALAXY_EXPORT.stopSoundActor]: 12,
    /** Update(FPointRegion by value, FCoords&) — region is ~58 B on stack */
    [GALAXY_EXPORT.update]: 62,
    [GALAXY_EXPORT.setVolumes]: 0,
    [GALAXY_EXPORT.getMusicChannel]: 0,
    [GALAXY_EXPORT.purgeExistingHandle]: 4,
    [GALAXY_EXPORT.modifySound]: 20,
    [GALAXY_EXPORT.exec]: 8,
    [GALAXY_EXPORT.postRender]: 4,
    [GALAXY_EXPORT.renderAudioGeometry]: 4,
};
