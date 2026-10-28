// "Download the whole game first", the page's side (docs/slow-network.md): one download worker at a time
// (download-worker.js), its progress kept in localStorage so a later visit shows where it stopped and resumes from
// there (the blocks already stored are skipped). The home screen draws it (home.js); starting a game stops it first.
// "Prepare" is the same with the launch set only (kind 'launch': what earlier sessions read before their game was
// playable, src/vfs/launch-set.js), and the card's "playable after X MB" line (launchStatus). The home's probe (`probe`:
// what the stores of the versions played before hold) writes the same progress, so that the lines tell the store's
// contents whoever filled it — a game played, a Prepare, a download — or that it is gone (evicted, cleared).
import { fmtRate, fmtBytes, fmtDuration } from './net-status.js';
import { pageStorage } from './storage-persist.js';
import { linkRate } from '../../vfs/data-client.js';
import { FAST_BPS } from '../../vfs/net-link.js';
import { lightLaunch } from '../../vfs/launch-set.js';

// (a launch set is a game language's own: "Prepare" in one language is not the other's)
const KEY = (name, kind = 'whole', lang = null) => (kind === 'launch' ? 'orthros.launch.' : 'orthros.download.') + name + (kind === 'launch' && lang ? '.' + lang : '');
const load = (name, kind, lang) => { try { return JSON.parse(localStorage.getItem(KEY(name, kind, lang)) ?? 'null'); } catch { return null; } };
const save = (name, kind, lang, v) => { try { localStorage.setItem(KEY(name, kind, lang), JSON.stringify(v)); } catch { /* storage off */ } };
const forget = (name, kind, lang) => { try { localStorage.removeItem(KEY(name, kind, lang)); } catch { /* storage off */ } };
const savedBw = () => linkRate.get() ?? null;

/**
 * What a game version's download looks like now: { state: 'none' | 'running' | 'paused' | 'done' | 'error', bytes,
 * total, bw, eta (s), pct, text, detail } — `text` the short line the home screen shows (`lang` 'en' or 'fr'), `detail`
 * the whole of it (its tooltip: the rate, the error).
 */
export function downloadStatus(st, total, lang = 'en', ratio = 0.75) {
  const bw = st?.bw ?? savedBw();
  const t = st?.total || total || 0, bytes = Math.min(t, st?.bytes ?? 0);
  const left = Math.max(0, t - bytes), eta = bw ? left * (st?.ratio ?? ratio) / bw : null;
  const state = st?.done ? 'done' : st?.error ? 'error' : st?.running ? 'running' : bytes > 0 ? 'paused' : 'none';
  const pct = t ? Math.floor(100 * bytes / t) : 0;
  const fr = lang === 'fr', B = (n) => fmtBytes(n, lang), R = (b) => fmtRate(b, lang), D = (s) => fmtDuration(s, lang), T = (s) => fmtDuration(s, lang, true);
  const text = state === 'done' ? (fr ? `Dans ce navigateur (${B(t)})` : `In this browser (${B(t)})`)
    : state === 'running' ? `${B(bytes)} / ${B(t)}${eta !== null ? ` · ${T(eta)}${fr ? ' restantes' : ' left'}` : ''}`
    : state === 'paused' ? (fr ? `${pct} % téléchargé${eta !== null ? ` · encore ${T(eta)}` : ''}` : `${pct}% downloaded${eta !== null ? ` · ${T(eta)} more` : ''}`)
    : state === 'error' ? (fr ? 'Téléchargement arrêté' : 'Download stopped')
    : (fr ? `Jeu complet : ${B(t)}${eta !== null ? ` · ${T(eta)}` : ''}` : `Whole game: ${B(t)}${eta !== null ? ` · ${T(eta)}` : ''}`);
  const detail = state === 'done' ? (fr ? `Dans ce navigateur (${B(t)}) : démarre sans téléchargement` : `In this browser (${B(t)}): starts without downloading`)
    : state === 'running' ? `${B(bytes)} / ${B(t)} (${pct} %)${bw ? ` · ${R(bw)}` : ''}${eta !== null ? ` · ${D(eta)}${fr ? ' restantes' : ' left'}` : ''}`
    : state === 'paused' ? (fr ? `${pct} % téléchargé (${B(bytes)} / ${B(t)})${eta !== null ? ` · encore ${D(eta)} à ${R(bw)}` : ''}` : `${pct}% downloaded (${B(bytes)} of ${B(t)})${eta !== null ? ` · ${D(eta)} more at ${R(bw)}` : ''}`)
    : state === 'error' ? (fr ? `Téléchargement arrêté : ${st.error}` : `Download stopped: ${st.error}`)
    : (fr ? `Tout télécharger d’abord : ${B(t)}${eta !== null ? `, ${D(eta)} à ${R(bw)}` : ''}` : `Download the whole game first: ${B(t)}${eta !== null ? `, ${D(eta)} at ${R(bw)}` : ''}`);
  return { state, bytes, total: t, bw, eta, pct, text, detail };
}

