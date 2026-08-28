/**
 * Per-game launch profile.
 *
 * A catalog entry can declare selectable languages and adjustable emulator options. The
 * player's choice is stored locally, then sent with `load_bundle`: the worker merges the
 * manifest part onto the bundle manifest and seeds the registry part after the bundle's
 * own defaults. Nothing here is game-specific — the catalog authors what a game exposes.
 *
 * A language carries its own `gameId`, so each one owns a separate OPFS container: its own
 * saves, registry and cloud snapshots. Switching language switches installs, it does not
 * convert one.
 */

export interface RegistryPatch {
    root: string;
    path: string;
    values: Array<{ name: string; type: string; data: string | number }>;
}

/** A selectable edition of a game. In practice: a language the bundle ships. */
export interface GameLanguage {
    /** Stable key stored in the profile, e.g. "fr". */
    code: string;
    /** Shown in the settings modal, in its own language ("Français"). */
    label: string;
    /** ISO 3166-1 alpha-2 country whose flag represents it on the card. */
    flag: string;
    /** Display name in this language; falls back to the entry's name. */
    name?: string;
    /** Cover in this language; falls back to the entry's cover. */
    coverUrl?: string;
    /** Own container key — omit to share the entry's default container. */
    gameId?: string;
    /** Seeded after the bundle's registry defaults, so the choice wins. */
    registry?: RegistryPatch | RegistryPatch[];
}

/** What the player picked. Absent fields mean "leave the bundle's value alone". */
export interface GameProfile {
    language?: string;
    width?: number;
    height?: number;
    skipVideo?: boolean;
}

/** Resolutions offered when an entry declares `resolutions: true`. */
export const RESOLUTION_CHOICES: ReadonlyArray<{ width: number; height: number; label: string }> = [
    { width: 800, height: 600, label: "800 × 600" },
    { width: 1024, height: 768, label: "1024 × 768" },
];

const STORAGE_PREFIX = "orthros.gameProfile.";

function storageKey(entryId: string): string {
    return `${STORAGE_PREFIX}${entryId}`;
}

export function loadGameProfile(entryId: string): GameProfile {
    try {
        const raw = localStorage.getItem(storageKey(entryId));
        if (!raw) return {};
        const parsed = JSON.parse(raw) as GameProfile;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export function saveGameProfile(entryId: string, profile: GameProfile): void {
    try {
        localStorage.setItem(storageKey(entryId), JSON.stringify(profile));
    } catch {
        /* private mode / quota — the profile just won't persist */
    }
}

/** The language a profile selects, or the entry's default, or the first declared one. */
export function resolveLanguage(
    languages: readonly GameLanguage[] | undefined,
    profile: GameProfile,
    defaultLanguage?: string,
): GameLanguage | null {
    if (!languages || languages.length === 0) return null;
    return (
        languages.find((l) => l.code === profile.language) ??
        languages.find((l) => l.code === defaultLanguage) ??
        languages[0]!
    );
}

/**
 * The payload sent with `load_bundle`. `manifest` is deep-merged onto the bundle's own
 * manifest, which is what makes `gameId` (and therefore the container) follow the choice.
 */
export interface LaunchProfile {
    manifest?: Record<string, unknown>;
    registry?: RegistryPatch | RegistryPatch[];
}

export function buildLaunchProfile(
    profile: GameProfile,
    language: GameLanguage | null,
): LaunchProfile | undefined {
    const manifest: Record<string, unknown> = {};
    const emulator: Record<string, unknown> = {};

    if (language?.gameId) manifest["gameId"] = language.gameId;
    if (language?.name) manifest["name"] = language.name;
    if (profile.width && profile.height) {
        emulator["screenResolution"] = { width: profile.width, height: profile.height };
    }
    if (typeof profile.skipVideo === "boolean") emulator["skipVideo"] = profile.skipVideo;
    if (Object.keys(emulator).length > 0) manifest["emulator"] = emulator;

    const launch: LaunchProfile = {};
    if (Object.keys(manifest).length > 0) launch.manifest = manifest;
    if (language?.registry) launch.registry = language.registry;
    return Object.keys(launch).length > 0 ? launch : undefined;
}
