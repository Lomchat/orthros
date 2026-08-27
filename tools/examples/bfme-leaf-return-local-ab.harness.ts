import { harness } from "../harness";

const rows: unknown[] = [];

for (const enabled of [false, true, false, true]) {
    const warmed = await harness()
        .call("dbgCall", "jitcfg", 28, enabled ? 1 : 0)
        .sleep(20_000)
        .perfProfile({ enable: true, reset: true })
        .sleep(15_000)
        .run();
    if (!warmed.ok) throw new Error(`warmup failed for leafReturnLocal=${enabled}`);

    const measured = await harness()
        .perfStats()
        .call("dbgCall", "jitLeafCallFusion")
        .call("dbgCall", "shadowDiff")
        .faults(20)
        .run();
    rows.push({
        enabled,
        perf: measured.steps.find(step => step.cmd === "perfStats")?.result,
        fusion: measured.steps.find(step => step.cmd === "dbgCall")?.result,
        shadow: measured.steps.filter(step => step.cmd === "dbgCall")[1]?.result,
        faults: measured.steps.find(step => step.cmd === "faults")?.result,
    });
}

console.log(JSON.stringify(rows, null, 2));
