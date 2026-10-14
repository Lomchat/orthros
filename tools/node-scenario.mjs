// Harness scenarios (tools/scenarios/*.txt, the language of tools/headless.mjs --input) played in Node without a page:
// tools/startbench.mjs --input <file>. Mouse and keyboard events are queued on the headless host as the browser host
// queues them; `waitframe:min,max` anchors on the Direct3D device's draws per frame (vm.d3dDevice), `mark:<label>` closes
// a phase and prints its guest instructions and the guest category's time per instruction (frame accounting, as the
// browser's phase reports), its frame-time percentiles and the APIs that took the most time ([apitop]: ms and calls per
// frame, µs per call), `dbg:ORTHROS_JIT_AB=<json>` switches the JIT's translation options (Jit.switchOpts), the
// API-layer switches (dbg:ORTHROS_API_OPT_OFF=1, ORTHROS_FX_BIND_OFF=1...) and other ORTHROS_* debug globals are set as
// the browser worker sets them. Other
// kinds (shot, profile, capture...) are ignored. Times are real seconds from the start, from the anchor after a wait
// (or `+t` from the first Direct3D frame), as in the harness.
import { acct, C as ACCT } from '../src/core/frame-acct.js';
import { scanCodeOfVk } from '../src/win32/dinput8.js';
import { BLOCK_COUNTS_BASE } from '../src/cpu/memory.js';
import { refreshApiOpt } from '../src/core/api-opt.js';

