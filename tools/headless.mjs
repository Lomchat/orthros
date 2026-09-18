// Headless harness: starts the server, opens the page in headless Chromium (Playwright), runs a
// manifest for N seconds, collects the emulator log, HUD stats and periodic screenshots.
// Usage: node tools/headless.mjs <manifest-name> [--seconds 60] [--shots 10] [--out build/shots] [--log kinds] [--interp]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../src/host/server.js';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const seconds = Number(opt('seconds', 60)), shotEvery = Number(opt('shots', 10)), out = opt('out', 'build/shots');
if (!name) { console.error('usage: node tools/headless.mjs <manifest> [--seconds N] [--shots N] [--out dir] [--log kinds] [--interp]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logFile = fs.createWriteStream(path.join(out, `${name}.log`));
page.on('console', (m) => { const t = m.text(); logFile.write(t + '\n'); if (/^\[(crash|warn|gfx|audio|input|thread)\]/.test(t) || args.includes('--verbose')) console.log(t); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const q = new URLSearchParams({ manifest: name, headless: '1' });
if (opt('log')) q.set('log', opt('log'));
if (args.includes('--interp')) q.set('interp', '1');
await page.goto(`http://127.0.0.1:${port}/?${q}`);
const t0 = Date.now();
let lastShot = 0, shot = 0;
const status = () => page.evaluate(() => ({ status: window.orthros.status, stats: window.orthros.stats, exitCode: window.orthros.exitCode, crash: window.orthros.crash }));
for (;;) {
  const s = await status();
  const t = (Date.now() - t0) / 1000;
  if (s.stats) console.log(`[t=${t.toFixed(0)}s] ${s.status} fps=${s.stats.fps.toFixed(1)} p99=${s.stats.frameP99.toFixed(1)}ms mips=${s.stats.mips.toFixed(0)} api/s=${s.stats.apiPerSec.toFixed(0)} threads=${s.stats.threads} frames=${s.stats.frames}${s.stats.d3d ? ` d3d=${s.stats.d3d.w}x${s.stats.d3d.h}/${s.stats.d3d.frames}f/${s.stats.d3d.draws}d` : s.stats.firstD3D ? ` dx=${s.stats.firstD3D}` : ''} unknown=${s.stats.unknownImports}`);
  if (t - lastShot >= shotEvery) { lastShot = t; const f = path.join(out, `${name}-${String(shot++).padStart(3, '0')}-${t.toFixed(0)}s.png`); await page.locator('#frame').screenshot({ path: f }).catch(() => page.screenshot({ path: f })); console.log(`[shot] ${f}`); }
  if (s.status === 'exited' || s.status === 'crashed') { console.log(`[end] ${s.status} code=${s.exitCode}`); if (s.crash) console.log(s.crash); break; }
  if (t >= seconds) { console.log(`[end] time limit ${seconds}s`); await page.evaluate(() => window.orthros.worker?.postMessage({ type: 'report' })); await page.waitForTimeout(500); const r = await page.evaluate(() => window.orthros.report); if (r) console.log(r); break; }
  await page.waitForTimeout(1000);
}
const f = path.join(out, `${name}-final.png`);
await page.locator('#frame').screenshot({ path: f }).catch(() => page.screenshot({ path: f }));
console.log(`[shot] ${f}`);
logFile.end();
await browser.close();
server.close();
