// Browser check of a GoldSrc port (docs/browser-ports.md), from the Orthros home: the version's card starts its page,
// the engine boots to the game's main menu and draws, then the check enters the mode as the menu does (`solo`: the
// manifest's map, its commands already run by the page; `multiplayer`: the server its LAN search lists, 127.0.0.1:8080); `solo` then moves, saves, loads (--reload: quits, starts again and finds the save; --no-save:
// a game without saves — it joins (--join-keys), moves, and counts the players, bots included, --min-players);
// `multiplayer` runs two players in separate browser contexts on the version's dedicated server, checks both see
// each other, move, and receive the same score when the first one dies. Every player is signed in to an Orthros QA
// account (the only identity: its name in the game, its saves on the account — created once, then reused:
// /tmp/orthros-scratch/qa-accounts.json; --guest: the first player not signed in, solo only); --reload also starts the
// game again in a new browser context — another device — and finds the save there, from the account.
// Evidence under /tmp/orthros-scratch/.
// Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/goldsrc/check.mjs <manifest> <solo|multiplayer> [--url http://127.0.0.1:8080]
//     [--reload] [--join-keys "{n},1"] [--no-save] [--min-players n]   (keys each player presses after joining, {n}: its
//     number — a team menu)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { rendererOf } from '../port-perf.mjs';

