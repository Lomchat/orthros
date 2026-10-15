// Short browser smoke check. Always invoke through tools/with-browser-slot.sh.
// Usage: tools/with-browser-slot.sh node tools/openmw/check.mjs <manifest> [--url origin] [--seconds N]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2), id = args[0], arg = (k) => args.includes(k) ? args[args.indexOf(k) + 1] : null;
if (!id) throw new Error('Expected a manifest id');
const base = arg('--url') ?? 'http://localhost:8080', seconds = Math.max(1, Math.min(30, Number(arg('--seconds') ?? 3)));
const dir = `/tmp/orthros-scratch/openmw-check-${id}`;
fs.mkdirSync(dir, { recursive: true }); process.env.TMPDIR = dir;
const catalog = await (await fetch(base + '/api/manifests')).json(), entry = catalog.find((m) => m.name === id);
if (!entry?.available || entry.runtime !== 'openmw') throw new Error('OpenMW installation is not available');
const man = await (await fetch(base + `/api/manifest/${encodeURIComponent(id)}`)).json();
if (!man.openmw.example) throw new Error('This check covers the free engine example. Real Morrowind/multiplayer needs its own gameplay validation.');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const faults = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  page.on('pageerror', (e) => faults.push(e.message));
  await page.addInitScript(() => {
    window.orthrosDraws = 0;
    for (const name of ['drawArrays', 'drawElements']) {
      const original = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (...args) { window.orthrosDraws++; return original.apply(this, args); };
    }
  });
  await page.goto(base + '/?menu');
  await page.locator(`[data-name="${man.gameId}"] .hm-play`).click();
  await page.waitForURL(`**/ports/openmw/${id}/`); await page.click('#solo');
  const frame = page.frameLocator('#game');
  await frame.locator('#loading.hide').waitFor({ state: 'attached', timeout: 90000 });
  await page.waitForTimeout(seconds * 1000);
  const state = await frame.locator('body').evaluate(async () => ({
    isolated: crossOriginIsolated, draws: window.orthrosDraws, args: window.Module?.arguments,
    databases: (await indexedDB.databases()).map((d) => d.name), log: document.querySelector('#log')?.textContent.slice(-1600),
  }));
  assert.equal(state.isolated, true); assert.ok(state.draws > 100, `Only ${state.draws} draws`);
  assert.ok(state.databases.includes(man.saveKey), 'Installation-specific browser saves');
  if (man.openmw.startCell) assert.ok(state.args?.includes(man.openmw.startCell), 'The manifest start cell reaches the engine');
  assert.deepEqual(faults, []);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(state, null, 2));
  await page.screenshot({ path: path.join(dir, 'example.png') });
  console.log(JSON.stringify({ ok: true, manifest: id, draws: state.draws, isolated: state.isolated, output: dir }));
} finally { await browser.close(); }