/**
 * The launch a card shows for game language `gameLang`: that language's own (/api/manifests `launch.langs`: the launch
 * set its sessions read, e.g. its translated texts), else the version's.
 */
export const launchFor = (launch, gameLang) => (gameLang && launch?.langs?.[gameLang]) || launch || null;

/**
 * The card's "playable after X MB" line for a version's launch (/api/manifests `launch`: launch-set.js launchSummary),
 * or null when the server does not know it yet: { state: 'none' | 'running' | 'paused' | 'done' | 'error', bytes (of
 * the launch set here), total, eta (s, null while the link is not measured), pct, text (short), detail (whole) }. `o.bw`: the link's rate (wire
 * bytes/s; linkRate's by default) — on a link that is not fast the light copies' set, the files' on a fast one (the light
 * one there too for an engine that reloads in place, `launch.reloads`: launch-set.js lightLaunch); `o.st`:
 * the "Prepare" progress (Downloads.get(name, 'launch', lang): its engine's bytes, `engine`, counted in its own); `o.whole`:
 * the whole download's (done: nothing to wait for). A "Prepare" whose engine files (`engineFiles`) are no longer the
 * launch's (an OpenMW game's lean package made since: the page asks for it, not for the package that was cached; an
 * engine release since, its changed files under new content addresses — src/host/engine-content.js) is not done: its
 * engine is to fetch again (the launch set is here; the files kept under the same addresses are found in the HTTP
 * cache, not downloaded: download-worker.js engineCached).
 */
