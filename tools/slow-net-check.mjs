// Slow-network check (docs/slow-network.md): plays bench scenarios (tools/scenarios/bench) in a fresh browser profile
// over a simulated thin link — a new player's first launch on a home connection — and prints, per game and speed, the
// time of each phase (to the menu, to the first image in game), what the network carried (the game's own reads and
// the background downloads apart) and the bench outcome. Every browser goes through tools/with-browser-slot.sh (the
// project's budget of test browsers), one run at a time.
//
// Usage: node tools/slow-net-check.mjs [--bench vicecity-drive,bfme2-skirmish] [--speeds 85k,1m,5m] [--rtt 50]
//          [--learn-from <dir>] [--games-dir <dir>] [--out <dir>] [--seconds 1500] [--keep]
//   --speeds: 85k (85 KB/s, a thin home link), 1m (1 MB/s), 5m (5 MB/s), fast (no simulation), or <n>mbit
//   --learn-from: a copy of this directory is the server's learned data (what a new player gets from a live server:
//     its prefetch order, programs, regions); default none (nothing learned)
//   --keep: keep the browser profiles and logs (default: the profiles are removed, the logs kept in --out)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const benches = opt('bench', 'vicecity-drive').split(',').filter(Boolean);
const speeds = opt('speeds', '85k,1m,5m').split(',').filter(Boolean);
const rtt = Number(opt('rtt', 50)), seconds = Number(opt('seconds', 1500));
const out = path.resolve(opt('out', path.join(root, 'build', 'slow-net')));
const learnFrom = opt('learn-from'), gamesDir = opt('games-dir');
const index = JSON.parse(fs.readFileSync(path.join(root, 'tools/scenarios/bench/index.json'), 'utf8'));

/** --net argument of the harness (ms:Mbit/s) for a speed name, or null (no simulation) */
export function netArg(speed, rttMs = 50) {
  const s = speed.toLowerCase();
  if (s === 'fast' || s === 'none') return null;
  let m;
  if ((m = /^([\d.]+)k$/.exec(s))) return `${rttMs}:${(Number(m[1]) * 1000 * 8 / 1e6).toFixed(3)}`; // KB/s (1000 bytes)
  if ((m = /^([\d.]+)m$/.exec(s))) return `${rttMs}:${(Number(m[1]) * 8).toFixed(3)}`; // MB/s
  if ((m = /^([\d.]+)mbit$/.exec(s))) return `${rttMs}:${m[1]}`;
  throw new Error(`unknown speed ${speed} (85k, 1m, 5m, fast, <n>mbit)`);
}

/** The summary of one harness run's output: phases, marks, network. */
export function parseRun(text) {
  const r = { outcome: null, phases: [], marks: null, network: null, net: null, firstFrame: null };
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^\[bench\] (\w+)(?: \((.*)\))? after (\d+) s/.exec(line))) { r.outcome = m[1]; r.detail = m[2] ?? null; r.seconds = Number(m[3]); }
    else if ((m = /^\[bench\] phase (\S+): ([\d.]+) s ([\d.]+) fps/.exec(line))) r.phases.push({ label: m[1], seconds: Number(m[2]), fps: Number(m[3]) });
    else if ((m = /^\[bench\] marks: (.*)$/.exec(line))) r.marks = m[1];
    else if ((m = /^\[bench\] network: (.*)$/.exec(line))) r.network = m[1];
    else if ((m = /^\[net\] demand (.*)$/.exec(line))) r.net = m[1];
    else if ((m = /^\[input\] first Direct3D frame at (\d+)s/.exec(line))) r.firstFrame = Number(m[1]);
  }
  // times from the launch (the page's marks: when the scenario reached them): the menu, the first image in game (the
  // 'play' mark), and the bytes received by then
  r.at = {}; r.rx = {};
  for (const m of (r.marks ?? '').matchAll(/(\w+)@([\d.]+)s(?: \(([\d.]+) MB received\))?/g)) { r.at[m[1]] = Number(m[2]); if (m[3]) r.rx[m[1]] = Number(m[3]); }
  r.inGame = r.at.play ?? null;
  return r;
}

/** a TCP port free on 127.0.0.1 now (each run's fresh profile needs no fixed port; another project's server may hold any) */
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

function run(cmd, argv, logFile) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile);
    const p = spawn(cmd, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (d) => { text += d; log.write(d); });
    p.stderr.on('data', (d) => { log.write(d); });
    p.on('close', (code) => { log.end(); resolve({ code, text }); });
  });
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const rows = [];
  for (const bench of benches) {
    const def = index.benches.find((b) => b.name === bench);
    if (!def) { console.error(`no bench ${bench} in tools/scenarios/bench/index.json`); process.exit(2); }
    for (const speed of speeds) {
      const tag = `${bench}-${speed}`, tmp = fs.mkdtempSync(path.join(os.tmpdir(), `orthros-slownet-${tag}-`));
      const learn = path.join(tmp, 'learn'); fs.mkdirSync(learn);
      if (learnFrom) for (const f of fs.readdirSync(learnFrom)) fs.copyFileSync(path.join(learnFrom, f), path.join(learn, f));
      const net = netArg(speed, rtt);
      const argv = [path.join(root, 'tools/with-browser-slot.sh'), 'node', 'tools/headless.mjs', def.manifests[0], '--bench', bench, '--ui', '--seconds', String(seconds),
        '--shots', '120', '--out', path.join(out, tag), '--opfs', path.join(tmp, 'profile'), '--port', String(await freePort()), '--learn', learn, '--telemetry', path.join(tmp, 'telemetry'),
        ...(gamesDir ? ['--games-dir', gamesDir] : []), ...(net ? ['--net', net] : [])];
      console.log(`[slow-net] ${tag}: ${net ? `--net ${net}` : 'no simulated link'}, fresh profile${learnFrom ? `, learned data from ${learnFrom}` : ', nothing learned'}`);
      const t0 = Date.now();
      const { text } = await run('bash', argv, path.join(out, `${tag}.txt`));
      const r = parseRun(text);
      rows.push({ tag, speed, ...r, wall: Math.round((Date.now() - t0) / 1000) });
      console.log(`[slow-net] ${tag}: ${r.outcome ?? 'no bench result'}${r.detail ? ` (${r.detail})` : ''}; first frame ${r.firstFrame ?? '-'} s; ${Object.entries(r.at).map(([k, v]) => `${k} at ${v} s${r.rx[k] !== undefined ? ` (${r.rx[k]} MB received)` : ''}`).join(', ')}`);
      if (r.network) console.log(`[slow-net]   page: ${r.network}`);
      if (r.net) console.log(`[slow-net]   server: demand ${r.net}`);
      if (!args.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log('\nbench / speed            outcome   1st frame  menu   in game  network (page)');
  for (const r of rows) console.log(`${r.tag.padEnd(25)}${String(r.outcome ?? '-').padEnd(10)}${String(r.firstFrame ?? '-').padStart(8)} s${String(r.at.menu ?? '-').padStart(6)} s${String(r.inGame ?? '-').padStart(7)} s  ${r.network ?? '-'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
