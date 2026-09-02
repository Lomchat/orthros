/**
 * Production static file server.
 * - Adds COOP/COEP headers (required for SharedArrayBuffer / cross-origin isolation)
 * - Handles HTTP Range requests (required for WGB streaming / ZIP random access)
 * - SPA fallback: unknown paths → index.html
 */
import path from "path";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, existsSync } from "node:fs";
import { bfmeRelayStats, bfmeRelayWebSocket, upgradeBfmeRelay } from "./bfme-net-relay";
import { auth } from "./auth";
import { handleSaveApi } from "./save-api";

const DIST = path.resolve(import.meta.dir, "..", "dist");
const PORT = parseInt(process.env.PORT ?? "5173");
const ORTHROS_HOST = process.env.ORTHROS_HOST ?? "0.0.0.0";
const BFME_WGB_PATH = path.resolve(
    process.env.BFME_WGB_PATH ?? path.resolve(import.meta.dir, "..", "..", "..", "data", "bfme-1.03-fr.wgb"),
);
const BFME_WGB_INTEGRITY_PATH = path.resolve(
    process.env.BFME_WGB_INTEGRITY_PATH ?? `${BFME_WGB_PATH}.integrity.json`,
);

type WgbIntegrity = {
    version: number;
    algorithm: string;
    size: number;
    sha256: string;
    chunkSize: number;
    chunks: string[];
    segmentSize: number;
    segments: string[];
};

/** One published bundle: the file, its verified descriptor, and the routes that reach it. */
type Bundle = {
    filePath: string;
    size: number;
    etag: string;
    integrityJson: string;
    integrityEtag: string;
};

/**
 * Re-hash a bundle and check it against its descriptor. Size alone is not enough — a bundle
 * edited in place keeps its length — and the descriptor's chunk/segment hashes are what the
 * browser cache trusts, so a stale one has to fail loudly at boot rather than mid-download.
 */
async function loadBundle(filePath: string, integrityPath: string): Promise<Bundle> {
    const integrityJson = await Bun.file(integrityPath).text();
    const integrity = JSON.parse(integrityJson) as WgbIntegrity;
    const size = await Bun.file(filePath).size;
    const hasher = createHash("sha256");
    for await (const chunk of createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 })) {
        hasher.update(chunk);
    }
    const sha256 = hasher.digest("hex");
    if (integrity.version !== 1 || integrity.algorithm !== "sha256" ||
        !/^[0-9a-f]{64}$/.test(integrity.sha256) || integrity.size !== size ||
        integrity.sha256 !== sha256 ||
        !Number.isSafeInteger(integrity.chunkSize) || integrity.chunkSize <= 0 ||
        !Number.isSafeInteger(integrity.segmentSize) || integrity.segmentSize < integrity.chunkSize ||
        integrity.segmentSize % integrity.chunkSize !== 0 ||
        !Array.isArray(integrity.chunks) || !Array.isArray(integrity.segments) ||
        integrity.chunks.length !== Math.ceil(size / integrity.chunkSize) ||
        integrity.segments.length !== Math.ceil(size / integrity.segmentSize) ||
        integrity.chunks.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
        integrity.segments.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
        throw new Error(`Invalid or stale integrity descriptor: ${integrityPath}`);
    }
    console.log(`Verified WGB ${path.basename(filePath)} SHA-256 ${sha256}`);
    return {
        filePath,
        size,
        etag: `"sha256-${integrity.sha256}"`,
        integrityJson,
        integrityEtag: `"sha256-${new Bun.CryptoHasher("sha256").update(integrityJson).digest("hex")}"`,
    };
}

