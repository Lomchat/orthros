// Browser check of the game kept at full speed in a hidden tab (src/web/background-play.js, docs/game-frame.md "At full
// speed in a hidden tab"): Chromium started directly — no automation attached to the page: Playwright's focus emulation
// keeps a background page "visible", and its default switches turn renderer backgrounding off — with a tiny extension
// (ext/) that hides the page's tab behind a new one and reads Chrome's own `audible` of it. Twice: with the keep-awake
// (the default) — hidden, the tab must be audible and its renderer back in the foreground within a few seconds —, and
// with ?awake=0 — hidden, not audible, the renderer backgrounded (Linux: nice 5; the check is meaningless where Chrome
// does not lower its renderers: it says so). Windows' slower cores are not reproduced here: the players' telemetry says
// it (tools/dev/telemetry-report.mjs, "hidden tab").
// Usage: tools/with-browser-slot.sh xvfb-run -a node tools/check/hidden-tab/check.mjs [--chrome <path>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../..');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const chrome = opt('chrome', chromium.executablePath());
fs.mkdirSync('/tmp/orthros-scratch/hidden-tab-check', { recursive: true });

/** One run of the page (`query`: its URL's query): the page's states, the extension's steps, the renderers' nice values. */
async function run(query) {
  const events = []; let done; const finished = new Promise((r) => { done = r; });
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0], body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (u === '/state' || u === '/log') { try { events.push({ kind: u.slice(1), ...JSON.parse(Buffer.concat(body).toString()) }); } catch { /* torn */ } res.end(); return; }
      if (u === '/done') { res.end(); done(); return; }
      if (u === '/check.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(here, 'page.html'))); return; }
      const f = path.join(root, path.normalize(u));
      if (u.startsWith('/src/') && f.startsWith(path.join(root, 'src')) && fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(fs.readFileSync(f)); return; }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const udd = fs.mkdtempSync('/tmp/orthros-scratch/hidden-tab-check/profile-');
  const browser = spawn(chrome, ['--no-sandbox', `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=800,600',
    `--disable-extensions-except=${path.join(here, 'ext')}`, `--load-extension=${path.join(here, 'ext')}`, '--autoplay-policy=no-user-gesture-required',
    `http://127.0.0.1:${server.address().port}/check.html${query ? '?' + query : ''}`], { stdio: 'ignore' });
  // (the renderers of this browser, their nice value and CPU time every second: the busy one is the page's)
  const seen = [];
  const look = () => {
    let ps; try { ps = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }); } catch { return; }
    const rows = ps.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], args: m[3] }));
    const tree = new Set([browser.pid]); for (let k = 0; k < 6; k++) for (const r of rows) if (tree.has(r.ppid)) tree.add(r.pid);
    for (const r of rows) {
      if (!tree.has(r.pid) || !r.args.includes('--type=renderer') || r.args.includes('--extension-process')) continue;
      try { const st = fs.readFileSync(`/proc/${r.pid}/stat`, 'utf8').split(') ')[1].split(' '); seen.push({ t: Date.now(), pid: r.pid, nice: +st[16], cpu: +st[11] + +st[12] }); } catch { /* gone */ }
    }
  };
  const timer = setInterval(look, 1000), limit = setTimeout(() => done(), 60000);
  try { await finished; } finally {
    clearInterval(timer); clearTimeout(limit);
    browser.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1500)); try { browser.kill('SIGKILL'); } catch { /* gone */ }
    server.close(); fs.rmSync(udd, { recursive: true, force: true });
  }
  const by = new Map(); for (const n of seen) by.set(n.pid, [...(by.get(n.pid) ?? []), n]);
  const busy = [...by.entries()].map(([pid, a]) => [pid, a.at(-1).cpu - a[0].cpu]).sort((x, y) => y[1] - x[1])[0]?.[0];
  const niceAt = (t) => (by.get(busy) ?? []).filter((n) => n.t <= t).at(-1)?.nice;
  const steps = events.filter((e) => e.kind === 'log').map((e) => ({ ...e, nice: niceAt(e.t) }));
  const states = events.filter((e) => e.kind === 'state');
  return { steps, states };
}

let ok = true;
const check = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) ok = false; };
const line = (r) => r.steps.map((s) => `${s.phase}: audible ${s.audible}, nice ${s.nice ?? '?'}`).join('; ');
const off = await run('awake=0');
console.log(`without (?awake=0): ${line(off)}`);
const lowers = off.steps.some((s) => s.phase === 'hidden' && s.nice > 0);
if (!lowers) console.log('note: this Chromium does not lower a hidden renderer here (no nice change): only the audible state is checked');
check(off.steps.filter((s) => s.phase === 'hidden').every((s) => !s.audible), 'without: the hidden tab is not audible');
const on = await run('');
console.log(`with: ${line(on)}`);
const hidden = on.steps.filter((s) => s.phase === 'hidden'), last = on.states.filter((s) => s.vis === 'hidden').at(-1);
check(!!last && last.aw === 'on' && last.sounding, `with: the page hidden, the signal on (${last ? `${last.aw}, context ${last.ctx}` : 'no state'})`);
check(hidden.length > 0 && hidden.every((s) => s.audible), 'with: Chrome calls the hidden tab audible');
if (lowers) check(hidden.slice(1).every((s) => s.nice === 0), 'with: the hidden tab\'s renderer stays in the foreground (nice 0)');
const shown = on.states.filter((s) => s.vis === 'visible').at(-1);
check(on.steps.at(-1)?.phase === 'shown' && on.steps.at(-1).audible === false && shown?.aw === 'visible', 'with: shown again, the signal off');
process.exit(ok ? 0 : 1);
