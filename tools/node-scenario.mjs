// Harness scenarios (tools/scenarios/*.txt, the language of tools/headless.mjs --input) played in Node without a page:
// tools/startbench.mjs --input <file>. Mouse and keyboard events are queued on the headless host as the browser host
// queues them (the steps parsed by the page's own src/host/scenario.js: `#` comment lines, new lines or `;` between
// steps); `waitframe:min,max[,min2,max2...]` anchors on the Direct3D device's draws per frame (vm.d3dDevice), `mark:<label>` closes
// a phase and prints its guest instructions and the guest category's time per instruction (frame accounting, as the
// browser's phase reports), its frame-time percentiles and the APIs that took the most time ([apitop]: ms and calls per
// frame, µs per call), `dbg:ORTHROS_JIT_AB=<json>` switches the JIT's translation options (Jit.switchOpts), the
// API-layer switches (dbg:ORTHROS_API_OPT_OFF=1, ORTHROS_FX_BIND_OFF=1...) and other ORTHROS_* debug globals are set as
// the browser worker sets them. Other
// kinds (shot, profile, capture...) are ignored. Times are real seconds from the start, from the anchor after a wait
// (or `+t` from the first Direct3D frame), as in the harness.
import { acct, C as ACCT, FrameStats, N_CATS } from '../src/core/frame-acct.js';
import { scanCodeOfVk } from '../src/win32/dinput8.js';
import { BLOCK_COUNTS_BASE } from '../src/cpu/memory.js';
import { refreshApiOpt } from '../src/core/api-opt.js';
import { parseScenario, inRanges, ScenarioPlayer } from '../src/host/scenario.js';
import { hostWaiter, injectedQuantum, adaptiveOn } from '../src/core/host-wait.js';

const POINTER_KINDS = new Set(['move', 'click', 'rclick', 'down', 'up']);