// Every *.wgb in the bundle directory that has a descriptor beside it gets published under
// its own basename, plus a content-addressed alias. `/apps/bfme.wgb` stays pinned to
// BFME_WGB_PATH so links and caches from before multi-game support keep resolving.
const WGB_DIR = path.resolve(process.env.ORTHROS_WGB_DIR ?? path.dirname(BFME_WGB_PATH));
const BUNDLE_ROUTES = new Map<string, Bundle>();
const INTEGRITY_ROUTES = new Map<string, Bundle>();
const HOT_PROFILE_ROUTES = new Map<string, string>();
for (const entry of readdirSync(WGB_DIR).sort()) {
    if (!entry.endsWith(".wgb")) continue;
    const filePath = path.join(WGB_DIR, entry);
    const integrityPath = `${filePath}.integrity.json`;
    if (!existsSync(integrityPath)) {
        console.warn(`Skipping ${entry}: no integrity descriptor`);
        continue;
    }
    const bundle = await loadBundle(filePath, integrityPath);
    const sha = bundle.etag.slice(8, -1);
    const stem = entry.slice(0, -4);
    // Optional sidecar: a hot-page profile (v86 HOTP image) recorded on the VPS,
    // handed to a browser that has none yet so its first session already
    // compiles the known pages at first touch. Pages carry their own hash, so a
    // stale sidecar degrades to "no profile", never to wrong code.
    // The route is registered whether or not the file exists yet: existence
    // is checked per request, so a sidecar dropped beside the bundle later
    // starts being served without a restart.
    const hotProfilePath = `${filePath}.hotp`;
    const routes = [`/apps/${entry}`, `/apps/${stem}-${sha}.wgb`];
    if (filePath === BFME_WGB_PATH) routes.push("/apps/bfme.wgb", `/apps/bfme-${sha}.wgb`);
    for (const route of routes) {
        BUNDLE_ROUTES.set(route, bundle);
        INTEGRITY_ROUTES.set(`${route}.integrity.json`, bundle);
        HOT_PROFILE_ROUTES.set(`${route}.hotp`, hotProfilePath);
        // Ahead-of-time translation batch (tools/aot/build-batch.ts), same
        // sidecar convention: dropped beside the bundle, served when present.
        HOT_PROFILE_ROUTES.set(`${route}.aot.wasm`, `${filePath}.aot.wasm`);
        HOT_PROFILE_ROUTES.set(`${route}.aot.json`, `${filePath}.aot.json`);
    }
    if (existsSync(hotProfilePath)) console.log(`Hot-page profile sidecar for ${entry}: ${hotProfilePath}`);
}
if (BUNDLE_ROUTES.size === 0) throw new Error(`No verified .wgb found in ${WGB_DIR}`);

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".wgb": "application/octet-stream",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

const COOP_COEP = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
};

function withIsolationHeaders(response: Response): Response {
    for (const [name, value] of Object.entries(COOP_COEP)) response.headers.set(name, value);
    return response;
}

function cacheControl(pathname: string, contentAddressedBfme: boolean): string {
    if (contentAddressedBfme || /\/[a-z0-9._-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|wasm|woff2|png|jpe?g)$/i.test(pathname)) {
        return "public, max-age=31536000, immutable";
    }
    if (pathname === "/index.html" || pathname === "/games-catalog.json" || pathname.endsWith(".integrity.json")) {
        return "no-cache";
    }
    return "public, max-age=3600";
}

