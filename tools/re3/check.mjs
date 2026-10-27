// Browser check of an re3 port (docs/browser-ports.md, "re3 ports"): the home lists the version as available; its page
// starts the engine on the game's main menu, which draws and plays sound once the page is used (AUDIO: the buffers its
// OpenAL started, those not silent — `heard`, at least one wanted —, distinct ones; an engine that reads its effects
// bank sample by sample — Module.orthrosSamples, revc-lazy-sfx.patch — must have read one and played it: a heard buffer
// of one read sample's length, the streams' — music, voices, also heard — told apart); the engine's profile
// (its ini file, settings, caches: every file it writes in the game's folder) is kept in the browser; --new-game starts
// a new game from the game's own menu (clicks at the menu's places, the canvas' fractions: `--menu "0.5,0.401;0.5,0.365"`)
// and waits for its first scene (many draws a frame); --reload goes back to the games from the header (saving here and
// on the account), starts the game again in a new browser context — another device, signed in to the same account — and
// finds the same profile there. The player is an Orthros QA account (/tmp/orthros-scratch/qa-accounts.json, shared with
// tools/goldsrc/check.mjs); --guest: not signed in. --mode <id>: one of the version's ways to play (re3.modes, ?mode=; the
// first one by default); `free` starts in the city, without the menu: checked there instead of the menu and the new game.
// --keys k1,k2,…: keys pressed in the game's menu once it draws (Playwright's names, a third of a second each), then the
// city expected — a menu entry that starts a game (Orthros' Vice City: ArrowDown,Enter,Enter, its free mode).
// Evidence under /tmp/orthros-scratch/re3-check-<manifest>/.
// Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/re3/check.mjs <manifest> [--url http://127.0.0.1:8080] [--new-game] [--reload]
//     [--guest] [--lang fr] [--menu "x,y;x,y"] [--mode story|free] [--keys ArrowDown,Enter,Enter]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { rendererOf } from '../port-perf.mjs';

const args = process.argv.slice(2), arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const [name] = args;
if (!name || name.startsWith('--')) { console.error('usage: check.mjs <manifest> [--url u] [--new-game] [--reload] [--guest] [--lang xx] [--menu "x,y;x,y"]'); process.exit(2); }
const base = arg('--url') ?? 'http://127.0.0.1:8080';
const root = `/tmp/orthros-scratch/re3-check-${name}`;
fs.mkdirSync(root, { recursive: true }); process.env.TMPDIR = root;
const manifest = await (await fetch(`${base}/api/manifest/${encodeURIComponent(name)}`)).json();
if (manifest.runtime !== 're3') throw new Error(`${name} is not an re3 version`);
const listed = (await (await fetch(`${base}/api/manifests`)).json()).find((m) => m.name === name);
if (!listed?.available) throw new Error(`${name} is not available on the home: ${JSON.stringify(listed)}`);
console.log('HOME', JSON.stringify({ title: listed.title, version: listed.version, launchUrl: listed.launchUrl, modes: listed.modes }));
const mode = arg('--mode') ?? (listed.modes?.length > 1 ? listed.modes[0] : null);
if (mode && !listed.modes?.includes(mode)) throw new Error(`${name} has no mode ${mode}: ${JSON.stringify(listed.modes)}`);
const query = new URLSearchParams({ ...(arg('--lang') ? { gameLang: arg('--lang') } : {}), ...(mode ? { mode } : {}) }).toString();
const pageUrl = `${base}${listed.launchUrl}${query ? `?${query}` : ''}`;
const inCity = mode === 'free'; // (the free mode starts in the city: no menu, no new game)
// (the menu's places: "Start game", then "New game" — fractions of the canvas, the game's menu being centred)
const menu = (arg('--menu') ?? '0.5,0.401;0.5,0.365').split(';').map((p) => p.split(',').map(Number));

