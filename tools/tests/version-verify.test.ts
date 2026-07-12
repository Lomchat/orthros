import { describe, expect, test } from "bun:test";
import {
    VER_BUILDNUMBER,
    VER_EQUAL,
    VER_GREATER_EQUAL,
    VER_MAJORVERSION,
    VER_MINORVERSION,
    VER_PLATFORMID,
    verSetConditionMask,
    verifyVersionInfoEx,
    type OsVersionExFields,
} from "../../src/worker/modules/kernel32/process/version-verify";
import {
    VER_PLATFORM_WIN32_NT,
    VER_PLATFORM_WIN32_WINDOWS,
} from "../../src/worker/core/emulator-config-manager";

const winXp: OsVersionExFields = {
    dwMajorVersion: 5,
    dwMinorVersion: 1,
    dwBuildNumber: 2600,
    dwPlatformId: VER_PLATFORM_WIN32_NT,
    wServicePackMajor: 0,
    wServicePackMinor: 0,
    wSuiteMask: 0,
    wProductType: 1,
};

const win98: OsVersionExFields = {
    dwMajorVersion: 4,
    dwMinorVersion: 10,
    dwBuildNumber: 1998,
    dwPlatformId: VER_PLATFORM_WIN32_WINDOWS,
    wServicePackMajor: 0,
    wServicePackMinor: 0,
    wSuiteMask: 0,
    wProductType: 0,
};

function buildMask(
    specs: Array<{ type: number; condition: number }>,
): { lo: number; hi: number } {
    let lo = 0;
    let hi = 0;
    for (const spec of specs) {
        ({ lo, hi } = verSetConditionMask(lo, hi, spec.type, spec.condition));
    }
    return { lo, hi };
}

describe("verSetConditionMask", () => {
    test("encodes major >= into bits 3..5", () => {
        const { lo } = verSetConditionMask(0, 0, VER_MAJORVERSION, VER_GREATER_EQUAL);
        expect(lo & 0x07).toBe(0);
        expect((lo >>> 3) & 0x07).toBe(VER_GREATER_EQUAL);
    });

    test("accumulates major + minor conditions", () => {
        const { lo } = buildMask([
            { type: VER_MAJORVERSION, condition: VER_EQUAL },
            { type: VER_MINORVERSION, condition: VER_EQUAL },
        ]);
        expect((lo >>> 3) & 0x07).toBe(VER_EQUAL);
        expect(lo & 0x07).toBe(VER_EQUAL);
    });
});

describe("verifyVersionInfoEx", () => {
    test("rejects empty type or condition mask", () => {
        expect(verifyVersionInfoEx(winXp, VER_MAJORVERSION, 0, 0, winXp)).toBe(false);
        expect(verifyVersionInfoEx(winXp, 0, 1, 0, winXp)).toBe(false);
    });

    test("exact XP match passes", () => {
        const criteria: OsVersionExFields = { ...winXp };
        const { lo, hi } = buildMask([
            { type: VER_MAJORVERSION, condition: VER_EQUAL },
            { type: VER_MINORVERSION, condition: VER_EQUAL },
            { type: VER_BUILDNUMBER, condition: VER_EQUAL },
            { type: VER_PLATFORMID, condition: VER_EQUAL },
        ]);
        expect(verifyVersionInfoEx(
            criteria,
            VER_MAJORVERSION | VER_MINORVERSION | VER_BUILDNUMBER | VER_PLATFORMID,
            lo,
            hi,
            winXp,
        )).toBe(true);
    });

    test("Vista+ check fails on Win98", () => {
        const criteria: OsVersionExFields = {
            ...win98,
            dwMajorVersion: 6,
            dwMinorVersion: 0,
        };
        const { lo, hi } = buildMask([
            { type: VER_MAJORVERSION, condition: VER_GREATER_EQUAL },
        ]);
        expect(verifyVersionInfoEx(
            criteria,
            VER_MAJORVERSION,
            lo,
            hi,
            win98,
        )).toBe(false);
    });

    test("Win98 equality check passes on Win98", () => {
        const criteria: OsVersionExFields = { ...win98 };
        const { lo, hi } = buildMask([
            { type: VER_MAJORVERSION, condition: VER_EQUAL },
            { type: VER_MINORVERSION, condition: VER_EQUAL },
        ]);
        expect(verifyVersionInfoEx(
            criteria,
            VER_MAJORVERSION | VER_MINORVERSION,
            lo,
            hi,
            win98,
        )).toBe(true);
    });
});
