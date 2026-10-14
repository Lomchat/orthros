#!/usr/bin/env node
// Snapshots in the page (docs/snapshot.md): the game runs with automatic snapshots on (?snapshot=auto) until its session
// took and kept one (or, --manual, until --at seconds, when orthros.saveSnapshot() takes it), then the page is opened
// again and must go on from it. Screenshots of the frame before and after, the snapshot's log lines, the state after.
// Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/snapshot-browser-check.mjs <manifest> [--games-dir <dir>] [--at <s>] [--after <s>]
//     [--settle <s>] [--manual] [--tries <n>] [--query <k=v&...>] [--out <dir>]
//   --at: seconds of play at most before the snapshot is kept (--manual: before it is asked for); --settle: the page
//   opened again once no other was kept for that long (60 s); --after: seconds of
//   play after the restore; --tries (--manual): asked again every 30 s while refused; --query: more page parameters
//   (glworker=0: the WebGL backend in the game's worker)
//   --url <server>: that server instead of one of its own; --once: the page opened once, by a new player (a fresh
//   browser profile), for --after seconds — exit status 1 unless it went on from a snapshot when --expect-restored
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../src/host/server.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FLAGS = new Set(['--manual', '--once', '--expect-restored']);
const name = args.find((a, i) => !a.startsWith('--') && (!args[i - 1]?.startsWith('--') || FLAGS.has(args[i - 1])));
const at = Number(opt('at', 180)), after = Number(opt('after', 20)), tries = Number(opt('tries', 1)), settle = Number(opt('settle', 60)), manual = args.includes('--manual');
const out = opt('out', `/tmp/orthros-scratch/snapshot-browser-${name}`);
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
process.env.TMPDIR = out;
const server = opt('url') ? null : createServer({ gamesDir: opt('games-dir') });
if (server) await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `${opt('url') ?? `http://127.0.0.1:${server.address().port}`}/?manifest=${encodeURIComponent(name)}&headless=1&opfs=1&snapshot=auto${opt('query') ? '&' + opt('query') : ''}`; // (opfs: the profile kept between the two starts, as a player's)
const chromeArgs = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launchPersistentContext(path.join(out, 'profile'), { args: chromeArgs, viewport: { width: 1280, height: 900 } });
const page = browser.pages()[0] ?? await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const running = () => page.waitForFunction(() => window.orthros?.status === 'running', null, { timeout: 120000 });
const shot = (f) => page.locator('#frame').screenshot({ path: path.join(out, f), timeout: 45000 }).catch((e) => log(`screenshot ${f}: ${e.message.split('\n')[0]}`));
const lines = (re) => page.evaluate((src) => window.orthros.logs.filter((l) => new RegExp(src).test(l)).slice(-20), re.source);
const printLines = async (re) => { for (const l of await lines(re)) console.log('  ' + l.slice(0, 300)); };
try {
  if (args.includes('--once')) {
    await page.goto(base); await running(); log(`${name} running`);
    await page.waitForTimeout(after * 1000);
    await shot('once.png');
    await printLines(/snapshot|restored|crash/);
    const s = await page.evaluate(() => ({ status: window.orthros.status, restored: window.orthros.logs.some((l) => /restored from a snapshot/.test(l)) }));
    log(`once: ${JSON.stringify(s)}`);
    if (s.status !== 'running' || (args.includes('--expect-restored') && !s.restored)) process.exitCode = 1;
    throw null; // (done)
  }
  await page.goto(base); await running(); log(`${name} running`);
  let kept = false;
  if (!manual) {
    // (the first one kept, then the later ones a session takes as its loading goes on: until none for --settle seconds)
    const until = Date.now() + at * 1000;
    kept = await page.waitForFunction(() => window.orthros.snapshotStored === true, null, { timeout: at * 1000, polling: 1000 }).then(() => true, () => false);
    while (kept && Date.now() < until) {
      const s = await page.evaluate(() => ({ at: window.orthros.snapshotKeptAt, pending: !!window.orthros.snapshotPending }));
      if (!s.pending && Date.now() - s.at > settle * 1000) break;
      await page.waitForTimeout(2000);
    }
    await printLines(/snapshot/);
    if (kept) log(`the session kept its snapshot (${await page.evaluate(() => window.orthros.snapshotsKept)} kept in turn)`);
    else { log(`no snapshot kept within ${at} s`); await printLines(/hang|busy|nested|crash/); process.exitCode = 1; }
  } else {
    await page.waitForTimeout(at * 1000);
    // (the worker answers within 15 s of a pump; none at all: it is blocked in a nested wait)
    let r;
    for (let i = 0; i < tries; i++) {
      if (i) await page.waitForTimeout(30000);
      r = await Promise.race([page.evaluate(() => window.orthros.saveSnapshot()), page.waitForTimeout(90000).then(() => ({ error: 'no answer from the worker in 90 s' }))]);
      if (r.saved || r.problems) break;
      log(`no snapshot yet: ${r.error}`);
    }
    if (r.saved) { kept = true; log(`snapshot: ${(r.bytes / 1048576).toFixed(1)} MiB, ${r.objects} objects, ${r.pages} pages, taken in ${r.ms.toFixed(0)} ms (${Object.entries(r.timing ?? {}).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')})`); }
    else { log('snapshot refused:'); for (const p of r.problems ?? [r.error]) console.log('  ' + p); await printLines(/hang|busy|nested|crash/); process.exitCode = 1; }
  }
  if (kept) {
    await shot('before.png');
    await page.goto(base); await running(); log('page opened again');
    await page.waitForTimeout(after * 1000);
    await shot('after.png');
    await printLines(/snapshot|restored|crash|warn/);
    const s = await page.evaluate(() => ({ status: window.orthros.status, fps: window.orthros.stats?.fps, failed: window.orthros.snapshotFailed ?? null, restored: window.orthros.logs.some((l) => /restored from a snapshot/.test(l)) }));
    log(`after: ${JSON.stringify(s)}`);
    if (s.failed || !s.restored || s.status !== 'running') process.exitCode = 1;
    if (!(s.fps >= 5)) { log('slow after the restore: the last log lines'); for (const l of await page.evaluate(() => window.orthros.logs.slice(-40))) console.log('  ' + l.slice(0, 400)); }
  }
} catch (e) {
  if (e === null) { /* --once: done */ } else {
  log(`failed: ${e.message.split('\n')[0]}`); process.exitCode = 1;
  const st = await page.evaluate(() => ({ status: window.orthros?.status, logs: window.orthros?.logs?.slice(-30) })).catch(() => null);
  if (st) { console.log(`  status: ${st.status}`); for (const l of st.logs ?? []) console.log('  ' + l.slice(0, 300)); }
  }
} finally { await browser.close(); server?.close(); }
