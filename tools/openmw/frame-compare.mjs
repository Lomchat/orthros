// Pictures of an OpenMW port's engine compared between page variants (each a query string: e.g. the engine's switches,
// ?omwenv=OPENMW_ORTHROS_UNIFORMS=0, against the defaults): for each view a new character started in its cell (?start=),
// the world held still where it can be (the console's `tai`: no AI moves; `set timescale to 0`: the sun stays), the time
// of day set (the engine's omw_debug_sethour), the camera turned (omw_debug_look), and the engine's canvas captured
// once the view settled, the page's own overlays hidden (the game data's indicator). The first variant is captured
// twice: what differs between those two captures (water, sky, particles) is the noise; a variant is the same picture
// when it differs from the first by no more than that. Per view: the mean absolute difference (0-255) and the share of
// pixels differing by more than 24 in a channel, for each variant against the first and for the repeat. Use a game
// without interface addons (their messages come and go): morrowind-goty-en. SwiftShader draws (no rasterizer discard):
// slow, the views wait. Not a gameplay check. Always through tools/with-browser-slot.sh:
//   tools/with-browser-slot.sh node tools/openmw/frame-compare.mjs <manifest> --url <origin> [--variant <query>]...
//     [--views day,night,interior] [--exterior -2,-9] [--interior "Seyda Neen, Arrille's Tradehouse"] [--settle 20]
//     [--frames 4] [--out <dir>]   (--frames: captures a view, 1.5 s apart, averaged — interiors' lights flicker)
//   The first --variant is the reference ('' for the page's defaults); views: day (the exterior at 13 h, the camera
//   turned south-west, slightly down), night (the same at 22 h), interior (the cell --interior at 13 h).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from '../port-perf.mjs';

const args = process.argv.slice(2), id = args[0], arg = (k, d = null) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
if (!id) throw new Error('Expected a manifest id');
const base = arg('--url', 'http://localhost:8080'), exterior = arg('--exterior', '-2,-9'), settle = Number(arg('--settle', 20)), frames = Math.max(1, Number(arg('--frames', 4)));
const variants = args.flatMap((a, i) => (a === '--variant' ? [args[i + 1] ?? ''] : []));
if (!variants.length) variants.push('');
const views = arg('--views', 'day,night,interior').split(',').filter(Boolean);
const interior = arg('--interior', "Seyda Neen, Arrille's Tradehouse");
const dir = arg('--out', `/tmp/orthros-scratch/openmw-frames-${id}`);
fs.mkdirSync(dir, { recursive: true }); process.env.TMPDIR = dir;
const VIEW = {
  day: { start: exterior, hour: 13, look: [225, -8] },
  night: { start: exterior, hour: 22, look: [225, -8] },
  interior: { start: interior, hour: 13, look: [0, -5] },
};

const browser = await chromium.launch(launchOptions({ gl: 'swiftshader', channel: arg('--channel', 'chromium') }));
const shots = {}, faults = [];
try {
  // (the reference twice — its second run the noise —, then each other variant)
  const runs = [{ name: 'ref', q: variants[0] }, { name: 'ref2', q: variants[0] }, ...variants.slice(1).map((q, i) => ({ name: `v${i + 1}`, q }))];
  for (const v of views) {
    const view = VIEW[v]; if (!view) throw new Error(`unknown view ${v}`);
    for (const run of runs) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      page.on('pageerror', (e) => faults.push(`${v}/${run.name}: ${e.message}`));
      await page.route((u) => /\/clientlog$|\/api\/(telemetry|prefetch|profile-seed|programs|regions)(\/|$)/.test(u.pathname), (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204, body: '' }));
      await page.goto(`${base}/ports/openmw/${encodeURIComponent(id)}/app/index.html?src=hosted&start=${encodeURIComponent(view.start)}&novid${run.q ? '&' + run.q : ''}`);
      await page.waitForFunction(() => window.omw?.state?.['orthros.view'] !== undefined, null, { timeout: 900000, polling: 500 });
      await page.mouse.click(640, 400);
      await page.waitForTimeout(5000);
      // (the world held still: no AI moves, the clock stopped once set)
      await page.keyboard.press('Backquote'); await page.waitForTimeout(800);
      for (const c of ['tai', 'set timescale to 0']) { await page.keyboard.type(c); await page.keyboard.press('Enter'); await page.waitForTimeout(400); }
      await page.keyboard.press('Backquote'); await page.waitForTimeout(800);
      await page.evaluate((h) => window.Module._omw_debug_sethour?.(h), view.hour);
      await page.evaluate(([y, p]) => window.Module._omw_debug_look?.(y, p), view.look);
      await page.waitForTimeout(settle * 1000);
      // (the engine's canvas alone: the page's fixed overlays — the game data's indicator — hidden)
      const engine = await page.evaluateHandle(() => {
        const c = window.Module?.canvas ?? document.getElementById('canvas') ?? document.querySelector('canvas');
        for (const o of document.querySelectorAll('canvas')) if (o !== c && getComputedStyle(o).position === 'fixed') o.style.display = 'none';
        return c;
      });
      // (several captures 1.5 s apart, averaged when compared: interiors' lights flicker)
      const files = [];
      for (let k = 0; k < frames; k++) {
        const file = path.join(dir, `${v}-${run.name}-${k}.png`);
        await engine.asElement().screenshot({ path: file }); files.push(file);
        if (k < frames - 1) await page.waitForTimeout(1500);
      }
      (shots[v] ??= {})[run.name] = files;
      await context.close();
    }
  }
  // (the differences, decoded in a page: two pictures' pixels side by side)
  const page = await browser.newPage();
  const diff = (a, b) => page.evaluate(async ([xs, ys]) => {
    const load = async (b64) => { const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext('2d'); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height).data; };
    // (a run's captures averaged)
    const mean = async (list) => { const all = await Promise.all(list.map(load)), m = new Float32Array(all[0].length); for (const d of all) for (let i = 0; i < m.length; i++) m[i] += d[i] / all.length; return m; };
    const [p, q] = await Promise.all([mean(xs), mean(ys)]);
    if (p.length !== q.length) return { error: 'sizes differ' };
    let sum = 0, over = 0; const n = p.length / 4;
    for (let i = 0; i < p.length; i += 4) {
      const r = Math.abs(p[i] - q[i]), g = Math.abs(p[i + 1] - q[i + 1]), b = Math.abs(p[i + 2] - q[i + 2]);
      sum += (r + g + b) / 3; if (Math.max(r, g, b) > 24) over++;
    }
    return { meanAbs: +(sum / n).toFixed(3), over24: +(over / n * 100).toFixed(3) };
  }, [a.map((f) => fs.readFileSync(f).toString('base64')), b.map((f) => fs.readFileSync(f).toString('base64'))]);
  const report = {};
  for (const v of views) {
    const s = shots[v]; report[v] = { noise: await diff(s.ref, s.ref2) };
    variants.slice(1).forEach((q, i) => { report[v][q] = null; });
    for (let i = 1; i < variants.length; i++) report[v][variants[i]] = await diff(s.ref, s[`v${i}`]);
  }
  const out = { manifest: id, url: base, reference: variants[0], views: report, shots: dir, faults };
  fs.writeFileSync(path.join(dir, 'compare.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
} finally { await browser.close(); }
