#!/usr/bin/env node
// Concurrent A/B of translation options on deterministic Node runs: every variant's runs play the same scenario at once
// (the same load on the shared machine) under startbench --virtual — the virtual clock makes a run repeat its guest
// work exactly (thread interleavings, inputs, frames) as long as nothing else differs, so phases compare the same work.
// A variant that changes where time slices end (region shapes: the budget is checked at chains and backward transfers)
// can still change the interleavings: the guest instructions of each phase are printed to tell.
// Usage: node tools/ab-virtual.mjs <manifest-id> --games-dir <dir> --input <scenario> [--profile-dir <dir>] [--heat <file>]
//          [--runs 2] [--limit 900] [--keep <dir>] --variant A='{}' --variant B='{"maxBlocks":96}' [-- <more startbench args>]
// Each variant's JSON is the runs' ORTHROS_JIT_DEFAULTS (translate.js JIT_DEFAULTS). Prints, per phase and variant, the
// guest time per guest instruction (frame accounting's guest category) and the emulator thread's CPU per frame, each
// run's and the mean, and the mean's difference from the first variant's.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const args = dash >= 0 ? argv.slice(0, dash) : argv, passThrough = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const target = args[0];
const variants = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--variant') { const v = args[i + 1], e = v.indexOf('='); variants.push({ name: v.slice(0, e), json: v.slice(e + 1) }); }
if (!target || target.startsWith('--') || !opt('input') || variants.length < 1) {
  console.error('usage: node tools/ab-virtual.mjs <manifest-id> --games-dir <dir> --input <scenario> --variant A=\'{}\' --variant B=\'{...}\' [--runs 2] [--profile-dir <dir>] [--heat <file>]');
  process.exit(2);
}
for (const v of variants) JSON.parse(v.json); // (fails early on a typo)
const runs = Number(opt('runs', 2));
const dir = opt('keep') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-abv-'));
fs.mkdirSync(dir, { recursive: true });
const bench = new URL('./startbench.mjs', import.meta.url).pathname;

const jobs = [];
for (let r = 0; r < runs; r++) for (const v of (r % 2 ? [...variants].reverse() : variants)) jobs.push({ v, r, name: `${v.name}-${r}` });
const started = jobs.map((j) => new Promise((resolve) => {
  const a = [bench, target, '--input', opt('input'), '--virtual', '--limit', opt('limit', '900'), '--phases', path.join(dir, j.name + '.json')];
  if (opt('games-dir')) a.push('--games-dir', opt('games-dir'));
  if (opt('heat')) a.push('--heat', opt('heat'));
  if (opt('profile-dir')) { const p = path.join(dir, 'profile-' + j.name); fs.rmSync(p, { recursive: true, force: true }); fs.cpSync(opt('profile-dir'), p, { recursive: true }); a.push('--save', p); }
  a.push(...passThrough);
  const log = fs.openSync(path.join(dir, j.name + '.log'), 'w');
  const c = spawn(process.execPath, a, { stdio: ['ignore', log, log], env: { ...process.env, ORTHROS_JIT_DEFAULTS: j.v.json } });
  c.on('exit', (code) => { fs.closeSync(log); resolve(code); });
}));
console.log(`${jobs.length} runs in ${dir}`);
await Promise.all(started);

const byPhase = new Map(); // label -> variant -> [{ ns, cpuMsPerFrame, insns }]
for (const j of jobs) {
  let res; try { res = JSON.parse(fs.readFileSync(path.join(dir, j.name + '.json'), 'utf8')); } catch { console.log(`${j.name}: no phases (see ${path.join(dir, j.name + '.log')})`); continue; }
  for (const p of res) {
    if (!byPhase.has(p.label)) byPhase.set(p.label, new Map());
    const m = byPhase.get(p.label); if (!m.has(j.v.name)) m.set(j.v.name, []);
    m.get(j.v.name).push({ ns: p.guestMsPerMInsn, cpuMsPerFrame: p.frames ? (p.threadCpuS ?? p.cpuS) * 1000 / p.frames : 0, insns: p.guestInsns });
  }
}
const mean = (l) => l.reduce((s, x) => s + x, 0) / Math.max(1, l.length);
for (const [label, m] of byPhase) {
  console.log(`phase ${label}`);
  const base = m.get(variants[0].name);
  for (const v of variants) {
    const l = m.get(v.name); if (!l) continue;
    const ns = mean(l.map((x) => x.ns)), cpu = mean(l.map((x) => x.cpuMsPerFrame));
    const d = base && v !== variants[0] ? ` (${(100 * (ns / mean(base.map((x) => x.ns)) - 1)).toFixed(1)} %, CPU per frame ${(100 * (cpu / mean(base.map((x) => x.cpuMsPerFrame)) - 1)).toFixed(1)} %)` : '';
    console.log(`  ${v.name.padEnd(10)} guest ${ns.toFixed(3)} ns per instruction [${l.map((x) => x.ns.toFixed(3)).join(' ')}], thread CPU ${cpu.toFixed(2)} ms per frame [${l.map((x) => x.cpuMsPerFrame.toFixed(2)).join(' ')}], ${l.map((x) => (x.insns / 1e6).toFixed(0)).join('/')} M instructions${d}`);
  }
}
