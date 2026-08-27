import { harness } from "../harness";

const order = [false, true, true, false, false, true];
const windows: Array<{ enabled: boolean; perf: unknown; jit: unknown }> = [];

// Diagnostic-only removal of BFME's 30 Hz wait branch. This exposes actual JIT
// throughput without changing production game timing; the original dword is
// restored before the harness exits.
let failure: unknown = null;
let restored: unknown = null;
try {
    const uncapped = await harness()
        .call("dbgCall", "poke32", 0x0046bf48, 0x9b8d21eb)
        .call("dbgCall", "jitClear")
        .sleep(20_000)
        .run();
    if (!uncapped.ok) throw new Error("failed to enter uncapped diagnostic mode");

    for (const enabled of order) {
        const result = await harness()
            .call("dbgCall", "jitDynamicChainSitePic", enabled)
            .sleep(20_000)
            .perfProfile({ enable: true, reset: true })
            .sleep(10_000)
            .perfStats()
            .call("dbgCall", "jitDynamicChainSitePic", enabled)
            .run();
        if (!result.ok) throw new Error(`A/B window failed (site PIC ${enabled ? "on" : "off"})`);
        const perf = result.steps.find(step => step.cmd === "perfStats")?.result ?? null;
        const jit = [...result.steps].reverse().find(step => step.cmd === "dbgCall")?.result ?? null;
        windows.push({ enabled, perf, jit });
    }
}
catch (error) {
    failure = error instanceof Error ? error.message : String(error);
}
finally {
    // Restore both production defaults even if a CDP window or assertion fails.
    restored = await harness()
        .call("dbgCall", "jitDynamicChainSitePic", true)
        .call("dbgCall", "poke32", 0x0046bf48, 0x9b8d2173)
        .call("dbgCall", "jitClear")
        .sleep(5_000)
        .call("dbgCall", "shadowDiff")
        .faults(20)
        .run();
}

console.log(JSON.stringify({ windows, failure, restored }, null, 2));
if (failure || !(restored as { ok?: boolean } | null)?.ok) process.exit(1);
