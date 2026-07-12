import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { MemoryGuard } from "../../core/memory/mem-guard";
import { MSSContext, SMP_FREE } from "./context";
import { MSSWaveOut } from "./types";
import { ensureDriverHandle, reinitDriverFields, stopHeartbeat, makeView, MSS_SAMPLE_STRUCT_SIZE } from "./helpers";
import { stopRingBuffer } from "./playback-engine";

export function createWaveOutExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    const MMSYSERR_NOERROR = 0;
    const WHDR_DONE = 0x00000001;

    // _AIL_waveOutOpen@16
    // Signature: S32 AIL_waveOutOpen(HDIGDRIVER* drvr, LPHWAVEOUT lpWaveOut, U32 deviceId, LPWAVEFORMATEX format)
    exports["_AIL_waveOutOpen@16"] = (ctxThunk, mem, args) => {
        const drvrOutPtr = args[0]; // OUT: pointer to receive HDIGDRIVER
        const lpWaveOut = args[1];  // OUT: pointer to receive HWAVEOUT
        const deviceId = args[2];
        const format = args[3];

        Logger.log(
            LogCategory.SYSTEM,
            `MSS32: _AIL_waveOutOpen@16 called: drvrOutPtr=0x${(drvrOutPtr >>> 0).toString(16)}, lpWaveOut=0x${(lpWaveOut >>> 0).toString(16)}, deviceId=0x${(deviceId >>> 0).toString(16)}, format=0x${(format >>> 0).toString(16)}`
        );

        const handle = ctx.nextWaveOutId++;
        const waveOut: MSSWaveOut = {
            handle: handle,
            deviceId: deviceId,
            preparedHeaders: new Map(),
        };

        ctx.waveOuts.set(waveOut.handle, waveOut);

        // Check DIG_MIXER_CHANNELS preference — game may have changed it before reinit
        const prefMixerChannels = ctx.preferences[1];
        if (prefMixerChannels > 0 && prefMixerChannels !== ctx.driverMaxSamples) {
            Logger.log(LogCategory.SYSTEM,
                `MSS32: waveOutOpen: DIG_MIXER_CHANNELS preference=${prefMixerChannels}, old maxSamples=${ctx.driverMaxSamples}`);
            // Reallocate sample array if needed
            if (ctx.driverSampleArray) {
                ctx.process.memory.free(ctx.driverSampleArray);
                ctx.driverSampleArray = 0;
            }
            // Reallocate aux buffers (maxSamples×4 each)
            if (ctx.driverAuxBuffer1) { ctx.process.memory.free(ctx.driverAuxBuffer1); ctx.driverAuxBuffer1 = 0; }
            if (ctx.driverAuxBuffer2) { ctx.process.memory.free(ctx.driverAuxBuffer2); ctx.driverAuxBuffer2 = 0; }
            if (ctx.driverAuxBuffer3) { ctx.process.memory.free(ctx.driverAuxBuffer3); ctx.driverAuxBuffer3 = 0; }

            ctx.driverMaxSamples = prefMixerChannels;
            ctx.driverSampleArray = ctx.process.memory.alloc(prefMixerChannels * MSS_SAMPLE_STRUCT_SIZE);
            const auxBufSize = prefMixerChannels * 4;
            ctx.driverAuxBuffer1 = ctx.process.memory.alloc(auxBufSize);
            ctx.driverAuxBuffer2 = ctx.process.memory.alloc(auxBufSize);
            ctx.driverAuxBuffer3 = ctx.process.memory.alloc(auxBufSize);
        }

        // HDIGDRIVER is a pointer to a driver structure, not a small integer.
        // Games dereference it to access driver fields — must be a valid allocated struct.
        const driverPtr = ensureDriverHandle(ctx, mem);

        // Always reinitialize the driver struct on every open.  revolt (and similar games)
        // zero the struct between AIL_waveOutClose and AIL_waveOutOpen as part of their
        // reinit sequence; without this, the cached struct would have all-zero fields on
        // the second call, causing an immediate NULL-dereference crash.
        // Pass the game's own WAVEFORMATEX pointer so it sees it back at driver+0x18.
        if (ctx.driverDummyBuffer && ctx.driverWaveFormat && ctx.driverNoopTable) {
            reinitDriverFields(ctx, driverPtr, ctx.driverDummyBuffer, ctx.driverWaveFormat, ctx.driverNoopTable, format, mem, deviceId);
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        if (drvrOutPtr && MemoryGuard.isValidRange(mem, drvrOutPtr, 4)) {
            view.setUint32(drvrOutPtr, driverPtr, true);
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_waveOutOpen@16 -> wrote drvr handle 0x${driverPtr.toString(16)} to 0x${(drvrOutPtr >>> 0).toString(16)}`);
        }

        if (lpWaveOut && MemoryGuard.isValidRange(mem, lpWaveOut, 4)) {
            view.setUint32(lpWaveOut, waveOut.handle, true);
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_waveOutOpen@16 -> wrote waveOut handle ${handle} to 0x${(lpWaveOut >>> 0).toString(16)}`);
        }

        return MMSYSERR_NOERROR;
    };

    // _AIL_waveOutClose@4
    // Real MSS32: stops all samples, resets sample array, cleans up driver state.
    // arg0 is the HDIGDRIVER address (not the waveOut counter ID).
    exports["_AIL_waveOutClose@4"] = (ctxThunk, mem, args) => {
        const driverAddr = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_waveOutClose@4 called: handle=0x${driverAddr.toString(16)}`);

        // 1. Stop all playing samples
        for (const sample of ctx.samples.values()) {
            if (sample.isPlaying || sample.isStopped) {
                if (!stopRingBuffer(sample.id)) {
                    self.postMessage({ type: "audio_stop", payload: { id: sample.id } });
                }
                sample.isPlaying = false;
                sample.isStopped = false;
            }
        }

        // 2. Reset sample array slots → all back to free (status=SMP_FREE at +0x08)
        if (ctx.driverSampleArray) {
            const view = makeView(mem);
            const stride = MSS_SAMPLE_STRUCT_SIZE;
            for (let i = 0; i < ctx.driverMaxSamples; i++) {
                const base = ctx.driverSampleArray + i * stride;
                view.setUint32(base + 0x08, SMP_FREE, true);       // real MSS32 free marker
                // +0x00 is type tag, NOT status — don't touch it
            }
        }

        // 3. Clear JS-side sample tracking
        ctx.samples.clear();
        ctx.samplesById.clear();

        // 4. Stop heartbeat
        stopHeartbeat(ctx);

        // 5. Remove waveOut entry — find by driver address since arg0 is HDIGDRIVER,
        //    not the incrementing counter ID used as map key
        for (const [key, wo] of ctx.waveOuts) {
            if (wo.deviceId === (driverAddr >>> 0) || key === driverAddr) {
                ctx.waveOuts.delete(key);
                break;
            }
        }
        // Fallback: if nothing matched, clear all (only one waveOut active at a time)
        if (ctx.waveOuts.size > 0) {
            ctx.waveOuts.clear();
        }

        return 0;
    };

    // _AIL_waveOutGetNumDevs@0
    exports["_AIL_waveOutGetNumDevs@0"] = (ctxThunk, mem, args) => {
        Logger.verbose(LogCategory.SYSTEM, 'MSS32: _AIL_waveOutGetNumDevs@0 called');
        return 1;
    };

    // _AIL_waveOutPrepareHeader@12
    exports["_AIL_waveOutPrepareHeader@12"] = (ctxThunk, mem, args) => {
        const hwo = args[0];
        const pwh = args[1];
        const cbwh = args[2];
        const w = ctx.waveOuts.get(hwo);
        if (w && pwh && MemoryGuard.isValidRange(mem, pwh, Math.min(cbwh, 32))) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const flags = view.getUint32(pwh + 12, true) & ~WHDR_DONE;
            view.setUint32(pwh + 12, flags, true);
            const len = view.getUint32(pwh + 4, true);
            w.preparedHeaders?.set(pwh, { ptr: pwh, len, flags });
        }
        return MMSYSERR_NOERROR;
    };

    // _AIL_waveOutUnprepareHeader@12
    exports["_AIL_waveOutUnprepareHeader@12"] = (ctxThunk, mem, args) => {
        const w = ctx.waveOuts.get(args[0]);
        w?.preparedHeaders?.delete(args[1]);
        return MMSYSERR_NOERROR;
    };

    // _AIL_waveOutWrite@12
    exports["_AIL_waveOutWrite@12"] = (ctxThunk, mem, args) => {
        const hwo = args[0];
        const pwh = args[1];
        const w = ctx.waveOuts.get(hwo);
        if (w && pwh && MemoryGuard.isValidRange(mem, pwh, 16)) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const flags = view.getUint32(pwh + 12, true) | WHDR_DONE;
            view.setUint32(pwh + 12, flags, true);
            view.setUint32(pwh + 8, 0, true);
            w.preparedHeaders?.set(pwh, { ptr: pwh, len: view.getUint32(pwh + 4, true), flags });
        }
        return MMSYSERR_NOERROR;
    };

    // _AIL_waveOutReset@4
    exports["_AIL_waveOutReset@4"] = (ctxThunk, mem, args) => {
        const w = ctx.waveOuts.get(args[0]);
        if (w?.preparedHeaders) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (const hdr of w.preparedHeaders.values()) {
                view.setUint32(hdr.ptr + 12, view.getUint32(hdr.ptr + 12, true) | WHDR_DONE, true);
            }
        }
        return MMSYSERR_NOERROR;
    };

    return exports;
}
