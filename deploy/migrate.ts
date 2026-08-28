import { readFile } from "node:fs/promises";
import path from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./auth";
import { dbPool } from "./database";

const lockId = 7_236_316_144;
const client = await dbPool.connect();

try {
    await client.query("SELECT pg_advisory_lock($1)", [lockId]);

    const authPlan = await getMigrations(auth.options);
    if (authPlan.unsafeChanges.length > 0) {
        throw new Error(`Unsafe Better Auth migration refused:\n${authPlan.unsafeChanges.join("\n")}`);
    }
    await authPlan.runMigrations();

    const appMigration = await readFile(
        path.join(import.meta.dir, "migrations", "001_cloud_saves.sql"),
        "utf8",
    );
    await client.query("BEGIN");
    try {
        await client.query(appMigration);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    console.log("Authentication and cloud-save migrations are current.");
} finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [lockId]); } catch { /* connection failed */ }
    client.release();
    await dbPool.end();
}