export class NodeScenario {
  /**
   * @param {string} text scenario
   * @param {any} vm
   * @param {(line: string) => void} log
   */
  constructor(text, vm, log, nowMs = () => performance.now()) {
    this.vm = vm; this.log = log; this.nowMs = nowMs; // (the time base: wall time, or a virtual clock's for a deterministic run)
    let afterWait = false;
    this.events = text.split(';').map((e) => e.trim()).filter(Boolean).map((e) => {
      const [t, kind, ...rest] = e.split(':'); const a = rest.join(':');
      const ev = { t: Number(t.replace(/^\+/, '')), rel: t.startsWith('+'), anchored: afterWait, kind, args: ['text', 'mark', 'dbg'].includes(kind) ? [a] : a.split(',').map(Number), done: false };
      if (kind === 'waitfps' || kind === 'waitpixel' || kind === 'waitframe') afterWait = true;
      return ev;
    });
    this.t0 = this.nowMs(); this.anchorAt = null; this.firstFrameAt = null;
    this.pending = []; // [time ms, input event] (button releases, key ups)
    this.phase = null; this.nextCheck = 0;
    this.results = [];
    // (frame intervals per phase, from the Direct3D presents: percentiles in the phase report)
    this.frameDts = []; this.lastPresentAt = 0;
    if (!vm.host.frameHook) vm.host.frameHook = () => { const n = this.nowMs(); if (this.lastPresentAt) this.frameDts.push(n - this.lastPresentAt); this.lastPresentAt = n; };
  }
  now() { return (this.nowMs() - this.t0) / 1000; }
  push(ev) { this.vm.host.inputQueue.push(ev); }
  /** Called often (API dispatch, waits): fires the due events. */
  tick() {
    const nowMs = this.nowMs();
    if (nowMs < this.nextCheck) return;
    this.nextCheck = nowMs + 5;
    while (this.pending.length && this.pending[0][0] <= nowMs) this.push(this.pending.shift()[1]);
    const t = this.now(), d3d = this.vm.d3dDevice;
    if (this.firstFrameAt === null && d3d?.frames > 0) this.firstFrameAt = t;
    for (const ev of this.events) {
      if (ev.done) continue;
      const base = ev.rel ? this.firstFrameAt : ev.anchored ? this.anchorAt : 0;
      if (base === null) break;
      const due = base + ev.t;
      if (ev.kind === 'waitframe') {
        if (t < due) break;
        if (!d3d) break;
        // (draws per frame over 0.5 s windows, three in a row within the range)
        if (ev.at !== undefined && t - ev.at < 0.5) break;
        const prev = ev.prev; ev.prev = { draws: d3d.draws, frames: d3d.frames }; ev.at = t;
        if (!prev || d3d.frames === prev.frames) break;
        const dpf = (d3d.draws - prev.draws) / (d3d.frames - prev.frames);
        ev.streak = dpf >= ev.args[0] && dpf <= ev.args[1] ? (ev.streak ?? 0) + 1 : 0;
        if (ev.streak >= 3) { ev.done = true; this.anchorAt = t; this.log(`[input] waitframe ${ev.args.join(',')}: ${dpf.toFixed(0)} draws/frame, anchor at ${t.toFixed(0)}s`); }
        break;
      }
      if (ev.kind === 'waitfps') { // F: more than F Direct3D frames per second, three 1-second windows in a row
        if (t < due) break;
        if (!d3d) break;
        if (ev.at !== undefined && t - ev.at < 1) break;
        const prev = ev.prev; ev.prev = { frames: d3d.frames }; const dt = ev.at === undefined ? 0 : t - ev.at; ev.at = t;
        if (!prev || !dt) break;
        const fps = (d3d.frames - prev.frames) / dt;
        ev.streak = fps > ev.args[0] ? (ev.streak ?? 0) + 1 : 0;
        if (ev.streak >= 3) { ev.done = true; this.anchorAt = t; this.log(`[input] waitfps ${ev.args[0]}: ${fps.toFixed(1)} fps, anchor at ${t.toFixed(0)}s`); }
        break;
      }
      if (t < due) break;
      ev.done = true;
      this.fire(ev, t);
      if (this.finished) this.mark('end', t); // (the last phase closed)
    }
  }
  fire(ev, t) {
    const [x, y] = ev.args, at = this.nowMs();
    switch (ev.kind) {
      case 'move': this.push({ type: 'mousemove', x, y, dx: 0, dy: 0 }); break;
      case 'click': case 'rclick': {
        const b = ev.kind === 'click' ? 0 : 1;
        this.push({ type: 'mousemove', x, y, dx: 0, dy: 0 }); this.push({ type: 'mousedown', button: b, x, y });
        this.pending.push([at + 80, { type: 'mouseup', button: b, x, y }]); break;
      }
      case 'down': this.push({ type: 'mousemove', x, y, dx: 0, dy: 0 }); this.push({ type: 'mousedown', button: 0, x, y }); break;
      case 'up': this.push({ type: 'mousemove', x, y, dx: 0, dy: 0 }); this.push({ type: 'mouseup', button: 0, x, y }); break;
      case 'key': { const vk = x, scan = y || scanCodeOfVk(vk); this.push({ type: 'keydown', vk, scan, extended: false, repeat: 0 }); this.pending.push([at + 80, { type: 'keyup', vk, scan, extended: false }]); break; }
      case 'keydown': { const vk = x, scan = y || scanCodeOfVk(vk); this.push({ type: 'keydown', vk, scan, extended: false, repeat: 0 }); break; }
      case 'keyup': { const vk = x, scan = y || scanCodeOfVk(vk); this.push({ type: 'keyup', vk, scan, extended: false }); break; }
      case 'text': {
        let k = 0;
        for (const ch of ev.args[0]) {
          const vk = ch.toUpperCase().charCodeAt(0), scan = scanCodeOfVk(vk), when = at + 60 * k++;
          this.pending.push([when, { type: 'keydown', vk, scan, extended: false, repeat: 0 }], [when, { type: 'char', code: ch.charCodeAt(0) }], [when + 30, { type: 'keyup', vk, scan, extended: false }]);
        }
        this.pending.sort((a, b) => a[0] - b[0]);
        break;
      }
      case 'dbg': {
        const [k, v] = ev.args[0].split('=');
        if (k === 'ORTHROS_JIT_AB' && this.vm.jit) {
          const o = v ? JSON.parse(v) : null;
          // (translations with block counters from now on: the counter area restarts, so that it holds the regions of this phase)
          if (o?.blockCounts) this.vm.mem.i32[BLOCK_COUNTS_BASE >>> 2] = 0;
          this.vm.jit.switchOpts(o); this.log(`[input] dbg ${k}=${v ?? ''}`);
        }
        // the block heat of the translations with counters made so far (Jit.collectHeat, for opts.coldExits)
        if (k === 'ORTHROS_JIT_HEAT' && this.vm.jit) this.log(`[input] dbg ${k}: ${this.vm.jit.collectHeat()} instructions executed`);
        // the visit flags of the translations made so far (opts.visit), added to the heat (Jit.harvestVisits)
        if (k === 'ORTHROS_JIT_HARVEST' && this.vm.jit) this.log(`[input] dbg ${k}: ${this.vm.jit.harvestVisits().length / 2} blocks visited`);
        // the API-layer switches, as the browser worker sets them (ORTHROS_API_OPT_OFF, ORTHROS_FX_BIND_OFF, ...: src/core/api-opt.js)
        if (/^ORTHROS_(API_OPT_OFF|FX_BIND_OFF|GL_NOCACHE|D3DX_FAST_OFF|API_FAST_OFF|DRAW_OPT_OFF)$/.test(k)) {
          globalThis[k] = v === undefined || v === '' ? undefined : Number(v);
          refreshApiOpt();
          if (k === 'ORTHROS_D3DX_FAST_OFF' || k === 'ORTHROS_API_OPT_OFF') this.vm.jit?.setD3dxFast?.(!globalThis[k]);
          if (k === 'ORTHROS_API_FAST_OFF') this.vm.setApiFastPaths?.(!globalThis[k]);
          if (k === 'ORTHROS_DRAW_OPT_OFF') this.vm.jit?.setDrawOpt?.(!globalThis[k]);
          this.log(`[input] dbg ${k}=${v ?? ''}`);
        } else if (/^ORTHROS_[A-Z0-9_]+$/.test(k) && !/^ORTHROS_(JIT_AB|JIT_HEAT|JIT_HARVEST)$/.test(k)) { // (other worker debug globals, as the browser worker sets them)
          globalThis[k] = v === undefined || v === '' ? undefined : Number.isNaN(Number(v)) ? v : Number(v);
          this.log(`[input] dbg ${k}=${v ?? ''}`);
        }
        break;
      }
      case 'mark': this.mark(ev.args[0], t); break;
      default: break; // (shot, profile, capture...: browser only)
    }
  }
  /** Close the running phase (its guest instructions, guest-category time per instruction) and open `label`. */
  mark(label, t) {
    const cats = acct.frame(), d3d = this.vm.d3dDevice;
    const cpu = process.cpuUsage();
    // (the emulator thread's own CPU time: unlike the categories' wall-clock time, not inflated while the thread waits
    // for a core on a loaded machine)
    const tcpu = process.threadCpuUsage?.() ?? null;
    if (this.phase) {
      const p = this.phase, g = this.vm.guestInsns - p.g0, frames = (d3d?.frames ?? 0) - p.f0, secs = t - p.t;
      const cpuS = (cpu.user - p.cpu.user) / 1e6;
      const threadCpuS = tcpu && p.tcpu ? (tcpu.user + tcpu.system - p.tcpu.user - p.tcpu.system) / 1e6 : null;
      const r = { label: p.label, seconds: secs, startMs: p.epoch, endMs: Date.now(), frames, guestInsns: g, guestMs: cats[ACCT.guest], guestMsPerMInsn: g ? cats[ACCT.guest] * 1e6 / g : 0, cpuS, threadCpuS, apiMs: cats[ACCT.api], waitMs: cats[ACCT.wait], jitMs: cats[ACCT.jit], interpMs: cats[ACCT.interp] };
      const dts = this.frameDts.sort((a, b) => a - b), q = (x) => dts.length ? dts[Math.min(dts.length - 1, Math.floor(x * dts.length))] : 0;
      r.dt = { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: dts[dts.length - 1] ?? 0, over34: dts.filter((d) => d > 34).length, over40: dts.filter((d) => d > 40).length };
      r.apiTop = this.apiTop();
      this.results.push(r);
      this.log(`[frames] node phase ${p.label}: ${secs.toFixed(1)} s, ${frames} frames, ${(g / 1e6).toFixed(0)} M guest instructions, guest ${(cats[ACCT.guest] / 1000).toFixed(2)} s = ${r.guestMsPerMInsn.toFixed(3)} ns per instruction; api ${(cats[ACCT.api] / 1000).toFixed(2)} s, jit ${(cats[ACCT.jit] / 1000).toFixed(2)} s, interp ${(cats[ACCT.interp] / 1000).toFixed(2)} s, wait ${(cats[ACCT.wait] / 1000).toFixed(2)} s, CPU ${cpuS.toFixed(1)} s${threadCpuS !== null ? `, thread CPU ${threadCpuS.toFixed(1)} s` : ''}; frame ms p50 ${r.dt.p50.toFixed(1)} p90 ${r.dt.p90.toFixed(1)} p99 ${r.dt.p99.toFixed(1)} max ${r.dt.max.toFixed(0)}, > 34 ms ${r.dt.over34}, > 40 ms ${r.dt.over40}`);
      this.log(`[apitop] ${p.label} (ms per frame, calls per frame, µs per call): ${r.apiTop.map(([k, ms, c, us]) => `${k} ${(ms / Math.max(1, frames)).toFixed(2)} (${(c / Math.max(1, frames)).toFixed(0)}, ${us.toFixed(1)})`).join(', ')}`);
      // (--jit-profile: the phase's transitions by kind, chained transitions and fallback steps)
      if (this.jitProf) this.log(`[jitprof] ${p.label}: ${this.jitProf()}`);
    }
    if (!this.phase) { this.apiTop(); this.jitProf?.(); }
    this.frameDts = [];
    this.phase = { label, t, g0: this.vm.guestInsns, f0: d3d?.frames ?? 0, cpu, tcpu, epoch: Date.now() }; // (epoch ms: phases matched with outside measurements, perf stat -I)
  }
  /**
   * The APIs that took the most time since the previous call (as the browser worker's phase report): each API's timed
   * calls (frame-acct.js samples them) scaled to all its calls; [name, ms, calls, µs per call], most time first.
   */
  apiTop(n = 30) {
    const cur = { ms: Float64Array.from(acct.idxMs), n: Float64Array.from(acct.idxN), calls: Float64Array.from(acct.idxCalls) }, prev = this.apiPrev; this.apiPrev = cur;
    const out = [];
    for (let i = 0; i < cur.calls.length; i++) {
      const calls = cur.calls[i] - (prev?.calls[i] ?? 0), k = (cur.n[i] ?? 0) - (prev?.n[i] ?? 0), ms = (cur.ms[i] ?? 0) - (prev?.ms[i] ?? 0);
      if (calls > 0 && k > 0) { const t = this.vm.api.thunk(i); out.push([t ? t.name : String(i), ms * Math.max(1, calls / k), calls, 1000 * ms / k]); }
    }
    return out.sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  /** Every event fired (the scenario is over). */
  get finished() { return this.events.every((e) => e.done); }
}
