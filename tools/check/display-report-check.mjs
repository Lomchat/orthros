// Checks a display report's two halves in headless Chromium, without a game (src/shared/display-report.js): a page with
// the player page's three stacked canvases (bitmaprenderer) shows the frames of a small WebGL2 renderer — a still
// background, a bar that moves every frame, a square drawn every other frame — presented through FrameReport
// (src/gfx/frame-report.js) as the backend's present does, while ScreenRecorder (src/web/screen-report.js) records
// the page at each requestAnimationFrame. Two presentation faults are made on purpose: once the page shows a red
// picture no back buffer had, once a picture of three frames before. The record is written as a telemetry line and
// read by tools/dev/flicker-report.mjs, which must find the alternation in both strips (still A-B-A), the red picture
// unmatched and the older one gone back.
// Usage: tools/with-browser-slot.sh node tools/check/display-report-check.mjs [--out <dir>] (default
// /tmp/orthros-scratch/display-report-check: the record, the tool's sheets and output)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : '/tmp/orthros-scratch/display-report-check';
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl'] });
let rec;
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  await page.route('http://localhost:9/**', (r) => {
    const u = new URL(r.request().url()).pathname, file = path.join(root, u);
    if (u === '/') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>report</title><div id=frame style="position:relative;width:640px;height:360px"><canvas id=c2d width=640 height=360 style="position:absolute;left:0;top:0;z-index:1"></canvas><canvas id=gl width=640 height=360 style="position:absolute;left:0;top:0;z-index:2"></canvas><canvas id=vid width=640 height=360 style="position:absolute;left:0;top:0;z-index:3;visibility:hidden"></canvas></div>' });
    if (!fs.existsSync(file)) return r.fulfill({ status: 404 });
    r.fulfill({ body: fs.readFileSync(file), contentType: 'text/javascript' });
  });
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:9/');
  rec = await page.evaluate(async () => {
    const { FrameReport } = await import('/src/gfx/frame-report.js');
    const { ScreenRecorder } = await import('/src/web/screen-report.js');
    const W = 640, H = 360, $ = (id) => document.getElementById(id), shown = $('gl').getContext('bitmaprenderer');
    const oc = new OffscreenCanvas(W, H), gl = oc.getContext('webgl2', { antialias: false, alpha: false });
    const rb = gl.createRenderbuffer(), fbo = gl.createFramebuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    const rect = (x, y, w, h, c) => { gl.scissor(x, y, w, h); gl.clearColor(...c, 1); gl.clear(gl.COLOR_BUFFER_BIT); };
    /** frame k's picture into the bound framebuffer: background, a bar k * 3 px long, the square on even frames */
    const draw = (k) => { gl.enable(gl.SCISSOR_TEST); rect(0, 0, W, H, [0.2, 0.3, 0.45]); rect(0, 0, W / 2, H / 3, [0.6, 0.5, 0.2]); rect(0, H - 20, (k * 3) % W, 12, [0.9, 0.9, 0.3]); if (k % 2 === 0) rect(300, 150, 40, 40, [1, 1, 1]); gl.disable(gl.SCISSOR_TEST); };
    const dev = { frame: 0, sigOn: false, dev: { backBuffers: [{ id: 7 }] }, flickerInfo: () => ({ mode: `${W}x${H}` }) };
    const screen = new ScreenRecorder({ layers: ['c2d', 'gl', 'vid'].map($), frame: $('frame') });
    let rep = null, bbDone, k = 0;
    const bb = new Promise((r) => { bbDone = r; });
    const t0 = performance.now(), faults = {};
    await new Promise((resolve) => {
      const step = () => {
        // (the renderer's present, as d3d8-webgl.js's: the back buffer bound, the report's turn, then the blit to the canvas)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); draw(k);
        if (k === 10) {
          rep = new FrameReport(gl, { id: 1, send: (m) => { if (m.started) screen.extendTo(m.started); else bbDone(m); } });
          screen.run().then((s) => { faults.screen = s; });
        }
        // (the frame's values record, as the backend's valPresent: the odd frames' draws read other shader constants)
        dev.valFrame = dev.sigOn ? { vsig: 0x11, draws: 5, tf: [], csig: k % 2 ? 0xc1 : 0xc2, cn: k % 2 ? 3 : 0, cd: k % 2 ? [1, 2, 4] : [] } : null;
        rep?.present(fbo, W, H, dev, dev.sigOn ? (k % 2 ? 0xb0b0 : 0xa0a0) : undefined);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        dev.frame++;
        let bm = oc.transferToImageBitmap();
        // (the faults: the page shows what no back buffer had, then a picture three frames old)
        if (k === 25 || k === 45) {
          bm.close(); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          if (k === 25) { gl.clearColor(0.9, 0.1, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT); } else draw(k - 3);
          bm = oc.transferToImageBitmap(); faults[k] = performance.now() - t0;
        }
        screen.arrived('gl', bm.width, bm.height, dev.frame - 1);
        shown.transferFromImageBitmap(bm);
        k++;
        if (performance.now() - t0 < 6000) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    const part = await bb;
    while (!faults.screen) await new Promise((r) => setTimeout(r, 50));
    return { event: 'display-report', v: 1, id: 1, session: 'check0001', game: 'synthetic', at: new Date().toISOString(), page: { frames: k }, bb: part.strip, screen: faults.screen, notes: part.notes ?? [] };
  });
} finally { await browser.close(); }

const line = JSON.stringify(rec), file = path.join(out, 'report.jsonl');
fs.writeFileSync(file, line + '\n');
console.log(`record: ${Math.round(line.length / 1024)} KB, back buffers ${rec.bb?.frames.length} frames (${rec.bb?.images.length} pictures), screen ${rec.screen?.frames.length} frames (${rec.screen?.images.length} pictures)`);
check(rec.bb?.frames.length >= 30 && rec.screen?.frames.length >= 30, 'both strips recorded (30 frames or more each)');
check((rec.bb?.analysis?.summary.stillFrames ?? 0) >= 10, `the back buffers' alternation found before the encode (${rec.bb?.analysis?.summary.stillFrames} frames with still A-B-A)`);
check(new Set(rec.bb?.frames.map((f) => f.sig)).size === 2, 'each frame\'s command signature kept');
check(new Set(rec.bb?.frames.map((f) => f.csig)).size === 2 && rec.bb?.frames.some((f) => f.cn === 3 && f.cd?.join() === '1,2,4'), 'and its shader constants record (csig, cn, cd)');
const text = execFileSync('node', [path.join(root, 'tools/dev/flicker-report.mjs'), file, '--out', out], { encoding: 'utf8' });
fs.writeFileSync(path.join(out, 'report.txt'), text);
const num = (re) => Number(re.exec(text)?.[1] ?? NaN);
check(num(/back buffers: \d+ frames, \d+ distinct pictures;[^\n]*?\((\d+) frames >= 0\.1 %; any/) >= 10, 'the tool finds the back buffers\' alternation on the decoded pictures');
check(num(/  screen: \d+ frames, \d+ distinct pictures;[^\n]*?\((\d+) frames >= 0\.1 %; any/) >= 5, 'and the screen\'s');
check(/shader constants signatures: 2 distinct .*draws reading other constants than the frame before: #\d+ 3 \(draws 1 2 4\)/.test(text), 'the tool names the frames whose draws read other shader constants');
check(num(/; (\d+) match no back buffer/) === 1, 'the red picture, and it alone: no back buffer had it');
check(num(/; (\d+) went BACK/) === 1 && num(/; (\d+) closer to another back buffer/) === 1, 'the picture three frames old, and it alone: the screen went back');
check(fs.readdirSync(out).some((f) => /^bb-check0001-1-p1\.png$/.test(f)) && fs.readdirSync(out).some((f) => /^screen-check0001-1-p1\.png$/.test(f)) && fs.readdirSync(out).some((f) => /^align-/.test(f)), 'contact sheets written');
console.log(text.split('\n').filter((l) => /^(---|  (back buffers|screen):)/.test(l)).join('\n'));
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
