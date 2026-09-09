import { describe, expect, test } from "bun:test";
import { startCapture, recordRawDraw, onFrameEnd, isCapturing } from "../../src/worker/modules/ddraw/frame-capture";

describe("frame capture starts at a frame boundary", () => {
    test("draws of the frame in progress when arming are not recorded; the next whole frame is", async () => {
        const pending = startCapture();
        expect(isCapturing()).toBe(false);
        recordRawDraw({ backend: "d3d9", vertexCount: 3 }); // tail of the current frame: ignored
        onFrameEnd(); // boundary: recording starts
        expect(isCapturing()).toBe(true);
        recordRawDraw({ backend: "d3d9", vertexCount: 6 });
        recordRawDraw({ backend: "d3d9", vertexCount: 9 });
        onFrameEnd(); // the whole frame is complete
        const frame = await pending;
        expect(frame.drawCalls.map((d) => d.vertexCount)).toEqual([6, 9]);
        expect(isCapturing()).toBe(false);
    });
});
