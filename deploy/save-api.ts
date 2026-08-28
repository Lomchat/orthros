import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { auth, authTrustedOrigins } from "./auth";
import { dbPool } from "./database";

const MAX_SAVE_BYTES = 32 * 1024 * 1024;
const SNAPSHOTS_TO_KEEP = 20;
const SAVE_ROOT = path.resolve(process.env.BFME_SAVE_PATH ?? "/srv/bfme/data/cloud-saves");
const CONTAINER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const DEVICE_ID = /^[a-zA-Z0-9._-]{1,64}$/;

type SessionUser = { id: string };

type SaveHeadRow = {
    snapshot_id: string;
    sha256: string;
    size_bytes: string;
    object_key: string;
    device_id: string;
    updated_at: Date;
};

function json(value: unknown, status = 200): Response {
    return Response.json(value, {
        status,
        headers: { "Cache-Control": "no-store" },
    });
}

function safeContainerId(raw: string): string | null {
    const decoded = decodeURIComponent(raw).toLowerCase();
    return CONTAINER_ID.test(decoded) ? decoded : null;
}

function sha256(data: Uint8Array | string): string {
    return createHash("sha256").update(data).digest("hex");
}

function objectPath(objectKey: string): string {
    const target = path.resolve(SAVE_ROOT, objectKey);
    if (!target.startsWith(`${SAVE_ROOT}${path.sep}`)) throw new Error("Invalid save object path");
    return target;
}

async function sessionUser(req: Request): Promise<SessionUser | null> {
    const session = await auth.api.getSession({ headers: req.headers });
    return session?.user?.id ? { id: session.user.id } : null;
}

function sameOrigin(req: Request): boolean {
    const origin = req.headers.get("Origin");
    return origin !== null && authTrustedOrigins.includes(origin);
}

async function currentHead(client: PoolClient, userId: string, containerId: string): Promise<SaveHeadRow | null> {
    const result = await client.query<SaveHeadRow>(
        `SELECT h.snapshot_id, s.sha256, s.size_bytes, s.object_key, s.device_id, h.updated_at
           FROM orthros_save_heads h
           JOIN orthros_save_snapshots s ON s.id = h.snapshot_id
          WHERE h.user_id = $1 AND h.container_id = $2
          FOR UPDATE OF h`,
        [userId, containerId],
    );
    return result.rows[0] ?? null;
}

async function pruneSnapshots(userId: string, containerId: string): Promise<void> {
    const old = await dbPool.query<{ id: string; object_key: string }>(
        `SELECT s.id, s.object_key
           FROM orthros_save_snapshots s
          WHERE s.user_id = $1 AND s.container_id = $2
            AND NOT EXISTS (SELECT 1 FROM orthros_save_heads h WHERE h.snapshot_id = s.id)
          ORDER BY s.created_at DESC
          OFFSET $3`,
        [userId, containerId, Math.max(0, SNAPSHOTS_TO_KEEP - 1)],
    );
    if (old.rows.length === 0) return;
    await dbPool.query(
        "DELETE FROM orthros_save_snapshots WHERE id = ANY($1::uuid[])",
        [old.rows.map((row) => row.id)],
    );
    await Promise.all(old.rows.map(async (row) => {
        try { await unlink(objectPath(row.object_key)); } catch { /* already absent or cleanup can retry later */ }
    }));
}

async function listSaves(userId: string): Promise<Response> {
    const result = await dbPool.query<SaveHeadRow & { container_id: string }>(
        `SELECT h.container_id, h.snapshot_id, s.sha256, s.size_bytes, s.object_key,
                s.device_id, h.updated_at
           FROM orthros_save_heads h
           JOIN orthros_save_snapshots s ON s.id = h.snapshot_id
          WHERE h.user_id = $1
          ORDER BY h.container_id`,
        [userId],
    );
    return json({
        games: result.rows.map((row) => ({
            containerId: row.container_id,
            hash: row.sha256,
            size: Number(row.size_bytes),
            deviceId: row.device_id,
            updatedAt: row.updated_at.toISOString(),
        })),
    });
}

async function downloadSave(userId: string, containerId: string): Promise<Response> {
    const result = await dbPool.query<SaveHeadRow>(
        `SELECT h.snapshot_id, s.sha256, s.size_bytes, s.object_key, s.device_id, h.updated_at
           FROM orthros_save_heads h
           JOIN orthros_save_snapshots s ON s.id = h.snapshot_id
          WHERE h.user_id = $1 AND h.container_id = $2`,
        [userId, containerId],
    );
    const head = result.rows[0];
    if (!head) return json({ error: "No cloud save for this game" }, 404);
    const file = Bun.file(objectPath(head.object_key));
    if (!(await file.exists())) return json({ error: "Cloud save object is missing" }, 503);
    return new Response(file, {
        headers: {
            "Content-Type": "application/zip",
            "Content-Length": head.size_bytes,
            "Cache-Control": "private, no-store",
            "ETag": `"sha256-${head.sha256}"`,
            "X-Orthros-Save-Hash": head.sha256,
        },
    });
}

