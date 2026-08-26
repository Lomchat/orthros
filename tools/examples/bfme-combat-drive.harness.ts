import { harness } from "../harness";

// BFME runs in an 800x600 guest window centred at desktop (300,155). Its circular
// minimap is in the lower-left of the *game* window (roughly x=20..145,
// y=460..585), hence desktop x=320..445/y=615..740. `Q`, then attack-move (`A`)
// into the opposite minimap corner attempts to send every available combat unit
// across Dunharrow without modifying game data or memory. A 30 FPS/no-spike run
// means no representative combat occurred and must not be used as combat proof.
const result = await harness()
    .key("q")
    .sleep(1_000)
    .key("a")
    .sleep(600)
    .move(425, 640)
    .sleep(1_200)
    .call("clickHold", 425, 640, 500, 0)
    .sleep(120_000)
    .perfProfile({ enable: true, reset: true })
    .sleep(15_000)
    .perfStats()
    .perfSpikes({ top: 20, minMs: 40 })
    .call("dbgCall", "tier2Stats")
    .faults(20)
    .run();

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
