// Bench mode of the page (docs/real-machine-bench.md): `?bench=<name>` plays a scripted scenario of
// tools/scenarios/bench/ in the player's own browser — the harness's scenario language (src/host/scenario.js), the
// harness's phase marks (each mark closes a phase measured by the worker's frame accounting) — shows a banner while it
// runs and a summary at the end, and sends one `bench` telemetry record: the per-phase results with the machine.
import { parseScenario, unsupportedSteps, ScenarioPlayer } from '../scenario.js';
import { PerfWindow, compactPhase } from '../perf-summary.js';
import { scanCodeOfVk } from '../../win32/vk-scan.js';

export const BENCH_DIR = '/tools/scenarios/bench/';

/**
 * The bench `name` (tools/scenarios/bench/index.json), its scenario parsed. `manifest`: the version asked for in the
 * URL, if any (it must be one the bench lists). Throws a message for the player when the bench cannot run.
 */
export async function loadBench(name, manifest = null, fetcher = fetch) {
  const res = await fetcher(BENCH_DIR + 'index.json');
  if (!res.ok) throw new Error(`the list of measurements is unavailable (HTTP ${res.status})`);
  const list = (await res.json()).benches ?? [];
  const def = list.find((b) => b.name === name);
  if (!def) throw new Error(`no measurement named "${name}" — available: ${list.map((b) => b.name).join(', ')}`);
  if (manifest && !def.manifests.includes(manifest)) throw new Error(`the measurement "${name}" is for ${def.manifests.join(', ')}, not ${manifest}`);
  const text = await (await fetcher(BENCH_DIR + def.file)).text();
  const { steps, errors } = parseScenario(text);
  const bad = unsupportedSteps(steps);
  if (errors.length || bad.length) throw new Error(`the scenario ${def.file} cannot be played here: ${[...errors, ...bad.map((s) => `step "${s.src}" (harness only)`)].join('; ')}`);
  return { ...def, manifest: manifest ?? def.manifests[0], steps };
}

const CSS = `
#bench { position: fixed; left: 50%; top: 10px; transform: translateX(-50%); z-index: 60; max-width: min(720px, 94vw); background: rgba(14,15,20,.94); border: 1px solid rgba(224,189,110,.55); border-radius: 12px; padding: 10px 16px; color: #e8e2d2; font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.6); text-align: center; }
#bench b { color: #e0bd6e; } #bench .st { font: 12px/1.5 ui-monospace, monospace; color: #b8bcc8; margin-top: 4px; }
#bench button, #benchResult button { margin: 8px 4px 0; font: 600 13px system-ui; color: #e8e2d2; background: rgba(201,165,90,.2); border: 1px solid rgba(201,165,90,.5); padding: 6px 14px; border-radius: 7px; cursor: pointer; }
#bench button.quiet, #benchResult button.quiet { background: transparent; border-color: rgba(255,255,255,.2); color: #b8bcc8; }
#benchResult { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 61; max-width: 96vw; max-height: 90vh; overflow: auto; background: rgba(14,15,20,.97); border: 1px solid rgba(224,189,110,.55); border-radius: 12px; padding: 16px 20px; color: #d9dce3; font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 20px 60px rgba(0,0,0,.7); }
#benchResult h2 { margin: 0 0 6px; font: 700 18px system-ui; color: #f2ead6; } #benchResult .m { font: 12px/1.5 ui-monospace, monospace; color: #9fa4b0; white-space: pre-wrap; }
#benchResult table { border-collapse: collapse; margin: 10px 0; font: 12px ui-monospace, monospace; }
#benchResult th, #benchResult td { padding: 3px 8px; border-bottom: 1px solid rgba(255,255,255,.08); text-align: right; white-space: nowrap; } #benchResult th:first-child, #benchResult td:first-child, #benchResult td.l { text-align: left; }
#benchResult .good { color: #8fd18f; } #benchResult .warn { color: #e0bd6e; } #benchResult .bad { color: #ff8b8b; }
`;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * One bench run in this page. `deps`: the page's pieces — state (window.orthros), push / EV / typeText (input ring),
 * postWorker, sendRecord(record) → Promise<boolean> (telemetry; false: not sent), machine() → Promise<object>,
 * headless (no banner interaction: starts at once).
 */
