/**
 * kernel32 drive/volume/DOS-device query handlers (GetLogicalDrives, GetDriveType,
 * GetDiskFreeSpace[Ex], QueryDosDevice, GetVolumeInformation). All values are
 * the emulator's stable fake volume geometry — no mutable state.
 */
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { encodeAnsi } from '../codepage-utils';
import { readStringA, readStringW, encodeUTF16LE } from './file-io-strings';

const ERROR_PATH_NOT_FOUND = 3;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_NAME = 123;
const ERROR_MORE_DATA = 234;

// Drive type constants
const DRIVE_UNKNOWN = 0;
const DRIVE_NO_ROOT_DIR = 1;
const DRIVE_REMOVABLE = 2;
const DRIVE_FIXED = 3;
const DRIVE_REMOTE = 4;
const DRIVE_CDROM = 5;
const DRIVE_RAMDISK = 6;

const FILE_CASE_SENSITIVE_SEARCH = 0x00000001;
const FILE_CASE_PRESERVED_NAMES = 0x00000002;
const FILE_UNICODE_ON_DISK = 0x00000004;
const FILE_SUPPORTS_LONG_NAMES = 0x00000040;
const FILE_READ_ONLY_VOLUME = 0x00080000;

const DOS_DEVICE_TARGETS: Record<string, string> = {
    AUX: "\\Device\\Serial0",
    CON: "\\Device\\ConDrv\\Console",
    NUL: "\\Device\\Null",
    PRN: "\\Device\\Parallel0",
    "C:": "\\Device\\HarddiskVolume1",
    "D:": "\\Device\\CdRom0",
};

const ENUMERATED_DOS_DEVICES = ["AUX", "CON", "NUL", "PRN", "C:", "D:"];

const resolveDosDeviceTarget = (deviceName: string): string | null => {
    const trimmed = deviceName.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (DOS_DEVICE_TARGETS[upper]) return DOS_DEVICE_TARGETS[upper];
    if (/^[A-Z]:$/.test(upper)) {
        return `\\Device\\HarddiskVolume${upper.charCodeAt(0) - 64}`;
    }
    return null;
};

const writeAnsiDeviceList = (buffer: number, maxChars: number, text: string): number => {
    const required = text.length + 1;
    if (maxChars < required) {
        System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
        return required;
    }
    const data = encodeAnsi(text + "\0");
    if (Mem.writeBytes(buffer, data) !== data.length) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }
    System.getInstance().scheduler.setLastError(0);
    return text.length;
};

const writeWideDeviceList = (buffer: number, maxChars: number, text: string): number => {
    const required = text.length + 1;
    if (maxChars < required) {
        System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
        return required;
    }
    const bytes = encodeUTF16LE(text + "\0");
    if (Mem.writeBytes(buffer, bytes) !== bytes.length) {
        System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
        return 0;
    }
    System.getInstance().scheduler.setLastError(0);
    return text.length;
};

const DISK_FREE_BYTES = 262144 * 8 * 512; // 1 GiB — matches GetDiskFreeSpaceA cluster math
const DISK_TOTAL_BYTES = 524288 * 8 * 512; // 2 GiB

const writeU64 = (view: DataView, addr: number, value: number): void => {
    if (!addr) return;
    view.setUint32(addr, value >>> 0, true);
    view.setUint32(addr + 4, Math.floor(value / 0x100000000) >>> 0, true);
};

