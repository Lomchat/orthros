// "Download the whole game first", the page's side (docs/slow-network.md): one download worker at a time
// (download-worker.js), its progress kept in localStorage so a later visit shows where it stopped and resumes from
// there (the blocks already stored are skipped). The home screen draws it (home.js); starting a game stops it first.
// "Prepare" is the same with the launch set only (kind 'launch': what earlier sessions read before their game was
// playable, src/vfs/launch-set.js), and the card's "playable after X MB" line (launchStatus).
import { fmtRate, fmtBytes, fmtDuration } from './net-status.js';
import { linkRate } from '../../vfs/data-client.js';
import { FAST_BPS } from '../../vfs/net-link.js';

const KEY = (name, kind = 'whole') => (kind === 'launch' ? 'orthros.launch.' : 'orthros.download.') + name;
const load = (name, kind) => { try { return JSON.parse(localStorage.getItem(KEY(name, kind)) ?? 'null'); } catch { return null; } };
const save = (name, kind, v) => { try { localStorage.setItem(KEY(name, kind), JSON.stringify(v)); } catch { /* storage off */ } };
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
  const fr = lang === 'fr', B = fmtBytes, R = fmtRate, D = (s) => (fr ? fmtDuration(s).replace('about', 'environ') : fmtDuration(s));
  const text = state === 'done' ? (fr ? `Dans ce navigateur (${B(t)}) : démarre sans téléchargement` : `In this browser (${B(t)}): starts without downloading`)
    : state === 'running' ? `${B(bytes)} / ${B(t)} (${pct} %)${bw ? ` · ${R(bw)}` : ''}${eta !== null ? ` · ${D(eta)}${fr ? ' restantes' : ' left'}` : ''}`
    : state === 'paused' ? (fr ? `${pct} % téléchargé (${B(bytes)} / ${B(t)})${eta !== null ? ` · encore ${D(eta)} à ${R(bw)}` : ''}` : `${pct}% downloaded (${B(bytes)} of ${B(t)})${eta !== null ? ` · ${D(eta)} more at ${R(bw)}` : ''}`)
    : state === 'error' ? (fr ? `Téléchargement arrêté : ${st.error}` : `Download stopped: ${st.error}`)
    : (fr ? `Tout télécharger d’abord : ${B(t)}${eta !== null ? `, ${D(eta)} à ${R(bw)}` : ''}` : `Download the whole game first: ${B(t)}${eta !== null ? `, ${D(eta)} at ${R(bw)}` : ''}`);
  return { state, bytes, total: t, bw, eta, pct, text };
}

/**
 * The card's "playable after X MB" line for a version's launch (/api/manifests `launch`: launch-set.js launchSummary),
 * or null when the server does not know it yet: { state: 'none' | 'running' | 'paused' | 'done' | 'error', bytes (of
 * the launch set here), total, eta (s, null while the link is not measured), pct, text }. `o.bw`: the link's rate (wire
 * bytes/s; linkRate's by default) — on a link that is not fast the light copies' set, the files' on a fast one; `o.st`:
 * the "Prepare" progress (Downloads.get(name, 'launch')); `o.whole`: the whole download's (done: nothing to wait for).
 */
