// Frame cost of an re3 port in the city (docs/browser-ports.md, "re3 ports"): its page started as a visitor, a new
// game from the game's menu, its cutscenes skipped (Enter held), then --seconds of play measured. The engine's own work
// a frame is the time from the browser's frame callback that resumes it (requestAnimationFrame) to its next wait for
// one; with --gl null (ANGLE's null backend: WebGL calls validated and sent, nothing drawn) it is the CPU a frame costs
// on a real machine whatever its GPU; --gl swiftshader draws on the CPU (slow, the GPU's share included). Also the
// frames a second, the WebGL calls a frame by kind, the memory. JSON on the last line; evidence under
// /tmp/orthros-scratch/re3-perf-<manifest>/. Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/re3/perf.mjs <manifest> [--url http://127.0.0.1:8080] [--gl null|swiftshader]
//     [--seconds 30] [--drive] [--warm 0] [--net KB/s] [--profile] [--size 1280x720] [--query "a=b"]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2), arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [name] = args;
if (!name || name.startsWith('--')) { console.error('usage: perf.mjs <manifest> [--url u] [--gl null|swiftshader] [--seconds n] [--drive] [--size WxH]'); process.exit(2); }
const base = arg('--url', 'http://127.0.0.1:8080'), gl = arg('--gl', 'null'), seconds = Number(arg('--seconds', 30));
const [width, height] = arg('--size', '1280x720').split('x').map(Number);
const root = `/tmp/orthros-scratch/re3-perf-${name}`;
fs.mkdirSync(root, { recursive: true }); process.env.TMPDIR = root;
const listed = (await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === name);
if (!listed?.available || listed.runtime !== 're3') throw new Error(`${name}: not an available re3 version`);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', `--use-angle=${gl === 'null' ? 'null' : 'swiftshader'}`, '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width, height: height + 44 } });
if (args.includes('--calls')) await page.addInitScript(() => { window.__countCalls = true; });
await page.addInitScript(() => {
  const P = window.perfProbe = { calls: new Map(), counting: false, draws: 0, frames: 0, work: [], resumedAt: 0, shown: [], drawsAt: 0 };
  const proto = WebGL2RenderingContext.prototype;
  for (const k of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, k); if (typeof d.value !== 'function') continue;
    const o = d.value, draw = k === 'drawElements' || k === 'drawArrays';
    proto[k] = function (...a) { if (draw) P.draws++; if (P.counting) P.calls.set(k, (P.calls.get(k) ?? 0) + 1); return o.apply(this, a); };
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    if (P.resumedAt) { P.work.push(performance.now() - P.resumedAt); if (P.work.length > 20000) P.work.shift(); P.resumedAt = 0; }
    return raf((t) => { P.frames++; P.resumedAt = performance.now(); if (P.draws !== P.drawsAt) { P.drawsAt = P.draws; P.shown.push(t); if (P.shown.length > 20000) P.shown.shift(); } cb(t); });
  };
});
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('crash', () => console.log('CRASH'));
const query = arg('--query', '');
// (--net KB/s: Chrome's network emulation, 50 ms round trip, from the start)
if (arg('--net')) { const c = await page.context().newCDPSession(page); await c.send('Network.enable'); await c.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: Number(arg('--net')) * 1024, uploadThroughput: 64 * 1024 }); }
await page.goto(`${base}${listed.launchUrl}${query ? `?${query}` : ''}`);
await page.waitForFunction(() => window.portSession?.state === 'running', null, { timeout: 300000 });
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
const cdp = args.includes('--profile') ? await page.context().newCDPSession(page) : null;
if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }
await page.evaluate(() => { const B = portSession.engine.orthrosBlocked; perfProbe.blocked0 = B ? { ...B, files: { ...B.files } } : {}; perfProbe.files0 = { ...portSession.files.stats }; perfProbe.work = []; perfProbe.shown = []; perfProbe.calls.clear(); perfProbe.counting = !!window.__countCalls; perfProbe.f0 = perfProbe.frames; perfProbe.d0 = perfProbe.draws; perfProbe.t0 = performance.now(); });
await page.waitForTimeout(seconds * 1000);
let profile = null;
if (cdp) {
  // (--profile: the measured seconds' CPU profile, self time by function — the engine's own, its WebGL calls, the rest)
  const { profile: pr } = await cdp.send('Profiler.stop'), byId = new Map(pr.nodes.map((n) => [n.id, n])), self = new Map();
  let total = 0;
  pr.samples.forEach((id, i) => { const n = byId.get(id), us = pr.timeDeltas[i] ?? 0, k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}`.trim(); self.set(k, (self.get(k) ?? 0) + us); total += us; });
  const wasm = [...self].filter(([k]) => k.endsWith('.wasm')).reduce((n, [, us]) => n + us, 0);
  // (the longest stretches without an idle sample — the hitches: their length and the functions they spent it in,
  // a function counted once a sample wherever it is on the stack)
  const runs = []; let run = null;
  pr.samples.forEach((id, i) => {
    const n = byId.get(id), us = pr.timeDeltas[i] ?? 0;
    if (n.callFrame.functionName === '(idle)') { if (run) runs.push(run); run = null; return; }
    run ??= { us: 0, ids: [] }; run.us += us; run.ids.push([id, us]);
  });
  if (run) runs.push(run);
  const parent = new Map(); for (const n of pr.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const hitches = runs.sort((a, b) => b.us - a.us).slice(0, 4).map((r) => {
    const incl = new Map();
    for (const [id, us] of r.ids) {
      const seen = new Set();
      for (let at = id; at != null; at = parent.get(at)) { const f = byId.get(at).callFrame.functionName || '(anon)'; if (!seen.has(f)) { seen.add(f); incl.set(f, (incl.get(f) ?? 0) + us); } }
    }
    return { ms: Math.round(r.us / 1000), top: Object.fromEntries([...incl].filter(([f]) => f !== '(root)').sort((a, b) => b[1] - a[1]).slice(0, 18).map(([f, us]) => [f, Math.round(us / 1000)])) };
  });
  profile = { wasmMsPerFrame: null, wasmShare: `${(100 * wasm / total).toFixed(1)}%`, wasmUs: wasm, top: Object.fromEntries([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => [k, `${(100 * us / total).toFixed(1)}%`])), hitches };
}
const result = await page.evaluate(() => {
  const P = perfProbe, frames = P.frames - P.f0, ms = performance.now() - P.t0, w = P.work.slice().sort((a, b) => a - b);
  const q = (f) => Math.round((w[Math.min(w.length - 1, Math.floor(w.length * f))] ?? 0) * 100) / 100;
  const calls = [...P.calls].sort((a, b) => b[1] - a[1]), total = calls.reduce((n, [, c]) => n + c, 0);
  // (the frames shown: a browser frame after one the game drew in — their intervals in vsync-ish buckets)
  const gaps = P.shown.slice(1).map((t, i) => t - P.shown[i]), hist = {};
  for (const g of gaps) { const b = g < 25 ? '<25' : g < 42 ? '25-42' : g < 58 ? '42-58' : '58+'; hist[b] = (hist[b] ?? 0) + 1; }
  const F = portSession.files.stats, F0 = P.files0 ?? {}, d = (k) => Math.round((F[k] ?? 0) - (F0[k] ?? 0));
  // (the engine's waits for its files in the measured seconds: count, total and its longest gap between shown frames)
  const B = portSession.engine.orthrosBlocked, B0 = P.blocked0 ?? {};
  // (the time the game stood still on a file read — engines that count it; else its demand waits are the closest)
  const blocked = B ? { blocks: (B.count ?? 0) - (B0.count ?? 0), blockedMs: Math.round((B.ms ?? 0) - (B0.ms ?? 0)), longestBlockMs: Math.round(B.max ?? 0), blockedFiles: Object.fromEntries(Object.entries(B.files ?? {}).map(([k, v]) => [k, Math.round(v - (B0.files?.[k] ?? 0))]).filter(([, v]) => v > 0)) } : { blocks: null };
  const waits = { ...blocked, waits: d('waits'), waitMs: d('waitMs'), waitMB: Math.round(d('waitBytes') / 1e5) / 10, syncFetches: d('syncFetches'), backgroundMB: Math.round(d('fetchedBytes') / 1e5) / 10, maxGapMs: Math.round(Math.max(0, ...gaps)), gaps250: gaps.filter((g) => g > 250).length };
  return { ...waits, fps: Math.round(frames / ms * 1000 * 10) / 10, shownFps: Math.round(gaps.length / ms * 1000 * 10) / 10, intervals: hist, frames, work: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) }, draws: Math.round((P.draws - P.d0) / frames),
    glCalls: Math.round(total / frames), top: Object.fromEntries(calls.slice(0, 14).map(([k, c]) => [k, Math.round(c / frames * 10) / 10])),
    heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576), wasmMB: Math.round((portSession.engine?.HEAPU8?.length ?? 0) / 1048576) };
});
if (args.includes('--drive')) await page.keyboard.up('w');
await page.screenshot({ path: path.join(root, 'end.png') });
await browser.close();
if (profile) { profile.wasmMsPerFrame = Math.round(profile.wasmUs / 1000 / result.frames * 100) / 100; delete profile.wasmUs; console.log('PROFILE', JSON.stringify(profile, null, 1)); }
console.log(JSON.stringify({ name, gl, seconds, size: `${width}x${height}`, drive: args.includes('--drive'), ...result }));
