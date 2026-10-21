// "Download the whole game first", the page's side (docs/slow-network.md): one download worker at a time
// (download-worker.js), its progress kept in localStorage so a later visit shows where it stopped and resumes from
// there (the blocks already stored are skipped). The home screen draws it (home.js); starting a game stops it first.
// "Prepare" is the same with the launch set only (kind 'launch': what earlier sessions read before their game was
// playable, src/vfs/launch-set.js), and the card's "playable after X MB" line (launchStatus).
import { fmtRate, fmtBytes, fmtDuration } from './net-status.js';
import { linkRate } from '../../vfs/data-client.js';
import { FAST_BPS } from '../../vfs/net-link.js';

// (a launch set is a game language's own: "Prepare" in one language is not the other's)
const KEY = (name, kind = 'whole', lang = null) => (kind === 'launch' ? 'orthros.launch.' : 'orthros.download.') + name + (kind === 'launch' && lang ? '.' + lang : '');
const load = (name, kind, lang) => { try { return JSON.parse(localStorage.getItem(KEY(name, kind, lang)) ?? 'null'); } catch { return null; } };
const save = (name, kind, lang, v) => { try { localStorage.setItem(KEY(name, kind, lang), JSON.stringify(v)); } catch { /* storage off */ } };
const savedBw = () => linkRate.get() ?? null;

/**
 * What a game version's download looks like now: { state: 'none' | 'running' | 'paused' | 'done' | 'error', bytes,
 * total, bw, eta (s), pct, text } — `text` the line the home screen shows (`lang` 'en' or 'fr').
 */
export function downloadStatus(st, total, lang = 'en', ratio = 0.75) {
  const bw = st?.bw ?? savedBw();
  const t = st?.total || total || 0, bytes = Math.min(t, st?.bytes ?? 0);
  const left = Math.max(0, t - bytes), eta = bw ? left * (st?.ratio ?? ratio) / bw : null;
  const state = st?.done ? 'done' : st?.error ? 'error' : st?.running ? 'running' : bytes > 0 ? 'paused' : 'none';
  const pct = t ? Math.floor(100 * bytes / t) : 0;
  const fr = lang === 'fr', B = (n) => fmtBytes(n, lang), R = (b) => fmtRate(b, lang), D = (s) => fmtDuration(s, lang);
  const text = state === 'done' ? (fr ? `Dans ce navigateur (${B(t)}) : démarre sans téléchargement` : `In this browser (${B(t)}): starts without downloading`)
    : state === 'running' ? `${B(bytes)} / ${B(t)} (${pct} %)${bw ? ` · ${R(bw)}` : ''}${eta !== null ? ` · ${D(eta)}${fr ? ' restantes' : ' left'}` : ''}`
    : state === 'paused' ? (fr ? `${pct} % téléchargé (${B(bytes)} / ${B(t)})${eta !== null ? ` · encore ${D(eta)} à ${R(bw)}` : ''}` : `${pct}% downloaded (${B(bytes)} of ${B(t)})${eta !== null ? ` · ${D(eta)} more at ${R(bw)}` : ''}`)
    : state === 'error' ? (fr ? `Téléchargement arrêté : ${st.error}` : `Download stopped: ${st.error}`)
    : (fr ? `Tout télécharger d’abord : ${B(t)}${eta !== null ? `, ${D(eta)} à ${R(bw)}` : ''}` : `Download the whole game first: ${B(t)}${eta !== null ? `, ${D(eta)} at ${R(bw)}` : ''}`);
  return { state, bytes, total: t, bw, eta, pct, text };
}

/**
 * The launch a card shows for game language `gameLang`: that language's own (/api/manifests `launch.langs`: the launch
 * set its sessions read, e.g. its translated texts), else the version's.
 */
export const launchFor = (launch, gameLang) => (gameLang && launch?.langs?.[gameLang]) || launch || null;

/**
 * The card's "playable after X MB" line for a version's launch (/api/manifests `launch`: launch-set.js launchSummary),
 * or null when the server does not know it yet: { state: 'none' | 'running' | 'paused' | 'done' | 'error', bytes (of
 * the launch set here), total, eta (s, null while the link is not measured), pct, text }. `o.bw`: the link's rate (wire
 * bytes/s; linkRate's by default) — on a link that is not fast the light copies' set, the files' on a fast one; `o.st`:
 * the "Prepare" progress (Downloads.get(name, 'launch', lang): its engine's bytes, `engine`, counted in its own); `o.whole`:
 * the whole download's (done: nothing to wait for). A "Prepare" whose engine files (`engineFiles`) are no longer the
 * launch's (an OpenMW game's lean package made since: the page asks for it, not for the package that was cached) is not
 * done: its engine is to fetch again (the launch set is here).
 */
