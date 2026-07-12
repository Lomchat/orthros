import { describe, expect, test } from "bun:test";
import { D3D9StateBlockRecorder } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-block";

describe("D3D9StateBlockRecorder", () => {
    test("records and deduplicates state changes between begin/end", () => {
        const recorder = new D3D9StateBlockRecorder();
        expect(recorder.isRecording()).toBe(false);

        expect(recorder.begin()).toBeUndefined();
        expect(recorder.isRecording()).toBe(true);

        recorder.record({ op: "renderState", state: 7, value: 1 });
        recorder.record({ op: "renderState", state: 7, value: 0 });
        recorder.record({ op: "texture", stage: 0, texPtr: 0x1000 });
        recorder.record({ op: "fvf", value: 0x112 });

        const entries = recorder.end();
        expect(recorder.isRecording()).toBe(false);
        expect(entries).toHaveLength(3);
        expect(entries[0]).toEqual({ op: "renderState", state: 7, value: 0 });
        expect(entries[1]).toEqual({ op: "texture", stage: 0, texPtr: 0x1000 });
        expect(entries[2]).toEqual({ op: "fvf", value: 0x112 });
    });

    test("ignores records outside an active block", () => {
        const recorder = new D3D9StateBlockRecorder();
        recorder.record({ op: "renderState", state: 1, value: 2 });
        recorder.begin();
        recorder.record({ op: "renderState", state: 3, value: 4 });
        expect(recorder.end()).toHaveLength(1);
    });
});
