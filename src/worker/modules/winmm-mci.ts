/**
 * winmm MCI (Media Control Interface) subsystem: mciGetDeviceIDA / mciSendCommandA /
 * mciSendStringA / mciGetErrorStringA, the MCI device registry (id + alias maps), and
 * the AVI video playback engine (videoEngine decode, audio-preroll A/V sync, MM_MCINOTIFY
 * completion posting). Host interface supplies guest-string helpers shared with the
 * rest of WinMM (PlaySound / waveOutGetErrorText).
 */
import { ThunkImplementation, ThunkResult } from "../core/thunking/thunk-dispatcher";
import { TimeService } from "../runtime/time";
import { Logger, LogCategory } from "../core/logger";
import { System } from "../core/system";
import { EmulatorConfig } from "../core/emulator-config-manager";
import { videoEngine } from "../../video/video-engine";
import { getAbsoluteWindowPosition, windows } from "./user32/shared-state";
import {
    getCtrl,
    CTRL_PLAY_CURSOR,
    CTRL_BUFFER_BYTES,
} from "../../audio/audio-ring-buffer";

const MMSYSERR_NOERROR = 0;
const MMSYSERR_ERROR = 1;

// MCI constants
const MCIERR_INVALID_DEVICE_ID = 257;
const MCIERR_UNRECOGNIZED_COMMAND = 261;
const MCIERR_INVALID_DEVICE_NAME = 259;
const MCIERR_MISSING_COMMAND_STRING = 267;
const MCIERR_MISSING_STRING_ARGUMENT = 269;
const MCIERR_DUPLICATE_ALIAS = 289;

// MCI command messages
const MCI_OPEN = 0x0803;
const MCI_CLOSE = 0x0804;
const MCI_PLAY = 0x0806;
const MCI_STOP = 0x0808;
const MCI_STATUS = 0x0814;
const MCI_WINDOW = 0x0841;
const MCI_PUT = 0x0842;
const MCI_BREAK = 0x088E;

// MCI flags
const MCI_NOTIFY = 0x00000001;
const MCI_OPEN_ELEMENT = 0x00000200;
const MCI_OPEN_TYPE = 0x00002000;
const MCI_OPEN_TYPE_ID = 0x00004000;
const MCI_STATUS_ITEM = 0x00000100;
const MCI_STATUS_MODE = 0x00000004;
const MCI_STATUS_READY = 0x00000007;
const MCI_ANIM_WINDOW_HWND = 0x00010000;
const MCI_ANIM_RECT = 0x00040000;
const MCI_ANIM_PUT_SOURCE = 0x00010000;
const MCI_ANIM_PUT_DESTINATION = 0x00020000;
const MCI_ANIM_STATUS_HWND = 0x00004000;
const MCI_ANIM_STATUS_STRETCH = 0x00008000;

// MCI notification codes
const MCI_NOTIFY_SUCCESSFUL = 1;
const MCI_NOTIFY_ABORTED = 4;
const MCI_MODE_STOP = 525;
const MCI_MODE_PLAY = 526;
const MCI_MODE_PAUSE = 529;

// MM_MCINOTIFY message
const MM_MCINOTIFY = 0x03B9;

interface MCIDevice {
    id: number;
    name: string;
    alias: string;
    mode: "stopped" | "playing" | "paused";
    timeFormat: string;
    elementName?: string;
    deviceType?: string;
    hwndWindow?: number;
    windowRect?: { x: number; y: number; w: number; h: number };
    notifyHwnd?: number;
    breakKey?: number;
    breakHwnd?: number;
    notifyTimer?: ReturnType<typeof setTimeout>;
    videoEngineHandle?: number;
    videoFrameTimer?: ReturnType<typeof setTimeout>;
    videoStartInFlight?: boolean;
    videoFrameDurationMs?: number;
    videoWidth?: number;
    videoHeight?: number;
    videoNotifyRequested?: boolean;
    /** Preloaded AVI bytes (sync read on MCI open). */
    videoFileBytes?: Uint8Array;
    /** Wall-clock anchor for stream-time frame scheduling (ms). */
    videoPlaybackStartMs?: number;
    /** Frames presented since playback anchor (for deadline math). */
    videoFramesPresented?: number;
    /** videoFramesPresented at preroll completion — sync point for real-time pacing. */
    videoSyncPresented?: number;
    /** True once audio preroll met or the clip has no audio track. */
    videoPrerollComplete?: boolean;
    videoHasAudio?: boolean;
    videoAudioSampleRate?: number;
    videoAudioChannels?: number;
    /** True when play used MCI_WAIT — virtual time follows wall clock in waitForMciVideoCompletion. */
    mciWaitActive?: boolean;
    videoLastPlayCursor?: number;
    videoPlayedBytes?: number;
}

/** Guest-string helpers the MCI subsystem borrows from the owning WinMM module
 *  (they stay in winmm.ts because PlaySound / waveOutGetErrorText share them). */
export interface WinmmMciHost {
    readAnsiString(ptr: number, maxLen: number): string;
    writeAnsiString(ptr: number, cch: number, value: string): boolean;
}

export class WinmmMci {
    private mciDevices: Map<number, MCIDevice> = new Map();
    private mciAliases: Map<string, number> = new Map();
    private nextMCIDeviceId = 1;
    private readAnsiString: (ptr: number, maxLen: number) => string;
    private writeAnsiString: (ptr: number, cch: number, value: string) => boolean;

    constructor(host: WinmmMciHost) {
        this.readAnsiString = host.readAnsiString;
        this.writeAnsiString = host.writeAnsiString;
    }

