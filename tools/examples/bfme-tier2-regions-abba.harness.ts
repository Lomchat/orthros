import { harness } from "../harness";

const rows: unknown[] = [];

for (const enabled of [false, true, true, false]) {
    const warmed = await harness()
        .call("dbgCall", "jitTier2Regions", enabled)
        .sleep(45_000)
        .perfProfile({ enable: true, reset: true })
        .sleep(20_000)
        .run();
    if (!warmed.ok) throw new Error(`warmup failed for regions=${enabled}`);

    const measured = await harness()
        .perfStats()
        .call("dbgCall", "tier2Stats")
        .call("dbgCall", "shadowDiff")
        .faults(20)
        .run();
    rows.push({
        enabled,
        perf: measured.steps.find(step => step.cmd === "perfStats")?.result,
        tier2: measured.steps.find(step => step.cmd === "dbgCall")?.result,
        shadow: measured.steps.filter(step => step.cmd === "dbgCall")[1]?.result,
        faults: measured.steps.find(step => step.cmd === "faults")?.result,
    });
}

console.log(JSON.stringify(rows, null, 2));
