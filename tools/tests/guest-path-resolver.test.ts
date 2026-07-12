import { describe, expect, test } from "bun:test";
import {
    expandFileLookupPaths,
    normalizeGuestPath,
} from "../../src/worker/runtime/filesystem/guest-path-resolver";
import {
    isVirtualHleSystemFile,
    isVirtualSystemDirectory,
} from "../../src/worker/core/hle-system-catalog";

describe("normalizeGuestPath", () => {
    test("normalizes slashes and collapses dot segments", () => {
        expect(normalizeGuestPath("c:/windows/system/../system/ddraw.dll")).toBe(
            "C:\\windows\\system\\ddraw.dll",
        );
    });
});

describe("expandFileLookupPaths", () => {
    test("aliases Win9x SYSTEM to SYSTEM32 for files", () => {
        const paths = expandFileLookupPaths("C:\\WINDOWS\\SYSTEM\\DDRAW.DLL");
        expect(paths).toContain("C:\\WINDOWS\\SYSTEM\\DDRAW.DLL");
        expect(paths).toContain("C:\\WINDOWS\\SYSTEM32\\DDRAW.DLL");
    });

    test("aliases SYSTEM32 to SYSTEM for files", () => {
        const paths = expandFileLookupPaths("C:\\WINDOWS\\SYSTEM32\\D3D9.DLL");
        expect(paths).toContain("C:\\WINDOWS\\SYSTEM32\\D3D9.DLL");
        expect(paths).toContain("C:\\WINDOWS\\SYSTEM\\D3D9.DLL");
    });

    test("aliases system directory paths", () => {
        const paths = expandFileLookupPaths("C:\\WINDOWS\\SYSTEM");
        expect(paths).toContain("C:\\WINDOWS\\SYSTEM");
        expect(paths).toContain("C:\\WINDOWS\\SYSTEM32");
    });

    test("leaves non-system paths untouched", () => {
        expect(expandFileLookupPaths("C:\\GAME\\DATA.BIN")).toEqual(["C:\\GAME\\DATA.BIN"]);
    });
});

describe("virtual HLE system files", () => {
    test("ddraw under Win9x system dir is virtually installed", () => {
        expect(isVirtualHleSystemFile("C:\\WINDOWS\\SYSTEM\\DDRAW.DLL")).toBe(true);
    });

    test("ddraw under System32 is virtually installed", () => {
        expect(isVirtualHleSystemFile("C:\\WINDOWS\\SYSTEM32\\DDRAW.DLL")).toBe(true);
    });

    test("random game file under system dir is not virtual", () => {
        expect(isVirtualHleSystemFile("C:\\WINDOWS\\SYSTEM\\NOTADLL.EXE")).toBe(false);
    });

    test("HLE dll outside system dirs is not virtual", () => {
        expect(isVirtualHleSystemFile("C:\\GAME\\DDRAW.DLL")).toBe(false);
    });
});

describe("virtual system directories", () => {
    test("core Windows dirs exist even without ROM entries", () => {
        expect(isVirtualSystemDirectory("C:\\WINDOWS")).toBe(true);
        expect(isVirtualSystemDirectory("C:\\WINDOWS\\SYSTEM")).toBe(true);
        expect(isVirtualSystemDirectory("C:\\WINDOWS\\SYSTEM32")).toBe(true);
    });

    test("game dirs are not virtual system dirs", () => {
        expect(isVirtualSystemDirectory("C:\\GAME")).toBe(false);
    });
});
