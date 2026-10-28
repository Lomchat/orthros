// The OpenMW engine page's guesses of the player's next place in play (docs/openmw.md "In play: crossings and doors"):
// the learned set (GET /api/places, what the engine announced when some player loaded that place) of the exterior grid
// the player is heading into — the cell after the one just entered, in the same direction: a whole cell's walk ahead
// (~27 s at a run), where the engine's own preload starts ~4 s before the crossing —, fetched by the page (streamfs.js)
// at the place's priority (GameData.want `prio: 'place'`: the link's idle time only, below the game's reads, a load's
// and the launch set). No engine change: the cell comes from view.lua's report. No door guess: standing at a door gives
// under a second of warning where a guess needs ~10 s at 300 KB/s to save anything, and each door passed would spend
// the session's bounds (docs/openmw.md, the door runs). Bounded for thin links:
// a guess takes its set's meshes and terrain only — never textures (a wrong guess on a mod's textures costs tens of MB;
// the load reads them, light first on a link that is not fast) —, LEAD.bytes of them at most, each place once a
// session, LEAD.sessionBytes in all; a place the server never learned costs one small GET. Off unless the page asks
// (?lead=1): measured, the learned order already brings a taught row before the player (docs/openmw.md, the A/B).

export const LEAD = {
  /** the kinds of a learned set a guess fetches (the server's list: [path, start, end, kind]) */
  kinds: ['meshes', 'terrain'],
  /** the most of the files' own bytes one guess asks for (a town's row of meshes: ~3-6 MB; the light copies are less) */
  bytes: 8 << 20,
  /** the most a session's guesses ask for in all (then none: a player wandering on a thin link pays nothing more) */
  sessionBytes: 64 << 20,
  /** the most places a session guesses (the GETs) */
  places: 64,
};

/** A view.lua cell report ('x y', '' inside) as [x, y], or null. */
export function parseCell(text) {
  const m = /^\s*(-?\d+)\s+(-?\d+)\s*$/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The exterior grid the player reaches next going on as they did: from the cell `prev` into its neighbour `cur` (view.lua
 * reports, 'x y'), the cell after `cur` the same way — the learned places' key 'x,y' (the grid centre the engine
 * announces a crossing for: the player's cell). null when the step was no neighbour's (a teleport, a door, a load).
 */
export function nextRow(prev, cur) {
  const a = parseCell(prev), b = parseCell(cur);
  if (!a || !b) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if ((!dx && !dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
  return `${b[0] + dx},${b[1] + dy}`;
}

/**
 * A guess's entries from the server's list ([[path, start, end, kind]], or under `list`): `kinds` only, in the list's
 * order, cut once `bytes` of the files' own would pass (`size(path)`: the file's size, null when the tree has no such
 * file — left out). [{ path, off, len }] (len -1: to the file's end) and their bytes.
 */
export function leadEntries(doc, { kinds = LEAD.kinds, bytes = LEAD.bytes, size }) {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.list) ? doc.list : [];
  const out = [];
  let n = 0;
  for (const x of list) {
    const [p, a, b, kind] = Array.isArray(x) ? x : [x?.path, x?.start, x?.end, x?.kind];
    if (typeof p !== 'string' || !kinds.includes(kind)) continue;
    const s = size(p);
    if (s === null || s === undefined) continue;
    const off = Math.max(0, Number(a) || 0), end = b === undefined || b === null || Number(b) < 0 ? s : Math.min(s, Number(b));
    if (!(end > off)) continue;
    if (n + end - off > bytes) break;
    n += end - off;
    out.push({ path: p, off, len: end === s ? -1 : end - off });
  }
  return { entries: out, bytes: n };
}

/**
 * The guesses of one page: `look(state)` at each poll with the engine's reports (window.omw.state) returns the places to
 * ask now — the next row after a crossing —, each place once;
 * `spent(bytes)` counts what a guess asked (LEAD.sessionBytes in all, then nothing more is guessed). `snapshot()`: the
 * counters (guessed, bytes, the last places).
 */
export function createLead(limits = LEAD) {
  const s = { cell: null, asked: new Set(), bytes: 0, last: [] };
  const fresh = (place) => place && !s.asked.has(place) && s.asked.size < limits.places && s.bytes < limits.sessionBytes;
  return {
    look(state) {
      const out = [], cell = state?.['orthros.cell'];
      if (typeof cell === 'string' && cell !== s.cell) {
        const next = nextRow(s.cell, cell);
        s.cell = cell;
        if (fresh(next)) out.push(next);
      }
      for (const p of out) { s.asked.add(p); s.last.push(p); if (s.last.length > 8) s.last.shift(); }
      return out;
    },
    spent(bytes) { s.bytes += Math.max(0, Number(bytes) || 0); },
    snapshot() { return { guessed: s.asked.size, bytes: s.bytes, last: [...s.last] }; },
  };
}
