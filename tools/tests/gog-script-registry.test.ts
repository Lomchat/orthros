import { describe, expect, test } from "bun:test";
import { parseGogScriptRegistry, mergeRegistrySeeds } from "@orthros/repack/gog-script";

const SW_RACER_SCRIPT = {
    actions: [
        {
            install: {
                action: "setRegistry",
                arguments: {
                    root: "HKEY_LOCAL_MACHINE",
                    subkey: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer\\v1.0",
                    valueData: "{app}\\SWEP1RCR.EXE",
                    valueName: "Executable",
                    valueType: "string",
                },
            },
            languages: ["*"],
            name: "registryKey01",
        },
        {
            install: {
                action: "setRegistry",
                arguments: {
                    root: "HKEY_LOCAL_MACHINE",
                    subkey: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer\\v1.0",
                    valueData: "{app}",
                    valueName: "Install Path",
                    valueType: "string",
                },
            },
            languages: ["*"],
            name: "registryKey02",
        },
        {
            install: {
                action: "setRegistry",
                arguments: {
                    root: "HKEY_LOCAL_MACHINE",
                    subkey: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer\\v1.0",
                    valueData: "9",
                    valueName: "InstallType",
                    valueType: "dword",
                },
            },
            languages: ["*"],
            name: "registryKey11",
        },
        {
            install: {
                action: "setRegistry",
                arguments: {
                    deleteSubkeys: true,
                    root: "HKEY_LOCAL_MACHINE",
                    subkey: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer",
                },
            },
            languages: ["*"],
            name: "registryKey17",
        },
        {
            install: {
                action: "Execute",
                arguments: { executable: "{app}/ipx_reg.cmd" },
            },
            languages: ["*"],
            name: "AddIPXRegs",
        },
    ],
    productId: "1288119483",
};

describe("gog-script registry", () => {
    test("parses setRegistry actions with {app} expansion", () => {
        const bytes = new TextEncoder().encode(JSON.stringify(SW_RACER_SCRIPT));
        const seeds = parseGogScriptRegistry(bytes, "C:\\");

        const lucas = seeds.find((s) => s.path.includes("LucasArts"));
        expect(lucas).toBeDefined();
        expect(lucas!.root).toBe("HKLM");

        const exe = lucas!.values.find((v) => v.name === "Executable");
        expect(exe).toEqual({ name: "Executable", type: "REG_SZ", data: "C:\\SWEP1RCR.EXE" });

        const installPath = lucas!.values.find((v) => v.name === "Install Path");
        expect(installPath).toEqual({ name: "Install Path", type: "REG_SZ", data: "C:\\" });

        const installType = lucas!.values.find((v) => v.name === "InstallType");
        expect(installType).toEqual({ name: "InstallType", type: "REG_DWORD", data: 9 });
    });

    test("skips deleteSubkeys and non-registry actions", () => {
        const bytes = new TextEncoder().encode(JSON.stringify(SW_RACER_SCRIPT));
        const seeds = parseGogScriptRegistry(bytes, "C:\\");
        expect(seeds).toHaveLength(1);
        expect(seeds[0]!.values).toHaveLength(3);
    });

    test("mergeRegistrySeeds lets later script values override Inno metadata", () => {
        const inno = [{
            root: "HKLM",
            path: "SOFTWARE\\GOG.com\\Games\\1288119483",
            values: [{ name: "ver", type: "REG_SZ", data: "\uFFFD" }],
        }];
        const script = [{
            root: "HKLM",
            path: "Software\\LucasArts Entertainment Company LLC\\Star Wars: Episode I Racer\\v1.0",
            values: [{ name: "Executable", type: "REG_SZ", data: "C:\\SWEP1RCR.EXE" }],
        }];
        const merged = mergeRegistrySeeds(inno, script);
        expect(merged).toHaveLength(2);
        expect(merged.some((s) => s.path.includes("LucasArts"))).toBe(true);
    });
});