const server = Bun.serve({
    port: PORT,
    hostname: ORTHROS_HOST,
    async fetch(req, bunServer) {
        const url = new URL(req.url);
        if (url.pathname === "/bfme-net/health") {
            return Response.json({ ok: true, ...bfmeRelayStats() }, { headers: COOP_COEP });
        }
        if (upgradeBfmeRelay(req, bunServer as any)) return undefined;

        if (url.pathname.startsWith("/api/auth/")) {
            return withIsolationHeaders(await auth.handler(req));
        }
        const saveResponse = await handleSaveApi(req, url);
        if (saveResponse) return withIsolationHeaders(saveResponse);
        if (url.pathname.startsWith("/api/")) {
            return Response.json(
                { error: "Not found" },
                { status: 404, headers: COOP_COEP },
            );
        }

        let pathname = decodeURIComponent(url.pathname);

        const integrityBundle = INTEGRITY_ROUTES.get(pathname);
        if (integrityBundle) {
            const headers = {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-cache",
                "ETag": integrityBundle.integrityEtag,
                ...COOP_COEP,
            };
            if (req.headers.get("If-None-Match") === integrityBundle.integrityEtag) {
                return new Response(null, { status: 304, headers });
            }
            return new Response(integrityBundle.integrityJson, { headers });
        }

        const hotProfilePath = HOT_PROFILE_ROUTES.get(pathname);
        if (hotProfilePath) {
            // Re-read per request: the sidecar is small and gets replaced in
            // place when a better profile is recorded, without a restart.
            const hot = Bun.file(hotProfilePath);
            if (!(await hot.exists())) return new Response("Not found", { status: 404, headers: COOP_COEP });
            const etag = `"sidecar-${hot.size}-${Math.floor(hot.lastModified)}"`;
            const headers = {
                "Content-Type": pathname.endsWith(".json") ? "application/json; charset=utf-8"
                    : pathname.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
                "Cache-Control": "no-cache",
                "ETag": etag,
                ...COOP_COEP,
            };
            if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
            return new Response(hot, { headers });
        }

        // SPA fallback for extensionless paths
        if (!path.extname(pathname)) pathname = "/index.html";

        const bundle = BUNDLE_ROUTES.get(pathname);
        const isBfmeBundle = bundle !== undefined;
        const filePath = bundle ? bundle.filePath : path.join(DIST, pathname);

        // Prevent path traversal
        if (!isBfmeBundle && !filePath.startsWith(DIST + path.sep) && filePath !== DIST) {
            return new Response("Forbidden", { status: 403 });
        }

        const ext = path.extname(filePath).toLowerCase();
        const file = Bun.file(filePath);
        const fileSize = await file.size;

        if (fileSize === 0 && !(await file.exists())) {
            // SPA fallback only for extensionless paths — never for binary assets
            if (!ext) {
                const index = Bun.file(path.join(DIST, "index.html"));
                if (await index.exists()) {
                    return new Response(index, {
                        headers: { "Content-Type": "text/html; charset=utf-8", ...COOP_COEP },
                    });
                }
            }
            return new Response("Not Found", { status: 404, headers: COOP_COEP });
        }
        const contentType = MIME[ext] ?? "application/octet-stream";
        const rangeHeader = req.headers.get("Range");
        const etag = bundle ? bundle.etag : `W/"${fileSize}-${file.lastModified}"`;
        const commonHeaders = {
            "Cache-Control": cacheControl(pathname, bundle !== undefined && pathname.includes("-" + bundle.etag.slice(8, -1))),
            "ETag": etag,
            ...(bundle ? { "X-Orthros-SHA256": bundle.etag.slice(8, -1) } : {}),
            ...COOP_COEP,
        };

        if (!rangeHeader && req.headers.get("If-None-Match") === etag) {
            return new Response(null, { status: 304, headers: commonHeaders });
        }

        // If-Range makes an old partial cache fail closed when the bundle identity
        // changes. A mismatch deliberately falls through to a complete 200 response;
        // range clients cancel that body and reload the new integrity descriptor.
        const ifRange = req.headers.get("If-Range");
        if (rangeHeader && (!ifRange || ifRange === etag)) {
            const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
            if (!match) {
                return new Response("Invalid Range", { status: 416, headers: COOP_COEP });
            }

            const rawStart = match[1];
            const rawEnd = match[2];
            const start = rawStart ? parseInt(rawStart) : fileSize - parseInt(rawEnd);
            const end = rawEnd ? Math.min(parseInt(rawEnd), fileSize - 1) : fileSize - 1;

            if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) {
                return new Response("Range Not Satisfiable", {
                    status: 416,
                    headers: { "Content-Range": `bytes */${fileSize}`, ...commonHeaders },
                });
            }

            return new Response(file.slice(start, end + 1), {
                status: 206,
                headers: {
                    "Content-Type": contentType,
                    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                    "Content-Length": String(end - start + 1),
                    "Accept-Ranges": "bytes",
                    ...commonHeaders,
                },
            });
        }

        if (req.method === "HEAD") {
            return new Response(null, {
                headers: {
                    "Content-Type": contentType,
                    "Content-Length": String(fileSize),
                    "Accept-Ranges": "bytes",
                    ...commonHeaders,
                },
            });
        }

        return new Response(file, {
            headers: {
                "Content-Type": contentType,
                "Content-Length": String(fileSize),
                "Accept-Ranges": "bytes",
                ...commonHeaders,
            },
        });
    },
    websocket: bfmeRelayWebSocket as any,
});

console.log(`Serving Orthros + BFME relay on http://${ORTHROS_HOST}:${server.port}`);
