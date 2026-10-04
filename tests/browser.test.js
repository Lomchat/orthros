// Browser host end-to-end: serve the page, run test PEs in headless Chromium through the worker,
// and check what reached the canvases (2D GDI presentation, WebGL2 Direct3D clear).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/host/server.js';
import { decodePng } from '../src/gfx/codecs/png.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* playwright not installed */ }
const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = !chromium ? 'playwright missing' : !fs.existsSync(PE_DIR + 'dx.exe') ? 'build/pe missing (make pe-tests)' : false;

async function runManifest(name, seconds, query = '') {
  const server = createServer({ manifests: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/manifests') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto(`http://127.0.0.1:${port}/?manifest=${name}&headless=1${query}`);
    const t0 = Date.now();
    let s;
    for (;;) {
      s = await page.evaluate(() => ({ status: window.orthros.status, exitCode: window.orthros.exitCode, crash: window.orthros.crash }));
      if (s.status === 'exited' || s.status === 'crashed' || Date.now() - t0 > seconds * 1000) break;
      await page.waitForTimeout(200);
    }
    // (the last frames may still be on their way to the page: with the render worker a presented frame travels from it
    // to the page as an ImageBitmap, after the emulator — and possibly the process — moved on; on a loaded machine that
    // takes a while. Screenshots until three in a row, 250 ms apart, agree, 5 s at most.)
    let png = await page.locator('#frame').screenshot();
    for (let i = 0, same = 0; i < 20 && same < 2; i++) {
      await page.waitForTimeout(250);
      const next = await page.locator('#frame').screenshot();
      same = Buffer.compare(next, png) === 0 ? same + 1 : 0;
      png = next;
    }
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

test('browser host: dx9.exe renders a textured triangle through the WebGL2 backend and reads it back', { skip, timeout: 60000 }, async () => {
  const r = await runManifest('test-dx9', 20);
  assert.equal(r.status, 'exited', r.crash ?? r.logs.slice(-5).join('\n'));
  assert.equal(r.exitCode, 0);
  // the last Present went through a gamma ramp halving every channel
  assert.equal(r.pixel(60, 60), 0x007f00, 'green texture modulated by white diffuse inside the triangle, through the gamma ramp');
  assert.equal(r.pixel(300, 200), 0x00007f, 'clear color: the counterclockwise triangle is culled by D3DCULL_CCW');
  const text = r.logs.filter((l) => l.startsWith('[stdout] ')).map((l) => l.slice(9)).join('');
  assert.match(text, /px_tri=0x0000ff00/, 'GetRenderTargetData reads the rendered pixels back into guest memory (no gamma)');
  assert.match(text, /px_clear=0x000000ff/);
  assert.match(text, /px_chk00=0x00000000/, 'texel-aligned checker: exact texel colors (D3D pixel centers)');
  assert.match(text, /px_chk10=0x00ffffff/);
  assert.match(text, /px_chk33=0x00000000/);
  assert.match(text, /px_chk_out=0x0000ff00/, 'the quad covers exactly pixels 100..103');
  assert.ok(r.logs.some((l) => l.includes('render worker: ready')), 'the render worker by default (?glworker=0 for the in-thread backend)');
});

// the render worker (docs/render-worker.md; the default, ?glworker=1): the same pixels and readbacks with
// the Direct3D work recorded and replayed in this thread (inline), in a render worker that presents the frames itself
// (1), and with the backend in the emulator's thread (0)
for (const mode of ['inline', '1', '0']) {
  test(`browser host, ?glworker=${mode}: dx9.exe renders, reads back and presents through the gamma ramp as in-thread`, { skip, timeout: 60000 }, async () => {
    const r = await runManifest('test-dx9', 20, `&glworker=${mode}`);
    assert.equal(r.status, 'exited', r.crash ?? r.logs.slice(-5).join('\n'));
    assert.equal(r.exitCode, 0);
    assert.equal(r.pixel(60, 60), 0x007f00, 'triangle through the gamma ramp');
    assert.equal(r.pixel(300, 200), 0x00007f, 'clear color through the gamma ramp');
    const text = r.logs.filter((l) => l.startsWith('[stdout] ')).map((l) => l.slice(9)).join('');
    for (const k of ['px_tri=0x0000ff00', 'px_clear=0x000000ff', 'px_chk00=0x00000000', 'px_chk10=0x00ffffff', 'px_chk33=0x00000000', 'px_chk_out=0x0000ff00']) assert.ok(text.includes(k), `${k} in\n${text}`);
    if (mode === '1') assert.ok(r.logs.some((l) => l.includes('render worker: ready')), 'the render worker rendered');
    if (mode === '0') assert.ok(!r.logs.some((l) => l.includes('render worker: ready')), 'the backend in the emulator\'s thread');
  });
  test(`browser host, ?glworker=${mode}: dx.exe clears the Direct3D back buffer`, { skip, timeout: 60000 }, async () => {
    const r = await runManifest('test-dx', 20, `&glworker=${mode}`);
    assert.equal(r.status, 'exited', r.crash ?? r.logs.slice(-5).join('\n'));
    assert.equal(r.exitCode, 0);
    assert.equal(r.pixel(100, 100), 0x0000ff, 'D3D Clear color on the GL layer');
  });
}

test('browser host: text.exe measures and draws an outline font through the canvas text engine', { skip, timeout: 60000 }, async () => {
  const r = await runManifest('test-text', 20);
  assert.equal(r.status, 'exited', r.crash ?? r.logs.slice(-5).join('\n'));
  const text = r.logs.filter((l) => l.startsWith('[stdout] ')).map((l) => l.slice(9)).join('');
  const v = Object.fromEntries([...text.matchAll(/(\w+)=(-?\d+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.ok(v.tm_height >= 20 && v.tm_height <= 26, `cell height of a -20 font: ${v.tm_height}`);
  assert.equal(v.tm_height, v.tm_ascent + v.tm_descent);
  assert.equal(v.tm_internal, v.tm_height - 20, 'internal leading = cell - em');
  assert.ok(v.tm_pitch & 6, 'TrueType/vector font');
  assert.equal(v.extent_cy, v.tm_height);
  assert.ok(v.extent_cx > 80 && v.extent_cx < 160, `extent of "Hello, World": ${v.extent_cx}`);
  assert.ok(v.width_W > 2 * v.width_i, `proportional widths W=${v.width_W} i=${v.width_i}`);
  assert.ok(v.px_black > 20 && v.px_gray > 20, `antialiased glyphs (black ${v.px_black}, gray ${v.px_gray})`);
  assert.ok(Math.abs(v.px_right - (4 + v.extent_cx)) <= 3, `ink ends near the measured extent (${v.px_right} vs ${4 + v.extent_cx})`);
  assert.ok(v.drawtext_h >= 2 * v.tm_height, `DrawText word wrap: ${v.drawtext_h}`);
});
