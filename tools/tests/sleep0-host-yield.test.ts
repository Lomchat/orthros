import { describe, expect, test } from 'bun:test';

const repoUrl = new URL('../../', import.meta.url);

describe('Sleep(0) host-yield storm guard', () => {
    test('lets a sole-runnable Sleep(0) storm escape WASM after a bounded burst', async () => {
        const source = await Bun.file(new URL('vendor/v86/src/rust/cpu/hypercall.rs', repoUrl)).text();

        expect(source).toContain('limit.saturating_mul(64)');
        expect(source).toContain('if effective_limit > 0 && counter < effective_limit');
        expect(source).toContain('*counter_ptr = 0;');
    });

    test('does not swallow the deliberate WASM fallthrough in a second TS fast path', async () => {
        const source = await Bun.file(new URL('src/worker/modules/kernel32/time/time.ts', repoUrl)).text();

        expect(source).not.toContain("registerFastPath('kernel32', 'Sleep'");
        expect(source).toContain("exports['Sleep']");
        expect(source).toContain('sched.sleepWithContext');
    });

    test('services sole-runnable Sleep immediately and keeps positive sleeps wall-paced', async () => {
        const source = await Bun.file(new URL('src/worker/core/scheduler/scheduler.ts', repoUrl)).text();
        const shortSleep = source.slice(
            source.indexOf('this.sleepPathStats.soleRunnableYield++'),
            source.indexOf('if (ms !== INFINITE) {', source.indexOf('this.sleepPathStats.soleRunnableYield++')),
        );

        expect(shortSleep).toContain('this.requestYieldToHost(ms, "sleepN");');
        expect(shortSleep).toContain('preemptionManager.requestImmediateExit();');
        expect(source).toContain('yieldSource !== "sleepN" && this.yieldPort');
    });
});
