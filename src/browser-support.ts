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

/**
 * Result of the async WebGPU probe. `stage` says how far adapter/device acquisition got;
 * `reason` is user-facing prose; `hints` are actionable remediation lines. The whole render
 * backend (ddraw/d3d8/d3d9/glide/opengl/postfx) is WebGPU, so a failure here means NO game can
 * run — but the outright-absent case is the only one detectBrowserSupport() catches. This probe
 * closes the gap the sync gate flags in its NOTE: `navigator.gpu` can be present while
 * requestAdapter() still yields null (hardware acceleration off, GPU blocklisted, VM/RDP with no
 * GPU) — which otherwise only surfaced deep inside CreateDevice as a swallowed D3DERR_INVALIDCALL
 * and a silent guest exit ("no crash logs").
 */
export type WebGPUProbeStage = "ok" | "no-api" | "no-adapter" | "no-device";
export type WebGPUProbeResult = {
  ok: boolean;
  stage: WebGPUProbeStage;
  reason: string;
  hints: string[];
  /** Adapter identity when we got one — diagnostics only. */
  adapter?: { vendor?: string; architecture?: string; device?: string; description?: string };
};

// Remediation for the "present but no usable GPU" family. Backtick-wrapped tokens (`code`) are
// rendered as inline code spans by the host overlay — reserve them for literal URLs/identifiers
// the user types or opens, not prose.
function webgpuAdapterHints(): string[] {
  return [
    "Enable hardware acceleration in your browser (Chrome/Edge: Settings → System → \"Use graphics acceleration when available\", then relaunch).",
    "Open `chrome://gpu` — the \"WebGPU\" row should read \"Hardware accelerated\". If it names a problem, that's the cause.",
    "Update your graphics driver — an outdated or blocklisted GPU driver is the most common reason no adapter is offered.",
    "Remote Desktop / a VM / a headless session often has no GPU for WebGPU to bind to — try a local session.",
  ];
}

async function readAdapterInfo(adapter: GPUAdapter): Promise<WebGPUProbeResult["adapter"]> {
  try {
    // Current spec: adapter.info (sync getter). Older builds: requestAdapterInfo().
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info
      ?? (await (adapter as GPUAdapter & { requestAdapterInfo?: () => Promise<GPUAdapterInfo> })
        .requestAdapterInfo?.());
    if (!info) return undefined;
    return {
      vendor: info.vendor || undefined,
      architecture: info.architecture || undefined,
      device: info.device || undefined,
      description: info.description || undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Actually acquire a WebGPU adapter + device (mirrors WebGPUBackend.initialize, which requires no
 * mandatory features — so this never false-negatives on an adapter the backend would accept).
 * Returns a precise, user-facing reason on failure instead of letting it degrade into a D3DERR.
 */
export async function probeWebGPU(): Promise<WebGPUProbeResult> {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) {
    return {
      ok: false,
      stage: "no-api",
      reason: "This browser does not expose the WebGPU API (`navigator.gpu`), which Orthros's entire graphics backend is built on.",
      hints: [
        "Use an up-to-date Google Chrome or Microsoft Edge, or Safari 26+.",
        "Firefox does not yet enable WebGPU by default.",
      ],
    };
  }

  const gpu = (navigator as Navigator & { gpu: GPU }).gpu;
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (e) {
    return {
      ok: false,
      stage: "no-adapter",
      reason: `WebGPU is present, but requesting a GPU adapter threw: ${e instanceof Error ? e.message : String(e)}.`,
      hints: webgpuAdapterHints(),
    };
  }
  if (!adapter) {
    return {
      ok: false,
      stage: "no-adapter",
      reason: "WebGPU is present, but the browser could not provide a GPU adapter — it found no usable GPU. This is almost always hardware acceleration being disabled, a blocklisted/outdated GPU driver, or running without a real GPU (VM/Remote Desktop).",
      hints: webgpuAdapterHints(),
    };
  }

  const info = await readAdapterInfo(adapter);
  try {
    // Mirror the backend: no required features so we test exactly what it would accept.
    const device = await adapter.requestDevice();
    device.destroy?.();
  } catch (e) {
    return {
      ok: false,
      stage: "no-device",
      reason: `A GPU adapter was found${info?.description ? ` (${info.description})` : ""}, but creating a WebGPU device failed: ${e instanceof Error ? e.message : String(e)}.`,
      hints: [...webgpuAdapterHints(), "This usually points to a GPU driver problem — update the driver and relaunch the browser."],
      adapter: info,
    };
  }

  return { ok: true, stage: "ok", reason: "WebGPU adapter and device acquired.", hints: [], adapter: info };
}
