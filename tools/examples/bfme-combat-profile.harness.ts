import { harness } from "../harness";

const seconds = Math.max(5, Number(process.env.BFME_COMBAT_PROFILE_SECONDS ?? 15));

// Short, bounded capture for a live skirmish. trace2 is armed only for the
// requested window and de-instrumented before the readout so subsequent FPS
// comparisons on the same simulation are not contaminated by tracing.
const result = await harness()
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "trace2Reset")
    .call("dbgCall", "trace2WatchTier2", 64)
    .sleep(seconds * 1_000)
    .call("dbgCall", "trace2UnwatchAll")
    .perfStats()
    .perfSpikes({ top: 20, minMs: 40 })
    .profilerStats({ top: 40, sort: "total" })
    .call("dbgCall", "trace2Stats")
    .call("dbgCall", "trace2PageHistogram")
    .call("dbgCall", "trace2Blocks", 80)
    .call("dbgCall", "trace2Indirects", 80)
    .call("dbgCall", "tier2Stats")
    .call("dbgCall", "shadowDiff")
    .faults(20)
    .run();

console.log(JSON.stringify({ seconds, result }, null, 2));
if (!result.ok) process.exit(1);
