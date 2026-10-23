#!/usr/bin/env node
// Learned prefetch orders without the mask-less entries that are provably stale (docs/slow-network.md "Learned order").
// An entry learned before masks existed ([path#block, t, n], no fourth element) stands for a whole 1 MiB block: a link
// that is not fast fetches the learned pieces only (its mask), so on a thin link the learned pass skips such an entry
// altogether, and on a between link it fetches the whole block.
//
// A mask-less entry is NOT a block "no recent session read": it is also the only record of a phase no recent session
// reached (a map load after sessions that stopped at the menu). The prune of 2026-10-21, which dropped every mask-less
// entry of an order that had enough masked ones, took BFME II's map load out of its order (docs/startup.md "Why RotWK
// 2.02 and BFME II waited"). So an entry is dropped only when one of two rules proves it stale:
//
//   masked-duplicate  the same block (path compared case-insensitively, '\' as '/') has a masked entry in the order:
//                     a session re-learned it since masks exist (the server ORs the pieces into the entry it reads), the
//                     mask-less record adds nothing but a whole-block fetch.
//   passed-unread     at least --sessions N (default 3) of the --recent K (default 10) latest sessions provably went
//                     through the entry's phase / time without reading the block. Needs a per-session record of reads
//                     (sessions-<manifest>.json, below). The server keeps none on disk (its sessions' read sets live in
//                     memory, phases-<manifest>.json counts phase starts, not reads): without that file the rule
//                     refuses, and drops nothing.
//
// A session "passed" an entry when its record reached the entry's time (`reached` ≥ t) without reading the block, and
// it went through the entry's phase: one of the entry's phases (`ph`) is among the session's, or — an entry without
// phases — the session read at least half of the order's masked entries learned within --window ms (default 5000) of
// the entry's time, with at least --min-neighbors (default 3) such entries: a phase none of the recent sessions
// reached has no masked neighbours, so its entries stay.
//
// sessions-<manifest>.json (not written by the server today; a later server or an operator's export):
//   [{ "id": "…", "reached": <ms from the session's first read>, "phases": [["map", 41000], …], "read": ["path#block", …] }, …]
//   oldest first.
//
// Usage: node tools/learn-prune.mjs <learn dir> [--only <manifest>]... [--sessions N] [--recent K] [--window MS]
//          [--min-neighbors N] [--list] [--write]
//   Without --write (the default): a dry run — each prefetch-<manifest>.json, its entries, mask-less ones and what each
//   rule would drop (entries, whole-block MB), what stays and why; --list prints every mask-less entry with its verdict.
//   With --write the entries the rules drop go (the file first copied to <file>.bak-<time>). The server keeps the orders
//   in memory and writes them back: run it while the server is stopped (or just before its restart), on a copy first.
import fs from 'node:fs';
import path from 'node:path';

const BLOCK = 1 << 20, CHUNK = 64 << 10;
const bits = (m) => { let n = 0; for (let x = m >>> 0; x; x &= x - 1) n++; return n; };
const isMaskless = (e) => Array.isArray(e) && (e[3] === undefined || e[3] === null);
/** A block's key as the game's files are matched (case-insensitively, either separator). */
export const blockKey = (k) => String(k).replace(/\\/g, '/').toLowerCase();

/** An order's entries split: { all, maskless: [...], masked: [...], masklessBytes, maskedBytes }. */
export function splitOrder(entries) {
  const maskless = [], masked = [];
  for (const e of entries) (isMaskless(e) ? maskless : masked).push(e);
  return { all: entries.length, maskless, masked, masklessBytes: maskless.length * BLOCK, maskedBytes: masked.reduce((n, e) => n + (e[3] ? bits(e[3]) * CHUNK : BLOCK), 0) };
}

/** A session record checked: { id, reached, phases: Set, read: Set(blockKey) } or null. */
function sessionRecord(s) {
  if (!s || typeof s !== 'object' || !Number.isFinite(s.reached) || !Array.isArray(s.read)) return null;
  return { id: String(s.id ?? ''), reached: s.reached, phases: new Set((Array.isArray(s.phases) ? s.phases : []).filter(Array.isArray).map((p) => String(p[0]))),
    read: new Set(s.read.map(blockKey)) };
}

/**
 * The verdict on each mask-less entry of `entries`: { drops: Map(entry -> rule), kept: Map(entry -> reason),
 * rules: { 'masked-duplicate': { entries, bytes }, 'passed-unread': { entries, bytes, refused? } } }.
 * `sessions`: the per-session records, oldest first (null: none kept — the passed-unread rule refuses).
 */
