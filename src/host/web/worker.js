// Emulator worker: builds the VFS (game folder over HTTP ranges, user profile in memory mirrored
// to OPFS), the browser host and the VM, then pumps the VM cooperatively so the canvases are
// presented and input/audio flow while the guest runs.
import { Vm, GuestCrash } from '../../core/vm.js';
import { RealClock } from '../../core/clock.js';
import { Vfs, MemBackend, normalizeWin } from '../../vfs/vfs.js';
import { HttpBackend } from '../../vfs/http-backend.js';
import { OpfsBlockStore, MemBlockStore } from '../../vfs/opfs-store.js';
import { Registry } from '../../win32/registry.js';
import { BrowserHost, CTL, IN_RING, AUDIO_RING_FRAMES } from '../browser-host.js';
import { VOICE_TABLE_BYTES } from '../../win32/dsound.js';
import { createWebGLBackend } from '../../gfx/d3d8-webgl.js';
import { stateUseReport } from '../../win32/d3d8.js';
import { decode, OP_NAMES, OT, fmtInsn } from '../../cpu/decoder.js';
import { HANDLERS, PROF_OPS_BASE, NOCHAIN_PROF } from '../../cpu/jit/translate.js';
import { MATH_KERNELS, FAST_NAMES, FAST_PROF } from '../../cpu/jit/runtime.js';

let profileFilesRestored = 0, profileListing = []; // (the listing goes to the page: failure diagnostics) // files of the game's user profile found in the browser (0: its first launch here)
let vm = null, host = null, profile = null, opfsDir = null, manifestName = '', gameStore = null, gameFilesStats = null, lastNetMs = 0, lastNetReq = 0;
const offline = { bytes: 0, total: 0, done: false }; // (background download of the game folder, opt-in)
const prefetch = { bytes: 0, blocks: 0, total: 0, done: false }; // (learned prefetch, see HttpBackend.prefetch)
let programSink = null, programsPostedAt = 0; // (GL programs this session built at a draw, sent to the server: see server.js)
/** code regions earlier sessions translated ([module, rva, x87 mode], from the server), translated while the game waits */
let regionQueue = null, regionPos = 0, regionSink = null, regionsPostedAt = 0;
let audioMixDirect = true; // (?audiomix=worker: the game's worker mixes into the ring, as before)
let bgTranslator = null, regionLater = [], bgDoneLogged = false; const bgMods = { n: -1, map: null }; // (background translation)
let lastFlush = 0, running = false, stopped = false;
const channel = new MessageChannel();
const post = (m, transfer) => self.postMessage(m, transfer);
const log = (kind, msg) => post({ type: 'log', kind, msg });

const PROFILE_DIRS = ['Temp', 'AppData', 'AppData/Roaming', 'AppData/Local', 'AppData/LocalLow', 'Documents', 'Desktop', 'Saved Games'];

async function loadProfile(mem) {
  try {
    const root = await navigator.storage.getDirectory();
    opfsDir = await root.getDirectoryHandle('orthros-' + manifestName, { create: true });
    const walk = async (dir, rel) => {
      for await (const [name, h] of dir.entries()) {
        const p = rel ? rel + '/' + name : name;
        if (h.kind === 'directory') { mem.mkdir(p); await walk(h, p); }
        else { const f = await h.getFile(); const data = new Uint8Array(await f.arrayBuffer()); mem.open(p, { create: true }).write(0, data); profileFilesRestored++; profileListing.push({ path: p, size: data.length, modified: f.lastModified }); }
      }
    };
    await walk(opfsDir, '');
  } catch (e) { log('warn', `OPFS unavailable (${e.message}): saves are not persisted`); opfsDir = null; }
}

