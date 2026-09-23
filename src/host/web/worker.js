// Emulator worker: builds the VFS (game folder over HTTP ranges, user profile in memory mirrored
// to OPFS), the browser host and the VM, then pumps the VM cooperatively so the canvases are
// presented and input/audio flow while the guest runs.
import { Vm, GuestCrash } from '../../core/vm.js';
import { RealClock } from '../../core/clock.js';
import { Vfs, MemBackend, normalizeWin } from '../../vfs/vfs.js';
import { HttpBackend } from '../../vfs/http-backend.js';
import { Registry } from '../../win32/registry.js';
import { BrowserHost, CTL, IN_RING, AUDIO_RING_FRAMES } from '../browser-host.js';
import { createWebGLBackend } from '../../gfx/d3d8-webgl.js';
import { stateUseReport } from '../../win32/d3d8.js';
import { decode, OP_NAMES, OT, fmtInsn } from '../../cpu/decoder.js';
import { HANDLERS } from '../../cpu/jit/translate.js';
import { MATH_KERNELS } from '../../cpu/jit/runtime.js';

let vm = null, host = null, profile = null, opfsDir = null, manifestName = '';
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
        else { const f = await h.getFile(); const data = new Uint8Array(await f.arrayBuffer()); mem.open(p, { create: true }).write(0, data); }
      }
    };
    await walk(opfsDir, '');
  } catch (e) { log('warn', `OPFS unavailable (${e.message}): saves are not persisted`); opfsDir = null; }
}

async function flushProfile(force = false) {
  if (!opfsDir || !profile) return;
  const now = Date.now();
  if (!force && now - lastFlush < 2000) return;
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
  const clock = new RealClock();
  const ctl = new Int32Array(m.ctl), inputRing = new Int32Array(m.inputRing), audioRing = new Float32Array(m.audioRing);
  // the worker owns its canvases and hands complete frames to the page as ImageBitmaps (see BrowserDisplay)
  const canvas2d = new OffscreenCanvas(manifest.display.width, manifest.display.height), canvasGl = new OffscreenCanvas(manifest.display.width, manifest.display.height);
  host = new BrowserHost({ clock, ctl, inputRing, audioRing, canvas2d, canvasGl, width: manifest.display.width, height: manifest.display.height, post });
  globalThis.ORTHROS_DUMP_SHADERS = !!m.opts.dumpShaders; globalThis.ORTHROS_CAPTURE_FRAME = m.opts.captureFrame || 0; globalThis.ORTHROS_CAPTURE_DRAWS = !!m.opts.captureDraws; globalThis.ORTHROS_LOCK_LOG = (m.opts.log ?? []).includes('lock'); if (m.opts.burstFromId) globalThis.ORTHROS_BURST_FROM_ID = m.opts.burstFromId; globalThis.ORTHROS_NO_CULL = !!m.opts.noCull; globalThis.ORTHROS_JIT_PROFILE = !!m.opts.jitProfile; globalThis.ORTHROS_GL_DISCARD = !!m.opts.glDiscard; globalThis.ORTHROS_WATCH_TEX = m.opts.watchTex || undefined; globalThis.ORTHROS_NO_F32 = !!m.opts.noF32; globalThis.ORTHROS_F32_OFF = m.opts.f32Off || '';
  // frame capture (--capture N): images (bound textures, render target after draws) encoded as PNG for the harness
  const dump = (name, w, h, rgba) => { try { const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0); c.convertToBlob({ type: 'image/png' }).then((b) => b.arrayBuffer()).then((ab) => post({ type: 'dump', name, data: ab }, [ab])); } catch (e) { log('warn', `dump ${name} failed: ${e.message}`); } };
  try { host.gfx = createWebGLBackend(canvasGl, (msg) => log('gfx', msg), dump); if (!host.gfx) log('warn', 'WebGL2 unavailable: Direct3D will run without rendering'); } catch (e) { log('warn', `WebGL2 init failed: ${e.message}`); }
  // VFS: system dirs in memory, game folder over HTTP, profile in memory (mirrored to OPFS)
  const vfs = new Vfs();
  const root = new MemBackend();
  vfs.mount('C:\\', root);
  for (const d of ['Windows', 'Windows/System32', 'Windows/Temp', 'Users', 'Users/Player', 'Program Files', 'Program Files/Common Files', 'Game']) root.mkdir(d);
  vfs.mount(manifest.mount, new HttpBackend(`/game/${manifestName}/`, m.tree, { cacheBlocks: m.opts.cacheBlocks ?? 256 }));
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
  vm = new Vm({ vfs, clock, host, jit: !m.opts.interp, logKinds: m.opts.log ?? ['loader', 'warn', 'crash', 'win', 'thread', 'gfx', 'audio', 'input'], log: log, apiHist: true });
  vm.onStdout = (s) => post({ type: 'stdout', text: s });
  // slow-frame diagnostics: what happened during a frame longer than 33 ms (deltas since the previous frame)
  host.frameProbe = () => ({ t: performance.now(), api: vm.apiCalls, slices: vm.slices, translateMs: vm.jit?.stats.translateMs ?? 0, regions: vm.jit?.stats.regions ?? 0, consolidations: vm.jit?.stats.consolidations ?? 0, fallbacks: vm.jit?.stats.fallbackSteps ?? 0, uploads: host.gfx?.stats?.uploads ?? 0, uploadKB: Math.round((host.gfx?.stats?.uploadBytes ?? 0) / 1024), draws: vm.d3dDevice?.draws ?? 0, audioMs: host.audioMs ?? 0, threads: vm.proc.threads.length });
  host.slowFrameFrom = (m.opts.slowFrom ?? 0) * 1000;
  host.onSlowFrame = (dt, d) => log('slowframe', `t=${(performance.now() / 1000).toFixed(1)}s ${dt.toFixed(1)}ms: api ${d.api} slices ${d.slices} draws ${d.draws} jit ${d.translateMs}ms/${d.regions}r/${d.consolidations}c fb ${d.fallbacks} tex ${d.uploads}/${d.uploadKB}KB present ${d.presentMs}ms audio ${d.audioMs}ms`);
  vm.registry = new Registry(); vm.registry.seed(manifest.registry);
  if (profile.files.has('registry.json')) { try { vm.registry.load(JSON.parse(new TextDecoder().decode(profile.open('registry.json').read(0, profile.stat('registry.json').size)))); } catch (e) { log('warn', `bad registry.json: ${e.message}`); } }
  const exePath = normalizeWin(manifest.mount + '\\' + manifest.exe);
  try {
    vm.createProcess({ exePath, args: manifest.args, env: manifest.env, dllOverrides: manifest.dllOverrides, cwd: manifest.cwd ? normalizeWin(manifest.mount + '\\' + manifest.cwd) : undefined });
  } catch (e) { post({ type: 'crash', report: e instanceof GuestCrash ? e.report : String(e.stack || e) }); return; }
  running = true;
  post({ type: 'started' });
  channel.port1.onmessage = () => pump();
  pump();
}

