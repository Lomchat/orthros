// Frame cost of an re3 port in the city (docs/browser-ports.md, "re3 ports"): its page started as a visitor, a new
// game from the game's menu, its cutscenes skipped (Enter held), then --seconds of play measured (tools/port-perf.mjs:
// the engine's work a frame — from the browser's frame callback that resumes it to its next wait for one —, the frames
// shown, the WebGL calls a frame by kind and the synchronous ones, the renderer; --gl swiftshader draws on the CPU, the
// GPU's share included; --gl discard sends every call but draws nothing — the CPU a frame costs, an upper bound). Also
// the engine's waits for its files and its memory. The page's reports (telemetry, learned order, first-launch profile)
// stay off the server unless --report. JSON on the last line; evidence under /tmp/orthros-scratch/re3-perf-<manifest>/.
// Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/re3/perf.mjs <manifest> [--url http://127.0.0.1:8080] [--gl swiftshader|discard|gpu]
//     [--seconds 30] [--drive] [--warm 0] [--net KB/s] [--profile] [--stacks getError,…] [--no-calls] [--report]
//     [--size 1280x720] [--query "a=b"] [--trace <file.json>]   (--trace: a Chrome trace of the measured seconds — the
//     renderer's main thread, the GPU process, their waits on each other —, for a closer look at the frames' gaps)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { chromeArgs, addProbe, quietReports, startMeasure, readMeasure, startProfile, stopProfile } from '../port-perf.mjs';

const args = process.argv.slice(2), arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [name] = args;
if (!name || name.startsWith('--')) { console.error('usage: perf.mjs <manifest> [--url u] [--gl swiftshader|discard|gpu] [--seconds n] [--drive] [--size WxH]'); process.exit(2); }
const base = arg('--url', 'http://127.0.0.1:8080'), gl = arg('--gl', 'discard'), seconds = Number(arg('--seconds', 30));
const [width, height] = arg('--size', '1280x720').split('x').map(Number);
const root = `/tmp/orthros-scratch/re3-perf-${name}`;
fs.mkdirSync(root, { recursive: true }); process.env.TMPDIR = root;
const listed = (await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === name);
if (!listed?.available || listed.runtime !== 're3') throw new Error(`${name}: not an available re3 version`);

const browser = await chromium.launch({ headless: true, args: chromeArgs(gl) });
const page = await browser.newPage({ viewport: { width, height: height + 44 } });
await addProbe(page, { discard: gl === 'discard', stacks: arg('--stacks', '').split(',').filter(Boolean) });
if (!args.includes('--report')) await quietReports(page);
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('crash', () => console.log('CRASH'));
const query = arg('--query', '');
// (--net KB/s: Chrome's network emulation, 50 ms round trip, from the start)
if (arg('--net')) { const c = await page.context().newCDPSession(page); await c.send('Network.enable'); await c.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: Number(arg('--net')) * 1024, uploadThroughput: 64 * 1024 }); }
await page.goto(`${base}${listed.launchUrl}${query ? `?${query}` : ''}`);
await page.waitForFunction(() => window.portSession?.state === 'running', null, { timeout: 300000 });
console.log('RENDERER', await page.evaluate(() => perfProbe.renderer), gl === 'discard' ? '(rasterizer discarded)' : '');
await page.waitForTimeout(5000);
const canvas = await page.locator('#canvas').boundingBox();
const at = (fx, fy) => [canvas.x + fx * canvas.width, canvas.y + fy * canvas.height];
const hold = async (key, ms = 600) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
/** Draws a frame over `ms`. */
const rate = async (ms) => { const a = await page.evaluate(() => [perfProbe.draws, perfProbe.frames]); await page.waitForTimeout(ms); const b = await page.evaluate(() => [perfProbe.draws, perfProbe.frames]); return (b[0] - a[0]) / Math.max(1, b[1] - a[1]); };
// (the game's menu: Start game, then New game — the menu's places, fractions of the canvas)
for (const fy of [0.401, 0.365]) { await page.mouse.move(...at(0.5, fy), { steps: 4 }); await page.waitForTimeout(400); await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up(); await page.waitForTimeout(2500); }
// (the intro's cutscenes skipped until the city is there and the player has the controls: a scene a while)
const t0 = Date.now(); let scenes = 0;
while (Date.now() - t0 < 300000) {
  await hold('Enter');
  const r = await rate(3000);
  scenes = r > 80 ? scenes + 1 : 0;
  if (scenes >= 4) break;
}
await page.screenshot({ path: path.join(root, 'start.png') });
if (args.includes('--drive')) { await hold('Enter', 700); await page.waitForTimeout(4000); await page.keyboard.down('w'); }
// (--warm s: played that long before the measure — the intro's last loading screen out of it)
await page.waitForTimeout(Number(arg('--warm', 0)) * 1000);
const cdp = args.includes('--profile') ? await startProfile(page) : null;
if (arg('--trace')) await browser.startTracing(page, { path: arg('--trace'), categories: ['toplevel', 'gpu', 'cc', 'viz', 'blink', 'v8', 'disabled-by-default-devtools.timeline', 'disabled-by-default-gpu.service'] });
await page.evaluate(() => { const B = portSession.engine.orthrosBlocked; perfProbe.blocked0 = B ? { ...B, files: { ...B.files } } : {}; perfProbe.files0 = { ...portSession.files.stats }; });
await startMeasure(page, { calls: !args.includes('--no-calls') });
await page.waitForTimeout(seconds * 1000);
const measured = await readMeasure(page);
const profile = cdp ? await stopProfile(cdp, measured.frames) : null;
if (arg('--trace')) await browser.stopTracing();
const result = { ...measured, ...await page.evaluate(() => {
  const P = perfProbe, F = portSession.files.stats, F0 = P.files0 ?? {}, d = (k) => Math.round((F[k] ?? 0) - (F0[k] ?? 0));
  // (the engine's waits for its files in the measured seconds: count, total and the files)
  const B = portSession.engine.orthrosBlocked, B0 = P.blocked0 ?? {};
  // (the time the game stood still on a file read — engines that count it; else its demand waits are the closest)
  const blocked = B ? { blocks: (B.count ?? 0) - (B0.count ?? 0), blockedMs: Math.round((B.ms ?? 0) - (B0.ms ?? 0)), longestBlockMs: Math.round(B.max ?? 0), blockedFiles: Object.fromEntries(Object.entries(B.files ?? {}).map(([k, v]) => [k, Math.round(v - (B0.files?.[k] ?? 0))]).filter(([, v]) => v > 0)) } : { blocks: null };
  return { ...blocked, waits: d('waits'), waitMs: d('waitMs'), waitMB: Math.round(d('waitBytes') / 1e5) / 10, syncFetches: d('syncFetches'), backgroundMB: Math.round(d('fetchedBytes') / 1e5) / 10,
    wasmMB: Math.round((portSession.engine?.HEAPU8?.length ?? 0) / 1048576) };
}) };
if (args.includes('--drive')) await page.keyboard.up('w');
await page.screenshot({ path: path.join(root, 'end.png') });
await browser.close();
if (profile) console.log('PROFILE', JSON.stringify(profile, null, 1));
console.log(JSON.stringify({ name, gl, seconds, size: `${width}x${height}`, drive: args.includes('--drive'), ...result }));
