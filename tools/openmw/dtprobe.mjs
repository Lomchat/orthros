// Round-8 validation probe of the draw thread (OPENMW_ORTHROS_DRAWTHREAD), scratch only. One browser, one page variant
// (--query). Modes:
//   --pictures: the main menu (no ?start), then a new character at --start: the world held still, F12 (the PNG the
//     engine writes), the world view, the inventory (menu mode, right button), the journal (J), a door-like cell change
//     (console coc into --interior) recorded by the compositor's screencast, then a save/load cycle (F5, F9, F5): each
//     save's pump time, the save's thumbnail (JPEG) and global map overlay (PNG) extracted from the file.
//   --watch <s>: boot at --start, then <s> seconds watched: the page's notices (#omw-fatal), navigations, the frames
//     shown, the engine's log lines about the draw thread (QA values: fail, lose, crash, refuse, mismatch, ?aa=2).
//   --fullscreen: (with --watch) the canvas asked fullscreen from a click, as SDL's fullscreen window mode does.
// Usage: tools/with-browser-slot.sh node tools/openmw/dtprobe.mjs <manifest> --url <origin> [--query q] --out <dir>
//   (--pictures | --watch 60 [--fullscreen]) [--discard]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from '../port-perf.mjs';

const args = process.argv.slice(2), id = args[0], arg = (k, d = null) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const base = arg('--url'), query = arg('--query', ''), dir = arg('--out'), start = arg('--start', '-2,-9');
const interior = arg('--interior', "Seyda Nihyn, auberge d'Arrile"), discard = args.includes('--discard');
fs.mkdirSync(dir, { recursive: true }); process.env.TMPDIR = dir;
const out = { query, faults: [], log: [], navigations: 0 };
const browser = await chromium.launch(launchOptions({ gl: 'swiftshader', channel: 'chromium' }));
const wanted = /DIAG|omwSync|not a crash|WebGL|Too many|drawthread|draw thread|Orthros:|Global map|crash|lost|fatal|EXC|ABORT|worker sent an error|unwind|threw/i;
const app = (extra) => `${base}/ports/openmw/${encodeURIComponent(id)}/app/index.html?src=hosted&novid${extra}${query ? '&' + query : ''}`;

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => out.faults.push(e.message.slice(0, 300)));
  page.on('console', (m) => { const t = m.text(); if (wanted.test(t) && out.log.length < 400) out.log.push(`[${new Date().toISOString().slice(11, 23)}] ${t.slice(0, 400)}`); });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) out.navigations++; });
  await page.route((u) => /\/clientlog$|\/api\/(telemetry|prefetch|profile-seed|programs|regions)(\/|$)/.test(u.pathname), (r) => r.request().method() === 'GET' ? r.continue() : r.fulfill({ status: 204, body: '' }));
  await page.addInitScript((discard) => {
    if (discard) {
      const proto = WebGL2RenderingContext.prototype, RD = 0x8C89, enable = proto.enable, disable = proto.disable, getContext = HTMLCanvasElement.prototype.getContext;
      proto.disable = function (cap) { if (cap === RD) return; return disable.call(this, cap); };
      HTMLCanvasElement.prototype.getContext = function (...a) { const gl = getContext.apply(this, a); if (gl && gl instanceof WebGL2RenderingContext) enable.call(gl, RD); return gl; };
    }
    // (diagnostics: who loses a context, and every context-lost event with its stack)
    const ge = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function (name) {
      const x = ge.call(this, name);
      if (x && name === 'WEBGL_lose_context' && !x.__w) { const l = x.loseContext; x.loseContext = function () { console.log('DIAG loseContext called, lost already: ' + this.__gl?.isContextLost?.() + ' ' + new Error().stack.slice(0, 600)); return l.call(this); }; x.__gl = this; x.__w = true; }
      return x;
    };
    addEventListener('webglcontextlost', (e) => console.log('DIAG webglcontextlost on ' + (e.target?.id || e.target?.tagName) + ' trusted ' + e.isTrusted + ' ' + new Error().stack.slice(0, 400)), true);
    const gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...a) { const c = gc.apply(this, a); if (c && /webgl/.test(a[0]) && !this.__d) { this.__d = 1; this.addEventListener('webglcontextlost', (e) => console.log('DIAG canvas ' + (this.id || 'anon') + ' lost, trusted ' + e.isTrusted + ' ' + new Error().stack.slice(0, 500))); } return c; };
    const ogc = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (...a) { const c = ogc.apply(this, a); if (c && /webgl/.test(a[0])) console.log('DIAG offscreen context made, lost: ' + c.isContextLost() + ' ' + new Error().stack.slice(0, 400)); return c; };
    // (round 9: every __omwSync call logged, with its end or its throw — the crash notice's sync after the page aborted)
    let syncFn;
    Object.defineProperty(window, '__omwSync', { configurable: true, get: () => syncFn, set: (f) => { syncFn = typeof f !== 'function' ? f : function (...a) { console.log('DIAG omwSync called'); try { const r = f.apply(this, a); console.log('DIAG omwSync returned'); return r; } catch (e) { console.log('DIAG omwSync threw ' + e); throw e; } }; } });
    // (each pump's start and end, wall clock: the saves' and the cell change's long pumps)
    const P = window.__dtProbe = { pumps: [] };
    const wrap = setInterval(() => {
      const M = window.Module, f = M?._omw_pump_frame; if (!f || f.dtTimed) return;
      const timed = function (...a) { const t0 = performance.now(), d0 = Date.now(); try { return f.apply(this, a); } finally { const ms = performance.now() - t0; if (ms > 60 && P.pumps.length < 5000) P.pumps.push([d0, +ms.toFixed(1)]); } };
      timed.dtTimed = true; M._omw_pump_frame = timed; clearInterval(wrap);
    }, 20);
  }, discard);
  return { context, page };
}
const engineShot = async (page, file) => {
  const c = await page.evaluateHandle(() => {
    const c = window.Module?.canvas ?? document.getElementById('canvas');
    for (const o of document.querySelectorAll('canvas')) if (o !== c && o.id !== 'omw-drawthread-layer' && getComputedStyle(o).position === 'fixed') o.style.display = 'none';
    return c;
  });
  await c.asElement().screenshot({ path: path.join(dir, file) });
};
const consoleCmd = async (page, cmds) => {
  await page.keyboard.press('Backquote'); await page.waitForTimeout(800);
  for (const c of cmds) { await page.keyboard.type(c); await page.keyboard.press('Enter'); await page.waitForTimeout(500); }
  await page.keyboard.press('Backquote'); await page.waitForTimeout(800);
};
const inWorld = (page) => page.waitForFunction(() => window.omw?.state?.['orthros.view'] !== undefined, null, { timeout: 900000, polling: 500 });
const state = (page) => page.evaluate(() => ({ shown: window.__omwDrawThreadFrames ?? 0, present: window.__omwDrawThreadPresent ? (({ layer, ctx, lat, ...s }) => s)(window.__omwDrawThreadPresent) : null,
  prep: window.__omwDrawThreadPrep ?? null, fatal: document.getElementById('omw-fatal')?.textContent?.slice(0, 300) ?? null, dt: window.__omwDrawThread ? (({ drawMs, ...s }) => s)(window.__omwDrawThread) : null,
  crash: window.Module?.orthrosDrawThreadCrash ?? null, pumpTrap: window.__omwPumpTrap ?? null }));

