// Bench mode of the page (docs/real-machine-bench.md): `?bench=<name>` plays a scripted scenario of
// tools/scenarios/bench/ in the player's own browser — the harness's scenario language (src/host/scenario.js), the
// harness's phase marks (each mark closes a phase measured by the worker's frame accounting) — shows a banner while it
// runs and a summary at the end, and sends one `bench` telemetry record: the per-phase results with the machine.
// The bench suite (bench-suite.js: every game in a row, ?benchsuite=) runs the same BenchRun for the browser ports, its
// frames measured by page-meter.js and its input given to the port's page (dom-input.js), its banner its own.
import { parseScenario, unsupportedSteps, ScenarioPlayer, PLAYER_KINDS, PORT_KINDS } from '../scenario.js';
import { PerfWindow, compactPhase } from '../perf-summary.js';
import { scanCodeOfVk } from '../../win32/vk-scan.js';
import { benchNetwork, fmtRate, fmtBytes, received } from './net-status.js';
import { AudioStats } from './sound.js';
import { pickLang } from './lang.js';
import { runTimingProbe, probeLine } from './timing-probe.js';

// (the page's words: English or French, as the rest of the page — lang.js)
const FR = pickLang() === 'fr';
const W = FR ? {
  noList: (st) => `la liste des mesures est indisponible (HTTP ${st})`, noBench: (n, list) => `aucune mesure nommée « ${n} » — disponibles : ${list}`,
  notFor: (n, m, v) => `la mesure « ${n} » est pour ${m}, pas ${v}`, cannot: (f, why) => `le scénario ${f} ne peut pas être joué ici : ${why}`, harnessOnly: (src) => `étape « ${src} » (banc de test seulement)`,
  title: 'Mesure de performance', about: (m) => `Environ ${m} minute${m > 1 ? 's' : ''} (plus au premier lancement : les fichiers du jeu se téléchargent d’abord). Le jeu est joué automatiquement : ne touche ni à la souris ni au clavier et garde cet onglet au premier plan jusqu’au bilan.`,
  start: 'Lancer la mesure', cancel: 'Annuler', running: 'Mesure en cours — ne touche à rien', stop: 'Arrêter la mesure', stoppedByPlayer: 'arrêtée par le joueur',
  done: (ok, why) => (ok ? 'Mesure terminée' : `Mesure arrêtée (${why})`), gpuUnknown: 'GPU inconnu', cores: 'cœurs', render: 'rendu', inThread: 'dans le fil', display: 'affichage',
  connection: 'connexion', roundTrip: 'aller-retour', receivedLine: (all, game, bg) => `${all} reçus (lectures du jeu ${game}, arrière-plan ${bg})`,
  hidden: (s, b) => `attention : l’onglet a été masqué ${s} s / a perdu le focus ${b} fois : ces phases ne sont pas représentatives`,
  head: ['phase', 'durée', 'img/s', 'image ms p50 / p90 / p99', '&gt;33 ms /min', '&gt;40', '&gt;50', '&gt;100', 'GPU ms p50 / p99', 'dessins /image', 'réveils en retard ms/image (attente active)', 'image moyenne (ms)'],
  timer: 'minuteries de ce navigateur (retard ms)',
  sent: 'Les résultats ont été envoyés au serveur. Merci !', notSent: 'Les résultats n’ont pas pu être envoyés (télémétrie désactivée sur ce serveur) : utilise « Copier les résultats ».',
  yours: 'Le jeu est à toi maintenant : clique dedans pour capturer la souris, Échap la libère.', copy: 'Copier les résultats', close: 'Fermer et jouer', copied: 'Copié', copyFailed: 'Échec de la copie',
} : {
  noList: (st) => `the list of measurements is unavailable (HTTP ${st})`, noBench: (n, list) => `no measurement named "${n}" — available: ${list}`,
  notFor: (n, m, v) => `the measurement "${n}" is for ${m}, not ${v}`, cannot: (f, why) => `the scenario ${f} cannot be played here: ${why}`, harnessOnly: (src) => `step "${src}" (harness only)`,
  title: 'Performance measurement', about: (m) => `About ${m} minute${m > 1 ? 's' : ''} (longer on a first launch: the game files download first). The game is played automatically: do not touch the mouse or the keyboard and keep this tab in front until the summary appears.`,
  start: 'Start the measurement', cancel: 'Cancel', running: 'Measurement in progress — do not touch', stop: 'Stop the measurement', stoppedByPlayer: 'stopped by the player',
  done: (ok, why) => (ok ? 'Measurement complete' : `Measurement stopped (${why})`), gpuUnknown: 'GPU unknown', cores: 'cores', render: 'render', inThread: 'in-thread', display: 'display',
  connection: 'connection', roundTrip: 'round trip', receivedLine: (all, game, bg) => `${all} received (game reads ${game}, background ${bg})`,
  hidden: (s, b) => `warning: the tab was hidden ${s} s / lost the focus ${b} time(s): those phases are not representative`,
  head: ['phase', 'time', 'fps', 'frame ms p50 / p90 / p99', '&gt;33 ms /min', '&gt;40', '&gt;50', '&gt;100', 'GPU ms p50 / p99', 'draws /frame', 'wake-ups late ms/frame (spin)', 'mean frame (ms)'],
  timer: 'this browser\'s timers (lateness ms)',
  sent: 'The results were sent to the server. Thank you!', notSent: 'The results could not be sent (telemetry is off on this server): use "Copy the results".',
  yours: 'The game is yours now: click it to capture the mouse, Escape releases it.', copy: 'Copy the results', close: 'Close and play', copied: 'Copied', copyFailed: 'Copy failed',
};

