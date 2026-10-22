// In-world frame measurement of an OpenMW port: its engine page straight into an exterior cell as a new character
// (?start=<cell>), then the player walking (W held) and turning for --seconds: the frames the engine drew (a frame: an
// animation frame with draws) — their gaps (p50, p99, max, counts over 100 and 250 ms), the engine's work in each
// animation-frame callback, the synchronous WebGL calls per frame (readPixels, getError, checkFramebufferStatus,
// getShaderParameter/getProgramParameter), the data stalls (the streaming's) and the shader variants built. Prints
// the WebGL renderer and the tier the page chose. --discard: rasterizer discard forced (an init script turns
// RASTERIZER_DISCARD on and ignores its disable) — SwiftShader then runs no rasterization, so the numbers are the
// engine's CPU and the browser's (upper bounds: vertex work still runs). Not a gameplay check.
// Always through tools/with-browser-slot.sh:
//   tools/with-browser-slot.sh node tools/openmw/perf.mjs <manifest> --url <origin> [--seconds 60] [--warm 10]
//     [--start -2,-9] [--query tier=high] [--discard] [--run] [--out <dir>] [--mem-every s]   (--run: Shift held, running)
// --mem-every s: the page's memory every s seconds of the walk (port-perf.mjs memSampler) and its growth per 10 minutes;
// --seconds up to 3600 then (300 otherwise)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { memSampler } from '../port-perf.mjs';