async function flushProfile(force = false) {
  const now = Date.now();
  if (!force && now - lastFlush < 2000) return;
  gameStore?.flush(); // (the game file block store's index)
  if (!opfsDir || !profile) { lastFlush = now; return; }
  const dirty = [...profile.files].filter(([, f]) => f.mtime > lastFlush);
  lastFlush = now;
  for (const [key, f] of dirty) {
    try {
      const parts = key.split('/');
      let dir = opfsDir;
      for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(profile.names.get(parts.slice(0, parts.indexOf(d) + 1).join('/')) ?? d, { create: true });
      const fh = await dir.getFileHandle(profile.names.get(key) ?? parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(f.data.subarray(0, f.len));
      await w.close();
    } catch (e) { log('warn', `OPFS write failed for ${key}: ${e.message}`); }
  }
}

/** Every profile file as { path (original case, '/'-separated), data (base64) } — the headless harness saves them. */
function profileDump() {
  if (!profile) return [];
  const out = [];
  for (const [key, f] of profile.files) {
    const parts = key.split('/');
    const path = parts.map((_, i) => profile.names.get(parts.slice(0, i + 1).join('/')) ?? parts[i]).join('/');
    let bin = ''; const d = f.data.subarray(0, f.len);
    for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    out.push({ path, data: btoa(bin) });
  }
  return out;
}

async function start(m) {
  manifestName = m.name;
  const manifest = m.manifest;
  const clock = new RealClock(m.opts.timeScale || 1); // (debugging: ?timescale=0.5 shows the guest a machine twice as fast)
  const ctl = new Int32Array(m.ctl), inputRing = new Int32Array(m.inputRing), audioRing = new Float32Array(m.audioRing);
  // the worker owns its canvases and hands complete frames to the page as ImageBitmaps (see BrowserDisplay)
  const canvas2d = new OffscreenCanvas(manifest.display.width, manifest.display.height), canvasGl = new OffscreenCanvas(manifest.display.width, manifest.display.height);
  host = new BrowserHost({ clock, ctl, inputRing, audioRing, canvas2d, canvasGl, width: manifest.display.width, height: manifest.display.height, post });
  // (debugging: ?dbg=NAME=value,... sets worker globals, e.g. ORTHROS_FX_BURST=30000)
  for (const kv of (m.opts.dbg ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); if (/^ORTHROS_[A-Z0-9_]+$/.test(k)) globalThis[k] = Number.isNaN(Number(v)) ? v : Number(v); }
  if (m.opts.jitOpts) try { globalThis.ORTHROS_JIT_OPTS = JSON.parse(m.opts.jitOpts); } catch { /* ignored */ } // (debugging: ?jitopts={"consolidateEvery":...})
  globalThis.ORTHROS_DUMP_SHADERS = !!m.opts.dumpShaders; globalThis.ORTHROS_CAPTURE_FRAME = m.opts.captureFrame || 0; globalThis.ORTHROS_CAPTURE_DRAWS = !!m.opts.captureDraws; globalThis.ORTHROS_LOCK_LOG = (m.opts.log ?? []).includes('lock'); if (m.opts.burstFromId) globalThis.ORTHROS_BURST_FROM_ID = m.opts.burstFromId; globalThis.ORTHROS_NO_CULL = !!m.opts.noCull; globalThis.ORTHROS_JIT_PROFILE = !!m.opts.jitProfile; globalThis.ORTHROS_GL_DISCARD = !!m.opts.glDiscard; globalThis.ORTHROS_WATCH_TEX = m.opts.watchTex || undefined; globalThis.ORTHROS_NO_F32 = !!m.opts.noF32; globalThis.ORTHROS_F32_OFF = m.opts.f32Off || ''; globalThis.ORTHROS_GL_VALIDATE = !!m.opts.glValidate; globalThis.ORTHROS_INTERP_RANGES = m.opts.interpRange || undefined;
  // frame capture (--capture N): images (bound textures, render target after draws) encoded as PNG for the harness
  const dump = (name, w, h, rgba) => { try { const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer instanceof ArrayBuffer ? rgba.buffer : rgba.slice().buffer, rgba.buffer instanceof ArrayBuffer ? rgba.byteOffset : 0, w * h * 4), w, h), 0, 0); c.convertToBlob({ type: 'image/png' }).then((b) => b.arrayBuffer()).then((ab) => post({ type: 'dump', name, data: ab }, [ab])); } catch (e) { log('warn', `dump ${name} failed: ${e.message}`); } };
  try { host.gfx = createWebGLBackend(canvasGl, (msg) => log('gfx', msg), dump); if (!host.gfx) log('warn', 'WebGL2 unavailable: Direct3D will run without rendering'); } catch (e) { log('warn', `WebGL2 init failed: ${e.message}`); }
  // GL programs of earlier sessions, compiled ahead of their first draw (see WebGLDevice.prewarmStep); this session's
  // new ones are sent back a few seconds after they are built
  const pcache = host.gfx?.programCache;
  if (pcache && m.opts.programCache) {
    const url = `/api/programs/${encodeURIComponent(manifestName)}`;
    fetch(url).then((r) => (r.ok ? r.json() : [])).then((list) => {
      if (!Array.isArray(list) || !list.length) return;
      pcache.queue.push(...list);
      log('gfx', `programs: ${list.length} learned from earlier sessions, compiled ahead${pcache.parallel ? ' (parallel compilation)' : ''}`);
    }).catch(() => {});
    programSink = (list) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ programs: list }) }).catch(() => {});
  }
  if (m.opts.regionCache) {
    const url = `/api/regions/${encodeURIComponent(manifestName)}`;
    fetch(url).then((r) => (r.ok ? r.json() : [])).then((list) => { if (Array.isArray(list) && list.length) { regionQueue = list; log('file', `regions: ${list.length} learned from earlier sessions, translated ${bgTranslator ? 'ahead in a background worker' : 'while the game waits'}`); } }).catch(() => {});
    regionSink = (list) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regions: list }) }).catch(() => {});
  }
  // VFS: system dirs in memory, game folder over HTTP, profile in memory (mirrored to OPFS)
  const vfs = new Vfs();
  const root = new MemBackend();
  vfs.mount('C:\\', root);
  for (const d of ['Windows', 'Windows/System32', 'Windows/Temp', 'Users', 'Users/Player', 'Program Files', 'Program Files/Common Files', 'Game']) root.mkdir(d);
  // game files over HTTP, kept in a persistent OPFS block store (pages; headless runs with a persistent profile, --opfs)
  let store = !m.opts.headless || m.opts.opfs ? await OpfsBlockStore.open('orthros-files-' + manifestName) : null;
  if (!store && m.opts.memPrefetch) store = new MemBlockStore(1536 * 1048576); // (harness: prefetch measured without a persistent profile)
  if (store) log('file', `block store: ${store.map.size} blocks (${Math.round(store.end / 1048576)} MiB) from earlier runs${store.resetReason ? ` (emptied: ${store.resetReason})` : ''}`);
  if (store) store.onCorrupt = (key) => { if ((store.stats.corrupt ?? 0) <= 20) log('warn', `block store: a stored block did not read back as written, fetched again: ${key}`); };
  const gameFiles = new HttpBackend(`/game/${manifestName}/`, m.tree, { cacheBlocks: m.opts.cacheBlocks ?? 256, store, encoded: !!m.opts.encodedRanges, session: m.opts.session ?? '', onRetry: (r) => log('warn', `game file read: ${r.problem} for ${r.url} [${r.start}, ${r.end}), attempt ${r.attempt + 1}`) });
  gameStore = store; gameFilesStats = gameFiles.stats;
  // offline copy (opt-in): the whole folder into the block store, in the background while the game runs
  // learned prefetch: the blocks earlier sessions read, in the order they needed them, downloaded in the background
  if (store && m.opts.prefetch && !m.opts.offline) {
    fetch(`/api/prefetch/${encodeURIComponent(manifestName)}`).then((r) => (r.ok ? r.json() : [])).then((list) => {
      prefetch.total = list.length; prefetch.t0 = performance.now();
      if (list.length) log('file', `prefetch: ${list.length} blocks learned from earlier sessions`);
      return gameFiles.prefetch(list, prefetch, () => stopped).then(() => log('file', `prefetch: ${prefetch.done ? 'done' : 'stopped'}, ${prefetch.blocks} blocks (${Math.round(prefetch.bytes / 1048576)} MB) downloaded in ${((performance.now() - prefetch.t0) / 1000).toFixed(0)} s; store writes ${Math.round(store.stats.putMs ?? 0)} ms (${store.stats.flushes ?? 0} index flushes, ${Math.round(store.stats.flushMs ?? 0)} ms)`));
    }).catch(() => {});
  }
  if (store && m.opts.offline) { gameFiles.downloadAll(offline, () => stopped).then(() => log('file', `offline copy: ${offline.done ? 'complete' : 'stopped'} (${Math.round(offline.bytes / 1048576)} MiB of ${Math.round(offline.total / 1048576)})`)); }
  vfs.mount(manifest.mount, gameFiles);
  profile = new MemBackend();
  for (const d of PROFILE_DIRS) profile.mkdir(d);
  if (!m.opts.headless || m.opts.opfs) await loadProfile(profile);
  // a harness-provided profile (headless runs: `--profile-dir`), base64 files with '/'-separated paths
  for (const f of m.opts.profileFiles ?? []) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) profile.mkdir(parts.slice(0, i).join('/'));
    profile.open(f.path, { create: true }).write(0, Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0)));
  }
  vfs.mount('C:\\Users\\Player', profile);
  audioMixDirect = m.opts.audioMix !== 'worker';
  const bgWanted = !m.opts.interp && m.opts.bgTranslate !== false && typeof Worker !== 'undefined' && globalThis.crossOriginIsolated;
  vm = new Vm({ vfs, clock, host, jit: !m.opts.interp, sharedMemory: bgWanted, logKinds: m.opts.log ?? ['loader', 'warn', 'crash', 'win', 'thread', 'gfx', 'audio', 'input'], log: log, apiHist: true });
  vm.onStdout = (s) => post({ type: 'stdout', text: s });
  if (regionSink && vm.jit) vm.jit.learned = [];
  // learned regions translated in a worker of their own (another core) while the game runs; ?bgjit=0: off (then only
  // while the game waits, on this thread)
  if (vm.jit && bgWanted) {
    try {
      bgTranslator = new Worker(new URL('../../cpu/jit/bg-translate.js', import.meta.url), { type: 'module' });
      bgTranslator.onmessage = (e) => { if (e.data?.type === 'batch') { vm.jit.bgInstall(e.data); feedBackground(); } };
      bgTranslator.onerror = (e) => { log('warn', `background translation unavailable: ${e.message ?? e}`); bgTranslator = null; };
      vm.jit.attachBackground(bgTranslator);
    } catch (e) { bgTranslator = null; log('warn', `background translation unavailable: ${e.message}`); }
  }
  // slow-frame diagnostics: what happened during a frame longer than 33 ms (deltas since the previous frame)
  host.frameProbe = () => ({ t: performance.now(), api: vm.apiCalls, slices: vm.slices, translateMs: vm.jit?.stats.translateMs ?? 0, regions: vm.jit?.stats.regions ?? 0, consolidations: vm.jit?.stats.consolidations ?? 0, fallbacks: vm.jit?.stats.fallbackSteps ?? 0, uploads: host.gfx?.device?.stats?.uploads ?? 0, uploadKB: Math.round((host.gfx?.device?.stats?.uploadBytes ?? 0) / 1024), draws: vm.d3dDevice?.draws ?? 0, audioMs: host.audioMs ?? 0, threads: vm.proc.threads.length, ioReq: gameFiles.stats.requests, ioMs: Math.round(gameFiles.stats.ms), ioKB: Math.round(gameFiles.stats.bytes / 1024), idleMs: Math.round(pumpIdleMs + (host.waitMs ?? 0)), idleParts: takeIdleParts(), heldMs: Math.round(vm.wm?.heldMs ?? 0), programMs: Math.round(host.gfx?.device?.stats?.programMs ?? 0), apiMs: Math.round(vm.apiTimeTotal ?? 0), topApis: vm.apiTimes ? takeTopApis() : '', mainWaits: vm.mainWaits ? takeMainWaits() : '' });
  host.slowFrameFrom = (m.opts.slowFrom ?? 0) * 1000;
  if (m.opts.headless) { longWaitMin = 150; vm.waitLogMin = 80; vm.mainWaits = new Map(); }
  if (m.opts.apiTimes) vm.apiTimes = new Map(); // (harness --api-times: a clock read per API call, garbage included) // (harness: waits of 150 ms and more reported too) // (harness runs: per-frame API time in the slow-frame lines)
  host.onSlowFrame = (dt, d) => {
    // (a frame mostly spent waiting: what the game waited for)
    if (d.idleMs > 150 && (idleFrameLogs = (idleFrameLogs ?? 0) + 1) <= 10) log('hang', `a ${dt.toFixed(0)} ms frame spent ${d.idleMs} ms waiting; idle: ${d.idleParts}; the main thread's waits in the frame: ${d.mainWaits}; its last API calls:\n  ${vm.recentApiCalls(40, vm.proc.threads[0]?.id).join('\n  ')}\n${vm.threadsReport().split('\nsync objects')[0]}`);
    log('slowframe', `t=${(performance.now() / 1000).toFixed(1)}s ${dt.toFixed(1)}ms: api ${d.api} slices ${d.slices} draws ${d.draws} jit ${d.translateMs}ms/${d.regions}r/${d.consolidations}c fb ${d.fallbacks} tex ${d.uploads}/${d.uploadKB}KB present ${d.presentMs}ms audio ${d.audioMs}ms io ${d.ioReq}/${d.ioKB}KB/${d.ioMs}ms idle ${d.idleMs}ms held ${d.heldMs}ms programs ${d.programMs}ms api ${d.apiMs}ms [${d.topApis}]${d.idleMs >= 10 ? ` — idle: ${d.idleParts}; main thread waits: ${d.mainWaits}` : ''}`);
  };
  vm.registry = new Registry(); vm.registry.seed(manifest.registry);
  if (profile.files.has('registry.json')) { try { vm.registry.load(JSON.parse(new TextDecoder().decode(profile.open('registry.json').read(0, profile.stat('registry.json').size)))); } catch (e) { log('warn', `bad registry.json: ${e.message}`); } }
  const exePath = normalizeWin(manifest.mount + '\\' + manifest.exe);
  try {
    vm.createProcess({ exePath, args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides, cwd: manifest.cwd ? normalizeWin(manifest.mount + '\\' + manifest.cwd) : undefined });
  } catch (e) { post({ type: 'crash', report: e instanceof GuestCrash ? e.report : String(e.stack || e) }); return; }
  running = true;
  post({ type: 'started', profile: profileListing.slice(0, 200), firstLaunch: !m.opts.headless && profileFilesRestored === 0 && !(m.opts.profileFiles?.length) });
  channel.port1.onmessage = () => { pumpPosted = false; pump(); };
  host.wake = () => { if (running && !stopped) schedulePump(0); }; // (an asynchronous completion a guest thread waits on)
  pump();
}

