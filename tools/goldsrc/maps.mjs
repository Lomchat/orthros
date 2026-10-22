// Map loads of a GoldSrc port (docs/browser-ports.md, "Map loads"): a new browser (nothing kept from an earlier
// session), its page started as a visitor, then each step of --steps run in turn: `map <name>` / `changelevel <name>`
// (a console command, the game's own transition for changelevel) or `wait <seconds>` (time in the map — the background
// loading goes on meanwhile). Each map's load is timed from its command to the moment frames come steadily again
// (the first frame followed by --steady frames each within 250 ms of the previous one); its data waits are the game
// data's (src/vfs/data-client.js stats: the reads that held the engine — count, ms, bytes) between the command and that
// moment; the bytes loaded in the background beside. --net KB/s (and --latency ms, default 40): Chrome's network
// emulation from the start. The page's reports (learned order, telemetry) stay off the server unless --report (a
// session that teaches the server its learned order). JSON on the last line; evidence under
// /tmp/orthros-scratch/goldsrc-maps-<manifest>/. Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/goldsrc/maps.mjs <manifest> --url http://127.0.0.1:8080
//     --steps "wait 5,map c1a0,wait 30,changelevel c1a0d" [--net 1024] [--latency 40] [--steady 20] [--report [--no-phases]] [--tag t]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { chromeArgs, addProbe, quietReports } from '../port-perf.mjs';

const args = process.argv.slice(2), arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [name] = args;
if (!name || name.startsWith('--')) { console.error('usage: maps.mjs <manifest> --steps "map c1a0,wait 30,changelevel c1a0d" [--url u] [--net KB/s]'); process.exit(2); }
const base = arg('--url', 'http://127.0.0.1:8080'), steady = Number(arg('--steady', 20));
const steps = arg('--steps', '').split(',').map((s) => s.trim()).filter(Boolean);
const root = `/tmp/orthros-scratch/goldsrc-maps-${name}`;
fs.mkdirSync(root, { recursive: true }); process.env.TMPDIR = root;

const browser = await chromium.launch({ headless: true, args: chromeArgs('discard') });
const out = { name, net: arg('--net') ? Number(arg('--net')) : null, latency: arg('--net') ? Number(arg('--latency', 40)) : null, steps, maps: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 812 } });
  await addProbe(page, { discard: true });
  if (!args.includes('--report')) await quietReports(page);
  // (--report --no-phases: the reports without the session's phases — a server taught by time only, to compare)
  else if (args.includes('--no-phases')) {
    await page.route(/\/api\/prefetch\//, (route) => {
      const r = route.request(); if (r.method() !== 'POST') return route.continue();
      let body = r.postData() ?? ''; try { const o = JSON.parse(body); delete o.phases; body = JSON.stringify(o); } catch { /* as it is */ }
      return route.continue({ postData: body });
    });
  }
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('crash', () => console.log('CRASH'));
  if (arg('--net')) {
    const c = await page.context().newCDPSession(page); await c.send('Network.enable');
    await c.send('Network.emulateNetworkConditions', { offline: false, latency: Number(arg('--latency', 40)), downloadThroughput: Number(arg('--net')) * 1024, uploadThroughput: 256 * 1024 });
  }
  // (every frame drawn, its time: the probe's draw count looked at each animation frame)
  await page.addInitScript(() => {
    const F = window.__mapFrames = [];
    const look = () => { const P = window.perfProbe; if (P && P.draws !== look.d) { look.d = P.draws; F.push(performance.now()); if (F.length > 20000) F.splice(0, 10000); } requestAnimationFrame(look); };
    requestAnimationFrame(look);
  });
  const t0 = Date.now();
  await page.goto(`${base}/ports/goldsrc/${encodeURIComponent(name)}/`);
  await page.waitForFunction(() => ['running', 'error'].includes(window.portSession?.state), null, { timeout: 900000 });
  if (await page.evaluate(() => portSession.state) !== 'running') throw new Error(await page.evaluate(() => document.querySelector('#status')?.textContent));
  out.runningMs = Date.now() - t0;
  out.startup = await page.evaluate(() => portSession.startup ?? null);
  const stats = () => page.evaluate(() => { const s = portSession.files.stats; return { waits: s.waits, waitMs: s.waitMs, waitBytes: s.waitBytes, syncFetches: s.syncFetches, fetchedBytes: s.fetchedBytes, at: performance.now() }; });
  for (const step of steps) {
    const [verb, value] = step.split(/\s+/);
    if (verb === 'wait') { await page.waitForTimeout(Number(value) * 1000); continue; }
    const s0 = await stats();
    await page.evaluate((c) => portSession.command(c), step);
    // (steady: `steady` frames in a row each within 250 ms of the one before; at most 10 minutes)
    // (the load's end: the first frame after a silence of more than 250 ms — the load — that begins a steady run)
    const end = await page.waitForFunction(({ from, steady }) => {
      const after = window.__mapFrames.filter((t) => t > from);
      for (let i = 0; i + steady < after.length; i++) {
        if ((i === 0 ? after[0] - from : after[i] - after[i - 1]) <= 250) continue;
        let ok = true; for (let k = i + 1; k <= i + steady; k++) if (after[k] - after[k - 1] > 250) { ok = false; break; }
        if (ok) return after[i];
      }
      return null;
    }, { from: s0.at, steady }, { timeout: 600000, polling: 250 }).then((h) => h.jsonValue());
    const s1 = await stats();
    const loadMs = Math.round(end - s0.at);
    out.maps.push({ step, loadMs, waits: s1.waits - s0.waits, waitMs: Math.round(s1.waitMs - s0.waitMs), waitMB: +((s1.waitBytes - s0.waitBytes) / 1048576).toFixed(1),
      syncFetches: s1.syncFetches - s0.syncFetches, backgroundMB: +((s1.fetchedBytes - s0.fetchedBytes) / 1048576).toFixed(1) });
    console.log(JSON.stringify(out.maps.at(-1)));
  }
  const tag = arg('--tag', '');
  await page.screenshot({ path: path.join(root, `end${tag ? `-${tag}` : ''}.png`) });
  out.load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
  console.log(JSON.stringify(out));
} finally { await browser.close(); }
