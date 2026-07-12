export interface SehFrameSnapshot {
    addr: number;
    handler: number;
    scopeTable?: number;
    trylevel?: number;
}

export interface SehDumpManifest {
    timestampIso: string;
    generation: number;
    reason: string;
    eip: number;
    esp: number;
    ebp: number;
    sehHead: number;
    faultAddr: number;
    faultEip: number;
    filterAddr: number;
    handlerAddr: number;
    frameList: SehFrameSnapshot[];
    dumpRange: {
        base: number;
        end: number;
    };
}

export interface SehRuntimeDumpPacket {
    fileStem: string;
    manifest: SehDumpManifest;
    bytes: ArrayBuffer;
    baseAddress: number;
    endAddress: number;
}

function formatUtcStamp(date: Date): string {
    const iso = date.toISOString().replace(/[:]/g, "-");
    return iso.replace(/\.\d{3}Z$/, "Z");
}

export function makeSehDumpFileStem(generation: number, reason: string, at: Date = new Date()): string {
    const safeReason = reason.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${formatUtcStamp(at)}-g${generation.toString(16)}-${safeReason}`;
}

export function emitSehRuntimeDump(packet: SehRuntimeDumpPacket): boolean {
    const postMessageFn = (globalThis as any)?.postMessage;
    if (typeof postMessageFn !== "function") {
        return false;
    }

    try {
        postMessageFn(
            {
                type: "seh_runtime_dump",
                payload: {
                    fileStem: packet.fileStem,
                    manifest: packet.manifest,
                    baseAddress: packet.baseAddress >>> 0,
                    endAddress: packet.endAddress >>> 0,
                    bytes: packet.bytes,
                },
            },
            [packet.bytes],
        );
        return true;
    } catch {
        return false;
    }
}
