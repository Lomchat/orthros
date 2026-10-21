// The Direct3D output of a headless Node run (tools/framebench.mjs, tools/startbench.mjs --gfx): the WebGL backend over a
// no-op WebGL2 context (`backend`: the in-thread path, ?glworker=0), the render worker's recorder with its commands
// dropped (`recorder`: what the default render worker leaves on the emulator thread), or nothing (`none`: the device's
// own bookkeeping only). Emulator-thread costs of a real game's frames, without a browser or a GPU.
import fs from 'node:fs';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { noopGl } from './noop-gl.mjs';
import { PROGRAM_GLSL_VERSION, ffKeyRegenerable } from '../src/gfx/program-id.js';

/**
 * Install `kind` on the headless host. `programs`: a learned programs2-<manifest>.json (compiled ahead by the
 * backend, as a session does; `raw`: with their learned sources, keys dropped).
 * @param {any} host HeadlessHost
 * @param {'backend'|'recorder'|'none'} kind
 * @param {{ programs?: string|null, raw?: boolean, log?: (l: string) => void }} [o]
 * @returns {{ kind: string, link: any, pcache: any, device: () => any }}
 */
export function installNodeGfx(host, kind, o = {}) {
  let pcache = null, dev = null, link = null;
  if (o.programs) {
    const j = JSON.parse(fs.readFileSync(o.programs, 'utf8')), sessions = Number(j.sessions) || 0;
    const list = j.programs.filter((r) => r[8] === PROGRAM_GLSL_VERSION || ffKeyRegenerable(r[1]) || ((r[8] ?? null) === null && r[7] >= sessions + 1 - 4)).sort((a, b) => a[5] - b[5]);
    pcache = { queue: list.map(([id, key, vs, fs2, attrs, , , , v]) => ({ id, key: o.raw ? '' : key, vs, fs: fs2, attrs, v })), ready: new Map(), learned: [], used: [], t0: performance.now(), parallel: true, started: 0, pending: 0, hits: 0, devices: new Set() };
    o.log?.(`programs: ${list.length} of ${j.programs.length} learned listed${o.raw ? ' (keys dropped: their sources as learned)' : ''}`);
  }
  if (kind === 'backend') { const gl = noopGl(); host.gfx = { createDevice: (d) => (dev = new WebGLDevice(gl, d, { programCache: pcache })) }; }
  else if (kind === 'recorder') {
    const words = new Int32Array(new SharedArrayBuffer(16 << 20));
    link = new RenderLink({ words, replayer: { reader: { consumed: 0 }, run() { this.reader.consumed = link.w.produced; } } });
    link.drain = function () { this.w.consumed = this.replayer.reader.consumed = this.w.produced; };
    host.gfx = { createDevice: (d) => (dev = new Recorder(link, d)) };
  } else if (kind !== 'none') throw new Error(`--gfx ${kind}: backend, recorder or none`);
  return { kind, link, pcache, device: () => dev };
}

/** The programs line of a run with learned programs (backend): built at a draw, compiled ahead, taken. */
export function programsLine(g) {
  const d = g.device();
  if (!g.pcache || !d?.stats) return null;
  const p = g.pcache;
  return `programs: built at a draw ${d.stats.programs} (${(d.stats.programMs ?? 0).toFixed(0)} ms), learned compiled ahead ${p.started}, taken ${p.hits}, regenerated from their key ${p.regenerated ?? 0}, other versions skipped ${p.stale ?? 0}`;
}
