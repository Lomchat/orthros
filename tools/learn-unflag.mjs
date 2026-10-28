#!/usr/bin/env node
// A learned launch set taken back for some files (docs/slow-network.md "Launch set after an engine change"): the
// entries of a version's learned order (prefetch-<manifest>.json) whose file is one of --path lose their `pre` count
// (the marking sessions that had read them before playable, the 5th element, and its per-language counts, the 6th) —
// out of the launch set at once, flagged again only if new sessions read them before playable as often as the version's
// marks ask (half of them: server.js prefetchList). They also move to the END of the order: their time becomes later
// than every other entry's, their phases go (the order is sorted by time — the earliest across sessions —, so an entry
// left at its early time would still be the first thing fetched after the launch set: measured on reVC r3 at 1.8 MB/s,
// the 11 MB sound bank downloaded during the menu ahead of the new game's gta3.img blocks, ~20 more serial demand reads
// in its load). A session that reads them earlier again teaches its own time. The version's marks
// (playable-<manifest>.json), the entries' counts and piece masks stay.
//
// What it is for: an engine release that no longer reads a file before playable (reVC r3: sound bank 0 read sample by
// sample on first play, no longer whole at the audio's start) leaves that file flagged by the sessions of the release
// before — with 19 marks, about 20 sessions of the new release before the server would stop flagging it alone.
// And --tail: an engine release that no longer reads a file's first blocks in play (reVC r4: a streamed MP3/ADF seeks
// to its byte estimate, no longer reading every frame from the file's start up to it) leaves those blocks early in the
// order, counted by the older release's sessions, never flagged (read after playable): fetched by every new device in
// the new game's load. With --tail the entries of the files and blocks named move to the end of the order whether
// counted before playable or not (those counted lose that count as above). The move lasts only for blocks the new
// release no longer reads early: the server keeps a block's earliest time over every session and sorts the order by it
// alone, so one session that reads a moved block early (an ambience started at a random position: its target block)
// puts it back — resetting its count would not help (docs/slow-network.md "How long the move lasts").
//
// Usage: node tools/learn-unflag.mjs <learn dir> --only <manifest>... --path <game file>[#<blocks>]... [--tail] [--write]
//   --path: a game file as the order names it (case-insensitively, either separator: 'Audio/sfx.RAW'); every block of it,
//   or the 1 MiB blocks given after '#': one ('#3'), a range ('#1-8'), or from one to the file's end ('#1-').
//   --tail: the entries named move to the end of the order even when no session counted them before playable.
//   Without --write (the default): a dry run — per order, the entries and bytes (whole 1 MiB blocks, or their learned
//   pieces) that are flagged today and would leave the launch set. With --write the counts go (the file first copied to
//   <file>.bak-<time>). The server keeps the orders in memory and writes them back: run it while the server is stopped,
//   after tools/backup.sh snapshot, on a copy first.
import fs from 'node:fs';
import path from 'node:path';

