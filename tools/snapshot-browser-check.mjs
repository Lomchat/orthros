#!/usr/bin/env node
// Snapshots in the page (docs/snapshot.md): the game runs, the page's worker takes its snapshot (orthros.saveSnapshot:
// kept in OPFS), then the page is opened again with ?snapshot=1 and the game goes on from it. Screenshots of the frame
// before and after, the restore's log lines, the frame rate after. Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/snapshot-browser-check.mjs <manifest> [--games-dir <dir>] [--at <s>] [--after <s>]
//     [--out <dir>]   (--at: seconds of play before the snapshot; --after: seconds of play after the restore)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../src/host/server.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const at = Number(opt('at', 30)), after = Number(opt('after', 20));
const out = opt('out', `/tmp/orthros-scratch/snapshot-browser-${name}`);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
process.env.TMPDIR = out;
const server = createServer({ gamesDir: opt('games-dir') });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/?manifest=${encodeURIComponent(name)}&headless=1`;
const chromeArgs = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launchPersistentContext(path.join(out, 'profile'), { args: chromeArgs, viewport: { width: 1280, height: 900 } });
const page = browser.pages()[0] ?? await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const running = () => page.waitForFunction(() => window.orthros?.status === 'running', null, { timeout: 120000 });
const shot = (f) => page.locator('#frame').screenshot({ path: path.join(out, f), timeout: 45000 }).catch((e) => log(`screenshot ${f}: ${e.message.split('\n')[0]}`));
const lines = (re) => page.evaluate((src) => window.orthros.logs.filter((l) => new RegExp(src).test(l)).slice(-20), re.source);
try {
  await page.goto(base); await running(); log(`${name} running`);
  await page.waitForTimeout(at * 1000);
  await shot('before.png');
  const r = await page.evaluate(() => window.orthros.saveSnapshot());
  if (!r.saved) {
    log('snapshot refused:'); for (const p of r.problems ?? [r.error]) console.log('  ' + p);
    process.exitCode = 1;
  } else {
    log(`snapshot: ${(r.bytes / 1048576).toFixed(1)} MiB, ${r.objects} objects, ${r.pages} pages, taken in ${r.ms.toFixed(0)} ms`);
    await page.goto(base + '&snapshot=1'); await running(); log('restored page running');
    await page.waitForTimeout(after * 1000);
    await shot('after.png');
    for (const l of await lines(/snapshot|restored|crash|warn/)) console.log('  ' + l.slice(0, 220));
    const s = await page.evaluate(() => ({ status: window.orthros.status, fps: window.orthros.stats?.fps, failed: window.orthros.snapshotFailed ?? null }));
    log(`after the restore: ${JSON.stringify(s)}`);
    if (s.failed || s.status !== 'running') process.exitCode = 1;
  }
} catch (e) {
  log(`failed: ${e.message.split('\n')[0]}`); process.exitCode = 1;
  const st = await page.evaluate(() => ({ status: window.orthros?.status, logs: window.orthros?.logs?.slice(-30) })).catch(() => null);
  if (st) { console.log(`  status: ${st.status}`); for (const l of st.logs ?? []) console.log('  ' + l.slice(0, 300)); }
} finally { await browser.close(); server.close(); }
