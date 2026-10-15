// Browser check of a GoldSrc port (docs/browser-ports.md), from the Orthros home: the version's card starts its page,
// the engine boots and draws; `solo` then moves, saves, loads (--reload: quits, starts again and finds the save; --no-save:
// a game without saves — it joins (--join-keys), moves, and counts the players, bots included, --min-players);
// `multiplayer` runs two players in separate browser contexts on the version's dedicated server, checks both see
// each other, move, and receive the same score when the first one dies. Evidence under /tmp/orthros-scratch/.
// Start it through the browser slot guard:
//   tools/with-browser-slot.sh node tools/goldsrc/check.mjs <manifest> <solo|multiplayer> [--url http://127.0.0.1:8080]
//     [--reload] [--join-keys "{n},1"] [--no-save] [--min-players n]   (keys each player presses after joining, {n}: its
//     number — a team menu)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2), arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const [name, mode] = args;
if (!name || !['solo', 'multiplayer'].includes(mode)) { console.error('usage: check.mjs <manifest> <solo|multiplayer> [--url u] [--reload] [--join-keys k]'); process.exit(2); }
const base = arg('--url') ?? 'http://127.0.0.1:8080';
const root = `/tmp/orthros-scratch/goldsrc-check-${name}-${mode}`;
fs.mkdirSync(root, { recursive: true }); process.env.TMPDIR = root;
const manifest = await (await fetch(`${base}/api/manifest/${encodeURIComponent(name)}`)).json();
const pageUrl = `${base}/ports/goldsrc/${encodeURIComponent(name)}/?debug=1`;
const nicknames = [1, 2].map((i) => `QA${i}-${Date.now().toString(36)}`);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const clients = [], keys = arg('--join-keys');
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
    const page = await context.newPage();
    page.on('pageerror', (error) => console.log('PAGE ERROR', error.message));
    page.on('console', (message) => { if (message.type() === 'error') console.log('CONSOLE', message.text().slice(0, 300)); });
    clients.push({ context, page });
    if (i === 0) { // (the first player arrives from the home, as a visitor does)
      await page.goto(`${base}/?menu`);
      await page.locator(`[data-name="${manifest.gameId}"] .hm-play`).click();
      await page.waitForURL(`**/ports/goldsrc/${encodeURIComponent(name)}/`);
      console.log('HOME', 'the card opened', page.url());
      await page.goto(pageUrl);
    } else await page.goto(pageUrl);
    await page.waitForFunction(() => ['ready', 'error'].includes(window.portSession?.state), null, { timeout: 20000 });
    await page.fill('#name', nicknames[i]); await page.selectOption('#mode', mode); await page.click('#launch');
    await page.waitForFunction(() => ['running', 'error'].includes(window.portSession?.state), null, { timeout: 180000 });
    const state = await page.evaluate(() => ({ state: portSession.state, status: document.querySelector('#status').textContent, draws: renderProbe.draws, multiplayer: portSession.multiplayer }));
    console.log('BOOT', i, JSON.stringify(state));
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
      await page.waitForFunction((names) => names.every((n) => portSession.logs.some((l) => l.includes(n))), nicknames.slice(0, clients.length), { timeout: 20000 });
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
    const listSaves = (dir) => { const FS = portSession.engine.em.FS; try { return FS.readdir(dir).filter((f) => f.startsWith('orthros_qa')).map((f) => ({ f, size: FS.stat(dir + '/' + f).size })); } catch { return []; } };
    await page.waitForFunction((dir) => { try { return portSession.engine.em.FS.readdir(dir).some((f) => f.startsWith('orthros_qa')); } catch { return false; } }, saves, { timeout: 15000 });
    await page.evaluate(() => portSession.save());
    await page.evaluate(() => portSession.command('load orthros_qa')); await page.waitForTimeout(5000);
    if (args.includes('--reload')) {
      const saved = await page.evaluate(listSaves, saves);
      await page.evaluate(() => document.exitPointerLock());
      // (the header's back to the games: it saves and quits, once the player confirmed)
      page.once('dialog', (dialog) => dialog.accept()); await page.click('#tbGames'); await page.waitForURL((url) => url.pathname === '/' && url.searchParams.has('menu'));
      await page.goto(pageUrl); await page.waitForFunction(() => portSession?.state === 'ready', null, { timeout: 20000 });
      await page.selectOption('#mode', 'solo'); await page.click('#launch');
      await page.waitForFunction(() => ['running', 'error'].includes(portSession?.state), null, { timeout: 180000 });
      await page.waitForFunction(() => renderProbe.draws > 50, null, { timeout: 30000 });
      const restored = await page.evaluate(listSaves, saves);
      if (JSON.stringify(restored) !== JSON.stringify(saved)) throw new Error('Saved files changed across quit and relaunch');
      await page.evaluate(() => portSession.command('load orthros_qa')); await page.waitForTimeout(5000);
      console.log('PERSISTENCE', JSON.stringify({ saved, restored }));
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