export function launchStatus(launch, o = {}, lang = 'en') {
  if (!launch || !(launch.bytes > 0)) return null;
  const bw = o.bw === undefined ? savedBw() : o.bw, fast = bw >= FAST_BPS;
  let st = o.st ?? null;
  if (st?.done && Array.isArray(st.engineFiles) && !sameFiles(st.engineFiles, launch.engineFiles ?? [])) st = { ...st, done: false, bytes: Math.max(0, (st.bytes ?? 0) - (st.engine ?? 0)) };
  // (the light copies' set on a link that is not fast, and on every link for an engine that reloads in place — its big
  // loads read them first, its files upgrades after: lightLaunch)
  const light = lightLaunch(fast, launch.reloads);
  const size = light ? launch.lightBytes ?? launch.bytes : launch.bytes, wire = (light ? launch.lightWire ?? launch.wire : launch.wire) ?? size * 0.75;
  // (what "Prepare" already brought: its own count of the set it fetched — and of the engine's files, when it fetched
  // them —, the rest in proportion)
  const withEngine = st?.engine > 0 ? st.engine : 0;
  const t = st?.total || size + withEngine, bytes = Math.min(t, st?.bytes ?? 0), left = Math.max(0, 1 - bytes / t);
  const eta = bw > 0 ? (wire + withEngine) * left / bw : null, pct = Math.floor(100 * bytes / t);
  const state = o.whole?.done || st?.done ? 'done' : st?.error ? 'error' : st?.running ? 'running' : bytes > 0 ? 'paused' : 'none';
  const fr = lang === 'fr', B = (n) => fmtBytes(n, lang), R = (b) => fmtRate(b, lang), D = (s) => fmtDuration(s, lang), T = (s) => fmtDuration(s, lang, true);
  // (the engine's own download, at a first launch only: said beside, not counted — a browser that ran it has it)
  const first = launch.engine > 0 && state === 'none', engineShort = first ? (fr ? ` (+ ${B(launch.engine)} de moteur)` : ` (+ ${B(launch.engine)} of engine)`) : '';
  const after = eta !== null ? ` · ${T(eta)}` : '';
  const text = state === 'done' ? (fr ? 'Prêt : démarre sans attendre' : 'Ready: starts without waiting')
    : state === 'running' ? (fr ? `Préparation : ${B(bytes)} / ${B(t)}${after}` : `Preparing: ${B(bytes)} / ${B(t)}${after}`)
    : state === 'error' ? (fr ? 'Préparation arrêtée' : 'Preparing stopped')
    : state === 'paused' ? (fr ? `Jouable après encore ${B(t - bytes)}${after}` : `Playable after ${B(t - bytes)} more${after}`)
    : (fr ? `Jouable après ${B(size)}${engineShort}${after}` : `Playable after ${B(size)}${engineShort}${after}`);
  const engine = first ? (fr ? ` (+ ${B(launch.engine)} de moteur au premier lancement${bw > 0 ? `, ${D(launch.engine / bw)}` : ''})` : ` (+ ${B(launch.engine)} of engine at the first launch${bw > 0 ? `, ${D(launch.engine / bw)}` : ''})`) : '';
  // (a second stage under way — the files themselves after the light set, download-worker.js —: said in the detail)
  const up = state === 'done' && st?.running && st.upgrade?.total > 0 ? st.upgrade : null;
  const upText = up ? (fr ? ` · images nettes : ${B(up.bytes)} / ${B(up.total)}` : ` · sharp textures: ${B(up.bytes)} / ${B(up.total)}`) : '';
  const detail = state === 'done' ? (fr ? `Prêt : démarre sans attendre le réseau (${B(size)} dans ce navigateur)${upText}` : `Ready: starts without waiting for the network (${B(size)} in this browser)${upText}`)
    : state === 'running' ? (fr ? `Préparation : ${B(bytes)} / ${B(t)} (${pct} %)${eta !== null ? ` · ${D(eta)} restantes` : ''}` : `Preparing: ${B(bytes)} of ${B(t)} (${pct}%)${eta !== null ? ` · ${D(eta)} left` : ''}`)
    : state === 'error' ? (fr ? `Préparation arrêtée : ${st.error}` : `Preparing stopped: ${st.error}`)
    : state === 'paused' ? (fr ? `Jouable après encore ${B(t - bytes)} (${pct} % prêt)${eta !== null ? `, ${D(eta)} à ta connexion (${R(bw)})` : ''}` : `Playable after ${B(t - bytes)} more (${pct}% ready)${eta !== null ? `, ${D(eta)} at your link (${R(bw)})` : ''}`)
    : (fr ? `Jouable après ${B(size)}${eta !== null ? `, ${D(eta)} à ta connexion (${R(bw)})` : ''}${engine}` : `Playable after ${B(size)}${eta !== null ? `, ${D(eta)} at your link (${R(bw)})` : ''}${engine}`);
  return { state, bytes, total: t, eta, pct, text, detail };
}

const sameFiles = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);

