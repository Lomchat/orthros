/**
 * WTSAPI32.dll — Terminal Services session API.
 *
 * Faithful single-console semantics: one active local session, not RDP.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { encodeAnsi } from "./codepage-utils";

const TRUE = 1;
const FALSE = 0;

const WTS_CURRENT_SERVER_HANDLE = 0;
const WTS_CURRENT_SESSION = 0xffffffff;

// WTS_INFO_CLASS (wtsapi.h)
const WTSInitialProgram = 0;
const WTSApplicationName = 1;
const WTSWorkingDirectory = 2;
const WTSOEMId = 3;
const WTSSessionId = 4;
const WTSUserName = 5;
const WTSWinStationName = 6;
const WTSDomainName = 7;
const WTSConnectState = 8;
const WTSClientBuildNumber = 9;
const WTSClientName = 10;
const WTSClientDirectory = 11;
const WTSClientProductId = 12;
const WTSClientHardwareId = 15;
const WTSClientAddress = 16;
const WTSClientDisplay = 17;
const WTSClientProtocolType = 18;

const WTSActive = 0;
const WTSUserNameValue = "User";
const WTSWinStationNameValue = "Console";
const WTSDomainNameValue = "WORKGROUP";
const WTSClientNameValue = "";

const ERROR_INVALID_PARAMETER = 87;
const ERROR_CALL_NOT_IMPLEMENTED = 120;

export class Wtsapi32 implements IModule {
    name = "wtsapi32";
    exports: Record<string, ThunkImplementation> = {};
    private process!: Process;
    private wtsAllocations = new Set<number>();

    initialize(process: Process): void {
        this.process = process;

        this.exports["WTSFreeMemory"] = (ctx, mem, args) => {
            const ptr = args[0] >>> 0;
            if (ptr && this.wtsAllocations.delete(ptr)) {
                try {
                    this.process.memory.free(ptr);
                } catch {
                    // Already freed or invalid — ignore like heap free on stale pointer
                }
            }
            return 0;
        };

        this.exports["WTSQuerySessionInformationA"] = (ctx, mem, args) => {
            return this.querySessionInformation(mem, args, false);
        };

        this.exports["WTSQuerySessionInformationW"] = (ctx, mem, args) => {
            return this.querySessionInformation(mem, args, true);
        };

        this.exports["WTSEnumerateSessionsA"] = (ctx, mem, args) => {
            return this.enumerateSessions(mem, args, false);
        };

        this.exports["WTSEnumerateSessionsW"] = (ctx, mem, args) => {
            return this.enumerateSessions(mem, args, true);
        };

        this.exports["WTSRegisterSessionNotification"] = (ctx, mem, args) => {
            const hwnd = args[0] >>> 0;
            const flags = args[1] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `wtsapi32:WTSRegisterSessionNotification(hwnd=0x${hwnd.toString(16)}, flags=0x${flags.toString(16)}) -> TRUE`
            );
            return TRUE;
        };

        this.exports["WTSUnRegisterSessionNotification"] = (ctx, mem, args) => {
            const hwnd = args[0] >>> 0;
            Logger.verbose(
                LogCategory.SYSTEM,
                `wtsapi32:WTSUnRegisterSessionNotification(hwnd=0x${hwnd.toString(16)}) -> TRUE`
            );
            return TRUE;
        };

        this.exports["WTSGetActiveConsoleSessionId"] = () => {
            return 0;
        };

        this.exports["WTSOpenServerA"] = (ctx, mem, args) => {
            const namePtr = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `wtsapi32:WTSOpenServerA(0x${namePtr.toString(16)}) -> WTS_CURRENT_SERVER_HANDLE`);
            return WTS_CURRENT_SERVER_HANDLE;
        };

        this.exports["WTSOpenServerW"] = (ctx, mem, args) => {
            const namePtr = args[0] >>> 0;
            Logger.verbose(LogCategory.SYSTEM, `wtsapi32:WTSOpenServerW(0x${namePtr.toString(16)}) -> WTS_CURRENT_SERVER_HANDLE`);
            return WTS_CURRENT_SERVER_HANDLE;
        };

        this.exports["WTSCloseServer"] = () => TRUE;

        this.exports["WTSQueryUserToken"] = () => {
            this.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
            return FALSE;
        };

        this.exports["WTSDisconnectSession"] = () => {
            this.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
            return FALSE;
        };

        this.exports["WTSWaitSystemEvent"] = () => {
            this.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
            return FALSE;
        };

        this.exports["WTSEnumerateProcessesW"] = () => {
            this.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
            return FALSE;
        };
    }

    reset(): void {
        this.wtsAllocations.clear();
    }

    private setLastError(code: number): void {
        System.getInstance().scheduler.setLastError(code);
    }

    private trackAlloc(ptr: number): number {
        if (ptr) this.wtsAllocations.add(ptr);
        return ptr;
    }

    private allocBytes(size: number): number {
        const ptr = this.process.memory.alloc(size);
        return this.trackAlloc(ptr >>> 0);
    }

    private writeAnsi(ptr: number, mem: Uint8Array, value: string): number {
        const bytes = encodeAnsi(value.endsWith("\0") ? value : `${value}\0`);
        mem.set(bytes, ptr);
        return bytes.length;
    }

    private writeWide(ptr: number, mem: Uint8Array, value: string): number {
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const chars = value.endsWith("\0") ? value.slice(0, -1) : value;
        let off = ptr;
        for (let i = 0; i < chars.length; i++) {
            view.setUint16(off, chars.charCodeAt(i), true);
            off += 2;
        }
        view.setUint16(off, 0, true);
        return (chars.length + 1) * 2;
    }

    private resolveSessionId(sessionId: number): number {
        if (sessionId === WTS_CURRENT_SESSION) return 0;
        return sessionId >>> 0;
    }

    private querySessionInformation(mem: Uint8Array, args: number[], wide: boolean): number {
        const hServer = args[0] >>> 0;
        const sessionId = this.resolveSessionId(args[1] >>> 0);
        const infoClass = args[2] >>> 0;
        const ppBuffer = args[3] >>> 0;
        const pBytesReturned = args[4] >>> 0;

        if (ppBuffer === 0 || pBytesReturned === 0) {
            this.setLastError(ERROR_INVALID_PARAMETER);
            return FALSE;
        }

        // Only local default server / console session is modeled.
        if (hServer !== 0 && hServer !== WTS_CURRENT_SERVER_HANDLE) {
            this.setLastError(ERROR_INVALID_PARAMETER);
            return FALSE;
        }

        let dataPtr = 0;
        let byteCount = 0;

        switch (infoClass) {
            case WTSInitialProgram:
            case WTSApplicationName:
            case WTSWorkingDirectory:
            case WTSOEMId:
            case WTSClientDirectory:
            case WTSClientHardwareId:
            case WTSClientAddress:
            case WTSClientDisplay:
                dataPtr = wide ? this.allocBytes(2) : this.allocBytes(1);
                if (wide) this.writeWide(dataPtr, mem, "");
                else this.writeAnsi(dataPtr, mem, "");
                byteCount = wide ? 2 : 1;
                break;
            case WTSSessionId:
                dataPtr = this.allocBytes(4);
                Mem.writeUint32(dataPtr, sessionId);
                byteCount = 4;
                break;
            case WTSConnectState:
                dataPtr = this.allocBytes(4);
                Mem.writeUint32(dataPtr, WTSActive);
                byteCount = 4;
                break;
            case WTSClientBuildNumber:
            case WTSClientProductId:
            case WTSClientProtocolType:
                dataPtr = this.allocBytes(4);
                Mem.writeUint32(dataPtr, 0);
                byteCount = 4;
                break;
            case WTSUserName:
                dataPtr = wide
                    ? this.allocBytes((WTSUserNameValue.length + 1) * 2)
                    : this.allocBytes(WTSUserNameValue.length + 1);
                byteCount = wide
                    ? this.writeWide(dataPtr, mem, WTSUserNameValue)
                    : this.writeAnsi(dataPtr, mem, WTSUserNameValue);
                break;
            case WTSWinStationName:
                dataPtr = wide
                    ? this.allocBytes((WTSWinStationNameValue.length + 1) * 2)
                    : this.allocBytes(WTSWinStationNameValue.length + 1);
                byteCount = wide
                    ? this.writeWide(dataPtr, mem, WTSWinStationNameValue)
                    : this.writeAnsi(dataPtr, mem, WTSWinStationNameValue);
                break;
            case WTSDomainName:
                dataPtr = wide
                    ? this.allocBytes((WTSDomainNameValue.length + 1) * 2)
                    : this.allocBytes(WTSDomainNameValue.length + 1);
                byteCount = wide
                    ? this.writeWide(dataPtr, mem, WTSDomainNameValue)
                    : this.writeAnsi(dataPtr, mem, WTSDomainNameValue);
                break;
            case WTSClientName:
                dataPtr = wide
                    ? this.allocBytes((WTSClientNameValue.length + 1) * 2)
                    : this.allocBytes(WTSClientNameValue.length + 1);
                byteCount = wide
                    ? this.writeWide(dataPtr, mem, WTSClientNameValue)
                    : this.writeAnsi(dataPtr, mem, WTSClientNameValue);
                break;
            default:
                Logger.verbose(
                    LogCategory.SYSTEM,
                    `wtsapi32:WTSQuerySessionInformation${wide ? "W" : "A"}(session=${sessionId}, class=${infoClass}) -> FALSE`
                );
                this.setLastError(ERROR_INVALID_PARAMETER);
                Mem.writeUint32(ppBuffer, 0);
                Mem.writeUint32(pBytesReturned, 0);
                return FALSE;
        }

        Mem.writeUint32(ppBuffer, dataPtr);
        Mem.writeUint32(pBytesReturned, byteCount);
        Logger.verbose(
            LogCategory.SYSTEM,
            `wtsapi32:WTSQuerySessionInformation${wide ? "W" : "A"}(session=${sessionId}, class=${infoClass}) -> TRUE ptr=0x${dataPtr.toString(16)} bytes=${byteCount}`
        );
        return TRUE;
    }

    private enumerateSessions(mem: Uint8Array, args: number[], wide: boolean): number {
        const hServer = args[0] >>> 0;
        const reserved = args[1] >>> 0;
        const version = args[2] >>> 0;
        const ppSessionInfo = args[3] >>> 0;
        const pCount = args[4] >>> 0;

        if (ppSessionInfo === 0 || pCount === 0) {
            this.setLastError(ERROR_INVALID_PARAMETER);
            return FALSE;
        }
        if (reserved !== 0 && reserved !== 1) {
            this.setLastError(ERROR_INVALID_PARAMETER);
            return FALSE;
        }
        if (hServer !== 0 && hServer !== WTS_CURRENT_SERVER_HANDLE) {
            this.setLastError(ERROR_INVALID_PARAMETER);
            return FALSE;
        }

        const stationName = wide ? WTSWinStationNameValue : WTSWinStationNameValue;
        const namePtr = wide
            ? this.allocBytes((stationName.length + 1) * 2)
            : this.allocBytes(stationName.length + 1);
        if (wide) this.writeWide(namePtr, mem, stationName);
        else this.writeAnsi(namePtr, mem, stationName);

        // WTS_SESSION_INFO(A/W): SessionId, pWinStationName, State
        const entrySize = wide ? 12 : 12;
        const blockPtr = this.allocBytes(entrySize);
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(blockPtr, 0, true); // SessionId
        view.setUint32(blockPtr + 4, namePtr, true);
        view.setUint32(blockPtr + 8, WTSActive, true);

        Mem.writeUint32(ppSessionInfo, blockPtr);
        Mem.writeUint32(pCount, 1);
        Logger.verbose(
            LogCategory.SYSTEM,
            `wtsapi32:WTSEnumerateSessions${wide ? "W" : "A"}(ver=${version}) -> TRUE count=1`
        );
        return TRUE;
    }
}