export function planPrune(entries, { sessions = null, need = 3, recent = 10, windowMs = 5000, minNeighbors = 3 } = {}) {
  const s = splitOrder(entries), drops = new Map(), kept = new Map();
  const maskedKeys = new Set(s.masked.filter(Array.isArray).map((e) => blockKey(e[0])));
  const recs = sessions ? sessions.map(sessionRecord).filter(Boolean).slice(-recent) : null;
  const masked = s.masked.filter((e) => Array.isArray(e) && Number.isFinite(e[1])).sort((a, b) => a[1] - b[1]);
  const neighbours = (t) => { // (the masked entries learned within windowMs of t)
    let lo = 0, hi = masked.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (masked[mid][1] < t - windowMs) lo = mid + 1; else hi = mid; }
    const out = []; for (let i = lo; i < masked.length && masked[i][1] <= t + windowMs; i++) out.push(blockKey(masked[i][0]));
    return out;
  };
  const passed = (r, e, key) => {
    if (r.read.has(key) || !(r.reached >= e[1])) return false;
    const ph = e[6] && typeof e[6] === 'object' ? Object.keys(e[6]) : [];
    if (ph.length) return ph.some((p) => r.phases.has(p));
    const nb = neighbours(e[1]);
    return nb.length >= minNeighbors && nb.filter((k) => r.read.has(k)).length * 2 >= nb.length;
  };
  for (const e of s.maskless) {
    const key = blockKey(e[0]);
    if (maskedKeys.has(key)) { drops.set(e, 'masked-duplicate'); continue; }
    if (!recs) { kept.set(e, 'no per-session record (passed-unread refused)'); continue; }
    const n = recs.filter((r) => passed(r, e, key)).length;
    if (n >= need && recs.length) drops.set(e, 'passed-unread');
    else kept.set(e, `${n} of ${recs.length} recent sessions passed it unread (${need} needed)`);
  }
  const rule = (name) => { const n = [...drops.values()].filter((v) => v === name).length; return { entries: n, bytes: n * BLOCK }; };
  return { ...s, drops, kept, rules: { 'masked-duplicate': rule('masked-duplicate'), 'passed-unread': { ...rule('passed-unread'), ...(recs ? { sessions: recs.length } : { refused: true }) } } };
}

/** The per-session records kept beside an order (sessions-<manifest>.json), null when there are none. */
export function readSessions(file) {
  const f = file.replace(/prefetch-([^/\\]+)\.json$/, 'sessions-$1.json');
  if (f === file || !fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!Array.isArray(j)) throw new Error(`${f}: not a list of session records`);
  return j;
}

/** The order of `file` with the entries planPrune drops taken out (only with `write`): the plan and `written`. */
export function pruneFile(file, { write = false, now = new Date(), sessions, ...opts } = {}) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`${file}: not a learned order`);
  const plan = planPrune(entries, { sessions: sessions === undefined ? readSessions(file) : sessions, ...opts });
  let written = false;
  if (write && plan.drops.size) {
    fs.copyFileSync(file, `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(entries.filter((e) => !plan.drops.has(e)))); fs.renameSync(file + '.tmp', file);
    written = true;
  }
  return { ...plan, written };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const VAL = ['--only', '--sessions', '--recent', '--window', '--min-neighbors'];
  const args = process.argv.slice(2), dir = args.find((a, i) => !a.startsWith('--') && !VAL.includes(args[i - 1]));
  const usage = 'usage: node tools/learn-prune.mjs <learn dir> [--only <manifest>]... [--sessions N] [--recent K] [--window MS] [--min-neighbors N] [--list] [--write]';
  if (args.includes('--min-masked')) { console.error('--min-masked is gone: a count of masked entries does not prove a mask-less one stale (docs/slow-network.md)'); process.exit(2); }
  if (!dir) { console.error(usage); process.exit(2); }
  const num = (flag, d) => { if (!args.includes(flag)) return d; const v = Number(args[args.indexOf(flag) + 1]); if (!(v >= 0)) { console.error(`${flag}: a number`); process.exit(2); } return v; };
  const opts = { need: Math.max(1, num('--sessions', 3)), recent: num('--recent', 10), windowMs: num('--window', 5000), minNeighbors: Math.max(1, num('--min-neighbors', 3)) };
  const only = args.flatMap((a, i) => (a === '--only' ? [args[i + 1]] : [])), write = args.includes('--write'), list = args.includes('--list');
  const MB = (b) => (b / 1048576).toFixed(0);
  if (!write) console.log('dry run (--write to drop)');
  for (const f of fs.readdirSync(dir).filter((n) => /^prefetch-.+\.json$/.test(n)).sort()) {
    const name = f.slice('prefetch-'.length, -'.json'.length);
    if (only.length && !only.includes(name)) continue;
    const r = pruneFile(path.join(dir, f), { write, ...opts });
    const md = r.rules['masked-duplicate'], pu = r.rules['passed-unread'];
    console.log(`${name.padEnd(40)} ${String(r.all).padStart(6)} entries, ${String(r.maskless.length).padStart(5)} mask-less (${MB(r.masklessBytes)} MB whole blocks), masked ${MB(r.maskedBytes)} MB${r.written ? ` -> ${r.drops.size} dropped` : ''}`);
    if (!r.maskless.length) continue;
    console.log(`  masked-duplicate: ${md.entries} (${MB(md.bytes)} MB)   passed-unread: ${pu.refused ? 'refused (no sessions-' + name + '.json: the server keeps no per-session reads)' : `${pu.entries} (${MB(pu.bytes)} MB) over ${pu.sessions} recent sessions`}   kept: ${r.kept.size}`);
    if (list) for (const e of r.maskless) console.log(`    ${String(e[0]).padEnd(60)} t ${String(Math.round(e[1])).padStart(8)} ms  ${r.drops.has(e) ? 'drop: ' + r.drops.get(e) : 'keep: ' + r.kept.get(e)}`);
  }
}