let lastProf = {};
let statsAt = 0, lastApi = 0, lastSlices = 0, lastFrames = 0, lastHist = new Map(), lastFallbacks = 0, lastFbHist = new Map();
const pumpStats = { runs: 0, sleeps: 0, idles: 0, sleepMs: 0, runMs: 0 }; // how the worker spends its time between slices
let longSliceStart = 0, longSliceLogs = 0, longWaitLogs = 0, longWaitMin = 1000, idleFrameLogs = 0;
/**
 * The next pump: at once (a message: the event loop still runs in between) or after `ms` (a timer). One pending at a
 * time — a wake-up (input, an asynchronous completion) replaces a pending timer instead of starting a second chain.
 */
let pumpPosted = false, pumpTimer = null;
function schedulePump(ms) {
  if (pumpTimer !== null) { clearTimeout(pumpTimer); pumpTimer = null; }
  if (ms > 0) { pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, ms); return; }
  if (!pumpPosted) { pumpPosted = true; channel.port2.postMessage(0); }
}
/** The APIs that took the most time since the previous frame (then reset): what a slow frame spent its time in. */
function takeTopApis() { const top = [...vm.apiTimes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '); vm.apiTimes.clear(); return top; }
let idlePartsPrev = { pump: 0, wait: 0 };
/** Worker time per guest thread since the last call (thread id: % of the interval), busiest first. */
const lastThreadMs = new Map();
function threadTimes(dt) {
  const out = [];
  for (const t of vm.proc.threads) { const ms = t.runMs ?? 0, d = ms - (lastThreadMs.get(t.id) ?? 0); lastThreadMs.set(t.id, ms); if (d >= 1) out.push([t.id, d]); }
  return out.sort((a, b) => b[1] - a[1]).map(([id, d]) => `t${id}:${Math.round(d / dt / 10)}%`).join(' ');
}
function takeIdleParts() { const r = `pump gaps ${Math.round(pumpIdleMs - idlePartsPrev.pump)}ms in ${pumpGaps} (max ${Math.round(pumpGapMax)}, last return ${lastPumpReturn}), nested waits ${Math.round((host.waitMs ?? 0) - idlePartsPrev.wait)}ms`; idlePartsPrev = { pump: pumpIdleMs, wait: host.waitMs ?? 0 }; pumpGaps = 0; pumpGapMax = 0; return r; }
/** registers, x87 state and the next instructions of every thread not waiting (debugging: `threads` input) */
function threadDetails() {
  const out = [];
  for (const t of vm.proc.threads) {
    if (t.state !== 0 && t.state !== 1) continue; // (ready or running)
    const c = t.cpu, st = [];
    for (let i = 0; i < 8; i++) st.push(c.st(i));
    out.push(`thread ${t.id} at ${vm.proc.symbolize(c.eip)}\n${c.dump()}\nx87 cw=${c.fpuCw.toString(16)} sw=${c.fpuSw.toString(16)} top=${c.fpuTop} tw=${c.fpuTw.toString(16)} st=${st.join(', ')}`);
    let a = c.eip;
    for (let i = 0; i < 14; i++) { try { const insn = decode(vm.mem, a); out.push(`  ${vm.proc.symbolize(a)}  ${fmtInsn(insn)}`); a = insn.next; } catch { break; } }
  }
  return out.join('\n');
}
function takeMainWaits() { const r = [...vm.mainWaits].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v.toFixed(0)}ms`).join(', '); vm.mainWaits.clear(); return r; }
let pumpIdleMs = 0, pumpEndAt = 0, pumpGaps = 0, pumpGapMax = 0, lastPumpReturn = ''; // (lastPumpReturn: why the last pump returned) // (time between two pumps: the worker waiting — slow-frame diagnostics)
function pump() {
  if (!running || stopped) return;
  if (bgTranslator && regionQueue) feedBackground();
  if (pumpEndAt) { const g = performance.now() - pumpEndAt; pumpIdleMs += g; pumpGaps++; if (g > pumpGapMax) pumpGapMax = g; }
  if (Atomics.load(host.ctl, CTL.STOP)) { stop('stopped'); return; }
  let r;
  const tRun = performance.now();
  // a slice that does not come back within a second (guest code run from a nested call — DllMain, a callback — is
  // not cut into slices): what runs, logged each second meanwhile (the page shows no new frame then)
  vm.progressEvery = 1000; vm.progressAt = tRun + 1000;
  vm.onProgress ??= (t) => { if ((longSliceLogs = (longSliceLogs ?? 0) + 1) <= 40) log('hang', `worker busy for ${((performance.now() - longSliceStart) / 1000).toFixed(1)} s in one slice: thread ${t.id}${t.callbackDepth ? ` (nested call depth ${t.callbackDepth})` : ''} at ${vm.proc.symbolize(t.cpu.eip)}, VM depth ${vm.depth}; last API calls: ${vm.recentApiCalls(6, t.id).join(', ')}`); };
  longSliceStart = tRun;
  try {
    r = vm.runFor(tRun + 12);
  } catch (e) {
    running = false;
    const report = e instanceof GuestCrash ? e.report : String(e.stack || e);
    post({ type: 'crash', report });
    flushProfile(true);
    return;
  }
  // the DirectSound buffers mixed by the page's AudioWorklet (guest memory shared): the voice table handed over once
  // DirectSound exists; until the worklet uses it (no audio output yet, ?audiomix=worker) the ring path below goes on
  if (vm.audio && !vm.audio.voices && audioMixDirect && vm.jit?.shared) { const sab = new SharedArrayBuffer(VOICE_TABLE_BYTES); vm.audio.attachVoices(sab); post({ type: 'audio-voices', memory: vm.mem.memory.buffer, voices: sab }); }
  host.renderAudio(vm);
  host.audioHook ??= () => host.renderAudio(vm);
  const now = performance.now();
  pumpStats.runs++; pumpStats.runMs += now - tRun;
  if (programSink && host.gfx.programCache.learned.length && now - programsPostedAt > 5000) { programsPostedAt = now; programSink(host.gfx.programCache.learned.splice(0)); }
  if (regionSink && vm.jit?.learned?.length && now - regionsPostedAt > 10000) {
    regionsPostedAt = now;
    const list = [];
    for (const [eip, fpc, t] of vm.jit.learned.splice(0)) { const mod = vm.proc.moduleByAddr(eip); if (mod) list.push([mod.name.toLowerCase(), eip - mod.base, fpc, t]); }
    if (list.length) regionSink(list);
  }
  if (now - statsAt > 500) {
    const dt = (now - statsAt) / 1000; statsAt = now;
    const hist = vm.apiHist();
    const ft = host.frameTimes.slice().sort((a, b) => a - b);
    const p = (q) => (ft.length ? ft[Math.min(ft.length - 1, Math.floor(q * ft.length))] : 0);
    const iv = host.interval ?? { max: 0, slow33: 0, slow50: 0 }; host.interval = { max: 0, slow33: 0, slow50: 0 };
    // time the game waited on the network for its files since the last report (synchronous range requests: nothing runs meanwhile)
    const netMs = (gameFilesStats?.ms ?? 0) - lastNetMs, netReq = (gameFilesStats?.requests ?? 0) - lastNetReq; lastNetMs = gameFilesStats?.ms ?? 0; lastNetReq = gameFilesStats?.requests ?? 0;
    const pc = host?.gfx?.programCache;
    // (loading progress for the page's loading screen: the learned downloads, translations and program builds done ahead)
    const load = { pfDone: prefetch.blocks, pfTotal: prefetch.total, pfFinished: prefetch.done || (prefetch.total > 0 && prefetch.blocks >= prefetch.total), pfMB: Math.round(prefetch.bytes / 1048576),
      rgDone: regionQueue ? regionPos : 0, rgTotal: regionQueue ? regionQueue.length : 0, pgDone: pc ? pc.started : 0, pgTotal: pc ? pc.started + pc.queue.length : 0 };
    post({ type: 'stats', load, dt, busy: Math.round(pumpStats.runMs / dt / 10), jitMs: Math.round((vm.jit?.stats.translateMs ?? 0) - (vm.jit?.stats.prewarmMs ?? 0)), netMs: Math.round(netMs), netReq, frameMax: iv.max, slow33: iv.slow33, slow50: iv.slow50, ioMB: Math.round((gameFilesStats?.bytes ?? 0) / 1048576), offlineMB: Math.round(offline.bytes / 1048576), prefetchMB: Math.round((prefetch.bytes ?? 0) / 1048576), offlineTotalMB: Math.round(offline.total / 1048576), apiPerSec: (vm.apiCalls - lastApi) / dt, mips: (vm.slices - lastSlices) * 0.1 / dt, fps: (host.framesPresented - lastFrames) / dt, frameP50: p(0.5), frameP99: p(0.99), regions: vm.jit?.stats.regions ?? 0, threads: vm.proc.threads.length, frames: host.framesPresented, firstD3D: vm.firstD3DCall?.name ?? null, d3d: vm.d3dDevice ? { frames: vm.d3dDevice.frames, draws: vm.d3dDevice.draws, w: vm.d3dDevice.pp.width, h: vm.d3dDevice.pp.height, programs: vm.d3dDevice.gfx?.stats.programs ?? 0, vaos: vm.d3dDevice.gfx?.stats.vaos ?? 0, programMs: Math.round(vm.d3dDevice.gfx?.stats.programMs ?? 0) } : null, unknownImports: vm.proc.unknownImports.size, fallbacksPerSec: ((vm.jit?.stats.fallbackSteps ?? 0) - lastFallbacks) / dt, pump: `${Math.round(pumpStats.runs / dt)} slices/s busy ${Math.round(pumpStats.runMs / dt / 10)}% sleeps ${Math.round(pumpStats.sleeps / dt)}/s avg ${(pumpStats.sleepMs / Math.max(1, pumpStats.sleeps)).toFixed(1)}ms idles ${Math.round(pumpStats.idles / dt)}/s threads ${threadTimes(dt)}`, topFallback: vm.jit?.fallbackHist ? [...vm.jit.fallbackHist].map(([k, v]) => [k, v - (lastFbHist.get(k) ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${OP_NAMES[k] ?? k}=${Math.round(v / dt)}`).join(' ') : '', audioBuffers: vm.audio?.buffers.size ?? 0, audioPeak: host.audioPeak ?? 0, audioMs: (host.audioMs ?? 0) / dt, audioFrames: (host.audioFrames ?? 0) / dt, topApi: hist ? [...hist].map(([k, v]) => [k, v - (lastHist.get(k) ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k.replace(/^(com|kernel32|user32|winmm|gdi32)\.dll!/, '')}=${Math.round(v / dt)}`).join(' ') : '' });
    if (hist) lastHist = hist;
    lastFallbacks = vm.jit?.stats.fallbackSteps ?? 0; if (vm.jit?.fallbackHist) lastFbHist = new Map(vm.jit.fallbackHist);
    // --jit-profile: block transitions per second by kind (intra-region jumps, returns, chaining)
    const prof = vm.jit?.stats.prof;
    if (prof) { log('jitprof', `per s: ${Object.entries(prof).map(([k, v]) => `${k}=${Math.round((v - (lastProf[k] ?? 0)) / dt)}`).join(' ')} chained=${Math.round((vm.jit.stats.chained - (lastProf.chained ?? 0)) / dt)} misses=${Math.round((vm.jit.stats.misses - (lastProf.misses ?? 0)) / dt)} translated=${Math.round((vm.jit.stats.regions - (lastProf.regions ?? 0)) / dt)} steps=${Math.round(((vm.jit.stats.steps ?? 0) - (lastProf.steps ?? 0)) / dt)} fpuModeMisses=${Math.round(((vm.jit.stats.fpuModeMisses ?? 0) - (lastProf.fpuModeMisses ?? 0)) / dt)} api=${Math.round((vm.apiCalls - (lastProf.api ?? 0)) / dt)} unchained(thunk,stop,budget,miss)=${[0, 1, 2, 3].map((k) => { const v = vm.mem.read32(PROF_OPS_BASE + NOCHAIN_PROF + 4 * k); vm.mem.write32(PROF_OPS_BASE + NOCHAIN_PROF + 4 * k, 0); return Math.round(v / dt); }).join('/')} flags helper by op/s: ${vm.jit.flagsByOp().slice(0, 10).map(([k, n]) => `${k}=${Math.round(n / dt)}`).join(' ')}`); lastProf = { ...prof, chained: vm.jit.stats.chained, misses: vm.jit.stats.misses, regions: vm.jit.stats.regions, steps: vm.jit.stats.steps ?? 0, fpuModeMisses: vm.jit.stats.fpuModeMisses ?? 0, api: vm.apiCalls }; }
    if (prof) { // fast-path API calls (handled by the dispatcher in WASM): per API, and their most frequent call sites
      const u32 = vm.mem.u32, base = FAST_PROF >>> 2, names = Object.entries(FAST_NAMES).reduce((a, [k, v]) => { a[v] ??= k.replace(/^kernel32\.dll!/, ''); return a; }, { 16: 'deferred COM' });
      const per = []; for (let i = 0; i < 32; i++) { if (u32[base + i]) per.push([names[i] ?? i, u32[base + i]]); u32[base + i] = 0; }
      const sites = new Map(); for (let i = 0; i < 1024; i++) { const a = u32[base + 0x40 + i]; if (a) sites.set(a, (sites.get(a) ?? 0) + 1); u32[base + 0x40 + i] = 0; }
      if (per.length) log('jitprof', `fast API calls per s: ${per.sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${Math.round(n / dt)}`).join(' ')}; return sites (of the last 1024): ${[...sites].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([a, n]) => { let call = '?'; for (const len of [6, 2, 3, 5, 7, 4]) { try { const i = decode(vm.mem, a - len); if (i.next === a && OP_NAMES[i.op] === 'CALL') { call = fmtInsn(i); break; } } catch {} } return `${vm.proc.symbolize(a)} x${n} [${call}]`; }).join(', ')}`);
    }
    pumpStats.runs = pumpStats.sleeps = pumpStats.idles = pumpStats.sleepMs = pumpStats.runMs = 0;
    lastApi = vm.apiCalls; lastSlices = vm.slices; lastFrames = host.framesPresented; host.audioPeak = 0; host.audioMs = 0; host.audioFrames = 0;
    flushProfile();
  }
  pumpEndAt = performance.now(); lastPumpReturn = r.state === 'sleep' ? `sleep ${Math.round(r.until - pumpEndAt)}ms` : r.state;
  if (r.state === 'exited') { running = false; post({ type: 'exit', code: r.code, report: vm.exitReport ?? null }); flushProfile(true); return; }
  if (r.state === 'sleep') {
    if (r.until - pumpEndAt >= 3) prewarmRegions(Math.min(8, r.until - pumpEndAt - 1)); // (the wait, used to translate ahead)
    const ms = Math.max(0, r.until - performance.now()); pumpStats.sleeps++; pumpStats.sleepMs += ms; schedulePump(Math.max(1, ms));
    // every thread waiting a second or more: what for (a wait Windows would end sooner shows up here)
    if (ms >= (longWaitMin ?? 1000) && (longWaitLogs = (longWaitLogs ?? 0) + 1) <= 20) log('hang', `every thread waits, next wake in ${(ms / 1000).toFixed(1)} s:\n${vm.threadsReport().split('\nsync objects')[0]}`);
  }
  else if (r.state === 'idle') { pumpStats.idles++; prewarmRegions(8); schedulePump(30); }
  else schedulePump(0);
}

