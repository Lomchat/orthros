// Headless harness: starts the server, opens the page in headless Chromium (Playwright), runs a
// manifest for N seconds, collects the emulator log, HUD stats and periodic screenshots.
// Usage: node tools/headless.mjs <manifest-name> [--seconds 60] [--shots 10] [--out build/shots] [--log kinds] [--interp]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../src/host/server.js';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const seconds = Number(opt('seconds', 60)), shotEvery = Number(opt('shots', 10)), out = opt('out', 'build/shots');
// scripted input: --input "180:click:400,300;185:key:Escape;190:move:10,20" (times in seconds)
// kinds: move x,y | click x,y | rclick x,y | key vk[,scan] | text <string>. Times are seconds from launch, or
// "+N" = N seconds after the first Direct3D frame (the loading time varies from run to run).
const inputs = (opt('input', '') || '').split(';').filter(Boolean).map((e) => { const [t, kind, ...rest] = e.split(':'); const args = rest.join(':'); return { t: Number(t), rel: t.startsWith('+'), kind, args: kind === 'text' ? [args] : args.split(',').map(Number), done: false }; });
let firstFrameAt = null;
if (!name) { console.error('usage: node tools/headless.mjs <manifest> [--seconds N] [--shots N] [--out dir] [--log kinds] [--interp]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logFile = fs.createWriteStream(path.join(out, `${name}.log`));
page.on('console', (m) => { const t = m.text(); logFile.write(t + '\n'); if (/^\[(crash|warn|gfx|audio|input|thread)\]/.test(t) || args.includes('--verbose')) console.log(t); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('crash', () => console.log('[pageerror] page crashed (renderer died)'));
browser.on('disconnected', () => console.log('[pageerror] browser disconnected'));
const q = new URLSearchParams({ manifest: name, headless: '1' });
if (opt('log')) q.set('log', opt('log'));
if (args.includes('--interp')) q.set('interp', '1');
if (args.includes('--dump-shaders')) q.set('dump', '1');
if (opt('capture')) q.set('capture', opt('capture'));
if (args.includes('--nocull')) q.set('nocull', '1');
if (args.includes('--audio')) q.set('audio', '1'); // set up the AudioWorklet even headless (checks the output path, not audible)
await page.goto(`http://127.0.0.1:${port}/?${q}`);
const t0 = Date.now();
let lastShot = 0, shot = 0, hangDumped = false;
/**
 * The worker stopped posting stats: pause its JS thread through the browser-level CDP session
 * (Target.attachToTarget + Debugger.pause work on a busy thread) and print the call stack.
 */
async function dumpWorkerStacks(reason) {
  console.log(`[hang] ${reason}: dumping worker call stacks`);
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const ti of targetInfos.filter((x) => x.type === 'worker' || x.type === 'shared_worker')) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: ti.targetId, flatten: false });
    let nextId = 1; const pending = new Map(); let pausedFrames = null;
    cdp.on('Target.receivedMessageFromTarget', (e) => {
      if (e.sessionId !== sessionId) return;
      const m = JSON.parse(e.message);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Debugger.paused') pausedFrames = m.params.callFrames;
    });
    const send = (method, params = {}, timeout = 5000) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, timeout); cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => resolve(null)); });
    await send('Debugger.enable');
    await send('Debugger.pause');
    for (let i = 0; i < 50 && !pausedFrames; i++) await new Promise((r) => setTimeout(r, 100));
    if (!pausedFrames) { console.log(`[hang] worker ${ti.url}: could not pause`); continue; }
    console.log(`[hang] worker ${ti.url} stack (${pausedFrames.length} frames):`);
    for (const f of pausedFrames.slice(0, 40)) console.log(`  ${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/src\//, 'src/')}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`);
    await send('Debugger.resume');
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}
const status = () => page.evaluate(() => ({ status: window.orthros.status, stats: window.orthros.stats, statsAt: window.orthros.statsAt, memoryMB: window.orthros.memoryMB, exitCode: window.orthros.exitCode, crash: window.orthros.crash }));
// --profile <start>:<seconds> — CPU-profile the worker (V8 sampling profiler through CDP) and print the top self-time functions
const profileOpt = opt('profile') ? opt('profile').split(':').map(Number) : null;
let profileState = profileOpt ? 'armed' : 'off';
async function workerSession() {
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const ti = targetInfos.find((x) => (x.type === 'worker' || x.type === 'shared_worker') && /worker\.js/.test(x.url));
  if (!ti) throw new Error('worker target not found');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: ti.targetId, flatten: false });
  let nextId = 1; const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', (e) => { if (e.sessionId !== sessionId) return; const m = JSON.parse(e.message); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}, timeout = 20000) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, timeout); cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(() => resolve(null)); });
  return { cdp, sessionId, send, close: () => cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}) };
}
async function profileWorker(seconds) {
  const s = await workerSession();
  await s.send('Profiler.enable'); await s.send('Profiler.setSamplingInterval', { interval: 500 }); await s.send('Profiler.start');
  console.log(`[profile] sampling the worker for ${seconds}s`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const r = await s.send('Profiler.stop', {}, 60000);
  await s.close();
  const p = r?.result?.profile; if (!p) { console.log('[profile] no profile returned'); return; }
  const byId = new Map(p.nodes.map((n) => [n.id, n])); const self = new Map(); let total = 0;
  const counts = new Map(); for (const s of p.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [id, c] of counts) { const n = byId.get(id); const cf = n.callFrame; const key = `${cf.functionName || '(anonymous)'} ${cf.url.replace(/^.*\/src\//, 'src/')}:${cf.lineNumber + 1}`; self.set(key, (self.get(key) ?? 0) + c); total += c; }
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30);
  console.log(`[profile] ${total} samples; top self time:`); for (const [k, c] of top) console.log(`  ${(100 * c / total).toFixed(1).padStart(5)}%  ${k}`);
  // aggregate by file
  const byFile = new Map(); for (const [k, c] of self) { const f = k.split(' ')[1]?.split(':')[0] ?? '?'; byFile.set(f, (byFile.get(f) ?? 0) + c); }
  console.log('[profile] by file:'); for (const [f, c] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(100 * c / total).toFixed(1).padStart(5)}%  ${f}`);
  // hottest JIT regions (region functions are named r_<entry eip> in the module name section)
  const regions = [...self].filter(([k]) => k.startsWith('r_')).map(([k, c]) => [k.split(' ')[0].slice(2), c]).sort((a, b) => b[1] - a[1]);
  const regionTotal = regions.reduce((acc, [, c]) => acc + c, 0);
  if (regions.length) { console.log(`[profile] guest code: ${(100 * regionTotal / total).toFixed(1)}% in ${regions.length} regions; hottest:`); for (const [eip, c] of regions.slice(0, 20)) console.log(`  ${(100 * c / total).toFixed(2).padStart(6)}%  region ${eip}`); }
}
for (;;) {
  const s = await status();
  const t = (Date.now() - t0) / 1000;
  if (s.stats) console.log(`[t=${t.toFixed(0)}s] ${s.status} fps=${s.stats.fps.toFixed(1)} p99=${s.stats.frameP99.toFixed(1)}ms mips=${s.stats.mips.toFixed(0)} api/s=${s.stats.apiPerSec.toFixed(0)} threads=${s.stats.threads} frames=${s.stats.frames}${s.stats.d3d ? ` d3d=${s.stats.d3d.w}x${s.stats.d3d.h}/${s.stats.d3d.frames}f/${s.stats.d3d.draws}d` : s.stats.firstD3D ? ` dx=${s.stats.firstD3D}` : ''} unknown=${s.stats.unknownImports} snd=${s.stats.audioBuffers ?? 0}/${(s.stats.audioPeak ?? 0).toFixed(2)}${s.stats.audioState ? `/${s.stats.audioState}/${s.stats.audioUnderruns}` : ''}${s.stats.audioFrames ? ` mix=${(s.stats.audioFrames / 1000).toFixed(1)}kf/s,${s.stats.audioMs.toFixed(0)}ms/s` : ''}${s.stats.fallbacksPerSec ? ` fb=${(s.stats.fallbacksPerSec / 1000).toFixed(0)}k/s` : ''}${s.stats.topApi && args.includes('--api') ? `\n    top api/s: ${s.stats.topApi}` : ''}${s.stats.topFallback && args.includes('--fallback') ? `\n    fallback/s: ${s.stats.topFallback}` : ''}${s.stats.pump && args.includes('--pump') ? `\n    pump: ${s.stats.pump}` : ''}${s.memoryMB ? ` mem=${s.memoryMB}MB` : ''}`);
  if (profileState === 'armed' && t >= profileOpt[0]) { profileState = 'running'; profileWorker(profileOpt[1]).then(() => { profileState = 'done'; }).catch((e) => console.log('[profile] failed:', e.message)); }
  if (s.status === 'running' && s.statsAt && Date.now() - s.statsAt > 15000 && !hangDumped) { hangDumped = true; await dumpWorkerStacks(`no stats for ${((Date.now() - s.statsAt) / 1000).toFixed(0)}s`).catch((e) => console.log('[hang] dump failed:', e.message)); }
  if (firstFrameAt === null && s.stats?.d3d?.frames > 0) { firstFrameAt = t; console.log(`[input] first Direct3D frame at ${t.toFixed(0)}s`); }
  for (const ev of inputs) {
    const due = ev.rel ? (firstFrameAt === null ? Infinity : firstFrameAt + ev.t) : ev.t;
    if (ev.done || t < due) continue;
    ev.done = true;
    console.log(`[input] ${ev.kind} ${ev.args.join(',')} at ${t.toFixed(0)}s`);
    await page.evaluate(({ kind, args }) => {
      const { push, EV } = window.orthrosInput;
      if (kind === 'move') push(EV.MOUSEMOVE, args[0], args[1], 0);
      else if (kind === 'click') { push(EV.MOUSEMOVE, args[0], args[1], 0); push(EV.MOUSEDOWN, 0, args[0], args[1]); push(EV.MOUSEUP, 0, args[0], args[1]); }
      else if (kind === 'rclick') { push(EV.MOUSEMOVE, args[0], args[1], 0); push(EV.MOUSEDOWN, 1, args[0], args[1]); push(EV.MOUSEUP, 1, args[0], args[1]); }
      else if (kind === 'key') { push(EV.KEYDOWN, args[0], args[1] || 0, 0); push(EV.KEYUP, args[0], args[1] || 0, 0); }
      else if (kind === 'text') window.orthrosInput.typeText(String(args[0]));
    }, { kind: ev.kind, args: ev.args });
  }
  if (t - lastShot >= shotEvery) { lastShot = t; const f = path.join(out, `${name}-${String(shot++).padStart(3, '0')}-${t.toFixed(0)}s.png`); try { await page.locator('#frame').screenshot({ path: f, timeout: 10000 }); console.log(`[shot] ${f}`); } catch (e) { console.log(`[shot] failed: ${e.message.split('\n')[0]}`); } }
  if (s.status === 'exited' || s.status === 'crashed') { console.log(`[end] ${s.status} code=${s.exitCode}`); if (s.crash) console.log(s.crash); break; }
  if (t >= seconds) { console.log(`[end] time limit ${seconds}s`); await page.evaluate(() => window.orthros.worker?.postMessage({ type: 'report' })); await page.waitForTimeout(500); const r = await page.evaluate(() => window.orthros.report); if (r) console.log(r); break; }
  await page.waitForTimeout(1000);
}
const f = path.join(out, `${name}-final.png`);
await page.locator('#frame').screenshot({ path: f }).catch(() => page.screenshot({ path: f }));
console.log(`[shot] ${f}`);
logFile.end();
await browser.close();
server.close();