let lastProf = {};
let statsAt = 0, lastApi = 0, lastSlices = 0, lastFrames = 0, lastHist = new Map(), lastFallbacks = 0, lastFbHist = new Map();
const pumpStats = { runs: 0, sleeps: 0, idles: 0, sleepMs: 0, runMs: 0 }; // how the worker spends its time between slices
function pump() {
  if (!running || stopped) return;
  if (Atomics.load(host.ctl, CTL.STOP)) { stop('stopped'); return; }
  let r;
  const tRun = performance.now();
  try {
    r = vm.runFor(tRun + 12);
  } catch (e) {
    running = false;
    const report = e instanceof GuestCrash ? e.report : String(e.stack || e);
    post({ type: 'crash', report });
    flushProfile(true);
    return;
  }
  host.renderAudio(vm);
  const now = performance.now();
  pumpStats.runs++; pumpStats.runMs += now - tRun;
  if (now - statsAt > 500) {
    const dt = (now - statsAt) / 1000; statsAt = now;
    const hist = vm.apiHist();
    const ft = host.frameTimes.slice().sort((a, b) => a - b);
    const p = (q) => (ft.length ? ft[Math.min(ft.length - 1, Math.floor(q * ft.length))] : 0);
    post({ type: 'stats', apiPerSec: (vm.apiCalls - lastApi) / dt, mips: (vm.slices - lastSlices) * 0.1 / dt, fps: (host.framesPresented - lastFrames) / dt, frameP50: p(0.5), frameP99: p(0.99), regions: vm.jit?.stats.regions ?? 0, threads: vm.proc.threads.length, frames: host.framesPresented, firstD3D: vm.firstD3DCall?.name ?? null, d3d: vm.d3dDevice ? { frames: vm.d3dDevice.frames, draws: vm.d3dDevice.draws, w: vm.d3dDevice.pp.width, h: vm.d3dDevice.pp.height } : null, unknownImports: vm.proc.unknownImports.size, fallbacksPerSec: ((vm.jit?.stats.fallbackSteps ?? 0) - lastFallbacks) / dt, pump: `${Math.round(pumpStats.runs / dt)} slices/s busy ${Math.round(pumpStats.runMs / dt / 10)}% sleeps ${Math.round(pumpStats.sleeps / dt)}/s avg ${(pumpStats.sleepMs / Math.max(1, pumpStats.sleeps)).toFixed(1)}ms idles ${Math.round(pumpStats.idles / dt)}/s`, topFallback: vm.jit?.fallbackHist ? [...vm.jit.fallbackHist].map(([k, v]) => [k, v - (lastFbHist.get(k) ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${OP_NAMES[k] ?? k}=${Math.round(v / dt)}`).join(' ') : '', audioBuffers: vm.audio?.buffers.size ?? 0, audioPeak: host.audioPeak ?? 0, audioMs: (host.audioMs ?? 0) / dt, audioFrames: (host.audioFrames ?? 0) / dt, topApi: hist ? [...hist].map(([k, v]) => [k, v - (lastHist.get(k) ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k.replace(/^(com|kernel32|user32|winmm|gdi32)\.dll!/, '')}=${Math.round(v / dt)}`).join(' ') : '' });
    if (hist) lastHist = hist;
    lastFallbacks = vm.jit?.stats.fallbackSteps ?? 0; if (vm.jit?.fallbackHist) lastFbHist = new Map(vm.jit.fallbackHist);
    // --jit-profile: block transitions per second by kind (intra-region jumps, returns, chaining)
    const prof = vm.jit?.stats.prof;
    if (prof) { log('jitprof', `per s: ${Object.entries(prof).map(([k, v]) => `${k}=${Math.round((v - (lastProf[k] ?? 0)) / dt)}`).join(' ')} chained=${Math.round((vm.jit.stats.chained - (lastProf.chained ?? 0)) / dt)} flags helper by op/s: ${vm.jit.flagsByOp().slice(0, 10).map(([k, n]) => `${k}=${Math.round(n / dt)}`).join(' ')}`); lastProf = { ...prof, chained: vm.jit.stats.chained }; }
    pumpStats.runs = pumpStats.sleeps = pumpStats.idles = pumpStats.sleepMs = pumpStats.runMs = 0;
    lastApi = vm.apiCalls; lastSlices = vm.slices; lastFrames = host.framesPresented; host.audioPeak = 0; host.audioMs = 0; host.audioFrames = 0;
    flushProfile();
  }
  if (r.state === 'exited') { running = false; post({ type: 'exit', code: r.code }); flushProfile(true); return; }
  if (r.state === 'sleep') { const ms = Math.max(0, r.until - performance.now()); pumpStats.sleeps++; pumpStats.sleepMs += ms; setTimeout(pump, ms); }
  else if (r.state === 'idle') { pumpStats.idles++; setTimeout(pump, 30); }
  else channel.port2.postMessage(0);
}

/** Instruction mix of translated regions (by entry EIP): mnemonic counts per region and overall — profiler companion. */
/** region function imports by index (translate.js IMP_*: flags helper, round24, interpreter fallback, then the math kernels) */
const IMPORT_NAMES = ['flags', 'round24', 'fallback', ...MATH_KERNELS.map(([n]) => n)];
function regionMix(eips) {
  const lines = [], overall = new Map(); let total = 0;
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
  else if (m.type === 'wake') { if (running && !stopped) channel.port2.postMessage(0); }
  else if (m.type === 'stop') stop('stop requested');
  else if (m.type === 'capture') { const d = host?.gfx?.device; if (d) { d.captureAt = d.frame + 1; d.captureDraws = !!m.draws; log('gfx', `d3d-webgl: capture requested at frame ${d.frame + 1}`); } }
  else if (m.type === 'regions') post({ type: 'regions', text: vm ? regionMix(m.eips) : 'no vm' });
  else if (m.type === 'corpus') post({ type: 'corpus', text: vm ? insnCorpus() : '{}' });
  else if (m.type === 'profile-dump') post({ type: 'profile', files: profileDump() });
  else if (m.type === 'frames') { const f = host?.frameStats(m.fromMs ?? 0); post({ type: 'frames', text: f ? `frames from t=${((m.fromMs ?? 0) / 1000).toFixed(0)}s: ${f.frames} frames in ${f.seconds.toFixed(0)}s = ${f.fps.toFixed(1)} fps; frame time p50 ${f.p50.toFixed(1)} p90 ${f.p90.toFixed(1)} p99 ${f.p99.toFixed(1)} max ${f.max.toFixed(0)} ms; >33ms ${f.over33} (${(100 * f.over33 / f.frames).toFixed(2)}%), >50ms ${f.over50}` : 'no frames' }); }
  else if (m.type === 'report') {
    const hist = vm?.apiHist();
    const apis = (hist ? '[report] API calls since start (' + hist.size + ' functions):\n' + [...hist].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v} ${k}`).join('\n') + '\n' : '') + (vm?.d3dDevice ? '[report] Direct3D states used (distinct values):\n  ' + stateUseReport(vm.d3dDevice) + '\n' : '');
    post({ type: 'report', text: vm ? apis + vm.threadsReport() + '\n' + vm.crashReport(vm.lastThread ?? vm.proc.threads[0], 'state dump') : 'no vm' });
  }
};
void IN_RING; void AUDIO_RING_FRAMES;