/**
 * Translate learned regions for up to `budgetMs` (the game is waiting): after the first frame (the code is in place),
 * in the order earlier sessions first needed them; entries of modules not loaded (yet) are passed over.
 */
/**
 * Learned regions to the background translator, in their order of first use, up to two batches in flight (the rest
 * waits for the answers: installing stays in step with what the other thread produces). Entries of modules not loaded
 * yet are kept for later.
 */
function feedBackground() {
  if (!bgTranslator || !regionQueue || !vm?.jit) return;
  const jit = vm.jit;
  if (bgMods.n !== vm.proc.moduleList.length) { bgMods.n = vm.proc.moduleList.length; bgMods.map = new Map(vm.proc.moduleList.map((x) => [x.name.toLowerCase(), x])); if (regionLater.length) { regionQueue.push(...regionLater); regionLater = []; } }
  while (jit.bgPending() < 2 && regionPos < regionQueue.length) {
    const list = [];
    while (list.length < 48 && regionPos < regionQueue.length) {
      const e = regionQueue[regionPos++];
      if (!Array.isArray(e) || !Number.isInteger(e[1]) || e[1] < 0) continue;
      const mod = bgMods.map.get(e[0]);
      if (!mod) { if (regionLater.length < 65536) regionLater.push(e); continue; }
      if (e[1] < mod.size) list.push([mod.base + e[1], e[2] ?? null]);
    }
    if (list.length) jit.bgPrewarm(list);
  }
  if (regionPos >= regionQueue.length && !jit.bgPending() && !bgDoneLogged && !regionLater.length) {
    bgDoneLogged = true;
    const bg = jit.bg;
    log('file', `regions: ${bg.installed} translated ahead in the background and installed (${Math.round(bg.bgMs)} ms there, ${Math.round(jit.stats.bgInstallMs ?? 0)} ms installing here), ${bg.rejected} dropped (code changed, or translated here first), ${bg.sent - bg.installed - bg.rejected} not translatable; ${regionQueue.length - bg.sent} entries already translated or without code`);
  }
}
function prewarmRegions(budgetMs) {
  if (bgTranslator) { feedBackground(); return; }
  if (!regionQueue || regionPos >= regionQueue.length || !vm.jit || !host.framesPresented) return;
  const end = performance.now() + budgetMs;
  const mods = new Map(vm.proc.moduleList.map((x) => [x.name.toLowerCase(), x]));
  while (regionPos < regionQueue.length && performance.now() < end) {
    const e = regionQueue[regionPos++];
    const mod = Array.isArray(e) ? mods.get(e[0]) : null;
    if (!mod || !Number.isInteger(e[1]) || e[1] < 0 || e[1] >= mod.size) continue;
    vm.jit.prewarm(mod.base + e[1], e[2] ?? null);
  }
  if (regionPos >= regionQueue.length) log('file', `regions: ${vm.jit.stats.prewarmed ?? 0} of ${regionQueue.length} translated ahead in ${Math.round(vm.jit.stats.prewarmMs ?? 0)} ms`);
}

