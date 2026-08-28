/**
 * Production static file server.
 * - Adds COOP/COEP headers (required for SharedArrayBuffer / cross-origin isolation)
 * - Handles HTTP Range requests (required for WGB streaming / ZIP random access)
 * - SPA fallback: unknown paths → index.html
 */
import path from "path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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

const bfmeIntegrityJson = await Bun.file(BFME_WGB_INTEGRITY_PATH).text();
const bfmeIntegrity = JSON.parse(bfmeIntegrityJson) as WgbIntegrity;
const actualWgbSize = await Bun.file(BFME_WGB_PATH).size;
const actualWgbHasher = createHash("sha256");
for await (const chunk of createReadStream(BFME_WGB_PATH, { highWaterMark: 8 * 1024 * 1024 })) {
    actualWgbHasher.update(chunk);
}
const actualWgbSha256 = actualWgbHasher.digest("hex");
if (bfmeIntegrity.version !== 1 || bfmeIntegrity.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/.test(bfmeIntegrity.sha256) || bfmeIntegrity.size !== actualWgbSize ||
    bfmeIntegrity.sha256 !== actualWgbSha256 ||
    !Number.isSafeInteger(bfmeIntegrity.chunkSize) || bfmeIntegrity.chunkSize <= 0 ||
    !Number.isSafeInteger(bfmeIntegrity.segmentSize) || bfmeIntegrity.segmentSize < bfmeIntegrity.chunkSize ||
    bfmeIntegrity.segmentSize % bfmeIntegrity.chunkSize !== 0 ||
    !Array.isArray(bfmeIntegrity.chunks) || !Array.isArray(bfmeIntegrity.segments) ||
    bfmeIntegrity.chunks.length !== Math.ceil(actualWgbSize / bfmeIntegrity.chunkSize) ||
    bfmeIntegrity.segments.length !== Math.ceil(actualWgbSize / bfmeIntegrity.segmentSize) ||
    bfmeIntegrity.chunks.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
    bfmeIntegrity.segments.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error(`Invalid or stale BFME integrity descriptor: ${BFME_WGB_INTEGRITY_PATH}`);
}
console.log(`Verified BFME WGB SHA-256 ${actualWgbSha256}`);
const BFME_ETAG = `"sha256-${bfmeIntegrity.sha256}"`;
const BFME_INTEGRITY_ETAG = `"sha256-${new Bun.CryptoHasher("sha256").update(bfmeIntegrityJson).digest("hex")}"`;
const BFME_HASHED_PATH = `/apps/bfme-${bfmeIntegrity.sha256}.wgb`;
const BFME_INTEGRITY_PATHS = new Set([
    "/apps/bfme.wgb.integrity.json",
    `${BFME_HASHED_PATH}.integrity.json`,
]);

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

        if (BFME_INTEGRITY_PATHS.has(pathname)) {
            const headers = {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-cache",
                "ETag": BFME_INTEGRITY_ETAG,
                ...COOP_COEP,
            };
            if (req.headers.get("If-None-Match") === BFME_INTEGRITY_ETAG) {
                return new Response(null, { status: 304, headers });
            }
            return new Response(bfmeIntegrityJson, {
                headers: {
                    ...headers,
                },
            });
        }

        // SPA fallback for extensionless paths
        if (!path.extname(pathname)) pathname = "/index.html";

        const isHashedBfmeBundle = pathname === BFME_HASHED_PATH;
        const isBfmeBundle = pathname === "/apps/bfme.wgb" || isHashedBfmeBundle;
        const filePath = isBfmeBundle ? BFME_WGB_PATH : path.join(DIST, pathname);

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
        const etag = isBfmeBundle ? BFME_ETAG : `W/"${fileSize}-${file.lastModified}"`;
        const commonHeaders = {
            "Cache-Control": cacheControl(pathname, isHashedBfmeBundle),
            "ETag": etag,
            ...(isBfmeBundle ? { "X-Orthros-SHA256": bfmeIntegrity.sha256 } : {}),
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
