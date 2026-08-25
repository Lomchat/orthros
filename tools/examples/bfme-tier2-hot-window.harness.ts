import { harness } from "../harness";

const mode = (process.env.BFME_TIER2_MODE ?? "profiled") === "profiled" ? "profiled" : "legacy";
const warmMs = Number(process.env.BFME_TIER2_WARM_MS ?? 180_000);

const result = await harness()
    .call("dbgCall", "jitTier2Regions", mode === "profiled")
    .sleep(warmMs)
    .perfProfile({ enable: true, reset: true })
    .sleep(30_000)
    .perfStats()
    .call("dbgCall", "tier2Stats")
    .call("dbgCall", "shadowDiff")
    .faults(20)
    .run();

console.log(JSON.stringify({ mode, warmMs, result }, null, 2));
if (!result.ok) process.exit(1);
