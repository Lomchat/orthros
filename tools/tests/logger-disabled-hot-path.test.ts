import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Logger, LogCategory, LogLevel } from "../../src/worker/core/logger";

describe("Logger disabled hot path", () => {
    beforeEach(() => {
        Logger.setStreamCallback(null);
        Logger.resetCategoryLevels();
        Logger.setLevel(LogLevel.NORMAL);
        Logger.setBufferSize(16);
        Logger.setGlobalEnabled(false);
    });

    afterAll(() => {
        Logger.setStreamCallback(null);
        Logger.resetCategoryLevels();
        Logger.setLevel(LogLevel.NORMAL);
        Logger.setBufferSize(50);
        Logger.setGlobalEnabled(true);
    });

    test("drops normal entries when logging has no consumer", () => {
        expect(Logger.isEnabled(LogCategory.D3D9, LogLevel.NORMAL)).toBe(false);
        Logger.log(LogCategory.D3D9, "per-draw diagnostic");
        expect(Logger.getRecentEntries()).toHaveLength(0);
    });

    test("keeps warnings available while normal logging is disabled", () => {
        Logger.warn(LogCategory.SYSTEM, "actionable warning");
        expect(Logger.getRecentEntries().map((entry) => entry.message)).toEqual(["actionable warning"]);
    });

    test("records normal entries for an explicit stream consumer", () => {
        Logger.setStreamCallback(() => {});
        expect(Logger.isEnabled(LogCategory.D3D9, LogLevel.NORMAL)).toBe(true);
        Logger.log(LogCategory.D3D9, "streamed diagnostic");
        expect(Logger.getRecentEntries().map((entry) => entry.message)).toEqual(["streamed diagnostic"]);
    });
});
