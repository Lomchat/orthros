// The one merge of several copies of a player's profile into one (docs/profiles.md): the per-version profiles of a game
// that now share one (the browser's copies of every runtime, the account's on the server), and a device's copy with
// the account's when neither can be said to be the other's newer state. Pure: no storage, the same in Node and in the
// browser, so every caller gets the same result from the same copies.
//
// The rule, from the owner ("like on your PC, patching keeps your saves and settings"):
//   - every file of every copy is kept (union by path, the path's case ignored — Windows' — the first casing seen
//     kept);
//   - the same bytes under one path: one file;
//   - different bytes under one path: a settings file (.ini, .cfg, .opt, or a manifest's `profileSettings` globs)
//     takes the newest copy; any other file (a save, a replay, a map…) keeps every distinct copy: the newest at its
//     path, each older one beside it with its copy's label inserted before the extension — "Save 1 (bfme1-108).sav" —
//     (a counter after the label when that name is taken by other bytes).
// "Newest": the file's own date when the copy knows it (mtime, ms), else its copy's (source.at).

const DEFAULT_SETTINGS = /\.(ini|cfg|opt)$/i;

/** Equal file contents: Uint8Array (or Buffer) bytes, or strings (base64 as an account's copy carries them). */
export function sameData(a, b) {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A matcher of profile paths ('/'-separated, case ignored) from globs: `*` any characters but '/', `?` one of them,
 * `**` any number of folders.
 * @param {string[]} globs
 */
export function globMatcher(globs) {
  const res = (globs ?? []).map((g) => new RegExp('^' + String(g).split(/(\*\*\/?|\*|\?)/).map((part) =>
    part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'i'));
  return (path) => res.some((re) => re.test(path));
}

/** What is wrong with a manifest's `profileSettings` (null when nothing). */
export function profileSettingsProblem(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((g) => typeof g === 'string' && g.length > 0 && g.length <= 256 && !g.startsWith('/') && !g.includes('\\')))
    return 'profileSettings doit être une liste de motifs de chemins du profil (relatifs, séparés par /)';
  return null;
}

/** The settings-file test: the default extensions, or one of `settings` (globs, or a predicate). */
export function settingsTest(settings) {
  const extra = typeof settings === 'function' ? settings : globMatcher(settings ?? []);
  return (path) => DEFAULT_SETTINGS.test(path) || extra(path);
}

const SAFE_LABEL = (label) => String(label ?? '').replace(/[\x00-\x1f/\\:*?"<>|]/g, '_').trim() || 'copy';
/** `path` with " (<label>)" — or " (<label> <n>)" — inserted before its extension. */
export function labelledPath(path, label, n = 1) {
  const slash = path.lastIndexOf('/'), dot = path.lastIndexOf('.');
  const cut = dot > slash + 1 ? dot : path.length;
  return `${path.slice(0, cut)} (${SAFE_LABEL(label)}${n > 1 ? ' ' + n : ''})${path.slice(cut)}`;
}

/**
 * Several copies of a profile merged into one.
 * @param {{ label: string, at?: number, files: { path: string, data: Uint8Array | string, mtime?: number }[] }[]} sources
 *   the copies; on equal dates the earlier copy counts as the newer one (the caller puts its preferred copy first)
 * @param {{ settings?: string[] | ((path: string) => boolean) }} [opts]
 * @returns {{ files: { path: string, data: any, mtime?: number }[], report: { path: string, action: 'same' | 'newest' | 'renamed', to?: string, from?: string[] }[] }}
 *   files sorted by path; report: the paths where copies differed or met (identical paths of one copy only are not told)
 */
export function mergeProfiles(sources, opts = {}) {
  const isSettings = settingsTest(opts.settings);
  /** lowercase path -> { path, copies: [{ data, time, mtime, label, order }] } */
  const groups = new Map();
  sources.forEach((source, order) => {
    for (const f of source.files ?? []) {
      const key = f.path.toLowerCase();
      let g = groups.get(key);
      if (!g) groups.set(key, g = { path: f.path, copies: [] });
      const mtime = Number.isFinite(f.mtime) ? f.mtime : undefined;
      g.copies.push({ data: f.data, mtime, time: mtime ?? (Number.isFinite(source.at) ? source.at : 0), label: source.label, order });
    }
  });
  // (each path's distinct contents, the newest first: identical copies are one, dated by their newest)
  const newerFirst = (a, b) => b.time - a.time || a.order - b.order;
  for (const g of groups.values()) {
    const distinct = [];
    for (const c of [...g.copies].sort(newerFirst)) {
      const same = distinct.find((d) => sameData(d.data, c.data));
      if (same) { same.labels.push(c.label); if (c.mtime !== undefined && (same.mtime === undefined || c.mtime > same.mtime)) same.mtime = c.mtime; }
      else distinct.push({ ...c, labels: [c.label] });
    }
    g.distinct = distinct;
  }
  const out = new Map(), report = [];
  const put = (path, d) => out.set(path.toLowerCase(), { path, data: d.data, ...(d.mtime !== undefined ? { mtime: d.mtime } : {}) });
  // (what will lie at a path: a group's newest content, or an older copy already put there)
  const occupant = (key) => out.get(key)?.data ?? groups.get(key)?.distinct[0].data;
  const has = (key) => out.has(key) || groups.has(key);
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key), [newest, ...older] = g.distinct;
    put(g.path, newest);
    if (g.copies.length > 1 && !older.length) report.push({ path: g.path, action: 'same' });
    if (!older.length) continue;
    if (isSettings(g.path)) { report.push({ path: g.path, action: 'newest', from: newest.labels }); continue; }
    for (const d of older) {
      let n = 1, to;
      for (;;) {
        to = labelledPath(g.path, d.label, n);
        const k = to.toLowerCase();
        if (!has(k)) { put(to, d); break; }
        if (sameData(occupant(k), d.data)) break; // (already there: a merge done again)
        n++;
      }
      report.push({ path: g.path, action: 'renamed', to, from: d.labels });
    }
  }
  const files = [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, report };
}
