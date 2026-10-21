#!/usr/bin/env node
// Learned prefetch orders without their old mask-less entries (docs/slow-network.md "Learned order"). An entry learned
// before masks existed ([path#block, t, n], no fourth element) stands for a whole 1 MiB block: a link that is not fast
// fetches the learned pieces only (its mask), so on a thin link the learned pass skips such an entry altogether, and on a
// between link it fetches the whole block. Measured on the live orders (2026-10-21): bfme-vanilla 663 of 698 entries
// mask-less (650 MB raw, ~267 MB on the wire), bfme2 636 of 860, where a masked order of the same game is ~130-170 MB.
// They were never masked since because a Windows session's reads answered by the browser's copy or the learned prefetch
// never reached the server; the Win32 page now reports every read (worker.js reportReads), so each new session masks
// the blocks it reads again, and the entries left mask-less are blocks no recent session read.
//
// Usage: node tools/learn-prune.mjs <learn dir> [--only <manifest>]... [--min-masked N] [--write]
//   Lists each prefetch-<manifest>.json: entries, mask-less ones, their raw bytes (whole blocks) and the masked ones'
//   (their pieces). With --write, the mask-less entries of each order that has at least N masked entries (default 50:
//   enough sessions with masks to stand for it) are dropped — the file first copied to <file>.bak-<time>. The server
//   keeps the orders in memory and writes them back: run it while the server is stopped (or just before its restart).
import fs from 'node:fs';
import path from 'node:path';

const BLOCK = 1 << 20, CHUNK = 64 << 10;
const bits = (m) => { let n = 0; for (let x = m >>> 0; x; x &= x - 1) n++; return n; };

/** An order's entries split: { all, maskless: [...], masked: [...], masklessBytes, maskedBytes }. */
export function splitOrder(entries) {
  const maskless = [], masked = [];
  for (const e of entries) (Array.isArray(e) && (e[3] === undefined || e[3] === null) ? maskless : masked).push(e);
  return { all: entries.length, maskless, masked, masklessBytes: maskless.length * BLOCK, maskedBytes: masked.reduce((n, e) => n + (e[3] ? bits(e[3]) * CHUNK : BLOCK), 0) };
}

/** The order of `file` pruned (its mask-less entries out) when it has `minMasked` masked entries: { before, after, written }. */
export function pruneFile(file, { minMasked = 50, write = false, now = new Date() } = {}) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`${file}: not a learned order`);
  const s = splitOrder(entries), ok = s.maskless.length > 0 && s.masked.length >= minMasked;
  let written = false;
  if (write && ok) {
    fs.copyFileSync(file, `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(s.masked)); fs.renameSync(file + '.tmp', file);
    written = true;
  }
  return { ...s, prunable: ok, written };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), dir = args.find((a, i) => !a.startsWith('--') && !['--only', '--min-masked'].includes(args[i - 1]));
  if (!dir) { console.error('usage: node tools/learn-prune.mjs <learn dir> [--only <manifest>]... [--min-masked N] [--write]'); process.exit(2); }
  const only = args.flatMap((a, i) => (a === '--only' ? [args[i + 1]] : [])), write = args.includes('--write');
  const minMasked = args.includes('--min-masked') ? Number(args[args.indexOf('--min-masked') + 1]) : 50;
  const MB = (b) => (b / 1048576).toFixed(0);
  for (const f of fs.readdirSync(dir).filter((n) => /^prefetch-.+\.json$/.test(n)).sort()) {
    const name = f.slice('prefetch-'.length, -'.json'.length);
    if (only.length && !only.includes(name)) continue;
    const r = pruneFile(path.join(dir, f), { minMasked, write });
    console.log(`${name.padEnd(40)} ${String(r.all).padStart(6)} entries, ${String(r.maskless.length).padStart(5)} mask-less (${MB(r.masklessBytes)} MB whole blocks), masked ${MB(r.maskedBytes)} MB${r.written ? ' -> pruned' : r.prunable ? ' (prunable: --write)' : r.maskless.length ? ` (kept: fewer than ${minMasked} masked entries)` : ''}`);
  }
}
