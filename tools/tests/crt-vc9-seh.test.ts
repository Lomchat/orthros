import { describe, expect, test } from "bun:test";
import { registerVc9SehExports } from "../../src/worker/modules/crt-vc9-seh";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

describe("crt-vc9-seh", () => {
    test("_except_handler4_common returns ContinueSearch for invalid frame", () => {
        const exports: Record<string, ThunkImplementation> = {};
        const mem = new Uint8Array(0x1000);
        registerVc9SehExports(exports, {
            process: { v86: { cpu: { reg32: new Uint32Array(8), instruction_pointer: new Uint32Array(1) } } } as any,
            notifySehAborted: () => {},
        });
        const result = exports["_except_handler4_common"]!(null as any, mem, [0, 0, 0, 0]);
        expect(result).toBe(1);
    });
});
