// The launch set of a game version, the same for every runtime (CLAUDE.md "Standardization", docs/slow-network.md
// "Playable after"): the entries of its learned order (/api/prefetch: [path, block, pieces mask, ms, flags?]) a session
// reads before its game is playable, as a link reads them (forLink). The server's learned order says which: a page marks
// the moment its game first draws in play (GameData.mark('playable')), the server flags the entries the sessions that
// marked it had read by then (bit PRE_PLAYABLE of the fifth element, present once a session marked the version); an
// order without flags is cut at its first pause instead (STARTUP_GAP_MS). One implementation for the data worker (the
// startup set a page waits for), the download worker (the home's "Prepare") and the server (the home's "playable after
// X MB": /api/manifests `launch`). `files`: an HttpBackend over the version's tree (lookup, isWhole, pieceHere,
// peekBlockHere) — the server's has no store.
import { BLOCK, CHUNK } from './http-backend.js';
import { LIGHT_DIR } from './game-tree.js';

/** An order without flags: its startup set up to its first pause this long. */
export const STARTUP_GAP_MS = 2000;
/** Flags bit: earlier sessions read the entry before their game was playable (in at least half the marked sessions). */
export const PRE_PLAYABLE = 1;
/** The wire bytes of a decoded byte, when the server does not know them (its compressed units: br-cache.js). */
export const WIRE_RATIO = 0.75;

const PIECES = BLOCK / CHUNK;

/** The order carries the server's flags (a session marked the version playable). */
export const flagged = (list) => list.some((e) => typeof e[4] === 'number');

/**
 * A learned order as this link reads it: on a link that is not fast, a texture's light copy (whole, once) in place of
 * the file — unless the file is here —, and the media files' entries (the tree's `media`: movies, music — game-tree.js)
 * after all the others, in their order (a movie earlier sessions watched while this one may skip it, a track the engine
 * streams itself: not ahead of what the game waits for); on a fast one, the files themselves in place of light copies
 * earlier sessions read. An entry's flags go with what replaces it.
 */
export function forLink(files, list, fast) {
  const out = [], tail = [], seen = new Set();
  const add = (path, block, mask, t, flags) => { const k = path + '#' + block; if (!seen.has(k)) { seen.add(k); out.push(flags === undefined ? [path, block, mask, t] : [path, block, mask, t, flags]); } };
  for (const e of list) {
    const [path, , , t, flags] = e, light = path.startsWith(LIGHT_DIR + '/');
    const r = files.lookup(light ? path.slice(LIGHT_DIR.length + 1) : path);
    if (!fast && !light && r?.file?.media) { const k = path + '#' + e[1]; if (!seen.has(k)) { seen.add(k); tail.push(e); } continue; }
    if (!r?.file?.light) { if (!light) add(...e); continue; }
    if (fast || files.isWhole(r.path)) {
      if (!light) add(...e); else for (let b = 0; b * BLOCK < r.file.size; b++) add(r.path, b, 0, t, flags);
    } else {
      for (let b = 0; b * BLOCK < r.file.light; b++) {
        const n = Math.ceil((Math.min(BLOCK, r.file.light - b * BLOCK)) / CHUNK);
        add(`${LIGHT_DIR}/${r.path}`, b, n >= 16 ? 0xffff : (1 << n) - 1, t, flags);
      }
    }
  }
  return tail.length ? out.concat(tail) : out;
}

/**
 * The startup set of a learned order as this link reads it (forLink's): its entries flagged PRE_PLAYABLE when the order
 * has flags, else those up to its first pause of STARTUP_GAP_MS — on a link that is not fast, without the media files
 * (they are not needed to start the game).
 */
export function startupHead(files, list, fast) {
  if (!fast) list = list.filter(([path]) => !files.lookup(path)?.file?.media);
  if (flagged(list)) return list.filter((e) => (e[4] & PRE_PLAYABLE) !== 0);
  let end = list.length;
  for (let i = 1; i < list.length; i++) if (list[i][3] - list[i - 1][3] > STARTUP_GAP_MS) { end = i; break; }
  return list.slice(0, end);
}

/** The launch set of a learned order (as received) on this link: startupHead(forLink(...)). */
export const launchSet = (files, list, fast) => startupHead(files, forLink(files, list, fast), fast);

