import { betterAuth } from "better-auth";
import { dbPool } from "./database";

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

export const authBaseUrl = required("BETTER_AUTH_URL").replace(/\/$/, "");
export const authTrustedOrigins = Array.from(new Set([
    new URL(authBaseUrl).origin,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => new URL(value).origin),
]));
export const auth = betterAuth({
    appName: "Orthros",
    database: dbPool,
    baseURL: authBaseUrl,
    secret: required("BETTER_AUTH_SECRET"),
    trustedOrigins: authTrustedOrigins,
    emailAndPassword: {
        enabled: true,
        minPasswordLength: 10,
        maxPasswordLength: 128,
    },
    rateLimit: {
        enabled: true,
        storage: "database",
        window: 60,
        max: 100,
        customRules: {
            "/sign-in/email": { window: 60, max: 10 },
            "/sign-up/email": { window: 60, max: 5 },
        },
    },
    advanced: {
        // The Bun origin listens on loopback only; Caddy is the sole caller and supplies XFF.
        // Declaring that narrow proxy boundary gives every public client its own rate-limit key.
        ipAddress: {
            ipAddressHeaders: ["x-forwarded-for"],
            trustedProxies: ["127.0.0.1", "::1"],
        },
    },
});
