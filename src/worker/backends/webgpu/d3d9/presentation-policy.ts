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
