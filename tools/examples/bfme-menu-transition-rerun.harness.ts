import { harness } from "../harness";

function resultFor(run: any, cmd: string, occurrence = 0): any {
    return run.steps.filter((step: any) => step.cmd === cmd)[occurrence]?.result ?? null;
}

const retSpec = process.env.BFME_RET_SPEC;
if (retSpec === "0" || retSpec === "1") {
    await harness()
        .call("dbgCall", "jitRetSpec", retSpec === "1", 128)
        .sleep(8_000)
        .run();
}

// Start on the settled skirmish setup screen. Escape returns to the Solo menu,
// allowing fast repeated A/B runs without rebooting the game for four minutes.
const back = await harness()
    .keyHold(0x1b, 500)
    .sleep(3_000)
    .perfProfile({ enable: true, reset: true })
    .sleep(2_000)
    .perfStats()
    .faults(10)
    .run();
console.log(JSON.stringify({
    phase: "solo-after-back",
    perf: resultFor(back, "perfStats"),
    faults: resultFor(back, "faults"),
}, null, 2));

const early = await harness()
    .move(320, 575)
    .sleep(1_200)
    .call("dbgCall", "gdiDibSyncDiag", true, true)
    .perfProfile({ enable: true, reset: true })
    .call("clickHold", 320, 575, 700)
    .sleep(1_300)
    .perfStats()
    .run();
console.log(JSON.stringify({
    phase: "skirmish-0-2s",
    perf: resultFor(early, "perfStats"),
}, null, 2));

const middle = await harness()
    .call("dbgCall", "trace2Reset")
    .call("dbgCall", "trace2WatchTier2", 64)
    .perfProfile({ enable: true, reset: true })
    .sleep(2_500)
    .call("dbgCall", "trace2UnwatchAll")
    .perfStats()
    .perfSpikes({ top: 8, minMs: 35 })
    .profilerStats({ top: 20, sort: "total" })
    .call("dbgCall", "gdiDibSyncDiag", false, false)
    .call("dbgCall", "gdiDibSyncReport")
    .call("dbgCall", "trace2PageHistogram")
    .call("dbgCall", "trace2Blocks", 50)
    .faults(10)
    .run();
const dbgResults = middle.steps.filter((step: any) => step.cmd === "dbgCall").map((step: any) => step.result);
console.log(JSON.stringify({
    phase: "skirmish-2-4.5s",
    perf: resultFor(middle, "perfStats"),
    spikes: resultFor(middle, "perfSpikes"),
    profiler: resultFor(middle, "profilerStats"),
    gdi: dbgResults[dbgResults.length - 3],
    pages: dbgResults[dbgResults.length - 2],
    blocks: dbgResults[dbgResults.length - 1],
    faults: resultFor(middle, "faults"),
}, null, 2));
