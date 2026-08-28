import { Process } from "../../core/process";
import { VfsFileHandle } from "../../runtime/filesystem/vfs";
import { MSSSample, MSSStream, MSSWaveOut, RedbookHandle, MSSTimer, MSSSequence, MSSListener3D } from "./types";

export const SMP_FREE = 1;
export const SMP_DONE = 2;
export const SMP_PLAYING = 4;
export const SMP_STOPPED = 8;

/**
 * Miles Sound System 6.x preference defaults, indexed by the public
 * AIL_PREFERENCE enum. Keep all N_PREFS entries: games legitimately query the
 * later DirectSound preferences during startup (for example index 34,
 * DIG_DS_FRAGMENT_SIZE).
 */
export const MILES_PREFERENCE_DEFAULTS = Object.freeze([
    131, 64, 127, 120, 8, 127, 1, 0, 2, 0,
    1536, 49152, 5, 16, 8192, 0, 32768, 44100, 0, 4096,
    120, 24, 0, 1, 0, 1, 0, 1, 1, 0,
    0, 1, 2048, 0, 8, 96, 0, 0, 0, 32768,
    0, 250, 8, 1, 1, 100,
]);

export function createMilesPreferences(): number[] {
    return Array.from(MILES_PREFERENCE_DEFAULTS);
}

export interface MSSContext {
    process: Process;
    memory: Uint8Array;

    samples: Map<number, MSSSample>;
    samplesById: Map<number, MSSSample>;
    streams: Map<number, MSSStream>;
    streamsById: Map<number, MSSStream>;
    waveOuts: Map<number, MSSWaveOut>;
    fileHandles: Map<number, VfsFileHandle>;
    redbookHandles: Map<number, RedbookHandle>;
    timers: Map<number, MSSTimer>;
    sequences: Map<number, MSSSequence>;

    nextSampleId: number;
    nextStreamId: number;
    nextWaveOutId: number;
    nextFileHandleId: number;
    nextTimerId: number;
    nextRedbookId: number;
    nextRedbookAudioId: number;
    nextSequenceId: number;

    initialized: boolean;
    digitalDriverHandle: number;
    driverDummyBuffer: number;
    driverWaveFormat: number;
    driverNoopStub: number;
    driverNoopTable: number;
    /** Guest-memory sample array: maxSamples × SAMPLE_STRUCT_SIZE bytes at driver[0x34] */
    driverSampleArray: number;
    driverMaxSamples: number;
    driverOutputRate: number;
    /** RIB type tag strings in guest memory — real MSS32 writes these at handle+0x00 */
    driverTypeTag: number;
    sampleTypeTag: number;
    /** Build buffer (driver+0x40) and decode buffer (driver+0xF8) — real MSS32 allocates these */
    driverBuildBuffer: number;
    driverDecodeBuffer: number;
    /** Aux buffers (driver+0xB0/B4/B8) — real MSS32 allocates maxSamples×4 each for mixing */
    driverAuxBuffer1: number;
    driverAuxBuffer2: number;
    driverAuxBuffer3: number;
    /** Guest-memory string for fake 3D provider name — returned by _AIL_enumerate_3D_providers */
    provider3DNamePtr: number;
    /** Guest-memory name returned by _AIL_enumerate_filters. */
    filterNamePtr: number;
    /** Miles 3D listener (created by _AIL_open_3D_listener). Distinct handle from sample handles. */
    listener3D: MSSListener3D | null;
    /** Global listener SAB shared with the audio worklet (LCTRL_* layout). */
    listenerSab: SharedArrayBuffer | null;
    /** Current 3D speaker-type preference (AIL_3D_2_SPEAKER etc.). */
    speakerType3D: number;
    /** Current 3D room-type (EAX environment preset). */
    roomType3D: number;
    /** MSS preferences array — indexed by preference number, stores current values */
    preferences: number[];
    midiDriverHandle: number;
    midiMasterVolume: number;
    updateInterval: any;
    startupTime: number;
    lastErrorPtr: number;
    lastErrorStr: string;

    /** Pointers allocated by readFileToBuffer when destBuffer is NULL; freed by _AIL_mem_free_lock */
    memAllocatedByMss: Set<number>;
    /** Queue of pending timer callbacks - processed during _AIL_serve to avoid corrupting CPU state */
    pendingTimerCallbacks: Array<{ callback: number; user: number }>;
    /** Queue of pending EOS callbacks - processed during _AIL_serve to avoid corrupting CPU state */
    pendingEOSCallbacks: Array<{ callback: number; handle: number; user: number }>;
    /** Flag to track if we're inside _AIL_serve (safe to invoke callbacks) */
    insideAilServe: boolean;
    /** H3 Async: reentrancy depth of _AIL_serve (nested serve = possible stack/callback conflict) */
    serveDepth: number;
    /** WAV format tag keyed by guest data-chunk pointer (set by AIL_WAV_info for ADPCM decode). */
    wavFormatByDataPtr: Map<number, number>;
}

export function createMSSContext(process: Process, memory: Uint8Array): MSSContext {
    return {
        process,
        memory,

        samples: new Map(),
        samplesById: new Map(),
        streams: new Map(),
        streamsById: new Map(),
        waveOuts: new Map(),
        fileHandles: new Map(),
        redbookHandles: new Map(),
        timers: new Map(),
        sequences: new Map(),

        nextSampleId: 1,
        nextStreamId: 0x00010001,
        nextWaveOutId: 1,
        nextFileHandleId: 0x50000000,
        nextTimerId: 1,
        nextRedbookId: 0x52420001,
        nextRedbookAudioId: 0x00CD0001,
        nextSequenceId: 1,

        initialized: false,
        digitalDriverHandle: 0,
        driverDummyBuffer: 0,
        driverWaveFormat: 0,
        driverNoopStub: 0,
        driverNoopTable: 0,
        driverSampleArray: 0,
        driverMaxSamples: MILES_PREFERENCE_DEFAULTS[1],
        driverOutputRate: 44100,
        driverTypeTag: 0,
        sampleTypeTag: 0,
        driverBuildBuffer: 0,
        driverDecodeBuffer: 0,
        driverAuxBuffer1: 0,
        driverAuxBuffer2: 0,
        driverAuxBuffer3: 0,
        provider3DNamePtr: 0,
        filterNamePtr: 0,
        listener3D: null,
        listenerSab: null,
        speakerType3D: 0,
        roomType3D: 0,
        preferences: createMilesPreferences(),
        midiDriverHandle: 0,
        midiMasterVolume: 127,
        updateInterval: null,
        startupTime: 0,
        lastErrorPtr: 0,
        lastErrorStr: "",

        memAllocatedByMss: new Set(),
        pendingTimerCallbacks: [],
        pendingEOSCallbacks: [],
        insideAilServe: false,
        serveDepth: 0,
        wavFormatByDataPtr: new Map(),
    };
}
