/**
 * SETUPAPI.dll — minimal device enumeration for hardware-ID / PnP query paths.
 *
 * Presents one stable virtual root devnode plus a single present device so games
 * that walk SetupDi and CM APIs get deterministic, non-host-leaking results.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";
import { System } from "../core/system";
import { encodeAnsi } from "./codepage-utils";

const TRUE = 1;
const FALSE = 0;

const INVALID_HANDLE_VALUE = 0xffffffff;

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_MORE_ITEMS = 259;

const CR_SUCCESS = 0;
const CR_INVALID_DEVINST = 6;
const CR_NO_SUCH_DEVINST = 13;
const CR_BUFFER_SMALL = 26;

const SP_DEVINFO_DATA_SIZE = 28;
const SP_DEVICE_INTERFACE_DATA_SIZE = 28;

const ROOT_DEVINST = 0;
const VIRTUAL_DEVINST = 1;

// DEVCLASS_SYSTEM {4d36e97d-e325-11ce-bfc1-08002be10318}
const SYSTEM_CLASS_GUID = {
    d1: 0x4d36e97d,
    d2: 0xe325,
    d3: 0x11ce,
    d4: [0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18] as const,
};

const VIRTUAL_DEVICE_ID = "ROOT\\LEGACY_BOTTLESHIP\\0000";
const VIRTUAL_HARDWARE_ID = "ROOT\\LEGACY_BOTTLESHIP\\0000";
const VIRTUAL_DEVICE_DESC = "BottleShip Virtual Device";
const VIRTUAL_MFG = "BottleShip";

const SPDRP_DEVICEDESC = 0x00000000;
const SPDRP_HARDWAREID = 0x00000001;
const SPDRP_COMPATIBLEIDS = 0x00000002;
const SPDRP_CLASS = 0x00000007;
const SPDRP_CLASSGUID = 0x00000008;
const SPDRP_MFG = 0x0000000b;

const REG_SZ = 1;
const REG_MULTI_SZ = 7;

type DeviceInfoSet = {
    deviceCount: number;
};

function setLastError(code: number): void {
    System.getInstance().scheduler.setLastError(code);
}

function readAsciiZ(ptr: number, maxChars = 512): string {
    if (!ptr) return "";
    const out: number[] = [];
    let addr = ptr;
    while (out.length < maxChars) {
        const ch = Mem.readUint8(addr);
        if (ch == null || ch === 0) break;
        out.push(ch);
        addr++;
    }
    return String.fromCharCode(...out);
}

function writeGuid(ptr: number, guid: typeof SYSTEM_CLASS_GUID): boolean {
    if (!Mem.writeUint32(ptr, guid.d1)) return false;
    if (!Mem.writeUint16(ptr + 4, guid.d2)) return false;
    if (!Mem.writeUint16(ptr + 6, guid.d3)) return false;
    for (let i = 0; i < guid.d4.length; i++) {
        if (!Mem.writeUint8(ptr + 8 + i, guid.d4[i]!)) return false;
    }
    return true;
}

function writeDevInfoData(ptr: number, devInst: number): boolean {
    const cbSize = Mem.readUint32(ptr) ?? 0;
    if (cbSize !== SP_DEVINFO_DATA_SIZE) {
        setLastError(ERROR_INVALID_PARAMETER);
        return false;
    }
    if (!writeGuid(ptr + 4, SYSTEM_CLASS_GUID)) return false;
    if (!Mem.writeUint32(ptr + 20, devInst)) return false;
    if (!Mem.writeUint32(ptr + 24, 0)) return false;
    return true;
}

/** UTF-16LE encode (no BOM). */
function encodeWide(str: string): Uint8Array {
    const out = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        out[i * 2] = c & 0xff;
        out[i * 2 + 1] = (c >> 8) & 0xff;
    }
    return out;
}

function writeStringProperty(buffer: number, bufferSize: number, requiredSizePtr: number, value: string, wide: boolean): boolean {
    const bytes = wide ? encodeWide(value + "\0") : encodeAnsi(value + "\0");
    if (requiredSizePtr) Mem.writeUint32(requiredSizePtr, bytes.length);
    if (bufferSize < bytes.length) {
        setLastError(ERROR_INSUFFICIENT_BUFFER);
        return false;
    }
    if (buffer) Mem.writeBytes(buffer, bytes);
    return true;
}

function writeMultiSzProperty(buffer: number, bufferSize: number, requiredSizePtr: number, values: string[], wide: boolean): boolean {
    const parts: number[] = [];
    for (const value of values) {
        const enc = wide ? encodeWide(value) : encodeAnsi(value);
        parts.push(...enc);
        if (wide) parts.push(0, 0); else parts.push(0);
    }
    if (wide) parts.push(0, 0); else parts.push(0);
    const bytes = new Uint8Array(parts);
    if (requiredSizePtr) Mem.writeUint32(requiredSizePtr, bytes.length);
    if (bufferSize < bytes.length) {
        setLastError(ERROR_INSUFFICIENT_BUFFER);
        return false;
    }
    if (buffer) Mem.writeBytes(buffer, bytes);
    return true;
}

