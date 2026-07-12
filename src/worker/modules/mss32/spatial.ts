import { MSSContext } from "./context";
import { MSSListener3D } from "./types";
import {
    createListenerSab,
    floatToI32,
    LCTRL_POS_X, LCTRL_POS_Y, LCTRL_POS_Z,
    LCTRL_VEL_X, LCTRL_VEL_Y, LCTRL_VEL_Z,
    LCTRL_FRONT_X, LCTRL_FRONT_Y, LCTRL_FRONT_Z,
    LCTRL_TOP_X, LCTRL_TOP_Y, LCTRL_TOP_Z,
    LCTRL_DIST_FACTOR, LCTRL_ROLLOFF_FACTOR, LCTRL_DOPPLER_FACTOR,
} from "../../../audio/audio-ring-buffer";

/** Sentinel handle returned by _AIL_open_3D_listener — distinct from any sample handle. */
export const LISTENER_3D_HANDLE = 0xDEAD3D11;

/**
 * Lazily create the global listener SAB and register it with the audio worklet.
 * Returns the listener handle. Idempotent — reuses the existing listener.
 */
export function ensureListener3D(ctx: MSSContext): number {
    if (!ctx.listener3D) {
        ctx.listener3D = {
            handle: LISTENER_3D_HANDLE,
            posX: 0, posY: 0, posZ: 0,
            velX: 0, velY: 0, velZ: 0,
            frontX: 0, frontY: 0, frontZ: 1,
            topX: 0, topY: 1, topZ: 0,
            distanceFactor: 1,
            rolloffFactor: 1,
            dopplerFactor: 1,
        };
    }
    if (!ctx.listenerSab) {
        ctx.listenerSab = createListenerSab();
        self.postMessage({ type: "audio_listener_sab", payload: { sab: ctx.listenerSab } });
    }
    return ctx.listener3D.handle;
}

/** Push the current listener state into the listener SAB the worklet mixes against. */
export function writeListener3D(ctx: MSSContext): void {
    const sab = ctx.listenerSab;
    const ls: MSSListener3D | null = ctx.listener3D;
    if (!sab || !ls) return;
    const c = new Int32Array(sab, 0, 16);
    Atomics.store(c, LCTRL_POS_X, floatToI32(ls.posX));
    Atomics.store(c, LCTRL_POS_Y, floatToI32(ls.posY));
    Atomics.store(c, LCTRL_POS_Z, floatToI32(ls.posZ));
    Atomics.store(c, LCTRL_VEL_X, floatToI32(ls.velX));
    Atomics.store(c, LCTRL_VEL_Y, floatToI32(ls.velY));
    Atomics.store(c, LCTRL_VEL_Z, floatToI32(ls.velZ));
    Atomics.store(c, LCTRL_FRONT_X, floatToI32(ls.frontX));
    Atomics.store(c, LCTRL_FRONT_Y, floatToI32(ls.frontY));
    Atomics.store(c, LCTRL_FRONT_Z, floatToI32(ls.frontZ));
    Atomics.store(c, LCTRL_TOP_X, floatToI32(ls.topX));
    Atomics.store(c, LCTRL_TOP_Y, floatToI32(ls.topY));
    Atomics.store(c, LCTRL_TOP_Z, floatToI32(ls.topZ));
    Atomics.store(c, LCTRL_DIST_FACTOR, floatToI32(ls.distanceFactor));
    Atomics.store(c, LCTRL_ROLLOFF_FACTOR, floatToI32(ls.rolloffFactor));
    Atomics.store(c, LCTRL_DOPPLER_FACTOR, floatToI32(ls.dopplerFactor));
}
