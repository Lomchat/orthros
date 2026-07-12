import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import { systemEventLog, SystemEventKind } from "../diagnostics/system-event-log";
import type { RegionEntry, RegionKind } from "./address-space";
import { memoryEventBuffer } from "./memory-event-buffer";

export type MemoryAccessType = "read" | "write";

export interface MemoryFaultDetails {
    address: number;
    size: number;
    perms: string;
    region?: RegionEntry | null;
    accessType: MemoryAccessType;
    context: string;
    reason?: string;
}

const THUNK_FAULT_KINDS: Set<RegionKind> = new Set(["THUNK_CODE"]);
const WINAPI_HISTORY_COUNT = 8;
const RECENT_LOG_COUNT = 6;

export function reportMemoryFault(details: MemoryFaultDetails): void {
    systemEventLog.write(
        SystemEventKind.MEMORY_FAULT,
        details.address >>> 0,
        details.size >>> 0,
        details.accessType === "write" ? 1 : 0
    );
    const system = System.getInstance();
    const process = system.process;
    const cpu = process?.v86?.cpu || (process?.v86?.v86 && process?.v86?.v86.cpu);
    const eip = (cpu?.instruction_pointer?.[0] ?? 0) >>> 0;
    const eflags = (cpu?.flags?.[0] ?? 0) >>> 0;
    const regionDesc = describeRegion(details.region);

    Logger.error(
        LogCategory.SYSTEM,
        `${details.context}: ${details.accessType.toUpperCase()} violation at ${regionDesc} ` +
        `addr=0x${details.address.toString(16)} size=0x${details.size.toString(16)} perms=${details.perms}`
    );

    Logger.error(LogCategory.SYSTEM, `EIP=0x${eip.toString(16)} EFLAGS=0x${eflags.toString(16)}`);

    if (details.reason) {
        Logger.error(LogCategory.SYSTEM, `Reason: ${details.reason}`);
    }

    logRecentWinApiCalls(process);
    logRecentLogContext();
    memoryEventBuffer.dump();

    const faultKind = details.region?.kind;
    if (faultKind && THUNK_FAULT_KINDS.has(faultKind) && details.accessType === "write") {
        Logger.error(LogCategory.SYSTEM, "Unauthorized write to THUNK_CODE detected - halting emulator.");
        haltEmulator(process, system);
    }
}

function describeRegion(region?: RegionEntry | null): string {
    if (!region) {
        return "unmapped region";
    }
    const start = region.base.toString(16).padStart(8, "0");
    const end = (region.base + region.size).toString(16).padStart(8, "0");
    return `${region.kind}:${start}..${end}`;
}

function logRecentWinApiCalls(process?: System["process"]): void {
    const dispatcher = process?.dispatcher;
    if (!dispatcher || typeof dispatcher.getLastWinApiCalls !== "function") return;
    const calls = dispatcher.getLastWinApiCalls(WINAPI_HISTORY_COUNT);
    if (calls.length === 0) return;
    Logger.log(LogCategory.SYSTEM, `Recent WinAPI calls: ${calls.join(" | ")}`);
}

function logRecentLogContext(): void {
    const entries = Logger.getRecentEntries(RECENT_LOG_COUNT);
    if (entries.length === 0) return;
    const summary = entries
        .map(entry => `[${entry.category}] ${entry.message.split("\n")[0]}`)
        .join(" | ");
    Logger.log(LogCategory.SYSTEM, `Recent log context: ${summary}`);
}

function haltEmulator(process: System["process"] | null, system: System): void {
    system.isExiting = true;
    system.isCleaningUp = true;
    try {
        process?.v86?.stop();
    } catch {
        Logger.warn(LogCategory.SYSTEM, "Error while stopping v86 after memory fault");
    }
}