const BLOCK = 1 << 20, CHUNK = 64 << 10;
const bits = (m) => { let n = 0; for (let x = m >>> 0; x; x &= x - 1) n++; return n; };
/** A file's key as the game's files are matched (case-insensitively, either separator). */
const fileKey = (p) => String(p).replace(/\\/g, '/').toLowerCase();
/** An entry's file (its key "path#block"). */
const entryFile = (k) => { const s = String(k), i = s.lastIndexOf('#'); return i < 0 ? s : s.slice(0, i); };
/** An entry's block (its key's number after '#'), null without one. */
const entryBlock = (k) => { const m = /#(\d+)$/.exec(String(k)); return m ? Number(m[1]) : null; };

/**
 * A --path as a selector: { key, lo, hi } — the file's key and its blocks [lo, hi] (every one without '#<blocks>').
 * A path whose own name holds '#' followed by anything but a block range is taken whole.
 */
export function parsePath(p) {
  const m = /^(.*)#(\d+)(?:(-)(\d*))?$/.exec(String(p));
  if (!m) return { key: fileKey(p), lo: 0, hi: Infinity };
  const lo = Number(m[2]), hi = m[3] ? (m[4] === '' ? Infinity : Number(m[4])) : lo;
  if (hi < lo) throw new Error(`${p}: empty block range`);
  return { key: fileKey(m[1]), lo, hi };
}

/**
 * An entry without its `pre` counts nor its phases, at time `t` (the order's end), in the row form the server writes
 * (server.js armLearnTimer): [k, t, n, mask], or [k, t, n] (no mask learned).
 */
export function unflagEntry(e, t = e[1]) {
  return e[3] === undefined || e[3] === null ? [e[0], t, e[2]] : [e[0], t, e[2], e[3]];
}

/**
 * The plan for an order (`entries`, `marks`: the version's marking sessions, playable-<manifest>.json): the entries of
 * `paths` (files, or blocks of them: parsePath) that carry a `pre` count — `hit`, a Set — and of them those flagged
 * today (`flagged`, `flaggedBytes`: whole blocks, or their learned pieces), and the order with them unflagged
 * (`entries`). `tail`: the entries of `paths` without a `pre` count move to the end too (`moved`, a Set, with `hit`'s).
 */
export function planUnflag(entries, paths, marks = 0, { tail = false } = {}) {
  const sel = paths.map(parsePath), hit = new Set(), moved = new Set();
  const named = (k) => { const f = fileKey(entryFile(k)), b = entryBlock(k); return sel.some((x) => x.key === f && (b === null ? x.lo === 0 && x.hi === Infinity : b >= x.lo && b <= x.hi)); };
  let flagged = 0, flaggedBytes = 0;
  // (after every other entry, in their own order: their time past the order's latest by their rank)
  const end = entries.reduce((m, e) => (Array.isArray(e) && Number.isFinite(e[1]) ? Math.max(m, e[1]) : m), 0) + 1;
  let rank = 0;
  const out = entries.map((e) => {
    if (!Array.isArray(e) || !named(e[0])) return e;
    if (!(e[4] > 0)) { if (!tail) return e; moved.add(e); return unflagEntry(e, end + rank++); }
    hit.add(e); moved.add(e);
    if (marks && e[4] * 2 >= marks) { flagged++; flaggedBytes += e[3] ? bits(e[3]) * CHUNK : BLOCK; }
    return unflagEntry(e, end + rank++);
  });
  return { hit, moved, flagged, flaggedBytes, entries: out };
}

/** The order of `file` with planUnflag's entries unflagged (only with `write`): the plan and `written`. */
export function unflagFile(file, paths, { write = false, now = new Date(), tail = false } = {}) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`${file}: not a learned order`);
  let marks = 0;
  try { marks = Number(JSON.parse(fs.readFileSync(file.replace(/prefetch-([^/\\]+)\.json$/, 'playable-$1.json'), 'utf8')).marks) || 0; } catch { /* never marked */ }
  const plan = planUnflag(entries, paths, marks, { tail });
  let written = false;
  if (write && plan.moved.size) {
    fs.copyFileSync(file, `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(plan.entries)); fs.renameSync(file + '.tmp', file);
    written = true;
  }
  return { ...plan, marks, written };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const VAL = ['--only', '--path'];
  const args = process.argv.slice(2), dir = args.find((a, i) => !a.startsWith('--') && !VAL.includes(args[i - 1]));
  const many = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const only = many('--only'), paths = many('--path'), write = args.includes('--write'), tail = args.includes('--tail');
  // (--only required: a file name shared by several games is never unflagged everywhere by mistake)
  if (!dir || !only.length || !paths.length) {
    console.error('usage: node tools/learn-unflag.mjs <learn dir> --only <manifest>... --path <game file>[#<blocks>]... [--tail] [--write]'); process.exit(2);
  }
  if (!write) console.log('dry run (--write to unflag)');
  for (const name of only) {
    const f = path.join(dir, `prefetch-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    if (!fs.existsSync(f)) { console.log(`${name}: no learned order (${f})`); continue; }
    const r = unflagFile(f, paths, { write, tail });
    console.log(`${name.padEnd(30)} ${String(r.hit.size).padStart(5)} entries counted before playable, ${r.flagged} flagged of ${r.marks} marks (${(r.flaggedBytes / 1048576).toFixed(2)} MB) out of the launch set${tail ? `; ${r.moved.size} entries to the order's end` : ''}${r.written ? ' -> written' : ''}`);
  }
}
