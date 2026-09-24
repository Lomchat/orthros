// Headless harness: starts the server, opens the page in headless Chromium (Playwright), runs a
// manifest for N seconds, collects the emulator log, HUD stats and periodic screenshots.
// Usage: node tools/headless.mjs <manifest-name | game-folder> [--seconds 60] [--shots 10] [--out build/shots] [--log kinds] [--interp]
//   --shots S: a screenshot every S seconds (not a count)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../src/host/server.js';
import { folderManifest } from '../src/host/manifest.js';
import { decodePng } from '../src/gfx/codecs/png.js';

const args = process.argv.slice(2);
let name = args.find((a) => !a.startsWith('--'));
// a game folder instead of a manifest name: served with a synthesized manifest, as `orthros run <folder>` does
let extraManifests = null;
if (name && (name.includes('/') || name.includes('\\')) && fs.existsSync(name) && fs.statSync(name).isDirectory()) {
  const m = folderManifest(name);
  const folderName = path.basename(m.folder).replace(/[^A-Za-z0-9._-]/g, '_') || 'game';
  extraManifests = new Map([[folderName, m]]);
  name = folderName;
}
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const seconds = Number(opt('seconds', 60)), shotEvery = Number(opt('shots', 10)), out = opt('out', 'build/shots');
// scripted input: --input "180:click:400,300;185:key:Escape;190:move:10,20" (times in seconds; kinds move, click, rclick,
// down/up (left button, for drags), key, text, shot (screenshot now), waitfps, waitpixel:x,y,r,g,b[,tol], waitframe:minDraws,maxDraws)
// kinds: move x,y | click x,y | rclick x,y | key vk[,scan] | text <string> | blur | focus (window focus loss / return). Times are seconds from launch, or
// "+N" = N seconds after the first Direct3D frame (the loading time varies from run to run).
// waitfps F: the following events wait until the game presents more than F frames/s for 3 consecutive seconds
// (e.g. a match started after its loading screen); their times then count from that moment ("anchor").
// --capture-at @N captures N seconds after the anchor.
let afterWait = false;
const inputs = (opt('input', '') || '').split(';').filter(Boolean).map((e) => { const [t, kind, ...rest] = e.split(':'); const args = rest.join(':'); const ev = { t: Number(t), rel: t.startsWith('+'), anchored: afterWait, kind, args: kind === 'text' ? [args] : args.split(',').map(Number), done: false }; if (kind === 'waitfps' || kind === 'waitpixel' || kind === 'waitframe') afterWait = true; return ev; });
let anchorAt = null, fpsStreak = 0;
let firstFrameAt = null;
if (!name) { console.error('usage: node tools/headless.mjs <manifest | game-folder> [--seconds N] [--shots <every S seconds>] [--out dir] [--log kinds] [--interp]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

// --net <ms>:<Mbit/s>: game file range requests answered after that round trip and transfer rate (a player's connection)
const netOpt = opt('net') ? opt('net').split(':').map(Number) : null;
const server = createServer({ extra: extraManifests, net: netOpt ? { delayMs: netOpt[0], bytesPerSec: netOpt[1] * 125000 } : null });
// OPFS storage is per origin: a persistent browser profile needs a stable port (--port, default 8123 with --opfs)
await new Promise((r) => server.listen(Number(opt('port', opt('opfs') ? 8123 : 0)), '127.0.0.1', r));
const port = server.address().port;
const chromeArgs = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required'];
// --opfs <user-data-dir>: persistent browser profile so the worker's OPFS mirror of the game profile (saves,
// Options.ini) survives across runs, exactly as in a real page (the default fresh context has no persistence).
const opfsDir = opt('opfs');
const browser = opfsDir ? await chromium.launchPersistentContext(opfsDir, { args: chromeArgs, viewport: { width: 1280, height: 900 } }) : await chromium.launch({ args: chromeArgs });
const page = opfsDir ? (browser.pages()[0] ?? await browser.newPage()) : await browser.newPage({ viewport: { width: 1280, height: 900 } });
const logFile = fs.createWriteStream(path.join(out, `${name}.log`));
page.on('console', (m) => { const t = m.text(); logFile.write(t + '\n'); if (/^\[(crash|warn|gfx|audio|input|thread|report|hang)\]/.test(t) || args.includes('--verbose')) console.log(t); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('crash', () => console.log('[pageerror] page crashed (renderer died)'));
browser.on('disconnected', () => console.log('[pageerror] browser disconnected'));
const q = new URLSearchParams({ manifest: name, headless: '1' });
if (opt('log')) q.set('log', opt('log'));
if (args.includes('--interp')) q.set('interp', '1');
if (args.includes('--dump-shaders')) q.set('dump', '1');
if (opt('capture')) q.set('capture', opt('capture'));
if (args.includes('--nocull')) q.set('nocull', '1');
if (args.includes('--no-f32')) q.set('nof32', '1'); // debugging: x87 registers never kept as floats
if (opt('f32-off')) q.set('f32off', opt('f32-off')); // debugging: float parts off (arith,round,m32,const; part@lo:hi keeps it in [lo, hi))
if (opt('watch-tex')) q.set('watchtex', opt('watch-tex')); // <fmt>:<w>x<h>: report the code writing into such surfaces (debugging)
if (opt('interp-range') && !opt('interp-range-at')) q.set('interprange', opt('interp-range')); // debugging: lo:hi[,lo:hi] (hex) run by the reference interpreter, the rest by the JIT
if (args.includes('--offline')) q.set('offline', '1'); // with --opfs: download the whole game folder into the OPFS block store in the background
if (args.includes('--gl-validate')) q.set('glvalidate', '1'); // debugging: the backend's cached GL state checked against GL (mismatches logged)
if (args.includes('--gl-discard')) q.set('gldiscard', '1'); // benchmark: GL calls issued, nothing rasterized (CPU-bound measurement)
if (args.includes('--jit-profile')) q.set('jitprof', '1'); // transitions per second by kind, logged as [jitprof]
if (args.includes('--capture-draws')) q.set('capturedraws', '1');
if (opt('burst-from')) q.set('burstfrom', opt('burst-from')); // --log apiburst: trace the API calls following tiny (stand-in) textures from this resource id on
// --capture-at <s|+s>: capture the next Direct3D frame at that time (textures as PNG, per-draw state; with
// --capture-draws also the render target after every draw) into <out>/capture
// --interp-range-at <s|+s> with --interp-range: the ranges switch to the interpreter only at that time (hot code during startup)
const interpRangeAt = opt('interp-range-at') ? { t: Number(opt('interp-range-at').replace(/^\+/, '')), rel: opt('interp-range-at').startsWith('+'), done: false } : null;
// --lose-context-at <s>: lose the WebGL context at that time and restore it 0.5 s later (recovery test)
const loseContextAt = opt('lose-context-at') ? Number(opt('lose-context-at')) : null;
let contextLost = false;
const captureAt = opt('capture-at') ? { t: Number(opt('capture-at').replace(/^@/, '')), rel: opt('capture-at').startsWith('+'), anchored: opt('capture-at').startsWith('@'), done: false } : null;
if (opfsDir) q.set('opfs', '1');
if (opt('frames-from')) q.set('slowfrom', opt('frames-from')); // slow-frame diagnostics only after that time
if (args.includes('--audio')) q.set('audio', '1'); // set up the AudioWorklet even headless (checks the output path, not audible)
// --profile-dir <dir>: the game's user profile (C:\\Users\\Player: Options.ini, saves...) is loaded from this host
// directory and written back at the end, so a second run skips the first-run setup (benchmarks) and keeps its settings.
const profileDir = opt('profile-dir');
if (profileDir) {
  const files = [];
  const walk = (dir, rel) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(dir, e.name), p); else files.push({ path: p, data: fs.readFileSync(path.join(dir, e.name)).toString('base64') }); } };
  walk(profileDir, '');
  console.log(`[profile] ${files.length} file(s) loaded from ${profileDir}`);
  await page.addInitScript((f) => { window.__orthrosProfile = f; }, files);
}
async function saveProfile() {
  if (!profileDir) return;
  try {
    await page.evaluate(() => { window.orthros.profile = null; window.orthros.worker?.postMessage({ type: 'profile-dump' }); });
    let files = null;
    for (let i = 0; i < 50 && !files; i++) { files = await page.evaluate(() => window.orthros.profile); if (!files) await page.waitForTimeout(100); }
    if (!files) { console.log('[profile] no profile received'); return; }
    for (const f of files) { const p = path.join(profileDir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(f.data, 'base64')); }
    console.log(`[profile] ${files.length} file(s) saved to ${profileDir}`);
  } catch (e) { console.log(`[profile] save failed: ${e.message.split('\n')[0]}`); }
}
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
/** RGB of the displayed frame at (x, y) (frame coordinates), from a 1-pixel screenshot; null when unavailable. */
async function pixelAt(x, y) {
  try {
    const box = await page.locator('#frame').boundingBox(); if (!box) return null;
    const png = await page.screenshot({ clip: { x: box.x + x, y: box.y + y, width: 1, height: 1 }, timeout: 5000 });
    const img = decodePng(new Uint8Array(png));
    return [img.data[0], img.data[1], img.data[2]];
  } catch { return null; }
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
  if (process.env.ORTHROS_DUMP_TICKS) for (const n of p.nodes) if (n.positionTicks && /^r_/.test(n.callFrame.functionName)) console.log('[ticks]', n.callFrame.functionName, n.callFrame.url, JSON.stringify(n.positionTicks.slice(0, 20)));
  console.log(`[profile] ${total} samples; top self time:`); for (const [k, c] of top) console.log(`  ${(100 * c / total).toFixed(1).padStart(5)}%  ${k}`);
  // callers of the five hottest entries (parent frames in the sampled call tree)
  const parentOf = new Map(); for (const n of p.nodes) for (const ch of n.children ?? []) parentOf.set(ch, n.id);
  const keyOf = (n) => `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.replace(/^.*\/src\//, 'src/')}:${n.callFrame.lineNumber + 1}`;
  for (const [k] of top.slice(0, 5)) {
    const callers = new Map(); let n0 = 0;
    for (const [id, c] of counts) { const n = byId.get(id); if (keyOf(n) !== k) continue; const par = byId.get(parentOf.get(id)); const pk = par ? keyOf(par) : '(root)'; callers.set(pk, (callers.get(pk) ?? 0) + c); n0 += c; }
    console.log(`[profile] callers of ${k.split(' ')[0]}: ${[...callers].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([pk, c]) => `${pk.split(' ')[0]} (${pk.split(' ')[1] ?? ''}) ${(100 * c / n0).toFixed(0)}%`).join(', ')}`);
  }
  // aggregate by file
  const byFile = new Map(); for (const [k, c] of self) { const f = k.split(' ')[1]?.split(':')[0] ?? '?'; byFile.set(f, (byFile.get(f) ?? 0) + c); }
  console.log('[profile] by file:'); for (const [f, c] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(100 * c / total).toFixed(1).padStart(5)}%  ${f}`);
  // hottest JIT regions (region functions are named r_<entry eip> in the module name section)
  const regions = [...self].filter(([k]) => k.startsWith('r_')).map(([k, c]) => [k.split(' ')[0].slice(2), c]).sort((a, b) => b[1] - a[1]);
  const regionTotal = regions.reduce((acc, [, c]) => acc + c, 0);
  if (regions.length) {
    console.log(`[profile] guest code: ${(100 * regionTotal / total).toFixed(1)}% in ${regions.length} regions; hottest:`); for (const [eip, c] of regions.slice(0, 20)) console.log(`  ${(100 * c / total).toFixed(2).padStart(6)}%  region ${eip}`);
    // instruction mix of the hottest regions (decoded by the worker from guest memory)
    await page.evaluate(([eips, list]) => { window.orthros.regions = null; window.orthros.worker?.postMessage({ type: 'regions', eips, list }); }, [regions.slice(0, 12).map(([eip]) => eip), Number(opt('profile-list') ?? 0)]); // --profile-list N: instruction listing of the N hottest regions
    for (let i = 0; i < 50; i++) { const txt = await page.evaluate(() => window.orthros.regions); if (txt) { console.log('[profile] instruction mix:\n' + txt); break; } await page.waitForTimeout(100); }
  }
}
for (;;) {
  const s = await status();
  const t = (Date.now() - t0) / 1000;
  if (s.stats) console.log(`[t=${t.toFixed(0)}s] ${s.status} fps=${s.stats.fps.toFixed(1)} p99=${s.stats.frameP99.toFixed(1)}ms mips=${s.stats.mips.toFixed(0)} api/s=${s.stats.apiPerSec.toFixed(0)} threads=${s.stats.threads} frames=${s.stats.frames} io=${s.stats.ioMB ?? 0}MB net=${s.stats.netMs ?? 0}ms/${s.stats.netReq ?? 0}${s.stats.d3d ? ` d3d=${s.stats.d3d.w}x${s.stats.d3d.h}/${s.stats.d3d.frames}f/${s.stats.d3d.draws}d` : s.stats.firstD3D ? ` dx=${s.stats.firstD3D}` : ''} unknown=${s.stats.unknownImports} snd=${s.stats.audioBuffers ?? 0}/${(s.stats.audioPeak ?? 0).toFixed(2)}${s.stats.audioState ? `/${s.stats.audioState}/${s.stats.audioUnderruns}` : ''}${s.stats.audioFrames ? ` mix=${(s.stats.audioFrames / 1000).toFixed(1)}kf/s,${s.stats.audioMs.toFixed(0)}ms/s` : ''}${s.stats.fallbacksPerSec ? ` fb=${(s.stats.fallbacksPerSec / 1000).toFixed(0)}k/s` : ''}${s.stats.topApi && args.includes('--api') ? `\n    top api/s: ${s.stats.topApi}` : ''}${s.stats.topFallback && args.includes('--fallback') ? `\n    fallback/s: ${s.stats.topFallback}` : ''}${s.stats.pump && args.includes('--pump') ? `\n    pump: ${s.stats.pump}` : ''}${s.memoryMB ? ` mem=${s.memoryMB}MB` : ''}${s.stats.offlineTotalMB ? ` offline=${s.stats.offlineMB}/${s.stats.offlineTotalMB}MB` : ''}`);
  if (profileState === 'armed' && t >= profileOpt[0]) { profileState = 'running'; profileWorker(profileOpt[1]).then(() => { profileState = 'done'; }).catch((e) => console.log('[profile] failed:', e.message)); }
  if (s.status === 'running' && s.statsAt && Date.now() - s.statsAt > 15000 && !hangDumped) { hangDumped = true; await dumpWorkerStacks(`no stats for ${((Date.now() - s.statsAt) / 1000).toFixed(0)}s`).catch((e) => console.log('[hang] dump failed:', e.message)); }
  if (firstFrameAt === null && s.stats?.d3d?.frames > 0) { firstFrameAt = t; console.log(`[input] first Direct3D frame at ${t.toFixed(0)}s`); }
  for (const ev of inputs) {
    if (ev.done) continue;
    const due = ev.anchored ? (anchorAt === null ? Infinity : anchorAt + ev.t) : ev.rel ? (firstFrameAt === null ? Infinity : firstFrameAt + ev.t) : ev.t;
    if (ev.kind === 'waitfps') {
      if (t < due) break; // events are sequential from here on
      fpsStreak = (s.stats?.fps ?? 0) > ev.args[0] ? fpsStreak + 1 : 0;
      if (fpsStreak >= 3) { ev.done = true; anchorAt = t; console.log(`[input] waitfps ${ev.args[0]}: anchor at ${t.toFixed(0)}s`); }
      break;
    }
    if (ev.kind === 'waitframe') { // min,max: until Direct3D frames carry that many draws (a loading screen: few; works with --gl-discard)
      if (t < due) break;
      const d3d = s.stats?.d3d, prev = ev.prev;
      if (!d3d || (prev && d3d.frames === prev.frames)) break; // (no new frame in this sample: a slow loading screen)
      ev.prev = { draws: d3d.draws, frames: d3d.frames };
      const dpf = prev ? (d3d.draws - prev.draws) / (d3d.frames - prev.frames) : -1;
      ev.streak = dpf >= ev.args[0] && dpf <= ev.args[1] ? (ev.streak ?? 0) + 1 : 0;
      if (ev.streak >= 3) { ev.done = true; anchorAt = t; console.log(`[input] waitframe ${ev.args.join(',')}: ${dpf.toFixed(0)} draws/frame, anchor at ${t.toFixed(0)}s`); }
      break;
    }
    if (ev.kind === 'waitpixel') { // x,y,r,g,b[,tolerance]: until the displayed pixel has that color (what is on screen, whatever the speed)
      if (t < due) break;
      const [x, y, r, g, b, tol = 24] = ev.args;
      const px = await pixelAt(x, y);
      if (px && Math.abs(px[0] - r) <= tol && Math.abs(px[1] - g) <= tol && Math.abs(px[2] - b) <= tol) { ev.done = true; anchorAt = t; console.log(`[input] waitpixel ${x},${y}: anchor at ${t.toFixed(0)}s`); }
      break;
    }
    if (t < due) continue;
    ev.done = true;
    console.log(`[input] ${ev.kind} ${ev.args.join(',')} at ${t.toFixed(0)}s`);
    if (ev.kind === 'shot') { const f = path.join(out, `${name}-step-${String(shot++).padStart(3, '0')}-${t.toFixed(0)}s.png`); await page.locator('#frame').screenshot({ path: f, timeout: 10000 }).then(() => console.log(`[shot] ${f}`), (e) => console.log(`[shot] failed: ${e.message.split('\n')[0]}`)); continue; }
    await page.evaluate(({ kind, args }) => {
      const { push, EV } = window.orthrosInput;
      if (kind === 'move') push(EV.MOUSEMOVE, args[0], args[1], 0);
      else if (kind === 'click') { push(EV.MOUSEMOVE, args[0], args[1], 0); push(EV.MOUSEDOWN, 0, args[0], args[1]); push(EV.MOUSEUP, 0, args[0], args[1]); }
      else if (kind === 'down') { push(EV.MOUSEMOVE, args[0], args[1], 0); push(EV.MOUSEDOWN, 0, args[0], args[1]); } // a drag: down, moves, up as separate steps
      else if (kind === 'up') { push(EV.MOUSEMOVE, args[0], args[1], 0); push(EV.MOUSEUP, 0, args[0], args[1]); }
      else if (kind === 'rclick') { push(EV.MOUSEMOVE, args[0], args[1], 0); push(EV.MOUSEDOWN, 1, args[0], args[1]); push(EV.MOUSEUP, 1, args[0], args[1]); }
      else if (kind === 'key') { push(EV.KEYDOWN, args[0], args[1] || 0, 0); push(EV.KEYUP, args[0], args[1] || 0, 0); }
      else if (kind === 'text') window.orthrosInput.typeText(String(args[0]));
      else if (kind === 'blur' || kind === 'focus') dispatchEvent(new Event(kind)); // the browser window loses / regains the focus (the game is deactivated / reactivated)
    }, { kind: ev.kind, args: ev.args });
  }
  if (interpRangeAt && !interpRangeAt.done && t >= (interpRangeAt.rel ? (firstFrameAt === null ? Infinity : firstFrameAt + interpRangeAt.t) : interpRangeAt.t)) { interpRangeAt.done = true; console.log(`[input] interpreter ranges ${opt('interp-range')} at ${t.toFixed(0)}s`); await page.evaluate((ranges) => window.orthros.worker?.postMessage({ type: 'interpRange', ranges }), opt('interp-range')); }
  if (loseContextAt !== null && !contextLost && t >= loseContextAt) { contextLost = true; console.log(`[input] WebGL context loss at ${t.toFixed(0)}s`); await page.evaluate(() => window.orthros.worker?.postMessage({ type: 'loseContext', ms: 500 })); }
  const waitsDone = inputs.every((e) => !e.kind.startsWith('wait') || e.done); // (@N counts from the last anchor of the scenario)
  if (captureAt && !captureAt.done && t >= (captureAt.anchored ? (anchorAt === null || !waitsDone ? Infinity : anchorAt + captureAt.t) : captureAt.rel ? (firstFrameAt === null ? Infinity : firstFrameAt + captureAt.t) : captureAt.t)) { captureAt.done = true; console.log(`[capture] frame capture requested at ${t.toFixed(0)}s`); await page.evaluate((draws) => window.orthros.worker?.postMessage({ type: 'capture', draws }), args.includes('--capture-draws')); }
  // captured images, a few per round trip (a whole frame of per-draw PNGs exceeds the maximum string length)
  let nDumps = 0;
  for (;;) {
    const dumps = await page.evaluate(() => (window.orthros.dumps ?? []).splice(0, 8)).catch(() => []);
    if (!dumps.length) break;
    for (const d of dumps) { const dir = path.join(out, 'capture'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, d.name + '.png'), Buffer.from(d.data, 'base64')); }
    nDumps += dumps.length;
  }
  if (nDumps) console.log(`[capture] ${nDumps} image(s) saved to ${path.join(out, 'capture')}`);
  if (t - lastShot >= shotEvery) { lastShot = t; const f = path.join(out, `${name}-${String(shot++).padStart(3, '0')}-${t.toFixed(0)}s.png`); try { await page.locator('#frame').screenshot({ path: f, timeout: 10000 }); console.log(`[shot] ${f}`); } catch (e) { console.log(`[shot] failed: ${e.message.split('\n')[0]}`); } }
  if (s.status === 'exited' || s.status === 'crashed') { console.log(`[end] ${s.status} code=${s.exitCode}`); if (s.crash) console.log(s.crash); break; }
  if (t >= seconds) {
    console.log(`[end] time limit ${seconds}s`);
    // --frames-from <s>: whole-run frame-time percentiles over the frames presented after that time (page time base)
    if (opt('frames-from')) { await page.evaluate((fromMs) => { window.orthros.frames = null; window.orthros.worker?.postMessage({ type: 'frames', fromMs }); }, Number(opt('frames-from')) * 1000); for (let i = 0; i < 30; i++) { const f = await page.evaluate(() => window.orthros.frames); if (f) { console.log('[frames] ' + f); break; } await page.waitForTimeout(100); } }
    // --corpus <file>: distinct instruction forms of the translated code (input of the `corpus` conformance suite)
    if (opt('corpus')) { await page.evaluate(() => { window.orthros.corpus = null; window.orthros.worker?.postMessage({ type: 'corpus' }); }); for (let i = 0; i < 100; i++) { const c = await page.evaluate(() => window.orthros.corpus); if (c) { fs.mkdirSync(path.dirname(opt('corpus')), { recursive: true }); fs.writeFileSync(opt('corpus'), c); const j = JSON.parse(c); console.log(`[corpus] ${j.forms.length} forms from ${j.insns} instructions -> ${opt('corpus')}`); break; } await page.waitForTimeout(200); } }
    await page.evaluate(() => window.orthros.worker?.postMessage({ type: 'report' })); await page.waitForTimeout(500); const r = await page.evaluate(() => window.orthros.report); if (r) console.log(r); await saveProfile(); break; }
  await page.waitForTimeout(1000);
}
const f = path.join(out, `${name}-final.png`);
await page.locator('#frame').screenshot({ path: f }).catch(() => page.screenshot({ path: f }));
console.log(`[shot] ${f}`);
logFile.end();
await browser.close();
server.close();