export class Downloads {
  constructor() { this.worker = null; this.name = null; this.kind = null; this.lang = null; this.listeners = new Set(); this.live = new Map(); this.storage = pageStorage(); this.closed = false; }
  /**
   * the last known progress of `name` (`kind`: 'whole', else 'launch' — "Prepare", of game language `lang`; this
   * visit's, else the one kept from an earlier visit)
   */
  get(name, kind = 'whole', lang = null) { return this.live.get(KEY(name, kind, lang)) ?? load(name, kind, lang); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(name) { for (const fn of this.listeners) fn(name); }
  running(name, kind = 'whole', lang = null) { return this.name === name && this.kind === kind && (kind !== 'launch' || this.lang === lang) && !!this.worker; }
  /**
   * Start (or resume) the download of `name` (`kind` 'launch': its launch set only — `o.lang`'s, and `o.launch`'s engine
   * files first: /api/manifests launch.engineFiles; `o.launch.reloads`: the light set, then the files — download-worker.js);
   * another one running stops first.
   */
  async start(name, kind = 'whole', o = {}) {
    const lang = kind === 'launch' ? o.lang ?? null : null;
    if (this.running(name, kind, lang)) return;
    this.storage.ask(); // (before the first write: persistent storage asked, storage-persist.js)
    await this.stop();
    const w = this.worker = new Worker(new URL('./download-worker.js', import.meta.url), { type: 'module' });
    const key = KEY(name, kind, lang);
    this.name = name; this.kind = kind; this.lang = lang;
    const engine = kind === 'launch' && o.launch?.engineFiles?.length ? { files: o.launch.engineFiles, bytes: o.launch.engine ?? 0 } : null;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        const v = { bytes: m.bytes, total: m.total, engine: m.engine ?? 0, ...(kind === 'launch' ? { engineFiles: engine?.files ?? [] } : {}), ...(m.upgrade ? { upgrade: m.upgrade } : {}), bw: m.bw, ratio: m.ratio, running: !!m.running, done: !!m.done, error: m.error ?? null, at: Date.now() };
        this.live.set(key, v); save(name, kind, lang, { ...v, running: false });
        linkRate.set(m.bw);
        this.emit(name);
      } else if (m.type === 'stopped') {
        const v = this.live.get(key); if (v) { v.running = false; save(name, kind, lang, v); }
        if (this.worker === w) { w.terminate(); this.worker = null; this.name = null; this.kind = null; this.lang = null; }
        this.stopped?.(); this.stopped = null;
        this.emit(name);
      }
    };
    w.onerror = (e) => { const v = { ...(this.get(name, kind, lang) ?? {}), running: false, error: e.message || 'the download stopped' }; this.live.set(key, v); w.terminate(); if (this.worker === w) { this.worker = null; this.name = null; this.kind = null; this.lang = null; } this.emit(name); };
    w.postMessage({ type: kind === 'launch' ? 'launch' : 'download', name, bw: savedBw(), lang, engine, reloads: kind === 'launch' && o.launch?.reloads === true });
    this.live.set(key, { ...(load(name, kind, lang) ?? {}), running: true, error: null, done: false }); this.emit(name);
  }
  /**
   * Probe the stores of `items` ([{ name, lang, engine? (/api/manifests launch: { files, bytes }), reloads? (its
   * launch.reloads) }], in the order
   * given — the resume game first —, one at a time, in the download worker: its `probe`) and keep what they hold as
   * the lines' progress (`probed`). Nothing while a download runs, nor once a game is chosen (forGame); a download
   * started or a game's Play stops it first (stop(): the stores closed).
   */
  probe(items) {
    if (this.closed || this.worker || !items?.length || typeof Worker !== 'function') return;
    const w = this.worker = new Worker(new URL('./download-worker.js', import.meta.url), { type: 'module' });
    this.name = null; this.kind = 'probe'; this.lang = null;
    const done = () => { w.terminate(); if (this.worker === w) { this.worker = null; this.name = null; this.kind = null; this.lang = null; } this.stopped?.(); this.stopped = null; };
    w.onmessage = (e) => { const m = e.data; if (m.type === 'probed') this.probed(m); else if (m.type === 'stopped') done(); };
    w.onerror = done;
    w.postMessage({ type: 'probe', items: items.map((i) => ({ name: i.name, lang: i.lang ?? null, engine: i.engine ?? null, reloads: i.reloads === true })), bw: savedBw() });
  }
  /**
   * A probe's answer (download-worker.js `probe`) kept as the progress of the launch (of game language `m.lang`) and
   * of the whole download: what the store holds of the launch set as this link reads it; a store gone (`missing`)
   * clears them. Never over a download of this visit's (its own count is live).
   */
  probed(m) {
    const at = Date.now();
    for (const [kind, lang, got] of [['launch', m.lang ?? null, m.launch], ['whole', null, m.whole]]) {
      const key = KEY(m.name, kind, lang); if (this.live.get(key)?.running) continue;
      if (m.missing || !got || (kind === 'whole' && !(got.bytes > 0))) {
        if (m.missing || kind === 'whole') { this.live.delete(key); forget(m.name, kind, lang); }
        continue;
      }
      const v = { bytes: got.bytes, total: got.total, engine: got.engine ?? 0, ...(kind === 'launch' ? { engineFiles: got.engineFiles ?? [] } : {}), bw: null, ratio: null, running: false, done: !!got.done, error: null, at, probed: true };
      this.live.set(key, v); save(m.name, kind, lang, v);
    }
    this.emit(m.name);
  }
  /**
   * A game was chosen (Play): no probe starts from now on (a timer's, a late one), the running download or probe stopped
   * — resolves once its stores are closed (the game's worker opens them next).
   */
  forGame() { this.closed = true; return this.stop(); }
  /** Stop the running download (its stores closed: a game may open them); resolves once stopped. */
  stop() {
    const w = this.worker; if (!w) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { w.terminate(); if (this.worker === w) { this.worker = null; this.name = null; this.kind = null; this.lang = null; } resolve(); }, 5000);
      this.stopped = () => { clearTimeout(t); resolve(); };
      w.postMessage({ type: 'stop', name: this.name });
    });
  }
}
