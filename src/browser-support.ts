// Capability-based browser-support gate for the host shell.

export type BrowserSupportInfo = {
  supported: boolean;
  detectedBrowser: string;
  /** Human-readable names of required capabilities that are missing. */
  missing: string[];
};

/**
 * Purely informational browser-name guess for diagnostics/UI copy — NOT a gate.
 * The actual support decision is capability-based (see detectBrowserSupport).
 */
export function detectBrowserName(): string {
  if (typeof navigator === "undefined") return "Unknown";
  const ua = navigator.userAgent ?? "";
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }> };
  };
  const brandNames = nav.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const hasBrand = (re: RegExp) => brandNames.some((b) => re.test(b));

  if (/Edg\//i.test(ua) || hasBrand(/Edge/i)) return "Microsoft Edge";
  if (/OPR\//i.test(ua) || hasBrand(/Opera/i)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua) && !/CriOS\//i.test(ua)) return "Safari";
  if (hasBrand(/Google Chrome/i)) return "Google Chrome";
  if (/Chrome\//i.test(ua) || /CriOS\//i.test(ua) || hasBrand(/^Chromium$/i)) return "Chromium-based browser";
  return "Unknown browser";
}

/**
 * Capability-based gate (Prime Directive: generic, no browser-name hacks). We require the
 * actual Web APIs the emulator can't run without, and report exactly which one is missing —
 * so any browser that ships them (Chrome, Safari 26+, …) passes automatically, and any that
 * lacks one fails with an honest reason instead of "use Chrome".
 *
 * NOTE: these are synchronous presence checks. WebGPU adapter acquisition and OPFS
 * createSyncAccessHandle are async and can still fail later on a browser that advertises the
 * top-level API; the backend surfaces those at init time. This gate only catches the
 * outright-absent case up front.
 */
export function detectBrowserSupport(): BrowserSupportInfo {
  const detectedBrowser = detectBrowserName();
  if (typeof navigator === "undefined") {
    // SSR / non-browser context — don't block; the real check runs client-side.
    return { supported: true, detectedBrowser, missing: [] };
  }

  const missing: string[] = [];

  // WebGPU — entire rendering backend (ddraw/d3d8/d3d9/glide/opengl/postfx) is WebGPU.
  if (!("gpu" in navigator)) missing.push("WebGPU (navigator.gpu)");

  // OPFS — the virtual filesystem lives in Origin Private File System.
  const storage = (navigator as Navigator & {
    storage?: { getDirectory?: unknown };
  }).storage;
  if (typeof storage?.getDirectory !== "function") missing.push("OPFS (navigator.storage.getDirectory)");

  // SharedArrayBuffer under cross-origin isolation — input/audio ring buffers depend on it.
  if (typeof SharedArrayBuffer === "undefined") {
    missing.push("SharedArrayBuffer");
  } else if (typeof crossOriginIsolated !== "undefined" && !crossOriginIsolated) {
    missing.push("cross-origin isolation (COOP/COEP headers)");
  }

  // OffscreenCanvas — the render target is transferred to the worker.
  if (typeof OffscreenCanvas === "undefined") missing.push("OffscreenCanvas");

  // AudioWorklet — the audio pump runs in an AudioWorkletProcessor.
  if (typeof AudioWorklet === "undefined") missing.push("AudioWorklet");

  return { supported: missing.length === 0, detectedBrowser, missing };
}
