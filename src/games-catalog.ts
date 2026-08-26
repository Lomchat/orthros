/**
 * Game library catalog — fetched from public/games-catalog.json instead of being
 * baked into the JS bundle, so ops can edit a file on the server with no rebuild.
 * Fetch failure/missing file = empty catalog.
 *
 * Two per-entry switches: "enabled": false drops it from the catalog entirely,
 * while "available": false keeps it listed but unlaunchable — for a deployment
 * that ships no bundle for it.
 */
import type { GameEntry } from "./library/GameSelectScreen";

interface GamesCatalogFileEntry extends GameEntry {
    enabled?: boolean;
}

let cached: GameEntry[] | null = null;

export async function loadGamesCatalog(): Promise<GameEntry[]> {
    if (cached) return cached;
    try {
        const resp = await fetch("/games-catalog.json");
        const entries: GamesCatalogFileEntry[] = resp.ok ? await resp.json() : [];
        cached = entries.filter((g) => g.enabled !== false);
    } catch {
        cached = [];
    }
    return cached;
}
