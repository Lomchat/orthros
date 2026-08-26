import { describe, expect, test } from "bun:test";
import { copyrightYear, synthesizeManifest } from "@orthros/repack/manifest-synth";
import type { InnoParseResult } from "@orthros/formats/inno";

describe("gog-import/copyrightYear", () => {
    test("plain single year", () => {
        expect(copyrightYear("(C) 1999 Perfect Entertainment")).toBe(1999);
    });

    test("range picks the latest year (closest to release)", () => {
        expect(copyrightYear("© 1997-2002 Some Studio")).toBe(2002);
        expect(copyrightYear("Copyright 1998, 2000 Publisher")).toBe(2000);
    });

    test("no year / missing string", () => {
        expect(copyrightYear("All rights reserved")).toBeUndefined();
        expect(copyrightYear(undefined)).toBeUndefined();
        expect(copyrightYear("")).toBeUndefined();
    });

    test("ignores non-year numbers (versions, addresses)", () => {
        expect(copyrightYear("v1.44 build 4242, © 2001")).toBe(2001);
    });
});

function fakeParsed(header: Partial<Record<string, string>>): InnoParseResult {
    return {
        header: { appName: "Test Game", appVersion: "1.0", ...header },
        files: [],
        icons: [],
        registryEntries: [],
        version: { isUnicode: () => false },
    } as unknown as InnoParseResult;
}

describe("gog-import/synthesizeManifest meta block", () => {
    test("emits manifest.meta with developer + year from the Inno header", () => {
        const { manifest } = synthesizeManifest({
            parsed: fakeParsed({ appPublisher: "Perfect Entertainment", appCopyright: "© 1999 Perfect Entertainment" }),
            gameFiles: new Map(),
            cli: { exe: "game.exe" },
        });
        expect(manifest.meta).toEqual({ developer: "Perfect Entertainment", year: 1999 });
    });

    test("omits meta entirely when the header has neither publisher nor a year", () => {
        const { manifest } = synthesizeManifest({
            parsed: fakeParsed({}),
            gameFiles: new Map(),
            cli: { exe: "game.exe" },
        });
        expect(manifest.meta).toBeUndefined();
    });

    test("partial meta: developer only", () => {
        const { manifest } = synthesizeManifest({
            parsed: fakeParsed({ appPublisher: "Some Studio" }),
            gameFiles: new Map(),
            cli: { exe: "game.exe" },
        });
        expect(manifest.meta).toEqual({ developer: "Some Studio" });
    });

    test("override.manifest.meta deep-merges over synthesized meta", () => {
        const { manifest } = synthesizeManifest({
            parsed: fakeParsed({ appPublisher: "Wrong Corp", appCopyright: "© 2000" }),
            gameFiles: new Map(),
            cli: { exe: "game.exe" },
            override: { manifest: { meta: { developer: "Right Corp", cover: "cover.png" } } },
        });
        expect(manifest.meta).toEqual({ developer: "Right Corp", year: 2000, cover: "cover.png" });
    });
});
