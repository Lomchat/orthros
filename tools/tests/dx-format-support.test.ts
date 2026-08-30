import { describe, expect, test } from "bun:test";
import {
    adapterBppDepth,
    checkDxDeviceFormat,
    D3D_OK,
    D3DERR_NOTAVAILABLE,
    getDxCompressedTextureNegotiationStats,
    isDxTextureFormatCompatibleWithAdapter,
    setDxCompressedTextureAdvertisement,
    textureBppDepth,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";

const D3DDEVTYPE_HAL = 1;
const D3DRTYPE_TEXTURE = 3;

const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_A1R5G5B5 = 25;
const D3DFMT_P8 = 41;
const D3DFMT_DXT1 = 0x31545844;

describe("adapterBppDepth / textureBppDepth", () => {
    test("known display formats", () => {
        expect(adapterBppDepth(D3DFMT_R5G6B5, 8)).toBe(16);
        expect(adapterBppDepth(D3DFMT_X8R8G8B8, 8)).toBe(32);
        expect(adapterBppDepth(0xdeadbeef, 8)).toBeNull();
    });

    test("texture bpp classes", () => {
        expect(textureBppDepth(D3DFMT_X8R8G8B8)).toBe(32);
        expect(textureBppDepth(D3DFMT_R5G6B5)).toBe(16);
        expect(textureBppDepth(D3DFMT_P8)).toBe(8);
    });
});

describe("isDxTextureFormatCompatibleWithAdapter", () => {
    test("HLE accepts cross-bpp combinations (PoP SoT R5G6B5 adapter probes)", () => {
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_R5G6B5, D3DFMT_X8R8G8B8, 8)).toBe(true);
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_R5G6B5, D3DFMT_A8R8G8B8, 8)).toBe(true);
    });

    test("same-bpp and P8 ok on 16-bit adapter", () => {
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8, 8)).toBe(true);
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_R5G6B5, D3DFMT_A1R5G5B5, 8)).toBe(true);
        expect(isDxTextureFormatCompatibleWithAdapter(D3DFMT_R5G6B5, D3DFMT_P8, 8)).toBe(true);
    });

    test("unknown adapter stays permissive (Morrowind probe)", () => {
        expect(isDxTextureFormatCompatibleWithAdapter(0x12345678, D3DFMT_A8R8G8B8, 8)).toBe(true);
    });
});

describe("checkDxDeviceFormat adapter gating", () => {
    test("GTA III CAPS path: 32-bit adapter accepts 888/8888", () => {
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3D_OK);
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_X8R8G8B8),
        ).toBe(D3D_OK);
    });

    test("16-bit adapter accepts 32-bit textures (PoP SoT CheckDeviceFormat matrix)", () => {
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_X8R8G8B8),
        ).toBe(D3D_OK);
        expect(
            checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0x1, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3D_OK);
    });

    test("garbage adapter format stays permissive", () => {
        expect(
            checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, 0xcafebabe, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8),
        ).toBe(D3D_OK);
    });
});

describe("compressed texture capability policy", () => {
    test("can hide negotiated DXT support without rejecting direct resource creation", () => {
        setDxCompressedTextureAdvertisement(true);
        getDxCompressedTextureNegotiationStats(true);
        expect(
            checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_DXT1),
        ).toBe(D3D_OK);

        setDxCompressedTextureAdvertisement(false);
        expect(
            checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_DXT1),
        ).toBe(D3DERR_NOTAVAILABLE);
        expect(getDxCompressedTextureNegotiationStats(false)).toEqual({
            advertised: false,
            probes: 2,
            rejected: 1,
        });

        // Restore the production default for the rest of the process suite.
        setDxCompressedTextureAdvertisement(true);
        getDxCompressedTextureNegotiationStats(true);
    });
});