/** Instruction mix of translated regions (by entry EIP): mnemonic counts per region and overall — profiler companion. */
/** region function imports by index (translate.js IMP_*: flags helper, round24, interpreter fallback, then the math kernels) */
const IMPORT_NAMES = ['flags', 'round24', 'fallback', ...MATH_KERNELS.map(([n]) => n)];
function regionMix(eips, list = 0) {
  const lines = [], overall = new Map(), listed = new Set(); let total = 0;
  for (const eipHex of eips) {
    const eip = parseInt(eipHex, 16);
    const r = vm.jit?.byEntry.get(eip);
    if (!r) { lines.push(`region ${eipHex}: not live`); continue; }
    const hist = new Map(); let n = 0, bytes = 0, fb = 0;
    for (const b of r.blocks) {
      let a = b.eip;
      while (a < b.end) { let insn; try { insn = decode(vm.mem, a); } catch { break; } const name = OP_NAMES[insn.op]; hist.set(name, (hist.get(name) ?? 0) + 1); overall.set(name, (overall.get(name) ?? 0) + 1); n++; total++; bytes += insn.len; a = insn.next; if (!HANDLERS[insn.op]) fb++; }
    }
    const top = [...hist].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join(', ');
    const calls = new Map(); const rc = r.calls ?? []; for (let i = 0; i < rc.length; i += 2) { const k = `${IMPORT_NAMES[rc[i]] ?? 'f' + rc[i]}@${rc[i + 1] >= 0 ? OP_NAMES[rc[i + 1]] : 'end'}`; calls.set(k, (calls.get(k) ?? 0) + 1); }
    lines.push(`region ${eipHex} (${vm.proc.symbolize(eip)}): ${r.blocks.length} blocks, ${n} insns, ${bytes} bytes, ${fb} interpreter fallbacks, calls ${calls.size ? [...calls].map(([k, v]) => `${k}x${v}`).join(' ') : 'none'} — ${top}`);
    if (listed.has(eip) || listed.size >= list) continue;
    listed.add(eip); // listing of the hottest regions: which instruction patterns the translation spends its time on
    for (const b of [...r.blocks].sort((x, y) => x.eip - y.eip)) {
      lines.push(`  block ${b.eip.toString(16)}`);
      for (let a = b.eip; a < b.end;) { let insn; try { insn = decode(vm.mem, a); } catch { break; } lines.push(`    ${a.toString(16)}  ${fmtInsn(insn)}`); a = insn.next; }
    }
  }
  lines.push(`overall (${total} insns): ` + [...overall].sort((x, y) => y[1] - x[1]).slice(0, 24).map(([k, v]) => `${k} ${(100 * v / Math.max(1, total)).toFixed(1)}%`).join(', '));
  return lines.join('\n');
}