export class NodeScenario {
  /**
   * @param {string} text scenario
   * @param {any} vm
   * @param {(line: string) => void} log
   * @param {() => number} [nowMs]
   * @param {{ from?: [number, number] | null }} [opts] from: the display the pointer coordinates were written for (a
   *   bench scenario's `coords`): scaled to the game's display as the page's bench player scales them
   */
  constructor(text, vm, log, nowMs = () => performance.now(), opts = {}) {
    this.vm = vm; this.log = log; this.nowMs = nowMs; // (the time base: wall time, or a virtual clock's for a deterministic run)
    // (the page's own scaling: the device's back buffer once there is one, the host's display before)
    this.scaler = new ScenarioPlayer([], { from: opts.from ?? null, display: () => { const pp = vm.d3dDevice?.pp, d = vm.host.display; return pp?.width ? [pp.width, pp.height] : d ? [d.width, d.height] : null; } });
    const { steps, errors } = parseScenario(text);
    if (errors.length) throw new Error(`scenario: ${errors.join('; ')}`);
    this.events = steps.map((st) => ({ t: st.t, rel: st.rel, anchored: st.anchored, kind: st.kind, args: st.args, done: false }));
    this.t0 = this.nowMs(); this.anchorAt = null; this.firstFrameAt = null;
    this.pending = []; // [time ms, input event] (button releases, key ups)
    this.phase = null; this.nextCheck = 0;
    this.results = [];
    // (frame intervals per phase, from the Direct3D presents: percentiles in the phase report)
    this.frameDts = []; this.lastPresentAt = 0;
    // (every frame's categories, as the browser host keeps them: the phase reports' slow frames by category, the same
    // FrameStats report as the page's [frames] lines; the categories summed per phase for its totals)
    this.frameAcct = new FrameStats(); this.phaseCats = new Float64Array(N_CATS);
    this.slowApis = null; this.gc = null; // (enableSlowApis, enableGc)
    if (!vm.host.frameHook) vm.host.frameHook = () => this.framePresented();
  }
  framePresented() {
    const n = this.nowMs(), cats = acct.frame();
    for (let i = 0; i < N_CATS; i++) this.phaseCats[i] += cats[i];
    const gcMs = this.gc ? this.gcFrame() : 0;
    if (this.lastPresentAt) {
      const dt = n - this.lastPresentAt; this.frameDts.push(dt); this.frameAcct.add(dt, cats, n, acct.lastReads);
      if (this.slowApis) this.slowApiFrame(dt, cats);
      if (this.gc) { const g = this.gc; g.ms += gcMs; g.frames++; if (dt > g.over) { g.slow++; g.slowMs += gcMs; if (gcMs >= 5) g.slowWithGc++; } if (gcMs > g.maxMs) g.maxMs = gcMs; }
    }
    this.lastPresentAt = n;
  }
  /**
   * startbench --slow-apis <ms>: the APIs' time in the frames longer than that (each API's sampled time in the frame,
   * scaled to its calls; the deferred-queue drain and the heavy calls are timed on every call), summed per phase — which
   * calls make the slow frames' `api` and `draw` time.
   */
  slowApiFrame(dt, cats) {
    const s = this.slowApis, ms = acct.idxMs, k = acct.idxN, calls = acct.idxCalls;
    const len = Math.max(ms.length, calls.length);
    if (s.ms.length < len) { const g = (a) => { const b = new Float64Array(len); b.set(a); return b; }; s.ms = g(s.ms); s.n = g(s.n); s.calls = g(s.calls); s.sum = g(s.sum); s.frames = g(s.frames); }
    if (dt > s.over) {
      s.slow++; s.apiMs += cats[ACCT.api] + cats[ACCT.draw];
      for (let i = 0; i < ms.length; i++) {
        const dm = ms[i] - s.ms[i]; if (dm <= 0) continue;
        const dn = k[i] - s.n[i], dc = (calls[i] ?? 0) - s.calls[i], e = dm * Math.max(1, dn > 0 ? dc / dn : 1);
        s.sum[i] += e; s.frames[i]++;
      }
    }
    s.ms.set(ms); s.n.set(k); s.calls.set(calls);
  }
  /**
   * startbench --gc <ms>: the garbage collections of this thread (V8's GCProfiler, restarted at each present: ~5 µs)
   * per frame, by kind; per phase: their time, in the frames longer than `over` ms, the largest one in a frame.
   */
  enableGc(over, v8) { this.gc = { v8, prof: null, over, ms: 0, frames: 0, slow: 0, slowMs: 0, slowWithGc: 0, maxMs: 0, kinds: {} }; this.gcFrame(); }
  gcFrame() {
    const g = this.gc; let ms = 0;
    if (g.prof) for (const s of g.prof.stop().statistics) { ms += s.cost / 1000; g.kinds[s.gcType] = (g.kinds[s.gcType] ?? 0) + s.cost / 1000; }
    g.prof = new g.v8.GCProfiler(); g.prof.start();
    return ms;
  }
  gcReport(label) {
    const g = this.gc; if (!g) return;
    this.log(`[gc] ${label}: ${g.ms.toFixed(0)} ms of garbage collection on the emulator thread in ${g.frames} frames (${(g.ms / Math.max(1, g.frames)).toFixed(2)} ms per frame; ${Object.entries(g.kinds).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}), most in one frame ${g.maxMs.toFixed(1)} ms; frames > ${g.over} ms: ${g.slow}, their GC ${(g.slowMs / Math.max(1, g.slow)).toFixed(2)} ms each, ${g.slowWithGc} of them with 5 ms or more`);
    Object.assign(g, { ms: 0, frames: 0, slow: 0, slowMs: 0, slowWithGc: 0, maxMs: 0, kinds: {} });
  }
  enableSlowApis(over) { const z = () => new Float64Array(0); this.slowApis = { over, slow: 0, apiMs: 0, ms: z(), n: z(), calls: z(), sum: z(), frames: z() }; }
  slowApiReport(label) {
    const s = this.slowApis; if (!s) return;
    const rows = [];
    for (let i = 0; i < s.sum.length; i++) if (s.sum[i] > 0) rows.push([this.vm.acctApiName(i), s.sum[i], s.frames[i]]);
    rows.sort((a, b) => b[1] - a[1]);
    this.log(`[slowapis] ${label}: ${s.slow} frames > ${s.over} ms, api+draw ${(s.apiMs / Math.max(1, s.slow)).toFixed(2)} ms per such frame; by API (ms per such frame, frames it took time in): ${rows.slice(0, 20).map(([nm, v, f]) => `${nm} ${(v / Math.max(1, s.slow)).toFixed(2)} (${f})`).join(', ')}`);
    s.slow = 0; s.apiMs = 0; s.sum.fill(0); s.frames.fill(0);
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
    if (this.firstFrameAt === null && d3d?.frames > 0) { this.firstFrameAt = t; this.log(`[input] first Direct3D frame at ${t.toFixed(1)}s (${(this.vm.guestInsns / 1e6).toFixed(0)} M guest instructions)`); }
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
        ev.streak = inRanges(dpf, ev.args) ? (ev.streak ?? 0) + 1 : 0; // (min,max[,min2,max2...]: any of the ranges)
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
    const [x, y] = POINTER_KINDS.has(ev.kind) ? this.scaler.scale(ev.args[0], ev.args[1]) : ev.args, at = this.nowMs();
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
        if (/^ORTHROS_(API_OPT_OFF|FX_BIND_OFF|GL_NOCACHE|D3DX_FAST_OFF|API_FAST_OFF|DRAW_OPT_OFF|FX_DEFER_OFF)$/.test(k)) {
          globalThis[k] = v === undefined || v === '' ? undefined : Number(v);
          refreshApiOpt();
          if (k === 'ORTHROS_D3DX_FAST_OFF' || k === 'ORTHROS_API_OPT_OFF') this.vm.jit?.setD3dxFast?.(!globalThis[k]);
          if (k === 'ORTHROS_API_FAST_OFF') this.vm.setApiFastPaths?.(!globalThis[k]);
          if (k === 'ORTHROS_DRAW_OPT_OFF') this.vm.jit?.setDrawOpt?.(!globalThis[k]);
          if (k === 'ORTHROS_FX_DEFER_OFF') this.vm.jit?.setFxDefer?.(!globalThis[k]);
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
    // (the phase's frames' categories and the time since the last present; a run without presents: all of it)
    const rest = acct.frame(), cats = Float64Array.from(this.phaseCats, (v, i) => v + rest[i]), d3d = this.vm.d3dDevice;
    this.phaseCats.fill(0);
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
      r.picks = (this.vm.sched?.picks ?? 0) - p.picks; // (scheduling decisions: Sleep(0) spins, yields)
      // (the page's phase report over the same frames: slow frames by category, hitches, worst frames)
      const ph = this.frameAcct.phase(label, this.nowMs());
      r.frameAcct = { ...ph, text: undefined };
      r.dt.over40PerMin = Math.round(r.dt.over40 / Math.max(1e-6, secs / 60));
      r.hostWait = { ...hostWaiter.take(), ...p.hw }; // (the host's wake-ups: overshoot, spins — core/host-wait.js)
      this.results.push(r);
      this.log(`[frames] node mark ${label}: ${ph.text}`);
      this.slowApiReport(p.label); this.gcReport(p.label);
      this.log(`[frames] node phase ${p.label}: ${secs.toFixed(1)} s, ${frames} frames, ${(g / 1e6).toFixed(0)} M guest instructions, guest ${(cats[ACCT.guest] / 1000).toFixed(2)} s = ${r.guestMsPerMInsn.toFixed(3)} ns per instruction; api ${(cats[ACCT.api] / 1000).toFixed(2)} s, jit ${(cats[ACCT.jit] / 1000).toFixed(2)} s, interp ${(cats[ACCT.interp] / 1000).toFixed(2)} s, wait ${(cats[ACCT.wait] / 1000).toFixed(2)} s, CPU ${cpuS.toFixed(1)} s${threadCpuS !== null ? `, thread CPU ${threadCpuS.toFixed(1)} s` : ''}; frame ms p50 ${r.dt.p50.toFixed(1)} p90 ${r.dt.p90.toFixed(1)} p99 ${r.dt.p99.toFixed(1)} max ${r.dt.max.toFixed(0)}, > 34 ms ${r.dt.over34}, > 40 ms ${r.dt.over40}`);
      const hw = r.hostWait.wait;
      if (hw) this.log(`[hostwait] ${p.label}: ${hw.waits} waits, overshoot mean ${hw.overMean} ms max ${hw.overMax} ms, late for the frame ${(hw.lateMs / Math.max(1, frames)).toFixed(2)} ms per frame (estimate ${r.hostWait.est} ms), early ${hw.early}, plain ${hw.plain}, spins ${hw.spins} (${hw.spinMs} ms, ${(hw.spinMs / Math.max(1, frames)).toFixed(2)} ms per frame); injected quantum ${p.hw.q || 'none'}, adaptive ${p.hw.adaptive ? 'on' : 'off'}; > 40 ms per minute ${r.dt.over40PerMin}`);
      this.log(`[apitop] ${p.label} (ms per frame, calls per frame, µs per call): ${r.apiTop.map(([k, ms, c, us]) => `${k} ${(ms / Math.max(1, frames)).toFixed(2)} (${(c / Math.max(1, frames)).toFixed(0)}, ${us.toFixed(1)})`).join(', ')}`);
      // (--jit-profile: the phase's transitions by kind, chained transitions and fallback steps)
      if (this.jitProf) this.log(`[jitprof] ${p.label}: ${this.jitProf()}`);
      for (const f of this.phaseReports ?? []) f(p.label, frames); // (a tool's own per-phase lines: startbench --sleeps, --slow-threads)
      // (startbench --d3dx-prof: D3DX image work by kind, and the surface lock patterns, as the browser worker reports them)
      const prof = this.vm.d3dxProf, ls = d3d?.lockStats, lp = p.locks ?? {};
      if (prof?.size) { this.log(`[d3dx] ${p.label} D3DX image work (ms, count): ${[...prof].sort((a, b) => b[1].ms - a[1].ms).slice(0, 16).map(([k, e]) => `${k}: ${e.ms.toFixed(0)}/${e.n}`).join('; ')}`); prof.clear(); }
      if (ls && this.vm.apiTimes) { const dl = (k) => (ls[k] ?? 0) - (lp[k] ?? 0); this.log(`[d3dx] ${p.label} locks: ${dl('whole')} whole, ${dl('rect')} rect (${(100 * dl('rectPx') / Math.max(1, dl('rectOfPx'))).toFixed(0)}% of their surfaces), ${dl('readOnly')} read-only`); }
    }
    if (!this.phase) {
      this.apiTop(); this.jitProf?.(); this.frameAcct.phase(label, this.nowMs());
      if (this.gc) Object.assign(this.gc, { ms: 0, frames: 0, slow: 0, slowMs: 0, slowWithGc: 0, maxMs: 0, kinds: {} });
      if (this.slowApis) { this.slowApis.slow = 0; this.slowApis.apiMs = 0; this.slowApis.sum.fill(0); this.slowApis.frames.fill(0); }
    }
    this.frameDts = [];
    this.phase = { label, t, g0: this.vm.guestInsns, f0: d3d?.frames ?? 0, cpu, tcpu, epoch: Date.now(), picks: this.vm.sched?.picks ?? 0, hw: { q: injectedQuantum(), adaptive: adaptiveOn() }, locks: { ...(d3d?.lockStats ?? {}) } }; // (epoch ms: phases matched with outside measurements, perf stat -I)
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
      if (calls > 0 && k > 0) { out.push([this.vm.acctApiName(i), ms * Math.max(1, calls / k), calls, 1000 * ms / k]); }
    }
    return out.sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  /** Every event fired (the scenario is over). */
  get finished() { return this.events.every((e) => e.done); }
}
