// The Direct3D output of a headless Node run (tools/bench/framebench.mjs, tools/bench/startbench.mjs --gfx): the WebGL backend over a
// no-op WebGL2 context (`backend`: the in-thread path, ?glworker=0), the render worker's recorder with its commands
// dropped (`recorder`: what the default render worker leaves on the emulator thread), or nothing (`none`: the device's
// own bookkeeping only). Emulator-thread costs of a real game's frames, without a browser or a GPU.
import fs from 'node:fs';
import { WebGLDevice } from '../../src/gfx/d3d8-webgl.js';
import { RenderLink, Recorder } from '../../src/gfx/d3d-recorder.js';
import { noopGl } from './noop-gl.mjs';
import { PROGRAM_GLSL_VERSION, ffKeyRegenerable } from '../../src/gfx/program-id.js';

/**
 * Install `kind` on the headless host. `programs`: a learned programs2-<manifest>.json (compiled ahead by the
 * backend, as a session does; `raw`: with their learned sources, keys dropped).
 * @param {any} host HeadlessHost
 * @param {'backend'|'recorder'|'none'} kind
 * @param {{ programs?: string|null, raw?: boolean, hash?: boolean, log?: (l: string) => void }} [o]
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
  // (o.compileMs, or ORTHROS_NOOP_COMPILE_MS: program builds that take that long, as ANGLE over Direct3D 11 — the waits
  // they cause at draws are counted, noop-gl.mjs; ORTHROS_NOOP_COMPILE_THREADS: the GPU process's compile threads)
  const compileMs = Number(o.compileMs ?? process.env.ORTHROS_NOOP_COMPILE_MS ?? 0), compileThreads = Number(process.env.ORTHROS_NOOP_COMPILE_THREADS ?? 4);
  if (kind === 'backend') {
    const gl = noopGl(1024, 768, { compileMs, compileThreads, drawHash: process.env.ORTHROS_NOOP_DRAW_HASH === '1' });
    if (pcache) pcache.parallel = !!gl.getExtension('KHR_parallel_shader_compile') || !compileMs; // (as before without a delay)
    host.gfx = { gl, programCache: pcache, createDevice: (d) => (dev = new WebGLDevice(gl, d, { programCache: pcache, log: o.log ? (m) => { if (typeof m === 'string' && /program built in|programs predicted|link error/.test(m)) o.log(m); } : undefined })) };
  }
  else if (kind === 'recorder') {
    const words = new Int32Array(new SharedArrayBuffer(16 << 20));
    link = new RenderLink({ words, replayer: { reader: { consumed: 0 }, run() { this.reader.consumed = link.w.produced; } } });
    // (o.hash: every command word dropped is hashed first — FNV-1a over the words — for streamHash: two runs of the same
    // guest work under the virtual clock compare their render commands, e.g. before / after an API-layer change)
    const sh = o.hash ? { h: 0x811c9dc5, words: 0 } : null;
    link.drain = function () {
      const w = this.w;
      if (sh !== null) { const I = w.I, m = w.mask; let h = sh.h; for (let p = this.replayer.reader.consumed; p < w.produced; p++) h = Math.imul(h ^ I[p & m], 16777619); sh.h = h; sh.words += w.produced - this.replayer.reader.consumed; }
      w.consumed = this.replayer.reader.consumed = w.produced;
    };
    if (sh !== null) link.streamHash = () => { link.drain(); return `${(sh.h >>> 0).toString(16).padStart(8, '0')} (${sh.words} words)`; };
    host.gfx = { createDevice: (d) => (dev = new Recorder(link, d)) };
  } else if (kind !== 'none') throw new Error(`--gfx ${kind}: backend, recorder or none`);
  return { kind, link, pcache, gl: host.gfx?.gl ?? null, device: () => dev };
}

/** The programs line of a run (backend): built at a draw, compiled ahead (learned, predicted), taken, waits at draws. */
export function programsLine(g) {
  const d = g.device();
  if (!d?.stats) return null;
  const p = g.pcache ?? d.pc, sim = g.gl?.sim;
  return `programs: built at a draw ${d.stats.programs} (${(d.stats.programMs ?? 0).toFixed(0)} ms)${p ? `, learned compiled ahead ${p.started}, taken ${p.hits} (waits at their draws ${(d.stats.prewarmTakeMs ?? 0).toFixed(0)} ms), regenerated from their key ${p.regenerated ?? 0}, other versions skipped ${p.stale ?? 0}` : ''}${p?.fx ? `, predicted ${p.predicted ?? 0} pairs (${p.fx.passes} passes, ${p.fx.codes.size} shaders) started ${p.predictStarted ?? 0} already built ${p.predictKnown ?? 0} taken ${p.predictHits ?? 0}, misses at draws ${JSON.stringify(d.stats.predictMiss ?? {})}` : ''}${d.stats.programsAsync ? `, async builds ${d.stats.programsAsync} (draws skipped ${d.stats.buildingDraws ?? 0})` : ''}${sim ? `; simulated builds ${sim.builds}, link waits ${sim.waits} (${sim.waitMs.toFixed(0)} ms, longest ${sim.maxWaitMs.toFixed(0)})` : ''}${g.gl?.drawHash ? `; draws ${g.gl.drawHash.draws} hash ${(g.gl.drawHash.h >>> 0).toString(16)}` : ''}`;
}
