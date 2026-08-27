import { harness } from "../harness";

const bundle = "/apps/bfme.wgb";
const mode = (process.env.BFME_TIER2_MODE ?? "legacy") === "profiled" ? "profiled" : "legacy";
const playerPage = process.env.BFME_PLAYER === "1";
const skipBoot = process.env.BFME_SKIP_BOOT === "1";

// D3D9 exclusive mode synchronizes the Win32 desktop and DirectInput coordinates
// to the 800x600 game surface. BFME polls DirectInput at menu-frame cadence, so
// every click is preceded by a settled hover and held across several polls.
const bootChain = harness();
if (!skipBoot) {
    if (playerPage) bootChain.reload().sleep(5_000);
    else bootChain.openWgb(bundle);
}

const opened = await bootChain
    .call("stopLogs")
    .audioGesture()
    .watchFrames(true)
    .call("dbgCall", "jitTier2Regions", mode === "profiled")
    .run();
console.log(JSON.stringify({ mode, phase: "opened", result: opened }, null, 2));
if (!opened.ok) process.exit(1);

// Keep each CDP evaluation below the harness' five-minute safety timeout. Under
// SwiftShader a nominal 240 s page timer can be delayed enough that combining it
// with all menu input makes an otherwise healthy run expire at the transport.
if (!skipBoot) {
    let sawFrame = false;
    for (let attempt = 0; attempt < 10; attempt++) {
        const settled = await harness()
            .waitForEvent("frameRendered", { timeoutMs: 55_000 })
            .run();
        console.log(JSON.stringify({ mode, phase: `settled-${attempt + 1}`, result: settled }, null, 2));
        if (!settled.ok) process.exit(1);
        sawFrame = !!settled.steps.find((step: any) => step.cmd === "waitForEvent")?.result;
        if (sawFrame) break;
    }
    if (!sawFrame) {
        console.error("No BFME frame after 550 seconds");
        process.exit(1);
    }
    const warmed = await harness().sleep(5_000).run();
    console.log(JSON.stringify({ mode, phase: "settled", result: warmed }, null, 2));
    if (!warmed.ok) process.exit(1);
}

const boot = await harness()
    .move(90, 575).sleep(1_200).call("clickHold", 90, 575, 700).sleep(6_000)   // Solo
    .move(320, 575).sleep(1_200).call("clickHold", 320, 575, 700).sleep(8_000) // Escarmouche
    .move(340, 575).sleep(1_200).call("clickHold", 340, 575, 700)              // Commencer
    .run();

console.log(JSON.stringify({ mode, phase: "boot", result: boot }, null, 2));
if (!boot.ok) process.exit(1);

const mapSettled = await harness().sleep(240_000).run();
console.log(JSON.stringify({ mode, phase: "map-settled", result: mapSettled }, null, 2));
if (!mapSettled.ok) process.exit(1);

const measured = await harness()
    .perfProfile({ enable: true, reset: true })
    .sleep(30_000)
    .perfStats()
    .call("dbgCall", "tier2Stats")
    .call("dbgCall", "shadowDiff")
    .faults(20)
    .run();

console.log(JSON.stringify({ mode, phase: "measured", result: measured }, null, 2));
if (!measured.ok) process.exit(1);
