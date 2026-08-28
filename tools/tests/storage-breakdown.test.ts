import { describe, expect, test } from "bun:test";
import {
    buildStorageBreakdown,
    classifyStoragePath,
} from "../../src/storage-breakdown";

describe("storage breakdown", () => {
    test("classifies managed and otherwise hidden OPFS files", () => {
        expect(classifyStoragePath("orthros/wgb-cache/bfme.wgb")).toBe("game-files");
        expect(classifyStoragePath("orthros/wgb-cache/bfme.wgb.part")).toBe("partial-downloads");
        expect(classifyStoragePath("orthros/wgb-cache/bfme.wgb.part.map")).toBe("partial-downloads");
        expect(classifyStoragePath("orthros/games/byo-bfme/overlay/Options.ini")).toBe("saves-settings");
        expect(classifyStoragePath("orthros/games/byo-bfme/ephemeral/run.log")).toBe("app-support");
        expect(classifyStoragePath("another-app/data.bin")).toBe("other-opfs");
    });

    test("reconciles readable OPFS file sizes with browser-reported usage", () => {
        const detail = buildStorageBreakdown([
            { path: "orthros/wgb-cache/bfme.wgb", bytes: 3_000 },
            { path: "orthros/wgb-cache/bfme.wgb.part", bytes: 2_000 },
            { path: "orthros/games/byo-bfme/registry.json", bytes: 100 },
            { path: "orthros/wgb-cache/_cache-lru.json", bytes: 20 },
        ], 6_000, 1);

        expect(detail.buckets["game-files"]).toEqual({ bytes: 3_000, files: 1 });
        expect(detail.buckets["partial-downloads"]).toEqual({ bytes: 2_000, files: 1 });
        expect(detail.buckets["saves-settings"]).toEqual({ bytes: 100, files: 1 });
        expect(detail.buckets["app-support"]).toEqual({ bytes: 20, files: 1 });
        expect(detail.scannedBytes).toBe(5_120);
        expect(detail.otherSiteBytes).toBe(880);
        expect(detail.unreadableFiles).toBe(1);
    });

    test("does not invent negative other-site usage for sparse files", () => {
        const detail = buildStorageBreakdown([
            { path: "orthros/wgb-cache/bfme.wgb.part", bytes: 10_000 },
        ], 3_000);
        expect(detail.otherSiteBytes).toBe(0);
        expect(detail.scannedBytes).toBe(10_000);
    });
});
