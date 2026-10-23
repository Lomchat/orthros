// The bench suite (docs/real-machine-bench.md, "The bench suite"): `/?benchsuite=<suite>` measures every game of the
// suite in a row in the player's browser — one link, the tab left in front ~15 minutes. Each game runs in a frame of
// this page, its own page as a player opens it (the Win32 page with its bench mode; a browser port's page), with the
// game's normal profile in this browser; the banner above says which game, how far, the phase. Every game ends with a
// `bench` record of the same shape (bench.js BenchRun: the per-phase frame time percentiles, work, frames > 40 ms, GPU
// time, data waits, the host-timing probe, the renderer): the Win32 page measures its worker's frames and sends its
// own; for a port this page runs the BenchRun, the port's frames measured from outside its page (page-meter.js) and
// its input given to it (dom-input.js), and sends it. A game that fails, stops or overstays is recorded so and the
// next one starts. At the end: the summary, one `bench-suite` record (every game's results), what was sent, a button
// to send again and one to copy. The suites and their benches: tools/scenarios/bench/index.json (`suites`).
// `?benchsuite=<bench>[,<bench>...]` runs those benches as a suite of their own (`&manifest=`, `&gameLang=`: the
// version and the game language of those); `&gldiscard=1` (this server's
// software GPU: the rasterizer discarded) reaches every game; `&benchauto=1` starts without the click.
import { loadBench, BenchRun, BENCH_DIR } from './bench.js';
import { PageMeter } from './page-meter.js';
import { domInput } from './dom-input.js';
import { pickLang } from './lang.js';
import { probeLine } from './timing-probe.js';

const FR = pickLang() === 'fr';
const W = FR ? {
  title: 'Mesure de performance — tous les jeux', noSuite: (n, list) => `aucune suite ni mesure nommée « ${n} » — suites : ${list}`, noList: (st) => `la liste des mesures est indisponible (HTTP ${st})`,
  about: (m, n) => `${n} jeux l’un après l’autre, environ ${m} minutes (plus au premier lancement : les fichiers des jeux se téléchargent d’abord). Les jeux sont joués automatiquement : ne touche ni à la souris ni au clavier, garde cet onglet au premier plan et visible jusqu’au bilan. Tes profils de jeu habituels sont utilisés ; ces sessions sont marquées « mesure ».`,
  start: 'Lancer la mesure', cancel: 'Annuler', skip: 'Passer ce jeu', stop: 'Tout arrêter', loading: 'chargement', phase: 'phase', waiting: 'attente de l’écran suivant',
  done: 'Mesure terminée', stopped: 'Mesure arrêtée', head: ['jeu', 'résultat', 'phase', 'durée', 'img/s', 'image ms p50 / p90 / p99', '&gt;40 ms /min', 'travail ms p50 / p99', 'GPU ms p50 / p99', 'attente données ms'],
  sent: (n) => `Résultats envoyés au serveur (${n} enregistrement${n > 1 ? 's' : ''}). Merci !`, notSent: (k, n) => `${k} enregistrement(s) sur ${n} n’ont pas pu être envoyés.`, resend: 'Renvoyer', copy: 'Copier les résultats', copied: 'Copié', copyFailed: 'Échec de la copie', close: 'Fermer',
  renderer: 'rendu', timers: 'minuteries (retard ms)', hidden: 'attention : l’onglet a été masqué ou a perdu le focus pendant ce jeu', outcomes: { done: 'terminé', timeout: 'trop long', aborted: 'arrêté', skipped: 'passé', exited: 'jeu quitté', crashed: 'erreur', failed: 'échec', lost: 'pas de résultat' },
} : {
  title: 'Performance measurement — every game', noSuite: (n, list) => `no suite nor measurement named "${n}" — suites: ${list}`, noList: (st) => `the list of measurements is unavailable (HTTP ${st})`,
  about: (m, n) => `${n} games one after the other, about ${m} minutes (longer on a first launch: the game files download first). The games are played automatically: do not touch the mouse or the keyboard, keep this tab in front and visible until the summary appears. Your usual game profiles are used; these sessions are marked as measurements.`,
  start: 'Start the measurement', cancel: 'Cancel', skip: 'Skip this game', stop: 'Stop everything', loading: 'loading', phase: 'phase', waiting: 'waiting for the next screen',
  done: 'Measurement complete', stopped: 'Measurement stopped', head: ['game', 'outcome', 'phase', 'time', 'fps', 'frame ms p50 / p90 / p99', '&gt;40 ms /min', 'work ms p50 / p99', 'GPU ms p50 / p99', 'data waits ms'],
  sent: (n) => `The results were sent to the server (${n} record${n > 1 ? 's' : ''}). Thank you!`, notSent: (k, n) => `${k} of ${n} record(s) could not be sent.`, resend: 'Send again', copy: 'Copy the results', copied: 'Copied', copyFailed: 'Copy failed', close: 'Close',
  renderer: 'renderer', timers: 'timers (lateness ms)', hidden: 'warning: the tab was hidden or lost the focus during this game', outcomes: { done: 'done', timeout: 'too long', aborted: 'stopped', skipped: 'skipped', exited: 'game exited', crashed: 'error', failed: 'failed', lost: 'no result' },
};

