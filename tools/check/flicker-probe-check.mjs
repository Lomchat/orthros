// Checks in headless Chromium what the floating-point formats and the flicker probe rely on:
// - float blits (src/gfx/d3d8-webgl.js stretchRect): WebGL 2 blits between an RGBA32F / RGBA16F target and an RGBA8 one,
//   both ways, nearest and linear, without a GL error, converting as Direct3D does (clamped into RGBA8); and whether
//   the color write mask applies to a blit (the backend sets a float target's missing channels to 1 after one anyway);
// - the flicker probe (src/gfx/flicker-probe.js) on synthetic frames of 800 x 600: a 4 x 4 patch that goes A-B-A is
//   counted (16 pixels) in its block, a still frame and a scroll are not, and its cost (CPU time of present() at the
//   sample's frames and at the others; GPU work of a sample: gl.finish() timed with and without it);
// - its capture (src/gfx/flicker-capture.js) on frames whose drawn square alternates (a uniform's color) over a still
//   background: one record sent, its three JPEG pictures decodable and showing the A-B-A, frames 1-2 differing in the
//   draw's uniforms and 1-3 not, under the size limit, WebGL's own methods back on the prototype afterwards.
// Usage: tools/with-browser-slot.sh node tools/check/flicker-probe-check.mjs [--old <repo copy>]  (--old: the same
// flicker scenes through that copy's probe too, for a before / after)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { decodeJpeg } from '../../src/gfx/codecs/jpeg.js';
import { CAPTURE_MAX_BYTES } from '../../src/shared/flicker-record.js';

