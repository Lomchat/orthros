// Emulator worker: builds the VFS (game folder over HTTP ranges, user profile in memory mirrored
// to OPFS), the browser host and the VM, then pumps the VM cooperatively so the canvases are
// presented and input/audio flow while the guest runs.
import { DxtPool } from '../../win32/dxt-pool.js';
import { setDxtEncoder } from '../../win32/d3dx9-image.js';
import { Vm, GuestCrash } from '../../core/vm.js';
import { RealClock } from '../../core/clock.js';
import { Vfs, MemBackend, normalizeWin, mountGameCdrom } from '../../vfs/vfs.js';
import { FileAliasBackend } from '../../vfs/file-alias-backend.js';
import { HttpBackend, BLOCK } from '../../vfs/http-backend.js';
import { NetLink } from '../../vfs/net-link.js';
import { OpfsBlockStore, MemBlockStore } from '../../vfs/opfs-store.js';
import { Registry } from '../../win32/registry.js';
import { BrowserHost, CTL, IN_RING, AUDIO_RING_FRAMES } from '../browser-host.js';
import { VOICE_TABLE_BYTES, audioPlaying } from '../../win32/dsound.js';
import { audioDecodeStats } from '../../media/mpeg-source.js';
import { LAN } from '../lan-proto.js';
import { createWebGLBackend } from '../../gfx/d3d8-webgl.js';
import { createInlineGfx, createRemoteGfx, createCompareGfx, renderMode } from '../../gfx/render-host.js';
import { stateUseReport } from '../../win32/d3d8.js';
import { decode, OP_NAMES, OT, fmtInsn } from '../../cpu/decoder.js';
import { HANDLERS, PROF_OPS_BASE, NOCHAIN_PROF } from '../../cpu/jit/translate.js';
import { MATH_KERNELS, FAST_NAMES, FAST_PROF, FAST_STATS } from '../../cpu/jit/runtime.js';
import { listRegion } from '../../cpu/jit/listing.js';
import { acct, C as ACCT, catsObject } from '../../core/frame-acct.js';
import { refreshApiOpt } from '../../core/api-opt.js';
import { SeedWatch, toBase64, fromBase64, seedPathOk } from '../profile-seed.js';
import { LearnedHeat } from '../../cpu/jit/heat.js';
import { captureVm, restoreVm } from '../../core/vm-snapshot.js';
import { encodeSnapshot, decodeSnapshot } from '../../core/snapshot.js';

let profileFilesRestored = 0, profileListing = []; // (the listing goes to the page: failure diagnostics) // files of the game's user profile found in the browser (0: its first launch here)
let vm = null, host = null, profile = null, opfsDir = null, manifestName = '', gameStore = null, gameFilesStats = null, lastNetMs = 0, lastNetReq = 0;
/** the block stores of the game files (the game's and the games it requires): their index synced by flushProfile */
const fileStores = [];
/** the player's connection (game file downloads: bandwidth, demand first) and the game folder's backend */
let netLink = null, primaryFiles = null;
const offline = { bytes: 0, total: 0, done: false }; // (background download of the game folder, opt-in)
const offlineDependencies = []; // copies of additional mounted games, counted with the primary game
const prefetch = { bytes: 0, blocks: 0, total: 0, done: false }; // (learned prefetch, see HttpBackend.prefetch)
/** the network read counters of the games the manifest requires (mounted beside it), counted with the game's own */
let extraFilesStats = null;
/** a network read counter (requests, ms, bytes) of the game's folder and the games it requires */
const netStat = (k) => { let v = gameFilesStats?.[k] ?? 0; for (const st of extraFilesStats ?? []) v += st[k] ?? 0; return v; };
let programSink = null, programsPostedAt = 0; // (GL programs this session built at a draw, sent to the server: see server.js)
/** code regions earlier sessions translated ([module, rva, x87 mode], from the server), translated while the game waits */
let regionQueue = null, regionPos = 0, regionSink = null, regionsPostedAt = 0;
// learned code heat (src/cpu/jit/heat.js): earlier sessions' ranges, applied to the JIT as modules load; this session's
// visit flags sent back with the regions
let learnedHeat = null, heatModules = 0, heatSink = null;
let audioMixDirect = true; // (?audiomix=worker: the game's worker mixes into the ring, as before)
let bgTranslator = null, regionLater = [], bgDoneLogged = false; const bgMods = { n: -1, map: null }; // (background translation)
let lastFlush = 0, running = false, stopped = false;
let snapshotWanted = null; // (the page asked for a snapshot of the machine: taken at the next quiet point — docs/snapshot.md)
/** shared first-launch profile (profile-seed.js): files offered by the server to an empty profile; a first session's watch */
let seedWatch = null, seedSink = null, profileSeeded = 0;
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

/** Puts the server's shared first-launch profile in an empty profile, else watches this first session (see profile-seed.js). */
async function seedProfile(lang, session) {
  const url = `/api/profile-seed/${encodeURIComponent(manifestName)}`;
  try {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 3000); // (never holds the start long)
    const r = await fetch(`${url}?lang=${encodeURIComponent(lang)}`, { signal: ac.signal }).finally(() => clearTimeout(timer));
    const j = r.ok ? await r.json() : null;
    for (const f of Array.isArray(j?.files) ? j.files : []) {
      const data = fromBase64(f?.data);
      if (!data || !seedPathOk(f.path)) continue;
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) profile.mkdir(parts.slice(0, i).join('/'));
      profile.open(f.path, { create: true })?.write(0, data);
      profileSeeded++;
    }
  } catch { /* none: learned below */ }
  if (profileSeeded) { log('file', `profile: ${profileSeeded} file(s) a first session of this game wrote put in place (shared first-launch profile)`); return; }
  seedWatch = new SeedWatch({ files: () => profileFilesList() });
  seedSink = (files) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang, session, files: files.map((f) => ({ path: f.path, data: toBase64(f.data) })) }) }).catch(() => {});
}

/** the persistent cache of translated code (code-cache.js): pages, and headless runs with a persistent profile (--opfs) */
const codeCacheOn = (o) => o.codeCache !== false && (!o.headless || !!o.opfs);

/** The profile's files: { path (original case, '/'-separated), data (a view: copy to keep) } */
function profileFilesList() {
  const out = [];
  for (const [key, f] of profile.files) {
    const parts = key.split('/');
    out.push({ path: parts.map((_, i) => profile.names.get(parts.slice(0, i + 1).join('/')) ?? parts[i]).join('/'), data: f.data.subarray(0, f.len) });
  }
  return out;
}

