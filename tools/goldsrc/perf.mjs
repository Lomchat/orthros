// Frame cost of a GoldSrc port in a game (docs/browser-ports.md, "Measured"): its page started as a visitor (no
// ?debug: the player's settings), the manifest's solo map entered as its menu does (its commands run by the page: bots
// included), --join-keys pressed (a team menu), --commands run (console commands, `;` between them: an A/B of the
// engine's settings), then --seconds measured while walking (--walk: forward held, turning) after --warm seconds.
// tools/port-perf.mjs measures: the engine's work a frame, the frames shown, the WebGL calls a frame by kind and the
// synchronous ones, the renderer (--gl swiftshader|discard|gpu; --stacks getError,…: who calls them). The page's
// reports stay off the server unless --report. JSON on the last line; evidence under
// /tmp/orthros-scratch/goldsrc-perf-<manifest>/. Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/goldsrc/perf.mjs <manifest> [--url http://127.0.0.1:8080] [--gl discard]
//     [--map de_dust2] [--join-keys "2,1"] [--commands "gl_vbo 1;…"] [--seconds 30] [--warm 10] [--walk] [--profile]
//     [--stacks getError] [--size 1280x720] [--query "a=b"] [--report] [--tag t]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { chromeArgs, addProbe, quietReports, startMeasure, readMeasure, startProfile, stopProfile } from '../port-perf.mjs';

const args = process.argv.slice(2), arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [name] = args;
if (!name || name.startsWith('--')) { console.error('usage: perf.mjs <manifest> [--url u] [--gl swiftshader|discard|gpu] [--commands "a;b"] [--seconds n] [--walk]'); process.exit(2); }
const base = arg('--url', 'http://127.0.0.1:8080'), gl = arg('--gl', 'discard'), seconds = Number(arg('--seconds', 30));
const [width, height] = arg('--size', '1280x720').split('x').map(Number);
const root = `/tmp/orthros-scratch/goldsrc-perf-${name}`;
fs.mkdirSync(root, { recursive: true }); process.env.TMPDIR = root;
const manifest = await (await fetch(`${base}/api/manifest/${encodeURIComponent(name)}`)).json();
if (manifest.runtime !== 'goldsrc') throw new Error(`${name}: not a GoldSrc version`);
const map = arg('--map', manifest.goldsrc.solo?.map);

const browser = await chromium.launch({ headless: true, args: chromeArgs(gl) });
try {
  const page = await browser.newPage({ viewport: { width, height: height + 44 } });
  await addProbe(page, { discard: gl === 'discard', stacks: arg('--stacks', '').split(',').filter(Boolean) });
  if (!args.includes('--report')) await quietReports(page);
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('crash', () => console.log('CRASH'));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const query = arg('--query', '');
  await page.goto(`${base}/ports/goldsrc/${encodeURIComponent(name)}/${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => ['running', 'error'].includes(window.portSession?.state), null, { timeout: 300000 });
  if (await page.evaluate(() => portSession.state) !== 'running') throw new Error(await page.evaluate(() => document.querySelector('#status')?.textContent));
  console.log('RENDERER', await page.evaluate(() => perfProbe.renderer), gl === 'discard' ? '(rasterizer discarded)' : '');
  await page.waitForTimeout(3000);
  await page.evaluate((m) => portSession.command(`map ${m}`), map);
  await page.waitForFunction(() => perfProbe.draws > 50, null, { timeout: 60000 });
  await page.waitForTimeout(7000);
  await page.evaluate(() => document.exitPointerLock()); await page.locator('#canvas').click();
  for (const k of (arg('--join-keys', '') || '').split(',').filter(Boolean)) { await page.keyboard.press(k); await page.waitForTimeout(1000); }
  for (const c of (arg('--commands', '') || '').split(';').map((c) => c.trim()).filter(Boolean)) await page.evaluate((c) => portSession.command(c), c);
  const walk = args.includes('--walk');
  // (walking: forward held, the view turned by small mouse steps — the scene changes as a player's does)
  let turning = null;
  if (walk) {
    await page.keyboard.down('w');
    const box = await page.locator('#canvas').boundingBox(); let x = box.x + box.width / 2, dir = 1;
    turning = setInterval(() => { x += dir * 25; if (Math.abs(x - (box.x + box.width / 2)) > 300) dir = -dir; page.mouse.move(x, box.y + box.height / 2).catch(() => {}); }, 200);
  }
  await page.waitForTimeout(Number(arg('--warm', 10)) * 1000);
  const cdp = args.includes('--profile') ? await startProfile(page) : null;
  await startMeasure(page);
  await page.waitForTimeout(seconds * 1000);
  const measured = await readMeasure(page);
  const profile = cdp ? await stopProfile(cdp, measured.frames) : null;
  if (turning) clearInterval(turning);
  if (walk) await page.keyboard.up('w');
  const tag = arg('--tag', ''); // (--tag t: the evidence files of this run apart, end-<t>.png)
  await page.screenshot({ path: path.join(root, `end${tag ? `-${tag}` : ''}.png`) });
  const logs = await page.evaluate(() => portSession.logs.slice(-60));
  fs.writeFileSync(path.join(root, 'logs.json'), JSON.stringify(logs, null, 1));
  if (profile) console.log('PROFILE', JSON.stringify(profile, null, 1));
  console.log(JSON.stringify({ name, gl, map, commands: arg('--commands', ''), seconds, size: `${width}x${height}`, walk, load: fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0], ...measured }));
} finally { await browser.close(); }
