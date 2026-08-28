/// <reference types="vite/client" />

/** Short git commit of the build, injected by vite `define` (see vite.config.ts). */
declare const __BUILD_SHA__: string;

/** Content hash of public/v86.wasm, injected by Vite for cache busting. */
declare const __V86_WASM_SHA__: string;