/**
 * A learned order as this link reads it (forLink's), its launch set first when it has flags: the entries earlier
 * sessions read before their game was playable, then the others, each part in its order (the media files last still,
 * on a link that is not fast). Followed from the game's position (HttpBackend.prefetch), a session that waits in its
 * menu loads what the rest of the way to playable needs (a new game's first load) before what sessions read later.
 * The list's `first` (when it has flags): how many of its entries are the launch set (HttpBackend.prefetch's opts.first).
 */
export function launchFirst(files, list, fast) {
  const all = forLink(files, list, fast);
  if (!flagged(all)) return all;
  const first = [], rest = [];
  for (const e of all) ((e[4] & PRE_PLAYABLE) !== 0 && (fast || !files.lookup(e[0])?.file?.media) ? first : rest).push(e);
  // (`first`: the launch set's length — HttpBackend.prefetch's opts.first)
  return Object.assign(first.concat(rest), { first: first.length });
}

/**
 * The 64 KiB pieces an entry stands for: { path (the tree's), size, mtime, block, pieces: [chunk index] } — its learned
 * ones (all of the block's when its mask is unknown) —, or null (not in the tree).
 */
export function entryPieces(files, [path, block, mask]) {
  const r = files.lookup(path); if (!r?.file || !(block * BLOCK < r.file.size)) return null;
  const n = Math.ceil(Math.min(BLOCK, r.file.size - block * BLOCK) / CHUNK), all = n >= PIECES ? 0xffff : (1 << n) - 1;
  const m = (mask & all) || all, pieces = [];
  for (let i = 0; i < n; i++) if (m & (1 << i)) pieces.push(block * PIECES + i);
  return { path: r.path, size: r.file.size, mtime: r.file.mtime ?? 0, block, pieces, whole: m === all };
}
const pieceBytes = (size, c) => Math.min(CHUNK, size - c * CHUNK);

/**
 * The bytes of a set (decoded), and those of them here already (files' memory or store): { bytes, here }. `whole`: its
 * blocks counted whole (what a fast link fetches of them: HttpBackend.prefetch), not their learned pieces.
 */
export function setBytes(files, list, whole = false) {
  let bytes = 0, here = 0;
  for (const e of list) {
    const p = entryPieces(files, e); if (!p) continue;
    const block = p.block, blockHere = files.peekBlockHere?.(p.path, p.size, p.mtime, block);
    const pieces = whole ? Array.from({ length: Math.ceil(Math.min(BLOCK, p.size - block * BLOCK) / CHUNK) }, (_, i) => block * PIECES + i) : p.pieces;
    for (const c of pieces) {
      const n = pieceBytes(p.size, c); bytes += n;
      if (blockHere || files.pieceHere?.(p.path, p.size, p.mtime, c)) here += n;
    }
  }
  return { bytes, here };
}

/**
 * What a version's launch costs, from its learned order (as the server lists it): { bytes, lightBytes, wire, lightWire,
 * entries } — decoded and wire bytes of the launch set on a fast link (the files themselves) and on one that is not
 * (light copies, no media) —, or null when no session marked it playable (no flags). `wireOf(path, unit, raw)`: the wire
 * bytes of a transport unit ({ kind: 'b' | 'p', index }, br-cache.js's: a block whose pieces are all learned, or one
 * piece; a light copy by pieces, one block when it is one piece), else raw × WIRE_RATIO.
 */
export function launchSummary(files, list, wireOf = null) {
  if (!flagged(list)) return null;
  const wire = (path, unit, raw) => { const w = wireOf?.(path, unit, raw); return Number.isFinite(w) ? w : raw * WIRE_RATIO; };
  const cost = (fast) => {
    const set = launchSet(files, list, fast);
    let bytes = 0, wired = 0;
    for (const e of set) {
      const p = entryPieces(files, e); if (!p) continue;
      const light = p.path.startsWith(LIGHT_DIR + '/');
      const n = p.pieces.reduce((a, c) => a + pieceBytes(p.size, c), 0);
      bytes += n;
      if (light ? p.size <= CHUNK : p.whole) wired += wire(p.path, { kind: 'b', index: p.block }, n);
      else for (const c of p.pieces) wired += wire(p.path, { kind: 'p', index: c }, pieceBytes(p.size, c));
    }
    return { bytes, wire: Math.round(wired), entries: set.length };
  };
  const full = cost(true), light = cost(false);
  return { bytes: full.bytes, lightBytes: light.bytes, wire: full.wire, lightWire: light.wire, entries: full.entries };
}