const root = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2), old = args.includes('--old') ? args[args.indexOf('--old') + 1] : null;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl'] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
try {
  const page = await browser.newPage();
  await page.route('http://localhost:9/**', (r) => {
    const u = new URL(r.request().url()).pathname;
    const file = u.startsWith('/old/') && old ? path.join(old, u.slice(5)) : path.join(root, u);
    if (u === '/') return r.fulfill({ body: '<!doctype html><title>flicker</title><canvas id=c width=800 height=600></canvas>', contentType: 'text/html' });
    if (!fs.existsSync(file)) return r.fulfill({ status: 404 });
    r.fulfill({ body: fs.readFileSync(file), contentType: 'text/javascript' });
  });
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto('http://localhost:9/');

  // ---- float blits
  const fb = await page.evaluate(() => {
    const gl = document.getElementById('c').getContext('webgl2'), out = { renderer: gl.getParameter(gl.RENDERER), cbf: !!gl.getExtension('EXT_color_buffer_float'), f32lin: !!gl.getExtension('OES_texture_float_linear') };
    const target = (internal) => { const rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, internal, 4, 4); const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb); return f; };
    const blit = (src, dst, filter) => { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst); gl.blitFramebuffer(0, 0, 4, 4, 0, 0, 4, 4, gl.COLOR_BUFFER_BIT, filter); return gl.getError(); };
    const read8 = (f) => { const p = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p); return Array.from(p); };
    const readF = (f) => { const p = new Float32Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, p); return Array.from(p); };
    const f32 = target(gl.RGBA32F), f16 = target(gl.RGBA16F), u8 = target(gl.RGBA8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f32); gl.clearBufferfv(gl.COLOR, 0, [0.5, 2, -1, 0.25]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f16); gl.clearBufferfv(gl.COLOR, 0, [0.5, 2, -1, 0.25]);
    out.f32toU8Nearest = { err: blit(f32, u8, gl.NEAREST), px: read8(u8) };
    out.f32toU8Linear = { err: blit(f32, u8, gl.LINEAR) };
    out.f16toU8Linear = { err: blit(f16, u8, gl.LINEAR), px: read8(u8) };
    gl.bindFramebuffer(gl.FRAMEBUFFER, u8); gl.clearColor(0.2, 0.4, 0.6, 0.8); gl.clear(gl.COLOR_BUFFER_BIT);
    out.u8toF32 = { err: blit(u8, f32, gl.LINEAR), px: readF(f32) };
    gl.bindFramebuffer(gl.FRAMEBUFFER, f32); gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.colorMask(true, false, false, false); const e = blit(u8, f32, gl.NEAREST); gl.colorMask(true, true, true, true);
    out.maskedBlit = { err: e, px: readF(f32) };
    out.end = gl.getError();
    return out;
  });
  console.log(`float blits on ${fb.renderer} (EXT_color_buffer_float ${fb.cbf}, OES_texture_float_linear ${fb.f32lin}): ${JSON.stringify(fb)}`);
  check(fb.f32toU8Nearest.err === 0 && fb.f32toU8Nearest.px.join() === '128,255,0,64', 'RGBA32F -> RGBA8 blit, clamped');
  check(fb.f16toU8Linear.err === 0, 'RGBA16F -> RGBA8 linear blit');
  check(fb.u8toF32.err === 0 && Math.abs(fb.u8toF32.px[0] - 0.2) < 0.01, 'RGBA8 -> RGBA32F blit');
  console.log(`  RGBA32F linear blit: GL error 0x${fb.f32toU8Linear.err.toString(16)} (the backend point-samples 32-bit floats without OES_texture_float_linear); color mask applied to a blit: ${fb.maskedBlit.px[1] === 0 ? 'yes' : 'no'} (${fb.maskedBlit.px.map((v) => v.toFixed(2))})`);

  // ---- the flicker probe
  const scenes = async (src) => page.evaluate(async (src) => {
    const { FlickerProbe, W } = await import(src);
    const gl = document.getElementById('c').getContext('webgl2');
    const w = 800, h = 600, rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    const back = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, back); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    // (a textured picture: grey noise, a fixed pseudo-random sequence — a scroll over it brings a pixel's value back one
    // frame later by chance, as a scroll over a game's terrain does)
    const noiseFbo = (() => {
      const W2 = w + 64, px = new Uint8Array(W2 * h * 4); let s = 12345;
      for (let i = 0; i < px.length; i += 4) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; px[i] = px[i + 1] = px[i + 2] = s >>> 24; px[i + 3] = 255; }
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W2, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f;
    })();
    // (a frame: vertical stripes 16 pixels wide — or the noise — shifted by `shift`; a 4 x 4 patch at (403, 301) of value `patch`)
    const frame = (shift, patch, noise) => {
      if (noise) { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, noiseFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, back); gl.blitFramebuffer(shift, 0, shift + w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST); gl.bindFramebuffer(gl.FRAMEBUFFER, back); return; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, back); gl.enable(gl.SCISSOR_TEST);
      for (let x = -32; x < w; x += 16) { const v = ((x + 32) / 16) % 2 ? 0.3 : 0.7; gl.scissor(x + shift, 0, 16, h); gl.clearColor(v, v, v, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      if (patch !== null) { gl.scissor(403, 301, 4, 4); gl.clearColor(patch, patch, patch, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.disable(gl.SCISSOR_TEST);
    };
    let t = 0;
    const logs = [];
    globalThis.ORTHROS_FLICKER = 2; // (every sample logged: where it flickered)
    const run = async (frames) => {
      const probe = new FlickerProbe(gl, { now: () => t, errors: true, log: (m) => logs.push(m) }); t += 20000; logs.length = 0;
      const cpu = [];
      for (let i = 0; i < frames.length + 100; i++) {
        const [shift, patch, noise] = frames[Math.min(i, frames.length - 1)]; frame(shift, patch, noise);
        const t0 = performance.now(); probe.present(back, w, h); cpu.push(performance.now() - t0);
        gl.finish(); await new Promise((r) => setTimeout(r, 10));
        if (probe.stats.n) break;
      }
      const s = probe.stats;
      const mask = /mask \d+x\d+ ([0-9a-f]+)/.exec(logs[0] ?? '')?.[1] ?? '', blocks = [];
      for (let k = 0; k < mask.length * 4; k++) if ((parseInt(mask[k >> 2], 16) >> (3 - (k & 3))) & 1) blocks.push([k % W, Math.floor(k / W)]);
      return { n: s.n, abaPpm: s.aba, stillPpm: s.still, chgPpm: s.chg, abaPixels: Math.round(s.aba * w * h / 1e6), stillPixels: s.still === undefined ? undefined : Math.round(s.still * w * h / 1e6), alt: s.alt, over1: s.over1, glErrors: s.glErrors, blocks, sampleCpuMs: cpu.slice(0, 3).map((v) => +v.toFixed(2)) };
    };
    const out = {};
    out.patch = await run([[0, 0.15], [0, 0.85], [0, 0.15]]);
    out.still = await run([[0, 0.15], [0, 0.15], [0, 0.15]]);
    out.scroll = await run([[0, null], [3, null], [6, null]]);
    out.noiseScroll = await run([[0, null, true], [3, null, true], [6, null, true]]);
    out.noiseStill = await run([[0, null, true], [0, null, true], [0, null, true]]);
    // (cost: present() between samples, and the GPU time of a sample's frames — finish() after each, with and without)
    const probe = new FlickerProbe(gl, { now: () => t }); t += 20000;
    let idle = 0; for (let i = 0; i < 210; i++) { const t0 = performance.now(); probe.present(back, w, h); if (i >= 10) idle += performance.now() - t0; } // (the first 3 sample, then their readback: the last 200 idle)
    // (a sample's work, GPU included: 20 samples' three frames timed with present() and a 1-pixel readback — a full sync
    // — after each, against the same frames without the probe; one probe, its program compiled at the warm-up)
    globalThis.ORTHROS_FLICKER = 1;
    const px = new Uint8Array(4), sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, back); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    // (`scroll`: the noise scrolled 3 pixels a frame — A-B-A by chance on a few % of the pixels, whose surroundings the
    // probe then reads: its most expensive picture)
    const gpu = (withProbe, scroll = false) => {
      let ms = 0;
      for (let k = 0; k < 20; k++) {
        t += 20000;
        for (let i = 0; i < 3; i++) { if (scroll) frame(3 * i, null, true); else frame(0, 0.5); sync(); const t0 = performance.now(); if (withProbe) probe.present(back, w, h); sync(); ms += performance.now() - t0; }
        if (withProbe) for (let i = 0; i < 3; i++) { probe.present(back, w, h); sync(); } // (its readback taken)
      }
      return ms / 20;
    };
    out.idlePresentUs = +(1000 * idle / 200).toFixed(1);
    gpu(true);
    const g0 = gpu(false), g1 = gpu(true);
    out.sampleMs = +(g1 - g0).toFixed(2); out.sampleMsWith = +g1.toFixed(2); out.sampleMsWithout = +g0.toFixed(2);
    const s0 = gpu(false, true), s1 = gpu(true, true);
    out.sampleMsScroll = +(s1 - s0).toFixed(2);
    out.patchBlock = [Math.floor(403 * W / w), Math.floor(301 * 48 / h)];
    out.err = gl.getError();
    return out;
  }, src);
  const cur = await scenes('/src/gfx/flicker-probe.js');
  console.log(`flicker probe: ${JSON.stringify(cur)}`);
  check(cur.patch.n === 1 && cur.patch.stillPixels === 16 && cur.patch.abaPixels === 16 && JSON.stringify(cur.patch.blocks) === JSON.stringify([cur.patchBlock]), 'a 4 x 4 patch going A-B-A in a still picture: its 16 pixels counted as flicker, in its block');
  check(cur.still.n === 1 && cur.still.abaPpm === 0 && cur.still.chgPpm === 0, 'a still frame: nothing');
  check(cur.scroll.n === 1 && cur.scroll.abaPpm === 0 && cur.scroll.alt === 0, 'a scroll: changes, no A-B-A');
  check(cur.noiseScroll.n === 1 && cur.noiseScroll.abaPpm > 10000 && cur.noiseScroll.stillPpm === 0 && cur.noiseScroll.alt === 0 && cur.noiseScroll.over1 === 0 && cur.noiseScroll.blocks.length === 0, `a scroll over a texture: A-B-A by chance (${(cur.noiseScroll.abaPpm / 1e4).toFixed(2)} % of the pixels), no flicker, nothing flagged`);
  check(cur.noiseStill.n === 1 && cur.noiseStill.chgPpm === 0 && cur.noiseStill.stillPpm === 0, 'a still textured frame: nothing');
  check(cur.err === 0 && cur.patch.glErrors === 0, 'no GL error');
  if (old) console.log(`flicker probe of ${old}: ${JSON.stringify(await scenes('/old/src/gfx/flicker-probe.js'))}`);

  // ---- the capture: a 200 x 200 square drawn red / blue / red... over still stripes
  const cap = await page.evaluate(async () => {
    const { FlickerProbe } = await import('/src/gfx/flicker-probe.js');
    const gl = document.getElementById('c').getContext('webgl2'), w = 800, h = 600, native = (k) => /\[native code\]/.test(String(WebGL2RenderingContext.prototype[k]));
    const rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    const back = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, back); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; uniform vec4 u_color; out vec4 o; void main() { o = u_color; }'));
    gl.bindAttribLocation(prog, 0, 'p'); gl.linkProgram(prog);
    const uColor = gl.getUniformLocation(prog, 'u_color'), vao = gl.createVertexArray(), vb = gl.createBuffer();
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.25, -0.33, 0.25, -0.33, -0.25, 0.33, 0.25, 0.33]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    let n = 0;
    const frame = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, back); gl.viewport(0, 0, w, h); gl.enable(gl.SCISSOR_TEST);
      for (let x = 0; x < w; x += 16) { const v = (x / 16) % 2 ? 0.3 : 0.7; gl.scissor(x, 0, 16, h); gl.clearColor(v, v, v, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(prog); gl.uniform4fv(uColor, n++ % 2 ? [0, 0, 1, 1] : [1, 0, 0, 1]); gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    let t = 0, rec = null;
    const probe = new FlickerProbe(gl, { now: () => t, send: (r) => { rec = r; } });
    for (let i = 0; i < 400 && !rec; i++) { frame(); probe.present(back, w, h); gl.bindFramebuffer(gl.FRAMEBUFFER, null); t += 400; await new Promise((r) => setTimeout(r, 5)); }
    for (let i = 0; i < 50 && probe.cap; i++) { probe.present(back, w, h); await new Promise((r) => setTimeout(r, 5)); }
    return { rec, json: rec ? JSON.stringify(rec).length : 0, native: ['drawArrays', 'bindFramebuffer', 'uniform4fv', 'getUniformLocation'].every(native), err: gl.getError() };
  });
  const rec = cap.rec;
  check(!!rec, 'a capture sent after a flickering sample');
  if (rec) {
    const imgs = rec.images.map((b) => decodeJpeg(new Uint8Array(Buffer.from(b, 'base64'))));
    const at = (im, x, y) => { const o = 4 * (y * im.width + x); return [im.data[o], im.data[o + 1], im.data[o + 2]]; }, mid = (im) => at(im, im.width >> 1, im.height >> 1);
    console.log(`capture: ${cap.json} characters, pictures ${rec.img.join('x')} q ${rec.q} (${rec.images.map((b) => b.length).join(', ')} base64), centres ${imgs.map((im) => mid(im).join(',')).join(' / ')}; small ${JSON.stringify(rec.small)}; trigger ${JSON.stringify(rec.trigger)}; diff 1-2 ${JSON.stringify(rec.diff['1-2'].passes.map((p) => p.fields))}, 1-3 ${rec.diff['1-3'].passes.length} passes differ; notes ${JSON.stringify(rec.notes)}; ${rec.gl.renderer}`);
    const c = imgs.map(mid), red = (p) => p[0] > 200 && p[2] < 60, blue = (p) => p[2] > 200 && p[0] < 60;
    check(imgs.length === 3 && imgs.every((im) => im.width === rec.img[0]) && ((red(c[0]) && blue(c[1]) && red(c[2])) || (blue(c[0]) && red(c[1]) && blue(c[2]))), 'three pictures: the square red, blue, red (or the other way) in the middle');
    check(rec.small?.aba > 5, `the downscaled frames A-B-A (${rec.small?.aba} %)`);
    check(rec.frames.every((f) => f.draws === 1) && rec.diff['1-2'].passes.some((p) => p.fields.uni === 1) && rec.diff['1-3'].passes.length === 0, 'frames 1-2 differ in the draw\'s uniforms, 1-3 not');
    check(cap.json <= CAPTURE_MAX_BYTES && cap.native && cap.err === 0, 'under the size limit, WebGL\'s methods back, no GL error');
  }
} finally { await browser.close(); }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
