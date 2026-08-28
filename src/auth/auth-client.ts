import { createAuthClient } from "better-auth/react";

/** Same-origin client: credentials stay in Secure, HttpOnly cookies managed by Better Auth. */
export const authClient = createAuthClient();

