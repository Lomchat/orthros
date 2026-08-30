/**
 * bfme-guided-nav — drive BFME's menus without being able to see them.
 *
 * SwiftShader's readback is black in this environment, so screenshots cannot
 * confirm that a click landed. Blind clicking on recorded coordinates fails
 * silently: the run continues, reaches no map load, and every counter that
 * depends on the map load reads zero — which looks exactly like "the feature
 * under test did nothing".
 *
 * D3D9 gives a usable substitute. Each screen has a characteristic draws-per-
 * presentation: the main menu is light, the skirmish setup screen is heavier,
 * and a loaded 3D scene heavier still. Sampling that ratio before and after a
 * click says whether the screen changed, so navigation becomes a feedback loop
 * instead of an open-loop guess.
 *
 *   bun tools/examples/bfme-guided-nav.harness.ts [--port 9492] [--game bfme]
 *     [--profile ...] [--dxt] [--boot-timeout 400]
 *
 * With --dxt the BC1 shadow comparator is armed before the map load. Note that
 * BFME 1 ships with compressedTexturePolicy "prefer-uncompressed", which refuses
 * all 321 compressed-format probes, so its encoder never runs and the comparator
 * stays empty unless dxtAdvertise(true) is set first.
 */

import { openBenchSession, type BenchSession } from "../bench-session";

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const has = (n: string) => process.argv.includes(`--${n}`);

const port = Number(arg("port", "9492"));
const profile = arg("profile", "/srv/bfme/app/orthros/tmp/bfme1-current");
const game = arg("game", "bfme");
const bootTimeoutSec = Number(arg("boot-timeout", "400"));
const tag = `nav-${Date.now()}`;

interface Signature { present: number; draws: number; drawsPerFrame: number; dxt: number; textures: number }

async function signature(bench: BenchSession): Promise<Signature> {
    return bench.evalPage<Signature>(`(async () => {
        const d = await __BS__.harness.dbgCall("d3d9Perf");
        const x = await __BS__.harness.dbgCall("dxtCacheReport");
        const a = d?.api ?? {};
        const draws = (a.drawPrimitive ?? 0) + (a.drawIndexedPrimitive ?? 0)
                    + (a.drawPrimitiveUP ?? 0) + (a.drawIndexedPrimitiveUP ?? 0);
        return { present: a.present ?? 0, draws, drawsPerFrame: 0,
                 dxt: x?.lookups ?? 0, textures: a.setTexture ?? 0 };
    })()`, 30_000);
}

/** Draws per presentation over a short window — the screen's fingerprint. */
async function fingerprint(bench: BenchSession, ms = 4_000): Promise<Signature> {
    const a = await signature(bench);
    await Bun.sleep(ms);
    const b = await signature(bench);
    const dp = b.present - a.present;
    return { ...b, drawsPerFrame: dp > 0 ? Math.round((b.draws - a.draws) / dp) : 0 };
}

async function key(bench: BenchSession, vk: number): Promise<void> {
    await bench.evalPage(`__BS__.harness.keyHold(${vk}, 120)`, 20_000).catch(() => {});
    await Bun.sleep(400);
}

async function click(bench: BenchSession, x: number, y: number): Promise<void> {
    await bench.evalPage(`(async () => {
        await __BS__.harness.move(${x}, ${y});
        await new Promise(r => setTimeout(r, 1200));
        return __BS__.harness.clickHold(${x}, ${y}, 700);
    })()`, 30_000).catch(() => {});
}

/**
 * Click each candidate in turn until the fingerprint moves. Returns the
 * coordinate that worked, or null — so a failed step is reported rather than
 * silently carried into the measurement.
 */
async function clickUntilScreenChanges(
    bench: BenchSession, label: string, candidates: Array<[number, number]>, settleMs = 6_000,
): Promise<[number, number] | null> {
    const before = await fingerprint(bench, 3_000);
    for (const [x, y] of candidates) {
        await click(bench, x, y);
        await Bun.sleep(settleMs);
        const after = await fingerprint(bench, 3_000);
        const moved = before.drawsPerFrame > 0
            ? Math.abs(after.drawsPerFrame - before.drawsPerFrame) / before.drawsPerFrame
            : (after.drawsPerFrame > 0 ? 1 : 0);
        console.log(JSON.stringify({
            step: label, tried: [x, y],
            drawsPerFrame: { before: before.drawsPerFrame, after: after.drawsPerFrame },
            changePct: Math.round(moved * 1000) / 10, dxt: after.dxt,
        }));
        if (moved > 0.2 || after.dxt > before.dxt) return [x, y];
    }
    console.log(`STEP-FAILED ${label}`);
    return null;
}

const bench = await openBenchSession({
    profile, port, url: `http://127.0.0.1:5173/?game=${game}&bench=${tag}`, matchToken: `bench=${tag}`,
});

const t0 = performance.now();
while (performance.now() - t0 < bootTimeoutSec * 1_000) {
    const s = await signature(bench).catch(() => null);
    if (s && s.present > 0) break;
    await Bun.sleep(2_000);
}
console.log(`first present after ${Math.round((performance.now() - t0) / 1000)}s`);
await Bun.sleep(12_000);
console.log("menu fingerprint " + JSON.stringify(await fingerprint(bench)));

// Coordinates recorded in optimisations.md for BFME 1's 800x600 exclusive
// desktop, plus the BFME II variants as fallbacks: which layout a bundle uses
// is exactly what cannot be checked visually here.
await clickUntilScreenChanges(bench, "solo", [[90, 575], [215, 575], [160, 575]]);
await clickUntilScreenChanges(bench, "skirmish", [[320, 575], [215, 387], [215, 420]]);

// The screen reached here is modal and waits on the KEYBOARD, not the mouse.
// Measured: twelve clicks at six separated positions move draws/frame by 0-0.9%,
// while Enter moves it 118 -> 175. Until this is sent, Play is unreachable and
// every downstream counter reads zero — which is indistinguishable from "the
// change under test did nothing" unless the landing is checked.
const beforeEnter = await fingerprint(bench, 3_000);
await key(bench, 13);
await Bun.sleep(8_000);
const afterEnter = await fingerprint(bench, 3_000);
console.log(JSON.stringify({
    step: "confirm-modal", key: "Enter",
    drawsPerFrame: { before: beforeEnter.drawsPerFrame, after: afterEnter.drawsPerFrame },
}));

if (has("dxt")) await bench.dbg("dxtShadow", true, true).catch(() => null);
await clickUntilScreenChanges(bench, "play", [[340, 575], [705, 574], [640, 556]], 15_000);

// Let the map load run; the encoder only fires there.
for (let i = 0; i < 20; i++) {
    await Bun.sleep(15_000);
    const s = await signature(bench);
    console.log(JSON.stringify({ tSec: Math.round((performance.now() - t0) / 1000), ...s }));
    if (s.dxt > 5_000) break;
}

console.log("RESULT " + JSON.stringify({
    dxt: await bench.dbg("dxtCacheReport").catch(() => null),
    dxtShadow: await bench.dbg("dxtShadowReport").catch(() => null),
    faults: await bench.evalPage(`__BS__.harness.faults(5)`).catch(() => null),
}));
bench.close();