export function registerFileIoVolumeExports(exports: Record<string, ThunkImplementation>): void {
    exports['GetLogicalDrives'] = (ctx, mem, args) => {
        // Return bitmask of available drives
        // Bit 0 = A:, Bit 1 = B:, Bit 2 = C:, Bit 3 = D:, etc.
        // We report C: and D: as available
        const drives = 0x0C; // C: (bit 2) + D: (bit 3)
        Logger.verbose(LogCategory.KERNEL32, `GetLogicalDrives() -> 0x${drives.toString(16)}`);
        return drives;
    };

    // GetLogicalDriveStringsA - returns MULTI_SZ list like "C:\\\0D:\\\0\0"
    exports['GetLogicalDriveStringsA'] = (ctx, mem, args) => {
        const nBufferLength = args[0] >>> 0; // chars
        const lpBuffer = args[1] >>> 0;

        const driveRoots = ['C:\\', 'D:\\'];
        const multiSz = `${driveRoots.join('\0')}\0\0`;
        const requiredChars = multiSz.length; // includes final double-NUL terminator
        const successChars = requiredChars - 1; // excludes final NUL per Win32 contract

        // Probe call: caller asks for required size only.
        if (nBufferLength === 0 || lpBuffer === 0) {
            return requiredChars;
        }

        if (nBufferLength < requiredChars) {
            System.getInstance().scheduler.setLastError(ERROR_MORE_DATA);
            Logger.verbose(
                LogCategory.KERNEL32,
                `GetLogicalDriveStringsA(buffer=${nBufferLength}) -> insufficient (required=${requiredChars})`
            );
            return requiredChars;
        }

        const data = encodeAnsi(multiSz);

        if (Mem.writeBytes(lpBuffer, data) !== data.length) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        System.getInstance().scheduler.setLastError(0);
        Logger.verbose(
            LogCategory.KERNEL32,
            `GetLogicalDriveStringsA(buffer=${nBufferLength}) -> "${driveRoots.join(', ')}" (${successChars} chars)`
        );
        return successChars;
    };

    exports['QueryDosDeviceA'] = (ctx, mem, args) => {
        const lpDeviceName = args[0] >>> 0;
        const lpTargetPath = args[1] >>> 0;
        const ucchMax = args[2] >>> 0;

        if (!lpTargetPath || ucchMax === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        if (!lpDeviceName) {
            const multiSz = `${ENUMERATED_DOS_DEVICES.join("\0")}\0\0`;
            const requiredChars = multiSz.length;
            if (ucchMax < requiredChars) {
                System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return requiredChars;
            }
            const data = encodeAnsi(multiSz);
            Mem.writeBytes(lpTargetPath, data);
            System.getInstance().scheduler.setLastError(0);
            const result = requiredChars - 1;
            Logger.verbose(LogCategory.KERNEL32, `QueryDosDeviceA(NULL) -> ${result}`);
            return result;
        }

        const deviceName = readStringA(mem, lpDeviceName, 32);
        const target = resolveDosDeviceTarget(deviceName);
        if (!target) {
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            Logger.verbose(LogCategory.KERNEL32, `QueryDosDeviceA("${deviceName}") -> NOT FOUND`);
            return 0;
        }

        const result = writeAnsiDeviceList(lpTargetPath, ucchMax, target);
        Logger.verbose(LogCategory.KERNEL32, `QueryDosDeviceA("${deviceName}") -> "${target}" (${result})`);
        return result;
    };

    exports['QueryDosDeviceW'] = (ctx, mem, args) => {
        const lpDeviceName = args[0] >>> 0;
        const lpTargetPath = args[1] >>> 0;
        const ucchMax = args[2] >>> 0;

        if (!lpTargetPath || ucchMax === 0) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        if (!lpDeviceName) {
            const multiSz = `${ENUMERATED_DOS_DEVICES.join("\0")}\0\0`;
            const requiredChars = multiSz.length;
            if (ucchMax < requiredChars) {
                System.getInstance().scheduler.setLastError(ERROR_INSUFFICIENT_BUFFER);
                return requiredChars;
            }
            const data = encodeUTF16LE(multiSz);
            Mem.writeBytes(lpTargetPath, data);
            System.getInstance().scheduler.setLastError(0);
            const result = requiredChars - 1;
            Logger.verbose(LogCategory.KERNEL32, `QueryDosDeviceW(NULL) -> ${result}`);
            return result;
        }

        const deviceName = readStringW(mem, lpDeviceName, 32);
        const target = resolveDosDeviceTarget(deviceName);
        if (!target) {
            System.getInstance().scheduler.setLastError(ERROR_FILE_NOT_FOUND);
            Logger.verbose(LogCategory.KERNEL32, `QueryDosDeviceW("${deviceName}") -> NOT FOUND`);
            return 0;
        }

        const result = writeWideDeviceList(lpTargetPath, ucchMax, target);
        Logger.verbose(LogCategory.KERNEL32, `QueryDosDeviceW("${deviceName}") -> "${target}" (${result})`);
        return result;
    };

    exports['GetDriveTypeA'] = (ctx, mem, args) => {
        const lpRootPathName = args[0];
        const rootPath = lpRootPathName ? readStringA(mem, lpRootPathName) : '';

        let driveType = DRIVE_UNKNOWN;
        const pathUpper = rootPath.toUpperCase();

        if (pathUpper.startsWith('C:') || pathUpper === 'C' || pathUpper === '') {
            driveType = DRIVE_FIXED; // C: is the main hard drive
        } else if (pathUpper.startsWith('D:') || pathUpper === 'D') {
            driveType = DRIVE_CDROM; // D: is typically CD-ROM for old games
        } else if (pathUpper.startsWith('A:') || pathUpper.startsWith('B:')) {
            driveType = DRIVE_REMOVABLE; // Floppy drives
        } else {
            driveType = DRIVE_NO_ROOT_DIR; // Unknown drive
        }

        Logger.verbose(LogCategory.KERNEL32, `GetDriveTypeA("${rootPath}") -> ${driveType}`);
        return driveType;
    };

    exports['GetDriveTypeW'] = (ctx, mem, args) => {
        const lpRootPathName = args[0];
        const rootPath = lpRootPathName ? readStringW(mem, lpRootPathName) : '';

        let driveType = DRIVE_UNKNOWN;
        const pathUpper = rootPath.toUpperCase();

        if (pathUpper.startsWith('C:') || pathUpper === 'C' || pathUpper === '') {
            driveType = DRIVE_FIXED;
        } else if (pathUpper.startsWith('D:') || pathUpper === 'D') {
            driveType = DRIVE_CDROM;
        } else if (pathUpper.startsWith('A:') || pathUpper.startsWith('B:')) {
            driveType = DRIVE_REMOVABLE;
        } else {
            driveType = DRIVE_NO_ROOT_DIR;
        }

        Logger.verbose(LogCategory.KERNEL32, `GetDriveTypeW("${rootPath}") -> ${driveType}`);
        return driveType;
    };

    exports['GetDiskFreeSpaceA'] = (ctx, mem, args) => {
        const lpRootPathName = args[0];
        const lpSectorsPerCluster = args[1];
        const lpBytesPerSector = args[2];
        const lpNumberOfFreeClusters = args[3];
        const lpTotalNumberOfClusters = args[4];

        const rootPath = lpRootPathName ? readStringA(mem, lpRootPathName) : 'C:\\';
        Logger.verbose(LogCategory.KERNEL32, `GetDiskFreeSpaceA("${rootPath}")`);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

        // Return fake disk space: 1GB free out of 2GB total
        const sectorsPerCluster = 8;
        const bytesPerSector = 512;
        const totalClusters = 524288; // 2GB / (8 * 512)
        const freeClusters = 262144;  // 1GB / (8 * 512)

        if (lpSectorsPerCluster) view.setUint32(lpSectorsPerCluster, sectorsPerCluster, true);
        if (lpBytesPerSector) view.setUint32(lpBytesPerSector, bytesPerSector, true);
        if (lpNumberOfFreeClusters) view.setUint32(lpNumberOfFreeClusters, freeClusters, true);
        if (lpTotalNumberOfClusters) view.setUint32(lpTotalNumberOfClusters, totalClusters, true);

        return 1; // TRUE
    };

    exports['GetDiskFreeSpaceExA'] = (ctx, mem, args) => {
        const lpDirectoryName = args[0];
        const lpFreeBytesAvailable = args[1];
        const lpTotalNumberOfBytes = args[2];
        const lpTotalNumberOfFreeBytes = args[3];

        const rootPath = lpDirectoryName ? readStringA(mem, lpDirectoryName) : 'C:\\';
        Logger.verbose(LogCategory.KERNEL32, `GetDiskFreeSpaceExA("${rootPath}")`);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        writeU64(view, lpFreeBytesAvailable, DISK_FREE_BYTES);
        writeU64(view, lpTotalNumberOfBytes, DISK_TOTAL_BYTES);
        writeU64(view, lpTotalNumberOfFreeBytes, DISK_FREE_BYTES);

        return 1; // TRUE
    };

    exports['GetDiskFreeSpaceExW'] = (ctx, mem, args) => {
        const lpDirectoryName = args[0];
        const lpFreeBytesAvailable = args[1];
        const lpTotalNumberOfBytes = args[2];
        const lpTotalNumberOfFreeBytes = args[3];

        const rootPath = lpDirectoryName ? readStringW(mem, lpDirectoryName) : 'C:\\';
        Logger.verbose(LogCategory.KERNEL32, `GetDiskFreeSpaceExW("${rootPath}")`);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        writeU64(view, lpFreeBytesAvailable, DISK_FREE_BYTES);
        writeU64(view, lpTotalNumberOfBytes, DISK_TOTAL_BYTES);
        writeU64(view, lpTotalNumberOfFreeBytes, DISK_FREE_BYTES);

        return 1; // TRUE
    };

    // GetVolumeInformationA - get volume metadata for a root path
    exports['GetVolumeInformationA'] = (ctx, mem, args) => {
        const lpRootPathName = args[0] >>> 0;
        const lpVolumeNameBuffer = args[1] >>> 0;
        const nVolumeNameSize = args[2] >>> 0;
        const lpVolumeSerialNumber = args[3] >>> 0;
        const lpMaximumComponentLength = args[4] >>> 0;
        const lpFileSystemFlags = args[5] >>> 0;
        const lpFileSystemNameBuffer = args[6] >>> 0;
        const nFileSystemNameSize = args[7] >>> 0;

        const rootPathRaw = lpRootPathName ? readStringA(mem, lpRootPathName) : "C:\\";
        const rootPath = rootPathRaw.trim();

        // Compatibility: many legacy titles pass relative paths here (e.g. "d2sfx.mpq").
        // Windows expects a root path, but falling back to current drive improves behavior.
        const driveMatch = rootPath.match(/^([a-zA-Z])(?::(?:\\.*)?)?$/);
        const isLikelyRelativePath = rootPath.length > 0 && !rootPath.includes(":") && !rootPath.startsWith("\\");

        let driveLetter = "C";
        if (rootPath.length === 0) {
            driveLetter = "C";
        } else if (driveMatch) {
            driveLetter = driveMatch[1]!.toUpperCase();
        } else if (isLikelyRelativePath) {
            driveLetter = "C";
            Logger.verbose(LogCategory.KERNEL32, `GetVolumeInformationA: treating relative path "${rootPathRaw}" as current drive root C:\\`);
        } else {
            Logger.warn(LogCategory.KERNEL32, `GetVolumeInformationA: invalid root path "${rootPathRaw}"`);
            System.getInstance().scheduler.setLastError(ERROR_INVALID_NAME);
            return 0; // FALSE
        }

        let volumeName = "BOTTLESHIP";
        let fileSystemName = "FAT32";
        let maxComponentLength = 255;
        let fileSystemFlags = FILE_CASE_SENSITIVE_SEARCH | FILE_CASE_PRESERVED_NAMES | FILE_UNICODE_ON_DISK | FILE_SUPPORTS_LONG_NAMES;
        let volumeSerial = 0x4A62_6840; // Stable per-emulator serial

        if (driveLetter === "D") {
            volumeName = "BOTTLESHIP_CD";
            fileSystemName = "CDFS";
            maxComponentLength = 110;
            fileSystemFlags = FILE_CASE_PRESERVED_NAMES | FILE_UNICODE_ON_DISK | FILE_READ_ONLY_VOLUME;
            volumeSerial = 0x2D44_4344; // "D-CD" style marker
        } else if (driveLetter === "A" || driveLetter === "B") {
            volumeName = "FLOPPY";
            fileSystemName = "FAT";
            maxComponentLength = 12;
            fileSystemFlags = FILE_CASE_PRESERVED_NAMES;
            volumeSerial = 0x0A0B_0001;
        } else if (driveLetter !== "C") {
            Logger.warn(LogCategory.KERNEL32, `GetVolumeInformationA: drive ${driveLetter}: not found`);
            System.getInstance().scheduler.setLastError(ERROR_PATH_NOT_FOUND);
            return 0; // FALSE
        }

        const writeCStringOut = (dest: number, cap: number, value: string): boolean => {
            if (!dest) return true;
            const encoded = encodeAnsi(value + "\0");
            if (cap === 0 || encoded.length > cap) {
                return false;
            }
            return Mem.writeBytes(dest, encoded) === encoded.length;
        };

        if (!writeCStringOut(lpVolumeNameBuffer, nVolumeNameSize, volumeName)) {
            System.getInstance().scheduler.setLastError(ERROR_MORE_DATA);
            return 0; // FALSE
        }
        if (!writeCStringOut(lpFileSystemNameBuffer, nFileSystemNameSize, fileSystemName)) {
            System.getInstance().scheduler.setLastError(ERROR_MORE_DATA);
            return 0; // FALSE
        }

        if (lpVolumeSerialNumber && !Mem.writeUint32(lpVolumeSerialNumber, volumeSerial >>> 0)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        if (lpMaximumComponentLength && !Mem.writeUint32(lpMaximumComponentLength, maxComponentLength >>> 0)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        if (lpFileSystemFlags && !Mem.writeUint32(lpFileSystemFlags, fileSystemFlags >>> 0)) {
            System.getInstance().scheduler.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }

        Logger.verbose(
            LogCategory.KERNEL32,
            `GetVolumeInformationA("${rootPath || "C:\\"}") -> volume="${volumeName}" fs="${fileSystemName}" serial=0x${volumeSerial.toString(16)}`
        );

        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };

    // GetVolumeInformationW - wide version
    exports['GetVolumeInformationW'] = (ctx, mem, args) => {
        const lpRootPathName = args[0] >>> 0;
        const lpVolumeNameBuffer = args[1] >>> 0;
        const nVolumeNameSize = args[2] >>> 0;
        const lpVolumeSerialNumber = args[3] >>> 0;
        const lpMaximumComponentLength = args[4] >>> 0;
        const lpFileSystemFlags = args[5] >>> 0;
        const lpFileSystemNameBuffer = args[6] >>> 0;
        const nFileSystemNameSize = args[7] >>> 0;

        const rootPath = lpRootPathName ? readStringW(mem, lpRootPathName) : "C:\\";
        const driveMatch = rootPath.match(/^([a-zA-Z])(?::(?:\\.*)?)?$/);
        const driveLetter = driveMatch ? driveMatch[1]!.toUpperCase() : "C";

        let volumeName = "BOTTLESHIP";
        let fileSystemName = "FAT32";
        let maxComponentLength = 255;
        let fileSystemFlags = FILE_CASE_SENSITIVE_SEARCH | FILE_CASE_PRESERVED_NAMES | FILE_UNICODE_ON_DISK | FILE_SUPPORTS_LONG_NAMES;
        let volumeSerial = 0x4A62_6840;

        if (driveLetter === "D") {
            volumeName = "BOTTLESHIP_CD";
            fileSystemName = "CDFS";
            maxComponentLength = 110;
            fileSystemFlags = FILE_CASE_PRESERVED_NAMES | FILE_UNICODE_ON_DISK | FILE_READ_ONLY_VOLUME;
            volumeSerial = 0x2D44_4344;
        }

        const writeWideOut = (dest: number, capChars: number, value: string): boolean => {
            if (!dest || !capChars) return true;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            for (let i = 0; i < Math.min(value.length, capChars - 1); i++) {
                view.setUint16(dest + i * 2, value.charCodeAt(i), true);
            }
            view.setUint16(dest + Math.min(value.length, capChars - 1) * 2, 0, true);
            return true;
        };

        writeWideOut(lpVolumeNameBuffer, nVolumeNameSize, volumeName);
        writeWideOut(lpFileSystemNameBuffer, nFileSystemNameSize, fileSystemName);

        if (lpVolumeSerialNumber) Mem.writeUint32(lpVolumeSerialNumber, volumeSerial >>> 0);
        if (lpMaximumComponentLength) Mem.writeUint32(lpMaximumComponentLength, maxComponentLength >>> 0);
        if (lpFileSystemFlags) Mem.writeUint32(lpFileSystemFlags, fileSystemFlags >>> 0);

        Logger.verbose(LogCategory.KERNEL32, `GetVolumeInformationW("${rootPath}") -> volume="${volumeName}"`);
        System.getInstance().scheduler.setLastError(0);
        return 1; // TRUE
    };
}
