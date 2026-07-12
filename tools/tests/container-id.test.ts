/**
 * Unit tests for container identity (container-id.ts) — the per-game save/registry/overlay key.
 *
 * The gameId is namespaced "<scheme>:<id>"; the scheme is a closed allowlist; the id must survive
 * re-download/patch (it is the save key). gameIdToContainerDir() is the single canonical encoder
 * shared by overlay + registry + bundle cache.
 */
import { describe, expect, test } from "bun:test";
import {
    deriveGameId,
    gameIdToContainerDir,
    isValidGameId,
    manifestToWgbFilename,
    parseGameId,
    resolveGameId,
    slugify,
} from "@bottleship/formats/wgb/container-id";

describe("parseGameId", () => {
    test("accepts known schemes", () => {
        expect(parseGameId("gog:1207658691")).toEqual({ scheme: "gog", id: "1207658691" });
        expect(parseGameId("app:com.acclaim.revolt-demo")).toEqual({ scheme: "app", id: "com.acclaim.revolt-demo" });
        expect(parseGameId("steam:9200")).toEqual({ scheme: "steam", id: "9200" });
        expect(parseGameId("byo:9f3c1a02")).toEqual({ scheme: "byo", id: "9f3c1a02" });
    });

    test("scheme match is case-insensitive", () => {
        expect(parseGameId("GOG:123")).toEqual({ scheme: "gog", id: "123" });
    });

    test("rejects unknown scheme (fail loud, not a silent new dir)", () => {
        expect(parseGameId("origin:123")).toBeNull();
        expect(parseGameId("nintendo:zelda")).toBeNull();
    });

    test("rejects malformed ids", () => {
        expect(parseGameId("no-scheme")).toBeNull();
        expect(parseGameId(":123")).toBeNull();   // empty scheme
        expect(parseGameId("gog:")).toBeNull();    // empty id
        expect(parseGameId("gog: ")).toBeNull();   // whitespace-only id
    });
});

describe("isValidGameId", () => {
    test("narrows undefined/null/invalid", () => {
        expect(isValidGameId(undefined)).toBe(false);
        expect(isValidGameId(null)).toBe(false);
        expect(isValidGameId("nope")).toBe(false);
        expect(isValidGameId("gog:123")).toBe(true);
    });
});

describe("gameIdToContainerDir", () => {
    test("is filesystem-safe, lowercase, deterministic", () => {
        expect(gameIdToContainerDir("gog:1207658691")).toBe("gog-1207658691");
        expect(gameIdToContainerDir("app:com.acclaim.revolt-demo")).toBe("app-com.acclaim.revolt-demo");
    });

    test("distinct gameIds map to distinct dirs", () => {
        const a = gameIdToContainerDir("app:com.acclaim.revolt");
        const b = gameIdToContainerDir("app:com.acclaim.revolt-demo");
        const c = gameIdToContainerDir("gog:1207658691");
        expect(new Set([a, b, c]).size).toBe(3);
    });

    test("same gameId is stable across calls", () => {
        expect(gameIdToContainerDir("byo:abc")).toBe(gameIdToContainerDir("byo:abc"));
    });

    test("malformed id still yields a stable non-empty dir", () => {
        const d = gameIdToContainerDir("garbage");
        expect(d.length).toBeGreaterThan(0);
        expect(d).toBe(gameIdToContainerDir("garbage"));
    });
});

describe("slugify", () => {
    test("lowercases and collapses unsafe runs", () => {
        expect(slugify("Re-Volt (Demo)")).toBe("re-volt-demo");
        expect(slugify("Discworld   Noir!!!")).toBe("discworld-noir");
    });
    test("preserves dots and trims edge separators", () => {
        expect(slugify("com.acclaim.revolt")).toBe("com.acclaim.revolt");
        expect(slugify("--foo--")).toBe("foo");
    });
});

describe("deriveGameId", () => {
    test("named bundle → app:<slug>", () => {
        expect(deriveGameId({ name: "Re-Volt" })).toBe("app:re-volt");
    });
    test("anonymous drop → byo:<hex>, stable per seed", () => {
        const id = deriveGameId({ entrypoint: "game/REVOLT.EXE" });
        expect(id).toMatch(/^byo:[0-9a-f]{8}$/);
        expect(deriveGameId({ entrypoint: "game/REVOLT.EXE" })).toBe(id);
    });
    test("different entrypoints → different byo ids", () => {
        expect(deriveGameId({ entrypoint: "a.exe" })).not.toBe(deriveGameId({ entrypoint: "b.exe" }));
    });
});

describe("resolveGameId", () => {
    test("explicit valid gameId wins", () => {
        expect(resolveGameId({ gameId: "gog:123", name: "Whatever" })).toBe("gog:123");
    });
    test("invalid explicit gameId falls back to derivation", () => {
        expect(resolveGameId({ gameId: "bogus:scheme", name: "Re-Volt" })).toBe("app:re-volt");
    });
    test("absent gameId derives from name", () => {
        expect(resolveGameId({ name: "Discworld Noir" })).toBe("app:discworld-noir");
    });
});

describe("manifestToWgbFilename", () => {
    test("uses slugified game title when present", () => {
        expect(manifestToWgbFilename({ name: "System Shock 2", gameId: "gog:1207659172" })).toBe("system-shock-2.wgb");
    });
    test("falls back to container dir when name is absent", () => {
        expect(manifestToWgbFilename({ gameId: "gog:1207659172" })).toBe("gog-1207659172.wgb");
    });
});
