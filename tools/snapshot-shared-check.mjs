#!/usr/bin/env node
// Shared snapshots end to end (docs/snapshot.md, stage 3): a private server keeping them (--snapshot-jobs, its learn
// directory in scratch); a first new player starts the game — there is none yet: the server runs its publishing session
// (tools/snapshot-publish.mjs) — then, once it published, a second new player (a fresh browser profile) must start
// from it. This script opens no browser itself: each player and the server's session go through the browser slot guard.
//   node tools/snapshot-shared-check.mjs <manifest> [--games-dir <dir>] [--lang <l>] [--wait <s>] [--after <s>] [--queue] [--keep]
//   --queue: as a sandboxed server (--snapshot-queue), the session run by tools/snapshot-jobs.mjs
//   --wait: seconds at most for the publishing session (1800); --after: seconds each player plays (30); --keep: the
//   scratch directory (server data, screenshots) kept
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from '../src/host/server.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = args[0], lang = opt('lang', 'en'), wait = Number(opt('wait', 1800)), after = opt('after', '30');
const dir = `/tmp/orthros-scratch/snapshot-shared-${name}`;
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'learn'), { recursive: true });
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const queued = args.includes('--queue');
const server = createServer({ gamesDir: opt('games-dir'), learnDir: path.join(dir, 'learn'), snapshotJobs: queued ? 'queue' : true });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const root = new URL('..', import.meta.url).pathname;
const player = (tag, expect) => new Promise((resolve) => {
  const a = ['node', 'tools/snapshot-browser-check.mjs', name, '--url', url, '--once', '--after', after, '--query', `gameLang=${lang}`, '--out', path.join(dir, tag), ...(expect ? ['--expect-restored'] : [])];
  const p = spawn(path.join(root, 'tools/with-browser-slot.sh'), a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => `  ${tag}: ${l}\n`).join('')));
  p.stderr.on('data', (d) => process.stderr.write(d));
  p.on('exit', (code) => resolve(code));
});
let ok = false;
try {
  log(`${name}: a first new player`);
  await player('first', false);
  const jobs = server.snapshotJobs;
  if (queued) {
    if (!jobs.jobs.length) throw new Error('no publishing session was queued');
    log('the runner publishes the queued snapshot');
    await new Promise((resolve) => {
      const p = spawn('node', ['tools/snapshot-jobs.mjs', '--queue', jobs.file, '--server', url, '--once'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => `  runner: ${l.slice(0, 250)}\n`).join('')));
      p.on('exit', resolve);
    });
  } else {
    if (!jobs.running && !jobs.queue.length && !jobs.tried.size) throw new Error('no publishing session was asked for');
    log('the server publishes its snapshot');
    const until = Date.now() + wait * 1000;
    while ((jobs.running || jobs.queue.length) && Date.now() < until) await new Promise((r) => setTimeout(r, 5000));
  }
  const logs = path.join(dir, 'learn', 'snapshots');
  for (const f of fs.readdirSync(logs).filter((x) => x.startsWith('publish-') && !queued)) for (const l of fs.readFileSync(path.join(logs, f), 'utf8').split('\n').filter((x) => /snapshot|done|failed|time is up|running/.test(x)).slice(-12)) console.log(`  publish: ${l.slice(0, 250)}`);
  const kept = fs.readdirSync(path.join(logs, name.replace(/[^A-Za-z0-9._-]/g, '_'))).filter((f) => f.endsWith('.json'));
  if (!kept.length) throw new Error('nothing published');
  log(`published: ${kept.map((f) => `${f} ${fs.readFileSync(path.join(logs, name.replace(/[^A-Za-z0-9._-]/g, '_'), f), 'utf8')}`).join('; ')}`);
  log(`${name}: a second new player`);
  ok = (await player('second', true)) === 0;
  log(ok ? 'PASSED: the second player started from the shared snapshot' : 'FAILED');
} catch (e) { log(`FAILED: ${e.message}`); }
finally {
  server.close();
  if (!args.includes('--keep')) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
