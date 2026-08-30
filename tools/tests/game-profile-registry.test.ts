import { describe, expect, test } from "bun:test";
import { buildLaunchProfile, type GameLanguage } from "../../src/game-profile";

describe("launch-profile registry metadata", () => {
  test("preserves numeric DWORDs and multiple installation keys", () => {
    const registry: NonNullable<GameLanguage["registry"]> = [
      {
        root: "HKLM",
        path: "Software\\Vendor\\Base",
        values: [{ name: "Version", type: "REG_DWORD", data: 0x10003 }],
      },
      {
        root: "HKLM",
        path: "Software\\Vendor\\Expansion",
        values: [{ name: "InstallPath", type: "REG_SZ", data: "C:\\" }],
      },
    ];
    const language: GameLanguage = {
      code: "fr",
      label: "Français",
      flag: "fr",
      entrypoint: "rom/native-launcher.exe",
      registry,
    };

    expect(buildLaunchProfile({}, language)?.registry).toEqual(registry);
    expect(buildLaunchProfile({}, language)?.manifest?.entrypoint).toBe("rom/native-launcher.exe");
  });

  test("preserves read-only WGB underlays without requiring manifest overrides", () => {
    expect(buildLaunchProfile({}, null, [
      { url: "/apps/base.wgb", include: ["base.exe"], mountPrefix: "BaseGame" },
      { url: "/apps/shared.wgb" },
    ])).toEqual({ romLayers: [
      { url: "/apps/base.wgb", include: ["base.exe"], mountPrefix: "BaseGame" },
      { url: "/apps/shared.wgb", include: undefined, mountPrefix: undefined },
    ] });
  });

  test("merges a generic catalog runtime policy below player choices", () => {
    expect(buildLaunchProfile(
      { width: 1024, height: 768, skipVideo: true },
      null,
      [],
      { compressedTexturePolicy: "prefer-uncompressed" },
    )).toEqual({ manifest: { emulator: {
      compressedTexturePolicy: "prefer-uncompressed",
      screenResolution: { width: 1024, height: 768 },
      skipVideo: true,
    } } });
  });
});
