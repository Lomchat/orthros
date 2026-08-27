import { harness } from "../harness";

const rows: unknown[] = [];

// Revisit the production budget between larger candidates so the evolving AI
// load cannot systematically favor the last value in the run.
for (const maxInstructions of [4, 8, 4, 16, 4]) {
    const warmed = await harness()
        .call("dbgCall", "jitcfg", 29, maxInstructions)
        .sleep(20_000)
        .perfProfile({ enable: true, reset: true })
        .sleep(15_000)
        .run();
    if (!warmed.ok) throw new Error(`warmup failed for maxInstructions=${maxInstructions}`);

    const measured = await harness()
        .perfStats()
        .call("dbgCall", "shadowDiff")
        .faults(20)
        .run();
    rows.push({
        maxInstructions,
        perf: measured.steps.find(step => step.cmd === "perfStats")?.result,
        shadow: measured.steps.find(step => step.cmd === "dbgCall")?.result,
        faults: measured.steps.find(step => step.cmd === "faults")?.result,
    });
}

console.log(JSON.stringify(rows, null, 2));
