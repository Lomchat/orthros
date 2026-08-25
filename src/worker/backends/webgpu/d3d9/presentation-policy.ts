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