/** seconds a game's frame is given beyond its bench's maxSeconds before the suite moves on without its record */
export const GRACE_S = 90;
/** the URL parameters of the suite's page passed on to each game's page */
export const PASSED = ['gldiscard', 'glworker', 'dbg', 'encoded', 'prefetch'];

/**
 * The suite `spec` (a suite of index.json, or bench names separated by commas), each bench loaded (bench.js loadBench).
 * `manifest`: the version for a suite of one bench. Throws a message for the player.
 */
export async function loadSuite(spec, { manifest = null, gameLang = null, fetcher = fetch } = {}) {
  const res = await fetcher(BENCH_DIR + 'index.json');
  if (!res.ok) throw new Error(W.noList(res.status));
  const index = await res.json(), suites = index.suites ?? [];
  let suite = suites.find((s) => s.name === spec);
  if (!suite) {
    const names = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length || !names.every((n) => (index.benches ?? []).some((b) => b.name === n))) throw new Error(W.noSuite(spec, suites.map((s) => s.name).join(', ')));
    suite = { name: names.join(','), title: null, benches: names.map((bench) => ({ bench, ...(names.length === 1 && manifest ? { manifest } : {}), ...(gameLang ? { gameLang } : {}) })) };
  }
  const items = [];
  for (const it of suite.benches) items.push({ ...it, def: await loadBench(it.bench, it.manifest ?? null, fetcher) });
  return { name: suite.name, title: suite.title ?? null, items };
}

/** The suite's announced minutes: its benches' `minutes`, summed. */
export const suiteMinutes = (suite) => Math.round(suite.items.reduce((a, it) => a + (it.def.minutes ?? it.def.maxSeconds / 60), 0));

/**
 * The address of a game's page in the suite: the Win32 page in bench mode, or the port's page (`def.page`: under the
 * version's launch address, `launch`: the /api/manifests entry). `run`: { run, name, index, of }; `pass`: the suite
 * page's parameters passed on.
 */
export function itemUrl(item, run, { origin, launch = null, pass = new URLSearchParams() } = {}) {
  const def = item.def, lang = item.gameLang ?? null;
  const q = new URLSearchParams();
  for (const k of PASSED) if (pass.has(k)) q.set(k, pass.get(k));
  q.set('benchrun', run.run); q.set('benchsuitename', run.name); q.set('benchindex', String(run.index)); q.set('benchof', String(run.of));
  if (lang) q.set('gameLang', lang);
  if (!def.runtime || def.runtime === 'win32') {
    const u = new URL('/', origin); u.searchParams.set('bench', def.name); u.searchParams.set('manifest', def.manifest); u.searchParams.set('benchauto', '1');
    for (const [k, v] of q) u.searchParams.set(k, v);
    return u.href;
  }
  const base = (lang && launch?.languageLaunchUrls?.[lang]) || launch?.launchUrl;
  if (!base) throw new Error(`${def.manifest}: no page for this version on this server`);
  const u = new URL(def.page ?? '', new URL(base, origin));
  for (const [k, v] of q) u.searchParams.set(k, v);
  return u.href;
}

