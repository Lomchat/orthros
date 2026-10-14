#!/usr/bin/env node
// A shared snapshot's publishing session (docs/snapshot.md, stage 3; started by the server with --snapshot-jobs, through
// the browser slot guard): a headless browser opens the game on that server as a new player would (no profile, the
// shared first-launch one if any), with ?snapshot=publish — each snapshot the session keeps is posted to the server
// with the job's token. It goes on while the game's loading goes on (the later snapshots replace the first), then quits.
//   tools/with-browser-slot.sh node tools/snapshot-publish.mjs <manifest> --url <server> --lang <l> --key <key>
//     --token <token> [--at <s>] [--settle <s>]
//   --key: the key the server was asked for (the session's must be the same, else it stops); --at: seconds at most
//   (1200); --settle: done once no snapshot was kept for that long (240)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = args[0], url = opt('url'), lang = opt('lang', ''), key = opt('key'), token = opt('token');
const at = Number(opt('at', 1200)), settle = Number(opt('settle', 240));
if (!name || !url || !key || !token) { console.error('usage: snapshot-publish.mjs <manifest> --url <server> --lang <l> --key <key> --token <token>'); process.exit(2); }
const scratch = fs.mkdtempSync(path.join(fs.existsSync('/tmp/orthros-scratch') ? '/tmp/orthros-scratch' : os.tmpdir(), `snapshot-publish-${name.replace(/[^\w.-]/g, '_')}-`));
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const chromeArgs = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required'];
let browser = null;
try {
  browser = await chromium.launchPersistentContext(path.join(scratch, 'profile'), { args: chromeArgs, viewport: { width: 1280, height: 900 } });
  const page = browser.pages()[0] ?? await browser.newPage();
  page.on('pageerror', (e) => log('[pageerror]', e.message));
  const q = new URLSearchParams({ manifest: name, gameLang: lang, headless: '1', opfs: '1', audio: '1', snapshot: 'publish', publishToken: token });
  await page.goto(`${url}/?${q}`);
  await page.waitForFunction(() => window.orthros?.status === 'running', null, { timeout: 180000 });
  const own = await page.evaluate(() => window.orthros.snapshotKey);
  if (own !== key) throw new Error(`this session's key is ${own}, the server was asked for ${key}: nothing to publish`);
  log(`${name} (${lang || 'no language'}) running, key ${key}`);
  const until = t0 + at * 1000;
  for (;;) {
    const s = await page.evaluate(() => ({ status: window.orthros.status, kept: window.orthros.snapshotsKept ?? 0, published: window.orthros.snapshotsPublished ?? 0, at: window.orthros.snapshotKeptAt ?? 0, pending: !!window.orthros.snapshotPending }));
    if (s.status !== 'running') throw new Error(`the game stopped (${s.status})`);
    if (s.kept && !s.pending && Date.now() - s.at > settle * 1000) { log(`done: ${s.kept} kept, ${s.published} published`); break; }
    if (Date.now() > until) { log(`time is up: ${s.kept} kept, ${s.published} published`); break; }
    await page.waitForTimeout(5000);
  }
  for (const l of await page.evaluate(() => window.orthros.logs.filter((x) => /snapshot/.test(x)).slice(-20))) console.log('  ' + l.slice(0, 300));
} catch (e) {
  log(`failed: ${e.message.split('\n')[0]}`); process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true });
}
