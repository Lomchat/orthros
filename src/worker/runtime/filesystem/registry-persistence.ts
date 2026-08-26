import { Logger, LogCategory } from "../../core/logger";
import { getContainerDir, listContainerDirs } from "./container-store";

/**
 * Serialized registry state for persistence
 */
export interface PersistedRegistryState {
    version: number;
    gameId: string;
    lastModified: number;
    keys: Record<string, Record<string, { name: string; type: string; data: string | number }>>;
}

/**
 * Registry access log entry
 */
export interface RegistryAccessLogEntry {
    ts: number; // timestamp
    op: string; // operation name (RegQueryValueExA, RegSetValueExA, etc.)
    key: string; // full registry key path
    value: string; // value name
    result: "success" | "not_found" | "error";
    data?: string | number; // data read/written (if applicable)
}

/**
 * Registry persistence manager - handles OPFS storage for registry state and access logs
 */
export class RegistryPersistence {
    /** registry.json + its access log live INSIDE the game's container (orthros/games/<cid>/). */
    private static readonly STATE_FILE = "registry.json";
    private static readonly ACCESS_LOG_FILE = "registry-access.log";

    /**
     * Get the OPFS container dir for a game's registry storage. The registry is just one file in the
     * per-game container (see container-store.ts); keying is via the namespaced gameId.
     */
    private static async getGameRegistryDir(
        gameId: string,
        create: boolean = false
    ): Promise<FileSystemDirectoryHandle | null> {
        try {
            return await getContainerDir(gameId, create);
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `Failed to get registry directory for game ${gameId}: ${error}`);
            return null;
        }
    }

    /**
     * Load persisted registry state for a game
     */
    static async load(gameId: string): Promise<PersistedRegistryState | null> {
        try {
            const gameDir = await this.getGameRegistryDir(gameId, false);
            if (!gameDir) {
                Logger.verbose(LogCategory.SYSTEM, `No persisted registry found for game ${gameId}`);
                return null;
            }

            const fileHandle = await gameDir.getFileHandle(this.STATE_FILE);
            const file = await fileHandle.getFile();
            const text = await file.text();
            const state = JSON.parse(text) as PersistedRegistryState;

            // Discard stale v1 data — REG_MULTI_SZ was stored as truncated REG_SZ
            if (!state.version || state.version < 2) {
                Logger.log(
                    LogCategory.SYSTEM,
                    `Discarding stale v${state.version ?? 0} registry for game ${gameId} (REG_MULTI_SZ fix)`
                );
                return null;
            }

            Logger.log(
                LogCategory.SYSTEM,
                `Loaded persisted registry for game ${gameId} (${Object.keys(state.keys).length} keys)`
            );
            return state;
        } catch (err: any) {
            if (err.name === "NotFoundError") {
                Logger.verbose(LogCategory.SYSTEM, `No persisted registry state file for game ${gameId}`);
                return null;
            }
            Logger.error(LogCategory.SYSTEM, `Failed to load registry state for ${gameId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Save registry state for a game
     */
    static async save(gameId: string, state: PersistedRegistryState): Promise<void> {
        try {
            const gameDir = await this.getGameRegistryDir(gameId, true);
            if (!gameDir) {
                Logger.error(LogCategory.SYSTEM, `Failed to create registry directory for game ${gameId}`);
                return;
            }

            state.lastModified = Date.now();
            const json = JSON.stringify(state, null, 2);

            const fileHandle = await gameDir.getFileHandle(this.STATE_FILE, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(json);
            await writable.close();

            Logger.verbose(
                LogCategory.SYSTEM,
                `Saved registry state for game ${gameId} (${Object.keys(state.keys).length} keys)`
            );
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `Failed to save registry state for ${gameId}: ${error}`);
        }
    }

    /**
     * Append entries to access log
     */
    static async appendAccessLog(gameId: string, entries: RegistryAccessLogEntry[]): Promise<void> {
        if (entries.length === 0) return;

        try {
            const gameDir = await this.getGameRegistryDir(gameId, true);
            if (!gameDir) {
                Logger.error(LogCategory.SYSTEM, `Failed to create registry directory for game ${gameId}`);
                return;
            }

            // Read existing log
            let existingContent = "";
            try {
                const fileHandle = await gameDir.getFileHandle(this.ACCESS_LOG_FILE);
                const file = await fileHandle.getFile();
                existingContent = await file.text();
            } catch (err: any) {
                if (err.name !== "NotFoundError") {
                    throw err;
                }
                // File doesn't exist yet, will be created
            }

            // Append new entries as JSONL (one JSON object per line)
            const newLines = entries.map((entry) => JSON.stringify(entry)).join("\n");
            const updatedContent = existingContent ? `${existingContent}\n${newLines}` : newLines;

            // Write back
            const fileHandle = await gameDir.getFileHandle(this.ACCESS_LOG_FILE, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(updatedContent);
            await writable.close();

            Logger.verbose(LogCategory.SYSTEM, `Appended ${entries.length} entries to access log for ${gameId}`);
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `Failed to append access log for ${gameId}: ${error}`);
        }
    }

    /**
     * Read access log for a game
     */
    static async readAccessLog(gameId: string): Promise<RegistryAccessLogEntry[]> {
        try {
            const gameDir = await this.getGameRegistryDir(gameId, false);
            if (!gameDir) {
                return [];
            }

            const fileHandle = await gameDir.getFileHandle(this.ACCESS_LOG_FILE);
            const file = await fileHandle.getFile();
            const text = await file.text();

            // Parse JSONL
            const entries: RegistryAccessLogEntry[] = [];
            const lines = text.split("\n").filter((line) => line.trim());
            for (const line of lines) {
                try {
                    entries.push(JSON.parse(line));
                } catch (err) {
                    Logger.warn(LogCategory.SYSTEM, `Failed to parse access log line: ${line}`);
                }
            }

            return entries;
        } catch (err: any) {
            if (err.name === "NotFoundError") {
                return [];
            }
            Logger.error(LogCategory.SYSTEM, `Failed to read access log for ${gameId}: ${err.message}`);
            return [];
        }
    }

    /**
     * Clear a game's registry data ONLY (registry.json + access log). Does NOT touch the overlay /
     * saves — the container survives; this is the "reset this game's registry" dev action.
     */
    static async clearGameData(gameId: string): Promise<void> {
        const dir = await this.getGameRegistryDir(gameId, false);
        if (!dir) {
            Logger.verbose(LogCategory.SYSTEM, `No registry data to clear for game ${gameId}`);
            return;
        }
        for (const file of [this.STATE_FILE, this.ACCESS_LOG_FILE]) {
            try {
                await dir.removeEntry(file);
            } catch (err: any) {
                if (err?.name !== "NotFoundError") {
                    Logger.error(LogCategory.SYSTEM, `Failed to clear ${file} for ${gameId}: ${err?.message}`);
                }
            }
        }
        Logger.log(LogCategory.SYSTEM, `Cleared registry data for game ${gameId}`);
    }

    /**
     * List the container dir names that currently exist (one per game with persisted state).
     */
    static async listGames(): Promise<string[]> {
        try {
            return await listContainerDirs();
        } catch (error) {
            Logger.error(LogCategory.SYSTEM, `Failed to list games with registry data: ${error}`);
            return [];
        }
    }
}
