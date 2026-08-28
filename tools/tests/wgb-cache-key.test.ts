import { describe, expect, test } from "bun:test";
import { wgbCacheKeyForUrl } from "../../src/worker/runtime/filesystem/wgb-cache-key";

describe("wgbCacheKeyForUrl", () => {
    test("keeps the bundle basename for normal app URLs", () => {
        expect(wgbCacheKeyForUrl("/apps/bfme.wgb?v=2")).toBe("bfme.wgb");
        expect(wgbCacheKeyForUrl("https://example.test/games/demo.wgb?token=x")).toBe("demo.wgb");
        expect(wgbCacheKeyForUrl(`/apps/bfme-${"a".repeat(64)}.wgb`)).toBe("bfme.wgb");
    });

    test("uses the mounted disk basename for the shared dev route", () => {
        expect(wgbCacheKeyForUrl("/__wgb/?path=%2Fsrv%2Fbfme%2Ftmp%2Fbfme-1280x720.wgb"))
            .toBe("bfme-1280x720.wgb");
        expect(wgbCacheKeyForUrl("/__wgb/?path=C%3A%5Cgames%5Cbfme-1920x1080.wgb"))
            .toBe("bfme-1920x1080.wgb");
    });
});
