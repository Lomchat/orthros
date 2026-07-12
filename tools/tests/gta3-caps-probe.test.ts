import { describe, expect, test } from "bun:test";
import {
    checkDxDeviceFormat,
    D3D_OK,
    D3DERR_NOTAVAILABLE,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";

/** Windows bake from c:\Share\gta3\data\CAPS.DAT after RTX 3090 conversion. */
export const GTA3_WINDOWS_CAPS_DWORDS = [0x500, 0x600, 0x100, 0x500] as const;

const D3DDEVTYPE_HAL = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_A1R5G5B5 = 25;

function probe(adapterFormat: number, checkFormat: number): boolean {
    return (
        checkDxDeviceFormat(8, 0, D3DDEVTYPE_HAL, adapterFormat, 0, D3DRTYPE_TEXTURE, checkFormat) ===
        D3D_OK
    );
}

describe("GTA III CAPS.DAT probe (D3D8 CheckDeviceFormat)", () => {
    test("32-bit adapter accepts formats behind Windows bake DWORDs", () => {
        expect(probe(D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8)).toBe(true); // slot0 0x500
        expect(probe(D3DFMT_X8R8G8B8, D3DFMT_X8R8G8B8)).toBe(true); // slot1 0x600
        expect(probe(D3DFMT_X8R8G8B8, D3DFMT_A1R5G5B5)).toBe(true); // slot2 0x100 (1555)
    });

    test("16-bit R5G6B5 adapter accepts 32-bit textures (HLE + PoP SoT detection)", () => {
        expect(probe(D3DFMT_R5G6B5, D3DFMT_X8R8G8B8)).toBe(true);
        expect(probe(D3DFMT_R5G6B5, D3DFMT_A8R8G8B8)).toBe(true);
        expect(
            checkDxDeviceFormat(
                8,
                0,
                D3DDEVTYPE_HAL,
                D3DFMT_R5G6B5,
                0,
                D3DRTYPE_TEXTURE,
                D3DFMT_X8R8G8B8,
            ),
        ).toBe(D3D_OK);
    });
});
