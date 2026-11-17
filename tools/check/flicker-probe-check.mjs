// Checks in headless Chromium what the floating-point formats and the flicker probe rely on:
// - float blits (src/gfx/d3d8-webgl.js stretchRect): WebGL 2 blits between an RGBA32F / RGBA16F target and an RGBA8 one,
//   both ways, nearest and linear, without a GL error, converting as Direct3D does (clamped into RGBA8); and whether
//   the color write mask applies to a blit (the backend sets a float target's missing channels to 1 after one anyway);
// - the flicker probe (src/gfx/flicker-probe.js) on synthetic frames of 800 x 600: a 4 x 4 patch that goes A-B-A is
//   counted (16 pixels) in its block, a still frame and a scroll are not, and its cost (CPU time of present() at the
//   sample's frames and at the others; GPU work of a sample: gl.finish() timed with and without it).
// Usage: tools/with-browser-slot.sh node tools/check/flicker-probe-check.mjs [--old <repo copy>]  (--old: the same
// flicker scenes through that copy's probe too, for a before / after)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

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
    // (a frame: vertical stripes 16 pixels wide, shifted by `shift`; a 4 x 4 patch at (403, 301) of value `patch`)
    const frame = (shift, patch) => {
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
      for (let i = 0; i < frames.length + 30; i++) {
        const [shift, patch] = frames[Math.min(i, frames.length - 1)]; frame(shift, patch);
        const t0 = performance.now(); probe.present(back, w, h); cpu.push(performance.now() - t0);
        gl.finish(); await new Promise((r) => setTimeout(r, 0));
        if (probe.stats.n) break;
      }
      const s = probe.stats;
      const mask = /mask \d+x\d+ ([0-9a-f]+)/.exec(logs[0] ?? '')?.[1] ?? '', blocks = [];
      for (let k = 0; k < mask.length * 4; k++) if ((parseInt(mask[k >> 2], 16) >> (3 - (k & 3))) & 1) blocks.push([k % W, Math.floor(k / W)]);
      return { n: s.n, abaPpm: s.aba, chgPpm: s.chg, abaPixels: Math.round(s.aba * w * h / 1e6), alt: s.alt, over1: s.over1, glErrors: s.glErrors, blocks, sampleCpuMs: cpu.slice(0, 3).map((v) => +v.toFixed(2)) };
    };
    const out = {};
    out.patch = await run([[0, 0.15], [0, 0.85], [0, 0.15]]);
    out.still = await run([[0, 0.15], [0, 0.15], [0, 0.15]]);
    out.scroll = await run([[0, null], [3, null], [6, null]]);
    // (cost: present() between samples, and the GPU time of a sample's frames — finish() after each, with and without)
    const probe = new FlickerProbe(gl, { now: () => t }); t += 20000;
    let idle = 0; for (let i = 0; i < 210; i++) { const t0 = performance.now(); probe.present(back, w, h); if (i >= 10) idle += performance.now() - t0; } // (the first 3 sample, then their readback: the last 200 idle)
    // (a sample's work, GPU included: 20 samples' three frames timed with present() and a 1-pixel readback — a full sync
    // — after each, against the same frames without the probe; one probe, its program compiled at the warm-up)
    globalThis.ORTHROS_FLICKER = 1;
    const px = new Uint8Array(4), sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, back); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const gpu = (withProbe) => {
      let ms = 0;
      for (let k = 0; k < 20; k++) {
        t += 20000;
        for (let i = 0; i < 3; i++) { frame(0, 0.5); sync(); const t0 = performance.now(); if (withProbe) probe.present(back, w, h); sync(); ms += performance.now() - t0; }
        if (withProbe) for (let i = 0; i < 3; i++) { probe.present(back, w, h); sync(); } // (its readback taken)
      }
      return ms / 20;
    };
    out.idlePresentUs = +(1000 * idle / 200).toFixed(1);
    gpu(true);
    const g0 = gpu(false), g1 = gpu(true);
    out.sampleMs = +(g1 - g0).toFixed(2); out.sampleMsWith = +g1.toFixed(2); out.sampleMsWithout = +g0.toFixed(2);
    out.patchBlock = [Math.floor(403 * W / w), Math.floor(301 * 48 / h)];
    out.err = gl.getError();
    return out;
  }, src);
  const cur = await scenes('/src/gfx/flicker-probe.js');
  console.log(`flicker probe: ${JSON.stringify(cur)}`);
  check(cur.patch.n === 1 && cur.patch.abaPixels === 16 && JSON.stringify(cur.patch.blocks) === JSON.stringify([cur.patchBlock]), 'a 4 x 4 patch going A-B-A: its 16 pixels counted, in its block');
  check(cur.still.n === 1 && cur.still.abaPpm === 0 && cur.still.chgPpm === 0, 'a still frame: nothing');
  check(cur.scroll.n === 1 && cur.scroll.abaPpm === 0 && cur.scroll.alt === 0, 'a scroll: changes, no A-B-A');
  check(cur.err === 0 && cur.patch.glErrors === 0, 'no GL error');
  if (old) console.log(`flicker probe of ${old}: ${JSON.stringify(await scenes('/old/src/gfx/flicker-probe.js'))}`);
} finally { await browser.close(); }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
