import { describe, expect, test } from 'bun:test';

const repoUrl = new URL('../../', import.meta.url);

describe('v86 WASM cache identity', () => {
    test('injects the binary content hash and uses it in the production fetch', async () => {
        const vite = await Bun.file(new URL('vite.config.ts', repoUrl)).text();
        const worker = await Bun.file(new URL('src/worker/emulator.worker.ts', repoUrl)).text();

        expect(vite).toContain('createHash("sha256")');
        expect(vite).toContain('__V86_WASM_SHA__: JSON.stringify(V86_WASM_SHA)');
        expect(worker).toContain('encodeURIComponent(__V86_WASM_SHA__)');
        expect(worker).not.toContain('encodeURIComponent(workerRevision)');
    });
});
