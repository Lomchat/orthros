// Shared first-launch profile ("profile seed"): some games spend a long time on their very first launch (no settings
// file yet: they measure the machine, build caches...) and skip that work once their settings exist. A session that
// starts with an empty emulated user profile (C:\Users\Player) records the small files the game wrote there by the
// time the player first acts on a screen of the game (a click, or typing), and reports them once the session has
// gone on playing; the server offers the set of files that enough distinct sessions reported identical to the next
// player whose profile is empty. Nothing typed by a player is in such a set (the snapshot comes before any typing),
// identical content across sessions means default settings rather than personal data, and the size limits keep out
// saves, previews and caches. Used by the page's worker (snapshot, seeding) and by the server (validation, storage).

/** Limits of a seed: per file, per set, file count, path length. */
export const SEED_LIMITS = Object.freeze({ fileMax: 64 * 1024, setMax: 128 * 1024, files: 32, pathMax: 240 });

/**
 * A profile-relative path a seed may hold: '/'-separated, plain components (no '.', '..', ':' or '\'), not under the
 * profile's Temp directory (the emulated %TEMP%: scratch files).
 */
export function seedPathOk(p, limits = SEED_LIMITS) {
  if (typeof p !== 'string' || !p || p.length > limits.pathMax) return false;
  const parts = p.split('/');
  if (parts.some((c) => !c || c === '.' || c === '..' || /[\\:*?"<>|\x00-\x1f]/.test(c) || c.trim() !== c)) return false;
  return parts.length > 1 ? parts[0].toLowerCase() !== 'temp' : true;
}

/**
 * The files of a seed among a profile's files ({path, data: Uint8Array}): eligible paths and sizes, sorted by path
 * (case-insensitively unique), within the set's size and count limits (smallest first when over). Empty: nothing to share.
 */
export function seedSelect(files, limits = SEED_LIMITS) {
  const seen = new Set(), ok = [];
  for (const f of files) {
    if (!f || !seedPathOk(f.path, limits) || !(f.data instanceof Uint8Array) || f.data.length > limits.fileMax) continue;
    const k = f.path.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); ok.push(f);
  }
  ok.sort((a, b) => a.data.length - b.data.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out = []; let total = 0;
  for (const f of ok) { if (out.length >= limits.files || total + f.data.length > limits.setMax) break; out.push(f); total += f.data.length; }
  return out.sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1));
}

/** Identity of a set of files (paths and bytes): two 32-bit FNV-1a lanes over each path, its length and its bytes. */
export function seedKey(files) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  const byte = (b) => { h1 = Math.imul(h1 ^ b, 0x01000193); h2 = Math.imul(h2 ^ b, 0x5bd1e995) ^ (h2 >>> 15); };
  const enc = new TextEncoder();
  for (const f of files) {
    for (const b of enc.encode(f.path.toLowerCase())) byte(b);
    byte(0); for (let s = 0; s < 32; s += 8) byte((f.data.length >>> s) & 0xff); byte(0);
    for (let i = 0; i < f.data.length; i++) byte(f.data[i]);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + files.length.toString(16);
}

/**
 * Canonical sets (made by an operator, tools/profile-seed-make.mjs): per manifest, at most one set per game language
 * that the server offers before any learned one — whatever the sessions report. File name in the learn directory.
 */
export const seedCanonFile = (manifest) => `seedcanon-${String(manifest).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;

/**
 * The valid sets of a canonical file's JSON ({ v: 1, sets: [{ lang, files: [[path, base64]], at?, note? }] }): each
 * within the limits (as a reported set: seedSelect keeps every file), one per language (the first). Each comes back as
 * { lang, key, files: [[path, base64]], at, note }.
 */
export function canonSets(json, limits = SEED_LIMITS) {
  const out = [], langs = new Set();
  for (const s of Array.isArray(json?.sets) ? json.sets : []) {
    if (!s || typeof s.lang !== 'string' || !/^[a-z-]{0,16}$/.test(s.lang) || langs.has(s.lang) || !Array.isArray(s.files)) continue;
    const files = [];
    for (const f of s.files) { const data = Array.isArray(f) ? fromBase64(f[1]) : null; if (data && seedPathOk(f[0], limits)) files.push({ path: f[0], data }); else { files.length = 0; break; } }
    const sel = seedSelect(files, limits);
    if (!sel.length || sel.length !== s.files.length) continue;
    langs.add(s.lang);
    out.push({ lang: s.lang, key: seedKey(sel), files: sel.map((f) => [f.path, toBase64(f.data)]), at: Number(s.at) || 0, note: typeof s.note === 'string' ? s.note.slice(0, 200) : '' });
  }
  return out;
}

/** bytes -> base64 (browsers and Node: btoa) */
export function toBase64(d) {
  let bin = '';
  for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** base64 -> bytes, or null when malformed */
export function fromBase64(s) {
  if (typeof s !== 'string') return null;
  try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; }
}

/**
 * The worker's side: watches a session that started with an empty profile and decides when to snapshot and report.
 * `files()` lists the profile's files ({path, data}). `input` is called with each click and each printable character
 * as the page delivers them, before the game sees them. The snapshot is the profile at the first click that finds
 * files there (the game reached a screen the player acts on, its first-launch work written), or at the first character
 * typed (whatever is there then: nothing typed is in it). `step` gives the snapshot back once the session has
 * presented `frames` more frames over at least `ms` (it went on running: not the files of a launch that failed).
 */
export class SeedWatch {
  constructor({ files, frames = 600, ms = 60000, limits = SEED_LIMITS }) {
    this.files = files; this.needFrames = frames; this.needMs = ms; this.limits = limits;
    this.snap = null; this.done = false;
  }
  /** A click (`typed` false) or a printable character (`typed` true) at `now` ms, `frames` presented so far. */
  input(now, frames, typed) {
    if (this.done || this.snap) return;
    const sel = seedSelect(this.files(), this.limits).map((f) => ({ path: f.path, data: f.data.slice() }));
    if (sel.length) this.snap = { files: sel, at: now, frames };
    else if (typed) this.done = true; // (typing began with nothing to share: no snapshot may come later)
  }
  /** A periodic check: the snapshot's files to report, once, or null. */
  step(now, frames) {
    if (this.done || !this.snap || frames - this.snap.frames < this.needFrames || now - this.snap.at < this.needMs) return null;
    this.done = true;
    return this.snap.files;
  }
}
