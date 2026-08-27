import { harness } from "../harness";

const seconds = Math.max(15, Number(process.env.BFME_ACTION_SECONDS ?? 120));

// Capture the transient itself, not merely the warm state after it. The frame
// profiler retains the five worst frames across the whole armed interval while
// the other counters show whether those stalls coincided with JIT compilation,
// new D3D9 pipelines/resources, or ordinary guest execution.
const armed = await harness()
    .call("stopLogs")
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true)
    .call("dbgCall", "d3d9Perf", true)
    .run();

if (!armed.ok) {
    console.log(JSON.stringify({ phase: "armed", result: armed }, null, 2));
    process.exit(1);
}

// Select all units and issue an attack-move toward the opposite Dunharrow
// minimap corner. Even when no battle occurs, the ensuing AI simulation is a
// useful bounded window for construction/animation spikes.
const action = await harness()
    .key("q")
    .sleep(1_000)
    .key("a")
    .sleep(600)
    .move(125, 485)
    .sleep(1_200)
    .call("clickHold", 125, 485, 500, 0)
    .sleep(seconds * 1_000)
    .perfStats()
    .perfSpikes({ top: 20, minMs: 40 })
    .profilerStats({ top: 50, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "d3d9Perf")
    .call("dbgCall", "tier2Stats")
    .call("dbgCall", "shadowDiff")
    .faults(20)
    .run();

console.log(JSON.stringify({ seconds, action }, null, 2));
if (!action.ok) process.exit(1);