const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v ?? null);
/** A game's result in the suite's record and summary: its outcome and, per phase, the figures read first. */
export function compactResult(rec) {
  return {
    bench: rec.bench, title: rec.title ?? null, runtime: rec.runtime ?? 'win32', manifest: rec.manifest ?? null, outcome: rec.outcome, detail: rec.detail ?? null,
    seconds: rec.seconds ?? null, renderer: rec.renderer ?? null, firstLaunch: !!rec.firstLaunch, display: rec.display ?? null,
    interrupted: rec.interrupted ?? null, sent: rec.sent ?? null, session: rec.session ?? null,
    phases: (rec.phases ?? []).map((p) => ({
      label: p.label, seconds: p.seconds ?? null, fps: p.fps ?? null, dt: p.dt ?? null, per40: p.per40 ?? null, slow40: p.slow40 ?? null,
      work: p.work ? { p50: r1(p.work.p50), p99: r1(p.work.p99) } : null,
      gpu: p.gpu?.frames ? { p50: p.gpu.p50, p99: p.gpu.p99, mean: p.gpu.mean, frames: p.gpu.frames } : p.gpu?.state ? { state: p.gpu.state } : null,
      dataWaitMs: p.dataWaitMs ?? null, drawsPerFrame: p.drawsPerFrame ?? null,
    })),
    hostTiming: (rec.hostTiming ?? []).slice(0, 1).map((p) => ({ atomicsWait1: p.atomicsWait1?.p50 ?? null, setTimeout1: p.setTimeout1?.p50 ?? null, battery: p.battery ?? null })),
  };
}

/** The suite's own record: every game's result (compactResult), the machine, the counts. */
export function suiteRecord(suite, run, results, env, { outcome = 'done', seconds = 0, version = null } = {}) {
  const count = (o) => results.filter((r) => r.outcome === o).length;
  return {
    event: 'bench-suite', suite: suite.name, title: suite.title, run, version, outcome, seconds: Math.round(seconds),
    games: results.length, done: count('done'), failed: results.length - count('done'),
    results: results.map(compactResult), env,
  };
}

/** A record lost with its game's page (no result in time): the suite still says what happened. */
export function lostRecord(item, run, detail) {
  return { event: 'bench', bench: item.def.name, title: item.def.title ?? null, runtime: item.def.runtime ?? 'win32', manifest: item.def.manifest, outcome: 'lost', detail, seconds: null, phases: [], marks: [], suite: run };
}

const CSS = `
#suite { position: fixed; left: 50%; top: 6px; transform: translateX(-50%); z-index: 70; max-width: min(820px, 96vw); background: rgba(14,15,20,.95); border: 1px solid rgba(224,189,110,.6); border-radius: 12px; padding: 8px 16px; color: #e8e2d2; font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.6); text-align: center; }
#suite b { color: #e0bd6e; } #suite .st { font: 12px/1.5 ui-monospace, monospace; color: #b8bcc8; margin-top: 2px; } #suite .bar { height: 3px; background: rgba(255,255,255,.1); border-radius: 2px; margin-top: 6px; } #suite .bar i { display: block; height: 100%; background: #e0bd6e; border-radius: 2px; }
#suite ol { text-align: left; margin: 8px auto; display: inline-block; color: #b8bcc8; font-size: 12px; }
#suite button, #suiteResult button { margin: 8px 4px 0; font: 600 13px system-ui; color: #e8e2d2; background: rgba(201,165,90,.2); border: 1px solid rgba(201,165,90,.5); padding: 5px 14px; border-radius: 7px; cursor: pointer; }
#suite button.quiet, #suiteResult button.quiet { background: transparent; border-color: rgba(255,255,255,.2); color: #b8bcc8; }
#suiteFrame { position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; z-index: 10; background: #000; }
#suiteResult { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 71; max-width: 98vw; max-height: 94vh; overflow: auto; background: rgba(14,15,20,.98); border: 1px solid rgba(224,189,110,.55); border-radius: 12px; padding: 16px 20px; color: #d9dce3; font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 20px 60px rgba(0,0,0,.7); }
#suiteResult h2 { margin: 0 0 6px; font: 700 18px system-ui; color: #f2ead6; } #suiteResult .m { font: 12px/1.5 ui-monospace, monospace; color: #9fa4b0; white-space: pre-wrap; }
#suiteResult table { border-collapse: collapse; margin: 10px 0; font: 12px ui-monospace, monospace; }
#suiteResult td.g { white-space: normal; max-width: 210px; }
#suiteResult th, #suiteResult td { padding: 3px 7px; border-bottom: 1px solid rgba(255,255,255,.08); text-align: right; white-space: nowrap; } #suiteResult td.l, #suiteResult th.l { text-align: left; }
#suiteResult tr.first td { border-top: 1px solid rgba(224,189,110,.35); }
#suiteResult .good { color: #8fd18f; } #suiteResult .warn { color: #e0bd6e; } #suiteResult .bad { color: #ff8b8b; }
`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (o) => JSON.parse(JSON.stringify(o)); // (a record of the frame's realm, kept after the frame goes)