export function launchStatus(launch, o = {}, lang = 'en') {
  if (!launch || !(launch.bytes > 0)) return null;
  const bw = o.bw === undefined ? savedBw() : o.bw, fast = bw >= FAST_BPS;
  let st = o.st ?? null;
  if (st?.done && Array.isArray(st.engineFiles) && !sameFiles(st.engineFiles, launch.engineFiles ?? [])) st = { ...st, done: false, bytes: Math.max(0, (st.bytes ?? 0) - (st.engine ?? 0)) };
  const size = fast ? launch.bytes : launch.lightBytes ?? launch.bytes, wire = (fast ? launch.wire : launch.lightWire ?? launch.wire) ?? size * 0.75;
  // (what "Prepare" already brought: its own count of the set it fetched — and of the engine's files, when it fetched
  // them —, the rest in proportion)
  const withEngine = st?.engine > 0 ? st.engine : 0;
  const t = st?.total || size + withEngine, bytes = Math.min(t, st?.bytes ?? 0), left = Math.max(0, 1 - bytes / t);
  const eta = bw > 0 ? (wire + withEngine) * left / bw : null, pct = Math.floor(100 * bytes / t);
  const state = o.whole?.done || st?.done ? 'done' : st?.error ? 'error' : st?.running ? 'running' : bytes > 0 ? 'paused' : 'none';
  const fr = lang === 'fr', B = (n) => fmtBytes(n, lang), R = (b) => fmtRate(b, lang), D = (s) => fmtDuration(s, lang);
  // (the engine's own download, at a first launch only: said beside, not counted — a browser that ran it has it)
  const engine = launch.engine > 0 && state === 'none' ? (fr ? ` (+ ${B(launch.engine)} de moteur au premier lancement${bw > 0 ? `, ${D(launch.engine / bw)}` : ''})` : ` (+ ${B(launch.engine)} of engine at the first launch${bw > 0 ? `, ${D(launch.engine / bw)}` : ''})`) : '';
  const text = state === 'done' ? (fr ? `Prêt : démarre sans attendre le réseau (${B(size)} dans ce navigateur)` : `Ready: starts without waiting for the network (${B(size)} in this browser)`)
    : state === 'running' ? (fr ? `Préparation : ${B(bytes)} / ${B(t)} (${pct} %)${eta !== null ? ` · ${D(eta)} restantes` : ''}` : `Preparing: ${B(bytes)} of ${B(t)} (${pct}%)${eta !== null ? ` · ${D(eta)} left` : ''}`)
    : state === 'error' ? (fr ? `Préparation arrêtée : ${st.error}` : `Preparing stopped: ${st.error}`)
    : state === 'paused' ? (fr ? `Jouable après encore ${B(t - bytes)} (${pct} % prêt)${eta !== null ? `, ${D(eta)} à ta connexion (${R(bw)})` : ''}` : `Playable after ${B(t - bytes)} more (${pct}% ready)${eta !== null ? `, ${D(eta)} at your link (${R(bw)})` : ''}`)
    : (fr ? `Jouable après ${B(size)}${eta !== null ? `, ${D(eta)} à ta connexion (${R(bw)})` : ''}${engine}` : `Playable after ${B(size)}${eta !== null ? `, ${D(eta)} at your link (${R(bw)})` : ''}${engine}`);
  return { state, bytes, total: t, eta, pct, text };
}

const sameFiles = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);

export class Downloads {
  constructor() { this.worker = null; this.name = null; this.kind = null; this.lang = null; this.listeners = new Set(); this.live = new Map(); }
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
   * files first: /api/manifests launch.engineFiles); another one running stops first.
   */
  async start(name, kind = 'whole', o = {}) {
    const lang = kind === 'launch' ? o.lang ?? null : null;
    if (this.running(name, kind, lang)) return;
    await this.stop();
    const w = this.worker = new Worker(new URL('./download-worker.js', import.meta.url), { type: 'module' });
    const key = KEY(name, kind, lang);
    this.name = name; this.kind = kind; this.lang = lang;
    const engine = kind === 'launch' && o.launch?.engineFiles?.length ? { files: o.launch.engineFiles, bytes: o.launch.engine ?? 0 } : null;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        const v = { bytes: m.bytes, total: m.total, engine: m.engine ?? 0, ...(kind === 'launch' ? { engineFiles: engine?.files ?? [] } : {}), bw: m.bw, ratio: m.ratio, running: !!m.running, done: !!m.done, error: m.error ?? null, at: Date.now() };
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
    w.postMessage({ type: kind === 'launch' ? 'launch' : 'download', name, bw: savedBw(), lang, engine });
    this.live.set(key, { ...(load(name, kind, lang) ?? {}), running: true, error: null, done: false }); this.emit(name);
  }
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
