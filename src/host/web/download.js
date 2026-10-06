// "Download the whole game first", the page's side (docs/slow-network.md): one download worker at a time
// (download-worker.js), its progress kept in localStorage so a later visit shows where it stopped and resumes from
// there (the blocks already stored are skipped). The home screen draws it (home.js); starting a game stops it first.
import { fmtRate, fmtBytes, fmtDuration } from './net-status.js';

const KEY = (name) => 'orthros.download.' + name;
const load = (name) => { try { return JSON.parse(localStorage.getItem(KEY(name)) ?? 'null'); } catch { return null; } };
const save = (name, v) => { try { localStorage.setItem(KEY(name), JSON.stringify(v)); } catch { /* storage off */ } };
const savedBw = () => { try { const v = Number(localStorage.getItem('orthros.netBw')); return v > 0 ? v : null; } catch { return null; } };

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

export class Downloads {
  constructor() { this.worker = null; this.name = null; this.listeners = new Set(); this.live = new Map(); }
  /** the last known progress of `name` (this visit's, else the one kept from an earlier visit) */
  get(name) { return this.live.get(name) ?? load(name); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(name) { for (const fn of this.listeners) fn(name); }
  running(name) { return this.name === name && !!this.worker; }
  /** Start (or resume) the download of `name`; another one running stops first. */
  async start(name) {
    if (this.running(name)) return;
    await this.stop();
    const w = this.worker = new Worker(new URL('./download-worker.js', import.meta.url), { type: 'module' });
    this.name = name;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        const v = { bytes: m.bytes, total: m.total, bw: m.bw, ratio: m.ratio, running: !!m.running, done: !!m.done, error: m.error ?? null, at: Date.now() };
        this.live.set(name, v); save(name, { ...v, running: false });
        if (m.bw > 0) { try { localStorage.setItem('orthros.netBw', String(Math.round(m.bw))); } catch { /* storage off */ } }
        this.emit(name);
      } else if (m.type === 'stopped') {
        const v = this.live.get(name); if (v) { v.running = false; save(name, v); }
        if (this.worker === w) { w.terminate(); this.worker = null; this.name = null; }
        this.stopped?.(); this.stopped = null;
        this.emit(name);
      }
    };
    w.onerror = (e) => { const v = { ...(this.get(name) ?? {}), running: false, error: e.message || 'the download stopped' }; this.live.set(name, v); w.terminate(); if (this.worker === w) { this.worker = null; this.name = null; } this.emit(name); };
    w.postMessage({ type: 'download', name, bw: savedBw() });
    this.live.set(name, { ...(load(name) ?? {}), running: true, error: null }); this.emit(name);
  }
  /** Stop the running download (its stores closed: a game may open them); resolves once stopped. */
  stop() {
    const w = this.worker; if (!w) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { w.terminate(); if (this.worker === w) { this.worker = null; this.name = null; } resolve(); }, 5000);
      this.stopped = () => { clearTimeout(t); resolve(); };
      w.postMessage({ type: 'stop', name: this.name });
    });
  }
}
