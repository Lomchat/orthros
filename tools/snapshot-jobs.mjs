#!/usr/bin/env node
// Runs the shared snapshots' publishing sessions a sandboxed Orthros server queued (server --snapshot-queue, docs/snapshot.md
// stage 3): reads its queue file every 30 s and runs each request once, one at a time, through the browser slot guard
// (tools/snapshot-publish.mjs: the project's browser budget and load limit apply). Outside the server's sandbox: it needs
// the Playwright browsers and the shared /tmp of the slots.
//   node tools/snapshot-jobs.mjs --queue <learn>/snapshots/queue.json --server http://127.0.0.1:8095 [--once]
//   --once: the requests there now, then exit
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const queue = opt('queue'), server = opt('server'), once = args.includes('--once');
if (!queue || !server) { console.error('usage: snapshot-jobs.mjs --queue <file> --server <url> [--once]'); process.exit(2); }
const root = new URL('..', import.meta.url).pathname;
const done = new Set(); // (tokens run by this runner)
const log = (...a) => console.log(new Date().toISOString(), ...a);
const run = (j) => new Promise((resolve) => {
  const a = ['1500', path.join(root, 'tools/with-browser-slot.sh'), 'node', 'tools/snapshot-publish.mjs', j.name, '--url', server, '--lang', j.lang, '--key', j.key, '--token', j.token];
  const p = spawn('timeout', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d) => { for (const l of d.toString().split('\n').filter(Boolean)) log(`${j.name} ${j.lang}: ${l.slice(0, 300)}`); };
  p.stdout.on('data', out); p.stderr.on('data', out);
  p.on('exit', (code) => resolve(code)); p.on('error', () => resolve(-1));
});
for (;;) {
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(queue, 'utf8')).jobs ?? []; } catch { /* none yet */ }
  const todo = jobs.filter((j) => !done.has(j.token) && Date.now() - j.at < 2 * 3600e3);
  for (const j of todo) {
    done.add(j.token);
    log(`${j.name} ${j.lang}: publishing the snapshot of key ${j.key}`);
    log(`${j.name} ${j.lang}: exit ${await run(j)}`);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, 30000));
}