const args = process.argv.slice(2), id = args[0], arg = (k, d = null) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
if (!id) throw new Error('Expected a manifest id');
const base = arg('--url', 'http://localhost:8080'), seconds = Math.max(5, Math.min(arg('--mem-every') ? 3600 : 300, Number(arg('--seconds', 60))));
const warm = Math.max(0, Number(arg('--warm', 10))), start = arg('--start', '-2,-9'), extra = arg('--query', '');
const discard = args.includes('--discard');
const dir = arg('--out', `/tmp/orthros-scratch/openmw-perf-${id}`);
fs.mkdirSync(dir, { recursive: true }); process.env.TMPDIR = dir;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const faults = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => faults.push(e.message));
  // (a measurement: nothing reported to the server — its learned order, telemetry and the gateway's client log stay clean)
  await page.route((u) => /\/clientlog$|\/api\/(telemetry|prefetch|profile-seed|programs|regions)(\/|$)/.test(u.pathname), (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204, body: '' }));
  await page.addInitScript((discard) => {
    const P = window.orthrosPerf = { draws: 0, frames: [], work: [], sync: {}, syncFrames: [], cur: {} };
    const proto = WebGL2RenderingContext.prototype;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = proto[name]; proto[name] = function (...a) { P.draws++; return f.apply(this, a); };
    }
    for (const name of ['readPixels', 'getError', 'checkFramebufferStatus', 'getShaderParameter', 'getProgramParameter', 'finish', 'clientWaitSync']) {
      const f = proto[name]; proto[name] = function (...a) { P.sync[name] = (P.sync[name] ?? 0) + 1; P.cur[name] = (P.cur[name] ?? 0) + 1; return f.apply(this, a); };
    }
    if (discard) {
      const RD = 0x8C89, enable = proto.enable, disable = proto.disable, getContext = HTMLCanvasElement.prototype.getContext;
      proto.disable = function (cap) { if (cap === RD) return; return disable.call(this, cap); };
      HTMLCanvasElement.prototype.getContext = function (...a) { const gl = getContext.apply(this, a); if (gl && gl instanceof WebGL2RenderingContext) enable.call(gl, RD); return gl; };
    }
    // (the engine's frame timed: the page pumps it, Module._omw_pump_frame, from a message after each animation frame)
    const raf = window.requestAnimationFrame.bind(window);
    // (and the Orthros build's skipped first plays of sounds: streamfs.js orthrosFileReady answering false)
    P.notReady = 0;
    const wrapReady = setInterval(() => {
      const r = window.orthrosFileReady; if (!r) return;
      window.orthrosFileReady = (name) => { const ok = r(name); if (!ok && P.on) P.notReady++; return ok; }; clearInterval(wrapReady);
    }, 50);
    const wrap = setInterval(() => {
      const M = window.Module, f = M?._omw_pump_frame; if (!f || f.orthrosTimed) return;
      const timed = function (...a) { const t0 = performance.now(); try { return f.apply(this, a); } finally { if (P.on) P.work.push(performance.now() - t0); } };
      timed.orthrosTimed = true; M._omw_pump_frame = timed; clearInterval(wrap);
    }, 50);
    let seen = 0;
    const tick = (t) => {
      if (P.draws !== seen) {
        seen = P.draws;
        if (P.on) { P.frames.push(t); P.syncFrames.push(P.cur); }
        P.cur = {};
      }
      raf(tick);
    };
    raf(tick);
  }, discard);
  const url = `${base}/ports/openmw/${encodeURIComponent(id)}/app/index.html?src=hosted&start=${encodeURIComponent(start)}&perfstats=1${extra ? '&' + extra : ''}`;
  const t0 = Date.now();
  await page.goto(url);
  // (in the world: Orthros' script's first report, view.lua — or the engine running and drawing for a while)
  await page.waitForFunction(() => window.omw?.state?.['orthros.view'] !== undefined || (window.Module?.__omwRunning && window.orthrosPerf.draws > 2000), null, { timeout: 600000, polling: 500 });
  const bootMs = Date.now() - t0;
  await page.mouse.click(640, 400);
  await page.waitForTimeout(warm * 1000);
  const before = await page.evaluate(() => ({ stall: window.__streamfsStats?.stallMs ?? null, misses: window.__omwShaderMisses ?? 0, cell: window.omw?.state?.['orthros.cell'] ?? null }));
  // (the exterior cells walked through: view.lua's report, looked at every half second)
  await page.evaluate(() => { const P = window.orthrosPerf; P.cells = new Set(); P.cellLook = setInterval(() => { const c = window.omw?.state?.['orthros.cell']; if (c) P.cells.add(c); }, 500); });
  await page.evaluate(() => { window.orthrosPerf.on = true; });
  if (args.includes('--run')) await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  const memStop = arg('--mem-every') ? await memSampler(page, Number(arg('--mem-every')), '() => Module.HEAPU8.length') : null;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { await page.mouse.move(640 + 60, 400, { steps: 4 }); await page.mouse.move(640, 400, { steps: 4 }); await page.waitForTimeout(400); }
  const mem = memStop ? await memStop() : null;
  await page.keyboard.up('w');
  if (args.includes('--run')) await page.keyboard.up('Shift');
  const r = await page.evaluate(({ before }) => {
    const P = window.orthrosPerf; P.on = false; clearInterval(P.cellLook);
    const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : null; };
    const gaps = P.frames.slice(1).map((t, i) => t - P.frames[i]), secs = (P.frames.at(-1) - P.frames[0]) / 1000;
    let renderer = null; try { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); renderer = gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER); } catch { /* none */ }
    const perFrame = {}; for (const f of P.syncFrames) for (const [k, v] of Object.entries(f)) perFrame[k] = (perFrame[k] ?? 0) + v;
    for (const k of Object.keys(perFrame)) perFrame[k] = +(perFrame[k] / Math.max(1, P.syncFrames.length)).toFixed(3);
    const log = document.querySelector('#log')?.textContent ?? '';
    return {
      renderer, tier: window.__omwTier ?? null, tierChoice: window.orthrosTierChoice ?? null, tierLog: /\[tier\][^\n]*/.exec(log)?.[0] ?? null,
      frames: P.frames.length, fps: +(P.frames.length / Math.max(0.001, secs)).toFixed(2),
      gap: { p50: q(gaps, 0.5), p90: q(gaps, 0.9), p99: q(gaps, 0.99), max: q(gaps, 1), over100: gaps.filter((g) => g > 100).length, over250: gaps.filter((g) => g > 250).length },
      work: { p50: q(P.work, 0.5), p90: q(P.work, 0.9), p99: q(P.work, 0.99), max: q(P.work, 1), over50: P.work.filter((w) => w > 50).length, over100: P.work.filter((w) => w > 100).length },
      syncPerFrame: perFrame, syncTotal: P.sync,
      dataStallMs: window.__streamfsStats ? +(window.__streamfsStats.stallMs - (before.stall ?? 0)).toFixed(0) : null,
      shaderVariantsBuilt: (window.__omwShaderMisses ?? 0) - before.misses, soundsNotReady: P.notReady, cells: [...P.cells],
      phase: window.__omwPhase ?? null,
    };
  }, { before });
  const out = { manifest: id, discard, seconds, warm, start, query: extra, bootMs, ...r, ...(mem ? { memGrowthPer10min: mem.growthPer10min, memFirst: mem.samples[0], memLast: mem.samples.at(-1), memSamples: mem.samples } : {}), faults };
  fs.writeFileSync(path.join(dir, 'perf.json'), JSON.stringify(out, null, 2));
  await page.screenshot({ path: path.join(dir, 'perf.png') });
  console.log(JSON.stringify(out));
} finally { await browser.close(); }