export const BENCH_DIR = '/tools/scenarios/bench/';
/** the pointer steps, and the least time between two of them (ms) */
const INPUT_KINDS = new Set(['move', 'click', 'rclick', 'down', 'up']), INPUT_GAP_MS = 300;

/**
 * The bench `name` (tools/scenarios/bench/index.json), its scenario parsed. `manifest`: the version asked for in the
 * URL, if any (it must be one the bench lists). Throws a message for the player when the bench cannot run.
 */
export async function loadBench(name, manifest = null, fetcher = fetch) {
  const res = await fetcher(BENCH_DIR + 'index.json');
  if (!res.ok) throw new Error(W.noList(res.status));
  const list = (await res.json()).benches ?? [];
  const def = list.find((b) => b.name === name);
  if (!def) throw new Error(W.noBench(name, list.map((b) => b.name).join(', ')));
  if (manifest && !def.manifests.includes(manifest)) throw new Error(W.notFor(name, def.manifests.join(', '), manifest));
  const text = await (await fetcher(BENCH_DIR + def.file)).text();
  const { steps, errors } = parseScenario(text);
  // (a browser port's bench — `runtime` re3, goldsrc, openmw; `page`: its page under the version's launch address —
  // plays the ports' steps too)
  const bad = unsupportedSteps(steps, def.runtime && def.runtime !== 'win32' ? PORT_KINDS : PLAYER_KINDS);
  if (errors.length || bad.length) throw new Error(W.cannot(def.file, [...errors, ...bad.map((s) => W.harnessOnly(s.src))].join('; ')));
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
 * The game's input from the Win32 page's input ring (push / EV / typeText): what BenchRun gives its steps to. A port's
 * page gets the same calls from dom-input.js.
 */
export function ringInput(push, EV, typeText) {
  return {
    move: (x, y) => push(EV.MOUSEMOVE, x, y, 0),
    button: (b, down, x, y) => { push(EV.MOUSEMOVE, x, y, 0); push(down ? EV.MOUSEDOWN : EV.MOUSEUP, b, x, y); },
    key: (vk, scan, down) => push(down ? EV.KEYDOWN : EV.KEYUP, vk, scan || scanCodeOfVk(vk), 0),
    text: (s) => typeText(s),
  };
}

/**
 * One bench run in this page. `deps`: the page's pieces — state (window.orthros: mode, stats, status, manifest...),
 * input (move, button, key, text and, for a port, command / look / glide — or push / EV / typeText: the input ring),
 * postWorker ({ type: 'mark' }: the phase's report comes back through onPhase), sendRecord(record) → Promise<boolean>
 * (telemetry; false: not sent), machine() → Promise<object>, headless (no banner interaction: starts at once), quiet
 * (no banner nor summary: the bench suite shows its own), suite (the suite run this bench is part of, kept in the
 * record), capture() (the mouse captured: the summary closed to play).
 */
export class BenchRun {
  constructor(def, deps) {
    this.def = def; this.d = deps; this.state = deps.state;
    this.input = deps.input ?? ringInput(deps.push, deps.EV, deps.typeText);
    this.player = new ScenarioPlayer(def.steps, { from: def.coords ?? null, display: () => (this.state.mode ? [this.state.mode.width, this.state.mode.height] : null) });
    this.win = new PerfWindow(); this.phases = []; this.extras = []; this.marks = []; this.anchors = [];
    this.audio = new AudioStats(); // (the page feeds it: the sound of the run, sent with the record)
    this.label = 'start'; this.hiddenSeconds = 0; this.blurs = 0; this.finished = false; this.t0 = null;
    // (host-timing probes — timing-probe.js: how late this browser wakes a worker up — at the start and at each mark)
    this.probes = []; this.probing = null;
    if (!document.getElementById('benchCss')) { const st = document.createElement('style'); st.id = 'benchCss'; st.textContent = CSS; document.head.appendChild(st); }
    this.el = document.createElement('div'); this.el.id = 'bench'; document.body.appendChild(this.el);
    if (deps.headless || deps.quiet) this.el.style.display = 'none'; // (the harness's bare frame: its screenshots without the banner; the suite's own banner)
  }
  /** The banner before the start: what will happen; `onStart` once the player agrees (a click: audio may start). */
  intro(onStart, onCancel) {
    const minutes = Math.max(1, Math.round((this.def.minutes ?? this.def.maxSeconds / 60)));
    this.el.innerHTML = `<div><b>${W.title}</b> — ${esc(this.def.title ?? this.def.name)}</div><div class="st">${W.about(minutes)}</div><button id="benchStart">${W.start}</button><button class="quiet" id="benchCancel">${W.cancel}</button>`;
    this.el.querySelector('#benchStart').onclick = () => onStart();
    this.el.querySelector('#benchCancel').onclick = () => { this.el.remove(); onCancel?.(); };
  }
  /** The game is starting: the scenario's clock begins (its times count from the launch, as in the harness). */
  begin() {
    this.t0 = performance.now(); this.state.benchActive = true;
    this.el.innerHTML = `<div><b>${W.running}</b></div><div class="st"></div><button class="quiet" id="benchAbort">${W.stop}</button>`;
    this.el.querySelector('#benchAbort').onclick = () => this.finish('aborted', W.stoppedByPlayer);
    this.onVis = () => { if (document.visibilityState === 'hidden') this.hiddenAt = performance.now(); else if (this.hiddenAt) { this.hiddenSeconds += (performance.now() - this.hiddenAt) / 1000; this.hiddenAt = null; } };
    // (a focus loss: the page's focus gone elsewhere — not into a frame of its own: the bench suite's game page)
    this.onBlur = () => setTimeout(() => { if (!document.hasFocus()) this.blurs++; }, 0);
    document.addEventListener('visibilitychange', this.onVis); addEventListener('blur', this.onBlur);
    this.timer = setInterval(() => this.tick(), 100);
    this.probe('start');
  }
  /** A host-timing probe now (one at a time; `label`: the phase it opens), kept with the record. */
  probe(label) {
    if (this.probing || this.d.timingProbe === null) return;
    const q = Number((/(?:^|,)ORTHROS_HOST_TIMER_Q=([\d.]+)/.exec(new URLSearchParams(globalThis.location?.search ?? '').get('dbg') ?? '') ?? [])[1]) || 0;
    const at = this.t0 === null ? 0 : Math.round((performance.now() - this.t0) / 100) / 10;
    this.probing = (this.d.timingProbe ?? runTimingProbe)(q).then((r) => { if (r) this.probes.push({ label, at, ...r }); }).catch(() => {}).finally(() => { this.probing = null; });
  }
  onStats(m) { if (this.t0 !== null && !this.finished) this.win.add(m, { t: Date.now(), visible: document.visibilityState === 'visible', fullscreen: !!document.fullscreenElement, status: this.state.status }); }
  onPhase(rep) { this.phases.push(rep); }
  tick() {
    if (this.finished) return;
    const now = (performance.now() - this.t0) / 1000, st = this.state;
    if (st.status === 'exited' || st.status === 'crashed') { this.finish(st.status, st.status === 'crashed' ? 'emulation error' : `the game exited (code ${st.exitCode})`); return; }
    if (now > (this.def.maxSeconds ?? 900)) { const w = this.player.waiting; this.finish('timeout', `not finished after ${this.def.maxSeconds ?? 900} s${w ? `; waiting at step "${w.src}"` : ''}`); return; }
    // (pointer steps that fell due together — the page's timer late under load — go one per INPUT_GAP_MS: two clicks
    // delivered in the same instant reach the game as down, down, up, up, and the menu takes neither)
    (this.pending ??= []).push(...this.player.tick(now, st.stats));
    while (this.pending.length) {
      const a = this.pending[0], input = INPUT_KINDS.has(a.kind);
      if (input && performance.now() - (this.lastInputAt ?? -1e9) < INPUT_GAP_MS) break;
      this.pending.shift(); this.perform(a);
      if (input) this.lastInputAt = performance.now();
    }
    if (this.player.done && !this.pending.length) { this.finish('done', null); return; }
    if (Math.floor(now) === this.shownAt) return; // (the banner's line once a second)
    this.shownAt = Math.floor(now);
    const [k, n] = this.player.progress, w = this.player.waiting;
    const line = this.el.querySelector('.st');
    // (the game waiting for its files: the banner says so, with the rate — a slow link's results read as such)
    const net = st.stats?.net, dl = net?.waiting ? ` · downloading game data ${net.bw > 0 ? fmtRate(net.bw) : ''} (${fmtBytes(received(net))} received)` : '';
    if (line) line.textContent = `${fmtTime(now)} · phase ${this.label} · step ${k}/${n}${w ? ` · waiting for ${w.kind === 'waitfps' ? 'the game to run' : 'the next screen'}` : ''}${dl}${st.stats ? ` · ${Math.round(st.stats.fps ?? 0)} fps` : ''}`;
  }
  perform(a) {
    const inp = this.input, [x, y] = a.args;
    switch (a.kind) {
      case 'move': inp.move(x, y); break;
      // (a click holds the button ~100 ms and a key press likewise, as the harness and a person do)
      case 'click': case 'rclick': { const b = a.kind === 'click' ? 0 : 1; inp.button(b, true, x, y); setTimeout(() => inp.button(b, false, x, y), 100); break; }
      case 'down': inp.button(0, true, x, y); break;
      case 'up': inp.button(0, false, x, y); break;
      case 'key': { const vk = a.args[0], scan = a.args[1] || 0; inp.key(vk, scan, true); setTimeout(() => inp.key(vk, scan, false), 100); break; }
      case 'keydown': case 'keyup': inp.key(a.args[0], a.args[1] || 0, a.kind === 'keydown'); break;
      case 'text': inp.text(String(a.args[0])); break;
      // (a port's own: its console, a captured mouse's look, its debug teleport — page-meter.js's hooks)
      case 'cmd': inp.command?.(String(a.args[0])); break;
      case 'look': inp.look?.(...a.args); break;
      case 'glide': inp.glide?.(a.args); break;
      case 'mark': this.mark(String(a.args[0]), a.at); break;
      case 'waitfps': case 'waitframe': this.anchors.push({ step: a.step.src, at: Math.round(a.at * 10) / 10 }); break;
      default: break; // (shot, blur, focus: harness steps without effect here)
    }
  }
  /** A phase boundary: the worker closes the phase (its frame report comes back as a 'phase' message). */
  mark(label, at) {
    this.d.postWorker({ type: 'mark', label });
    this.extras.push({ label: this.label, at: this.marks.length ? this.marks[this.marks.length - 1].at : 0, window: this.win.take() });
    // (what the network had carried by then: the time of a phase on a slow link reads with it)
    const net = this.state.stats?.net;
    // (a port's: the reads its engine waited for, page-meter.js — the same keys)
    const data = this.state.stats?.data;
    this.marks.push({ label, at: Math.round(at * 10) / 10, ...(net ? { netBytes: received(net), netDemandMs: Math.round(net.demandMs ?? 0) } : data ? { netBytes: data.bytes ?? 0, netDemandMs: Math.round(data.waitMs ?? 0), dataWaits: data.waits ?? 0 } : {}) });
    this.label = label;
    if (label !== 'end') this.probe(label);
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
    if (this.probing) await Promise.race([this.probing, new Promise((r) => setTimeout(r, 5000))]);
    const phases = [];
    for (let i = 0; i < this.extras.length; i++) {
      const rep = this.phases[i], x = this.extras[i], w = x.window;
      if (x.label === 'end') continue;
      // (the time the game waited for its data in the phase: the network's demand reads, a port's engine's reads)
      const m0 = this.marks[i - 1], m1 = this.marks[i];
      const dataWaitMs = m1?.netDemandMs !== undefined ? m1.netDemandMs - (m0?.netDemandMs ?? 0) : null;
      phases.push({ ...(compactPhase(rep) ?? { label: x.label }), label: x.label, at: x.at, drawsPerFrame: w?.drawsPerFrame ?? null, gpu: w?.gpu ?? null, glCalls: w?.glCalls ?? null, render: w?.render ?? null, busy: w?.busy ?? null, visible: w?.visible ?? null, dataWaitMs });
    }
    const st = this.state;
    const record = {
      event: 'bench', bench: this.def.name, title: this.def.title ?? null, runtime: this.def.runtime ?? st.runtime ?? 'win32', manifest: st.manifest, version: st.version ?? null, outcome, detail,
      ...(this.d.suite ? { suite: this.d.suite } : {}), // (bench-suite.js: { run, name, index, of } — the suite run this bench is part of)
      seconds: Math.round(seconds), firstLaunch: !!st.firstLaunch, display: st.mode ? `${st.mode.width}x${st.mode.height}` : null,
      options: st.perfOptions ?? null, marks: this.marks, anchors: this.anchors, phases,
      interrupted: { hiddenSeconds: Math.round(this.hiddenSeconds), blurs: this.blurs },
      audio: this.audio.take(), // (sound.js: context state, worklet output, mix level, buffers over the run)
      network: benchNetwork(st.stats?.net), // (the measured link: bytes/s, round trip, the game's reads and the background downloads)
      hostTiming: this.probes, // (timing-probe.js: Atomics.wait / setTimeout / hop lateness and the battery, at the start and each mark)
      env: await this.d.machine().catch(() => null),
    };
    // (the WebGL renderer the game drew with: a port's context's, page-meter.js; the Win32 page's machine line's)
    record.renderer = st.renderer ?? record.env?.gpu ?? null;
    st.benchResult = record;
    let sent = false;
    try { sent = await this.d.sendRecord(record); } catch { sent = false; }
    record.sent = sent; st.benchSent = sent;
    this.d.log?.('bench', `${outcome}${detail ? ` (${detail})` : ''}: ${phases.map((p) => `${p.label} ${p.seconds ?? '?'} s ${p.fps ?? '?'} fps p99 ${p.dt?.p99 ?? '?'} ms`).join('; ')}; record ${sent ? 'sent' : 'not sent (telemetry off)'}`);
    this.el.remove();
    this.d.onDone?.(record);
    if (!this.d.headless && !this.d.quiet) this.showResult(record);
  }
  showResult(r) {
    const el = document.createElement('div'); el.id = 'benchResult';
    const cls = (fps) => (fps >= 29.5 ? 'good' : fps >= 20 ? 'warn' : 'bad');
    const rows = r.phases.map((p) => `<tr><td>${esc(p.label)}</td><td>${p.seconds ?? '–'} s</td><td class="${cls(p.fps ?? 0)}">${p.fps ?? '–'}</td><td>${p.dt ? `${p.dt.p50} / ${p.dt.p90} / ${p.dt.p99}` : '–'}</td><td>${p.per33 ?? '–'}</td><td>${p.per40 ?? '–'}</td><td>${p.per50 ?? '–'}</td><td>${p.per100 ?? '–'}</td><td>${p.gpu?.state === 'on' && p.gpu.frames ? `${p.gpu.p50} / ${p.gpu.p99}` : p.gpu?.state === 'unavailable' ? 'n/a' : '–'}</td><td>${p.drawsPerFrame ?? '–'}</td><td>${p.hostWait ? `${p.hostWait.lateMsPerFrame} (${p.hostWait.spinMsPerFrame})` : '–'}</td><td class="l">${p.mean ? Object.entries(p.mean).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ') : ''}</td></tr>`).join('');
    const e = r.env ?? {};
    el.innerHTML = `<h2>${W.done(r.outcome === 'done', esc(r.outcome))} — ${esc(r.title ?? r.bench)}</h2>
<div class="m">${esc(r.detail ?? '')}${r.detail ? '\n' : ''}${esc(e.gpu ?? W.gpuUnknown)} · ${e.cores ?? '?'} ${W.cores}${e.memGB ? ` · ${e.memGB} GB` : ''} · ${esc(e.screen ?? '')} · ${W.render} ${r.options?.renderWorker ? 'worker' : W.inThread} · ${W.display} ${esc(r.display ?? '?')}${r.network?.bw ? `\n${W.connection} ${fmtRate(r.network.bw)}${r.network.rtt ? `, ${W.roundTrip} ${r.network.rtt} ms` : ''}: ${W.receivedLine(fmtBytes(r.network.demandBytes + r.network.bgBytes), fmtBytes(r.network.demandBytes), fmtBytes(r.network.bgBytes))}` : ''}${r.interrupted.hiddenSeconds || r.interrupted.blurs ? `\n${W.hidden(r.interrupted.hiddenSeconds, r.interrupted.blurs)}` : ''}</div>
<table><tr>${W.head.map((x) => `<th>${x}</th>`).join('')}</tr>${rows}</table>
${r.hostTiming?.length ? `<div class="m">${W.timer}:\n${r.hostTiming.map((p) => `${esc(p.label)} (${p.at} s): ${esc(probeLine(p))}`).join('\n')}</div>` : ''}
<div class="m">${r.sent ? W.sent : W.notSent}</div>
<div class="m">${W.yours}</div>
<button id="benchCopy">${W.copy}</button><button class="quiet" id="benchClose">${W.close}</button>`;
    document.body.appendChild(el);
    el.querySelector('#benchCopy').onclick = async (ev) => { try { await navigator.clipboard.writeText(JSON.stringify(r, null, 1)); ev.target.textContent = W.copied; } catch { ev.target.textContent = W.copyFailed; } };
    // (the game is the player's from here: closing the summary captures the mouse, as a click in the game does)
    el.querySelector('#benchClose').onclick = () => { el.remove(); this.d.capture?.(); };
  }
}
