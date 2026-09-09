/**
 * Choose the D3D9 presentation path without risking Chromium's software/headless
 * WebGPU implementation. A real browser GPU should present its swapchain directly;
 * HeadlessChrome keeps the CPU/ImageBitmap bridge used by automated VPS tests.
 */
export function shouldUseDirectD3D9Presentation(
    override: unknown,
    userAgent: string,
): boolean {
    if (typeof override === "boolean") return override;
    return !/HeadlessChrome/i.test(userAgent);
}

/**
 * Usage contract for the D3D9 offscreen framebuffer. Both presentation paths
 * consume the same texture: the headless bridge copies from it, while desktop
 * presentation samples it through WebGPUBackend.drawTexture into the swapchain.
 */
export function d3d9PresentSourceTextureUsage(usage: {
    readonly COPY_SRC: GPUTextureUsageFlags;
    readonly RENDER_ATTACHMENT: GPUTextureUsageFlags;
    readonly TEXTURE_BINDING: GPUTextureUsageFlags;
}): GPUTextureUsageFlags {
    return usage.COPY_SRC | usage.RENDER_ATTACHMENT | usage.TEXTURE_BINDING;
}

/**
 * Back-off of the CPU readback presentation path. A readback that never completes
 * (map or bitmap timeout) must not be re-queued every frame: each attempt leaves a
 * pending map request alive inside the GPU process beyond its timeout, and their
 * accumulation slows every later queue submission. After three consecutive
 * timeouts the path pauses 30 s, doubling per further failure up to five minutes;
 * a completed readback clears the streak.
 */
export const CPU_PRESENT_BACKOFF_AFTER = 3;
export const CPU_PRESENT_BACKOFF_BASE_MS = 30_000;
export const CPU_PRESENT_BACKOFF_MAX_MS = 300_000;

export function cpuPresentBackoffMs(consecutiveTimeouts: number): number {
    if (consecutiveTimeouts < CPU_PRESENT_BACKOFF_AFTER) return 0;
    const doublings = consecutiveTimeouts - CPU_PRESENT_BACKOFF_AFTER;
    return Math.min(CPU_PRESENT_BACKOFF_MAX_MS, CPU_PRESENT_BACKOFF_BASE_MS * 2 ** Math.min(doublings, 8));
}
