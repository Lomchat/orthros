/**
 * Game library catalog — fetched from public/games-catalog.json instead of being
 * baked into the JS bundle, so ops can edit a file on the server with no rebuild.
 * Fetch failure/missing file = empty catalog. Per-entry "enabled": false hides a
 * game — this deployment publishes a bundle for BFME only.
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