async function uploadSave(req: Request, userId: string, containerId: string): Promise<Response> {
    if (!sameOrigin(req)) return json({ error: "Invalid request origin" }, 403);
    const contentLength = Number(req.headers.get("Content-Length") ?? "0");
    if (contentLength > MAX_SAVE_BYTES) return json({ error: "Save snapshot is too large" }, 413);

    const parentHash = (req.headers.get("X-Orthros-Parent-Hash") ?? "").toLowerCase();
    const deviceId = req.headers.get("X-Orthros-Device-Id") ?? "";
    if (!(parentHash === "none" || HASH.test(parentHash))) return json({ error: "Invalid parent hash" }, 400);
    if (!DEVICE_ID.test(deviceId)) return json({ error: "Invalid device id" }, 400);

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SAVE_BYTES) {
        return json({ error: "Save snapshot must be between 1 byte and 32 MiB" }, bytes.byteLength ? 413 : 400);
    }
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return json({ error: "Save snapshot is not a ZIP archive" }, 400);
    const hash = sha256(bytes);
    const userDir = sha256(userId).slice(0, 32);
    const snapshotId = randomUUID();
    const objectKey = `${userDir}/${containerId}/${snapshotId}.zip`;
    const finalPath = objectPath(objectKey);
    const tempPath = objectPath(`.tmp/${snapshotId}.upload`);

    await mkdir(path.dirname(tempPath), { recursive: true });
    await mkdir(path.dirname(finalPath), { recursive: true });
    await writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });

    const client = await dbPool.connect();
    let committedObject = false;
    try {
        await client.query("BEGIN");
        // A row lock cannot serialize the very first upload because no head row exists yet.
        // Pairwise advisory locking closes that race without a global upload bottleneck.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [userId, containerId]);
        const head = await currentHead(client, userId, containerId);
        const actualParent = head?.sha256 ?? "none";
        if (actualParent !== parentHash) {
            await client.query("ROLLBACK");
            return json({
                error: "Cloud save changed since the last sync",
                conflict: true,
                remoteHash: actualParent,
            }, 409);
        }
        if (head?.sha256 === hash) {
            await client.query("ROLLBACK");
            return json({ hash, unchanged: true });
        }

        const existing = await client.query<{ id: string; object_key: string }>(
            `SELECT id, object_key FROM orthros_save_snapshots
              WHERE user_id = $1 AND container_id = $2 AND sha256 = $3`,
            [userId, containerId, hash],
        );
        let activeSnapshotId = existing.rows[0]?.id;
        if (!activeSnapshotId) {
            await rename(tempPath, finalPath);
            committedObject = true;
            await client.query(
                `INSERT INTO orthros_save_snapshots
                    (id, user_id, container_id, sha256, size_bytes, object_key, device_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [snapshotId, userId, containerId, hash, bytes.byteLength, objectKey, deviceId],
            );
            activeSnapshotId = snapshotId;
        }
        await client.query(
            `INSERT INTO orthros_save_heads (user_id, container_id, snapshot_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, container_id) DO UPDATE
               SET snapshot_id = EXCLUDED.snapshot_id, updated_at = now()`,
            [userId, containerId, activeSnapshotId],
        );
        await client.query("COMMIT");
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* connection failed */ }
        if (committedObject) {
            try { await unlink(finalPath); } catch { /* best effort */ }
        }
        throw error;
    } finally {
        client.release();
        try { await unlink(tempPath); } catch { /* renamed or already removed */ }
    }

    void pruneSnapshots(userId, containerId).catch((error) => {
        console.warn(`Cloud-save retention cleanup failed for ${containerId}:`, error);
    });
    return json({ hash, unchanged: false }, 201);
}

/** Same-origin, cookie-authenticated cloud-save API. Returns null when the route is unrelated. */
export async function handleSaveApi(req: Request, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith("/api/saves")) return null;

    const user = await sessionUser(req);
    if (!user) return json({ error: "Authentication required" }, 401);

    if (url.pathname === "/api/saves" && req.method === "GET") return listSaves(user.id);
    const match = /^\/api\/saves\/([^/]+)$/.exec(url.pathname);
    if (!match) return json({ error: "Not found" }, 404);
    const containerId = safeContainerId(match[1]);
    if (!containerId) return json({ error: "Invalid game container id" }, 400);

    if (req.method === "GET") return downloadSave(user.id, containerId);
    if (req.method === "PUT") return uploadSave(req, user.id, containerId);
    return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
}
