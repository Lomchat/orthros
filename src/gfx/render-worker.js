// Render worker (docs/render-worker.md, D063): replays the Direct3D work the emulator records (cmd-ring.js) into
// device mirrors read by the unchanged WebGL backend, on its own OffscreenCanvas and WebGL2 context, and posts each
// presented frame to the page. Guest memory is shared with the emulator worker: resource contents are read from it
// (the emulator's fences keep them stable until read), readback pixels written into it while the emulator waits.
import { createWebGLBackend } from './d3d8-webgl.js';
import { programsPost } from './program-id.js';
import { Replayer } from './d3d-mirror.js';
import { CTL } from './cmd-ring.js';
import { replayLoop, publishTail } from './render-loop.js';
import { GuestMemory } from '../cpu/memory.js';
import { refreshApiOpt } from '../core/api-opt.js';

let ctl = null, port = null, replayer = null, backend = null, canvas = null;
const replay = { ms: 0, frames: 0, commands: 0, waitMs: 0 };
const log = (msg) => port?.postMessage({ type: 'log', kind: 'gfx', msg });

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { try { init(m); } catch (err) { self.postMessage({ type: 'failed', reason: String(err?.stack ?? err) }); if (ctl) Atomics.store(ctl, CTL.READY, -1); } }
  else if (m.type === 'memory') { replayer.mems[m.index] = new GuestMemory({ memory: m.memory }); Atomics.store(ctl, CTL.MEMORIES, m.index); Atomics.notify(ctl, CTL.MEMORIES); } // (a child process's: docs/processes.md)
  else if (m.type === 'dbg') { const [k, v] = String(m.kv ?? '').split('='); if (/^ORTHROS_[A-Z0-9_]+$/.test(k)) globalThis[k] = v === undefined || v === '' ? undefined : Number.isNaN(Number(v)) ? v : Number(v); refreshApiOpt(); }
  else if (m.type === 'capture') { const d = backend?.device; if (d) { if (m.at !== undefined) d.captureAt = d.frame + 1; if (m.draws !== undefined) d.captureDraws = !!m.draws; if (m.count !== undefined) d.countFrames = m.count; } }
  else if (m.type === 'loseContext') { const ext = backend?.gl.getExtension('WEBGL_lose_context'); if (ext) { ext.loseContext(); setTimeout(() => ext.restoreContext(), m.ms ?? 500); } else log('d3d-webgl: WEBGL_lose_context unavailable'); }
};

function init(m) {
  const o = m.opts ?? {};
  for (const [k, v] of Object.entries(o.globals ?? {})) globalThis[k] = v;
  ctl = new Int32Array(m.ctl); port = m.port;
  const mem = new GuestMemory({ memory: m.memory });
  canvas = new OffscreenCanvas(o.width || 1024, o.height || 768);
  const dump = (name, w, h, rgba) => { try { const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer instanceof ArrayBuffer ? rgba.buffer : rgba.slice().buffer, rgba.buffer instanceof ArrayBuffer ? rgba.byteOffset : 0, w * h * 4), w, h), 0, 0); c.convertToBlob({ type: 'image/png' }).then((b) => b.arrayBuffer()).then((ab) => port.postMessage({ type: 'dump', name, data: ab }, [ab])); } catch (err) { log(`dump ${name} failed: ${err.message}`); } };
  backend = createWebGLBackend(canvas, log, dump);
  if (!backend) { Atomics.store(ctl, CTL.READY, -1); self.postMessage({ type: 'failed', reason: 'WebGL2 unavailable in the render worker' }); return; }
  programSync(o.programs);
  replayer = new Replayer(new Int32Array(m.ring), {
    mem, ack: new Int32Array(m.ack), createBackend: (mirror) => backend.createDevice(mirror),
    // (?glworker=compare-worker: the back buffer of every `compareEvery`-th frame sent for comparison, no frame shown)
    beforePresent: o.compareEvery ? (mirror, frame) => { if (frame % o.compareEvery === 0 && mirror.gfx) { const snap = mirror.gfx.readBackBuffer(); self.postMessage({ type: 'compare', frame, snap }, [snap.px.buffer]); } } : null,
    onPresent: (mirror, frame) => {
      let bitmap = null;
      try { bitmap = canvas.transferToImageBitmap(); } catch { /* context lost: no frame until restored */ }
      if (bitmap) { if (o.noPresent) bitmap.close(); else port.postMessage({ type: 'frame', layer: 'gl', bitmap }, [bitmap]); }
      replay.frames++;
      Atomics.store(ctl, CTL.SHOWN, frame); Atomics.notify(ctl, CTL.SHOWN);
    },
    onReadback: (ticket) => { publishTail(ctl, replayer); Atomics.store(ctl, CTL.READBACK, ticket); Atomics.notify(ctl, CTL.READBACK); },
    onCanvas: (w, h) => { if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } },
  });
  canvas.addEventListener?.('webglcontextrestored', () => Atomics.add(ctl, CTL.EPOCH, 1));
  Atomics.store(ctl, CTL.READY, 1);
  self.postMessage({ type: 'ready', renderer: String(backend.gl.getParameter(backend.gl.RENDERER)) });
  setInterval(postStats, 500);
  replayLoop(ctl, replayer, backend, replay, () => false, log).catch((e) => { log(`render worker: replay loop stopped: ${e?.stack ?? e}`); });
}

function postStats() {
  const pc = backend.programCache, devices = [];
  for (const [id, m] of replayer.devices) if (m.gfx) devices.push([id, { ...m.gfx.stats }]);
  const pcs = { queueLength: pc.queue.length, started: pc.started, hits: pc.hits, pending: pc.pending, resolved: pc.resolved ?? 0, caughtUp: pc.caughtUp ?? 0, resolveMs: pc.resolveMs ?? 0, resolveMaxMs: pc.resolveMaxMs ?? 0, polls: pc.polls ?? 0, pollMs: pc.pollMs ?? 0, startMs: pc.startMs ?? 0, resolvedHits: pc.resolvedHits ?? 0, parallel: pc.parallel };
  self.postMessage({ type: 'stats', devices, programCache: pcs, replay: { ...replay, commands: replayer.commands } });
}

/** GL programs of earlier sessions compiled ahead, this session's new ones sent back (as the in-thread path does) */
function programSync(url) {
  if (!url) return;
  const pc = backend.programCache;
  fetch(url).then((r) => (r.ok ? r.json() : [])).then((list) => { if (Array.isArray(list) && list.length) { pc.queue.push(...list); log(`programs: ${list.length} learned from earlier sessions, compiled ahead in the render worker${pc.parallel ? ' (parallel compilation)' : ''}`); } }).catch(() => {});
  setInterval(() => {
    if (!pc.learned.length && !pc.used.length) return;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: programsPost(pc.learned.splice(0), pc.used.splice(0)) }).catch(() => {});
  }, 5000);
}