export class BenchRun {
  constructor(def, deps) {
    this.def = def; this.d = deps; this.state = deps.state;
    this.player = new ScenarioPlayer(def.steps, { from: def.coords ?? null, display: () => (this.state.mode ? [this.state.mode.width, this.state.mode.height] : null) });
    this.win = new PerfWindow(); this.phases = []; this.extras = []; this.marks = []; this.anchors = [];
    this.label = 'start'; this.hiddenSeconds = 0; this.blurs = 0; this.finished = false; this.t0 = null;
    if (!document.getElementById('benchCss')) { const st = document.createElement('style'); st.id = 'benchCss'; st.textContent = CSS; document.head.appendChild(st); }
    this.el = document.createElement('div'); this.el.id = 'bench'; document.body.appendChild(this.el);
  }
  /** The banner before the start: what will happen; `onStart` once the player agrees (a click: audio may start). */
  intro(onStart, onCancel) {
    const minutes = Math.max(1, Math.round((this.def.minutes ?? this.def.maxSeconds / 60)));
    this.el.innerHTML = `<div><b>Performance measurement</b> — ${esc(this.def.title ?? this.def.name)}</div><div class="st">About ${minutes} minute${minutes > 1 ? 's' : ''} (longer on a first launch: the game files download first). The game is played automatically: do not touch the mouse or the keyboard and keep this tab in front until the summary appears.</div><button id="benchStart">Start the measurement</button><button class="quiet" id="benchCancel">Cancel</button>`;
    this.el.querySelector('#benchStart').onclick = () => onStart();
    this.el.querySelector('#benchCancel').onclick = () => { this.el.remove(); onCancel?.(); };
  }
  /** The game is starting: the scenario's clock begins (its times count from the launch, as in the harness). */
  begin() {
    this.t0 = performance.now(); this.state.benchActive = true;
    this.el.innerHTML = '<div><b>Measurement in progress — do not touch</b></div><div class="st"></div><button class="quiet" id="benchAbort">Stop the measurement</button>';
    this.el.querySelector('#benchAbort').onclick = () => this.finish('aborted', 'stopped by the player');
    this.onVis = () => { if (document.visibilityState === 'hidden') this.hiddenAt = performance.now(); else if (this.hiddenAt) { this.hiddenSeconds += (performance.now() - this.hiddenAt) / 1000; this.hiddenAt = null; } };
    this.onBlur = () => { this.blurs++; };
    document.addEventListener('visibilitychange', this.onVis); addEventListener('blur', this.onBlur);
    this.timer = setInterval(() => this.tick(), 100);
  }
  onStats(m) { if (this.t0 !== null && !this.finished) this.win.add(m, { t: Date.now(), visible: document.visibilityState === 'visible', fullscreen: !!document.fullscreenElement, status: this.state.status }); }
  onPhase(rep) { this.phases.push(rep); }
  tick() {
    if (this.finished) return;
    const now = (performance.now() - this.t0) / 1000, st = this.state;
    if (st.status === 'exited' || st.status === 'crashed') { this.finish(st.status, st.status === 'crashed' ? 'emulation error' : `the game exited (code ${st.exitCode})`); return; }
    if (now > (this.def.maxSeconds ?? 900)) { const w = this.player.waiting; this.finish('timeout', `not finished after ${this.def.maxSeconds ?? 900} s${w ? `; waiting at step "${w.src}"` : ''}`); return; }
    for (const a of this.player.tick(now, st.stats)) this.perform(a);
    if (this.player.done) { this.finish('done', null); return; }
    if (Math.floor(now) === this.shownAt) return; // (the banner's line once a second)
    this.shownAt = Math.floor(now);
    const [k, n] = this.player.progress, w = this.player.waiting;
    const line = this.el.querySelector('.st');
    if (line) line.textContent = `${fmtTime(now)} · phase ${this.label} · step ${k}/${n}${w ? ` · waiting for ${w.kind === 'waitfps' ? 'the game to run' : 'the next screen'}` : ''}${st.stats ? ` · ${Math.round(st.stats.fps ?? 0)} fps` : ''}`;
  }
  perform(a) {
    const { push, EV, typeText } = this.d, [x, y] = a.args;
    switch (a.kind) {
      case 'move': push(EV.MOUSEMOVE, x, y, 0); break;
      // (a click holds the button ~100 ms and a key press likewise, as the harness and a person do)
      case 'click': case 'rclick': { const b = a.kind === 'click' ? 0 : 1; push(EV.MOUSEMOVE, x, y, 0); push(EV.MOUSEDOWN, b, x, y); setTimeout(() => push(EV.MOUSEUP, b, x, y), 100); break; }
      case 'down': push(EV.MOUSEMOVE, x, y, 0); push(EV.MOUSEDOWN, 0, x, y); break;
      case 'up': push(EV.MOUSEMOVE, x, y, 0); push(EV.MOUSEUP, 0, x, y); break;
      case 'key': { const vk = a.args[0], scan = a.args[1] || scanCodeOfVk(vk); push(EV.KEYDOWN, vk, scan, 0); setTimeout(() => push(EV.KEYUP, vk, scan, 0), 100); break; }
      case 'keydown': case 'keyup': { const vk = a.args[0], scan = a.args[1] || scanCodeOfVk(vk); push(a.kind === 'keydown' ? EV.KEYDOWN : EV.KEYUP, vk, scan, 0); break; }
      case 'text': typeText(String(a.args[0])); break;
      case 'mark': this.mark(String(a.args[0]), a.at); break;
      case 'waitfps': case 'waitframe': this.anchors.push({ step: a.step.src, at: Math.round(a.at * 10) / 10 }); break;
      default: break; // (shot, blur, focus: harness steps without effect here)
    }
  }
  /** A phase boundary: the worker closes the phase (its frame report comes back as a 'phase' message). */
  mark(label, at) {
    this.d.postWorker({ type: 'mark', label });
    this.extras.push({ label: this.label, at: this.marks.length ? this.marks[this.marks.length - 1].at : 0, window: this.win.take() });
    this.marks.push({ label, at: Math.round(at * 10) / 10 });
    this.label = label;
  }
  async finish(outcome, detail) {
    if (this.finished) return;
    this.finished = true; clearInterval(this.timer); this.state.benchActive = false;
    document.removeEventListener('visibilitychange', this.onVis); removeEventListener('blur', this.onBlur);
    this.onVis?.();
    const seconds = this.t0 === null ? 0 : (performance.now() - this.t0) / 1000;
    // (the last phase closed unless the scenario's last mark was "end")
    if (this.label !== 'end') this.mark('end', seconds);
    for (let i = 0; i < 40 && this.phases.length < this.marks.length; i++) await new Promise((r) => setTimeout(r, 100));
    const phases = [];
    for (let i = 0; i < this.extras.length; i++) {
      const rep = this.phases[i], x = this.extras[i], w = x.window;
      if (x.label === 'end') continue;
      phases.push({ ...(compactPhase(rep) ?? { label: x.label }), label: x.label, at: x.at, drawsPerFrame: w?.drawsPerFrame ?? null, gpu: w?.gpu ?? null, glCalls: w?.glCalls ?? null, render: w?.render ?? null, busy: w?.busy ?? null, visible: w?.visible ?? null });
    }
    const st = this.state;
    const record = {
      event: 'bench', bench: this.def.name, title: this.def.title ?? null, manifest: st.manifest, version: st.version ?? null, outcome, detail,
      seconds: Math.round(seconds), firstLaunch: !!st.firstLaunch, display: st.mode ? `${st.mode.width}x${st.mode.height}` : null,
      options: st.perfOptions ?? null, marks: this.marks, anchors: this.anchors, phases,
      interrupted: { hiddenSeconds: Math.round(this.hiddenSeconds), blurs: this.blurs },
      env: await this.d.machine().catch(() => null),
    };
    st.benchResult = record;
    let sent = false;
    try { sent = await this.d.sendRecord(record); } catch { sent = false; }
    record.sent = sent; st.benchSent = sent;
    this.d.log?.('bench', `${outcome}${detail ? ` (${detail})` : ''}: ${phases.map((p) => `${p.label} ${p.seconds ?? '?'} s ${p.fps ?? '?'} fps p99 ${p.dt?.p99 ?? '?'} ms`).join('; ')}; record ${sent ? 'sent' : 'not sent (telemetry off)'}`);
    this.el.remove();
    if (!this.d.headless) this.showResult(record);
  }
  showResult(r) {
    const el = document.createElement('div'); el.id = 'benchResult';
    const cls = (fps) => (fps >= 29.5 ? 'good' : fps >= 20 ? 'warn' : 'bad');
    const rows = r.phases.map((p) => `<tr><td>${esc(p.label)}</td><td>${p.seconds ?? '–'} s</td><td class="${cls(p.fps ?? 0)}">${p.fps ?? '–'}</td><td>${p.dt ? `${p.dt.p50} / ${p.dt.p90} / ${p.dt.p99}` : '–'}</td><td>${p.per33 ?? '–'}</td><td>${p.per50 ?? '–'}</td><td>${p.per100 ?? '–'}</td><td>${p.gpu?.state === 'on' && p.gpu.frames ? `${p.gpu.p50} / ${p.gpu.p99}` : p.gpu?.state === 'unavailable' ? 'n/a' : '–'}</td><td>${p.drawsPerFrame ?? '–'}</td><td class="l">${p.mean ? Object.entries(p.mean).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ') : ''}</td></tr>`).join('');
    const e = r.env ?? {};
    el.innerHTML = `<h2>Measurement ${r.outcome === 'done' ? 'complete' : `stopped (${esc(r.outcome)})`} — ${esc(r.title ?? r.bench)}</h2>
<div class="m">${esc(r.detail ?? '')}${r.detail ? '\n' : ''}${esc(e.gpu ?? 'GPU unknown')} · ${e.cores ?? '?'} cores${e.memGB ? ` · ${e.memGB} GB` : ''} · ${esc(e.screen ?? '')} · render ${r.options?.renderWorker ? 'worker' : 'in-thread'} · display ${esc(r.display ?? '?')}${r.interrupted.hiddenSeconds || r.interrupted.blurs ? `\nwarning: the tab was hidden ${r.interrupted.hiddenSeconds} s / lost the focus ${r.interrupted.blurs} time(s): those phases are not representative` : ''}</div>
<table><tr><th>phase</th><th>time</th><th>fps</th><th>frame ms p50 / p90 / p99</th><th>&gt;33 ms /min</th><th>&gt;50</th><th>&gt;100</th><th>GPU ms p50 / p99</th><th>draws /frame</th><th>mean frame (ms)</th></tr>${rows}</table>
<div class="m">${r.sent ? 'The results were sent to the server. Thank you!' : 'The results could not be sent (telemetry is off on this server): use "Copy the results".'}</div>
<button id="benchCopy">Copy the results</button><button class="quiet" id="benchClose">Close</button>`;
    document.body.appendChild(el);
    el.querySelector('#benchCopy').onclick = async (ev) => { try { await navigator.clipboard.writeText(JSON.stringify(r, null, 1)); ev.target.textContent = 'Copied'; } catch { ev.target.textContent = 'Copy failed'; } };
    el.querySelector('#benchClose').onclick = () => el.remove();
  }
}
