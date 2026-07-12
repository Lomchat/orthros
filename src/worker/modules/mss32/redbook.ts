import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { Marshaler } from "../../core/memory/marshaler";
import { MSSContext } from "./context";
import { RedbookHandle } from "./types";
import { System } from "../../core/system";

export function createRedbookExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_redbook_open@4
    exports["_AIL_redbook_open@4"] = (ctxThunk, mem, args) => {
        const deviceId = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_open@4 called: deviceId=${deviceId}`);
        return openRedbookHandle(ctx);
    };

    // _AIL_redbook_close@4
    exports["_AIL_redbook_close@4"] = (ctxThunk, mem, args) => {
        const handle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_close@4 called: handle=0x${handle.toString(16)}`);
        const rb = ctx.redbookHandles.get(handle);
        if (rb && rb.status === 2) {
            self.postMessage({ type: "audio_stop", payload: { id: rb.audioId } });
        }
        ctx.redbookHandles.delete(handle);
        return 0;
    };

    // _AIL_redbook_open_drive@4
    exports["_AIL_redbook_open_drive@4"] = (ctxThunk, mem, args) => {
        const drive = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_open_drive@4 called: drive=${drive} (${String.fromCharCode(65 + drive)}:)`);
        return openRedbookHandle(ctx);
    };

    // _AIL_redbook_tracks@4
    exports["_AIL_redbook_tracks@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        const count = rb ? rb.tracks.length + 1 : 0;
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_tracks@4: handle=0x${hand.toString(16)} -> ${count} tracks`);
        return count;
    };

    // _AIL_redbook_track_info@16
    exports["_AIL_redbook_track_info@16"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const tracknum = args[1];
        const startmsecPtr = args[2];
        const endmsecPtr = args[3];
        const rb = ctx.redbookHandles.get(hand);
        const view = new DataView(ctx.memory.buffer, ctx.memory.byteOffset, ctx.memory.byteLength);

        if (!rb) {
            if (startmsecPtr) view.setUint32(startmsecPtr, 0, true);
            if (endmsecPtr) view.setUint32(endmsecPtr, 0, true);
            return 0;
        }

        if (tracknum === 1) {
            if (startmsecPtr) view.setUint32(startmsecPtr, 0, true);
            if (endmsecPtr) view.setUint32(endmsecPtr, 0, true);
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_track_info@16: track 1 (data) -> 0..0`);
            return 1;
        }

        const idx = tracknum - 2;
        if (idx >= 0 && idx < rb.tracks.length) {
            const t = rb.tracks[idx];
            if (startmsecPtr) view.setUint32(startmsecPtr, t.startMs, true);
            if (endmsecPtr) view.setUint32(endmsecPtr, t.endMs, true);
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_track_info@16: track ${tracknum} -> ${t.startMs}..${t.endMs} (${t.file})`);
            return 1;
        }

        if (startmsecPtr) view.setUint32(startmsecPtr, 0, true);
        if (endmsecPtr) view.setUint32(endmsecPtr, 0, true);
        return 0;
    };

    // _AIL_redbook_set_volume@8
    exports["_AIL_redbook_set_volume@8"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const volume = args[1];
        const rb = ctx.redbookHandles.get(hand);
        const prevVolume = rb ? rb.volume : 0;
        if (rb) {
            rb.volume = volume;
            if (rb.status === 2) {
                self.postMessage({
                    type: "audio_update",
                    payload: { id: rb.audioId, volume: volume / 127.0 }
                });
            }
        }
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_set_volume@8: handle=0x${hand.toString(16)}, volume=${volume} (prev=${prevVolume})`);
        return prevVolume;
    };

    // _AIL_redbook_volume@4
    exports["_AIL_redbook_volume@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        const vol = rb ? rb.volume : 0;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_redbook_volume@4: handle=0x${hand.toString(16)} -> ${vol}`);
        return vol;
    };

    // _AIL_redbook_status@4
    exports["_AIL_redbook_status@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        const status = rb ? rb.status : 1;
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_redbook_status@4: handle=0x${hand.toString(16)} -> ${status}`);
        return status;
    };

    // _AIL_redbook_stop@4
    exports["_AIL_redbook_stop@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        if (rb && rb.status === 2) {
            self.postMessage({ type: "audio_stop", payload: { id: rb.audioId } });
        }
        if (rb) {
            rb.status = 1;
            rb.currentTrackIdx = -1;
            rb.pauseElapsedMs = 0;
        }
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_stop@4: handle=0x${hand.toString(16)}`);
        return 0;
    };

    // _AIL_redbook_play@12
    exports["_AIL_redbook_play@12"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const startmsec = args[1];
        const endmsec = args[2];
        const rb = ctx.redbookHandles.get(hand);
        if (!rb) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_redbook_play@12: invalid handle 0x${hand.toString(16)}`);
            return 0;
        }

        let trackIdx = -1;
        for (let i = 0; i < rb.tracks.length; i++) {
            if (startmsec >= rb.tracks[i].startMs && startmsec < rb.tracks[i].endMs) {
                trackIdx = i;
                break;
            }
        }

        if (trackIdx < 0) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_redbook_play@12: no track for startmsec=${startmsec}`);
            return 0;
        }

        if (rb.status === 2) {
            self.postMessage({ type: "audio_stop", payload: { id: rb.audioId } });
        }

        const track = rb.tracks[trackIdx];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_play@12: playing track ${trackIdx + 2} "${track.file}" (${startmsec}..${endmsec})`);
        playRedbookTrack(ctx, rb, trackIdx, startmsec, endmsec);
        return 1;
    };

    // _AIL_redbook_pause@4
    exports["_AIL_redbook_pause@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        if (rb && rb.status === 2) {
            rb.pauseElapsedMs = performance.now() - rb.startTime;
            self.postMessage({ type: "audio_stop", payload: { id: rb.audioId } });
            rb.status = 3;
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_pause@4: paused at ${rb.pauseElapsedMs | 0}ms`);
        }
        return 0;
    };

    // _AIL_redbook_resume@4
    exports["_AIL_redbook_resume@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        if (rb && rb.status === 3 && rb.currentTrackIdx >= 0) {
            Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_redbook_resume@4: resuming track ${rb.currentTrackIdx + 2}`);
            playRedbookTrack(ctx, rb, rb.currentTrackIdx, rb.playStartMs, rb.playEndMs);
        }
        return 0;
    };

    // _AIL_redbook_position@4
    exports["_AIL_redbook_position@4"] = (ctxThunk, mem, args) => {
        const hand = args[0];
        const rb = ctx.redbookHandles.get(hand);
        if (!rb || rb.status === 1) return 0;
        if (rb.status === 3) {
            return (rb.playStartMs + rb.pauseElapsedMs) | 0;
        }
        const elapsed = performance.now() - rb.startTime;
        return (rb.playStartMs + elapsed) | 0;
    };

    return exports;
}

// ==================== Private helpers ====================

function openRedbookHandle(ctx: MSSContext): number {
    const system = System.getInstance();
    const handleId = ctx.nextRedbookId++;
    const tracks: RedbookHandle["tracks"] = [];

    const TRACK_DURATION_MS = 300000;
    for (let trackNum = 2; trackNum <= 99; trackNum++) {
        const paddedNum = trackNum.toString().padStart(2, "0");
        const fileName = `music/Track${paddedNum}.ogg`;
        const handle = system.fileSystem.openSync(fileName, 0x80000000, 3);
        if (handle) {
            const startMs = (trackNum - 2) * TRACK_DURATION_MS;
            tracks.push({ file: fileName, startMs, endMs: startMs + TRACK_DURATION_MS });
            Logger.log(LogCategory.SYSTEM, `MSS32: Redbook: found ${fileName} -> track ${trackNum} [${startMs}..${startMs + TRACK_DURATION_MS}]`);
        }
    }

    const rb: RedbookHandle = {
        id: handleId,
        tracks,
        volume: 127,
        status: 1,
        currentTrackIdx: -1,
        startTime: 0,
        playStartMs: 0,
        playEndMs: 0,
        audioId: 0,
        pauseElapsedMs: 0,
    };
    ctx.redbookHandles.set(handleId, rb);

    Logger.log(LogCategory.SYSTEM, `MSS32: Redbook opened: handle=0x${handleId.toString(16)}, ${tracks.length} audio tracks found`);
    return handleId;
}

async function playRedbookTrack(ctx: MSSContext, rb: RedbookHandle, trackIdx: number, startmsec: number, endmsec: number): Promise<void> {
    const system = System.getInstance();
    const track = rb.tracks[trackIdx];

    try {
        rb.audioId = ctx.nextRedbookAudioId++;
        rb.currentTrackIdx = trackIdx;
        rb.playStartMs = startmsec;
        rb.playEndMs = endmsec;
        rb.startTime = performance.now();
        rb.status = 2;
        rb.pauseElapsedMs = 0;

        const handle = system.fileSystem.openSync(track.file, 0x80000000, 3);
        if (!handle) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: Redbook: failed to open "${track.file}"`);
            rb.status = 1;
            return;
        }

        const fileSize = system.fileSystem.getFileSize(track.file);

        let fileData = system.fileSystem.readSync(handle, fileSize);
        if (!fileData) {
            Logger.log(LogCategory.SYSTEM, `MSS32: Redbook: sync read failed for "${track.file}", using async path`);
            fileData = await system.fileSystem.read(handle, fileSize);
        }

        if (!fileData || fileData.length === 0) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: Redbook: no data for "${track.file}" (${fileSize} bytes)`);
            rb.status = 1;
            return;
        }

        if (rb.status !== 2) {
            Logger.log(LogCategory.SYSTEM, `MSS32: Redbook: playback cancelled during load for "${track.file}"`);
            return;
        }

        const volume = rb.volume / 127.0;
        const payloadData = fileData.slice();

        self.postMessage({
            type: "audio_play_encoded",
            payload: {
                id: rb.audioId,
                data: payloadData,
                mimeType: "audio/ogg",
                playbackRate: 1.0,
                volume: volume,
                pan: 0,
                loopCount: 1
            }
        } as any, [payloadData.buffer] as any);

        rb.startTime = performance.now();

        Logger.log(LogCategory.SYSTEM, `MSS32: Redbook: playing track ${trackIdx + 2} "${track.file}" (audioId=${rb.audioId}, vol=${rb.volume}, ${fileData.length} bytes)`);
    } catch (err) {
        Logger.error(LogCategory.SYSTEM, `MSS32: Redbook: error playing "${track.file}": ${err}`);
        rb.status = 1;
    }
}