    private tokenizeMciCommand(command: string): string[] {
        const tokens: string[] = [];
        const re = /"([^"]*)"|(\S+)/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(command)) !== null) {
            if (match[1] != null) {
                tokens.push(match[1]);
            } else if (match[2] != null) {
                tokens.push(match[2]);
            }
        }
        return tokens;
    }

    private findMciDevice(nameOrAlias: string): MCIDevice | null {
        const key = nameOrAlias.trim().toLowerCase();
        if (!key) return null;
        const aliasId = this.mciAliases.get(key);
        if (aliasId != null) {
            return this.mciDevices.get(aliasId) ?? null;
        }
        for (const device of this.mciDevices.values()) {
            if (device.name.toLowerCase() === key || device.alias.toLowerCase() === key) {
                return device;
            }
        }
        return null;
    }

    private createMciDevice(name: string, alias?: string): MCIDevice {
        const id = this.nextMCIDeviceId++;
        const resolvedAlias = (alias && alias.trim()) ? alias.trim() : name;
        const device: MCIDevice = {
            id,
            name: name.trim(),
            alias: resolvedAlias,
            mode: "stopped",
            timeFormat: "milliseconds",
        };
        this.mciDevices.set(id, device);
        this.mciAliases.set(resolvedAlias.toLowerCase(), id);
        return device;
    }

    private normalizeMciText(value?: string): string {
        return (value ?? "").trim().replace(/\\/g, "/").toLowerCase();
    }

    private describeMciDevice(device: MCIDevice): string {
        return `device=${device.id} alias="${device.alias}" type="${device.deviceType ?? ""}" file="${device.elementName ?? ""}"`;
    }

    private isMciVideoDevice(device: MCIDevice): boolean {
        const type = this.normalizeMciText(device.deviceType);
        const name = this.normalizeMciText(device.name);
        const element = this.normalizeMciText(device.elementName);
        return type.includes("video")
            || type.includes("avi")
            || name.endsWith(".avi")
            || element.endsWith(".avi");
    }

    private clearMciNotifyTimer(device: MCIDevice): void {
        if (device.notifyTimer != null) {
            clearTimeout(device.notifyTimer);
            device.notifyTimer = undefined;
        }
    }

    private clearMciVideoTimer(device: MCIDevice): void {
        if (device.videoFrameTimer != null) {
            clearTimeout(device.videoFrameTimer);
            device.videoFrameTimer = undefined;
        }
    }

    private closeMciVideoHandle(device: MCIDevice): void {
        this.clearMciVideoTimer(device);
        if (device.videoEngineHandle && device.videoEngineHandle > 0) {
            videoEngine.close(device.videoEngineHandle);
        }
        device.videoEngineHandle = 0;
        device.videoStartInFlight = false;
        device.videoWidth = 0;
        device.videoHeight = 0;
    }

    private resolveMciNotifyHwnd(device: MCIDevice, hwndCallback: number): number {
        const hwnd = (hwndCallback || device.notifyHwnd || device.hwndWindow || device.breakHwnd || 0) >>> 0;
        if (hwndCallback) {
            device.notifyHwnd = hwndCallback >>> 0;
        }
        return hwnd;
    }

    private postMciNotify(device: MCIDevice, status: number, hwndCallback: number, reason: string): void {
        const hwnd = this.resolveMciNotifyHwnd(device, hwndCallback);
        device.mode = "stopped";
        if (!hwnd) {
            Logger.log(LogCategory.SYSTEM,
                `MCI notify skipped (${reason}): ${this.describeMciDevice(device)} no callback hwnd`);
            return;
        }

        Logger.log(LogCategory.SYSTEM,
            `MCI notify (${reason}): ${this.describeMciDevice(device)} hwnd=0x${hwnd.toString(16)} status=${status}`);
        const system = System.getInstance();
        system.windowManager.postMessage(hwnd, MM_MCINOTIFY, status, device.id);
        system.scheduler.wakeMessageWaiters();
    }

    private scheduleMciCompletion(device: MCIDevice, hwndCallback: number, delayMs: number, reason: string): void {
        this.clearMciNotifyTimer(device);
        const hwnd = this.resolveMciNotifyHwnd(device, hwndCallback);
        if (delayMs <= 0) {
            this.postMciNotify(device, MCI_NOTIFY_SUCCESSFUL, hwnd, reason);
            return;
        }

        Logger.log(LogCategory.SYSTEM,
            `MCI notify scheduled (${reason}): ${this.describeMciDevice(device)} hwnd=0x${hwnd.toString(16)} delayMs=${delayMs}`);
        device.notifyTimer = setTimeout(() => {
            device.notifyTimer = undefined;
            if (!this.mciDevices.has(device.id)) return;
            this.postMciNotify(device, MCI_NOTIFY_SUCCESSFUL, hwnd, reason);
        }, delayMs);
    }

    private startMciPlayback(
        device: MCIDevice,
        notifyRequested: boolean,
        hwndCallback: number,
        source: string,
        waitForCompletion: boolean = false,
        stackCleanup: number = 0,
    ): number | ThunkResult | Promise<ThunkResult> {
        if (this.isMciVideoDevice(device)) {
            return this.playMciVideoThunk(
                device, notifyRequested, hwndCallback, source, waitForCompletion, stackCleanup);
        }

        Logger.log(LogCategory.SYSTEM,
            `${source} play: ${this.describeMciDevice(device)} notify=${notifyRequested ? 1 : 0}`);

        device.mode = "playing";
        if (notifyRequested) {
            this.scheduleMciCompletion(device, hwndCallback, 500, source);
        }
        return MMSYSERR_NOERROR;
    }

    private stopMciPlayback(device: MCIDevice, reason: string): void {
        const hadPendingNotify = device.notifyTimer != null;
        const hwnd = this.resolveMciNotifyHwnd(device, 0);
        this.clearMciNotifyTimer(device);
        this.abortMciVideoPlayback(device, reason);
        device.mode = "stopped";
        Logger.log(LogCategory.SYSTEM,
            `${reason}: ${this.describeMciDevice(device)} pendingNotify=${hadPendingNotify ? 1 : 0}`);
        if (hadPendingNotify && hwnd) {
            const system = System.getInstance();
            system.windowManager.postMessage(hwnd, MM_MCINOTIFY, MCI_NOTIFY_ABORTED, device.id);
            system.scheduler.wakeMessageWaiters();
        }
    }

    private resolveMciVideoVfsPath(device: MCIDevice): string | null {
        const rawPath = device.elementName || device.name;
        if (!rawPath) return null;

        const vfs = System.getInstance().fileSystem;
        const romPath = vfs.resolveRomMediaPath(rawPath);
        if (romPath) return romPath;

        let vfsPath = rawPath.replace(/\\/g, '/');
        if (vfsPath.match(/^[A-Z]:/i)) {
            vfsPath = `C:${vfsPath.substring(2).replace(/\//g, '\\')}`;
        } else {
            vfsPath = vfs.resolvePath(vfsPath);
        }
        return vfs.getFileSize(vfsPath) > 0 ? vfsPath : null;
    }

    private async readMciVideoFile(vfsPath: string): Promise<Uint8Array | null> {
        const sync = this.readMciVideoFileSync(vfsPath);
        if (sync) return sync;
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(vfsPath);
            const LIMIT_BYTES = 256 * 1024 * 1024;
            if (size <= 0 || size > LIMIT_BYTES) {
                Logger.warn(LogCategory.SYSTEM, `MCI video: invalid file size ${size} for "${vfsPath}"`);
                return null;
            }
            const GENERIC_READ = 0x80000000;
            const OPEN_EXISTING = 3;
            const handle = await vfs.open(vfsPath, GENERIC_READ, OPEN_EXISTING);
            if (!handle) return null;
            return await vfs.read(handle, size);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `MCI video: read "${vfsPath}" failed: ${e}`);
            return null;
        }
    }

    private readMciVideoFileSync(vfsPath: string): Uint8Array | null {
        try {
            const vfs = System.getInstance().fileSystem;
            const size = vfs.getFileSize(vfsPath);
            const LIMIT_BYTES = 256 * 1024 * 1024;
            if (size <= 0 || size > LIMIT_BYTES) return null;
            const GENERIC_READ = 0x80000000;
            const OPEN_EXISTING = 3;
            const handle = vfs.openSync(vfsPath, GENERIC_READ, OPEN_EXISTING);
            if (!handle) return null;
            const chunks: Uint8Array[] = [];
            let remaining = size;
            while (remaining > 0) {
                const chunk = vfs.readSync(handle, Math.min(remaining, 4 * 1024 * 1024));
                if (!chunk || chunk.length === 0) break;
                chunks.push(chunk);
                remaining -= chunk.length;
            }
            if (remaining > 0) return null;
            const out = new Uint8Array(size);
            let off = 0;
            for (const c of chunks) {
                out.set(c, off);
                off += c.length;
            }
            return out;
        } catch (e) {
            Logger.warn(LogCategory.SYSTEM, `MCI video sync read "${vfsPath}" failed: ${e}`);
            return null;
        }
    }

    private preloadMciVideoDevice(device: MCIDevice): void {
        if (device.videoFileBytes || !this.isMciVideoDevice(device)) return;
        const vfsPath = this.resolveMciVideoVfsPath(device);
        if (!vfsPath) return;
        const bytes = this.readMciVideoFileSync(vfsPath);
        if (bytes) {
            device.videoFileBytes = bytes;
            Logger.log(LogCategory.SYSTEM,
                `MCI video preload: ${this.describeMciDevice(device)} vfs="${vfsPath}" bytes=${bytes.length}`);
        }
    }

    private isMciVideoReady(device: MCIDevice): boolean {
        if (!this.isMciVideoDevice(device)) return true;
        if (device.videoStartInFlight) return false;
        return (device.videoEngineHandle ?? 0) > 0;
    }

    private async prepareMciVideoEngine(device: MCIDevice, source: string): Promise<boolean> {
        if (!this.mciDevices.has(device.id)) return false;

        if (EmulatorConfig.getInstance().skipVideo) {
            Logger.log(LogCategory.SYSTEM, `MCI video skipped by config: ${this.describeMciDevice(device)}`);
            this.completeMciVideoPlayback(device, 'skipVideo');
            return false;
        }

        if (!device.videoFileBytes) {
            this.preloadMciVideoDevice(device);
        }
        let fileBytes = device.videoFileBytes;
        if (!fileBytes) {
            const vfsPath = this.resolveMciVideoVfsPath(device);
            if (!vfsPath) {
                Logger.warn(LogCategory.SYSTEM, `MCI video not found: ${this.describeMciDevice(device)}`);
                this.completeMciVideoPlayback(device, 'missing');
                return false;
            }
            const loaded = await this.readMciVideoFile(vfsPath);
            if (!loaded) {
                this.completeMciVideoPlayback(device, 'read-failed');
                return false;
            }
            fileBytes = loaded;
            device.videoFileBytes = loaded;
        }

        if (!this.mciDevices.has(device.id) || device.mode !== 'playing') return false;

        const engineHandle = await videoEngine.open(fileBytes);
        const info = videoEngine.getInfo(engineHandle);
        if (!info) {
            videoEngine.close(engineHandle);
            this.completeMciVideoPlayback(device, 'open-failed');
            return false;
        }

        if (!this.mciDevices.has(device.id) || device.mode !== 'playing') {
            videoEngine.close(engineHandle);
            return false;
        }

        device.videoEngineHandle = engineHandle;
        device.videoStartInFlight = false;
        device.videoWidth = info.width;
        device.videoHeight = info.height;
        device.videoFrameDurationMs = info.fps > 0 ? (1000 / info.fps) : 66;
        device.videoHasAudio = info.hasAudio;
        device.videoAudioSampleRate = info.hasAudio ? info.sampleRate : 0;
        device.videoAudioChannels = info.hasAudio ? info.channels : 0;
        device.videoFramesPresented = 0;
        device.videoSyncPresented = 0;
        device.videoPrerollComplete = !info.hasAudio;
        device.videoPlaybackStartMs = info.hasAudio ? 0 : performance.now();

        Logger.log(LogCategory.SYSTEM,
            `${source} video decode started: ${this.describeMciDevice(device)} ` +
            `${info.width}x${info.height} fps=${info.fps.toFixed(1)} codec="${info.codecName}"`);
        this.decodeMciVideoFrame(device.id);
        return true;
    }

    private waitForMciVideoCompletion(device: MCIDevice): Promise<void> {
        const time = TimeService.getInstance();
        return new Promise((resolve) => {
            let lastPollMs = performance.now();
            const poll = (): void => {
                if (!this.mciDevices.has(device.id) || device.mode !== 'playing') {
                    resolve();
                    return;
                }
                // MCI_WAIT blocks the caller until playback ends; guest GetTickCount/timeGetTime
                // still advance at wall-clock rate while the thread is parked (async thunk).
                const now = performance.now();
                const dt = now - lastPollMs;
                lastPollMs = now;
                if (dt > 0) {
                    time.advanceVirtualTime(dt);
                }
                setTimeout(poll, 16);
            };
            poll();
        });
    }

    /**
     * Stream position in ms for A/V sync. Uses the audio play cursor when available
     * (master clock); falls back to wall time since preroll completed.
     */
    private getMciVideoStreamElapsedMs(device: MCIDevice): number {
        if (!device.videoPrerollComplete || !device.videoPlaybackStartMs) return 0;

        const handle = device.videoEngineHandle;
        if (device.videoHasAudio && handle && videoEngine.hasAudioPlaybackStarted(handle)) {
            const sab = videoEngine.getAudioSab(handle);
            const rate = device.videoAudioSampleRate ?? 0;
            const ch = device.videoAudioChannels ?? 0;
            const bufferBytes = sab ? getCtrl(sab, CTRL_BUFFER_BYTES) : 0;
            if (sab && rate > 0 && ch > 0 && bufferBytes > 0) {
                const playBytesWrapped = getCtrl(sab, CTRL_PLAY_CURSOR);

                // Track unwrapped position to handle ring wraps
                if (device.videoLastPlayCursor === undefined) {
                    device.videoPlayedBytes = playBytesWrapped;
                } else {
                    let delta = (playBytesWrapped - device.videoLastPlayCursor + bufferBytes) % bufferBytes;
                    // If the worklet is stuck in underrun, Atomics.load(CTRL_PLAY_CURSOR) stays constant.
                    // If it's a huge jump, assume it's a reset/seek rather than 1000 wraps.
                    if (delta > bufferBytes / 2) delta = 0;
                    device.videoPlayedBytes = (device.videoPlayedBytes ?? 0) + delta;
                }
                device.videoLastPlayCursor = playBytesWrapped;

                const blockAlign = ch * 2;
                if (blockAlign > 0) {
                    return (device.videoPlayedBytes / blockAlign / rate) * 1000;
                }
            }
        }
        return performance.now() - device.videoPlaybackStartMs;
    }

    /** Highest 0-based frame index that should be visible at the current stream position. */
    private getMciVideoTargetFrameIndex(device: MCIDevice): number {
        const anchor = device.videoSyncPresented ?? 0;
        const frameDur = device.videoFrameDurationMs ?? 66;
        if (frameDur <= 0) return anchor;
        const elapsed = this.getMciVideoStreamElapsedMs(device);
        return anchor + Math.floor(elapsed / frameDur);
    }

    private playMciVideoThunk(
        device: MCIDevice,
        notifyRequested: boolean,
        hwndCallback: number,
        source: string,
        waitForCompletion: boolean,
        stackCleanup: number,
    ): ThunkResult | Promise<ThunkResult> {
        this.clearMciNotifyTimer(device);
        this.abortMciVideoPlayback(device, 'restart');
        device.mode = 'playing';
        device.videoNotifyRequested = notifyRequested;
        device.videoStartInFlight = true;
        device.mciWaitActive = waitForCompletion;
        this.resolveMciNotifyHwnd(device, hwndCallback);
        this.preloadMciVideoDevice(device);

        Logger.log(LogCategory.SYSTEM,
            `${source} video play: ${this.describeMciDevice(device)} notify=${notifyRequested ? 1 : 0} wait=${waitForCompletion ? 1 : 0}`);

        return (async (): Promise<ThunkResult> => {
            try {
                const ok = await this.prepareMciVideoEngine(device, source);
                if (!ok) {
                    return { value: MMSYSERR_NOERROR, stackCleanup };
                }
                if (waitForCompletion) {
                    await this.waitForMciVideoCompletion(device);
                }
                return { value: MMSYSERR_NOERROR, stackCleanup };
            } catch (e) {
                Logger.error(LogCategory.SYSTEM, `MCI video playback failed: ${this.describeMciDevice(device)} ${e}`);
                this.completeMciVideoPlayback(device, 'error');
                return { value: MMSYSERR_NOERROR, stackCleanup };
            } finally {
                const cur = this.mciDevices.get(device.id);
                if (cur) cur.videoStartInFlight = false;
            }
        })();
    }

    private getMciVideoDestRect(device: MCIDevice, srcW: number, srcH: number): { x: number; y: number; w: number; h: number } {
        const win = device.hwndWindow ? windows.get(device.hwndWindow) : undefined;
        const base = win ? getAbsoluteWindowPosition(win) : { x: 0, y: 0 };
        if (device.windowRect && device.windowRect.w > 0 && device.windowRect.h > 0) {
            return {
                x: base.x + device.windowRect.x,
                y: base.y + device.windowRect.y,
                w: device.windowRect.w,
                h: device.windowRect.h,
            };
        }
        if (win) {
            return {
                x: base.x,
                y: base.y,
                w: win.width > 0 ? win.width : srcW,
                h: win.height > 0 ? win.height : srcH,
            };
        }
        return { x: 0, y: 0, w: srcW, h: srcH };
    }

    private completeMciVideoPlayback(device: MCIDevice, reason: string): void {
        device.mciWaitActive = false;
        this.closeMciVideoHandle(device);
        device.mode = "stopped";
        Logger.log(LogCategory.SYSTEM, `MCI video complete (${reason}): ${this.describeMciDevice(device)}`);
        if (device.videoNotifyRequested) {
            this.postMciNotify(device, MCI_NOTIFY_SUCCESSFUL, 0, `mci-video-${reason}`);
        }
        device.videoNotifyRequested = false;
    }

    private abortMciVideoPlayback(device: MCIDevice, reason: string): void {
        const hadVideo = !!device.videoEngineHandle || !!device.videoFrameTimer || !!device.videoStartInFlight;
        const shouldNotify = !!device.videoNotifyRequested;
        this.closeMciVideoHandle(device);
        device.videoNotifyRequested = false;
        if (!hadVideo) return;

        Logger.log(LogCategory.SYSTEM, `MCI video abort (${reason}): ${this.describeMciDevice(device)}`);
        if (shouldNotify) {
            this.postMciNotify(device, MCI_NOTIFY_ABORTED, 0, `mci-video-${reason}`);
        }
    }

    /** Max frames to decode at full speed while filling the audio preroll buffer. */
    private static readonly MCI_VIDEO_MAX_PREROLL_FRAMES = 120;
    /** Low-water mark: decode bursts when ring pending drops below this (ms of PCM). */
    private static readonly MCI_AUDIO_LOW_WATER_MS = 400;
    /** High-water mark: ease decode polling when pending exceeds this (ms of PCM). */
    private static readonly MCI_AUDIO_HIGH_WATER_MS = 900;
    /** Max consecutive doFrame calls per timer tick when refilling audio. */
    private static readonly MCI_AUDIO_DECODE_BURST = 16;

    private getMciAudioBytesForMs(device: MCIDevice, ms: number): number {
        const rate = device.videoAudioSampleRate ?? 0;
        const ch = device.videoAudioChannels ?? 1;
        if (rate <= 0 || ms <= 0) return 0;
        return Math.ceil(rate * ch * 2 * (ms / 1000));
    }

    private getMciAudioLowWaterBytes(device: MCIDevice): number {
        return this.getMciAudioBytesForMs(device, WinmmMci.MCI_AUDIO_LOW_WATER_MS);
    }

    private getMciAudioHighWaterBytes(device: MCIDevice): number {
        return this.getMciAudioBytesForMs(device, WinmmMci.MCI_AUDIO_HIGH_WATER_MS);
    }

    private scheduleMciVideoFrame(device: MCIDevice): void {
        if (device.mode !== "playing" || !device.videoEngineHandle) return;

        const frameDur = device.videoFrameDurationMs ?? 66;
        let delayMs: number;

        if (!device.videoPrerollComplete) {
            // Preroll: decode as fast as possible, but don't lap the max preroll frame count
            // in a single tick to avoid starving the worker's event loop.
            delayMs = 0;
        } else {
            const startMs = device.videoPlaybackStartMs ?? performance.now();
            const presented = device.videoFramesPresented ?? 0;
            const anchor = device.videoSyncPresented ?? 0;
            const targetIdx = this.getMciVideoTargetFrameIndex(device);

            if (presented <= targetIdx) {
                // Behind or on time: decode next frame ASAP.
                delayMs = 0;
            } else {
                // Ahead: wait for the next frame's deadline.
                const deadline = startMs + (presented - anchor + 1) * frameDur;
                delayMs = Math.max(1, deadline - performance.now());

                // If audio is hungry, throttle less aggressively to allow refilling.
                if (device.videoHasAudio) {
                    const buffered = videoEngine.getBufferedAudioBytes(device.videoEngineHandle!);
                    if (buffered < this.getMciAudioLowWaterBytes(device)) {
                        delayMs = Math.min(delayMs, 10);
                    }
                }
            }
        }

        device.videoFrameTimer = setTimeout(() => this.decodeMciVideoFrame(device.id), delayMs);
    }

    private tryCompleteMciVideoPreroll(device: MCIDevice): void {
        if (device.videoPrerollComplete || !device.videoEngineHandle || !device.videoHasAudio) return;

        const handle = device.videoEngineHandle;
        const preroll = videoEngine.getAudioPrerollBytes(handle);
        const buffered = videoEngine.getBufferedAudioBytes(handle);
        const presented = device.videoFramesPresented ?? 0;
        const ready = buffered >= preroll
            || presented >= WinmmMci.MCI_VIDEO_MAX_PREROLL_FRAMES
            || videoEngine.hasAudioPlaybackStarted(handle);

        if (!ready) return;

        videoEngine.beginAudioPlayback(handle);
        device.videoPrerollComplete = true;
        device.videoPlaybackStartMs = performance.now();
        device.videoSyncPresented = presented;
        Logger.log(LogCategory.SYSTEM,
            `MCI video preroll complete: ${this.describeMciDevice(device)} ` +
            `frames=${presented} buffered=${buffered}B preroll=${preroll}B`);
    }

    private decodeMciVideoFrame(deviceId: number): void {
        const device = this.mciDevices.get(deviceId);
        if (!device || device.mode !== "playing" || !device.videoEngineHandle) return;

        try {
            const handle = device.videoEngineHandle;
            const startMs = performance.now();
            const ok = videoEngine.doFrame(handle);
            const decodeElapsed = performance.now() - startMs;

            if (!ok) {
                if (decodeElapsed > 1) {
                    TimeService.getInstance().advanceVirtualTime(decodeElapsed);
                }
                this.completeMciVideoPlayback(device, "eof");
                return;
            }

            const frameIndex0 = device.videoFramesPresented ?? 0;
            const targetIdx = this.getMciVideoTargetFrameIndex(device);
            const shouldBlit = !device.videoPrerollComplete || frameIndex0 <= targetIdx;

            const bgra = shouldBlit ? videoEngine.getFrameBgra(handle) : null;
            const srcW = device.videoWidth ?? 0;
            const srcH = device.videoHeight ?? 0;
            if (bgra && srcW > 0 && srcH > 0) {
                const rect = this.getMciVideoDestRect(device, srcW, srcH);
                System.getInstance().gdiContext.drawBgraToOverlayRect(rect.x, rect.y, rect.w, rect.h, bgra, srcW, srcH);
            }

            device.videoFramesPresented = frameIndex0 + 1;
            this.tryCompleteMciVideoPreroll(device);

            // Virtual time: preroll frames only credit decode work; stream frames credit
            // one frame of media timeline unless MCI_WAIT (wall clock credited in wait poll).
            const frameDur = device.videoFrameDurationMs ?? 66;
            const time = TimeService.getInstance();
            if (!device.mciWaitActive) {
                if (device.videoPrerollComplete) {
                    time.advanceVirtualTime(Math.max(frameDur, decodeElapsed));
                } else if (decodeElapsed > 1) {
                    time.advanceVirtualTime(decodeElapsed);
                }
            } else if (!device.videoPrerollComplete && decodeElapsed > 1) {
                time.advanceVirtualTime(decodeElapsed);
            }

            videoEngine.nextFrame(handle);
        } catch (e) {
            Logger.error(LogCategory.SYSTEM, `MCI video decode error: ${e}`);
            this.completeMciVideoPlayback(device, "error");
            return;
        }

        this.scheduleMciVideoFrame(device);
    }

    registerExports(exports: Record<string, ThunkImplementation>): void {
        exports["mciGetDeviceIDA"] = (ctx, mem, args) => {
            const lpszDevice = args[0];
            if (!lpszDevice) return 0;

            const deviceName = this.readAnsiString(lpszDevice, 256).trim();
            if (!deviceName) return 0;

            Logger.verbose(LogCategory.SYSTEM, `mciGetDeviceIDA: device="${deviceName}"`);

            const existing = this.findMciDevice(deviceName);
            if (existing) return existing.id;

            return this.createMciDevice(deviceName).id;
        };

        exports["mciSendCommandA"] = (ctx, mem, args) => {
            const deviceId = args[0];
            const uMsg = args[1];
            const fdwCommand = args[2];
            const dwParam = args[3];

            Logger.log(LogCategory.SYSTEM, `mciSendCommandA: device=${deviceId}, msg=0x${uMsg.toString(16)}, cmd=0x${fdwCommand.toString(16)}, param=0x${dwParam.toString(16)}`);

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            if (uMsg === MCI_OPEN) {
                // MCI_OPEN_PARMS: +0 dwCallback, +4 wDeviceID, +8 lpstrDeviceType,
                // +12 lpstrElementName, +16 lpstrAlias
                let openName = "avivideo";
                let elementName = "";
                let deviceType = "";
                if (dwParam) {
                    const typePtr = view.getUint32(dwParam + 8, true);
                    const elemPtr = view.getUint32(dwParam + 12, true);
                    const aliasPtr = view.getUint32(dwParam + 16, true);
                    if (typePtr) deviceType = this.readAnsiString(typePtr, 256);
                    if (elemPtr) elementName = this.readAnsiString(elemPtr, 512);
                    if (aliasPtr) openName = this.readAnsiString(aliasPtr, 256) || openName;
                }
                const device = this.createMciDevice(openName, openName);
                device.elementName = elementName;
                device.deviceType = deviceType || "avivideo";
                if (dwParam) {
                    view.setUint32(dwParam + 4, device.id, true);
                }
                Logger.log(LogCategory.SYSTEM,
                    `mciSendCommandA MCI_OPEN: ${this.describeMciDevice(device)}`);
                this.preloadMciVideoDevice(device);
                return MMSYSERR_NOERROR;
            }

            const device = deviceId !== 0 ? this.mciDevices.get(deviceId) : undefined;

            if (uMsg === MCI_WINDOW && device) {
                if (dwParam && (fdwCommand & MCI_ANIM_WINDOW_HWND)) {
                    const hwnd = view.getUint32(dwParam + 4, true);
                    device.hwndWindow = hwnd;
                    Logger.log(LogCategory.SYSTEM,
                        `mciSendCommandA MCI_WINDOW: device=${deviceId} hwnd=0x${hwnd.toString(16)}`);
                }
                return MMSYSERR_NOERROR;
            }

            if (uMsg === MCI_PUT && device && dwParam) {
                if (fdwCommand & MCI_ANIM_PUT_DESTINATION) {
                    device.windowRect = {
                        x: view.getInt32(dwParam + 4, true),
                        y: view.getInt32(dwParam + 8, true),
                        w: view.getInt32(dwParam + 12, true) - view.getInt32(dwParam + 4, true),
                        h: view.getInt32(dwParam + 16, true) - view.getInt32(dwParam + 8, true),
                    };
                    Logger.log(LogCategory.SYSTEM,
                        `mciSendCommandA MCI_PUT destination: device=${deviceId} rect=${JSON.stringify(device.windowRect)}`);
                }
                return MMSYSERR_NOERROR;
            }

            if (uMsg === MCI_STATUS && device && dwParam) {
                if (fdwCommand & MCI_STATUS_ITEM) {
                    const item = view.getUint32(dwParam + 8, true);
                    if (item === MCI_STATUS_READY) {
                        const ready = this.isMciVideoReady(device) ? 1 : 0;
                        view.setUint32(dwParam + 4, ready, true);
                    } else if (item === MCI_STATUS_MODE) {
                        const mode = device.mode === "playing"
                            ? MCI_MODE_PLAY
                            : device.mode === "paused"
                                ? MCI_MODE_PAUSE
                                : MCI_MODE_STOP;
                        view.setUint32(dwParam + 4, mode, true);
                    }
                }
                if (fdwCommand & MCI_ANIM_STATUS_HWND && dwParam) {
                    view.setUint32(dwParam + 4, device.hwndWindow ?? 0, true);
                }
                return MMSYSERR_NOERROR;
            }

            if (uMsg === MCI_BREAK && device) {
                if (dwParam) {
                    const virtKey = view.getUint32(dwParam + 4, true);
                    const breakHwnd = view.getUint32(dwParam + 8, true);
                    device.breakKey = virtKey;
                    device.breakHwnd = breakHwnd;
                    Logger.log(LogCategory.SYSTEM,
                        `mciSendCommandA MCI_BREAK: ${this.describeMciDevice(device)} key=0x${virtKey.toString(16)} hwnd=0x${breakHwnd.toString(16)}`);
                }
                return MMSYSERR_NOERROR;
            }

            if (uMsg === MCI_PLAY) {
                // MCI_PLAY_PARMS layout:
                //   +0: DWORD_PTR dwCallback
                //   +4: DWORD dwFrom
                //   +8: DWORD dwTo
                if (!device) {
                    return deviceId !== 0 ? MCIERR_INVALID_DEVICE_ID : MMSYSERR_NOERROR;
                }
                const notifyRequested = (fdwCommand & MCI_NOTIFY) !== 0;
                const hwndCallback = notifyRequested && dwParam ? view.getUint32(dwParam, true) : 0;
                const waitForCompletion = (fdwCommand & 0x00000200) !== 0; // MCI_WAIT
                return this.startMciPlayback(
                    device,
                    notifyRequested,
                    hwndCallback,
                    "mciSendCommandA MCI_PLAY",
                    waitForCompletion,
                    16,
                );
            }

            if (uMsg === MCI_STOP || uMsg === MCI_CLOSE) {
                if (device) {
                    this.stopMciPlayback(device, `mciSendCommandA ${uMsg === MCI_STOP ? 'MCI_STOP' : 'MCI_CLOSE'}`);
                } else {
                    Logger.log(LogCategory.SYSTEM, `mciSendCommandA ${uMsg === MCI_STOP ? 'MCI_STOP' : 'MCI_CLOSE'}: device=${deviceId}`);
                }
                if (uMsg === MCI_CLOSE && deviceId !== 0 && device) {
                    this.mciDevices.delete(deviceId);
                    this.mciAliases.delete(device.alias.toLowerCase());
                }
                return MMSYSERR_NOERROR;
            }

            // Unknown command - return success (stub)
            if (deviceId !== 0 && !this.mciDevices.has(deviceId)) {
                return MCIERR_INVALID_DEVICE_ID;
            }
            return MMSYSERR_NOERROR;
        };

        exports["mciSendStringA"] = (ctx, mem, args) => {
            const lpszCommand = args[0];
            const lpstrReturnString = args[1];
            const cchReturn = args[2] >>> 0;
            const hwndCallback = args[3];

            if (!lpszCommand) {
                return MCIERR_MISSING_COMMAND_STRING;
            }

            const raw = this.readAnsiString(lpszCommand, 1024).trim();
            if (!raw) {
                return MCIERR_MISSING_COMMAND_STRING;
            }

            const tokens = this.tokenizeMciCommand(raw);
            if (tokens.length === 0) {
                return MCIERR_MISSING_COMMAND_STRING;
            }

            const verb = tokens[0].toLowerCase();
            Logger.verbose(LogCategory.SYSTEM, `mciSendStringA: "${raw}" cb=0x${hwndCallback.toString(16)}`);

            if (lpstrReturnString && cchReturn > 0) {
                this.writeAnsiString(lpstrReturnString, cchReturn, "");
            }

            if (verb === "open") {
                if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
                const name = tokens[1];
                let alias = "";
                const aliasIndex = tokens.findIndex((t) => t.toLowerCase() === "alias");
                if (aliasIndex >= 0 && aliasIndex + 1 < tokens.length) {
                    alias = tokens[aliasIndex + 1];
                }
                if (alias && this.mciAliases.has(alias.toLowerCase())) {
                    return MCIERR_DUPLICATE_ALIAS;
                }
                const typeIndex = tokens.findIndex((t) => t.toLowerCase() === "type");
                const device = this.createMciDevice(name, alias || undefined);
                device.elementName = name;
                device.deviceType = typeIndex >= 0 && typeIndex + 1 < tokens.length
                    ? tokens[typeIndex + 1]
                    : (this.normalizeMciText(name).endsWith(".avi") ? "avivideo" : undefined);
                Logger.log(LogCategory.SYSTEM, `mciSendStringA open: ${this.describeMciDevice(device)}`);
                this.preloadMciVideoDevice(device);
                return MMSYSERR_NOERROR;
            }

            if (verb === "close") {
                if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
                const target = tokens[1].toLowerCase();
                if (target === "all") {
                    for (const device of this.mciDevices.values()) {
                        this.stopMciPlayback(device, "mciSendStringA close all");
                    }
                    this.mciDevices.clear();
                    this.mciAliases.clear();
                    return MMSYSERR_NOERROR;
                }
                const device = this.findMciDevice(tokens[1]);
                if (!device) return MCIERR_INVALID_DEVICE_NAME;
                this.stopMciPlayback(device, "mciSendStringA close");
                this.mciDevices.delete(device.id);
                this.mciAliases.delete(device.alias.toLowerCase());
                return MMSYSERR_NOERROR;
            }

            if (verb === "sysinfo") {
                let out = "";
                if (tokens.some((t) => t.toLowerCase() === "quantity") && tokens.some((t) => t.toLowerCase() === "open")) {
                    out = this.mciDevices.size.toString();
                }
                if (lpstrReturnString && cchReturn > 0) {
                    this.writeAnsiString(lpstrReturnString, cchReturn, out);
                }
                return MMSYSERR_NOERROR;
            }

            if (verb === "set") {
                if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
                const device = this.findMciDevice(tokens[1]);
                if (!device) return MCIERR_INVALID_DEVICE_NAME;
                const lower = tokens.map((t) => t.toLowerCase());
                if (lower.includes("break")) {
                    const keyIdx = lower.indexOf("key");
                    if (keyIdx >= 0 && keyIdx + 1 < tokens.length) {
                        const keyTok = tokens[keyIdx + 1].toLowerCase();
                        device.breakKey = keyTok === "on" ? 0x1B : parseInt(tokens[keyIdx + 1], 0) || 0; // ESC default
                    }
                    Logger.log(LogCategory.SYSTEM, `mciSendStringA set break key: device=${device.alias}`);
                    return MMSYSERR_NOERROR;
                }
                const tf = tokens.findIndex((t) => t.toLowerCase() === "time");
                if (tf >= 0 && tf + 2 < tokens.length && tokens[tf + 1].toLowerCase() === "format") {
                    device.timeFormat = tokens[tf + 2];
                }
                const handleIdx = tokens.findIndex((t) => t.toLowerCase() === "handle");
                if (handleIdx >= 0 && handleIdx + 1 < tokens.length) {
                    device.hwndWindow = parseInt(tokens[handleIdx + 1], 0) >>> 0;
                }
                return MMSYSERR_NOERROR;
            }

            if (verb === "break") {
                if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
                const device = this.findMciDevice(tokens[1]);
                if (!device) return MCIERR_INVALID_DEVICE_NAME;
                Logger.log(LogCategory.SYSTEM, `mciSendStringA break: ${this.describeMciDevice(device)} key=0x${(device.breakKey ?? 0).toString(16)} hwnd=0x${(device.breakHwnd ?? 0).toString(16)}`);
                return MMSYSERR_NOERROR;
            }

            if (["play", "stop", "pause", "resume", "seek", "status"].includes(verb)) {
                if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
                const device = this.findMciDevice(tokens[1]);
                if (!device) return MCIERR_INVALID_DEVICE_NAME;
                const lower = tokens.map((t) => t.toLowerCase());

                if (verb === "play") {
                    return this.startMciPlayback(
                        device,
                        lower.includes("notify"),
                        hwndCallback,
                        "mciSendStringA",
                        lower.includes("wait"),
                        16,
                    );
                }
                if (verb === "stop") {
                    this.stopMciPlayback(device, "mciSendStringA stop");
                    return MMSYSERR_NOERROR;
                }
                if (verb === "pause") device.mode = "paused";
                if (verb === "resume") device.mode = "playing";
                if (verb === "status") {
                    const itemTokens = lower.slice(2).filter((t) => t !== "wait" && t !== "notify");
                    const item = itemTokens.length > 0 ? itemTokens.join(" ") : "mode";
                    let out = "0";
                    if (item === "mode") out = device.mode;
                    else if (item === "ready") out = this.isMciVideoReady(device) ? "true" : "false";
                    else if (item === "window handle") out = (device.hwndWindow ?? 0).toString();
                    if (lpstrReturnString && cchReturn > 0) {
                        this.writeAnsiString(lpstrReturnString, cchReturn, out);
                    }
                    Logger.log(LogCategory.SYSTEM, `mciSendStringA status: ${this.describeMciDevice(device)} item="${item}" -> "${out}"`);
                }
                return MMSYSERR_NOERROR;
            }

            if (verb === "window") {
                if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
                const device = this.findMciDevice(tokens[1]);
                if (!device) return MCIERR_INVALID_DEVICE_NAME;
                const handleIdx = tokens.findIndex((t) => t.toLowerCase() === "handle");
                if (handleIdx >= 0 && handleIdx + 1 < tokens.length) {
                    device.hwndWindow = parseInt(tokens[handleIdx + 1], 0) >>> 0;
                    Logger.log(LogCategory.SYSTEM, `mciSendStringA window: ${device.alias} hwnd=0x${device.hwndWindow.toString(16)}`);
                }
                return MMSYSERR_NOERROR;
            }

            if (verb === "put") {
                if (tokens.length < 2) return MCIERR_MISSING_STRING_ARGUMENT;
                const device = this.findMciDevice(tokens[1]);
                if (!device) return MCIERR_INVALID_DEVICE_NAME;
                const atIdx = tokens.findIndex((t) => t.toLowerCase() === "at");
                if (atIdx >= 0 && atIdx + 4 < tokens.length) {
                    device.windowRect = {
                        x: parseInt(tokens[atIdx + 1], 10) | 0,
                        y: parseInt(tokens[atIdx + 2], 10) | 0,
                        w: parseInt(tokens[atIdx + 3], 10) | 0,
                        h: parseInt(tokens[atIdx + 4], 10) | 0,
                    };
                }
                return MMSYSERR_NOERROR;
            }

            return MCIERR_UNRECOGNIZED_COMMAND;
        };

        exports["mciGetErrorStringA"] = (ctx, mem, args) => {
            const fdwError = args[0];
            const lpszErrorText = args[1];
            const cchErrorText = args[2];

            if (!lpszErrorText || cchErrorText === 0) return MMSYSERR_ERROR;

            const known: Record<number, string> = {
                [MMSYSERR_NOERROR]: "No error",
                [MCIERR_INVALID_DEVICE_ID]: "Invalid device ID",
                [MCIERR_INVALID_DEVICE_NAME]: "Invalid device name",
                [MCIERR_UNRECOGNIZED_COMMAND]: "Unrecognized command",
                [MCIERR_MISSING_COMMAND_STRING]: "Missing command string",
                [MCIERR_MISSING_STRING_ARGUMENT]: "Missing string argument",
                [MCIERR_DUPLICATE_ALIAS]: "Duplicate alias",
            };
            const errorMsg = known[fdwError] ?? `MCI Error ${fdwError}`;
            if (!this.writeAnsiString(lpszErrorText, cchErrorText, errorMsg)) {
                return MMSYSERR_ERROR;
            }

            Logger.verbose(LogCategory.SYSTEM, `mciGetErrorStringA: error=${fdwError}`);
            return 1; // TRUE
        };
    }

    reset(): void {
        this.mciDevices.clear();
        this.mciAliases.clear();
    }

    /** Diagnostic snapshot for paint-time guest-state logging. */
    formatMciDiagnosticSnapshot(): string {
        if (this.mciDevices.size === 0) return 'mci=none';
        const parts: string[] = [];
        for (const d of this.mciDevices.values()) {
            parts.push(
                `id=${d.id} mode=${d.mode} file="${d.elementName ?? ''}" ` +
                `engine=${d.videoEngineHandle ?? 0} inFlight=${d.videoStartInFlight ? 1 : 0} ` +
                `notify=${d.videoNotifyRequested ? 1 : 0}`,
            );
        }
        return `mci=[${parts.join('; ')}]`;
    }
}

export function registerWinmmMciExports(
    exports: Record<string, ThunkImplementation>,
    host: WinmmMciHost,
): WinmmMci {
    const mci = new WinmmMci(host);
    mci.registerExports(exports);
    return mci;
}