async function flushProfile(force = false) {
  const now = Date.now();
  if (!force && now - lastFlush < 2000) return;
  for (const s of fileStores) s.flush(force); // (the game file block stores' index: a sync point every 2 s, at once when forced)
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
  return profileFilesList().map((f) => ({ path: f.path, data: toBase64(f.data) }));
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
  refreshApiOpt();
  if (m.opts.jitOpts) try { globalThis.ORTHROS_JIT_OPTS = JSON.parse(m.opts.jitOpts); } catch (e) { log('warn', `jitopts ignored (not JSON: ${e.message}): ${m.opts.jitOpts}`); } // (debugging: ?jitopts={"consolidateEvery":...}; a run believed to use them must not silently run the defaults)
  globalThis.ORTHROS_DUMP_SHADERS = !!m.opts.dumpShaders; globalThis.ORTHROS_CAPTURE_FRAME = m.opts.captureFrame || 0; globalThis.ORTHROS_CAPTURE_DRAWS = !!m.opts.captureDraws; globalThis.ORTHROS_LOCK_LOG = (m.opts.log ?? []).includes('lock'); if (m.opts.burstFromId) globalThis.ORTHROS_BURST_FROM_ID = m.opts.burstFromId; globalThis.ORTHROS_NO_CULL = !!m.opts.noCull; globalThis.ORTHROS_JIT_PROFILE = !!m.opts.jitProfile; globalThis.ORTHROS_GL_DISCARD = !!m.opts.glDiscard; globalThis.ORTHROS_WATCH_TEX = m.opts.watchTex || undefined; globalThis.ORTHROS_NO_F32 = !!m.opts.noF32; globalThis.ORTHROS_F32_OFF = m.opts.f32Off || ''; globalThis.ORTHROS_GL_VALIDATE = !!m.opts.glValidate; globalThis.ORTHROS_INTERP_RANGES = m.opts.interpRange || undefined;
  // frame capture (--capture N): images (bound textures, render target after draws) encoded as PNG for the harness
  const dump = (name, w, h, rgba) => { try { const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer instanceof ArrayBuffer ? rgba.buffer : rgba.slice().buffer, rgba.buffer instanceof ArrayBuffer ? rgba.byteOffset : 0, w * h * 4), w, h), 0, 0); c.convertToBlob({ type: 'image/png' }).then((b) => b.arrayBuffer()).then((ab) => post({ type: 'dump', name, data: ab }, [ab])); } catch (e) { log('warn', `dump ${name} failed: ${e.message}`); } };
  // Direct3D rendering: the WebGL backend on this thread, or (?glworker=1, docs/render-worker.md) the devices' work
  // recorded for a render worker that owns its own canvas — ?glworker=inline / check: recorded and replayed here
  // (?glworker=compare / compare-worker: the in-thread backend presents, the recorded work is replayed beside it — here
  // or in a render worker — and the two back buffers compared every 60 frames)
  // (the page's ?glworker= wins, then the manifest's compat flag "glWorker": 0 / 1 / "inline"; without either the render
  // worker where it can run, the default since 2026-10-04 — docs/render-worker.md section 8.8; renderMode)
  const glMode = renderMode(m.opts.glWorker, manifest.glWorker);
  const workerOk = typeof Worker !== 'undefined' && !!globalThis.crossOriginIsolated && !m.opts.interp;
  const renderWorker = (glMode === '1' || glMode === 'compare-worker') && workerOk, remoteGl = glMode === '1' && workerOk;
  if ((glMode === '1' || glMode === 'compare-worker') && !workerOk) log('gfx', `render worker unavailable here (${m.opts.interp ? 'reference interpreter: no shared memory' : 'needs cross-origin isolation and shared memory'}): rendering in this thread`);
  const threadBackend = () => { try { const g = createWebGLBackend(canvasGl, (msg) => log('gfx', msg), dump); if (!g) log('warn', 'WebGL2 unavailable: Direct3D will run without rendering'); return g; } catch (e) { log('warn', `WebGL2 init failed: ${e.message}`); return null; } };
  let renderer = null; // (the render worker's link)
  if (renderWorker) renderer = createRemoteGfx({ log: (msg) => log('gfx', msg), workerUrl: new URL('../../gfx/render-worker.js', import.meta.url), onFail: (reason, recorders) => (remoteGl ? renderInThread(recorders, threadBackend) : log('gfx', 'render compare: stopped (render worker gone)')) });
  if (remoteGl) { host.gfx = renderer; host.remoteGl = true; }
  else if (glMode === 'compare' || glMode === 'compare-worker') {
    // (?dbg=ORTHROS_COMPARE_EVERY=N: compared every N frames)
    try { host.gfx = createCompareGfx(canvasGl, (msg) => log('gfx', msg), dump, { remote: renderer, every: Number(globalThis.ORTHROS_COMPARE_EVERY) || 60 }); log('gfx', `render: frames compared with the recorded work replayed ${renderer ? 'in a render worker' : 'in this thread'} (${glMode})`); } catch (e) { log('warn', `WebGL2 init failed: ${e.message}`); }
  } else if (glMode === 'inline' || glMode === 'check') {
    try { host.gfx = createInlineGfx(canvasGl, (msg) => log('gfx', msg), dump, { check: glMode === 'check' }); log('gfx', `render: Direct3D work recorded and replayed in this thread (${glMode})`); } catch (e) { log('warn', `WebGL2 init failed: ${e.message}`); }
  } else host.gfx = threadBackend();
  // GL programs of earlier sessions, compiled ahead of their first draw (see WebGLDevice.prewarmStep); this session's
  // new ones are sent back a few seconds after they are built (a render worker does both itself)
  const pcache = host.gfx?.programCache;
  if (pcache && m.opts.programCache && !pcache.remote) {
    const url = `/api/programs/${encodeURIComponent(manifestName)}`;
    fetch(url).then((r) => (r.ok ? r.json() : [])).then((list) => {
      if (!Array.isArray(list) || !list.length) return;
      pcache.queue.push(...list);
      log('gfx', `programs: ${list.length} learned from earlier sessions, compiled ahead${pcache.parallel ? ' (parallel compilation)' : ''}`);
    }).catch(() => {});
    // (new builds with their sources; the ids of the learned ones this session used, which the server keeps)
    programSink = (list, used) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ programs: list, used }) }).catch(() => {});
  }
  if (!m.opts.headless || m.opts.lan) connectLan(host, manifestName); // (the virtual LAN: every player of this game on the server)
  if (m.opts.regionCache) {
    const url = `/api/regions/${encodeURIComponent(manifestName)}`, heatUrl = `/api/heat/${encodeURIComponent(manifestName)}`;
    // (the heat first: the learned regions are translated with it)
    fetch(heatUrl).then((r) => (r.ok ? r.json() : null)).then((o) => {
      if (o && typeof o === 'object') { learnedHeat = new LearnedHeat(o); heatModules = 0; let n = 0; for (const l of Object.values(o)) n += Array.isArray(l) ? l.length / 2 : 0; if (n) log('file', `heat: ${n} code ranges learned from earlier sessions (${Object.keys(o).length} modules)`); }
    }).catch(() => {}).finally(() => {
      fetch(url).then((r) => (r.ok ? r.json() : [])).then((list) => { if (Array.isArray(list) && list.length) { regionQueue = list; log('file', `regions: ${list.length} learned from earlier sessions, translated ${bgTranslator ? 'ahead in a background worker' : 'while the game waits'}`); } }).catch(() => {});
    });
    heatSink = (body) => fetch(heatUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {}); // (body: JSON { heat: [[module, offset, length], ...] })
    regionSink = (list, covered) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regions: list, covered }) }).catch(() => {});
  }
  // VFS: system dirs in memory, game folder over HTTP, profile in memory (mirrored to OPFS)
  const vfs = new Vfs();
  const root = new MemBackend();
  vfs.mount('C:\\', root);
  for (const d of ['Windows', 'Windows/System32', 'Windows/Temp', 'Users', 'Users/Player', 'Program Files', 'Program Files/Common Files', 'Game']) root.mkdir(d);
  // game files over HTTP, kept in a persistent OPFS block store (pages; headless runs with a persistent profile, --opfs);
  // the games the manifest requires (mounted beside it) the same way: their own store, learned prefetch and read logs,
  // and one connection shared with the game's folder (the game's reads through either come first, see HttpBackend.link)
  const link = new Set();
  netLink = new NetLink({ bw: Number(m.opts.netBw) || undefined }); // (the rate this browser measured last time, until measured)
  const mountFiles = async (name, tree, primary) => {
    let store = !m.opts.headless || m.opts.opfs ? await OpfsBlockStore.open('orthros-files-' + name) : null;
    if (!store && m.opts.memPrefetch) store = new MemBlockStore((primary ? 1536 : 1024) * 1048576); // (harness: prefetch measured without a persistent profile)
    const tag = primary ? '' : ` (${name})`;
    if (store) log('file', `block store${tag}: ${store.map.size} blocks (${Math.round((store.end ?? store.bytes ?? 0) / 1048576)} MiB) from earlier runs${store.resetReason ? ` (emptied: ${store.resetReason})` : ''}`);
    if (store) fileStores.push(store);
    if (store) store.onCorrupt = (key) => { if ((store.stats.corrupt ?? 0) <= 20) log('warn', `block store${tag}: a stored block did not read back as written, fetched again: ${key}`); };
    const pf = primary ? prefetch : { bytes: 0, blocks: 0, total: 0, done: false }, rank = new Map();
    const files = new HttpBackend(`/game/${name}/`, tree, { cacheBlocks: m.opts.cacheBlocks ?? 256, store, encoded: !!m.opts.encodedRanges, session: m.opts.session ?? '', link, net: netLink,
      onFetch: m.opts.netLog ? (f) => log('net', `t=${(performance.now() / 1000).toFixed(1)}s ${f.async ? 'parked' : 'sync'} ${primary ? '' : name + ':'}${f.path} [${f.start}, ${f.end}) ${Math.round(f.ms)}ms; learned rank ${rank.get(`${f.path}#${Math.floor(f.start / BLOCK)}`) ?? '-'}, prefetch at ${pf.k ?? '-'}`) : null,
      onRetry: (r) => log('warn', `game file read: ${r.problem} for ${r.url} [${r.start}, ${r.end}), attempt ${r.attempt + 1}`) });
    // learned prefetch: the blocks earlier sessions read, in the order they needed them, downloaded in the background
    if (store && m.opts.prefetch && !m.opts.offline) {
      fetch(`/api/prefetch/${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : [])).then((list) => {
        pf.total = list.length; pf.t0 = performance.now();
        if (m.opts.netLog) list.forEach(([p, b], i) => rank.set(`${p}#${b}`, i));
        if (list.length) log('file', `prefetch${tag}: ${list.length} blocks learned from earlier sessions`);
        return files.prefetch(list, pf, () => stopped).then(() => log('file', `prefetch${tag}: ${pf.done ? 'done' : 'stopped'}, ${pf.blocks} blocks (${Math.round(pf.bytes / 1048576)} MB) downloaded in ${((performance.now() - pf.t0) / 1000).toFixed(0)} s; store writes ${Math.round(store.stats.putMs ?? 0)} ms (${store.stats.flushes ?? 0} index flushes, ${Math.round(store.stats.flushMs ?? 0)} ms)`));
      }).catch(() => {});
    }
    // offline copy (opt-in): the whole folder into the block store, in the background while the game runs
    if (store && m.opts.offline) {
      const progress = primary ? offline : { bytes: 0, total: 0, done: false };
      if (!primary) offlineDependencies.push(progress);
      files.downloadAll(progress, () => stopped).then(() => log('file', `offline copy${tag}: ${progress.done ? 'complete' : 'stopped'} (${Math.round(progress.bytes / 1048576)} MiB of ${Math.round(progress.total / 1048576)})`));
    }
    return { files, store };
  };
  const main = await mountFiles(manifestName, m.tree, true);
  gameStore = main.store; gameFilesStats = main.files.stats; primaryFiles = main.files;
  const aliases = manifest.languageFileAliases?.[m.opts.gameLanguage];
  const gameFiles = aliases ? new FileAliasBackend(main.files, aliases) : main.files;
  vfs.mount(manifest.mount, gameFiles);
  mountGameCdrom(vfs, manifest, gameFiles);
  for (const dependency of manifest.extraMounts ?? []) {
    root.mkdir(dependency.mount.replace(/^C:\\/, ''));
    const treeResponse = await fetch(`/api/tree/${encodeURIComponent(dependency.manifest)}`);
    if (!treeResponse.ok) throw new Error(`dependency ${dependency.manifest}: HTTP ${treeResponse.status}`);
    const dep = await mountFiles(dependency.manifest, await treeResponse.json(), false);
    vfs.mount(dependency.mount, dep.files);
    (extraFilesStats ??= []).push(dep.files.stats);
  }
  profile = new MemBackend();
  for (const d of PROFILE_DIRS) profile.mkdir(d);
  if (!m.opts.headless || m.opts.opfs) await loadProfile(profile);
  // a harness-provided profile (headless runs: `--profile-dir`), base64 files with '/'-separated paths
  for (const f of m.opts.profileFiles ?? []) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) profile.mkdir(parts.slice(0, i).join('/'));
    profile.open(f.path, { create: true }).write(0, Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0)));
  }
  // (a profile still empty here: the game's first launch on this browser — the files a first session of this game
  // wrote, as the server learned them, are put in place: the game skips its first-launch work; else this session's are
  // learned. Manifest compat flag "profileSeed": false, ?profileseed=0: off)
  if (m.opts.profileSeed && manifest.profileSeed !== false && profile.files.size === 0) await seedProfile(m.opts.gameLanguage ?? '', m.opts.session ?? '');
  vfs.mount('C:\\Users\\Player', profile);
  audioMixDirect = m.opts.audioMix !== 'worker';
  const bgWanted = !m.opts.interp && m.opts.bgTranslate !== false && typeof Worker !== 'undefined' && globalThis.crossOriginIsolated;
  vm = new Vm({ vfs, clock, host, jit: !m.opts.interp, sharedMemory: bgWanted || renderWorker, logKinds: m.opts.log ?? ['loader', 'warn', 'crash', 'win', 'thread', 'gfx', 'audio', 'input'], log: log, apiHist: true });
  // (a ReadFile whose data is still on the network parks its thread while the fetch runs: the other threads and the
  // page go on; ?asyncreads=0 restores the synchronous reads)
  vm.asyncReads = m.opts.asyncReads !== false;
  vm.onStdout = (s) => post({ type: 'stdout', text: s });
  if (renderer) { // (the render worker: guest memory shared, frames to the page through a port of their own)
    const ch = new MessageChannel(), globals = {};
    for (const k of Object.keys(globalThis)) if (k.startsWith('ORTHROS_') && (typeof globalThis[k] !== 'object' || globalThis[k] === null)) globals[k] = globalThis[k];
    post({ type: 'gl-port', port: ch.port1 }, [ch.port1]);
    await renderer.start(vm.mem.memory, { width: manifest.display.width, height: manifest.display.height, globals, programs: m.opts.programCache && remoteGl ? `/api/programs/${encodeURIComponent(manifestName)}` : null, compareEvery: remoteGl ? 0 : Number(globalThis.ORTHROS_COMPARE_EVERY) || 60, noPresent: !remoteGl }, ch.port2);
  }
  if (regionSink && vm.jit) { vm.jit.learned = []; vm.jit.coveredLearned = []; } // (coveredLearned: learned entries found to be blocks of other learned regions, see Jit.bgInstallNow)
  // visit flags in the translations (the heat sent back; ?dbg=ORTHROS_JIT_VISIT=0: off)
  if (heatSink && vm.jit && vm.jit.opts.visit === undefined && !vm.jit.opts.blockCounts) vm.jit.opts.visit = globalThis.ORTHROS_JIT_VISIT === undefined ? true : !!Number(globalThis.ORTHROS_JIT_VISIT);
  // learned regions translated in a worker of their own (another core) while the game runs; ?bgjit=0: off (then only
  // while the game waits, on this thread)
  if (vm.jit && bgWanted) {
    try {
      bgTranslator = new Worker(new URL('../../cpu/jit/bg-translate.js', import.meta.url), { type: 'module' });
      bgTranslator.onmessage = (e) => { if (e.data?.type === 'batch') { vm.jit.bgInstall(e.data); feedBackground(); } else if (e.data?.type === 'cache-error') log('warn', `translated code cache unavailable: ${e.data.message}`); else if (e.data?.type === 'cache-stats' && vm.jit.bg) vm.jit.bg.cache = e.data.cache; };
      bgTranslator.onerror = (e) => { log('warn', `background translation unavailable: ${e.message ?? e}`); bgTranslator = null; };
      // (translations kept across sessions in OPFS, keyed by the translator's own sources: ?codecache=0, off)
      const jitUrl = (f) => new URL(`../../cpu/jit/${f}`, import.meta.url).href;
      vm.jit.attachBackground(bgTranslator, codeCacheOn(m.opts) ? { name: manifestName, sources: [jitUrl('bg-translate.js'), jitUrl('jit.js'), jitUrl('runtime.js')] } : null);
      // cold tier (Jit.runCold): new code interpreted while the background worker translates it (?dbg=ORTHROS_COLD_TIER=0|1)
      vm.jit.coldTier = !!(globalThis.ORTHROS_COLD_TIER ?? COLD_TIER_DEFAULT);
    } catch (e) { bgTranslator = null; log('warn', `background translation unavailable: ${e.message}`); }
  }
  // D3DX's DXT encoding of large images split with helper workers (other cores; the same bytes as on one thread);
  // ?dxthelpers=N sets their number (0: none)
  const dxtHelpers = m.opts.dxtHelpers ?? Math.max(0, Math.min(4, (navigator.hardwareConcurrency || 2) - 2));
  if (dxtHelpers > 0 && typeof Worker !== 'undefined' && globalThis.crossOriginIsolated) {
    try {
      const pool = new DxtPool(dxtHelpers, () => { const w = new Worker(new URL('../../win32/dxt-helper.js', import.meta.url), { type: 'module' }); w.onerror = (e) => log('warn', `dxt helper: ${e.message ?? e}`); return w; }, (t) => log('warn', t));
      setDxtEncoder((fmt, rgba, w, h) => pool.encode(fmt, rgba, w, h));
      host.dxtPool = pool;
    } catch (e) { log('warn', `parallel DXT encoding unavailable: ${e.message}`); }
  }
  // slow-frame diagnostics: what happened during a frame longer than 33 ms (deltas since the previous frame)
  host.frameProbe = () => ({ t: performance.now(), api: vm.apiCalls, slices: vm.slices, translateMs: vm.jit?.stats.translateMs ?? 0, regions: vm.jit?.stats.regions ?? 0, consolidations: vm.jit?.stats.consolidations ?? 0, fallbacks: vm.jit?.stats.fallbackSteps ?? 0, uploads: host.gfx?.device?.stats?.uploads ?? 0, uploadKB: Math.round((host.gfx?.device?.stats?.uploadBytes ?? 0) / 1024), texMs: Math.round(host.gfx?.device?.stats?.texMs ?? 0), draws: vm.d3dDevice?.draws ?? 0, audioMs: host.audioMs ?? 0, threads: vm.proc.threads.length, ioReq: netStat('requests'), ioMs: Math.round(netStat('ms')), ioKB: Math.round(netStat('bytes') / 1024), idleMs: Math.round(pumpIdleMs + (host.waitMs ?? 0)), idleParts: takeIdleParts(), heldMs: Math.round(vm.wm?.heldMs ?? 0), programMs: Math.round(host.gfx?.device?.stats?.programMs ?? 0), apiMs: Math.round(vm.apiTimeTotal ?? 0), topApis: vm.apiTimes ? takeTopApis() : '', mainWaits: vm.mainWaits ? takeMainWaits() : '', gpuWaitMs: Math.round(host.gfx?.link?.stats.gpuWaitMs ?? 0) });
  host.slowFrameFrom = (m.opts.slowFrom ?? 0) * 1000;
  if (m.opts.headless) { longWaitMin = 150; vm.waitLogMin = 80; vm.mainWaits = new Map(); }
  if (m.opts.apiTimes) { vm.apiTimes = new Map(); vm.apiTimesPhase = new Map(); } // (harness --api-times: a clock read per API call, garbage included) // (harness: waits of 150 ms and more reported too) // (harness runs: per-frame API time in the slow-frame lines)
  host.onSlowFrame = (dt, d) => {
    // (a frame mostly spent waiting: what the game waited for)
    const nw = vm.nestedWaitLog ? [...vm.nestedWaitLog].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v.toFixed(0)}ms`).join(', ') : ''; vm.nestedWaitLog?.clear();
    if (d.idleMs > 150 && (idleFrameLogs = (idleFrameLogs ?? 0) + 1) <= 10) log('hang', `a ${dt.toFixed(0)} ms frame spent ${d.idleMs} ms waiting; idle: ${d.idleParts}; nested waits by thread and reason (since the last slow frame): ${nw || '-'}; the main thread's waits in the frame: ${d.mainWaits}; its last API calls:\n  ${vm.recentApiCalls(40, vm.proc.threads[0]?.id).join('\n  ')}\n${vm.threadsReport().split('\nsync objects')[0]}`);
    const fc = host.lastCats ? catsObject(host.lastCats, 0.5, 8) : null; // (the frame's time by category: frame-acct.js)
    log('slowframe', `t=${(performance.now() / 1000).toFixed(1)}s ${dt.toFixed(1)}ms${fc ? ` [${Object.entries(fc).map(([k, v]) => `${k} ${v}`).join(', ')}]` : ''}: api ${d.api} slices ${d.slices} draws ${d.draws} jit ${d.translateMs}ms/${d.regions}r/${d.consolidations}c fb ${d.fallbacks} tex ${d.uploads}/${d.uploadKB}KB/${d.texMs}ms present ${d.presentMs}ms audio ${d.audioMs}ms io ${d.ioReq}/${d.ioKB}KB/${d.ioMs}ms idle ${d.idleMs}ms held ${d.heldMs}ms programs ${d.programMs}ms${d.gpuWaitMs ? ` render waits ${d.gpuWaitMs}ms` : ''} api ${d.apiMs}ms [${d.topApis}]${d.idleMs >= 10 ? ` — idle: ${d.idleParts}; main thread waits: ${d.mainWaits}` : ''}`);
  };
  vm.registry = new Registry(); vm.registry.seed(manifest.registry);
  if (profile.files.has('registry.json')) { try { vm.registry.load(JSON.parse(new TextDecoder().decode(profile.open('registry.json').read(0, profile.stat('registry.json').size)))); } catch (e) { log('warn', `bad registry.json: ${e.message}`); } }
  // The player's pre-launch choice wins over settings saved by an earlier run of this version.
  if (manifest.languageRegistryKey && ['en', 'fr'].includes(m.opts.gameLanguage) && manifest.languages?.includes(m.opts.gameLanguage)) {
    vm.registry.setString(manifest.languageRegistryKey, 'Language', m.opts.gameLanguage === 'fr' ? 'French' : 'English');
  }
  const exePath = normalizeWin(manifest.mount + '\\' + manifest.exe);
  // (a snapshot of this game's machine, docs/snapshot.md: it goes on from there instead of starting)
  if (m.snapshot) {
    const t0 = performance.now();
    try { restoreVm(vm, decodeSnapshot(new Uint8Array(m.snapshot))); }
    catch (e) { post({ type: 'snapshot-failed', error: String(e.stack || e) }); return; }
    log('loader', `restored from a snapshot of ${(m.snapshot.byteLength / 1048576).toFixed(1)} MiB in ${(performance.now() - t0).toFixed(0)} ms`);
  } else try {
    vm.createProcess({ exePath, args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides, cwd: manifest.cwd ? normalizeWin(manifest.mount + '\\' + manifest.cwd) : undefined });
  } catch (e) { post({ type: 'crash', report: e instanceof GuestCrash ? e.report : String(e.stack || e) }); return; }
  running = true;
  // the options this session runs with, as decided here (perf telemetry: a measurement is read with them)
  post({ type: 'perf-options', options: { glWorker: glMode, renderWorker: !!remoteGl, asyncReads: vm.asyncReads, bgTranslate: !!bgTranslator, dxtHelpers: host.dxtPool ? dxtHelpers : 0, audioMix: audioMixDirect ? 'worklet' : 'worker', timeScale: m.opts.timeScale || 1, interp: !!m.opts.interp, programCache: !!m.opts.programCache, regionCache: !!m.opts.regionCache, codeCache: !!vm.jit?.bg && codeCacheOn(m.opts), profileSeeded, prefetch: !!m.opts.prefetch, encodedRanges: !!m.opts.encodedRanges, offline: !!m.opts.offline, parallelCompile: !!host.gfx?.programCache?.parallel, jitOpts: m.opts.jitOpts || '', dbg: m.opts.dbg || '', cores: navigator.hardwareConcurrency ?? null, display: `${manifest.display.width}x${manifest.display.height}` } });
  if (seedWatch) host.onUserInput = (typed) => seedWatch?.input(performance.now(), host.framesPresented, typed);
  post({ type: 'started', profile: profileListing.slice(0, 200), firstLaunch: !m.opts.headless && profileFilesRestored === 0 && !profileSeeded && !(m.opts.profileFiles?.length) });
  channel.port1.onmessage = () => { pumpPosted = false; pump(); };
  host.wake = () => { if (running && !stopped) schedulePump(0); }; // (an asynchronous completion a guest thread waits on)
  pump();
}

