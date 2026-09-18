// Browser host end-to-end: serve the page, run test PEs in headless Chromium through the worker,
// and check what reached the canvases (2D GDI presentation, WebGL2 Direct3D clear).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from '../src/host/server.js';
import { decodePng } from '../src/gfx/codecs/png.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* playwright not installed */ }
const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = !chromium ? 'playwright missing' : !fs.existsSync(PE_DIR + 'dx.exe') ? 'build/pe missing (make pe-tests)' : false;

async function runManifest(name, seconds) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto(`http://127.0.0.1:${port}/?manifest=${name}&headless=1`);
    const t0 = Date.now();
    let s;
    for (;;) {
      s = await page.evaluate(() => ({ status: window.orthros.status, exitCode: window.orthros.exitCode, crash: window.orthros.crash }));
      if (s.status === 'exited' || s.status === 'crashed' || Date.now() - t0 > seconds * 1000) break;
      await page.waitForTimeout(200);
    }
    const png = await page.locator('#frame').screenshot();
    const img = decodePng(new Uint8Array(png));
    const pixel = (x, y) => { const o = (y * img.width + x) * 4; return (img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]; };
    return { ...s, logs, img, pixel };
  } finally {
    await browser.close();
    server.close();
  }
}

test('browser host: window.exe presents its GDI client area on the 2D canvas', { skip, timeout: 60000 }, async () => {
  const r = await runManifest('test-window', 20);
  assert.equal(r.status, 'exited', r.crash ?? r.logs.slice(-5).join('\n'));
  assert.equal(r.exitCode, 27);
  assert.equal(r.img.width, 800);
  assert.equal(r.pixel(150, 150), 0xff0000, 'red rectangle drawn by the guest');
  assert.equal(r.pixel(300, 300), 0xffffff, 'window background');
  assert.equal(r.pixel(600, 500), 0x000000, 'desktop');
});

test('browser host: dx.exe clears the Direct3D back buffer through WebGL2', { skip, timeout: 60000 }, async () => {
  const r = await runManifest('test-dx', 20);
  assert.equal(r.status, 'exited', r.crash ?? r.logs.slice(-5).join('\n'));
  assert.equal(r.exitCode, 0);
  assert.equal(r.pixel(100, 100), 0x0000ff, 'D3D Clear color on the GL layer');
  assert.equal(r.pixel(500, 400), 0x000000, 'outside the device window');
  assert.ok(r.logs.some((l) => l.includes('CreateDevice') && l.includes('backend yes')), 'WebGL backend attached');
});
