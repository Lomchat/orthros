// One run of the data matrix (tools/data-matrix.mjs): a new player in a fresh browser (no profile, no cache, no block
// store) opens a version as the home's Play does (/?manifest=<name>&gameLang=<l>: a Win32 game's page, or a port's page
// it hands over to) through the throttling proxy, and plays to the first moment it is playable: a Win32 game as it
// starts (the worker's PlayableWatch marks its menu), a GoldSrc port its solo map (`map <solo.map>` once running, as its
// menu's New Game), an re3 port a new game (the menu's clicks, re3/check.mjs's), an OpenMW port New Game (its menu).
// Prints one JSON line: { firstFrame, shown (loader hidden / menu), playable (the proxy saw the mark), inPlay, ... } —
// seconds from the page's navigation. Start it through tools/with-browser-slot.sh.
//   node tools/data-matrix-run.mjs --base https://127.0.0.1:<proxy> --manifest <name> [--lang en] [--seconds 1200] [--shot f.png]
import fs from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const base = opt('base'), name = opt('manifest'), lang = opt('lang', null), seconds = Number(opt('seconds', 1200));
// (the proxy's certificate is its own: NODE_TLS_REJECT_UNAUTHORIZED=0 for these two fetches, set by data-matrix.mjs)
const man = await (await fetch(`${base}/api/manifest/${encodeURIComponent(name)}`)).json();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const out = { manifest: name, lang, firstFrame: null, shown: null, playable: null, inPlay: null, error: null, notes: [] };
const t0 = Date.now(); const at = () => Math.round((Date.now() - t0) / 100) / 10;
const marks = async () => { try { return await (await fetch(`${base}/__proxy/marks`)).json(); } catch { return []; } };
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.renderProbe = { draws: 0, frames: 0 };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => { window.renderProbe.frames++; cb(t); });
    for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!type) continue;
      for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
        const f = type.prototype[m]; if (!f) continue; type.prototype[m] = function (...a) { window.renderProbe.draws++; return f.apply(this, a); };
      }
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(seconds * 1000);
  page.on('pageerror', (e) => out.notes.push('pageerror ' + e.message.slice(0, 200)));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const q = new URLSearchParams({ manifest: name, ...(lang ? { gameLang: lang } : {}) });
  await page.goto(`${base}/?${q}`);
  const deadline = t0 + seconds * 1000;
  const rt = man?.runtime ?? 'win32';
  const drawRate = async (ms = 3000) => {
    const f = rt === 'openmw' ? page.frames().find((x) => x.url().includes('/app/')) ?? page.mainFrame() : page.mainFrame();
    const a = await f.evaluate(() => ({ ...window.renderProbe })).catch(() => ({ draws: 0, frames: 0 })); await page.waitForTimeout(ms);
    const b = await f.evaluate(() => ({ ...window.renderProbe })).catch(() => ({ draws: 0, frames: 0 }));
    return { perFrame: (b.draws - a.draws) / Math.max(1, b.frames - a.frames), frames: b.frames - a.frames, draws: b.draws };
  };
  const markSeen = async () => (await marks()).some((m) => m.mark?.kind === 'playable' && m.url.endsWith('/' + encodeURIComponent(name)));
  if (rt === 'win32') {
    let steadyN = 0;
    for (;;) {
      if (Date.now() > deadline) { out.error = 'timeout'; break; }
      const s = await page.evaluate(() => window.orthros?.stats ?? null).catch(() => null);
      if (out.firstFrame === null && s?.d3d?.frames > 0) out.firstFrame = at();
      if (s?.net) out.pageNet = s.net;
      if (await markSeen()) { out.playable = at(); out.shown = out.playable; break; }
      // (steady: drawing at 10 fps or more for 8 s, nothing waited for the network — the menu on this loaded machine;
      // without the worker's mark (20 fps: SwiftShader may not reach it) the run ends 120 s later)
      if (out.firstFrame !== null && s && s.fps >= 10 && !s.net?.waiting) { steadyN++; if (steadyN >= 8 && out.steady === undefined) out.steady = Math.round((at() - 8) * 10) / 10; } else steadyN = 0;
      if (out.steady !== undefined && at() - out.steady > 120) { out.error = 'no mark 120 s after steady'; break; }
      await page.waitForTimeout(1000);
    }
  } else {
    // (the port's page: running, its first draws, its loader hidden — the mark of GoldSrc / re3)
    await page.waitForURL((u) => u.pathname.startsWith('/ports/'), { timeout: 60000 });
    for (;;) {
      if (Date.now() > deadline) { out.error = 'timeout before the game showed'; break; }
      const st = await page.evaluate(() => ({ state: window.portSession?.state, draws: window.renderProbe?.draws ?? 0, hidden: !!document.querySelector('#loader')?.classList.contains('hidden') })).catch(() => ({}));
      let draws = st.draws;
      if (rt === 'openmw') { const f = page.frames().find((x) => x.url().includes('/app/')); if (f) draws = await f.evaluate(() => window.renderProbe?.draws ?? 0).catch(() => 0); }
      if (out.firstFrame === null && draws > 0) out.firstFrame = at();
      if (st.state === 'error') { out.error = 'port error'; break; }
      if (rt === 'openmw' ? st.hidden && draws > 50 : st.hidden) { out.shown = at(); break; }
      if (rt === 'openmw' && st.state === undefined && page.url().includes('/ports/openmw/')) await page.click('#solo', { timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    if (!out.error) {
      if (await markSeen()) out.playable = at();
      if (rt === 'goldsrc') {
        await page.waitForFunction(() => window.portSession?.state === 'running', null, { timeout: Math.max(1000, deadline - Date.now()) }).catch(() => {});
        await page.waitForTimeout(2000);
        await page.evaluate((m) => window.portSession.command(`map ${m}`), man.goldsrc.solo.map).catch((e) => out.notes.push('map: ' + e.message));
        out.mapAt = at();
      } else if (rt === 're3') {
        const mode = man.modes?.[0] ?? null;
        if (mode !== 'free') {
          await page.waitForTimeout(4000);
          const c = await page.locator('#canvas').boundingBox();
          await page.mouse.click(c.x + c.width * 0.3, c.y / 2); await page.waitForTimeout(1500);
          for (const [fx, fy] of [[0.5, 0.401], [0.5, 0.365]]) { await page.mouse.move(c.x + fx * c.width, c.y + fy * c.height, { steps: 4 }); await page.waitForTimeout(400); await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up(); await page.waitForTimeout(2500); }
        }
        out.newGameAt = at();
      } else if (rt === 'openmw') {
        // (the main menu's New Game: the second button of the stack under the logo, keyboard first)
        await page.waitForTimeout(5000);
        const f = page.frameLocator('#game');
        const box = await page.locator('#game').boundingBox();
        if (opt('shot')) await page.screenshot({ path: opt('shot').replace(/\.png$/, '-menu.png') }).catch(() => {});
        const ng = (opt('newgame', '0.5,0.795')).split(',').map(Number);
        await page.mouse.click(box.x + box.width * ng[0], box.y + box.height * ng[1]); out.newGameAt = at();
        void f;
      }
      // in play: many draws a frame (a 3D scene) — and the mark (OpenMW: in the world)
      for (;;) {
        if (Date.now() > deadline) { out.error = 'timeout before play'; break; }
        if (out.playable === null && await markSeen()) out.playable = at();
        const r = await drawRate(3000);
        if (r.perFrame > 60 && (rt !== 'openmw' || out.playable !== null)) { out.inPlay = at(); break; }
      }
    }
  }
  if (opt('shot')) await page.screenshot({ path: opt('shot') }).catch(() => {});
} catch (e) { out.error = String(e.message ?? e).slice(0, 300); }
finally { out.wall = at(); await browser.close().catch(() => {}); }
console.log('RESULT ' + JSON.stringify(out));
fs.writeFileSync(opt('json', '/dev/null'), JSON.stringify(out));
