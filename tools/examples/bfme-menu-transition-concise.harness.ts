import { harness } from "../harness";

function resultFor(run: any, cmd: string, occurrence = 0): any {
    return run.steps.filter((step: any) => step.cmd === cmd)[occurrence]?.result ?? null;
}

// Start on the settled skirmish setup screen. This intentionally reports only
// the compact data needed to identify the remaining transition hot spots: the
// full spike/profiler payload makes both the console output and this short phase
// unnecessarily noisy.
await harness()
    .keyHold(0x1b, 500)
    .sleep(3_000)
    .move(320, 575)
    .sleep(1_200)
    .call("clickHold", 320, 575, 700)
    .sleep(1_300)
    .run();

const middle = await harness()
    .call("dbgCall", "trace2Reset")
    .call("dbgCall", "trace2WatchTier2", 64)
    .perfProfile({ enable: true, reset: true })
    .sleep(2_500)
    .call("dbgCall", "trace2UnwatchAll")
    .perfStats()
    .call("dbgCall", "trace2PageHistogram")
    .call("dbgCall", "trace2Blocks", 1000)
    .faults(10)
    .run();

const dbg = middle.steps
    .filter((step: any) => step.cmd === "dbgCall")
    .map((step: any) => step.result);
const pages = Array.isArray(dbg.at(-2)) ? dbg.at(-2).slice(0, 15) : dbg.at(-2);
const allBlocks = dbg.at(-1);
const blocks = Array.isArray(allBlocks) ? allBlocks.slice(0, 40) : allBlocks;

console.log(JSON.stringify({
    perf: resultFor(middle, "perfStats"),
    pages,
    blocks,
    faults: resultFor(middle, "faults"),
}, null, 2));
