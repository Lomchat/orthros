// Emulator worker: builds the VFS (game folder over HTTP ranges, user profile in memory mirrored
// to OPFS), the browser host and the VM, then pumps the VM cooperatively so the canvases are
// presented and input/audio flow while the guest runs.
import { Vm, GuestCrash } from '../../core/vm.js';
import { RealClock } from '../../core/clock.js';
import { Vfs, MemBackend, normalizeWin } from '../../vfs/vfs.js';
import { HttpBackend } from '../../vfs/http-backend.js';
import { Registry } from '../../win32/registry.js';
import { BrowserHost, CTL, IN_RING, AUDIO_RING_FRAMES } from '../browser-host.js';

let vm = null, host = null, profile = null, opfsDir = null, manifestName = '';
let lastFlush = 0, running = false, stopped = false;
const channel = new MessageChannel();
const post = (m) => self.postMessage(m);
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

async function start(m) {
  manifestName = m.name;
  const manifest = m.manifest;
  const clock = new RealClock();
  const ctl = new Int32Array(m.ctl), inputRing = new Int32Array(m.inputRing), audioRing = new Float32Array(m.audioRing);
  host = new BrowserHost({ clock, ctl, inputRing, audioRing, canvas2d: m.canvas2d, canvasGl: m.canvasGl, width: manifest.display.width, height: manifest.display.height, post });
  // VFS: system dirs in memory, game folder over HTTP, profile in memory (mirrored to OPFS)
  const vfs = new Vfs();
  const root = new MemBackend();
  vfs.mount('C:\\', root);
  for (const d of ['Windows', 'Windows/System32', 'Windows/Temp', 'Users', 'Users/Player', 'Program Files', 'Program Files/Common Files', 'Game']) root.mkdir(d);
  vfs.mount(manifest.mount, new HttpBackend(`/game/${manifestName}/`, m.tree, { cacheBlocks: m.opts.cacheBlocks ?? 256 }));
  profile = new MemBackend();
  for (const d of PROFILE_DIRS) profile.mkdir(d);
  if (!m.opts.headless) await loadProfile(profile);
  vfs.mount('C:\\Users\\Player', profile);
  vm = new Vm({ vfs, clock, host, jit: !m.opts.interp, logKinds: m.opts.log ?? ['loader', 'warn', 'crash', 'win', 'thread', 'gfx', 'audio', 'input'], log: log, apiHist: true });
  vm.onStdout = (s) => post({ type: 'stdout', text: s });
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

let statsAt = 0, lastApi = 0, lastSlices = 0, lastFrames = 0;
function pump() {
  if (!running || stopped) return;
  if (Atomics.load(host.ctl, CTL.STOP)) { stop('stopped'); return; }
  let r;
  try {
    r = vm.runFor(performance.now() + 12);
  } catch (e) {
    running = false;
    const report = e instanceof GuestCrash ? e.report : String(e.stack || e);
    post({ type: 'crash', report });
    flushProfile(true);
    return;
  }
  host.renderAudio(vm);
  const now = performance.now();
  if (now - statsAt > 500) {
    const dt = (now - statsAt) / 1000; statsAt = now;
    const ft = host.frameTimes.slice().sort((a, b) => a - b);
    const p = (q) => (ft.length ? ft[Math.min(ft.length - 1, Math.floor(q * ft.length))] : 0);
    post({ type: 'stats', apiPerSec: (vm.apiCalls - lastApi) / dt, mips: (vm.slices - lastSlices) * 0.1 / dt, fps: (host.framesPresented - lastFrames) / dt, frameP50: p(0.5), frameP99: p(0.99), regions: vm.jit?.stats.regions ?? 0, threads: vm.proc.threads.length, frames: host.framesPresented, firstD3D: vm.firstD3DCall?.name ?? null, d3d: vm.d3dDevice ? { frames: vm.d3dDevice.frames, draws: vm.d3dDevice.draws, w: vm.d3dDevice.pp.width, h: vm.d3dDevice.pp.height } : null, unknownImports: vm.proc.unknownImports.size });
    lastApi = vm.apiCalls; lastSlices = vm.slices; lastFrames = host.framesPresented;
    flushProfile();
  }
  if (r.state === 'exited') { running = false; post({ type: 'exit', code: r.code }); flushProfile(true); return; }
  if (r.state === 'sleep') setTimeout(pump, Math.max(0, r.until - performance.now()));
  else if (r.state === 'idle') setTimeout(pump, 30);
  else channel.port2.postMessage(0);
}

function stop(reason) { stopped = true; running = false; flushProfile(true); post({ type: 'exit', code: -1, reason }); }

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') start(m).catch((err) => post({ type: 'crash', report: String(err.stack || err) }));
  else if (m.type === 'wake') { if (running && !stopped) channel.port2.postMessage(0); }
  else if (m.type === 'stop') stop('stop requested');
  else if (m.type === 'report') post({ type: 'report', text: vm ? vm.threadsReport() + '\n' + vm.crashReport(vm.lastThread ?? vm.proc.threads[0], 'state dump') : 'no vm' });
};
void IN_RING; void AUDIO_RING_FRAMES;
