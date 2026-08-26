import { harness } from "../harness";

// Profiles the two menu transitions that the long skirmish benchmark used to
// hide behind fixed sleeps. Run against an already booted main menu with
// BFME_SKIP_BOOT=1, or let this script load BFME and wait for the main menu.
const bundle = "/apps/bfme.wgb";
const skipBoot = process.env.BFME_SKIP_BOOT === "1";
const trace = process.env.BFME_TRACE === "1";

function print(phase: string, result: unknown): void {
    console.log(JSON.stringify({ phase, result }, null, 2));
}

if (!skipBoot) {
    const opened = await harness()
        .openWgb(bundle)
        .audioGesture()
        .watchFrames(true)
        .run();
    print("opened", opened);
    if (!opened.ok) process.exit(1);

    const settled = await harness().sleep(240_000).run();
    print("main-menu-settled", settled);
    if (!settled.ok) process.exit(1);
}

const baseline = await harness()
    .perfProfile({ enable: true, reset: true })
    .sleep(3_000)
    .perfStats()
    .perfSpikes({ top: 12, minMs: 35 })
    .run();
print("main-menu-baseline", baseline);
if (!baseline.ok) process.exit(1);

// D3D9 exclusive mode now synchronizes the Win32 desktop to the 800x600 game
// surface, so these are direct game-screen coordinates. Holding the click spans
// several DirectInput polls even if the transition itself becomes slow.
const solo = await harness()
    .move(90, 575)
    .sleep(1_200)
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true)
    .call("clickHold", 90, 575, 700)
    .sleep(1_300)
    .perfStats()
    .perfSpikes({ top: 12, minMs: 35 })
    .profilerStats({ top: 30, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "tier2Stats")
    .run();
print("solo-transition-0-2s", solo);
if (!solo.ok) process.exit(1);

const soloSettled = await harness()
    .perfProfile({ enable: true, reset: true })
    .sleep(4_000)
    .perfStats()
    .perfSpikes({ top: 12, minMs: 35 })
    .run();
print("solo-screen-2-6s", soloSettled);
if (!soloSettled.ok) process.exit(1);

const skirmishEarly = await harness()
    .move(320, 575)
    .sleep(1_200)
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true)
    .call("clickHold", 320, 575, 700)
    .sleep(800)
    .perfStats()
    .perfSpikes({ top: 16, minMs: 35 })
    .profilerStats({ top: 40, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "tier2Stats")
    .run();
print("skirmish-transition-0-1.5s", skirmishEarly);
if (!skirmishEarly.ok) process.exit(1);

const skirmishMiddleChain = harness();
if (trace) {
    skirmishMiddleChain
        .call("dbgCall", "trace2Reset")
        .call("dbgCall", "trace2WatchTier2", 64);
}
skirmishMiddleChain
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true)
    .sleep(2_500);
if (trace) skirmishMiddleChain.call("dbgCall", "trace2UnwatchAll");
skirmishMiddleChain
    .perfStats()
    .perfSpikes({ top: 16, minMs: 35 })
    .profilerStats({ top: 40, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "tier2Stats");
if (trace) {
    skirmishMiddleChain
        .call("dbgCall", "trace2Stats")
        .call("dbgCall", "trace2PageHistogram")
        .call("dbgCall", "trace2Blocks", 100)
        .call("dbgCall", "trace2Indirects", 100);
}
const skirmishMiddle = await skirmishMiddleChain.run();
print("skirmish-transition-1.5-4s", skirmishMiddle);
if (!skirmishMiddle.ok) process.exit(1);

const skirmishLate = await harness()
    .perfProfile({ enable: true, reset: true })
    .call("dbgCall", "jitCompileStats", true)
    .sleep(5_000)
    .perfStats()
    .perfSpikes({ top: 16, minMs: 35 })
    .profilerStats({ top: 40, sort: "total" })
    .call("dbgCall", "jitCompileStats")
    .call("dbgCall", "tier2Stats")
    .call("dbgCall", "d3d9Perf")
    .call("dbgCall", "shadowDiff")
    .faults(20)
    .run();
print("skirmish-screen-4-9s", skirmishLate);
if (!skirmishLate.ok) process.exit(1);
