#!/usr/bin/env node
// What the other versions' learned code data lends a version by content (src/server/code-share.js), from a learn
// directory: the server's answers to /api/heat and /api/regions, written as files startbench reads (--heat, --regions).
//   node tools/dev/code-share.mjs <manifest> --learn <dir> [--games-dir <dir>] [--from id,id] [--own 0|1]
//     [--heat-out <file>] [--regions-out <file>]
// --from: only those versions lend (default every other one); --own 0: the version's own data left out (a first
// session's view: what other versions taught alone). Prints the modules and pages lent.
import fs from 'node:fs';
import path from 'node:path';
import { loadGameCatalog, DEFAULT_GAMES_DIR } from '../../src/server/game-catalog.js';
import { listGameTree, resolveGameFile } from '../../src/server/game-files.js';
import { CodeShare, servedHeat, servedRegions, readHeatFile, readRegionsFile } from '../../src/server/code-share.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const learn = opt('learn');
if (!target || !learn) { console.error('usage: code-share.mjs <manifest> --learn <dir> [--games-dir <dir>] [--from id,id] [--own 0|1] [--heat-out f] [--regions-out f]'); process.exit(2); }
const catalog = loadGameCatalog(path.resolve(opt('games-dir', DEFAULT_GAMES_DIR)));
if (!catalog.has(target)) throw new Error(`no manifest ${target}`);
const from = opt('from') ? new Set(opt('from').split(',')) : null;
const name = (v) => v.replace(/[^A-Za-z0-9._-]/g, '_');
const heats = new Map(), regs = new Map(), memo = new Map(), trees = new Map();
const own0 = (v) => v === target && opt('own', '1') === '0'; // (a first session: nothing of its own, not even module names)
const heatOf = (v) => { if (own0(v)) return new Map(); if (!heats.has(v)) heats.set(v, readHeatFile(path.join(learn, `heat-${name(v)}.json`))); return heats.get(v); };
const regionsOf = (v) => { if (own0(v)) return new Map(); if (!regs.has(v)) regs.set(v, readRegionsFile(path.join(learn, `regions-${name(v)}.json`))); return regs.get(v); };
const lenders = (v) => v !== target && (!from || from.has(v));
const share = new CodeShare({
  versions: () => [...catalog.keys()].filter((v) => v === target || lenders(v)),
  manifestOf: (v) => catalog.get(v),
  tree: (v) => { if (!trees.has(v)) trees.set(v, listGameTree(catalog.get(v))); return trees.get(v); },
  resolve: (v, rel) => resolveGameFile(catalog.get(v), rel, memo),
  hasData: (v) => lenders(v) && (fs.existsSync(path.join(learn, `heat-${name(v)}.json`)) || fs.existsSync(path.join(learn, `regions-${name(v)}.json`))),
  heatOf, regionsOf,
});
const t0 = performance.now();
const lent = share.lend(target);
console.log(`[codeshare] ${target}: index of ${share.index.byHash.size} pages in ${(performance.now() - t0).toFixed(0)} ms (${share.stats.hashedFiles} files hashed); ${lent.pagesLent} pages lend`);
for (const [mod, p] of lent.heat) console.log(`[codeshare]   heat ${mod}: ${p.length / 2} ranges`);
const byMod = new Map(); for (const e of lent.regions) byMod.set(e[0], (byMod.get(e[0]) ?? 0) + 1);
console.log(`[codeshare]   regions: ${lent.regions.length} (${[...byMod].map(([m, n]) => `${m} ${n}`).join(', ')})`);
const ownHeat = heatOf(target), ownRegions = regionsOf(target);
if (opt('heat-out')) fs.writeFileSync(opt('heat-out'), JSON.stringify(servedHeat(ownHeat, lent)));
if (opt('regions-out')) {
  // (the served list in the learned file's format, [key, t, n], t its rank: read back in the served order)
  const list = servedRegions(ownRegions, lent);
  fs.writeFileSync(opt('regions-out'), JSON.stringify(list.map((e, i) => [`${e[0]}:${e[1]}:${e[2] ?? ''}`, i, 1])));
  console.log(`[codeshare] served regions: ${list.length} (${Math.min(ownRegions.size, list.length)} own)`);
}
