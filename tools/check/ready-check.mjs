// Browser check of the player's page in a hidden tab (docs/game-frame.md "Ready signal", docs/telemetry-compat.md):
// the game starts while the page says it is hidden; at its first images the tab's title must get the ready prefix and a
// notification must be shown (notifications granted); the title comes back when the tab is shown; the telemetry must
// carry the `ready` event, the session's `compat` summary and the GPU probe's fence figures.
// Usage: tools/with-browser-slot.sh node tools/check/ready-check.mjs <manifest> [--seconds 150] [--after 40] [--telemetry <dir>] [--games-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../src/server/server.js';

const args = process.argv.slice(2);
const manifest = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!manifest) { console.error('usage: node tools/check/ready-check.mjs <manifest> [--seconds 150] [--telemetry <dir>]'); process.exit(2); }
const seconds = Number(opt('seconds', 150)), dir = opt('telemetry', '/tmp/orthros-scratch/ready-check/telemetry');
fs.mkdirSync(dir, { recursive: true });
const server = createServer({ telemetryDir: dir, gamesDir: opt('games-dir') }); // (a worktree: --games-dir /srv/orthros/data/games)
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required'] });
let ok = true;
const check = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) ok = false; };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await context.grantPermissions(['notifications'], { origin });
  const page = await context.newPage();
  // (a headless tab is always visible: the page is told it is hidden until the check shows it; notifications recorded)
  await page.addInitScript(() => {
    window.__vis = 'hidden'; window.__notes = [];
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => window.__vis, configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => window.__vis === 'hidden', configurable: true });
    // (headless Chromium never shows notifications, whatever the permission: a stand-in that records them, permission granted)
    window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } constructor(title, o) { window.__notes.push({ title, body: o?.body ?? null }); } close() {} };
  });
  await page.goto(`${origin}/?manifest=${encodeURIComponent(manifest)}`);
  const t0 = Date.now();
  let title = '';
  while (Date.now() - t0 < seconds * 1000) { title = await page.title(); if (title.startsWith('▶')) break; await page.waitForTimeout(500); }
  console.log(`title after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${title}`);
  check(title.startsWith('▶'), 'ready prefix in the hidden tab\'s title');
  const notes = await page.evaluate(() => window.__notes);
  check(notes.length === 1, `one notification (${JSON.stringify(notes)})`);
  await page.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  title = await page.title();
  check(!title.startsWith('▶'), `title back when shown: ${title}`);
  await page.waitForTimeout(Number(opt('after', 40)) * 1000); // (a ~20 s summary with the GPU figures, the compat summary)
  const st = await page.evaluate(() => { const m = window.orthros?.stats; return m ? { frames: m.frames, d3dFrames: m.d3d?.frames ?? null, unknownImports: m.unknownImports, compat: m.compat ?? null, gpu: m.d3d?.gpu ?? null } : null; });
  console.log(`worker stats: ${JSON.stringify(st).slice(0, 1200)}`);
  await page.evaluate(() => dispatchEvent(new Event('pagehide'))).catch((e) => check(false, `page gone before its end: ${e.message.split('\n')[0]}`));
  await page.waitForTimeout(1500);
} finally { await browser.close(); server.close(); }
const recs = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) try { recs.push(JSON.parse(l)); } catch { /* torn */ }
const evs = recs.flatMap((r) => r.samples ?? []);
const ready = evs.find((x) => x.event === 'ready'), compat = evs.filter((x) => x.event === 'compat').at(-1);
check(!!ready && ready.hidden === true && ready.notified === true, `ready event ${JSON.stringify(ready)}`);
console.log(`compat events: ${evs.filter((x) => x.event === 'compat').length}; last: ${JSON.stringify(compat ?? null).slice(0, 600)}`);
const gpu = evs.filter((x) => x.event === 'summary').map((x) => x.gpu).filter(Boolean).at(-1);
console.log(`last summary gpu: ${JSON.stringify(gpu ?? null).slice(0, 400)}`);
const perf = recs.filter((r) => r.event === 'perf').at(-1);
console.log(`perf record gpu: ${JSON.stringify(perf?.gpu ?? perf?.totals?.gpu ?? null).slice(0, 400)}`);
process.exitCode = ok ? 0 : 1;
