#!/usr/bin/env node
// A warm job's learn session (src/server/warm-jobs.js, docs/snapshot.md "Warm jobs"; started by the server with
// --snapshot-jobs or by tools/snapshot-jobs.mjs, inside the browser slot guard): the version's learn scenarios played one
// after the other against that server (tools/headless.mjs --server-port: the server learns from their reads, GL programs,
// regions and heat), each on a fresh browser as a new player. A scenario whose every wait was met (it reached the screens
// it opens) is reported played, with the job's token: the server does not queue it again until it changes.
//   tools/with-browser-slot.sh node tools/warm-learn.mjs <manifest> --server <url> --token <token> --out <scratch dir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { learnScenarios, learnArgs } from '../src/server/warm-jobs.js';
import { WAIT_KINDS, parseScenario } from '../src/web/scenario.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const name = args[0], server = opt('server'), token = opt('token'), out = opt('out');
if (!name || !server || !token || !out) { console.error('usage: warm-learn.mjs <manifest> --server <url> --token <token> --out <dir>'); process.exit(2); }
const root = new URL('..', import.meta.url).pathname, port = new URL(server).port;
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

/** One headless session: resolves with the number of waits it met and its exit code. */
const session = (sc, dir) => new Promise((resolve) => {
  const p = spawn('node', learnArgs(root, name, port, dir, sc), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let met = 0, rest = '', status = '';
  const line = (l) => {
    if (/^\[input\] wait\w+ .*anchor at/.test(l)) { met++; log(`  ${l}`); } else if (/^\[(end|pageerror|crash)\]/.test(l)) log(`  ${l.slice(0, 300)}`);
    else if (l.startsWith('[t=')) status = l; // (the last state line: where a session that did not reach its screens stood)
  };
  const data = (d) => { const parts = (rest + d.toString()).split('\n'); rest = parts.pop(); parts.forEach(line); };
  p.stdout.on('data', data); p.stderr.on('data', data);
  p.on('exit', (code) => { if (rest) line(rest); resolve({ met, code, status }); });
  p.on('error', () => resolve({ met, code: -1, status }));
});

// (the learn scenarios the server has seen played already are skipped — all played: the lists are what is missing, all
// played again)
const done = new Set(await fetch(`${server}/api/warm-learned/${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : []), () => []));
const all = learnScenarios(root, name), todo = all.filter((sc) => !sc.required || !done.has(sc.id)), plan = todo.length ? todo : all, played = [];
log(`${name}: ${plan.length ? plan.map((s) => s.id).join(', ') : 'the boot only'}${plan.length < all.length ? ` (${all.length - plan.length} played already)` : ''}`);
for (const sc of plan.length ? plan : [null]) {
  const dir = fs.mkdtempSync(path.join(out, 'session-'));
  const waits = sc ? parseScenario(fs.readFileSync(sc.file, 'utf8')).steps.filter((s) => WAIT_KINDS.has(s.kind)).length : 0;
  const r = await session(sc, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  log(`${sc?.id ?? 'boot'}: exit ${r.code}, ${r.met}/${waits} waits met${r.met < waits ? ` (last: ${r.status.slice(0, 300)})` : ''}`);
  if (sc?.required && r.code === 0 && r.met >= waits) played.push(sc.id);
}
if (played.length) {
  const res = await fetch(`${server}/api/warm-learned/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}&ids=${encodeURIComponent(played.join(','))}`, { method: 'POST' }).catch((e) => ({ status: e.message }));
  log(`played ${played.join(', ')}: told the server (${res.status})`);
}