function resolveDevInstFromDeviceInfoSet(set: DeviceInfoSet | undefined, memberIndex: number): number | null {
    if (!set || memberIndex >= set.deviceCount) return null;
    return VIRTUAL_DEVINST;
}

function resolveDevInstById(deviceId: string): number | null {
    if (deviceId.length === 0) return ROOT_DEVINST;
    if (deviceId.toUpperCase() === VIRTUAL_DEVICE_ID.toUpperCase()) return VIRTUAL_DEVINST;
    return null;
}

function devInstToDeviceId(devInst: number): string | null {
    if (devInst === ROOT_DEVINST) return "";
    if (devInst === VIRTUAL_DEVINST) return VIRTUAL_DEVICE_ID;
    return null;
}

export class Setupapi implements IModule {
    name = "setupapi";
    exports: Record<string, ThunkImplementation> = {};

    private nextHandle = 0x00050000;
    private deviceInfoSets = new Map<number, DeviceInfoSet>();

    initialize(_process: Process): void {
        this.exports["SetupDiGetClassDevsA"] = (_ctx, _mem, args) => {
            const handle = this.nextHandle++;
            this.deviceInfoSets.set(handle, { deviceCount: 1 });
            return handle;
        };

        this.exports["SetupDiGetClassDevsW"] = (ctx, mem, args) =>
            this.exports["SetupDiGetClassDevsA"]!(ctx, mem, args);

        this.exports["SetupDiDestroyDeviceInfoList"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            if (!this.deviceInfoSets.delete(handle)) {
                setLastError(ERROR_INVALID_HANDLE);
                return FALSE;
            }
            return TRUE;
        };

        this.exports["SetupDiEnumDeviceInfo"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const memberIndex = args[1] >>> 0;
            const deviceInfoData = args[2] >>> 0;
            const set = this.deviceInfoSets.get(handle);
            if (!set) {
                setLastError(ERROR_INVALID_HANDLE);
                return FALSE;
            }
            if (!deviceInfoData) {
                setLastError(ERROR_INVALID_PARAMETER);
                return FALSE;
            }
            const devInst = resolveDevInstFromDeviceInfoSet(set, memberIndex);
            if (devInst === null) {
                setLastError(ERROR_NO_MORE_ITEMS);
                return FALSE;
            }
            if (!writeDevInfoData(deviceInfoData, devInst)) return FALSE;
            return TRUE;
        };

        this.exports["SetupDiEnumDeviceInterfaces"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            const memberIndex = args[3] >>> 0;
            const deviceInterfaceData = args[4] >>> 0;
            if (!this.deviceInfoSets.has(handle)) {
                setLastError(ERROR_INVALID_HANDLE);
                return FALSE;
            }
            if (!deviceInterfaceData) {
                setLastError(ERROR_INVALID_PARAMETER);
                return FALSE;
            }
            const cbSize = Mem.readUint32(deviceInterfaceData) ?? 0;
            if (cbSize !== SP_DEVICE_INTERFACE_DATA_SIZE) {
                setLastError(ERROR_INVALID_PARAMETER);
                return FALSE;
            }
            if (memberIndex > 0) {
                setLastError(ERROR_NO_MORE_ITEMS);
                return FALSE;
            }
            setLastError(ERROR_NO_MORE_ITEMS);
            return FALSE;
        };

        this.exports["SetupDiGetDeviceInterfaceDetailA"] = (_ctx, _mem, args) => {
            const handle = args[0] >>> 0;
            if (!this.deviceInfoSets.has(handle)) {
                setLastError(ERROR_INVALID_HANDLE);
                return FALSE;
            }
            setLastError(ERROR_NO_MORE_ITEMS);
            return FALSE;
        };

        this.exports["SetupDiGetDeviceInterfaceDetailW"] = (ctx, mem, args) =>
            this.exports["SetupDiGetDeviceInterfaceDetailA"]!(ctx, mem, args);

        const getDeviceRegistryProperty = (args: number[], wide: boolean): number => {
            const handle = args[0] >>> 0;
            const deviceInfoData = args[1] >>> 0;
            const property = args[2] >>> 0;
            const propertyRegDataType = args[3] >>> 0;
            const propertyBuffer = args[4] >>> 0;
            const propertyBufferSize = args[5] >>> 0;
            const requiredSize = args[6] >>> 0;

            if (!this.deviceInfoSets.has(handle) || !deviceInfoData) {
                setLastError(ERROR_INVALID_PARAMETER);
                return FALSE;
            }
            const cbSize = Mem.readUint32(deviceInfoData) ?? 0;
            if (cbSize !== SP_DEVINFO_DATA_SIZE) {
                setLastError(ERROR_INVALID_PARAMETER);
                return FALSE;
            }
            const devInst = Mem.readUint32(deviceInfoData + 20) ?? ROOT_DEVINST;
            if (devInst !== VIRTUAL_DEVINST) {
                setLastError(ERROR_NO_MORE_ITEMS);
                return FALSE;
            }

            let ok = false;
            switch (property) {
                case SPDRP_DEVICEDESC:
                    if (propertyRegDataType) Mem.writeUint32(propertyRegDataType, REG_SZ);
                    ok = writeStringProperty(propertyBuffer, propertyBufferSize, requiredSize, VIRTUAL_DEVICE_DESC, wide);
                    break;
                case SPDRP_HARDWAREID:
                    if (propertyRegDataType) Mem.writeUint32(propertyRegDataType, REG_MULTI_SZ);
                    ok = writeMultiSzProperty(propertyBuffer, propertyBufferSize, requiredSize, [VIRTUAL_HARDWARE_ID], wide);
                    break;
                case SPDRP_COMPATIBLEIDS:
                    if (propertyRegDataType) Mem.writeUint32(propertyRegDataType, REG_MULTI_SZ);
                    ok = writeMultiSzProperty(propertyBuffer, propertyBufferSize, requiredSize, [VIRTUAL_HARDWARE_ID], wide);
                    break;
                case SPDRP_CLASS:
                    if (propertyRegDataType) Mem.writeUint32(propertyRegDataType, REG_SZ);
                    ok = writeStringProperty(propertyBuffer, propertyBufferSize, requiredSize, "System", wide);
                    break;
                case SPDRP_CLASSGUID:
                    if (propertyRegDataType) Mem.writeUint32(propertyRegDataType, REG_SZ);
                    ok = writeStringProperty(
                        propertyBuffer,
                        propertyBufferSize,
                        requiredSize,
                        "{4d36e97d-e325-11ce-bfc1-08002be10318}",
                        wide,
                    );
                    break;
                case SPDRP_MFG:
                    if (propertyRegDataType) Mem.writeUint32(propertyRegDataType, REG_SZ);
                    ok = writeStringProperty(propertyBuffer, propertyBufferSize, requiredSize, VIRTUAL_MFG, wide);
                    break;
                default:
                    setLastError(ERROR_NO_MORE_ITEMS);
                    return FALSE;
            }
            return ok ? TRUE : FALSE;
        };

        this.exports["SetupDiGetDeviceRegistryPropertyA"] = (_ctx, _mem, args) =>
            getDeviceRegistryProperty(args, false);

        this.exports["SetupDiGetDeviceRegistryPropertyW"] = (_ctx, _mem, args) =>
            getDeviceRegistryProperty(args, true);

        this.exports["CM_Locate_DevNodeA"] = (_ctx, _mem, args) => {
            const pdnDevInst = args[0] >>> 0;
            const pDeviceId = args[1] >>> 0;
            if (!pdnDevInst) return CR_INVALID_DEVINST;
            const deviceId = pDeviceId ? readAsciiZ(pDeviceId) : "";
            const devInst = resolveDevInstById(deviceId);
            if (devInst === null) return CR_NO_SUCH_DEVINST;
            Mem.writeUint32(pdnDevInst, devInst);
            return CR_SUCCESS;
        };

        this.exports["CM_Locate_DevNodeW"] = (ctx, mem, args) =>
            this.exports["CM_Locate_DevNodeA"]!(ctx, mem, args);

        const getDeviceId = (args: number[], wide: boolean): number => {
            const dnDevInst = args[0] >>> 0;
            const buffer = args[1] >>> 0;
            const bufferLen = args[2] >>> 0; // ulLength is in CHARACTERS
            const deviceId = devInstToDeviceId(dnDevInst);
            if (deviceId === null) return CR_NO_SUCH_DEVINST;
            const chars = deviceId.length + 1; // + NUL
            if (bufferLen < chars) return CR_BUFFER_SMALL;
            const bytes = wide ? encodeWide(deviceId + "\0") : encodeAnsi(deviceId + "\0");
            if (buffer) Mem.writeBytes(buffer, bytes);
            return CR_SUCCESS;
        };

        this.exports["CM_Get_Device_IDA"] = (_ctx, _mem, args) => getDeviceId(args, false);

        this.exports["CM_Get_Device_IDW"] = (_ctx, _mem, args) => getDeviceId(args, true);

        this.exports["CM_Get_Parent"] = (_ctx, _mem, args) => {
            const pdnDevInst = args[0] >>> 0;
            const dnDevInst = args[1] >>> 0;
            if (!pdnDevInst) return CR_INVALID_DEVINST;
            if (dnDevInst === ROOT_DEVINST) return CR_NO_SUCH_DEVINST;
            if (dnDevInst === VIRTUAL_DEVINST) {
                Mem.writeUint32(pdnDevInst, ROOT_DEVINST);
                return CR_SUCCESS;
            }
            return CR_NO_SUCH_DEVINST;
        };
    }

    reset(): void {
        this.nextHandle = 0x00050000;
        this.deviceInfoSets.clear();
    }
}