/**
 * Instruction corpus: the distinct instruction forms (mnemonic, operand kinds and sizes, addressing shape, prefixes)
 * found in the translated regions, each with a few concrete encodings — input of the `corpus` conformance suite
 * (tools/gen/gen_cases.py), which replays them against the native CPU with random operands.
 */
function insnCorpus() {
  const forms = new Map();
  const opKey = (o) => o.t === OT.MEM ? `m${o.size}${o.base >= 0 ? 'b' : ''}${o.index >= 0 ? 'i' : ''}${o.seg >= 0 ? 's' + o.seg : ''}${o.a16 ? 'a16' : ''}` : o.t === OT.REG ? `r${o.size}` : o.t === OT.IMM ? `i${o.size ?? ''}` : o.t === OT.XMM ? 'x' : o.t === OT.MM ? 'mm' : o.t === OT.ST ? (o.r ? 'sti' : 'st0') : 'o' + o.t;
  let insns = 0;
  for (const r of vm.jit?.byEntry.values() ?? []) {
    for (const b of r.blocks) {
      let a = b.eip;
      while (a < b.end) {
        let insn; try { insn = decode(vm.mem, a); } catch { break; }
        insns++;
        const key = `${OP_NAMES[insn.op]}${insn.cc !== undefined && insn.cc >= 0 ? '.' + insn.cc : ''}|${insn.opsize ?? ''}|${insn.lock ? 'L' : ''}${insn.rep ? 'R' + insn.rep : ''}|${insn.ops.map(opKey).join(',')}`;
        let f = forms.get(key);
        if (!f) forms.set(key, (f = { key, op: OP_NAMES[insn.op], count: 0, examples: [] }));
        f.count++;
        if (f.examples.length < 4) {
          const bytes = Array.from(vm.mem.bytes(a, insn.len), (x) => x.toString(16).padStart(2, '0')).join('');
          if (!f.examples.some((e) => e.hex === bytes)) f.examples.push({ hex: bytes, text: fmtInsn(insn), mem: insn.ops.filter((o) => o.t === OT.MEM).map((o) => ({ base: o.base, index: o.index, scale: o.scale, disp: o.disp, size: o.size, seg: o.seg, a16: !!o.a16 })) });
        }
        a = insn.next;
      }
    }
  }
  return JSON.stringify({ insns, forms: [...forms.values()].sort((x, y) => y.count - x.count) });
}

