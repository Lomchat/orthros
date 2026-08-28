import { Pool } from "pg";

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

/** One small pool shared by Better Auth and the save metadata API. */
export const dbPool = new Pool({
    connectionString: required("DATABASE_URL"),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

