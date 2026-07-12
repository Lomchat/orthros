export type VideoCodec = "smack" | "bink" | "avi" | "quartz";

export type VideoTargetHintKind =
    | "none"
    | "ddraw_surface"
    | "glide_lfb"
    | "app_buffer";

export interface VideoTargetHint {
    kind: VideoTargetHintKind;
    valid: boolean;
    updatedAtMs: number;
    surfacePtr?: number;
    pitch?: number;
    width?: number;
    height?: number;
    note?: string;
}

export type VideoSinkKind =
    | "EXPLICIT_DDRAW_SURFACE"
    | "EXPLICIT_GLIDE_LFB"
    | "APP_PRESENT_OBSERVED"
    | "CODEC_LEGACY_PRIMARY"
    | "VIDEO_OVERLAY"
    | "DROP";

export interface VideoFrameViews {
    width: number;
    height: number;
    frameIndex: number;
    frameDurationMs: number;
    decodedAtMs: number;
    bgra?: Uint8Array | null;
    rgb565?: Uint8Array | null;
    pal8Indices?: Uint8Array | null;
    paletteBgra?: Uint8Array | null;
}

export interface VideoSessionState {
    sessionKey: string;
    codec: VideoCodec;
    guestHandle: number;
    width: number;
    height: number;
    frameDurationMs: number;
    openedAtMs: number;
    lastDecodedAtMs: number;
    lastFinalizeAtMs: number;
    presentSerialAtDecode: number;
    lastObservedPresentSerial: number;
    lastObservedPresentAtMs: number;
    consecutiveMisses: number;
    sink: VideoSinkKind;
    sinkLockedToOverlay: boolean;
    targetHint: VideoTargetHint;
    frameViews: VideoFrameViews | null;
    hasAppManagedSink: boolean;
    legacyPrimarySink?: (() => boolean) | null;
    explicitDdrawSink?: (() => boolean) | null;
    explicitGlideSink?: (() => boolean) | null;
}

export type VideoRoutingEventType =
    | "session_open"
    | "target_hint"
    | "sink_selected"
    | "sink_submit_ok"
    | "sink_submit_fail"
    | "fallback_on"
    | "fallback_off"
    | "session_close";

export interface VideoRoutingEvent {
    id: number;
    timestampMs: number;
    sessionKey: string;
    type: VideoRoutingEventType;
    detail?: string;
}

export interface VideoSinkAdapter {
    readonly name: string;
    readonly kind: VideoSinkKind;
    readonly priority: number;
    canHandle(session: VideoSessionState): boolean;
    submit(session: VideoSessionState): boolean;
}