function stop(reason) { stopped = true; running = false; flushProfile(true); post({ type: 'exit', code: -1, reason }); }

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') start(m).catch((err) => post({ type: 'crash', report: String(err.stack || err) }));
  else if (m.type === 'wake') { if (running && !stopped) schedulePump(0); }
  else if (m.type === 'dump') { if (vm) log('hang', `memory ${(m.addr >>> 0).toString(16)}+${m.len.toString(16)}: ${Array.from(vm.mem.bytes(m.addr >>> 0, m.len), (b) => b.toString(16).padStart(2, '0')).join('')}`); } // (debugging: harness input `dump:addr,len`)
  else if (m.type === 'watch') { if (vm?.jit) { vm.jit.watchWrites(m.addr >>> 0, m.len || 4, 'ctl', 100000); log('hang', `watching writes to ${(m.addr >>> 0).toString(16)}+${m.len || 4}`); } } // (debugging: harness input `watch:addr,len`, then `unwatch`)
  else if (m.type === 'unwatch') { if (vm?.jit) log('hang', `writes seen (writer: count): ${[...vm.jit.unwatch('ctl')].map(([k, n]) => `${k}: ${n}`).join(', ') || 'none'}`); }
  else if (m.type === 'threads') { if (vm) log('hang', `threads on request:\n${vm.threadsReport()}\n${threadDetails()}`); } // (debugging: harness input `threads`)
  else if (m.type === 'burst') { if (vm) vm.startApiBurst(vm.proc.threads.find((t) => t.id === m.tid) ?? vm.proc.threads[0], m.n ?? 3000, !!m.noGfx); } // (debugging: --log apiburst, harness input burst:N[,tid])
  else if (m.type === 'stop') stop('stop requested');
  else if (m.type === 'capture') { const d = host?.gfx?.device; if (d) { d.captureAt = d.frame + 1; d.captureDraws = !!m.draws; d.countFrames = m.count ?? 0; log('gfx', `d3d-webgl: ${m.count ? 'GL call count' : 'capture'} requested at frame ${d.frame + 1}`); } }
  else if (m.type === 'regions') post({ type: 'regions', text: vm ? regionMix(m.eips, m.list ?? 0) : 'no vm' });
  else if (m.type === 'interpRange') { // (debugging: from now on, these code ranges run in the reference interpreter)
    const ranges = String(m.ranges).split(',').map((r) => r.split(':').map((x) => parseInt(x, 16)));
    if (vm?.jit) { vm.jit.opts.interpRanges = ranges; for (const [lo, hi] of ranges) vm.invalidateCode(lo, hi - lo); log('warn', `interpreter ranges on: ${m.ranges}`); }
  }
  else if (m.type === 'loseContext') { // (testing: WebGL context loss and restoration)
    const ext = host?.gfx?.gl.getExtension('WEBGL_lose_context');
    if (ext) { ext.loseContext(); setTimeout(() => ext.restoreContext(), m.ms ?? 500); } else log('warn', 'WEBGL_lose_context unavailable');
  }
  else if (m.type === 'corpus') post({ type: 'corpus', text: vm ? insnCorpus() : '{}' });
  else if (m.type === 'profile-dump') post({ type: 'profile', files: profileDump() });
  else if (m.type === 'frames') { const f = host?.frameStats(m.fromMs ?? 0); post({ type: 'frames', text: f ? `frames from t=${((m.fromMs ?? 0) / 1000).toFixed(0)}s: ${f.frames} frames in ${f.seconds.toFixed(0)}s = ${f.fps.toFixed(1)} fps; frame time p50 ${f.p50.toFixed(1)} p90 ${f.p90.toFixed(1)} p99 ${f.p99.toFixed(1)} max ${f.max.toFixed(0)} ms; >33ms ${f.over33} (${(100 * f.over33 / f.frames).toFixed(2)}%), >50ms ${f.over50}` : 'no frames' }); }
  else if (m.type === 'report') {
    const hist = vm?.apiHist();
    const apis = (hist ? '[report] API calls since start (' + hist.size + ' functions):\n' + [...hist].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v} ${k}`).join('\n') + '\n' : '') + (vm?.d3dDevice ? '[report] Direct3D states used (distinct values):\n  ' + stateUseReport(vm.d3dDevice) + '\n' : '') + (vm?.jit ? `[report] JIT: ${vm.jit.stats.regions} regions translated in ${(vm.jit.stats.translateMs / 1000).toFixed(1)} s (emit ${(vm.jit.stats.tEmit / 1000).toFixed(1)}, build ${(vm.jit.stats.tBuild / 1000).toFixed(1)}, compile ${(vm.jit.stats.tModule / 1000).toFixed(1)}, instantiate ${(vm.jit.stats.tInstance / 1000).toFixed(1)}, consolidate ${(vm.jit.stats.tConsolidate / 1000).toFixed(1)} s), ${(vm.jit.stats.bytes / 1048576).toFixed(0)} MiB of WASM, ${vm.jit.stats.blocks} blocks for ${vm.jit.blockMap.size} distinct block addresses, ${vm.jit.stats.fpuVersions ?? 0} FPU-mode versions, ${vm.jit.stats.fpuModeMisses ?? 0} mode misses${vm.jit.stats.prewarmed ? `; ${vm.jit.stats.prewarmed} translated ahead (learned) in ${(vm.jit.stats.prewarmMs / 1000).toFixed(1)} s, ${regionPos} of ${regionQueue?.length ?? 0} entries looked at` : ''}\n` : '') + (gameFilesStats ? `[report] game files over HTTP: ${gameFilesStats.requests} requests, ${(gameFilesStats.bytes / 1048576).toFixed(0)} MiB, ${gameFilesStats.ms.toFixed(0)} ms${gameStore ? `; block store: ${gameStore.stats.hits} hits, ${gameStore.stats.puts} blocks added` : ''}\n` : '') + (host?.gfx?.device?.stats?.programs ? `[report] GL programs built: ${host.gfx.device.stats.programs} in ${(host.gfx.device.stats.programMs ?? 0).toFixed(0)} ms (slowest ${(host.gfx.device.stats.programMaxMs ?? 0).toFixed(1)} ms)\n` : '') + (host?.gfx?.programCache?.started ? `[report] GL programs compiled ahead: ${host.gfx.programCache.started}, ${host.gfx.programCache.hits} used, ${host.gfx.programCache.stale} with other sources\n` : '') + (host?.gfx?.device?.stats?.uploadsBy ? '[report] texture level uploads by format:size (most frequent):\n  ' + [...host.gfx.device.stats.uploadsBy].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k} x${v}`).join(', ') + '\n' : '');
    post({ type: 'report', text: vm ? apis + vm.threadsReport() + '\n' + vm.crashReport(vm.lastThread ?? vm.proc.threads[0], 'state dump') : 'no vm' });
  }
};
void IN_RING; void AUDIO_RING_FRAMES;