const qaFile = '/tmp/orthros-scratch/qa-accounts.json';
let qa = []; try { qa = JSON.parse(fs.readFileSync(qaFile, 'utf8'))[base] ?? []; } catch { /* none yet */ }
const guest = args.includes('--guest');
async function signIn(context, clean = true) {
  if (guest) return null;
  const page = await context.newPage(); await page.goto(`${base}/?menu`);
  const known = qa[0];
  const account = known ?? { username: `qa-check-1-${Math.random().toString(36).slice(2, 7)}`, password: Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('') };
  const result = await page.evaluate(async ({ a, create }) => {
    const r = await fetch(create ? '/api/account/register' : '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: a.username, password: a.password }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { a: account, create: !known });
  if (result.status !== 200) throw new Error(`QA account ${account.username}: ${result.status} ${JSON.stringify(result.body)}`);
  if (!known) { qa[0] = account; let all = {}; try { all = JSON.parse(fs.readFileSync(qaFile, 'utf8')); } catch { /* new */ } all[base] = qa; fs.writeFileSync(qaFile, JSON.stringify(all, null, 1), { mode: 0o600 }); }
  // (a clean start: the account's earlier copy of this game removed — the check then knows what it finds there)
  if (clean) await page.evaluate((game) => fetch(`/api/cloud/${encodeURIComponent(game)}`, { method: 'DELETE' }), name);
  await page.close();
  return account.username;
}
const probe = () => {
  window.renderProbe = { draws: 0, frames: 0, audioContexts: [] };
  // (the engine's frames: it waits for the browser's next one after each, requestAnimationFrame)
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { window.renderProbe.frames++; cb(t); });
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!type) continue;
    for (const method of ['drawArrays', 'drawElements']) {
      const original = type.prototype[method];
      type.prototype[method] = function (...a) { window.renderProbe.draws++; return original.apply(this, a); };
    }
  }
  if (window.AudioContext) { const Original = window.AudioContext; window.AudioContext = class extends Original { constructor(...a) { super(...a); window.renderProbe.audioContexts.push(this); } }; }
  // (the sounds heard: each buffer the engine's OpenAL starts — a sample, a piece of a stream —, silent or not: a sample
  // whose bytes the engine never read plays as silence)
  const sounds = window.renderProbe.sounds = { started: 0, heard: 0, silent: 0, distinct: 0, lengths: [] }, loud = new WeakMap();
  const start = window.AudioBufferSourceNode?.prototype.start;
  if (start) window.AudioBufferSourceNode.prototype.start = function (...a) {
    const b = this.buffer;
    if (b) {
      if (!loud.has(b)) { const d = b.getChannelData(0); let l = false; for (let i = 0; i < d.length && !l; i += 3) l = Math.abs(d[i]) > 1e-3; loud.set(b, l); if (l) { sounds.distinct++; if (sounds.lengths.length < 4096) sounds.lengths.push(b.length); } }
      sounds.started++; if (loud.get(b)) sounds.heard++; else sounds.silent++;
    }
    return start.apply(this, a);
  };
};
/** The profile as the page keeps it: paths and sizes. */
const profileOf = (page) => page.evaluate(async () => { await portSession.save(); const db = await new Promise((ok, ko) => { const r = indexedDB.open(portSession.config.saveKey); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }); const files = await new Promise((ok) => { const r = db.transaction('profile').objectStore('profile').get('files'); r.onsuccess = () => ok(r.result ?? []); }); return files.map((f) => ({ path: f.path, size: f.data.length })).sort((a, b) => a.path.localeCompare(b.path)); });
/** Draws per frame over `ms` (the menu draws a few, a 3D scene hundreds). */
const drawRate = async (page, ms = 3000) => {
  const a = await page.evaluate(() => ({ ...renderProbe })); await page.waitForTimeout(ms);
  const b = await page.evaluate(() => ({ ...renderProbe }));
  return { perFrame: Math.round((b.draws - a.draws) / Math.max(1, b.frames - a.frames)), frames: b.frames - a.frames };
};
async function boot(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(180000); // (a screenshot of the city waits for SwiftShader's frame: seconds)
  page.on('pageerror', (error) => console.log('PAGE ERROR', error.message));
  page.on('console', (message) => { if (message.type() === 'error') console.log('CONSOLE', message.text().slice(0, 300)); });
  page.on('crash', () => console.log('CRASH', 'the page crashed'));
  await page.goto(pageUrl);
  await page.waitForFunction(() => ['running', 'error'].includes(window.portSession?.state), null, { timeout: 300000 });
  const state = await page.evaluate(() => ({ state: portSession.state, status: document.querySelector('#status')?.textContent, startup: portSession.startup }));
  console.log('BOOT', JSON.stringify({ ...state, renderer: await rendererOf(page) }));
  if (state.state !== 'running') throw new Error(state.status);
  // (its first images: the loading screen hides after ten)
  await page.waitForFunction(() => document.querySelector('#loader')?.classList.contains('hidden') || renderProbe.draws > 200, null, { timeout: 120000 });
  return page;
}
// (Chromium itself, headless: Playwright's lighter headless shell stops on an internal check of its browser process a
// minute or so into the free mode's city — docs/browser-ports.md, "re3 ports", State)
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const heartbeat = setInterval(async () => {
  for (const ctx of browser.contexts()) for (const page of ctx.pages()) try { console.log('PROGRESS', await page.evaluate(() => ({ state: portSession?.state, draws: renderProbe?.draws }))); } catch { /* closing */ }
}, 15000);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(probe);
  const player = await signIn(context);
  const page = await boot(context);
  await page.waitForTimeout(4000);
  const canvas = await page.locator('#canvas').boundingBox();
  const at = ([fx, fy]) => [canvas.x + fx * canvas.width, canvas.y + fy * canvas.height];
  // (the page used — the sound may start — by a click on its header: the game's menu takes a click anywhere for its
  // highlighted option, the original's way)
  await page.mouse.click(canvas.x + canvas.width * 0.3, canvas.y / 2);
  await page.waitForTimeout(1500);
  if (inCity) {
    // (the city at once: many draws a frame, once its models are streamed in)
    const t = Date.now(); let rate = { perFrame: 0 };
    while (Date.now() - t < 300000) { rate = await drawRate(page, 5000); if (rate.perFrame > 60) break; }
    await page.screenshot({ path: path.join(root, 'city.png') });
    if (rate.perFrame <= 60) throw new Error(`no city in the ${mode} mode (${JSON.stringify(rate)})`);
    console.log('CITY', JSON.stringify({ mode, ...rate, seconds: Math.round((Date.now() - t) / 1000) }));
  }
  if (!inCity) await page.screenshot({ path: path.join(root, 'menu.png') });
  if (!inCity) {
    const menuDraws = await drawRate(page);
    if (menuDraws.frames < 10 || menuDraws.perFrame < 3) throw new Error(`the menu does not draw (${JSON.stringify(menuDraws)} in 3 s)`);
    // (the menus keep the mouse free: the game's own cursor follows it)
    const locked = await page.evaluate(() => !!document.pointerLockElement);
    if (locked) throw new Error('the mouse is captured in the game\'s menu');
    const buffer = await page.evaluate(() => { const c = document.querySelector('#canvas'); return { width: c.width, height: c.height, css: [c.clientWidth, c.clientHeight] }; });
    console.log('MENU', JSON.stringify({ ...menuDraws, canvas, buffer, locked }));
  }
  if (arg('--keys') && !inCity) {
    // (the menu's keys: the game reads them once a frame — the menu draws at the screen's rate)
    for (const key of arg('--keys').split(',')) { await page.keyboard.down(key); await page.waitForTimeout(350); await page.keyboard.up(key); await page.waitForTimeout(1500); }
    await page.screenshot({ path: path.join(root, 'keys.png') });
    const t = Date.now(); let rate = { perFrame: 0 };
    while (Date.now() - t < 300000) { rate = await drawRate(page, 5000); if (rate.perFrame > 60) break; }
    await page.screenshot({ path: path.join(root, 'city.png') });
    if (rate.perFrame <= 60) throw new Error(`no city after the keys ${arg('--keys')} (${JSON.stringify(rate)})`);
    console.log('CITY', JSON.stringify({ keys: arg('--keys'), ...rate, seconds: Math.round((Date.now() - t) / 1000) }));
  }
  if (args.includes('--new-game') && !inCity) {
    for (const [i, p] of menu.entries()) { await page.mouse.move(...at(p), { steps: 4 }); await page.waitForTimeout(400); await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up(); await page.waitForTimeout(2500); await page.screenshot({ path: path.join(root, `menu-click-${i}.png`) }); }
    // (the first scene: many draws a frame, once its models are streamed in)
    const t = Date.now(); let rate = { perFrame: 0 };
    while (Date.now() - t < 300000) { rate = await drawRate(page, 5000); if (rate.perFrame > 60) break; }
    await page.screenshot({ path: path.join(root, 'new-game.png') });
    if (rate.perFrame <= 60) throw new Error(`no scene after the new game (${JSON.stringify(rate)})`);
    console.log('NEW GAME', JSON.stringify({ ...rate, seconds: Math.round((Date.now() - t) / 1000) }));
  }
  const audio = await page.evaluate(() => renderProbe.audioContexts.map((c) => c.state));
  if (!audio.includes('running')) throw new Error(`no sound: ${JSON.stringify(audio)}`);
  const { lengths, ...sounds } = await page.evaluate(() => renderProbe.sounds);
  const samples = await page.evaluate(() => portSession.engine?.orthrosSamples ?? null);
  // (a lazily read sample heard: a loud buffer as long as one of the samples read — frames, mono or forced to stereo)
  const readHeard = samples ? lengths.filter((n) => samples.frames.includes(n)).length : null;
  console.log('AUDIO', JSON.stringify({ ...sounds, ...(samples ? { samplesRead: samples.read, samplesSkipped: samples.skipped, readHeard } : {}) }));
  if (!(sounds.heard > 0)) throw new Error(`no sound heard: ${JSON.stringify(sounds)}`);
  if (samples && !(samples.read > 0 && readHeard > 0)) throw new Error(`no sample of the effects bank read and heard: ${JSON.stringify({ read: samples.read, skipped: samples.skipped, readHeard })}`);
  const saved = await profileOf(page);
  if (!saved.length) throw new Error('the profile is empty: the engine wrote nothing the page kept');
  console.log('PROFILE', JSON.stringify(saved));
  if (args.includes('--reload')) {
    await page.evaluate(() => document.exitPointerLock());
    // (the header's back to the games: it saves — here and on the account — and quits, once the player confirmed)
    await page.click('#tbGames'); await page.locator('#ask button.primary').click();
    await page.waitForURL((url) => url.pathname === '/', { timeout: 60000 });
    let again;
    if (player) {
      const cloud = await page.evaluate((game) => fetch(`/api/cloud/${encodeURIComponent(game)}/history`).then((r) => r.json()), name);
      console.log('ACCOUNT COPY', JSON.stringify(cloud?.versions?.slice(0, 3) ?? null));
      const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await other.addInitScript(probe);
      await signIn(other, false); // (the account's copy kept: it is what this other device must find)
      again = await boot(other);
    } else again = await boot(context);
    await again.waitForTimeout(3000);
    const restored = await profileOf(again);
    const wanted = saved.filter((f) => !/\.log$/i.test(f.path));
    if (!wanted.every((f) => restored.some((r) => r.path === f.path))) throw new Error(`profile not found again: ${JSON.stringify({ saved, restored })}`);
    console.log('PERSISTENCE', JSON.stringify({ saved: wanted.length, restored: restored.length, otherDevice: !!player }));
  }
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
    if (!(await p.evaluate(() => !!window.portSession).catch(() => false))) continue;
    const evidence = await p.evaluate(() => ({ state: portSession.state, logs: portSession.logs.slice(-150), draws: renderProbe.draws, audio: renderProbe.audioContexts.map((c) => c.state), sounds: renderProbe.sounds, samples: portSession.engine?.orthrosSamples ?? null, startup: portSession.startup, background: portSession.background }));
    fs.writeFileSync(path.join(root, `evidence-${ctx === context ? 0 : 1}.json`), JSON.stringify(evidence, null, 2));
    await p.screenshot({ path: path.join(root, `final-${ctx === context ? 0 : 1}.png`) });
  }
  console.log('PASSED', name);
} finally {
  clearInterval(heartbeat);
  await browser.close();
}