/**
 * The page's part (main.js ?benchsuite=): `deps` { machine() → Promise<env>, version, telemetry (the server keeps
 * records), log }.
 */
export async function startSuite(spec, deps) {
  const params = new URLSearchParams(location.search);
  document.getElementById('menu')?.classList.add('hidden');
  if (!document.getElementById('suiteCss')) { const st = document.createElement('style'); st.id = 'suiteCss'; st.textContent = CSS; document.head.appendChild(st); }
  const banner = document.createElement('div'); banner.id = 'suite'; document.body.appendChild(banner);
  let suite;
  try { suite = await loadSuite(spec, { manifest: params.get('manifest'), gameLang: params.get('gameLang') }); } catch (e) { banner.innerHTML = `<b>${W.title}</b><div class="st">${esc(e.message ?? e)}</div>`; return null; }
  const runner = new SuiteRun(suite, { ...deps, banner, params });
  window.orthrosSuite = runner; // (the harness's view: tools/bench-suite-check.mjs)
  if (params.get('benchauto') === '1') runner.run();
  else runner.intro();
  return runner;
}

export class SuiteRun {
  constructor(suite, deps) {
    this.suite = suite; this.d = deps; this.banner = deps.banner; this.params = deps.params ?? new URLSearchParams();
    this.run_ = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.results = []; this.state = 'intro'; this.current = null; this.stopAll = false; this.sends = [];
  }
  get runId() { return this.run_; }
  intro() {
    const m = suiteMinutes(this.suite), n = this.suite.items.length;
    this.banner.innerHTML = `<div><b>${W.title}</b></div><div class="st">${esc(W.about(m, n))}</div><ol>${this.suite.items.map((it) => `<li>${esc(it.def.title ?? it.def.name)}</li>`).join('')}</ol><div><button id="suiteStart">${W.start}</button><button class="quiet" id="suiteCancel">${W.cancel}</button></div>`;
    this.banner.querySelector('#suiteStart').onclick = () => this.run();
    this.banner.querySelector('#suiteCancel').onclick = () => { location.href = '/?menu'; };
  }
  async run() {
    if (this.state !== 'intro') return;
    this.state = 'running'; this.t0 = performance.now();
    this.banner.innerHTML = `<div class="ln"></div><div class="st"></div><div class="bar"><i style="width:0"></i></div><button class="quiet" id="suiteSkip">${W.skip}</button><button class="quiet" id="suiteStop">${W.stop}</button>`;
    this.banner.querySelector('#suiteSkip').onclick = () => this.current?.skip('skipped');
    this.banner.querySelector('#suiteStop').onclick = () => { this.stopAll = true; this.current?.skip('aborted'); };
    let launches = [];
    try { launches = await (await fetch('/api/manifests')).json(); } catch { launches = []; }
    const of = this.suite.items.length;
    for (let i = 0; i < of && !this.stopAll; i++) {
      const item = this.suite.items[i], run = { run: this.run_, name: this.suite.name, index: i + 1, of };
      let rec;
      try { rec = await this.game(item, run, launches.find((m) => m.name === item.def.manifest) ?? null); }
      catch (e) { rec = { ...lostRecord(item, run, String(e?.message ?? e)), outcome: 'failed' }; }
      this.results.push(rec);
      this.d.log?.('bench', `suite ${i + 1}/${of} ${item.def.name}: ${rec.outcome}${rec.detail ? ` (${rec.detail})` : ''}`);
    }
    this.state = 'finishing';
    await this.finish();
  }
  /** The banner's lines now. */
  show(i, of, title, line) {
    const ln = this.banner.querySelector('.ln'), st = this.banner.querySelector('.st'), bar = this.banner.querySelector('.bar i');
    if (ln) ln.innerHTML = `<b>${i}/${of}</b> ${esc(title)} · ${fmtTime((performance.now() - this.t0) / 1000)}`;
    if (st) st.textContent = line;
    if (bar) bar.style.width = `${Math.round(((i - 1) / of) * 100)}%`;
  }
  /** One game: its page in the frame, measured until its record; then the page left as a player leaves it. */
  async game(item, run, launch) {
    const def = item.def, url = itemUrl(item, run, { origin: location.origin, launch, pass: this.params });
    const frame = document.createElement('iframe');
    frame.id = 'suiteFrame'; frame.allow = 'autoplay; fullscreen; cross-origin-isolated; gamepad'; frame.src = url;
    // (the game's page has the focus, as a page a player opened: its window active — not "paused while inactive")
    frame.addEventListener('load', () => { try { frame.contentWindow?.focus(); } catch { /* gone */ } });
    document.body.insertBefore(frame, this.banner);
    const t0 = performance.now(), title = def.title ?? def.name, deadline = ((def.maxSeconds ?? 900) + GRACE_S) * 1000;
    const port = !!def.runtime && def.runtime !== 'win32';
    const g = port ? this.portGame(item, run, frame) : this.win32Game(frame);
    this.current = g;
    let rec = null;
    try {
      while (!rec) {
        await sleep(250);
        rec = g.result();
        const secs = (performance.now() - t0) / 1000;
        this.show(run.index, run.of, title, g.line(secs));
        if (!rec && performance.now() - t0 > deadline) { g.skip('timeout'); for (let k = 0; k < 40 && !(rec = g.result()); k++) await sleep(250); rec ??= lostRecord(item, run, `no result after ${Math.round(deadline / 1000)} s`); }
      }
      rec = plain(rec);
      // (the port's record: sent by this page; the Win32 page sent its own — again here if it could not)
      if (port || rec.sent === false || rec.outcome === 'lost') rec.sent = await this.send(rec, `${this.run_}.${run.index}`);
    } finally {
      this.current = null;
      await g.leave().catch(() => {});
      try { frame.src = 'about:blank'; } catch { /* gone */ }
      await sleep(1500); frame.remove(); await sleep(1500);
    }
    return rec;
  }
  /** A Win32 game: its page plays its bench (bench.js in the frame); its record read there. */
  win32Game(frame) {
    const o = () => { try { return frame.contentWindow?.orthros ?? null; } catch { return null; } };
    let skipped = null;
    return {
      result: () => { const s = o(); return s?.benchResult && s.benchSent !== undefined ? s.benchResult : null; },
      line: (secs) => {
        const s = o(), b = s?.bench, [k, n] = b?.player?.progress ?? [0, 0], w = b?.player?.waiting;
        if (!b?.t0) return `${W.loading} · ${Math.round(secs)} s`;
        return `${W.phase} ${b.label} · ${k}/${n}${w ? ` · ${W.waiting}` : ''}${s.stats ? ` · ${Math.round(s.stats.fps ?? 0)} fps` : ''}`;
      },
      skip: (why) => { skipped = why; o()?.bench?.finish(why === 'timeout' ? 'timeout' : 'aborted', why); },
      leave: async () => { const sh = frame.contentWindow?.orthrosShell; if (sh?.save) await Promise.race([sh.save(), sleep(15000)]); },
      get skipped() { return skipped; },
    };
  }
  /** A browser port: its page in the frame, measured from here (page-meter.js), its bench played by a BenchRun here. */
  portGame(item, run, frame) {
    const def = item.def, discard = this.params.get('gldiscard') === '1';
    const winOf = () => { try { return frame.contentWindow; } catch { return null; } };
    const state = { manifest: def.manifest, version: this.d.version ?? null, runtime: def.runtime, status: 'loading', stats: null, mode: null, renderer: null };
    let meter = null, done = null, input = domInput(winOf);
    const bench = new BenchRun(def, {
      state, input, quiet: true, suite: run, log: this.d.log, machine: this.d.machine,
      postWorker: (m) => { if (m.type === 'mark') bench.onPhase(meter ? meter.phase(m.label) : { label: m.label, frames: 0, text: '' }); },
      sendRecord: async () => true, // (sent by the suite once it has it: game())
      onDone: (rec) => { done = rec; },
    });
    // (the meter in the port's window as soon as its page is there; its status and canvas looked at each time)
    const look = setInterval(() => {
      const w = winOf(); if (!w) return;
      let href = ''; try { href = w.location.href; } catch { return; }
      if (href === 'about:blank' || !w.document) return;
      if (!w.__orthrosPageMeter) {
        meter?.stop(); meter = new PageMeter(w, { discard, onStats: (m) => { state.stats = m; bench.onStats(m); } }); meter.install();
      }
      const c = w.document.querySelector('canvas');
      if (c?.clientWidth) state.mode = { width: c.clientWidth, height: c.clientHeight };
      state.renderer = meter?.renderer ?? state.renderer;
      const ps = w.portSession?.state;
      state.status = ps === 'error' ? 'crashed' : ps === 'ended' ? 'exited' : 'running';
      if (ps === 'ended') state.exitCode = w.portSession.exitCode ?? 0;
    }, 100);
    bench.begin();
    return {
      result: () => (done ? { ...done, display: done.display ?? (state.mode ? `${state.mode.width}x${state.mode.height}` : null) } : null),
      line: () => {
        const [k, n] = bench.player.progress, w = bench.player.waiting, s = state.stats;
        return `${W.phase} ${bench.label} · ${k}/${n}${w ? ` · ${W.waiting}` : ''}${s ? ` · ${Math.round(s.fps ?? 0)} fps` : ''}`;
      },
      skip: (why) => { bench.finish(why === 'timeout' ? 'timeout' : why, why); },
      leave: async () => {
        clearInterval(look); input.release(); meter?.stop();
        const sh = winOf()?.orthrosShell; if (sh?.save) await Promise.race([sh.save(), sleep(15000)]);
      },
    };
  }
  /** One record to the server's telemetry (a session of its own, marked as this suite's); whether it was kept. */
  async send(rec, session) {
    if (!this.d.telemetry) return false;
    this.env ??= await this.d.machine?.().catch(() => null);
    const body = { session, game: rec.manifest ?? null, bench: this.run_, env: this.env, samples: [{ t: Date.now(), ...rec }] };
    try { const r = await fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: JSON.stringify(body).length < 60000 }); return r.ok; } catch { return false; }
  }
  async finish() {
    this.env ??= await this.d.machine?.().catch(() => null);
    const seconds = (performance.now() - this.t0) / 1000;
    this.record = suiteRecord(this.suite, this.run_, this.results, this.env, { outcome: this.stopAll ? 'aborted' : 'done', seconds, version: this.d.version ?? null });
    this.record.sent = await this.send(this.record, `${this.run_}.0`);
    this.state = 'done';
    this.banner.remove();
    this.showResult();
  }
  /** Records not kept by the server sent again (the games' and the suite's). */
  async resend() {
    for (const r of this.results) if (r.sent === false) r.sent = await this.send(r, `${this.run_}.${r.suite?.index ?? 0}`);
    this.record.results = this.results.map(compactResult);
    if (!this.record.sent) this.record.sent = await this.send(this.record, `${this.run_}.0`);
  }
  sentLine() {
    const all = [...this.results, this.record], bad = all.filter((r) => !r.sent).length;
    return bad ? W.notSent(bad, all.length) : W.sent(all.length);
  }
  showResult() {
    const el = document.createElement('div'); el.id = 'suiteResult';
    const cls = (fps) => (fps >= 29.5 ? 'good' : fps >= 20 ? 'warn' : 'bad');
    const rows = this.results.map((r) => {
      const ph = (r.phases ?? []).filter((p) => p.label !== 'start'), name = esc(r.title ?? r.bench), out = `<span class="${r.outcome === 'done' ? 'good' : 'bad'}">${esc(W.outcomes[r.outcome] ?? r.outcome)}</span>`;
      if (!ph.length) return `<tr class="first"><td class="l g">${name}</td><td class="l">${out}</td><td class="l" colspan="8">${esc(r.detail ?? '')}</td></tr>`;
      return ph.map((p, i) => `<tr${i ? '' : ' class="first"'}><td class="l g">${i ? '' : name}</td><td class="l">${i ? '' : out}</td><td class="l">${esc(p.label)}</td><td>${p.seconds ?? '–'} s</td><td class="${cls(p.fps ?? 0)}">${p.fps ?? '–'}</td><td>${p.dt ? `${p.dt.p50} / ${p.dt.p90} / ${p.dt.p99}` : '–'}</td><td>${p.per40 ?? '–'}</td><td>${p.work ? `${r1(p.work.p50)} / ${r1(p.work.p99)}` : '–'}</td><td>${p.gpu?.frames ? `${p.gpu.p50} / ${p.gpu.p99}` : p.gpu?.state === 'unavailable' ? 'n/a' : '–'}</td><td>${p.dataWaitMs ?? '–'}</td></tr>`).join('');
    }).join('');
    const e = this.env ?? {}, probe = this.results.find((r) => r.hostTiming?.length)?.hostTiming?.[0];
    const renderers = [...new Set(this.results.map((r) => r.renderer).filter(Boolean))];
    const interrupted = this.results.filter((r) => r.interrupted && (r.interrupted.hiddenSeconds || r.interrupted.blurs)).map((r) => r.title ?? r.bench);
    el.innerHTML = `<h2>${this.stopAll ? W.stopped : W.done} — ${esc(this.suite.title ?? this.suite.name)}</h2>
<div class="m">${esc(e.gpu ?? '')} · ${e.cores ?? '?'} cores${e.memGB ? ` · ${e.memGB} GB` : ''} · ${esc(e.screen ?? '')} · ${fmtTime(this.record.seconds)}${renderers.length ? `\n${W.renderer}: ${esc(renderers.join(' | '))}` : ''}${probe ? `\n${W.timers}: ${esc(probeLine(probe))}` : ''}${interrupted.length ? `\n${W.hidden}: ${esc(interrupted.join(', '))}` : ''}</div>
<table><tr>${W.head.map((x, i) => `<th${i < 3 ? ' class="l"' : ''}>${x}</th>`).join('')}</tr>${rows}</table>
<div class="m" id="suiteSent">${esc(this.sentLine())}</div>
<button id="suiteResend" class="${this.record.sent && this.results.every((r) => r.sent) ? 'quiet' : ''}">${W.resend}</button><button id="suiteCopy">${W.copy}</button><button class="quiet" id="suiteClose">${W.close}</button>`;
    document.body.appendChild(el);
    el.querySelector('#suiteResend').onclick = async (ev) => { ev.target.disabled = true; await this.resend(); el.querySelector('#suiteSent').textContent = this.sentLine(); ev.target.disabled = false; };
    el.querySelector('#suiteCopy').onclick = async (ev) => { try { await navigator.clipboard.writeText(JSON.stringify({ suite: this.record, records: this.results }, null, 1)); ev.target.textContent = W.copied; } catch { ev.target.textContent = W.copyFailed; } };
    el.querySelector('#suiteClose').onclick = () => { location.href = '/?menu'; };
  }
}
