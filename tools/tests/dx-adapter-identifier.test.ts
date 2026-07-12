import { describe, expect, test } from 'bun:test';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import {
    D3DADAPTER_IDENTIFIER8_SIZE,
    D3DADAPTER_IDENTIFIER9_OFFSETS,
    D3DADAPTER_IDENTIFIER9_SIZE,
    DEFAULT_DEVICE_ID,
    DEFAULT_DRIVER_DLL,
    DEFAULT_VENDOR_ID,
    writeAdapterIdentifier8,
    writeAdapterIdentifier9,
} from '../../src/worker/backends/webgpu/shared/dx-adapter-identifier';

describe('dx-adapter-identifier', () => {
    test('writeAdapterIdentifier8 fills stable PCI ids', () => {
        const mem = new Uint8Array(D3DADAPTER_IDENTIFIER8_SIZE + 64);
        Mem.bind(() => mem);
        const base = 32;
        expect(writeAdapterIdentifier8(mem, base, 0)).toBe(true);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        expect(view.getUint32(base + 1032, true)).toBe(DEFAULT_VENDOR_ID);
        expect(view.getUint32(base + 1036, true)).toBe(DEFAULT_DEVICE_ID);

        const driver = new TextDecoder().decode(mem.subarray(base, base + 512));
        expect(driver.startsWith(DEFAULT_DRIVER_DLL)).toBe(true);
    });

    test('writeAdapterIdentifier9 matches D3D9 layout offsets', () => {
        const mem = new Uint8Array(D3DADAPTER_IDENTIFIER9_SIZE + 64);
        Mem.bind(() => mem);
        const base = 16;
        expect(writeAdapterIdentifier9(mem, base, 0)).toBe(true);

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        expect(view.getUint32(base + D3DADAPTER_IDENTIFIER9_OFFSETS.VendorId, true)).toBe(DEFAULT_VENDOR_ID);
        expect(view.getUint32(base + D3DADAPTER_IDENTIFIER9_OFFSETS.DeviceId, true)).toBe(DEFAULT_DEVICE_ID);
    });
});
