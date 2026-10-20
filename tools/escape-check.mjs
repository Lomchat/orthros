// The Escape rule of the game pages (src/host/web/escape.js) with real key presses: xdotool into a headed Chrome under
// Xvfb (CDP key events would not go through the browser's own handling of Escape). Prints what a game page receives and
// whether the mouse stays captured: in a window, captured, free, freed by the page itself; in full screen; Escape held.
// Usage: tools/with-browser-slot.sh xvfb-run -a -s '-screen 0 800x600x24' node tools/escape-check.mjs
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
fs.mkdirSync('/tmp/orthros-scratch/escape-check', { recursive: true }); process.env.TMPDIR = '/tmp/orthros-scratch/escape-check';
const html = `<!doctype html><body style="margin:0;background:#222"><canvas id=c width=600 height=400 style="background:#446"></canvas><script type=module>
import { escapeToGame } from '/escape.js';
window.rule = escapeToGame(window);
window.game = []; const c = document.getElementById('c');
addEventListener('keydown', (e) => { if (e.key === 'Escape') game.push('down' + (e.isTrusted ? '' : '*') + (e.repeat ? 'r' : '')); });
addEventListener('keyup', (e) => { if (e.key === 'Escape') game.push('up' + (e.isTrusted ? '' : '*')); });
c.onclick = async () => { if (window.fs && !document.fullscreenElement) { await document.documentElement.requestFullscreen(); await navigator.keyboard.lock(['Escape']); } await c.requestPointerLock(); };
window.state = () => ({ game: game.join(' '), locked: !!document.pointerLockElement, fs: !!document.fullscreenElement });
</script>`;
const server = http.createServer((q, r) => {
  if (q.url === '/escape.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); r.end(fs.readFileSync(new URL('../src/host/web/escape.js', import.meta.url))); return; }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(html);
}).listen(18097, '127.0.0.1');
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--window-size=800,600', '--window-position=0,0'] });
const key = (...a) => execFileSync('xdotool', a);
const run = async (name, fsMode, steps) => {
  const page = await browser.newPage({ viewport: { width: 780, height: 500 } });
  await page.goto('http://127.0.0.1:18097/'); await page.evaluate((f) => { window.fs = f; }, fsMode);
  await page.bringToFront(); await page.waitForTimeout(300);
  const out = [];
  for (const [label, act] of steps) { await act(page); await page.waitForTimeout(700); out.push(label + ' → ' + JSON.stringify(await page.evaluate(() => state()))); }
  console.log('== ' + name + '\n  ' + out.join('\n  '));
  await page.close();
};
const click = async (p) => p.mouse.click(200, 200), esc = async () => key('key', 'Escape');
await run('window', false, [['click', click], ['Esc', esc], ['click', click], ['Esc', esc], ['page frees the mouse itself', async (p) => { await click(p); await p.waitForTimeout(500); await p.evaluate(() => document.exitPointerLock()); }]]);
await run('full screen', true, [['click', click], ['Esc', esc], ['Esc', esc], ['Esc (mouse free)', esc], ['click', click], ['Esc', esc]]);
await run('full screen, Esc held', true, [['click', click], ['hold Esc 2.5 s', async (p) => { key('keydown', 'Escape'); await p.waitForTimeout(2500); key('keyup', 'Escape'); }], ['after', async (p) => p.waitForTimeout(800)]]);
await browser.close(); server.close();
