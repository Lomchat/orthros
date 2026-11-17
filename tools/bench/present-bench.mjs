// The GPU work Orthros' WebGL backend adds around a game's frame, measured alone (docs/render-worker.md section 12): a
// worker's OffscreenCanvas WebGL2 context, as the render worker has, renders N frames the way the backend does — the
// frame into a framebuffer object (RGBA8 + D24S8, cleared, one full-screen draw), blitted to the canvas, handed to the
// page (transferToImageBitmap -> bitmaprenderer) — and the GPU process's CPU per frame is read from /proc (headless
// Chromium on SwiftShader: the rasterizer runs on the CPU, its time is the GPU work). Variants:
//   canvas-ds    the canvas with a depth and stencil buffer (the backend before 2026-11-17)
//   canvas       the canvas without (now)
//   direct       the frame drawn straight into the canvas (with a depth and stencil buffer), no framebuffer object and
//                no blit: what the present's copy of the frame costs (the backend keeps it: docs/render-worker.md 12)
//   texdraw      the frame's color in a texture, copied to the canvas by a full-screen draw instead of a blit
//   map-rgba32f  canvas, plus a 1024x1024 one-channel float map drawn (one full quad) and read by a full-screen pass
//                with 4 point-sampled taps (a SAGE shadow map at High and its receivers), stored RGBA32F (before)
//   map-r32f     the same map stored R32F (now)
// usage: tools/with-browser-slot.sh node tools/bench/present-bench.mjs <W>x<H> <frames> <variant>... [--rounds n]
// (variants alternated round by round; one line of JSON per variant and round)
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2), rounds = Number(args[args.indexOf('--rounds') + 1]) || 1;
const [size, framesArg, ...rest] = args.filter((a, i) => a !== '--rounds' && args[i - 1] !== '--rounds');
const [W, H] = size.split('x').map(Number), N = Number(framesArg) || 60, variants = rest;
if (!W || !H || !variants.length) { console.error('usage: node tools/bench/present-bench.mjs <W>x<H> <frames> <canvas-ds|canvas|direct|texdraw|map-rgba32f|map-r32f>... [--rounds n]'); process.exit(2); }
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl'] });
/** CPU ticks (1/100 s) of this browser's GPU processes */
function gpuTicks() {
  let t = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { if (!fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('--type=gpu-process')) continue; const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'), f = st.slice(st.lastIndexOf(')') + 2).split(' '); t += Number(f[11]) + Number(f[12]); } catch { /* gone */ }
  }
  return t;
}
const workerSrc = `
onmessage = async (e) => {
  const { W, H, N, variant } = e.data, direct = variant === 'direct', texdraw = variant === 'texdraw', depth = variant === 'canvas-ds' || direct, map = variant.startsWith('map-') ? variant.slice(4) : null;
  const c = new OffscreenCanvas(W, H);
  const gl = c.getContext('webgl2', { alpha: false, antialias: false, depth, stencil: depth, preserveDrawingBuffer: false, premultipliedAlpha: false });
  gl.getExtension('EXT_color_buffer_float');
  const target = (w, h, internal) => { const fbo = gl.createFramebuffer(), rb = gl.createRenderbuffer(), db = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, internal, w, h); gl.bindRenderbuffer(gl.RENDERBUFFER, db); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, db); return fbo; };
  let back = direct ? null : target(W, H, gl.RGBA8), backTex = null;
  if (texdraw) { backTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, backTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H); gl.bindFramebuffer(gl.FRAMEBUFFER, back); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, backTex, 0); }
  let mapFbo = null, mapTex = null;
  if (map) {
    mapTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, mapTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, map === 'r32f' ? gl.R32F : gl.RGBA32F, 1024, 1024);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    mapFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mapTex, 0);
  }
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const prog = (fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, '#version 300 es\\nvoid main() { gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.5, 1.0); }')); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; };
  const plain = prog('#version 300 es\\nprecision highp float; out vec4 o; void main() { o = vec4(gl_FragCoord.xy / 4096.0, 0.5, 1.0); }');
  const depthWrite = prog('#version 300 es\\nprecision highp float; out vec4 o; void main() { o = vec4(fract(gl_FragCoord.x * 0.001 + gl_FragCoord.y * 0.0007)); }');
  const receive = prog('#version 300 es\\nprecision highp float; uniform sampler2D m; out vec4 o; void main() { vec2 uv = gl_FragCoord.xy / vec2(' + W + '.0, ' + H + '.0); float z = uv.x * 0.5 + 0.25, s = 0.0; for (int i = 0; i < 4; i++) s += texture(m, uv + vec2(float(i & 1), float(i >> 1)) / 1024.0).x < z - 0.002 ? 0.0 : 1.0; o = vec4(uv * s * 0.25, 0.5, 1.0); }');
  const copy = prog('#version 300 es\\nprecision highp float; uniform highp sampler2D t; out vec4 o; void main() { o = texelFetch(t, ivec2(gl_FragCoord.xy), 0); }');
  gl.bindVertexArray(gl.createVertexArray());
  postMessage({ ready: true });
  await new Promise((r) => { onmessage = r; });
  const inflight = [];
  const drain = async (max) => { while (inflight.length > max) { await new Promise((r) => setTimeout(r, 1)); while (inflight.length && gl.getSyncParameter(inflight[0], gl.SYNC_STATUS) === gl.SIGNALED) gl.deleteSync(inflight.shift()); } };
  for (let i = 0; i < N; i++) {
    if (map) { gl.bindFramebuffer(gl.FRAMEBUFFER, mapFbo); gl.viewport(0, 0, 1024, 1024); gl.disable(gl.DEPTH_TEST); gl.colorMask(true, false, false, false); gl.useProgram(depthWrite); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.colorMask(true, true, true, true); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, back); gl.viewport(0, 0, W, H); gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (map) { gl.useProgram(receive); gl.bindTexture(gl.TEXTURE_2D, mapTex); } else gl.useProgram(plain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (texdraw) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.DEPTH_TEST); gl.useProgram(copy); gl.bindTexture(gl.TEXTURE_2D, backTex); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    else if (!direct) { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, back); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST); }
    gl.flush();
    const bm = c.transferToImageBitmap();
    postMessage({ bm }, [bm]);
    inflight.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
    await drain(2);
  }
  await drain(0);
  postMessage({ done: true });
};`;
for (let r = 0; r < rounds; r++) {
  for (const variant of variants) {
    const page = await browser.newPage();
    await page.setContent(`<canvas id="c" width="${W}" height="${H}" style="width:640px;height:360px"></canvas>`);
    await page.evaluate(([src, W, H, N, variant]) => new Promise((resolve) => {
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onerror = (e) => { console.error(`worker: ${e.message}`); window.__done = true; resolve(); }; // (a broken variant ends instead of hanging)
      const ctx = document.getElementById('c').getContext('bitmaprenderer');
      window.__w = w; window.__frames = 0;
      w.onmessage = (e) => { if (e.data.ready) resolve(); else if (e.data.bm) { ctx.transferFromImageBitmap(e.data.bm); window.__frames++; } else if (e.data.done) window.__done = true; };
      w.postMessage({ W, H, N, variant });
    }), [workerSrc, W, H, N, variant]);
    await page.waitForTimeout(500);
    const t0 = gpuTicks(), w0 = Date.now();
    await page.evaluate(() => window.__w.postMessage('go'));
    await page.waitForFunction(() => window.__done, null, { timeout: 600000, polling: 100 });
    await page.waitForTimeout(300); // (the page's last frames composited)
    const gpuMs = (gpuTicks() - t0) * 10, wall = Date.now() - w0, frames = await page.evaluate(() => window.__frames);
    console.log(JSON.stringify({ round: r + 1, variant, size, frames, gpuMsPerFrame: +(gpuMs / N).toFixed(2), wallMsPerFrame: +(wall / N).toFixed(2) }));
    await page.close();
  }
}
await browser.close();
