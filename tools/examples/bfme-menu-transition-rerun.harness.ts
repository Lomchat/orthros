import { harness } from "../harness";

const trace = process.env.BFME_TRACE !== "0";
const hot = process.env.BFME_HOT === "1";
const traceAddr = process.env.BFME_TRACE_ADDR;
const fastmemWrites = process.env.BFME_FASTMEM_WRITES;

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

if (fastmemWrites === "0" || fastmemWrites === "1") {
    await harness()
        .call("dbgCall", "fastmemWrites", fastmemWrites === "1")
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
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true);
if (trace) {
    middle
        .call("dbgCall", "trace2Reset");
    if (traceAddr) middle.call("dbgCall", "trace2Watch", traceAddr);
    else middle.call("dbgCall", "trace2WatchTier2", 64);
}
if (hot) middle.call("dbgCall", "hotJit", 2_500, 2, 80, 1);
else middle.sleep(2_500);
if (trace) middle.call("dbgCall", "trace2UnwatchAll");
middle
    .perfStats()
    .perfSpikes({ top: 8, minMs: 35 })
    .profilerStats({ top: 20, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "gdiDibSyncDiag", false, false)
    .call("dbgCall", "gdiDibSyncReport");
if (trace) {
    middle
        .call("dbgCall", "trace2PageHistogram")
        .call("dbgCall", "trace2Blocks", 50);
}
middle
    .call("dbgCall", "fastmemWriteAudit")
    .faults(10)
const middleRun = await middle.run();
const dbgResults = middleRun.steps.filter((step: any) => step.cmd === "dbgCall").map((step: any) => step.result);
console.log(JSON.stringify({
    phase: "skirmish-2-4.5s",
    fastmemWrites: fastmemWrites ?? null,
    perf: resultFor(middleRun, "perfStats"),
    jit: dbgResults.find((value: any) => value && typeof value === "object" && "started" in value),
    hot: dbgResults.find((value: any) => value && typeof value === "object" && Array.isArray(value.rows)),
    audit: dbgResults.find((value: any) => value && typeof value === "object" && "danger" in value),
    tracePages: dbgResults.find((value: any) => Array.isArray(value) && value.some((row: any) => row && "page" in row)),
    traceBlocks: dbgResults.find((value: any) => Array.isArray(value) && value.some((row: any) => row && "addr" in row && "exec" in row)),
    spikes: resultFor(middleRun, "perfSpikes"),
    profiler: resultFor(middleRun, "profilerStats"),
    faults: resultFor(middleRun, "faults"),
}, null, 2));
