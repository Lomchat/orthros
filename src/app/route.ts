/**
 * Game routing.
 *
 * Public URLs are path-based (`/bfme`). The `?game=<id>` form stays supported and
 * takes precedence, because the harness, the dev console and the BYO-load flow all
 * drive the app through it with extra query params attached (`?game=dev&load=…`).
 */

/** Game id for the current location, or null when the library should be shown. */
export function currentGameId(): string | null {
    const fromQuery = new URLSearchParams(window.location.search).get("game");
    if (fromQuery) return fromQuery;
    // A single extension-less path segment is a game id; anything else (`/`,
    // `/index.html`, nested paths) falls through to the library.
    const segment = window.location.pathname.replace(/^\/+|\/+$/g, "");
    if (!segment || segment.includes("/") || segment.includes(".")) return null;
    return decodeURIComponent(segment);
}

/** URL that launches a catalog game. */
export function gameHref(id: string): string {
    return `/${encodeURIComponent(id)}`;
}