const args = process.argv.slice(2), arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const [name, mode] = args;
if (!name || !['solo', 'multiplayer'].includes(mode)) { console.error('usage: check.mjs <manifest> <solo|multiplayer> [--url u] [--reload] [--join-keys k]'); process.exit(2); }
const base = arg('--url') ?? 'http://127.0.0.1:8080';
const root = `/tmp/orthros-scratch/goldsrc-check-${name}-${mode}`;
fs.mkdirSync(root, { recursive: true }); process.env.TMPDIR = root;
const manifest = await (await fetch(`${base}/api/manifest/${encodeURIComponent(name)}`)).json();
const pageUrl = `${base}/ports/goldsrc/${encodeURIComponent(name)}/?debug=1`;
// (the QA accounts: two, made once on this server and kept with their passwords in the scratch folder)
const qaFile = '/tmp/orthros-scratch/qa-accounts.json';
let qa = []; try { qa = JSON.parse(fs.readFileSync(qaFile, 'utf8'))[base] ?? []; } catch { /* none yet */ }
const guest = args.includes('--guest');
async function signIn(context, i, clean = true) {
  if (guest && i === 0) return null;
  const page = await context.newPage(); await page.goto(`${base}/?menu`);
  const known = qa[i];
  const account = known ?? { username: `qa-check-${i + 1}-${Math.random().toString(36).slice(2, 7)}`, password: Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('') };
  const result = await page.evaluate(async ({ a, create }) => {
    const r = await fetch(create ? '/api/account/register' : '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: a.username, password: a.password }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { a: account, create: !known });
  if (result.status !== 200) throw new Error(`QA account ${account.username}: ${result.status} ${JSON.stringify(result.body)}`);
  if (!known) { qa[i] = account; let all = {}; try { all = JSON.parse(fs.readFileSync(qaFile, 'utf8')); } catch { /* new */ } all[base] = qa; fs.writeFileSync(qaFile, JSON.stringify(all, null, 1), { mode: 0o600 }); }
  // (a clean start: the account's earlier copy of this game removed — the check then knows what it finds there)
  if (clean) await page.evaluate((game) => fetch(`/api/cloud/${encodeURIComponent(game)}`, { method: 'DELETE' }), name);
  await page.close();
  return account.username;
}
const nicknames = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const clients = [], keys = arg('--join-keys');
const enter = (page) => page.evaluate((command) => portSession.command(command), mode === 'solo' ? `map ${manifest.goldsrc.solo.map}` : 'connect 127.0.0.1:8080');
const focusGame = async (page) => { await page.bringToFront(); await page.evaluate(() => document.exitPointerLock()); await page.locator('#canvas').click(); };
const lastPos = (page) => page.evaluate(() => portSession.logs.filter((l) => /\borg \(/.test(l)).at(-1)?.match(/org \(([^)]+)\)/)?.[1]);
const heartbeat = setInterval(async () => {
  for (const { page } of clients) try { console.log('PROGRESS', await page.evaluate(() => ({ state: portSession?.state, status: document.querySelector('#status')?.textContent, draws: renderProbe?.draws }))); } catch { /* closing */ }
}, 10000);
try {
  for (let i = 0; i < (mode === 'multiplayer' ? 2 : 1); i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.addInitScript(() => {
      window.renderProbe = { draws: 0, audioContexts: [] };
      for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!type) continue;
        for (const method of ['drawArrays', 'drawElements']) {
          const original = type.prototype[method];
          type.prototype[method] = function (...a) { window.renderProbe.draws++; return original.apply(this, a); };
        }
      }
      if (window.AudioContext) { const Original = window.AudioContext; window.AudioContext = class extends Original { constructor(...a) { super(...a); window.renderProbe.audioContexts.push(this); } }; }
    });
    nicknames[i] = await signIn(context, i);
    const page = await context.newPage();
    page.on('pageerror', (error) => console.log('PAGE ERROR', error.message));
    page.on('dialog', (dialog) => { console.log('DIALOG', dialog.type(), dialog.message()); dialog.accept().catch(() => {}); });
    page.on('console', (message) => { if (message.type() === 'error') console.log('CONSOLE', message.text().slice(0, 300)); });
    clients.push({ context, page });
    if (i === 0) { // (the first player arrives from the home, as a visitor does)
      await page.goto(`${base}/?menu`);
      await page.locator(`[data-name="${manifest.gameId}"] .hm-play`).click();
      await page.waitForURL((u) => u.pathname === `/ports/goldsrc/${encodeURIComponent(name)}/`);
      console.log('HOME', 'the card opened', page.url());
      await page.goto(pageUrl);
    } else await page.goto(pageUrl);
    // (the game starts by itself: the account's saves, the engine, the files)
    await page.waitForFunction(() => ['running', 'error'].includes(window.portSession?.state), null, { timeout: 180000 });
    if (await page.evaluate(() => portSession.state) === 'running') { await page.waitForTimeout(3000); await enter(page); }
    const state = await page.evaluate(() => ({ state: portSession.state, status: document.querySelector('#status').textContent, draws: renderProbe.draws, multiplayer: portSession.multiplayer }));
    console.log('BOOT', i, JSON.stringify({ ...state, renderer: await rendererOf(page) }));
    if (state.state !== 'running') throw new Error(state.status);
    await page.waitForFunction(() => renderProbe.draws > 50, null, { timeout: 30000 });
    await page.waitForTimeout(7000);
    await page.screenshot({ path: path.join(root, `client-${i}.png`) });
    // (each player joins as soon as it is in, before the next one starts: one browser's renderer is shared by them)
    if (keys && (mode === 'multiplayer' || args.includes('--no-save'))) {
      await focusGame(page);
      for (const k of keys.split(',')) { await page.keyboard.press(k.replace('{n}', String(i + 1))); await page.waitForTimeout(1000); }
    }
  }
  if (mode === 'multiplayer' || args.includes('--no-save')) {
    await clients[0].page.waitForTimeout(8000); // (a round may freeze players at its start)
    for (const { page } of clients) {
      await page.evaluate(() => portSession.command('status'));
      // (a status line holds the name, followed by the address on a listen server)
      await page.waitForFunction((names) => names.every((n) => portSession.logs.some((l) => l.includes(n))), nicknames.slice(0, clients.length).filter(Boolean), { timeout: 20000 });
    }
    for (const { page } of clients) {
      await page.evaluate(() => portSession.command('viewpos')); await page.waitForTimeout(100);
      const before = await lastPos(page);
      await focusGame(page);
      let after = before;
      for (const key of ['w', 'd', 's', 'a']) {
        await page.keyboard.down(key); await page.waitForTimeout(1000); await page.keyboard.up(key);
        await page.evaluate(() => portSession.command('viewpos')); await page.waitForTimeout(100);
        after = await lastPos(page);
        if (after !== before) break;
      }
      if (!before || !after || before === after) throw new Error('Movement did not update the player position');
      console.log('MOVEMENT', JSON.stringify({ before, after }));
    }
    if (arg('--min-players')) {
      // (the players status lists: a line per client after its "# score ping ..." header, bots included)
      const page = clients[0].page;
      await page.evaluate(() => portSession.command('status')); await page.waitForTimeout(1500);
      const players = await page.evaluate(() => {
        const logs = portSession.logs, head = logs.findLastIndex((l) => l.includes('# score'));
        let n = 0; for (let i = head + 1; head >= 0 && i < logs.length && /^\[[^\]]*\]\s+\d+\s+-?\d+\s/.test(logs[i]); i++) n++;
        return n;
      });
      if (players < Number(arg('--min-players'))) throw new Error(`${players} players, fewer than ${arg('--min-players')}`);
      console.log('PLAYERS', players);
    }
  } else {
    const page = clients[0].page, saves = `/rwdir/${manifest.goldsrc.gameDir}/save`;
    await focusGame(page); await page.keyboard.down('w'); await page.waitForTimeout(1000); await page.keyboard.up('w');
    await page.evaluate(() => { portSession.command('save orthros_qa'); portSession.command('host_writeconfig'); });
    const listSaves = (dir) => { const FS = portSession.engine.em.FS; try { return FS.readdir(dir).filter((f) => f.startsWith('orthros_qa')).sort().map((f) => ({ f, size: FS.stat(dir + '/' + f).size })); } catch { return []; } };
    await page.waitForFunction((dir) => { try { return portSession.engine.em.FS.readdir(dir).some((f) => f.startsWith('orthros_qa')); } catch { return false; } }, saves, { timeout: 15000 });
    await page.evaluate(() => portSession.save());
    await page.evaluate(() => portSession.command('load orthros_qa')); await page.waitForTimeout(5000);
    if (args.includes('--reload')) {
      const saved = await page.evaluate(listSaves, saves);
      await page.evaluate(() => document.exitPointerLock());
      // (the header's back to the games: it saves — here and on the account — and quits, once the player confirmed)
      await page.click('#tbGames'); await page.locator('#ask button.primary').click();
      await page.waitForURL((url) => url.pathname === '/' && url.searchParams.has('menu'), { timeout: 60000 });
      const cloud = nicknames[0] ? await page.evaluate((game) => fetch(`/api/cloud/${encodeURIComponent(game)}/history`).then((r) => r.json()), name) : null;
      console.log('ACCOUNT COPY', JSON.stringify(cloud?.versions?.slice(0, 3) ?? null));
      // (signed in: started again in a new browser context — another device, nothing kept but the account; else here)
      let again = page;
      if (nicknames[0]) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }); clients.push({ context, page: null });
        await context.addInitScript(() => { window.renderProbe = { draws: 0, audioContexts: [] }; for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) { if (!type) continue; for (const method of ['drawArrays', 'drawElements']) { const original = type.prototype[method]; type.prototype[method] = function (...a) { window.renderProbe.draws++; return original.apply(this, a); }; } } if (window.AudioContext) { const Original = window.AudioContext; window.AudioContext = class extends Original { constructor(...a) { super(...a); window.renderProbe.audioContexts.push(this); } }; } });
        await signIn(context, 0, false); // (signed in again, the account's copy kept: it is what this device must find)
        again = await context.newPage(); clients.splice(0, clients.length, { context, page: again });
      }
      await again.goto(pageUrl);
      await again.waitForFunction(() => ['running', 'error'].includes(portSession?.state), null, { timeout: 180000 });
      const state = await again.evaluate(() => ({ state: portSession.state, status: document.querySelector('#status').textContent }));
      if (state.state !== 'running') throw new Error(state.status);
      await again.waitForTimeout(3000); await enter(again);
      await again.waitForFunction(() => renderProbe.draws > 50, null, { timeout: 30000 });
      const restored = await again.evaluate(listSaves, saves);
      if (JSON.stringify(restored) !== JSON.stringify(saved)) throw new Error('Saved files changed across quit and relaunch' + (nicknames[0] ? ' on another device' : '') + `: ${JSON.stringify({ saved, restored })}`);
      await again.evaluate(() => portSession.command('load orthros_qa')); await again.waitForTimeout(5000);
      console.log('PERSISTENCE', JSON.stringify({ saved, restored, otherDevice: !!nicknames[0] }));
    }
  }
  for (let i = 0; i < clients.length; i++) {
    const page = clients[i].page;
    const evidence = await page.evaluate(() => ({ state: portSession.state, logs: portSession.logs.slice(-100), draws: renderProbe.draws, audio: renderProbe.audioContexts.map((c) => c.state), saveAt: portSession.lastSaveAt ?? null }));
    fs.writeFileSync(path.join(root, `client-${i}.json`), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: path.join(root, `client-${i}-final.png`) });
    if (!evidence.audio.includes('running')) throw new Error('Audio did not resume with user interaction');
    console.log('EVIDENCE', i, JSON.stringify({ state: evidence.state, draws: evidence.draws, audio: evidence.audio }));
  }
  if (mode === 'multiplayer') {
    await clients[0].page.evaluate(() => portSession.command('kill')); await clients[0].page.waitForTimeout(3000);
    for (const { page } of clients) {
      await page.evaluate(() => portSession.command('status'));
      await page.waitForFunction((n) => portSession.logs.some((l) => /\]\s+\d+\s+-1\s+/.test(l) && l.endsWith(n)), nicknames[0], { timeout: 10000 });
    }
    console.log('SYNCHRONIZATION', 'both players received the same score update after player one died');
  }
  console.log('PASSED', name, mode);
} finally {
  clearInterval(heartbeat);
  await browser.close();
}
