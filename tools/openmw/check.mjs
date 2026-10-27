// Short browser smoke check of an OpenMW port: from its home card, the Orthros frame (shell.js) around it, solo, the
// engine drawing, the frame's header told its frame rate and the mouse (frame-meter.js). Not a multiplayer or gameplay
// validation. Always invoke through tools/with-browser-slot.sh.
// Usage: tools/with-browser-slot.sh node tools/openmw/check.mjs <manifest> [--url origin] [--seconds N] [--lang <code>]
//   --lang: the game language chosen on the card (its flag) before Play — the version that language runs is the one
//   checked (the manifest's languageVersions: e.g. morrowind-goty-en --lang fr checks the page of morrowind-goty-fr).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2), id = args[0], arg = (k) => args.includes(k) ? args[args.indexOf(k) + 1] : null;
if (!id) throw new Error('Expected a manifest id');
const base = arg('--url') ?? 'http://localhost:8080', seconds = Math.max(1, Math.min(30, Number(arg('--seconds') ?? 3)));
const lang = arg('--lang');
if (lang !== null && !/^[a-z]{2}$/.test(lang)) throw new Error('--lang expects a two-letter language code');
const dir = `/tmp/orthros-scratch/openmw-check-${id}${lang ? '-' + lang : ''}`;
fs.mkdirSync(dir, { recursive: true }); process.env.TMPDIR = dir;
const catalog = await (await fetch(base + '/api/manifests')).json(), entry = catalog.find((m) => m.name === id);
if (!entry?.available || entry.runtime !== 'openmw') throw new Error('OpenMW installation is not available');
const card = await (await fetch(base + `/api/manifest/${encodeURIComponent(id)}`)).json();
if (lang && !card.languages?.includes(lang)) throw new Error(`${id} offers no game language ${lang} (it has: ${(card.languages ?? []).join(', ')})`);
// (the version the language runs: its own page, languageLaunchUrls — the manifest whose saves and start cell are checked)
const target = lang && card.languageLaunchUrls?.[lang] ? decodeURIComponent(new URL(card.languageLaunchUrls[lang], base).pathname.split('/')[3]) : id;
const man = target === id ? card : await (await fetch(base + `/api/manifest/${encodeURIComponent(target)}`)).json();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const faults = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  page.on('pageerror', (e) => faults.push(e.message));
  await page.addInitScript(() => {
    window.orthrosDraws = 0;
    for (const name of ['drawArrays', 'drawElements']) {
      const original = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (...args) { window.orthrosDraws++; return original.apply(this, args); };
    }
  });
  await page.goto(base + '/?menu');
  if (lang) {
    // (the card's game-language flag: a single language is shown, not offered)
    const flag = page.locator(`[data-name="${man.gameId}"] .hm-opt[data-value="${lang}"]`);
    if (await flag.evaluate((el) => el.tagName === 'BUTTON')) await flag.click();
    await page.locator(`[data-name="${man.gameId}"] .hm-opt.on[data-value="${lang}"]`).waitFor({ timeout: 10000 });
  }
  await page.locator(`[data-name="${man.gameId}"] .hm-play`).click();
  await page.waitForURL((u) => u.pathname === `/ports/openmw/${encodeURIComponent(target)}/` && (!lang || u.searchParams.get('gameLang') === lang)); await page.click('#solo');
  const frame = page.frameLocator('#game');
  await frame.locator('#loading.hide').waitFor({ state: 'attached', timeout: 90000 });
  await page.waitForTimeout(seconds * 1000);
  // (the page hides its loading screen ~2.4 s after the engine's first frame-rate report: under a loaded software
  // renderer that can come after the fixed wait — waited for, up to 30 s, instead of read at once)
  await page.locator('#loader.hidden').waitFor({ state: 'attached', timeout: 30000 }).catch(() => {});
  const state = await frame.locator('body').evaluate(async () => ({
    isolated: crossOriginIsolated, draws: window.orthrosDraws, args: window.Module?.arguments,
    databases: (await indexedDB.databases()).map((d) => d.name), log: document.querySelector('#log')?.textContent.slice(-1600),
  }));
  const header = await page.evaluate(() => ({ fps: Number(document.querySelector('#tbPerf .fps')?.textContent), mouse: document.querySelector('#tbMouse')?.textContent, save: document.querySelector('#tbSave')?.textContent, loader: document.querySelector('#loader')?.classList.contains('hidden') }));
  Object.assign(state, { header });
  assert.equal(state.isolated, true); assert.ok(state.draws > 100, `Only ${state.draws} draws`);
  assert.ok(header.fps > 0, 'The header shows the engine\'s frame rate'); assert.ok(header.mouse, 'The mouse indicator'); assert.ok(header.loader, 'The loading screen gone once the engine draws');
  assert.ok(state.databases.includes(man.saveKey), 'Installation-specific browser saves');
  // (a start cell is the example world's only — src/ports/openmw/play.js: a hosted game starts at its menu or its save)
  if (man.openmw.example && man.openmw.startCell) assert.ok(state.args?.includes(man.openmw.startCell), 'The manifest start cell reaches the engine');
  assert.deepEqual(faults, []);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(state, null, 2));
  await page.screenshot({ path: path.join(dir, 'solo.png') });
  console.log(JSON.stringify({ ok: true, manifest: id, ...(lang ? { lang, ran: target } : {}), draws: state.draws, isolated: state.isolated, output: dir }));
} finally { await browser.close(); }
