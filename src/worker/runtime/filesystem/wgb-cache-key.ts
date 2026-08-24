/**
 * Stable OPFS filename for a WGB URL.
 *
 * Development disk mounts all share the route `/__wgb/?path=...`; keying only
 * from the route would collapse every mounted bundle to `game.wgb` and can make
 * a later run silently reuse the bytes/manifest of a different bundle. Use the
 * real disk basename for that route while retaining the historical basename
 * behavior for ordinary `/apps/foo.wgb` URLs.
 */
export function wgbCacheKeyForUrl(url: string): string {
    try {
        const parsed = new URL(url, "http://bottleship.invalid");
        if (parsed.pathname.replace(/\/+$/, "") === "/__wgb") {
            const diskPath = parsed.searchParams.get("path");
            if (diskPath) {
                const name = diskPath.replace(/\\/g, "/").split("/").pop();
                if (name) return name;
            }
        }
        return parsed.pathname.split("/").pop() || "game.wgb";
    } catch {
        const path = url.split("?")[0]!.replace(/\\/g, "/");
        return path.split("/").pop() || "game.wgb";
    }
}
