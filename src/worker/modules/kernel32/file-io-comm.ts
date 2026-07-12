/**
 * kernel32 serial/communications-port + DeviceIoControl handlers (GetComm/SetComm
 * family, PurgeComm, SetupComm, GetOverlappedResult, DeviceIoControl). Games
 * almost never use serial ports — faithful stubs.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_IO_INCOMPLETE = 996;
const COMMCONFIG_SIZE = 48;

function writeStubDcb(lpDCB: number): void {
    Mem.writeUint32(lpDCB + 0, 28); // DCBlength
    Mem.writeUint32(lpDCB + 4, 9600); // BaudRate
    Mem.writeUint32(lpDCB + 8, 1); // fBinary
    Mem.writeUint16(lpDCB + 12, 0);
    Mem.writeUint16(lpDCB + 14, 0);
    Mem.writeUint16(lpDCB + 16, 0);
    Mem.writeUint8(lpDCB + 18, 8); // ByteSize
    Mem.writeUint8(lpDCB + 19, 0); // Parity
    Mem.writeUint8(lpDCB + 20, 0); // StopBits
    Mem.writeUint8(lpDCB + 21, 0);
    Mem.writeUint8(lpDCB + 22, 0);
    Mem.writeUint8(lpDCB + 23, 0);
    Mem.writeUint8(lpDCB + 24, 0);
    Mem.writeUint8(lpDCB + 25, 0);
    Mem.writeUint16(lpDCB + 26, 0);
}

export function registerFileIoCommExports(exports: Record<string, ThunkImplementation>): void {
    exports['GetCommProperties'] = (ctx, mem, args) => {
        const lpCommProp = args[1];
        if (!lpCommProp) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const size = 64;
        Mem.writeBytes(lpCommProp, new Uint8Array(size));
        Mem.writeUint32(lpCommProp, size);
        return 1;
    };

    exports['GetCommState'] = (ctx, mem, args) => {
        const lpDCB = args[1];
        if (!lpDCB) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        writeStubDcb(lpDCB);
        return 1;
    };

    exports['SetCommState'] = (ctx, mem, args) => {
        return 1;
    };

    exports['SetCommTimeouts'] = (ctx, mem, args) => {
        return 1;
    };

    exports['GetCommModemStatus'] = (ctx, mem, args) => {
        const lpModemStat = args[1];
        if (lpModemStat) {
            Mem.writeUint32(lpModemStat, 0);
        }
        return 1;
    };

    exports['EscapeCommFunction'] = (ctx, mem, args) => {
        return 1;
    };

    exports['PurgeComm'] = (ctx, mem, args) => {
        return 1;
    };

    exports['SetCommBreak'] = (ctx, mem, args) => {
        return 1;
    };

    exports['ClearCommBreak'] = (ctx, mem, args) => {
        return 1;
    };

    // BOOL ClearCommError(HANDLE hFile, LPDWORD lpErrors, LPCOMSTAT lpStat)
    exports['ClearCommError'] = (ctx, mem, args) => {
        const lpErrors = args[1];
        const lpStat = args[2];
        if (lpErrors) Mem.writeUint32(lpErrors, 0);
        if (lpStat) {
            // Zero out COMSTAT (28 bytes)
            for (let i = 0; i < 28; i += 4) {
                Mem.writeUint32(lpStat + i, 0);
            }
        }
        return 1;
    };

    // BOOL SetupComm(HANDLE hFile, DWORD dwInQueue, DWORD dwOutQueue)
    exports['SetupComm'] = (ctx, mem, args) => {
        return 1;
    };

    // BOOL GetCommMask(HANDLE hFile, LPDWORD lpEvtMask)
    exports['GetCommMask'] = (ctx, mem, args) => {
        const lpEvtMask = args[1];
        if (lpEvtMask) Mem.writeUint32(lpEvtMask, 0);
        return 1;
    };

    // BOOL GetCommConfig(HANDLE, LPCOMMCONFIG lpCC, LPDWORD lpdwSize)
    exports['GetCommConfig'] = (ctx, mem, args) => {
        const lpCC = args[1];
        const lpdwSize = args[2];
        if (!lpdwSize) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        Mem.writeUint32(lpdwSize, COMMCONFIG_SIZE);
        if (!lpCC) {
            return 1;
        }
        Mem.writeUint32(lpCC, COMMCONFIG_SIZE);
        Mem.writeUint16(lpCC + 4, 1); // wVersion
        Mem.writeUint16(lpCC + 6, 0); // wReserved
        writeStubDcb(lpCC + 8);
        Mem.writeUint32(lpCC + 36, 0); // dwProviderSubType
        Mem.writeUint32(lpCC + 40, 0); // dwProviderOffset
        Mem.writeUint32(lpCC + 44, 0); // dwProviderSize
        return 1;
    };

    // BOOL SetCommConfig(HANDLE, LPCOMMCONFIG lpCC, DWORD dwSize)
    exports['SetCommConfig'] = () => 1;

    // BOOL WaitCommEvent(HANDLE, LPDWORD lpEvtMask, LPOVERLAPPED lpOverlapped)
    exports['WaitCommEvent'] = (ctx, mem, args) => {
        const lpEvtMask = args[1];
        const lpOverlapped = args[2];
        if (lpEvtMask) Mem.writeUint32(lpEvtMask, 0);
        if (lpOverlapped && lpOverlapped + 20 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpOverlapped, 0, true); // Internal = completed
            view.setUint32(lpOverlapped + 4, 0, true); // InternalHigh
        }
        return 1;
    };

    exports['GetOverlappedResult'] = (ctx, mem, args) => {
        const hFile = args[0];
        const lpOverlapped = args[1];
        const lpNumberOfBytesTransferred = args[2];
        const bWait = args[3];

        if (lpOverlapped && lpOverlapped + 20 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const status = view.getUint32(lpOverlapped, true);       // Internal
            const bytesTransferred = view.getUint32(lpOverlapped + 4, true); // InternalHigh

            // If operation is still pending (Internal == STATUS_PENDING = 0x103) and bWait, wait on hEvent
            if (status === 0x103 && bWait) {
                const hEvent = view.getUint32(lpOverlapped + 16, true);
                if (hEvent) {
                    // For now, just report it — our ReadFile completes synchronously so this shouldn't happen
                    Logger.warn(LogCategory.KERNEL32,
                        `GetOverlappedResult: pending I/O with bWait=1, hEvent=0x${hEvent.toString(16)}`);
                }
            }

            if (lpNumberOfBytesTransferred) {
                Mem.writeUint32(lpNumberOfBytesTransferred, bytesTransferred);
            }

            // Return TRUE if completed successfully (Internal == 0)
            if (status === 0) {
                return 1;
            }
            // Still pending
            if (status === 0x103) {
                System.getInstance().scheduler.setLastError(996); // ERROR_IO_INCOMPLETE
                return 0;
            }
            // Error
            System.getInstance().scheduler.setLastError(status);
            return 0;
        }

        // No OVERLAPPED pointer - just succeed
        if (lpNumberOfBytesTransferred) {
            Mem.writeUint32(lpNumberOfBytesTransferred, 0);
        }
        return 1;
    };

    // BOOL DeviceIoControl(HANDLE, DWORD dwIoControlCode, LPVOID lpInBuffer, DWORD nInBufferSize,
    //   LPVOID lpOutBuffer, DWORD nOutBufferSize, LPDWORD lpBytesReturned, LPOVERLAPPED)
    exports['DeviceIoControl'] = (ctx, mem, args) => {
        const dwIoControlCode = args[1];
        const lpBytesReturned = args[6];
        Logger.warn(LogCategory.KERNEL32,
            `DeviceIoControl: ioctl=0x${dwIoControlCode.toString(16)} — stub`);
        if (lpBytesReturned) Mem.writeUint32(lpBytesReturned, 0);
        // Return FALSE with ERROR_INVALID_FUNCTION — device not supported
        System.getInstance().scheduler.setLastError(1); // ERROR_INVALID_FUNCTION
        return 0;
    };
}
