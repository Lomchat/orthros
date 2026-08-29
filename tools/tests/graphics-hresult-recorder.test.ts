import { beforeEach, describe, expect, test } from "bun:test";
import {
    getGraphicsHresultFailures,
    recordGraphicsHresultFailure,
    resetGraphicsHresultFailures,
} from "../../src/worker/core/diagnostics/graphics-hresult-recorder";

describe("graphics HRESULT recorder", () => {
    beforeEach(resetGraphicsHresultFailures);

    test("retains failed graphics calls with copied arguments", () => {
        const args = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70];
        recordGraphicsHresultFailure("d3d9:CreateThing", 0x8876086c, 0x401234, args, args.length);
        args[0] = 0;

        expect(getGraphicsHresultFailures()).toEqual([{
            api: "d3d9:CreateThing",
            hresult: 0x8876086c,
            caller: 0x401234,
            args: [0x10, 0x20, 0x30, 0x40, 0x50, 0x60],
            seq: 1,
        }]);
    });

    test("ignores success values and non-graphics failures", () => {
        recordGraphicsHresultFailure("d3dx9:Ok", 0, 1, [], 0);
        recordGraphicsHresultFailure("kernel32:Fail", 0x80004005, 2, [], 0);
        expect(getGraphicsHresultFailures()).toEqual([]);
    });

    test("is bounded to the newest 128 failures", () => {
        for (let i = 0; i < 140; i++) {
            recordGraphicsHresultFailure("ddraw:Fail", 0x80000000 + i, i, [i], 1);
        }
        const report = getGraphicsHresultFailures();
        expect(report).toHaveLength(128);
        expect(report[0]!.caller).toBe(12);
        expect(report.at(-1)!.caller).toBe(139);
    });
});
