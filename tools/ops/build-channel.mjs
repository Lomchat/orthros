#!/usr/bin/env node
// The build players get (docs/builds.md): every page loads all its code from one frozen build of the tree
// (src/server/build-store.js), picked at its load; the channel says which:
//   auto (the default)  the live tree's latest build: every deploy — a merge into the live tree, a restart — reaches the
//                       next page loaded, as before builds
//   restart             the build of the tree as it was when the server started: a merge reaches players at the next
//                       restart (fewer new builds: a returning player downloads the page's code again at each one)
//   stable (promote)    a pinned build, until the next promotion, whatever the live tree does (promote <id>: any build
//                       kept — a rollback)
// A page opened with ?channel=main (a cookie; ?channel=stable to leave it) gets the live tree's latest build whatever the
// channel. The server reads the channel file at its next page (no restart).
//
// Usage: node tools/ops/build-channel.mjs [--builds /var/lib/orthros/builds] [--url http://127.0.0.1:8095] <command>
//   status          the live tree's build, the server's, the channel, the builds kept (newest use first)
//   auto | restart  that channel
//   promote [<id>]  the stable channel pinned to build <id> (kept in the store), or to the live tree's build — the
//                   server's once it has cut the tree as it is now (asked at --url, waited for up to 20 s)
// --builds: the server's store (its --builds, default <learn>/../builds: /var/lib/orthros/builds for orthros.service).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChannel, treeBuildId } from '../../src/server/build-store.js';
import { BUILD_ID } from '../../src/shared/build-path.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const dir = opt('--builds', '/var/lib/orthros/builds'), url = opt('--url', 'http://127.0.0.1:8095').replace(/\/$/, '');
const [cmd = 'status', id] = args;

const meta = (b) => { try { return JSON.parse(fs.readFileSync(path.join(dir, b, 'build.json'), 'utf8')); } catch { return null; } };
const server = async () => { try { const r = await fetch(`${url}/api/build`, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; } catch { return null; } };
const write = (c) => {
  const f = path.join(dir, 'channel.json'), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...c, at: new Date().toISOString(), version: c.stable ? meta(c.stable)?.version ?? null : null }, null, 1) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, f);
};
const describe = (c) => (c.stable ? `stable, pinned to ${c.stable} (${meta(c.stable)?.version ?? 'not in the store: the live build served'})` : c.mode === 'restart' ? 'restart (the build of the server\'s start)' : 'auto (the live tree\'s latest build)');
if (!fs.existsSync(dir)) { console.error(`${dir}: no build store (the server's --builds)`); process.exit(2); }

if (cmd === 'status') {
  const live = treeBuildId(ROOT), s = await server(), c = readChannel(dir);
  console.log(`live tree (${ROOT}): ${live}${s ? (s.live === live ? ' — the server\'s live build' : ` — the server's live build is ${s.live} (cut at its next page once the tree is quiet)`) : ''}`);
  console.log(`channel: ${describe(c)}`);
  if (s) console.log(`a page loaded now gets ${s.build} (${s.version})`); else console.log(`server ${url}: no answer`);
  const all = fs.readdirSync(dir).filter((n) => BUILD_ID.test(n)).map((n) => ({ n, used: fs.statSync(path.join(dir, n)).mtimeMs, m: meta(n) })).sort((a, b) => b.used - a.used);
  let bytes = 0; for (const b of fs.readdirSync(path.join(dir, 'blobs'))) { try { bytes += fs.statSync(path.join(dir, 'blobs', b)).size; } catch { /* gone */ } }
  console.log(`${all.length} builds kept, their files ${(bytes / 1048576).toFixed(1)} MB (each file's bytes once):`);
  for (const b of all.slice(0, 20)) console.log(`  ${b.n}  ${b.m?.version ?? '?'}  cut ${b.m?.at?.slice(0, 16).replace('T', ' ') ?? '?'}  used ${new Date(b.used).toISOString().slice(0, 16).replace('T', ' ')}${b.n === c.stable ? '  [stable]' : ''}${b.n === s?.live ? '  [live]' : ''}${b.n === s?.start ? '  [start]' : ''}`);
} else if (cmd === 'promote') {
  let target = id;
  if (target && !meta(target)) { console.error(`${target}: no such build in ${dir}`); process.exit(1); }
  if (!target) {
    // (the tree as it is now: the server cuts it at a page once it is quiet — asked until it has)
    const live = treeBuildId(ROOT), until = Date.now() + 20000;
    for (;;) { const s = await server(); if (s?.live === live && meta(live)) break; if (Date.now() > until) { console.error(`the server (${url}) has not cut the live tree's build ${live} (its live build: ${s?.live ?? 'no answer'}): is the tree still being written, is --url the server?`); process.exit(1); } await new Promise((r) => setTimeout(r, 1000)); }
    target = live;
  }
  write({ stable: target, mode: 'auto' });
  console.log(`channel: ${describe({ stable: target })}: players' next pages get it; ?channel=main for the live tree's build`);
} else if (cmd === 'auto' || cmd === 'restart') {
  write({ stable: null, mode: cmd });
  console.log(`channel: ${describe({ stable: null, mode: cmd })}: players' next pages get it`);
} else { console.error('usage: build-channel.mjs [--builds <dir>] [--url <server>] status | auto | restart | promote [<id>]'); process.exit(2); }
