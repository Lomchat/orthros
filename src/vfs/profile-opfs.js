// The player's profile (C:\Users\Player: settings, saves) kept in the browser's OPFS between sessions: what the page
// worker writes there as the game changes it (flushProfileOpfs), and the profile as the headless harness takes it
// (profileDumpOf, profileGone: --profile-dir).

/**
 * Write what changed in `profile` (a MemBackend: files dated after `since`, the keys in `profile.changes` — renamed,
 * removed, folders made) into the OPFS directory `dir`. The files first, then the removals, and only once every write
 * succeeded: a file moved to a new place (a manifest's profileMoves, a rename by the game) is never gone from both
 * places — a worker killed during the writes, or a write that fails, leaves its old entry. What failed stays in
 * `profile.changes` and is written (or removed) again at the next flush.
 * @param {FileSystemDirectoryHandle | any} dir
 * @param {any} profile
 * @param {number} since the previous flush's date (ms)
 * @param {{ log?: (msg: string) => void }} [o]
 * @returns {Promise<{ written: number, removed: number, failed: number, changed: boolean }>}
 */
export async function flushProfileOpfs(dir, profile, since, o = {}) {
  const changes = profile.changes ? [...profile.changes] : []; profile.changes?.clear();
  const dirty = new Map([...profile.files].filter(([, f]) => f.mtime > since));
  for (const k of changes) if (profile.files.has(k)) dirty.set(k, profile.files.get(k)); // (renamed: same date)
  const out = { written: 0, removed: 0, failed: 0, changed: dirty.size > 0 || changes.length > 0 };
  const dirOf = async (parts, create) => { let d = dir; for (let i = 0; i < parts.length; i++) d = await d.getDirectoryHandle(profile.names.get(parts.slice(0, i + 1).join('/')) ?? parts[i], { create }); return d; };
  const gone = [];
  // (folders made: before the files they hold)
  for (const k of changes) {
    if (profile.files.has(k)) continue;
    if (profile.dirs.has(k)) { try { await dirOf(k.split('/'), true); } catch { /* already so */ } } else gone.push(k);
  }
  for (const [key, f] of dirty) {
    try {
      const parts = key.split('/');
      const d = await dirOf(parts.slice(0, -1), true);
      const fh = await d.getFileHandle(profile.names.get(key) ?? parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(f.data.subarray(0, f.len));
      await w.close();
      out.written++;
    } catch (e) { out.failed++; profile.changes?.add(key); o.log?.(`OPFS write failed for ${key}: ${e.message}`); }
  }
  // (files removed or renamed away, folders removed: the browser's copy follows — a deleted save must not come back —
  // once the new copies are there; else at a later flush)
  if (out.failed) { for (const k of gone) profile.changes?.add(k); return out; }
  for (const k of gone) {
    const parts = k.split('/');
    try { await (await dirOf(parts.slice(0, -1), false)).removeEntry(profile.names.get(k) ?? parts[parts.length - 1]); out.removed++; }
    catch { /* already so */ }
  }
  return out;
}

/**
 * Every profile file as { path (original case, '/'-separated), data (base64) } for the headless harness — null while
 * the profile is not complete yet (`ready` false: the worker still loading it, or its start failed before), so that the
 * harness never takes a profile it has not seen whole for one the game emptied.
 * @param {any} profile
 * @param {boolean} ready
 * @param {(p: any) => { path: string, data: Uint8Array }[]} list
 * @param {(d: Uint8Array) => string} toBase64
 */
export function profileDumpOf(profile, ready, list, toBase64) {
  if (!profile || !ready) return null;
  return list(profile).map((f) => ({ path: f.path, data: toBase64(f.data) }));
}

/**
 * The files the harness loaded into the profile that its dump no longer has (the game deleted them, a manifest's
 * profileMoves moved them): removed from the host folder too. None when there is no dump (null: not ready).
 * @param {string[]} loaded
 * @param {{ path: string }[] | null | undefined} files
 */
export function profileGone(loaded, files) {
  if (!Array.isArray(files)) return [];
  const now = new Set(files.map((f) => f.path.toLowerCase()));
  return loaded.filter((p) => !now.has(p.toLowerCase()));
}
