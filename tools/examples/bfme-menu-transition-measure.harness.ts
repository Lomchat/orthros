import { harness } from "../harness";

function resultFor(run: any, cmd: string, occurrence = 0): any {
    return run.steps.filter((step: any) => step.cmd === cmd)[occurrence]?.result ?? null;
}

await harness().keyHold(0x1b, 500).sleep(3_000).move(320, 575).sleep(1_200).run();

const early = await harness()
    .perfProfile({ enable: true, reset: true })
    .call("clickHold", 320, 575, 700)
    .sleep(800)
    .perfStats()
    .run();

const middle = await harness()
    .perfProfile({ enable: true, reset: true })
    .sleep(2_500)
    .perfStats()
    .run();

const late = await harness()
    .perfProfile({ enable: true, reset: true })
    .sleep(5_000)
    .perfStats()
    .call("dbgCall", "hleReport")
    .call("dbgCall", "shadowDiff")
    .faults(20)
    .run();

const dbg = late.steps.filter((step: any) => step.cmd === "dbgCall").map((step: any) => step.result);
console.log(JSON.stringify({
    early: resultFor(early, "perfStats"),
    middle: resultFor(middle, "perfStats"),
    late: resultFor(late, "perfStats"),
    hle: dbg[0],
    shadows: dbg[1],
    faults: resultFor(late, "faults"),
}, null, 2));
