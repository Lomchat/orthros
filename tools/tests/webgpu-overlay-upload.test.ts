import { describe, expect, test } from 'bun:test';
import { WebGPUBackend } from '../../src/worker/backends/webgpu/webgpu-backend';

describe('WebGPU overlay external-image upload', () => {
    test('turns a transient Chromium source rejection into a skipped overlay', () => {
        const previousUsage = (globalThis as any).GPUTextureUsage;
        (globalThis as any).GPUTextureUsage = {
            TEXTURE_BINDING: 1,
            COPY_DST: 2,
            RENDER_ATTACHMENT: 4,
        };
        try {
            const backend = new WebGPUBackend() as any;
            const texture = { width: 800, height: 600, createView: () => ({}) };
            backend.device = { createTexture: () => texture };
            backend.queue = {
                copyExternalImageToTexture: () => {
                    throw new TypeError('Failed to copy content from external image');
                },
            };
            expect(backend.updateOverlayTexture({ width: 800, height: 600 })).toBe(false);
            expect(backend.overlayExternalCopyFailures).toBe(1);

            backend.queue.copyExternalImageToTexture = () => undefined;
            expect(backend.updateOverlayTexture({ width: 800, height: 600 })).toBe(true);
        } finally {
            (globalThis as any).GPUTextureUsage = previousUsage;
        }
    });
});
