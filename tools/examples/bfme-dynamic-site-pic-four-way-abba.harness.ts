import { harness } from "../harness";

const order = [false, true, true, false, false, true];
const windows: Array<{ enabled: boolean; perf: unknown }> = [];
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
            .call("dbgCall", "jitDynamicChainSitePicFourWay", enabled)
            .perfProfile({ enable: true, reset: true })
            .sleep(10_000)
            .perfStats()
            .run();
        if (!result.ok) throw new Error(`A/B window failed (four way ${enabled ? "on" : "off"})`);
        windows.push({
            enabled,
            perf: result.steps.find(step => step.cmd === "perfStats")?.result ?? null,
        });
    }
}
catch (error) {
    failure = error instanceof Error ? error.message : String(error);
}
finally {
    restored = await harness()
        .call("dbgCall", "jitDynamicChainSitePicFourWay", true)
        .call("dbgCall", "poke32", 0x0046bf48, 0x9b8d2173)
        .call("dbgCall", "jitClear")
        .sleep(5_000)
        .call("dbgCall", "shadowDiff")
        .faults(20)
        .run();
}

console.log(JSON.stringify({ windows, failure, restored }, null, 2));
if (failure || !(restored as { ok?: boolean } | null)?.ok) process.exit(1);