try {
  if (args.includes('--pictures')) {
    // (1) the main menu (--no-menu: left out)
    if (!args.includes('--no-menu')) {
      const { context, page } = await newPage();
      await page.goto(app(''));
      // (the page's own menu first when no cell is asked: the engine's main menu if it comes within 3 min, else what shows)
      out.menuReached = await page.waitForFunction(() => window.Module?.__omwRunning, null, { timeout: 180000, polling: 500 }).then(() => true, () => false);
      await page.waitForTimeout(out.menuReached ? 25000 : 0);
      await page.screenshot({ path: path.join(dir, 'menu-page.png') });
      if (out.menuReached) await engineShot(page, 'menu.png');
      out.menu = await state(page);
      await context.close();
    }
    // (2) the world, the windows, a cell change, a save/load cycle
    const { context, page } = await newPage();
    await page.goto(app(`&start=${encodeURIComponent(start)}`));
    await inWorld(page);
    await page.mouse.click(640, 400); await page.waitForTimeout(5000);
    await consoleCmd(page, ['tai', 'set timescale to 0']);
    await page.evaluate(() => window.Module._omw_debug_sethour?.(13));
    await page.evaluate(() => window.Module._omw_debug_look?.(225, -8));
    await page.waitForTimeout(15000);
    await engineShot(page, 'world.png');
    // F12: the engine's own screenshot file
    // (every file under the page's file system, recursively: [path, mtime] — the screenshots' and the saves' folders found)
    const walk = (ext) => page.evaluate((ext) => { const r = []; const go = (d, depth) => { if (depth > 8) return; let names = []; try { names = FS.readdir(d); } catch { return; } for (const n of names) { if (n === '.' || n === '..') continue; const p = (d === '/' ? '' : d) + '/' + n; let st; try { st = FS.stat(p); } catch { continue; } if (FS.isDir(st.mode)) { if (!/^\/(proc|dev|mwdata|tmp)/.test(p)) go(p, depth + 1); } else if (p.toLowerCase().endsWith(ext)) r.push([p, st.mtime.getTime()]); } }; go('/userdata', 0); go('/home', 0); return r; }, ext);
    const listShots = async () => (await walk('.png')).map(([p]) => p);
    const shotsBefore = await listShots();
    await page.keyboard.press('F12'); await page.waitForTimeout(6000);
    const newShot = (await listShots()).find((n) => !shotsBefore.includes(n));
    if (newShot) fs.writeFileSync(path.join(dir, 'f12.png'), Buffer.from(await page.evaluate((n) => Array.from(FS.readFile(n)), newShot)));
    out.f12 = newShot ?? null;
    // the inventory (menu mode: the right button), then the journal
    await page.mouse.click(640, 400, { button: 'right' }); await page.waitForTimeout(6000);
    await engineShot(page, 'inventory.png');
    await page.mouse.click(640, 400, { button: 'right' }); await page.waitForTimeout(3000);
    await page.keyboard.press('j'); await page.waitForTimeout(6000);
    await engineShot(page, 'journal.png');
    await page.keyboard.press('j'); await page.waitForTimeout(3000);
    // the save/load cycle: F5, F9, F5 — each save's long pump and the files
    const saves = () => walk('.omwsave');
    const extract = (buf, tag) => {
      const jpg = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff])), jend = jpg >= 0 ? buf.indexOf(Buffer.from([0xff, 0xd9]), jpg) : -1;
      if (jpg >= 0 && jend > 0) fs.writeFileSync(path.join(dir, `${tag}-thumb.jpg`), buf.subarray(jpg, jend + 2));
      const png = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])), pend = png >= 0 ? buf.indexOf(Buffer.from('IEND'), png) : -1;
      if (png >= 0 && pend > 0) fs.writeFileSync(path.join(dir, `${tag}-map.png`), buf.subarray(png, pend + 8));
      return { thumb: jpg >= 0, map: png >= 0, bytes: buf.length };
    };
    out.saves = [];
    for (const [i, key] of [[1, 'F5'], [0, 'F9'], [2, 'F5']]) {
      const t0 = Date.now(), list0 = await saves();
      await page.keyboard.press(key);
      await page.waitForTimeout(key === 'F9' ? 30000 : 8000);
      const pumps = (await page.evaluate(() => window.__dtProbe.pumps)).filter(([d]) => d >= t0 - 50);
      const rec = { key, maxPumpMs: pumps.length ? Math.max(...pumps.map((p) => p[1])) : 0, pumps: pumps.slice(0, 20) };
      if (key === 'F5') {
        const list = await saves(); const newest = list.sort((a, b) => b[1] - a[1])[0];
        if (newest && !list0.some(([p, m]) => p === newest[0] && m === newest[1])) {
          const buf = Buffer.from(await page.evaluate((p) => Array.from(FS.readFile(p)), newest[0]));
          rec.file = newest[0]; Object.assign(rec, extract(buf, `save${i}`));
        }
      }
      out.saves.push(rec);
    }
    // the cell change, the compositor's frames recorded
    const cdp = await context.newCDPSession(page), frames = [];
    cdp.on('Page.screencastFrame', async (e) => { frames.push({ t: Date.now(), data: e.data }); cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {}); });
    await page.keyboard.press('Backquote'); await page.waitForTimeout(800);
    await page.keyboard.type(`coc "${interior}"`);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
    await page.waitForTimeout(1500);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(20000);
    await cdp.send('Page.stopScreencast');
    const pumps = (await page.evaluate(() => window.__dtProbe.pumps)).filter(([d]) => d >= t0 - 50);
    const longest = pumps.reduce((m, p) => (p[1] > (m?.[1] ?? 0) ? p : m), null);
    const loadEnd = longest ? longest[0] + longest[1] : null;
    out.door = { pumps: pumps.slice(0, 30), loadEnd, frames: frames.length };
    fs.mkdirSync(path.join(dir, 'door'), { recursive: true });
    frames.forEach((f, k) => fs.writeFileSync(path.join(dir, 'door', `${String(k).padStart(3, '0')}-${f.t - t0}.jpg`), Buffer.from(f.data, 'base64')));
    out.door.firstAfter = loadEnd ? frames.findIndex((f) => f.t > loadEnd) : null;
    out.final = await state(page);
    await context.close();
  } else {
    const watch = Number(arg('--watch', 60));
    const { context, page } = await newPage();
    const menu = args.includes('--menu');
    await page.goto(app(menu ? '' : `&start=${encodeURIComponent(start)}`));
    if (menu) out.menuReached = await page.waitForFunction(() => window.Module?.__omwRunning, null, { timeout: 180000, polling: 500 }).then(() => true, () => false);
    else await Promise.race([inWorld(page), page.waitForSelector('#omw-fatal', { timeout: 900000 })]).catch(() => {});
    out.atWorld = await state(page);
    if (args.includes('--fullscreen')) {
      await page.evaluate(() => { window.__fsAsk = () => { const c = window.Module.canvas; c.requestFullscreen().then(() => { window.__fsOk = String(document.fullscreenElement?.tagName); }, (e) => { window.__fsOk = 'refused ' + e.message; }); }; document.addEventListener('click', window.__fsAsk, { once: true }); });
      await page.mouse.click(640, 400); await page.waitForTimeout(5000);
      out.fullscreen = await page.evaluate(() => ({ ok: window.__fsOk ?? null, element: document.fullscreenElement?.tagName ?? null, layerVisible: (() => { const l = document.getElementById('omw-drawthread-layer'); if (!l) return null; const r = l.getBoundingClientRect(); return { w: r.width, h: r.height, display: getComputedStyle(l).display }; })() }));
      await page.screenshot({ path: path.join(dir, 'fullscreen.png') });
    } else await page.mouse.click(640, 400);
    const until = Date.now() + watch * 1000;
    out.samples = [];
    const saveAt = arg('--save-at') ? Date.now() + Number(arg('--save-at')) * 1000 : null;
    while (Date.now() < until) {
      await page.waitForTimeout(10000);
      const st = await state(page).catch((e) => ({ error: String(e).slice(0, 100) }));
      out.samples.push({ t: Math.round((until - Date.now()) / 1000), ...st });
      if (saveAt && Date.now() >= saveAt && !out.saved) {
        out.saved = true; await page.keyboard.press('F5'); await page.waitForTimeout(8000);
        out.savesBefore = await page.evaluate(() => { const r = []; const go = (d) => { let n = []; try { n = FS.readdir(d); } catch { return; } for (const x of n) { if (x === '.' || x === '..') continue; const p = d + '/' + x; try { const q = FS.stat(p); if (FS.isDir(q.mode)) go(p); else if (/\.omwsave$/i.test(x)) r.push([p, q.size, q.mtime.getTime()]); } catch {} } }; go('/userdata'); return r; }).catch((e) => String(e));
      }
      if ((st.crash || st.fatal) && !out.syncCheck) {
        // (the page after the draw thread's crash: its IndexedDB sync still completes? its saves still listed?)
        await page.waitForTimeout(3000);
        out.syncCheck = await page.evaluate(() => new Promise((res) => { const t = setTimeout(() => res({ syncfs: 'no callback in 15 s' }), 15000); try { FS.syncfs(false, (err) => { clearTimeout(t); res({ syncfs: err ? 'error ' + err : 'ok' }); }); } catch (e) { clearTimeout(t); res({ syncfs: 'threw ' + e }); } })).catch((e) => ({ error: String(e).slice(0, 200) }));
        out.syncCheck.saves = await page.evaluate(() => { const r = []; const go = (d) => { let n = []; try { n = FS.readdir(d); } catch { return; } for (const x of n) { if (x === '.' || x === '..') continue; const p = d + '/' + x; try { const q = FS.stat(p); if (FS.isDir(q.mode)) go(p); else if (/\.omwsave$/i.test(x)) r.push([p, q.size, q.mtime.getTime()]); } catch {} } }; go('/userdata'); return r; }).catch((e) => String(e));
        out.syncCheck.idb = await page.evaluate(() => new Promise((res) => { try { const rq = indexedDB.databases(); rq.then((l) => res(l.map((d) => d.name)), (e) => res(String(e))); } catch (e) { res(String(e)); } })).catch((e) => String(e));
      }
    }
    await page.screenshot({ path: path.join(dir, 'end.png') }).catch(() => {});
    await context.close();
  }
} finally {
  fs.writeFileSync(path.join(dir, 'probe.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, log: out.log.slice(-40) }).slice(0, 6000));
  await browser.close();
}
