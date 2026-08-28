export type StorageBreakdownKind =
    | "game-files"
    | "partial-downloads"
    | "saves-settings"
    | "app-support"
    | "other-opfs";

export interface StorageFileSize {
    /** OPFS-root-relative path, using forward slashes. */
    path: string;
    bytes: number;
}

export interface StorageBreakdownBucket {
    bytes: number;
    files: number;
}

export interface StorageBreakdown {
    buckets: Record<StorageBreakdownKind, StorageBreakdownBucket>;
    /** Bytes reported by the browser but not represented by readable OPFS files. */
    otherSiteBytes: number;
    scannedBytes: number;
    scannedFiles: number;
    unreadableFiles: number;
}

export function classifyStoragePath(path: string): StorageBreakdownKind {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
    const lower = normalized.toLowerCase();

    if (lower.startsWith("orthros/wgb-cache/")) {
        if (lower.endsWith(".wgb.part") || lower.endsWith(".wgb.part.map")) return "partial-downloads";
        if (lower.endsWith(".wgb")) return "game-files";
        return "app-support";
    }

    if (lower.startsWith("orthros/games/")) {
        const parts = lower.split("/");
        return parts[3] === "ephemeral" ? "app-support" : "saves-settings";
    }

    if (lower.startsWith("orthros/")) return "app-support";
    return "other-opfs";
}

export function buildStorageBreakdown(
    files: Iterable<StorageFileSize>,
    browserUsageBytes: number,
    unreadableFiles = 0,
): StorageBreakdown {
    const buckets: StorageBreakdown["buckets"] = {
        "game-files": { bytes: 0, files: 0 },
        "partial-downloads": { bytes: 0, files: 0 },
        "saves-settings": { bytes: 0, files: 0 },
        "app-support": { bytes: 0, files: 0 },
        "other-opfs": { bytes: 0, files: 0 },
    };
    let scannedBytes = 0;
    let scannedFiles = 0;

    for (const file of files) {
        const bytes = Number.isFinite(file.bytes) ? Math.max(0, file.bytes) : 0;
        const bucket = buckets[classifyStoragePath(file.path)];
        bucket.bytes += bytes;
        bucket.files++;
        scannedBytes += bytes;
        scannedFiles++;
    }

    return {
        buckets,
        otherSiteBytes: Math.max(0, browserUsageBytes - scannedBytes),
        scannedBytes,
        scannedFiles,
        unreadableFiles,
    };
}
