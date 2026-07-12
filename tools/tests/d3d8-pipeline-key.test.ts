/**
 * D3D8 programmable pipeline cache key tests.
 */
import { describe, expect, test } from "bun:test";
import { buildD3D8PipelineKey } from "../../src/worker/backends/webgpu/d3d8/d3d8-shader-registry";
import { computeBlendKey } from "../../src/worker/backends/webgpu/d3d9/d3d9-blend";

describe("d3d8-pipeline-key", () => {
    test("different cull modes produce different keys", () => {
        const rs1 = new Int32Array(256);
        const rs2 = new Int32Array(256);
        rs1[22] = 2; // D3DRENDERSTATE_CULLMODE — CW
        rs2[22] = 3; // CCW
        const blend = computeBlendKey((s) => rs1[s] ?? 0);
        const k1 = buildD3D8PipelineKey(rs1, 1, 0, 32, 32, "triangle-list", false, blend, "a0", 0);
        const k2 = buildD3D8PipelineKey(rs2, 1, 0, 32, 32, "triangle-list", false, blend, "a0", 0);
        expect(k1).not.toBe(k2);
    });

    test("alpha test change produces different keys", () => {
        const rs = new Int32Array(256);
        const blend = computeBlendKey((s) => rs[s] ?? 0);
        const k1 = buildD3D8PipelineKey(rs, 1, 3, 32, 32, "triangle-list", false, blend, "a0", 0);
        const k2 = buildD3D8PipelineKey(rs, 1, 3, 32, 32, "triangle-list", false, blend, "a3.128", 0);
        expect(k1).not.toBe(k2);
    });

    test("multi-stream stride key is distinct from single-stream", () => {
        const rs = new Int32Array(256);
        const blend = computeBlendKey((s) => rs[s] ?? 0);
        const single = buildD3D8PipelineKey(rs, 1, 0, 24, "24", "triangle-list", false, blend, "a0", 0);
        const multi = buildD3D8PipelineKey(rs, 1, 0, 24, "24|8", "triangle-list", false, blend, "a0", 0);
        expect(single).not.toBe(multi);
        // Numeric and string forms of the same single-stream stride serialize identically.
        expect(buildD3D8PipelineKey(rs, 1, 0, 24, 24, "triangle-list", false, blend, "a0", 0)).toBe(single);
    });

    test("identical state produces identical keys", () => {
        const rs = new Int32Array(256);
        rs[7] = 1;  // D3DRENDERSTATE_ZENABLE
        rs[14] = 1; // D3DRENDERSTATE_ZWRITEENABLE
        rs[22] = 3; // D3DRENDERSTATE_CULLMODE
        const blend = computeBlendKey((s) => rs[s] ?? 0);
        const k1 = buildD3D8PipelineKey(rs, 5, 7, 36, 36, "triangle-list", false, blend, "a0", 0);
        const k2 = buildD3D8PipelineKey(rs, 5, 7, 36, 36, "triangle-list", false, blend, "a0", 0);
        expect(k1).toBe(k2);
    });
});
