import { afterEach, describe, expect, test } from "bun:test";
import { createDeviceExports } from "../../src/worker/modules/d3d9/device";
import { devices, resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";
import { surfaceMeta } from "../../src/worker/modules/d3d9/resource-registry";

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

afterEach(() => {
  devices.clear();
  resourceToDevice.clear();
  surfaceMeta.clear();
});

describe("IDirect3DDevice9 cursor API", () => {
  test("validates and forwards a level-zero A8R8G8B8 surface", () => {
    const exports = createDeviceExports();
    const calls: unknown[][] = [];
    const device = {
      setCursorProperties: (...args: unknown[]) => { calls.push(args); return true; },
    };
    devices.set(0x100, device as any);
    resourceToDevice.set(0x200, device as any);
    surfaceMeta.set(0x200, {
      format: 21, type: 1, usage: 0, pool: 1,
      multiSampleType: 0, multiSampleQuality: 0,
      width: 32, height: 32, texturePtr: 0x300, level: 0,
    });

    expect(exports.IDirect3DDevice9_SetCursorProperties!(null as any, new Uint8Array(), [0x100, 4, 5, 0x200]))
      .toBe(D3D_OK);
    expect(calls).toEqual([[4, 5, 0x300, 0, 21]]);
  });

  test("rejects foreign, multisampled and non-texture-backed surfaces", () => {
    const exports = createDeviceExports();
    const device = { setCursorProperties: () => true };
    devices.set(0x100, device as any);
    surfaceMeta.set(0x200, {
      format: 21, type: 1, usage: 0, pool: 1,
      multiSampleType: 1, multiSampleQuality: 0,
      width: 32, height: 32, texturePtr: 0x300, level: 0,
    });
    resourceToDevice.set(0x200, device as any);
    expect(exports.IDirect3DDevice9_SetCursorProperties!(null as any, new Uint8Array(), [0x100, 0, 0, 0x200]))
      .toBe(D3DERR_INVALIDCALL);

    surfaceMeta.set(0x200, {
      format: 21, type: 1, usage: 0, pool: 1,
      multiSampleType: 0, multiSampleQuality: 0,
      width: 32, height: 32,
    });
    expect(exports.IDirect3DDevice9_SetCursorProperties!(null as any, new Uint8Array(), [0x100, 0, 0, 0x200]))
      .toBe(D3DERR_INVALIDCALL);
  });

  test("tracks position and returns previous visibility", () => {
    const exports = createDeviceExports();
    let position: number[] = [];
    let visible = false;
    const device = {
      setCursorPosition: (x: number, y: number) => { position = [x, y]; },
      showCursor: (show: boolean) => { const previous = visible; visible = show; return previous; },
    };
    devices.set(0x100, device as any);

    expect(exports.IDirect3DDevice9_SetCursorPosition!(null as any, new Uint8Array(), [0x100, -3, 700, 1]))
      .toBe(0);
    expect(position).toEqual([-3, 700]);
    expect(exports.IDirect3DDevice9_ShowCursor!(null as any, new Uint8Array(), [0x100, 1])).toBe(0);
    expect(exports.IDirect3DDevice9_ShowCursor!(null as any, new Uint8Array(), [0x100, 0])).toBe(1);
  });
});