export function launchStatus(launch, o = {}, lang = 'en') {
  if (!launch || !(launch.bytes > 0)) return null;
  const bw = o.bw === undefined ? savedBw() : o.bw, fast = bw >= FAST_BPS, st = o.st ?? null;
  const size = fast ? launch.bytes : launch.lightBytes ?? launch.bytes, wire = (fast ? launch.wire : launch.lightWire ?? launch.wire) ?? size * 0.75;
  // (what "Prepare" already brought: its own count of the set it fetched, the rest in proportion)
  const t = st?.total || size, bytes = Math.min(t, st?.bytes ?? 0), left = Math.max(0, 1 - bytes / t);
  const eta = bw > 0 ? wire * left / bw : null, pct = Math.floor(100 * bytes / t);
  const state = o.whole?.done || st?.done ? 'done' : st?.error ? 'error' : st?.running ? 'running' : bytes > 0 ? 'paused' : 'none';
  const fr = lang === 'fr', B = fmtBytes, R = fmtRate, D = (s) => fmtDuration(s, lang);
  const text = state === 'done' ? (fr ? `Prêt : démarre sans attendre le réseau (${B(size)} dans ce navigateur)` : `Ready: starts without waiting for the network (${B(size)} in this browser)`)
    : state === 'running' ? (fr ? `Préparation : ${B(bytes)} / ${B(t)} (${pct} %)${eta !== null ? ` · ${D(eta)} restantes` : ''}` : `Preparing: ${B(bytes)} of ${B(t)} (${pct}%)${eta !== null ? ` · ${D(eta)} left` : ''}`)
    : state === 'error' ? (fr ? `Préparation arrêtée : ${st.error}` : `Preparing stopped: ${st.error}`)
    : state === 'paused' ? (fr ? `Jouable après encore ${B(size * left)} (${pct} % prêt)${eta !== null ? `, ${D(eta)} à ta connexion (${R(bw)})` : ''}` : `Playable after ${B(size * left)} more (${pct}% ready)${eta !== null ? `, ${D(eta)} at your link (${R(bw)})` : ''}`)
    : (fr ? `Jouable après ${B(size)}${eta !== null ? `, ${D(eta)} à ta connexion (${R(bw)})` : ''}` : `Playable after ${B(size)}${eta !== null ? `, ${D(eta)} at your link (${R(bw)})` : ''}`);
  return { state, bytes, total: t, eta, pct, text };
}

export class Downloads {
  constructor() { this.worker = null; this.name = null; this.kind = null; this.listeners = new Set(); this.live = new Map(); }
  /** the last known progress of `name` (`kind`: 'whole', else 'launch' — "Prepare"; this visit's, else the one kept from an earlier visit) */
  get(name, kind = 'whole') { return this.live.get(KEY(name, kind)) ?? load(name, kind); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(name) { for (const fn of this.listeners) fn(name); }
  running(name, kind = 'whole') { return this.name === name && this.kind === kind && !!this.worker; }
  /** Start (or resume) the download of `name` (`kind` 'launch': its launch set only); another one running stops first. */
  async start(name, kind = 'whole') {
    if (this.running(name, kind)) return;
    await this.stop();
    const w = this.worker = new Worker(new URL('./download-worker.js', import.meta.url), { type: 'module' });
    const key = KEY(name, kind);
    this.name = name; this.kind = kind;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        const v = { bytes: m.bytes, total: m.total, bw: m.bw, ratio: m.ratio, running: !!m.running, done: !!m.done, error: m.error ?? null, at: Date.now() };
        this.live.set(key, v); save(name, kind, { ...v, running: false });
        linkRate.set(m.bw);
        this.emit(name);
      } else if (m.type === 'stopped') {
        const v = this.live.get(key); if (v) { v.running = false; save(name, kind, v); }
        if (this.worker === w) { w.terminate(); this.worker = null; this.name = null; this.kind = null; }
        this.stopped?.(); this.stopped = null;
        this.emit(name);
      }
    };
    w.onerror = (e) => { const v = { ...(this.get(name, kind) ?? {}), running: false, error: e.message || 'the download stopped' }; this.live.set(key, v); w.terminate(); if (this.worker === w) { this.worker = null; this.name = null; this.kind = null; } this.emit(name); };
    w.postMessage({ type: kind === 'launch' ? 'launch' : 'download', name, bw: savedBw() });
    this.live.set(key, { ...(load(name, kind) ?? {}), running: true, error: null, done: false }); this.emit(name);
  }
  /** Stop the running download (its stores closed: a game may open them); resolves once stopped. */
  stop() {
    const w = this.worker; if (!w) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { w.terminate(); if (this.worker === w) { this.worker = null; this.name = null; this.kind = null; } resolve(); }, 5000);
      this.stopped = () => { clearTimeout(t); resolve(); };
      w.postMessage({ type: 'stop', name: this.name });
    });
  }
}
