import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { Marshaler } from "../../core/memory/marshaler";
import { MSSContext, SMP_DONE, SMP_PLAYING } from "./context";
import { MSSStream } from "./types";
import { System } from "../../core/system";
import {
    getBytesPerSecond,
    setStreamStatus, writeStreamPosition, writeStreamVolume, writeStreamPan,
    writeStreamPlaybackRate, refreshStreamLenDone, isEncodedFormat,
} from "./helpers";
import { playStream, updateStreamPlayback, stopRingBuffer, resumeRingBuffer } from "./playback-engine";
import { decodeStreamFile } from "./audio-decode";

export function createStreamExports(ctx: MSSContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    // _AIL_open_stream@12
    exports["_AIL_open_stream@12"] = (ctxThunk, mem, args) => {
        const dig = args[0];
        const filenamePtr = args[1];
        const memoryImage = args[2];

        const filenameStr = filenamePtr ? Marshaler.readString(mem, filenamePtr) : null;
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_stream@12 called: dig=0x${dig.toString(16)}, filename="${filenameStr ?? '(memory)'}"`);

        const STREAM_STRUCT_SIZE = 512;
        const handle = ctx.process.memory.alloc(STREAM_STRUCT_SIZE);
        const streamDummyBuffer = ctx.process.memory.alloc(256);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        for (let i = 0; i < STREAM_STRUCT_SIZE; i += 4) {
            view.setUint32(handle + i, 0, true);
        }

        view.setUint32(handle + 0x00, SMP_DONE, true);
        view.setUint32(handle + 0x04, dig, true);
        view.setUint32(handle + 0x10, streamDummyBuffer, true);
        view.setInt32(handle + 0x34, 22050, true);
        view.setInt32(handle + 0x38, 127, true);
        view.setInt32(handle + 0x3C, 64, true);

        const streamId = ctx.nextStreamId++;
        const stream: MSSStream = {
            id: streamId,
            handle: handle,
            fileData: null,
            decodedData: null,
            filename: filenameStr,
            sampleRate: 22050,
            channels: 2,
            bitsPerSample: 16,
            formatTag: 1,
            blockAlign: 4,
            volume: 127,
            pan: 64,
            playbackRate: 1.0,
            loopCount: 1,
            streamDummyBuffer: streamDummyBuffer,
            isPlaying: false,
            isPaused: false,
            position: 0,
            pendingStart: false
        };

        ctx.streams.set(handle, stream);
        ctx.streamsById.set(streamId, stream);

        if (filenameStr) {
            loadStreamFile(ctx, stream).catch(err => {
                Logger.error(LogCategory.SYSTEM, `MSS32: Failed to load stream file "${filenameStr}": ${err}`);
            });
        }

        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_open_stream@12 -> 0x${handle.toString(16)} (streamId=${streamId})`);
        return handle;
    };

    // _AIL_close_stream@4
    exports["_AIL_close_stream@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_close_stream@4 called: stream=0x${streamHandle.toString(16)}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_close_stream@4: Invalid stream handle`);
            return 0;
        }

        if (stream.isPlaying) {
            if (!stopRingBuffer(stream.id)) {
                self.postMessage({ type: "audio_stop", payload: { id: stream.id } });
            }
        }
        if (stream.streamDummyBuffer) {
            ctx.process.memory.free(stream.streamDummyBuffer);
        }
        ctx.process.memory.free(streamHandle);
        ctx.streamsById.delete(stream.id);
        ctx.streams.delete(streamHandle);
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_close_stream@4: Stream closed (id=${stream.id})`);
        return 0;
    };

    // _AIL_start_stream@4
    exports["_AIL_start_stream@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_start_stream@4 called: stream=0x${streamHandle.toString(16)}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_start_stream@4: Invalid stream handle`);
            return 0;
        }

        stream.startTime = performance.now();

        if (!stream.decodedData) {
            if (stream.fileData && isEncodedFormat(stream.fileFormat)) {
                playStream(ctx, stream);
                Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_start_stream@4: Started ${stream.fileFormat} stream`);
                return 0;
            }
            Logger.warn(LogCategory.SYSTEM, `MSS32: _AIL_start_stream@4: No data yet, deferring start`);
            stream.pendingStart = true;
            setStreamStatus(ctx, stream, SMP_PLAYING);
            return 0;
        }

        playStream(ctx, stream);
        Logger.log(LogCategory.SYSTEM, `MSS32: _AIL_start_stream@4: Started stream playback`);
        return 0;
    };

    // _AIL_pause_stream@4
    exports["_AIL_pause_stream@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_pause_stream@4 called: stream=0x${streamHandle.toString(16)}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        if (stream.isPlaying && !stream.isPaused) {
            if (!stopRingBuffer(stream.id)) {
                self.postMessage({ type: "audio_pause", payload: { id: stream.id } });
            }
            stream.isPaused = true;
            Logger.log(LogCategory.SYSTEM, `MSS32: Stream paused (id=${stream.id})`);
        }
        return 0;
    };

    // _AIL_pause_stream@8
    exports["_AIL_pause_stream@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const pause = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_pause_stream@8 called: stream=0x${streamHandle.toString(16)}, pause=${pause}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        if (pause && stream.isPlaying && !stream.isPaused) {
            if (!stopRingBuffer(stream.id)) {
                self.postMessage({ type: "audio_pause", payload: { id: stream.id } });
            }
            stream.isPaused = true;
            Logger.log(LogCategory.SYSTEM, `MSS32: Stream paused (id=${stream.id})`);
        } else if (!pause && stream.isPaused) {
            if (!resumeRingBuffer(stream.id)) {
                self.postMessage({ type: "audio_resume", payload: { id: stream.id } });
            }
            stream.isPaused = false;
            Logger.log(LogCategory.SYSTEM, `MSS32: Stream resumed (id=${stream.id})`);
        }
        return 0;
    };

    // _AIL_resume_stream@4
    exports["_AIL_resume_stream@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_resume_stream@4 called: stream=0x${streamHandle.toString(16)}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        if (stream.isPaused) {
            if (!resumeRingBuffer(stream.id)) {
                self.postMessage({ type: "audio_resume", payload: { id: stream.id } });
            }
            stream.isPaused = false;
            Logger.log(LogCategory.SYSTEM, `MSS32: Stream resumed (id=${stream.id})`);
        }
        return 0;
    };

    // _AIL_stream_status@4
    exports["_AIL_stream_status@4"] = (ctxThunk, mem, args) => {
        const stream = ctx.streams.get(args[0]);
        if (!stream) return SMP_DONE;
        if (stream.isPaused) return SMP_PLAYING;
        return stream.isPlaying ? SMP_PLAYING : SMP_DONE;
    };

    // _AIL_stream_position@4
    exports["_AIL_stream_position@4"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        if (stream.isPlaying && stream.startTime && !stream.isPaused) {
            const elapsed = performance.now() - stream.startTime;
            const bytesPerSec = getBytesPerSecond(stream);
            const effectiveBytesPerSec = bytesPerSec * stream.playbackRate;
            stream.position = Math.floor((elapsed / 1000) * effectiveBytesPerSec);

            const totalLen = stream.pcmBytes ?? stream.fileData?.length ?? 0;
            if (totalLen > 0 && stream.position > totalLen) {
                stream.position = totalLen;
            }
        }
        return stream.position;
    };

    // _AIL_stream_ms_position@4 (alternate: _AIL_stream_position_ms@4)
    const streamMsPosition: ThunkImplementation = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        const bytesPerSec = getBytesPerSecond(stream);
        if (bytesPerSec === 0) return 0;

        const position = exports["_AIL_stream_position@4"]!(ctxThunk, mem, [streamHandle]) as number;
        return Math.floor((position / bytesPerSec) * 1000);
    };
    exports["_AIL_stream_ms_position@4"] = streamMsPosition;
    exports["_AIL_stream_position_ms@4"] = streamMsPosition;

    // _AIL_set_stream_position@8
    exports["_AIL_set_stream_position@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const position = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_position@8 called: stream=0x${streamHandle.toString(16)}, pos=${position}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        stream.position = position;
        writeStreamPosition(ctx, stream, position);

        if (stream.isPlaying) {
            const bytesPerSec = getBytesPerSecond(stream);
            const seekTimeMs = bytesPerSec > 0 ? (position / bytesPerSec) * 1000 : 0;
            self.postMessage({
                type: "audio_seek",
                payload: { id: stream.id, timeMs: seekTimeMs }
            });
        }
        return 0;
    };

    // _AIL_set_stream_volume@8
    exports["_AIL_set_stream_volume@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const volume = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_volume@8 called: stream=0x${streamHandle.toString(16)}, volume=${volume}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        stream.volume = Math.max(0, Math.min(127, volume));
        writeStreamVolume(ctx, stream, stream.volume);
        if (stream.isPlaying) updateStreamPlayback(ctx, stream);
        return 0;
    };

    // _AIL_stream_volume@4
    exports["_AIL_stream_volume@4"] = (ctxThunk, mem, args) => {
        const stream = ctx.streams.get(args[0]);
        return stream ? stream.volume : 127;
    };

    // _AIL_set_stream_pan@8
    exports["_AIL_set_stream_pan@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const pan = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_pan@8 called: stream=0x${streamHandle.toString(16)}, pan=${pan}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        stream.pan = Math.max(0, Math.min(127, pan));
        writeStreamPan(ctx, stream, stream.pan);
        if (stream.isPlaying) updateStreamPlayback(ctx, stream);
        return 0;
    };

    // _AIL_set_stream_loop_count@8
    exports["_AIL_set_stream_loop_count@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const loopCount = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_loop_count@8 called: stream=0x${streamHandle.toString(16)}, loopCount=${loopCount}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        stream.loopCount = loopCount;
        if (stream.isPlaying) updateStreamPlayback(ctx, stream);
        return 0;
    };

    // _AIL_set_stream_playback_rate@8
    exports["_AIL_set_stream_playback_rate@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const rate = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_set_stream_playback_rate@8 called: stream=0x${streamHandle.toString(16)}, rate=${rate}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        const targetRate = rate >>> 0;
        const baseRate = stream.sampleRate || 22050;
        stream.playbackRate = targetRate / baseRate;
        stream.playbackRateHz = targetRate;
        writeStreamPlaybackRate(ctx, stream, targetRate);
        if (stream.isPlaying) updateStreamPlayback(ctx, stream);
        return 0;
    };

    // _AIL_stream_info@8
    exports["_AIL_stream_info@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const infoType = args[1];
        Logger.verbose(LogCategory.SYSTEM, `MSS32: _AIL_stream_info@8 called: stream=0x${streamHandle.toString(16)}, infoType=${infoType}`);

        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        switch (infoType) {
            case 0: return Math.floor(getBytesPerSecond(stream));
            case 1: return stream.sampleRate;
            case 2: return stream.channels;
            case 3: return stream.bitsPerSample;
            case 4: return stream.formatTag;
            default: return 0;
        }
    };

    // _AIL_service_stream@8
    exports["_AIL_service_stream@8"] = (ctxThunk, mem, args) => {
        const streamHandle = args[0];
        const stream = ctx.streams.get(streamHandle);
        if (!stream) return 0;

        if (stream.isPlaying && !stream.isPaused) {
            const position = exports["_AIL_stream_position@4"]!(ctxThunk, mem, [streamHandle]) as number;
            writeStreamPosition(ctx, stream, position);

            const totalLen = stream.pcmBytes ?? stream.fileData?.length ?? 0;
            if (totalLen > 0 && position >= totalLen) {
                if (stream.loopCount === 1) {
                    stream.isPlaying = false;
                    setStreamStatus(ctx, stream, SMP_DONE);
                    return 0;
                }
            }
            return 1;
        }
        return 0;
    };

    return exports;
}

// ==================== Private helpers ====================

async function loadStreamFile(ctx: MSSContext, stream: MSSStream): Promise<void> {
    if (!stream.filename) {
        Logger.warn(LogCategory.SYSTEM, `MSS32: loadStreamFile: No filename provided`);
        return;
    }

    try {
        const system = System.getInstance();

        let handle = system.fileSystem.openSync(stream.filename, 0x80000000, 3);
        if (!handle) {
            handle = await system.fileSystem.open(stream.filename, 0x80000000, 3);
            if (!handle) {
                // Diagnostic: show resolved path and search for similar files
                const resolved = system.fileSystem.resolvePath(stream.filename);
                const baseName = stream.filename.split(/[\\/]/).pop()?.toLowerCase() ?? "";
                const dirName = stream.filename.split(/[\\/]/).slice(0, -1).join("/").toLowerCase();
                Logger.error(LogCategory.SYSTEM,
                    `MSS32: Failed to open stream file: "${stream.filename}" (resolved="${resolved}", currentDir="${system.fileSystem.currentDir}")`);
                // List available files in the same directory for debugging
                const dirEntries = system.fileSystem.listDirectory(
                    resolved.substring(0, resolved.lastIndexOf("\\")) || "C:\\"
                );
                if (dirEntries.length > 0) {
                    const names = dirEntries.slice(0, 30).map(e => e.name);
                    Logger.error(LogCategory.SYSTEM,
                        `MSS32: Available files in directory: [${names.join(", ")}] (${dirEntries.length} total)`);
                } else {
                    Logger.error(LogCategory.SYSTEM,
                        `MSS32: Directory appears empty or does not exist`);
                }
                return;
            }
        }

        const fileSize = system.fileSystem.getFileSize(handle.path);
        if (fileSize <= 0) {
            Logger.warn(LogCategory.SYSTEM, `MSS32: Stream file is empty: "${stream.filename}"`);
            return;
        }

        system.fileSystem.setPosition(handle, 0, 0);

        let fileData = system.fileSystem.readSync(handle, fileSize);
        if (!fileData) {
            fileData = await system.fileSystem.read(handle, fileSize);
        }

        if (!fileData || fileData.length === 0) {
            Logger.error(LogCategory.SYSTEM, `MSS32: Failed to read stream file: "${stream.filename}"`);
            return;
        }

        stream.fileData = fileData;
        decodeStreamFile(ctx, stream);
    } catch (err) {
        Logger.error(LogCategory.SYSTEM, `MSS32: Error loading stream file "${stream.filename ?? '(memory)'}": ${err}`);
    }
}
