import { harness } from "../harness";

const rows: unknown[] = [];
for (const enabled of [false, true, true, false]) {
    await harness()
        .call("dbgCall", "jitRetSpec", enabled, 128)
        .sleep(8_000)
        .keyHold(0x1b, 500)
        .sleep(3_000)
        .move(320, 575)
        .sleep(1_200)
        .call("clickHold", 320, 575, 700)
        .sleep(1_300)
        .perfProfile({ enable: true, reset: true })
        .sleep(2_500)
        .run();
    const measured = await harness().perfStats().faults(10).run();
    rows.push({
        enabled,
        perf: measured.steps.find(step => step.cmd === "perfStats")?.result,
        faults: measured.steps.find(step => step.cmd === "faults")?.result,
    });
}
console.log(JSON.stringify(rows, null, 2));
