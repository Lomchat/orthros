import { VfsFileHandle } from "../../runtime/filesystem/vfs";

// Miles Sound System sample handle
export interface MSSSample {
    id: number;
    handle: number;
    fileData: Uint8Array | null;
    decodedData: Float32Array | null;
    streamBuffers?: { ptr: number; size: number; inUse: boolean }[];
    userData?: number[];
    totalBytes?: number;
    fileFormat?: "wav" | "mp3" | "ogg" | "unknown";
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    formatTag: number;
    blockAlign: number;
    volume: number; // 0-127
    pan: number; // Miles API 0-127 (64=center)
    playbackRate: number; // multiplier for WAV
    playbackRateHz?: number; // current rate in Hz (API getter returns this)
    loopCount: number;
    /** PCM data length in bytes (WAV data chunk only); used for len/done in guest struct */
    pcmBytes?: number;
    isPlaying: boolean;
    isStopped: boolean;
    position: number;
    pendingStart: boolean;
    fileDataAllocated: boolean; // Track if fileData was allocated in emulator memory (vs loaded from VFS or referenced)
    fileDataAddress?: number; // Address if allocated in emulator memory
    startTime?: number; // Timestamp when playback started (for position calculation)
    lastDebugLogTime?: number; // Last timestamp for debug logging
    lastDebugPos?: number; // Last position for debug logging
    lastAudioPositionTime?: number; // Timestamp of last authoritative audio position update
    lastAudioPositionBytes?: number; // Last authoritative position in bytes
    lastRingCursorBytes?: number; // Last SAB play cursor observed by heartbeat
    lastRingCursorTime?: number; // Timestamp when the SAB play cursor last moved
    /** Estimated decoded duration for encoded formats decoded by the host audio stack. */
    encodedDurationMs?: number;

    // --- Miles 3D positional audio (set via the _AIL_*_3D_* API) ---
    /** True for samples allocated via _AIL_allocate_3D_sample_handle — routed through the worklet 3D mixer. */
    is3D?: boolean;
    /** Spatial state pushed into the ring buffer's CTRL_3D_* fields. World units = game units. */
    pos3D?: { x: number; y: number; z: number };
    vel3D?: { x: number; y: number; z: number };
    minDist3D?: number;
    maxDist3D?: number;
    /** DS3DMODE_* (0=normal, 1=head-relative, 2=disable). */
    mode3D?: number;
    cone3D?: { inner: number; outer: number; oriX: number; oriY: number; oriZ: number; outVolCb: number };
}

/** Miles 3D listener — one per provider; drives the global listener SAB the worklet mixes against. */
export interface MSSListener3D {
    handle: number;
    posX: number; posY: number; posZ: number;
    velX: number; velY: number; velZ: number;
    frontX: number; frontY: number; frontZ: number;
    topX: number; topY: number; topZ: number;
    distanceFactor: number;
    rolloffFactor: number;
    dopplerFactor: number;
}

// Redbook (CD Audio) handle - maps CD track positions to OGG files in VFS
export interface RedbookHandle {
    id: number;                    // Unique handle ID
    tracks: { file: string; startMs: number; endMs: number }[];
    volume: number;                // 0-127
    status: number;                // 1=STOPPED, 2=PLAYING, 3=PAUSED
    currentTrackIdx: number;       // Which track is playing (-1 = none)
    startTime: number;             // performance.now() when play started
    playStartMs: number;           // startmsec passed to play()
    playEndMs: number;             // endmsec passed to play()
    audioId: number;               // Audio engine playback ID (from nextRedbookAudioId)
    pauseElapsedMs: number;        // Elapsed ms when paused (for resume)
}

// Wave output device handle
export interface MSSWaveOut {
    handle: number;
    deviceId: number;
    preparedHeaders?: Map<number, { ptr: number; len: number; flags: number }>;
}

// Miles Sound System stream handle (for streaming audio playback - e.g., Smacker video audio)
export interface MSSStream {
    id: number;
    handle: number;
    fileData: Uint8Array | null;
    decodedData: Float32Array | null;
    filename: string | null;
    fileFormat?: "wav" | "mp3" | "ogg" | "unknown";
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    formatTag: number;
    blockAlign: number;
    volume: number; // 0-127
    pan: number; // 0-127 (64=center)
    playbackRate: number;
    playbackRateHz?: number;
    loopCount: number;
    pcmBytes?: number;
    streamDummyBuffer?: number; // Allocated dummy buffer for stream struct
    isPlaying: boolean;
    isPaused: boolean;
    position: number;
    pendingStart: boolean;
    startTime?: number;
    lastAudioPositionTime?: number;
    lastAudioPositionBytes?: number;
    /** Estimated decoded duration for encoded formats decoded by the host audio stack. */
    encodedDurationMs?: number;
}

// MIDI/XMIDI sequence handle (stub — no actual playback)
export interface MSSSequence {
    handle: number;
    status: number;     // SMP_DONE(2) / SMP_PLAYING(4) / SMP_STOPPED(8)
    volume: number;     // 0-127
    loopCount: number;
    tempo: number;      // microseconds per beat
}

// Timer handle
export interface MSSTimer {
    handle: number;
    callback: number;
    user: number;
    freq: number;
    period: number;
    active: boolean;
    timerId?: number;
}
