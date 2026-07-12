import { describe, expect, test } from "bun:test";
import {
    decodeD3d9Sampler,
    D3DSAMP_ADDRESSU, D3DSAMP_ADDRESSV, D3DSAMP_ADDRESSW,
    D3DSAMP_MAGFILTER, D3DSAMP_MINFILTER, D3DSAMP_MIPFILTER,
    D3DSAMP_MAXMIPLEVEL, D3DSAMP_MAXANISOTROPY,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-sampler";

// Build a getter from a sparse state map (unset → 0, the D3D9 default).
const getter = (m: Record<number, number>) => (type: number) => m[type] ?? 0;

describe("decodeD3d9Sampler — D3D9 defaults", () => {
    test("unset state resolves to the faithful D3D9 defaults (POINT min/mag, NONE mip, WRAP address)", () => {
        const s = decodeD3d9Sampler(getter({}));
        expect(s.min).toBe("nearest");   // D3DSAMP_MINFILTER default = D3DTEXF_POINT
        expect(s.mag).toBe("nearest");   // D3DSAMP_MAGFILTER default = D3DTEXF_POINT
        expect(s.mipNone).toBe(true);    // D3DSAMP_MIPFILTER default = D3DTEXF_NONE
        expect(s.addressU).toBe("repeat"); // D3DTADDRESS_WRAP default — NOT clamp
        expect(s.addressV).toBe("repeat");
        expect(s.gameAnisotropy).toBe(1);
    });
});

describe("decodeD3d9Sampler — explicit state", () => {
    test("linear min/mag + linear mip + mirror/clamp addresses", () => {
        const s = decodeD3d9Sampler(getter({
            [D3DSAMP_MINFILTER]: 2, // LINEAR
            [D3DSAMP_MAGFILTER]: 2, // LINEAR
            [D3DSAMP_MIPFILTER]: 2, // LINEAR
            [D3DSAMP_ADDRESSU]: 2,  // MIRROR
            [D3DSAMP_ADDRESSV]: 3,  // CLAMP
            [D3DSAMP_ADDRESSW]: 1,  // WRAP
        }));
        expect(s.min).toBe("linear");
        expect(s.mag).toBe("linear");
        expect(s.mip).toBe("linear");
        expect(s.mipNone).toBe(false);
        expect(s.addressU).toBe("mirror-repeat");
        expect(s.addressV).toBe("clamp-to-edge");
        expect(s.addressW).toBe("repeat");
    });

    test("point min/mag preserved (pixel-art must not be forced linear)", () => {
        const s = decodeD3d9Sampler(getter({ [D3DSAMP_MINFILTER]: 1, [D3DSAMP_MAGFILTER]: 1, [D3DSAMP_MIPFILTER]: 1 }));
        expect(s.min).toBe("nearest");
        expect(s.mag).toBe("nearest");
        expect(s.mip).toBe("nearest");
        expect(s.mipNone).toBe(false); // POINT mip filter, not NONE
    });

    test("anisotropic min/mag sets gameAnisotropy from MAXANISOTROPY", () => {
        const s = decodeD3d9Sampler(getter({
            [D3DSAMP_MINFILTER]: 3, // ANISOTROPIC
            [D3DSAMP_MAGFILTER]: 2, // LINEAR
            [D3DSAMP_MAXANISOTROPY]: 8,
        }));
        expect(s.min).toBe("linear"); // anisotropic decodes to linear; aniso carried separately
        expect(s.gameAnisotropy).toBe(8);
    });

    test("MAXMIPLEVEL is carried through", () => {
        const s = decodeD3d9Sampler(getter({ [D3DSAMP_MAXMIPLEVEL]: 4 }));
        expect(s.maxMipLevel).toBe(4);
    });
});
