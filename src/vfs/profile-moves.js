// Player profile moves declared by a manifest ("profileMoves"): files a game kept at one place of the player's profile
// (C:\Users\Player) and keeps at another since its manifest changed — e.g. a registry value the installer writes added
// to the manifest, which moves the game's user-data folder — put at the new place at every start, before the game
// sees its profile, so a player keeps their settings and saves. Generic: any VFS backend with the usual interface
// (stat, readdir, mkdir, rename, rmdir: MemBackend — the page's profile, the OPFS copy and the account's copy go
// through it —, NodeBackend — the Node runner's save folder), no game named here.
//
// A move { from, to, names? } takes every entry of the folder `from` (only those named in `names`, compared without
// case, when given; never the folder holding `to` when `to` is beneath `from`) to `to/<name>`, folders merged
// recursively. A file whose new place already holds one stays where it was (the new place's is the game's own, newer:
// nothing is overwritten, nothing lost). Idempotent: once moved there is nothing left to move, a later start changes
// nothing — no marker needed, so the profile the game sees (and a snapshot's check of it) is the files alone.

const SEGMENT = /^[^\x00-\x1f<>:"\\|?*/]+$/;
const MAX_MOVES = 8, MAX_NAMES = 64, MAX_PATH = 240, MAX_DEPTH = 32;

const segOk = (s) => SEGMENT.test(s) && s !== '.' && s !== '..' && !/[ .]$/.test(s);
/** A profile path as a manifest gives it: '/'-separated, relative, without '.', '..' or Windows-forbidden characters. */
export const profilePathOk = (p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH && p.split('/').every(segOk);

/** What is wrong with a manifest's profileMoves (undefined: none declared), or null when it is valid. */
export function profileMovesProblem(moves) {
  if (moves === undefined) return null;
  if (!Array.isArray(moves) || moves.length > MAX_MOVES) return `profileMoves doit être une liste de ${MAX_MOVES} déplacements au plus`;
  for (const mv of moves) {
    if (!mv || typeof mv !== 'object' || Array.isArray(mv)) return 'profileMoves : déplacement invalide';
    for (const k of Object.keys(mv)) if (!['from', 'to', 'names'].includes(k)) return `profileMoves : champ inconnu ${k}`;
    if (!profilePathOk(mv.from) || !profilePathOk(mv.to)) return 'profileMoves : from et to doivent être des chemins relatifs du profil (séparés par /)';
    const from = mv.from.toLowerCase(), to = mv.to.toLowerCase();
    if (from === to || from.startsWith(to + '/')) return 'profileMoves : to ne peut être from ni le contenir';
    if (mv.names !== undefined && (!Array.isArray(mv.names) || !mv.names.length || mv.names.length > MAX_NAMES || !mv.names.every(segOk))) return 'profileMoves : names doit lister des noms d\'entrées';
  }
  return null;
}

const join = (a, b) => (a ? a + '/' + b : b);
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** The folders of `dir` made down from the root (the existing ones left as they are); false when one is a file. */
function ensureDir(backend, dir) {
  const parts = dir.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/'), st = backend.stat(p);
    if (st?.isDir) continue;
    if (st || !backend.mkdir(p)) return false;
  }
  return true;
}

function moveEntry(backend, src, dst, isDir, out, depth = 0) {
  const there = backend.stat(dst);
  if (!isDir) {
    if (there || !ensureDir(backend, parentOf(dst)) || !backend.rename(src, dst)) { out.kept.push(src); return; }
    out.moved.push([src, dst]);
    return;
  }
  if ((there && !there.isDir) || depth >= MAX_DEPTH) { out.kept.push(src); return; } // (deeper than a profile goes: left)
  if (!there && !ensureDir(backend, dst)) { out.kept.push(src); return; }
  for (const e of backend.readdir(src) ?? []) moveEntry(backend, join(src, e.name), join(dst, e.name), e.isDir, out, depth + 1);
  if (!(backend.readdir(src) ?? []).length && backend.rmdir?.(src)) out.moved.push([src, dst]);
}

/**
 * Applies a manifest's profile moves to a backend holding the player's profile at its root.
 * @returns {{ moved: Array<[string, string]>, kept: string[] }} the entries moved (files, then each emptied folder) and
 *   the files left at their old place because the new one holds a file already.
 */
export function applyProfileMoves(backend, moves) {
  const out = { moved: [], kept: [] };
  if (!Array.isArray(moves) || profileMovesProblem(moves)) return out;
  for (const { from, to, names } of moves) {
    if (!backend.stat(from)?.isDir) continue;
    const lower = from.toLowerCase(), target = to.toLowerCase();
    // (the folder holding `to`, when `to` is beneath `from`: where the entries go, not one to move)
    const skip = target.startsWith(lower + '/') ? target.slice(lower.length + 1).split('/')[0] : null;
    const only = names ? new Set(names.map((n) => n.toLowerCase())) : null;
    for (const e of backend.readdir(from) ?? []) {
      const n = e.name.toLowerCase();
      if (n === skip || (only && !only.has(n))) continue;
      moveEntry(backend, join(from, e.name), join(to, e.name), e.isDir, out);
    }
  }
  return out;
}
