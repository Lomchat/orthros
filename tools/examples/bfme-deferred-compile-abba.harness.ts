import { harness } from "../harness";

const order = [false, true, true, false];
const windows: Array<{
    enabled: boolean;
    elapsedMs: number;
    perf: unknown;
    jit: unknown;
}> = [];

let failure: unknown = null;
let restored: unknown = null;
try {
    for (const enabled of order) {
        const startedAt = performance.now();
        const result = await harness()
            .call("dbgCall", "jitDeferredCompileQueue", enabled)
            .call("dbgCall", "jitCompileStats", true)
            .perfProfile({ enable: true, reset: true })
            .sleep(20_000)
            .perfStats()
            .call("dbgCall", "jitCompileStats")
            .run();
        if (!result.ok) throw new Error(`A/B window failed (deferred compile ${enabled ? "on" : "off"})`);
        const perf = result.steps.find(step => step.cmd === "perfStats")?.result ?? null;
        const jit = [...result.steps].reverse().find(step => step.cmd === "dbgCall")?.result ?? null;
        windows.push({
            enabled,
            elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
            perf,
            jit,
        });
    }
}
catch (error) {
    failure = error instanceof Error ? error.message : String(error);
}
finally {
    restored = await harness()
        .call("dbgCall", "jitDeferredCompileQueue", false)
        .sleep(5_000)
        .call("dbgCall", "shadowDiff")
        .faults(20)
        .run();
}

console.log(JSON.stringify({ windows, failure, restored }, null, 2));
if (failure || !(restored as { ok?: boolean } | null)?.ok) process.exit(1);