/**
 * The connection as the page shows it (docs/slow-network.md): the measured rate, what came, whether the game waits
 * for the network now, and the bytes of the game's current step still to come (from the learned order, see
 * HttpBackend.stepEstimate).
 */
function netInfo() {
  if (!netLink) return null;
  const n = netLink.snapshot();
  n.waiting = (vm?.readsInFlight ?? 0) > 0 || !!vm?.frameThreadWaitsForRead?.() || n.demandInFlight > 0;
  n.ratio = Math.round(netLink.ratio() * 100) / 100;
  const step = n.waiting ? primaryFiles?.stepEstimate() : null; // (only while the game waits: the page shows it then)
  if (step) { n.stepBytes = step.bytes; n.stepWire = Math.round(step.bytes * netLink.ratio()); }
  return n;
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
let markPrev = null;
function takeTopApis() { const top = [...vm.apiTimes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '); vm.apiTimes.clear(); return top; }
/**
 * The APIs that took the most time since the previous call (phase marks): each API's timed calls (frame-acct.js
 * samples them) scaled to all its calls.
 */
let apiPhasePrev = null;
function apiPhaseTop() {
  const cur = { ms: Float64Array.from(acct.idxMs), n: Float64Array.from(acct.idxN), calls: Float64Array.from(acct.idxCalls) }, prev = apiPhasePrev; apiPhasePrev = cur;
  const out = [];
  for (let i = 0; i < cur.calls.length; i++) {
    const calls = cur.calls[i] - (prev?.calls[i] ?? 0), n = (cur.n[i] ?? 0) - (prev?.n[i] ?? 0), ms = (cur.ms[i] ?? 0) - (prev?.ms[i] ?? 0);
    if (calls > 0 && n > 0) out.push([i, ms * Math.max(1, calls / n), calls]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 12).map(([i, ms, calls]) => { const t = vm.api.thunk(i); return `${t ? t.name : i} ${ms.toFixed(0)} (${calls})`; }).join(', ');
}
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
/**
 * Frame accounting of the time between two pumps (frame-acct.js): the worker sleeps until the next wake-up the guest
 * threads asked for (`sleep`, the game's pacing — or `ioWait` when what they wait for is a file read on the network);
 * coming back later than planned is `late` (timer clamping, garbage collection, the event loop's other tasks).
 */
const gap = { cat: -1, planned: 0, at: 0, acc0: 0 };
/** the JIT's cold tier (Jit.runCold) with a background translator */
const COLD_TIER_DEFAULT = true;
function gapBegin(r) {
  let cat = ACCT.late, planned = 0;
  if (r.state === 'sleep' || r.state === 'idle') {
    planned = r.state === 'idle' ? 30 : Math.max(0, r.until - performance.now());
    // (the thread presenting frames waits for a file read, or a read is on the network and no guest timer is due soon:
    // the threads wait for the read)
    cat = vm.frameThreadWaitsForRead() || (vm.readsInFlight > 0 && (r.state === 'idle' || planned > 50)) ? ACCT.ioWait : ACCT.sleep;
  }
  acct.enter(cat);
  gap.cat = cat; gap.planned = planned; gap.at = acct.at; gap.acc0 = acct.acc[cat];
}
function gapEnd() {
  acct.enter(ACCT.host);
  if (gap.cat < 0) return;
  const over = acct.at - gap.at - gap.planned;
  if (over > 0 && gap.cat !== ACCT.late) acct.move(gap.cat, ACCT.late, Math.min(over, acct.acc[gap.cat] - gap.acc0));
  gap.cat = -1;
}
/**
 * The visit flags harvested for the server's heat (Jit.harvestVisitsStep), in steps of about `budgetMs`: a harvest
 * pass every 10 s cut into steps, then its blocks mapped to module + offset and posted in pieces (the server merges
 * them), one per step — a whole pass at once was a 15-50 ms stall every 10 s, its post alone 5-20 ms for 20-40 k
 * blocks. The steps run while the guest waits (heatSlack: every thread asleep until a wake-up, or a nested wait in an
 * API — BrowserHost.waitEvent —: time frames do not wait for), or after the slice when no such wait came for a
 * second (heatDue).
 * (timing: the longest step of each kind of the pass, logged with it)
 */
const heatPost = { pairs: null, at: 0, n: 0, posts: 0, passAt: 0, lastAt: 0, dueAt: 0, mod: null, steps: 0, slack: 0, max: { harvest: 0, end: 0, map: 0 } };
const heatWork = (now) => heatSink && vm.jit?.opts.visit && (heatPost.pairs || vm.jit.harvestAt > 0 || now - heatPost.passAt >= 10000);
/** a step after the slice: work pending and no wait used for it for a second */
function heatDue(now) {
  const h = heatPost;
  if (!heatWork(now)) { h.dueAt = 0; return; }
  if (!h.dueAt) h.dueAt = now;
  if (now - Math.max(h.dueAt, h.lastAt) > 1000) heatStep(now, 1);
}
/** a step in a wait of the guest threads (`ms` before the next wake-up) */
function heatSlack(ms) { const now = performance.now(); if (ms >= 1 && heatWork(now)) { heatPost.slack++; heatStep(now, Math.min(1, 0.6 * ms)); } }
function heatStep(now, budgetMs) {
  const t0 = performance.now(), h = heatPost;
  h.lastAt = t0;
  let kind;
  if (!h.pairs && (vm.jit.harvestAt > 0 || now - h.passAt >= 10000)) {
    if (!vm.jit.harvestAt) h.passAt = now;
    h.pairs = vm.jit.harvestVisitsStep(budgetMs); h.at = 0; h.mod = null; h.steps++;
    kind = h.pairs ? 'end' : 'harvest';
  } else if (h.pairs) {
    kind = 'map';
    const pairs = h.pairs, out = [];
    let i = h.at;
    for (; i < pairs.length; i += 2) {
      if ((i & 127) === 0 && i > h.at && performance.now() - t0 >= budgetMs / 2) break;
      const a = pairs[i];
      let mod = h.mod;
      if (!mod || a < mod.base || a >= mod.base + mod.size) mod = h.mod = vm.proc.moduleByAddr(a);
      if (mod && pairs[i + 1] <= mod.base + mod.size) out.push(`[${JSON.stringify(mod.name.toLowerCase())},${a - mod.base},${pairs[i + 1] - a}]`);
    }
    h.at = i;
    if (out.length) { heatSink(`{"heat":[${out.join(',')}]}`); h.n += out.length; h.posts++; }
    if (i >= pairs.length) {
      h.pairs = null;
      const dt = performance.now() - t0; if (dt > h.max.map) h.max.map = dt;
      const m = h.max;
      if (h.n) log('jit', `heat: ${h.n} blocks posted in ${h.posts} requests (pass in ${h.steps} steps, ${h.slack} of all in waits; longest step: harvest ${m.harvest.toFixed(2)} ms, pass end ${m.end.toFixed(2)} ms, mapping and post ${m.map.toFixed(2)} ms; ${vm.jit.visitRegions.length} regions with flags left)`);
      h.n = h.posts = h.steps = h.slack = 0; h.max = { harvest: 0, end: 0, map: 0 };
      return;
    }
  }
  if (kind) { const dt = performance.now() - t0; if (dt > h.max[kind]) h.max[kind] = dt; }
}
/** The page asked for a snapshot (docs/snapshot.md): taken now — between two runs — and sent as bytes, or every field it refused. */
function takeSnapshot() {
  const id = snapshotWanted; snapshotWanted = null;
  const t0 = performance.now(), problems = [];
  try {
    const s = captureVm(vm, { manifest: manifestName, at: vm.clock.now() }, problems);
    if (problems.length) { post({ type: 'snapshot', id, problems }); return; }
    const bytes = encodeSnapshot(s);
    post({ type: 'snapshot', id, bytes: bytes.buffer, ms: performance.now() - t0, objects: s.graph.objects.length, pages: s.pages.index.length }, [bytes.buffer]);
  } catch (e) { post({ type: 'snapshot', id, error: String(e.message ?? e) }); }
}
function pump() {
  if (!running || stopped) return;
  gapEnd();
  if (learnedHeat && vm?.jit && vm.proc && vm.proc.moduleList.length !== heatModules) { heatModules = vm.proc.moduleList.length; vm.jit.heatAdd(learnedHeat.apply(vm.proc.moduleList)); }
  if (bgTranslator && regionQueue) feedBackground();
  if (pumpEndAt) { const g = performance.now() - pumpEndAt; pumpIdleMs += g; pumpGaps++; if (g > pumpGapMax) pumpGapMax = g; }
  if (Atomics.load(host.ctl, CTL.STOP)) { stop('stopped'); return; }
  // (debugging, --dbg ORTHROS_BG_FIRST=1: the guest waits until the learned regions of the loaded modules are installed —
  // the background translation as a very fast machine has it)
  if (globalThis.ORTHROS_BG_FIRST && bgTranslator && regionQueue && vm?.jit && (regionPos < regionQueue.length || vm.jit.bgPending())) { schedulePump(5); return; }
  let r;
  if (host.gfx?.beforeSlice) { acct.enter(ACCT.prog); host.gfx.beforeSlice(2); acct.enter(ACCT.host); } // (GL programs compiled ahead, resolved when the GPU process has caught up: see createWebGLBackend)
  acct.enter(ACCT.guest);
  const tRun = acct.stamp();
  // a slice that does not come back within a second (guest code run from a nested call — DllMain, a callback — is
  // not cut into slices): what runs, logged each second meanwhile (the page shows no new frame then)
  vm.progressEvery = 1000; vm.progressAt = tRun + 1000;
  vm.onProgress ??= (t) => { if ((longSliceLogs = (longSliceLogs ?? 0) + 1) <= 40) log('hang', `worker busy for ${((performance.now() - longSliceStart) / 1000).toFixed(1)} s in one slice: thread ${t.id}${t.callbackDepth ? ` (nested call depth ${t.callbackDepth})` : ''} at ${vm.proc.symbolize(t.cpu.eip)}, VM depth ${vm.depth}; last API calls: ${vm.recentApiCalls(6, t.id).join(', ')}`); };
  longSliceStart = tRun;
  try {
    // (a file read on the network: short slices, so the read's completion — several event-loop tasks for one fetch —
    // is not held behind a 12 ms slice at each step; --dbg ORTHROS_READ_SLICE_MS=12 is the earlier behaviour)
    vm.readSliceMs = globalThis.ORTHROS_READ_SLICE_MS ?? 2;
    r = vm.runFor(tRun + (vm.readsInFlight > 0 ? vm.readSliceMs : 12));
    acct.enter(ACCT.host);
    if (vm.jit?.coldQueue.length) vm.jit.flushCold(); // (the cold tier's entries to the background translator)
  } catch (e) {
    acct.enter(ACCT.host);
    running = false;
    let report = e instanceof GuestCrash ? e.report : String(e.stack || e);
    // (an emulator error: the guest's state with it — threads, recent API calls — for the crash telemetry)
    if (!(e instanceof GuestCrash)) { try { report += '\n\n' + vm.crashReport(vm.current ?? vm.proc.threads[0], 'emulator error'); } catch { /* best effort */ } }
    post({ type: 'crash', report });
    flushProfile(true);
    return;
  }
  // the DirectSound buffers mixed by the page's AudioWorklet (guest memory shared): the voice table handed over once
  // DirectSound exists; until the worklet uses it (no audio output yet, ?audiomix=worker) the ring path below goes on
  if (vm.audio && !vm.audio.voices && audioMixDirect && vm.jit?.shared) { const sab = new SharedArrayBuffer(VOICE_TABLE_BYTES); vm.audio.attachVoices(sab); post({ type: 'audio-voices', memory: vm.mem.memory.buffer, voices: sab }); }
  acct.enter(ACCT.audio); host.renderAudio(vm); acct.enter(ACCT.host);
  if (snapshotWanted !== null && !vm.readsInFlight) takeSnapshot();
  host.audioHook ??= () => { const p = acct.enter(ACCT.audio); host.renderAudio(vm); acct.leave(p); };
  host.idleWork ??= heatSlack; // (a nested wait of the guest: the heat harvest's steps, see heatSlack)
  const now = acct.stamp();
  pumpStats.runs++; pumpStats.runMs += now - tRun;
  if (programSink && (host.gfx.programCache.learned.length || host.gfx.programCache.used.length) && now - programsPostedAt > 5000) { programsPostedAt = now; programSink(host.gfx.programCache.learned.splice(0), host.gfx.programCache.used.splice(0)); }
  if (regionSink && (vm.jit?.learned?.length || vm.jit?.coveredLearned?.length) && now - regionsPostedAt > 10000) {
    regionsPostedAt = now;
    const list = [], covered = [];
    for (const [eip, fpc, t] of vm.jit.learned.splice(0)) { const mod = vm.proc.moduleByAddr(eip); if (mod) list.push([mod.name.toLowerCase(), eip - mod.base, fpc, t]); }
    for (const [eip, fpc] of vm.jit.coveredLearned.splice(0)) { const mod = vm.proc.moduleByAddr(eip); if (mod) covered.push([mod.name.toLowerCase(), eip - mod.base, fpc]); }
    if (list.length || covered.length) regionSink(list, covered);
  }
  heatDue(now);
  if (now - statsAt > 500) {
    const dt = (now - statsAt) / 1000; statsAt = now;
    const hist = vm.apiHist();
    const ft = host.frameTimes.slice().sort((a, b) => a - b);
    const p = (q) => (ft.length ? ft[Math.min(ft.length - 1, Math.floor(q * ft.length))] : 0);
    const iv = host.interval ?? { max: 0, slow33: 0, slow50: 0 }; host.interval = { max: 0, slow33: 0, slow50: 0 };
    // time the game waited on the network for its files since the last report (synchronous range requests: nothing runs meanwhile)
    const allMs = netStat('ms'), allReq = netStat('requests');
    const netMs = allMs - lastNetMs, netReq = allReq - lastNetReq; lastNetMs = allMs; lastNetReq = allReq;
    const pc = host?.gfx?.programCache;
    // (loading progress for the page's loading screen: the learned downloads, translations and program builds done ahead)
    const load = { pfDone: prefetch.blocks, pfTotal: prefetch.total, pfFinished: prefetch.done || (prefetch.total > 0 && prefetch.blocks >= prefetch.total), pfMB: Math.round(prefetch.bytes / 1048576),
      rgDone: regionQueue ? regionPos : 0, rgTotal: regionQueue ? regionQueue.length : 0, pgDone: pc ? pc.started : 0, pgTotal: pc ? pc.started + pc.queue.length : 0 };
    const fa = host.frameAcct.takeInterval(); if (fa) fa.heavy = acct.heavyApis; // (frame accounting of the interval: frame-acct.js)
    post({ type: 'stats', acct: fa, load, net: netInfo(), dt, render: host.remoteGl ? 'worker' : host.gfx ? (host.gfx.mode ?? 'thread') : 'none', busy: Math.round(pumpStats.runMs / dt / 10), jitMs: Math.round((vm.jit?.stats.translateMs ?? 0) - (vm.jit?.stats.prewarmMs ?? 0)), netMs: Math.round(netMs), netReq, frameMax: iv.max, slow33: iv.slow33, slow50: iv.slow50, ioMB: Math.round((gameFilesStats?.bytes ?? 0) / 1048576), offlineMB: Math.round((offline.bytes + offlineDependencies.reduce((n, d) => n + d.bytes, 0)) / 1048576), prefetchMB: Math.round((prefetch.bytes ?? 0) / 1048576), offlineTotalMB: Math.round((offline.total + offlineDependencies.reduce((n, d) => n + d.total, 0)) / 1048576), apiPerSec: (vm.apiCalls - lastApi) / dt, mips: (vm.slices - lastSlices) * 0.1 / dt, fps: (host.framesPresented - lastFrames) / dt, frameP50: p(0.5), frameP99: p(0.99), regions: vm.jit?.stats.regions ?? 0, threads: vm.proc.threads.length, frames: host.framesPresented, videoFrames: host.display.videoFrames, firstD3D: vm.firstD3DCall?.name ?? null, d3d: vm.d3dDevice ? { frames: vm.d3dDevice.frames, draws: vm.d3dDevice.draws, w: vm.d3dDevice.pp.width, h: vm.d3dDevice.pp.height, programs: vm.d3dDevice.gfx?.stats.programs ?? 0, vaos: vm.d3dDevice.gfx?.stats.vaos ?? 0, programMs: Math.round(vm.d3dDevice.gfx?.stats.programMs ?? 0), programTakeMs: Math.round(vm.d3dDevice.gfx?.stats.prewarmTakeMs ?? 0), gpu: vm.d3dDevice.gfx?.stats.gpu ?? null, glCalls: vm.d3dDevice.gfx?.stats.glCalls ?? null } : null, unknownImports: vm.proc.unknownImports.size, gl: host.gfx?.stats?.() ?? null, fallbacksPerSec: ((vm.jit?.stats.fallbackSteps ?? 0) - lastFallbacks) / dt, pump: `${Math.round(pumpStats.runs / dt)} slices/s busy ${Math.round(pumpStats.runMs / dt / 10)}% sleeps ${Math.round(pumpStats.sleeps / dt)}/s avg ${(pumpStats.sleepMs / Math.max(1, pumpStats.sleeps)).toFixed(1)}ms idles ${Math.round(pumpStats.idles / dt)}/s threads ${threadTimes(dt)}`, topFallback: vm.jit?.fallbackHist ? [...vm.jit.fallbackHist].map(([k, v]) => [k, v - (lastFbHist.get(k) ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${OP_NAMES[k] ?? k}=${Math.round(v / dt)}`).join(' ') : '', audioBuffers: vm.audio?.buffers.size ?? 0, audioPlaying: audioPlaying(vm.audio), audioMix: !vm.audio ? null : vm.audio.worklet ? 'worklet' : 'worker', audioDecodeFailures: audioDecodeStats.failures, audioPeak: host.audioPeak ?? 0, audioMs: (host.audioMs ?? 0) / dt, audioFrames: (host.audioFrames ?? 0) / dt, topApi: hist ? [...hist].map(([k, v]) => [k, v - (lastHist.get(k) ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k.replace(/^(com|kernel32|user32|winmm|gdi32)\.dll!/, '')}=${Math.round(v / dt)}`).join(' ') : '' });
    if (hist) lastHist = hist;
    // (debugging, dbg:ORTHROS_STEP_HIST=1: the instructions translated code leaves to the interpreter, by address, logged
    // with a few samples of the x87 state every 10 s)
    if (globalThis.ORTHROS_STEP_HIST && vm.jit) {
      if (!vm.jit.stepHist) {
        vm.jit.stepHist = new Map(); vm.jit.stepSamples = new Map(); vm.jit.stepHistAt = now;
        vm.jit.stepSample = (cpu) => {
          const a = cpu.eip >>> 0, list = vm.jit.stepSamples.get(a) ?? []; if (list.length >= 3 || Math.random() > 0.01) return;
          let m = null; try { const insn = decode(vm.mem, a); const o = insn.ops.find((x) => x.t === OT.MEM); if (o) { const ea = ((o.base >= 0 ? cpu.reg(o.base) : 0) + (o.index >= 0 ? cpu.reg(o.index) << o.scale : 0) + o.disp) >>> 0; m = o.size === 8 ? vm.mem.readF64(ea) : o.size === 4 ? vm.mem.readF32?.(ea) : null; } } catch { /* best effort */ }
          list.push(`cw=${cpu.fpuCw.toString(16)} st0=${cpu.st(0)} st1=${cpu.st(1)} m=${m}`); vm.jit.stepSamples.set(a, list);
        };
      } else if (now - vm.jit.stepHistAt >= 10000) {
        const top = [...vm.jit.stepHist].sort((x, y) => y[1] - x[1]).slice(0, 10);
        log('jit', `steps in ${((now - vm.jit.stepHistAt) / 1000).toFixed(0)} s: ${[...vm.jit.stepHist.values()].reduce((a, b) => a + b, 0)}${top.map(([a, n]) => { let d = '?'; try { d = fmtInsn(decode(vm.mem, a)); } catch { /* */ } return `\n  ${n} x ${vm.proc.symbolize(a)}  ${d}  ${(vm.jit.stepSamples.get(a) ?? []).join(' | ')}`; }).join('')}`);
        vm.jit.stepHist.clear(); vm.jit.stepSamples.clear(); vm.jit.stepHistAt = now;
      }
    }
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
    if (seedWatch) { const files = seedWatch.step(now, host.framesPresented); if (files || seedWatch.done) { seedWatch = null; host.onUserInput = null; if (files) { log('file', `profile: ${files.length} file(s) this first session wrote reported to the server (shared first-launch profile)`); seedSink(files); } } }
  }
  // (every guest thread waits: learned GL programs started — before afterSlice's fence, which then covers their builds)
  acct.enter(ACCT.prog);
  if (r.state === 'idle' || (r.state === 'sleep' && r.until - performance.now() >= 3)) host.gfx?.prewarm?.();
  host.gfx?.afterSlice?.();
  acct.enter(ACCT.host);
  pumpEndAt = performance.now(); lastPumpReturn = r.state === 'sleep' ? `sleep ${Math.round(r.until - pumpEndAt)}ms` : r.state;
  if (r.state === 'exited') { running = false; post({ type: 'exit', code: r.code, report: vm.exitReport ?? null }); flushProfile(true); return; }
  if (r.state === 'sleep') {
    if (r.until - pumpEndAt >= 3) { acct.enter(ACCT.ahead); prewarmRegions(Math.min(8, r.until - pumpEndAt - 1)); acct.enter(ACCT.host); } // (the wait, used to translate ahead)
    heatSlack(r.until - performance.now());
    const ms = Math.max(0, r.until - performance.now()); pumpStats.sleeps++; pumpStats.sleepMs += ms; schedulePump(Math.max(1, ms));
    // every thread waiting a second or more: what for (a wait Windows would end sooner shows up here)
    if (ms >= (longWaitMin ?? 1000) && (longWaitLogs = (longWaitLogs ?? 0) + 1) <= 20) log('hang', `every thread waits, next wake in ${(ms / 1000).toFixed(1)} s:\n${vm.threadsReport().split('\nsync objects')[0]}`);
  }
  else if (r.state === 'idle') { pumpStats.idles++; acct.enter(ACCT.ahead); prewarmRegions(8); acct.enter(ACCT.host); heatSlack(20); schedulePump(30); }
  else schedulePump(0);
  gapBegin(r);
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
    log('file', `regions: ${bg.installed} translated ahead in the background and installed by t=${(performance.now() / 1000).toFixed(1)}s (${Math.round(bg.bgMs)} ms there, ${Math.round(bg.translateMs)} of them translating, ${Math.round(bg.compileMs)} compiling, ${Math.round(jit.stats.bgInstallMs ?? 0)} ms installing here${bg.cache ? `; translated code cache: ${bg.cacheHits} reused, ${bg.cache.misses} not (${bg.cache.missNew} new, other extent ${bg.cache.missExtent}, other inline-API slots ${bg.cache.missDeps}, other bytes ${bg.cache.missBytes}, other heat ${bg.cache.missHeat ?? 0}), ${bg.cache.added} added, ${bg.cache.superseded ?? 0} superseded, ${bg.cache.evicted ?? 0} evicted, ${bg.cache.loaded} entries read in ${Math.round(bg.cache.loadMs)} ms (session ${bg.cache.session ?? '-'}), ${Math.round(bg.cache.bytes / 1048576)} MiB (${Math.round((bg.cache.dead ?? 0) / 1048576)} unused)${bg.cache.compactions ? `, ${bg.cache.compactions} compaction(s) in ${Math.round(bg.cache.compactMs)} ms` : ''}${bg.cache.reset ? ` (emptied: ${bg.cache.reset})` : ''}` : ''}), ${bg.rejected} dropped (code changed, or translated here first), ${bg.covered} skipped (blocks of regions translated before), ${bg.sent - bg.installed - bg.rejected - bg.covered} not translatable; ${regionQueue.length - bg.sent} entries already translated or without code`);
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
/**
 * WASM listing of the live region holding `eip` (src/cpu/jit/listing.js): the region translated again with its own
 * options (same emitter decisions), per guest instruction, with the block structure and — translations with block
 * counters (?jitopts={"blockCounts":true}) — each block's execution count so far. `ops` false: operation counts only.
 */
function jitList(eip, ops = true) {
  const jit = vm?.jit; if (!jit) return 'no jit';
  const r = jit.regionAt(eip);
  if (!r) return `jitlist ${(eip >>> 0).toString(16)}: no live region holds it`;
  try { return listRegion(vm.mem, r.entry, { ...jit.translateOpts(r.fnIdx, r.fpc), blockCounts: false }, { counts: jit.blockCounts(r), ops }).text; }
  catch (e) { return `jitlist ${(eip >>> 0).toString(16)}: ${e.message}`; }
}
function regionMix(eips, list = 0, wasm = 0) {
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
    if (wasm > 0 && !listed.has(eip)) { wasm--; listed.add(eip); lines.push(jitList(eip).split('\n').map((l) => '  ' + l).join('\n')); continue; } // (--profile-wasm N)
    if (listed.has(eip) || listed.size >= list) continue;
    listed.add(eip); // listing of the hottest regions: which instruction patterns the translation spends its time on
    const counts = vm.jit.blockCounts(r);
    for (const b of [...r.blocks].sort((x, y) => x.eip - y.eip)) {
      lines.push(`  block ${b.eip.toString(16)}${counts ? ` executed ${counts[b.index]}` : ''}`);
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

/**
 * The render worker failed (did not start, died, stopped making progress): every device gets the WebGL backend on
 * this thread, which reads the device itself — resources are uploaded again from guest memory on use, render target
 * contents are lost once (as after a lost context).
 */
function renderInThread(recorders, threadBackend) {
  const d = host.display;
  host.remoteGl = false;
  if (d.canvasGl.width !== d.width || d.canvasGl.height !== d.height) { d.canvasGl.width = d.width; d.canvasGl.height = d.height; }
  const g = threadBackend();
  host.gfx = g;
  for (const r of recorders) {
    const dev = r.dev; r.detach();
    dev.gfx = g ? g.createDevice(dev) : null;
    const ramp = dev.gamma ?? vm?.gammaRamp; if (ramp && dev.gfx) dev.gfx.setGamma(ramp);
  }
  d.glActive = false;
  log('gfx', `render: ${recorders.length} device(s) moved to the in-thread backend`);
}

function stop(reason) { stopped = true; running = false; flushProfile(true); post({ type: 'exit', code: -1, reason }); }

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') start(m).catch((err) => post({ type: 'crash', report: String(err.stack || err) }));
  else if (m.type === 'wake') { if (running && !stopped) schedulePump(0); }
  else if (m.type === 'find') { if (vm) { const pat = Uint8Array.from(m.hex.match(/../g).map((h) => parseInt(h, 16))), u8 = vm.mem.u8, hits = []; const lim = 0x7f000000; for (let a = 0x10000; a < lim && hits.length < 20; a++) { if (u8[a] !== pat[0]) continue; let k = 1; while (k < pat.length && u8[a + k] === pat[k]) k++; if (k === pat.length) { const ctx = Array.from(u8.subarray(a - 48, a + 48), (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''); hits.push(`${a.toString(16)} ${vm.proc.symbolize(a)} |${ctx}|`); } } log('hang', `find ${m.hex}: ${hits.length} hits\n${hits.join('\n')}`); } } // (debugging: harness input find:<hex bytes>)
  else if (m.type === 'dump') { if (vm) log('hang', `memory ${(m.addr >>> 0).toString(16)}+${m.len.toString(16)}: ${Array.from(vm.mem.bytes(m.addr >>> 0, m.len), (b) => b.toString(16).padStart(2, '0')).join('')}`); } // (debugging: harness input `dump:addr,len`)
  else if (m.type === 'watch') { if (vm?.jit) { vm.jit.watchWrites(m.addr >>> 0, m.len || 4, 'ctl', 100000); log('hang', `watching writes to ${(m.addr >>> 0).toString(16)}+${m.len || 4}`); } } // (debugging: harness input `watch:addr,len`, then `unwatch`)
  else if (m.type === 'unwatch') { if (vm?.jit) log('hang', `writes seen (writer: count): ${[...vm.jit.unwatch('ctl')].map(([k, n]) => `${k}: ${n}`).join(', ') || 'none'}`); }
  else if (m.type === 'threads') { if (vm) log('hang', `threads on request:\n${vm.threadsReport()}\n${threadDetails()}`); } // (debugging: harness input `threads`)
  else if (m.type === 'burst') { if (vm) vm.startApiBurst(vm.proc.threads.find((t) => t.id === m.tid) ?? vm.proc.threads[0], m.n ?? 3000, !!m.noGfx); } // (debugging: --log apiburst, harness input burst:N[,tid])
  else if (m.type === 'stop') stop('stop requested');
  else if (m.type === 'snapshot') { snapshotWanted = m.id ?? 0; if (running && !stopped) schedulePump(0); } // (docs/snapshot.md)
  else if (m.type === 'capture') { const d = host?.gfx?.device; if (d) { d.captureAt = d.frame + 1; d.captureDraws = !!m.draws; d.countFrames = m.count ?? 0; log('gfx', `d3d-webgl: ${m.count ? 'GL call count' : 'capture'} requested at frame ${d.frame + 1}`); } }
  else if (m.type === 'regions') post({ type: 'regions', text: vm ? regionMix(m.eips, m.list ?? 0, m.wasm ?? 0) : 'no vm' });
  else if (m.type === 'jitlist') { if (vm) log('jitlist', jitList(parseInt(m.eip, 16), m.ops !== false)); } // (debugging: harness input jitlist:<hex eip>)
  else if (m.type === 'interpRange') { // (debugging: from now on, these code ranges run in the reference interpreter)
    const ranges = String(m.ranges).split(',').map((r) => r.split(':').map((x) => parseInt(x, 16)));
    if (vm?.jit) { vm.jit.opts.interpRanges = ranges; for (const [lo, hi] of ranges) vm.invalidateCode(lo, hi - lo); log('warn', `interpreter ranges on: ${m.ranges}`); }
  }
  else if (m.type === 'loseContext') { // (testing: WebGL context loss and restoration)
    if (host?.gfx?.post) { host.gfx.post(m); return; } // (the render worker's context)
    const ext = host?.gfx?.gl.getExtension('WEBGL_lose_context');
    if (ext) { ext.loseContext(); setTimeout(() => ext.restoreContext(), m.ms ?? 500); } else log('warn', 'WEBGL_lose_context unavailable');
  }
  else if (m.type === 'dbg') { // (harness dbg:NAME=value: a worker debug global changed while the game runs, as --dbg sets them at start; ORTHROS_TRACE_API=1: every API call logged with its result as [api], 2: COM / D3DX calls too)
    const [k, v] = String(m.kv ?? '').split('=');
    if (/^ORTHROS_[A-Z0-9_]+$/.test(k)) { globalThis[k] = v === undefined || v === '' ? undefined : Number.isNaN(Number(v)) ? v : Number(v); log('input', `dbg ${k}=${v ?? ''}`); if (k === 'ORTHROS_API_FAST_OFF') vm?.setApiFastPaths(!globalThis[k]); if (k === 'ORTHROS_TRACE_API' && vm) vm.traceApiRet = Number(globalThis[k] ?? 0); refreshApiOpt(); if (k === 'ORTHROS_D3DX_FAST_OFF' || k === 'ORTHROS_API_OPT_OFF') vm?.jit?.setD3dxFast?.(!globalThis[k]); if (k === 'ORTHROS_COLD_TIER' && vm?.jit?.bg) vm.jit.coldTier = !!globalThis[k]; if (k === 'ORTHROS_JIT_AB' && vm?.jit) vm.jit.switchOpts(v ? JSON.parse(v) : null); if (k === 'ORTHROS_ACCT_OFF') acct.setClock(globalThis[k] ? null : () => performance.now()); host?.gfx?.post?.(m); }
  }
  else if (m.type === 'mark') { // (harness mark:<label>: texture work and API time since the previous mark)
    // guest instructions executed in the phase: the guest category's time per instruction is the translated code's speed,
    // whatever the scene asks of it (an A/B of the code generator less sensitive to what the game does meanwhile)
    const guestInsns = (vm?.guestInsns ?? 0) - (markPrev?.guestInsns ?? 0);
    // (scheduling decisions and slices of the phase: the thread switches whose cost the guest category also carries)
    const picks = (vm?.sched?.picks ?? 0) - (markPrev?.picks ?? 0), slices = (vm?.slices ?? 0) - (markPrev?.slices ?? 0);
    if (host) {
      const ph = host.frameAcct.phase(String(m.label), performance.now());
      const guestMs = (ph.mean?.guest ?? 0) * (ph.frames ?? 0), perM = guestInsns > 0 ? guestMs / (guestInsns / 1e6) : 0;
      log('frames', `mark ${m.label}: ${ph.text}${vm ? `\n  API time (estimated ms, calls): ${apiPhaseTop()}` : ''}${guestInsns > 0 ? `\n  guest instructions: ${(guestInsns / 1e6).toFixed(0)} M, ${(guestInsns / 1e6 / Math.max(1, ph.frames ?? 0)).toFixed(2)} M per frame; guest time ${perM.toFixed(2)} ms per M instructions; ${(picks / Math.max(1, ph.frames ?? 0)).toFixed(0)} scheduling decisions and ${(slices / Math.max(1, ph.frames ?? 0)).toFixed(1)} slices per frame` : ''}`);
      post({ type: 'phase', report: { ...ph, text: undefined, guestInsns, guestMsPerMInsn: perM, picks, slices } });
    }
    // (the translated code cache so far: the background worker also translates the cold tier's new code)
    const bc = vm?.jit?.bg?.cache;
    if (bc) log('file', `mark ${m.label}: translated code cache: ${vm.jit.bg.cacheHits} reused, ${bc.misses} not (${bc.missNew} new, other extent ${bc.missExtent}, other inline-API slots ${bc.missDeps}, other bytes ${bc.missBytes}, other heat ${bc.missHeat ?? 0}), ${bc.added} added, ${bc.superseded ?? 0} superseded${bc.supersededAge ? ` (last used ${Object.entries(bc.supersededAge).map(([k, n]) => `${k}${k === '4' ? '+' : ''}: ${n}`).join(', ')} sessions ago)` : ''}, ${bc.evicted ?? 0} evicted, ${Math.round(bc.bytes / 1048576)} MiB (${Math.round((bc.dead ?? 0) / 1048576)} unused), ${bc.compactions ?? 0} compaction(s) in ${Math.round(bc.compactMs ?? 0)} ms${bc.reset ? `, emptied: ${bc.reset}` : ''}; refreshed under the grown heat: ${bc.refreshPasses ?? 0} pass(es), ${bc.refreshChecked ?? 0} regions discovered again, ${bc.refreshed ?? 0} new shapes kept (${Math.round(bc.refreshMs ?? 0)} ms translating, ${Math.round(bc.refreshBusyMs ?? 0)} ms in all); background worker ${Math.round(vm.jit.bg.bgMs)} ms, ${Math.round(vm.jit.bg.translateMs)} translating`);
    const st = host?.gfx?.device?.stats ?? {}, prev = markPrev ?? {}, d = (k) => (st[k] ?? 0) - (prev[k] ?? 0);
    const ls = vm?.d3dDevice?.lockStats ?? {}, lp = markPrev?.locks ?? {}, dl = (k) => (ls[k] ?? 0) - (lp[k] ?? 0);
    const top = vm?.apiTimesPhase ? [...vm.apiTimesPhase].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ') : '(--api-times off)';
    log('gfx', `mark ${m.label}: texture levels uploaded ${d('texLevels')} (${d('reuploads')} again), ${(d('uploadBytes') / 1048576).toFixed(1)} MiB as RGBA8, ${d('texMs').toFixed(0)} ms (conversion ${d('texConvMs').toFixed(0)}, placeholder check ${d('texCheckMs').toFixed(0)}), ${d('texPartial')} of them partial; locks: ${dl('whole')} whole, ${dl('rect')} rect (${(100 * dl('rectPx') / Math.max(1, dl('rectOfPx'))).toFixed(0)}% of their surfaces), ${dl('readOnly')} read-only; API ms: ${top}`);
    if (host?.dxtPool) { const ps = host.dxtPool.stats, pp = markPrev?.pool ?? { jobs: 0, waitMs: 0 }; log('gfx', `mark ${m.label}: parallel DXT encodes ${ps.jobs - pp.jobs}, waiting for the helpers ${(ps.waitMs - pp.waitMs).toFixed(0)} ms${host.dxtPool.broken ? ' (pool off)' : ''}`); }
    if (vm?.d3dxProf?.size) { log('gfx', `mark ${m.label}: D3DX image work (ms, count): ${[...vm.d3dxProf].sort((a, b) => b[1].ms - a[1].ms).slice(0, 14).map(([k, e]) => `${k}: ${e.ms.toFixed(0)}/${e.n}`).join('; ')}`); vm.d3dxProf.clear(); }
    const hist = vm?.apiHist(), hp = markPrev?.hist;
    if (hist && hp) { const dh = [...hist].map(([k, v]) => [k, v - (hp.get(k) ?? 0)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]); log('gfx', `mark ${m.label}: API calls ${dh.reduce((a, [, v]) => a + v, 0)}, most frequent: ${dh.slice(0, 30).map(([k, v]) => `${k.replace(/^com\.dll!/, '')} ${v}`).join(', ')}`); }
    // (frame times of the phase: percentiles of the frames presented since the previous mark; render worker waits)
    const fs = markPrev?.at !== undefined ? host?.frameStats(markPrev.at) : null, g = host?.gfx?.stats?.() ?? null, gp = markPrev?.gl;
    if (fs) log('gfx', `mark ${m.label}: frames ${fs.frames} in ${fs.seconds.toFixed(1)} s (${fs.fps.toFixed(1)} fps), frame time p50 ${fs.p50.toFixed(1)} p90 ${fs.p90.toFixed(1)} p99 ${fs.p99.toFixed(1)} max ${fs.max.toFixed(0)} ms, >33 ms ${fs.over33}${g ? `; render: waits ${(g.gpuWaitMs - (gp?.gpuWaitMs ?? 0)).toFixed(0)} ms (fences ${(g.fenceMs - (gp?.fenceMs ?? 0)).toFixed(0)} ms in ${g.fenceWaits - (gp?.fenceWaits ?? 0)}: ${(g.fenceTex ?? 0) - (gp?.fenceTex ?? 0)} of textures, ${(g.fenceBuf ?? 0) - (gp?.fenceBuf ?? 0)} of buffers, frames ${(g.frameMs - (gp?.frameMs ?? 0)).toFixed(0)} ms in ${g.frameWaits - (gp?.frameWaits ?? 0)}, readbacks ${(g.readbackMs - (gp?.readbackMs ?? 0)).toFixed(0)} ms), replay ${((g.replayMs ?? 0) - (gp?.replayMs ?? 0)).toFixed(0)} ms, buffer data ${(((g.bufDataBytes ?? 0) - (gp?.bufDataBytes ?? 0)) / 1048576).toFixed(1)} MiB, ${(g.cows ?? 0) - (gp?.cows ?? 0)} surface copies (${(((g.cowBytes ?? 0) - (gp?.cowBytes ?? 0)) / 1048576).toFixed(1)} MiB)${g.compared !== undefined ? `, ${g.compared} frames compared, ${g.differing} differing` : ''}` : ''}`);
    const fast = vm?.jit ? [vm.mem.read32(FAST_STATS), vm.mem.read32(FAST_STATS + 4)] : null;
    const same = [...(vm?.d3dDevices ?? [])].reduce((a, d) => a + (d.sameSets ?? 0), 0);
    if (fast && markPrev?.fast) log('gfx', `mark ${m.label}: fast paths: ${fast[0] - markPrev.fast[0]} redundant state sets dropped, ${fast[1] - markPrev.fast[1]} AddRef/Release; ${same - (markPrev.same ?? 0)} texture / stream / index sets changing nothing ran in JavaScript`);
    // (PeekMessage polling of the phase, user32.js peekIdle: waits, those up to the expected end, bouts of polling)
    const pk = { parks: 0, longParks: 0, ends: 0, cut: 0 }; for (const t of vm?.proc?.threads ?? []) if (t.peekIdle) for (const k in pk) pk[k] += t.peekIdle[k];
    if (markPrev?.pk && pk.parks > markPrev.pk.parks) log('gfx', `mark ${m.label}: PeekMessage polling: ${pk.parks - markPrev.pk.parks} waits (${pk.longParks - markPrev.pk.longParks} up to the expected end), ${pk.ends - markPrev.pk.ends} bouts of polling ended (${pk.cut - markPrev.pk.cut} right after a wait)`);
    markPrev = { ...st, pk, guestInsns: vm?.guestInsns ?? 0, picks: vm?.sched?.picks ?? 0, slices: vm?.slices ?? 0, locks: { ...ls }, pool: host?.dxtPool ? { ...host.dxtPool.stats } : null, hist, at: performance.now(), gl: g ? { ...g } : null, fast, same }; if (vm?.apiTimes) vm.apiTimesPhase = new Map();
  }
  else if (m.type === 'corpus') post({ type: 'corpus', text: vm ? insnCorpus() : '{}' });
  else if (m.type === 'profile-dump') post({ type: 'profile', files: profileDump() });
  else if (m.type === 'frames') { const f = host?.frameStats(m.fromMs ?? 0); post({ type: 'frames', text: f ? `frames from t=${((m.fromMs ?? 0) / 1000).toFixed(0)}s: ${f.frames} frames in ${f.seconds.toFixed(0)}s = ${f.fps.toFixed(1)} fps; frame time p50 ${f.p50.toFixed(1)} p90 ${f.p90.toFixed(1)} p99 ${f.p99.toFixed(1)} max ${f.max.toFixed(0)} ms; >33ms ${f.over33} (${(100 * f.over33 / f.frames).toFixed(2)}%), >50ms ${f.over50}` : 'no frames' }); }
  else if (m.type === 'report') {
    const hist = vm?.apiHist();
    const apis = (hist ? '[report] API calls since start (' + hist.size + ' functions):\n' + [...hist].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v} ${k}`).join('\n') + '\n' : '') + (vm?.d3dDevice ? '[report] Direct3D states used (distinct values):\n  ' + stateUseReport(vm.d3dDevice) + '\n' : '') + (vm?.jit ? `[report] JIT: ${vm.jit.stats.regions} regions translated in ${(vm.jit.stats.translateMs / 1000).toFixed(1)} s (emit ${(vm.jit.stats.tEmit / 1000).toFixed(1)}, build ${(vm.jit.stats.tBuild / 1000).toFixed(1)}, compile ${(vm.jit.stats.tModule / 1000).toFixed(1)}, instantiate ${(vm.jit.stats.tInstance / 1000).toFixed(1)}, consolidate ${(vm.jit.stats.tConsolidate / 1000).toFixed(1)} s), ${(vm.jit.stats.bytes / 1048576).toFixed(0)} MiB of WASM, ${vm.jit.stats.blocks} blocks for ${vm.jit.blockMap.size} distinct block addresses, ${vm.jit.stats.fpuVersions ?? 0} FPU-mode versions, ${vm.jit.stats.fpuModeMisses ?? 0} mode misses, ${vm.jit.stats.misses} translated at a miss${vm.jit.stats.coldEntries ? `; cold tier: ${vm.jit.stats.coldEntries} entries interpreted (${vm.jit.stats.coldSteps ?? 0} instructions), ${vm.jit.stats.coldRequests ?? 0} asked of the background worker, ${vm.jit.stats.coldHot ?? 0} translated here when hot` : ''}${vm.jit.stats.prewarmed ? `; ${vm.jit.stats.prewarmed} translated ahead (learned) in ${(vm.jit.stats.prewarmMs / 1000).toFixed(1)} s, ${regionPos} of ${regionQueue?.length ?? 0} entries looked at` : ''}\n` : '') + (netLink ? `[report] connection: ${(() => { const n = netLink.snapshot(); return `${n.bw ? `${Math.round(n.bw / 1024)} KB/s measured` : 'not measured'}, round trip ${n.rtt ?? '-'} ms; game reads ${n.demandRequests} requests ${(n.demandBytes / 1048576).toFixed(1)} MB (waited ${Math.round(n.demandMs / 1000)} s), background ${n.bgRequests} requests ${(n.bgBytes / 1048576).toFixed(1)} MB, ${n.abortedRequests} aborted`; })()}\n` : '') + (gameFilesStats ? `[report] game files over HTTP: ${gameFilesStats.requests} requests, ${(gameFilesStats.bytes / 1048576).toFixed(0)} MiB, ${gameFilesStats.ms.toFixed(0)} ms${gameStore ? `; block store: ${gameStore.stats.hits} hits, ${gameStore.stats.puts} blocks added, writes ${Math.round(gameStore.stats.putMs ?? 0)} ms (${gameStore.stats.flushes ?? 0} index flushes, ${Math.round(gameStore.stats.flushMs ?? 0)} ms)` : ''}${gameFilesStats.aheadRequests ? `; ${gameFilesStats.aheadRequests} learned piece requests ahead of the game (${((gameFilesStats.aheadBytes ?? 0) / 1048576).toFixed(0)} MiB)` : ''}\n` : '') + (host?.gfx?.device?.stats ? `[report] GL programs built at a draw: ${host.gfx.device.stats.programs} in ${(host.gfx.device.stats.programMs ?? 0).toFixed(0)} ms (slowest ${(host.gfx.device.stats.programMaxMs ?? 0).toFixed(1)} ms); ${host.gfx.device.stats.programsShared ?? 0} keys given a program of the same sources\n` : '') + (host?.gfx?.programCache?.started ? `[report] GL programs compiled ahead: ${host.gfx.programCache.started}, ${host.gfx.programCache.resolved ?? 0} resolved ahead when the GPU process had caught up (${host.gfx.programCache.caughtUp ?? 0} times; ${(host.gfx.programCache.resolveMs ?? 0).toFixed(0)} ms, slowest ${(host.gfx.programCache.resolveMaxMs ?? 0).toFixed(1)}; ${host.gfx.programCache.polls ?? 0} completion checks in ${(host.gfx.programCache.pollMs ?? 0).toFixed(0)} ms; starts ${(host.gfx.programCache.startMs ?? 0).toFixed(0)} ms), ${host.gfx.programCache.hits} used (${host.gfx.programCache.resolvedHits ?? 0} of them resolved; ${(host.gfx.device?.stats?.prewarmTakeMs ?? 0).toFixed(0)} ms waiting for the others at draws)\n` : '') + (host?.gfx?.device?.stats?.uploadsBy ? `[report] texture level uploads: ${[...host.gfx.device.stats.uploadsBy.values()].reduce((a, b) => a + b, 0)} (${((host.gfx.device.stats.uploadBytes ?? 0) / 1048576).toFixed(0)} MiB as RGBA8) in ${(host.gfx.device.stats.texMs ?? 0).toFixed(0)} ms\n` : '') + (host?.gfx?.device?.stats?.uploadsBy ? '[report] texture level uploads by format:size (most frequent):\n  ' + [...host.gfx.device.stats.uploadsBy].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k} x${v}`).join(', ') + '\n' : '');
    post({ type: 'report', text: vm ? apis + vm.threadsReport() + '\n' + vm.crashReport(vm.lastThread ?? vm.proc.threads[0], 'state dump') : 'no vm' });
  }
};
void IN_RING; void AUDIO_RING_FRAMES;

/**
 * The link to the server's virtual LAN (src/host/lan.js, D061): host.lan for the emulated Winsock — the address the
 * server gave, send() of a frame — and the frames received handed to it between guest time slices. Reconnects after a
 * drop (the address may then change: a game in progress loses its peers, as on a real network cable pulled).
 */
function connectLan(h, room) {
  if (typeof WebSocket === 'undefined') return;
  const lan = h.lan = { ip: null, peers: 0, ws: null, sent: 0, received: 0 };
  lan.send = (type, src, dst, payload) => {
    const ws = lan.ws; if (!ws || ws.readyState !== 1) return;
    const f = new Uint8Array(LAN.HEADER + (payload?.length ?? 0)), dv = new DataView(f.buffer);
    f[0] = type; dv.setUint32(1, src.ip, true); dv.setUint16(5, src.port); dv.setUint32(7, dst.ip, true); dv.setUint16(11, dst.port);
    if (payload) f.set(payload, LAN.HEADER);
    ws.send(f); lan.sent++;
  };
  const open = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/lan?room=${encodeURIComponent(room)}`);
    ws.binaryType = 'arraybuffer'; lan.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'hello') { lan.ip = m.ip; log('net', `LAN: address ${m.ip}, ${m.peers} player${m.peers > 1 ? 's' : ''} of this game on the server`); }
        if (m.peers !== undefined) { lan.peers = m.peers; post({ type: 'lan', ip: lan.ip, peers: m.peers }); }
        return;
      }
      const f = new Uint8Array(e.data); if (f.length < LAN.HEADER) return;
      const dv = new DataView(f.buffer);
      lan.received++;
      vm?.lanDeliver?.(f[0], { ip: dv.getUint32(1, true), port: dv.getUint16(5) }, { ip: dv.getUint32(7, true), port: dv.getUint16(11) }, f.subarray(LAN.HEADER));
      h.wake?.();
    };
    ws.onclose = (e) => { lan.ws = null; log('net', `LAN: link closed (${e.code}${e.reason ? ' ' + e.reason : ''}), reconnecting`); post({ type: 'lan', ip: null, peers: 0 }); setTimeout(open, 3000); };
  };
  open();
}
