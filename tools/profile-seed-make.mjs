#!/usr/bin/env node
// Canonical first-launch profiles (docs/startup.md "Shared first-launch profile"): an operator makes, per Win32 version
// and game language, the set of profile files a new player's empty profile receives (the server offers it before any
// set the sessions reported: <learn>/seedcanon-<manifest>.json, read again when it changes). Generic: it iterates the
// game catalog, names no game.
//
//   node tools/profile-seed-make.mjs plan --games-dir <dir> [--learn <dir>] [--only id[:lang],...]
//       every win32 version × declared language, and what the learn dir holds for it (canonical, learned candidates)
//   node tools/profile-seed-make.mjs make --games-dir <dir> --learn <dir> [--only id[:lang],...] [--runs 2] [--seconds 170]
//       [--scratch <dir>] [--missing] [--accept agree|first] [-- <extra headless.mjs args>]
//       for each: `--runs` first launches with an empty profile (tools/with-browser-slot.sh node tools/headless.mjs <id>
//       --game-lang <l> --profile-seed 0 --profile-dir <empty dir> --seconds <s> --gl-discard --memprefetch), one after
//       the other; their profiles' seed files (seedSelect) compared; written as the canonical set when they agree (or,
//       --accept first, the first run's set, the others reported). --missing: only those without a canonical set yet.
//   node tools/profile-seed-make.mjs put <manifest> <lang> <profile-dir> --learn <dir> [--note <text>]
//       the seed files of a profile directory (e.g. a headless run's --profile-dir, edited by hand) as the canonical set
//   node tools/profile-seed-make.mjs promote <manifest> <lang> --learn <dir> [--key <set key>]
//       a set the sessions reported (the most reported one, or that key) as the canonical set
//   node tools/profile-seed-make.mjs show|remove <manifest> [<lang>] --learn <dir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { seedSelect, seedKey, toBase64, fromBase64, seedCanonFile, canonSets } from '../src/host/profile-seed.js';
import { loadGameCatalog } from '../src/host/game-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const args = dash >= 0 ? argv.slice(0, dash) : argv, extra = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [cmd] = pos;
const learn = opt('learn');
const die = (m) => { console.error(m); process.exit(2); };

const canonPath = (name) => path.join(learn, seedCanonFile(name));
const readCanon = (name) => { try { return canonSets(JSON.parse(fs.readFileSync(canonPath(name), 'utf8'))); } catch { return []; } };
/** the canonical sets of `name` with `set` for its language (null: that language's removed), written atomically */
function writeCanon(name, lang, set) {
  const sets = readCanon(name).filter((s) => s.lang !== lang);
  if (set) sets.push({ lang, files: set.files, at: Date.now(), note: set.note ?? '' });
  sets.sort((a, b) => (a.lang < b.lang ? -1 : 1));
  const f = canonPath(name);
  if (!sets.length) { fs.rmSync(f, { force: true }); return; }
  fs.mkdirSync(learn, { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify({ v: 1, sets: sets.map(({ lang: l, files, at, note }) => ({ lang: l, files, at, note })) }, null, 1));
  fs.renameSync(f + '.tmp', f);
  const back = readCanon(name).find((s) => s.lang === lang);
  if (set && !back) throw new Error('the canonical set did not read back');
  return back;
}
/** a profile directory's files ({ path, data }), '/'-separated paths */
function dirFiles(dir) {
  const out = [];
  const walk = (d, rel) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), p); else if (e.isFile()) out.push({ path: p, data: new Uint8Array(fs.readFileSync(path.join(d, e.name))) }); } };
  walk(dir, '');
  return out;
}
const asSet = (files) => { const sel = seedSelect(files); return { key: seedKey(sel), files: sel.map((f) => [f.path, toBase64(f.data)]) }; };
const describe = (files) => files.map(([p, d]) => `    ${p} (${fromBase64(d).length} bytes)${/\.(ini|cfg|txt)$/i.test(p) ? '\n' + new TextDecoder().decode(fromBase64(d)).trim().split(/\r?\n/).map((l) => '      | ' + l).join('\n') : ''}`).join('\n');
const learnedSets = (name) => { try { return JSON.parse(fs.readFileSync(path.join(learn, `profileseed-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), 'utf8')).sets ?? []; } catch { return []; } };

/** the win32 versions × languages of a catalog (--only id[:lang],... to restrict) */
function targets() {
  const dir = opt('games-dir') ?? die('--games-dir <dir> needed');
  const only = opt('only') ? opt('only').split(',').map((s) => s.split(':')) : null;
  const out = [];
  for (const [id, m] of loadGameCatalog(dir)) {
    if ((m.runtime ?? 'win32') !== 'win32' || m.profileSeed === false) continue;
    for (const lang of m.languages?.length ? m.languages : ['']) {
      if (only && !only.some(([i, l]) => i === id && (l === undefined || l === lang))) continue;
      out.push({ id, lang });
    }
  }
  return out;
}

function runHeadless(id, lang, profileDir, logFile) {
  const a = ['tools/with-browser-slot.sh', 'node', 'tools/headless.mjs', id, '--games-dir', opt('games-dir'), '--profile-seed', '0', '--profile-dir', profileDir,
    '--seconds', String(Number(opt('seconds', 170))), '--gl-discard', '--memprefetch', '--shots', '1000', '--out', path.join(path.dirname(profileDir), 'shots'), ...(lang ? ['--game-lang', lang] : []), ...extra];
  return new Promise((resolve) => {
    const log = fs.openSync(logFile, 'w');
    const p = spawn(a[0], a.slice(1), { cwd: ROOT, stdio: ['ignore', log, log] });
    p.on('exit', (code) => { fs.closeSync(log); resolve(code); });
  });
}

if (cmd === 'plan') {
  for (const { id, lang } of targets()) {
    const canon = learn ? readCanon(id).find((s) => s.lang === lang) : null;
    const cands = learn ? learnedSets(id).filter((s) => s.lang === lang) : [];
    console.log(`${id} ${lang || '-'}: ${canon ? `canonical ${canon.key} (${canon.files.length} file(s))` : 'no canonical set'}; learned candidates: ${cands.length ? cands.map((s) => `${s.key} × ${s.sessions.length}`).join(', ') : 'none'}`);
  }
} else if (cmd === 'make') {
  if (!learn) die('--learn <dir> needed');
  const runs = Math.max(1, Number(opt('runs', 2))), accept = opt('accept', 'agree');
  const scratch = path.resolve(opt('scratch', '/tmp/orthros-scratch/profile-seed-make'));
  let failed = 0;
  for (const { id, lang } of targets()) {
    if (args.includes('--missing') && readCanon(id).some((s) => s.lang === lang)) { console.log(`${id} ${lang}: canonical set present, skipped`); continue; }
    const sets = [];
    for (let r = 0; r < runs; r++) {
      const dir = path.join(scratch, `${id}-${lang || 'x'}-${r}`), prof = path.join(dir, 'profile');
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(prof, { recursive: true });
      const t0 = Date.now(), code = await runHeadless(id, lang, prof, path.join(dir, 'run.log'));
      const set = asSet(dirFiles(prof));
      console.log(`${id} ${lang} run ${r + 1}/${runs}: exit ${code}, ${((Date.now() - t0) / 1000).toFixed(0)} s, ${set.files.length} seed file(s), key ${set.files.length ? set.key : '-'} (log ${path.join(dir, 'run.log')})`);
      if (set.files.length) sets.push(set);
    }
    const agree = sets.length === runs && sets.every((s) => s.key === sets[0].key);
    if (!sets.length || (accept === 'agree' && !agree)) {
      failed++;
      console.log(`${id} ${lang}: NOT written — ${sets.length ? 'the runs disagree:' : 'no profile files (the game wrote nothing in the time given: --seconds)'}`);
      for (const s of sets) console.log(`  set ${s.key}\n${describe(s.files)}`);
      continue;
    }
    const kept = writeCanon(id, lang, { files: sets[0].files, note: `profile-seed-make ${new Date().toISOString()}, ${runs} run(s)${agree ? ' agreeing' : ', first kept'}` });
    console.log(`${id} ${lang}: canonical set ${kept.key} written to ${canonPath(id)}\n${describe(kept.files)}`);
    if (!agree) for (const s of sets.slice(1)) if (s.key !== sets[0].key) console.log(`  (another run gave ${s.key}:)\n${describe(s.files)}`);
  }
  if (!args.includes('--keep')) fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
} else if (cmd === 'put') {
  const [, name, lang, dir] = pos;
  if (!learn || !name || lang === undefined || !dir) die('usage: put <manifest> <lang> <profile-dir> --learn <dir>');
  const set = asSet(dirFiles(dir));
  if (!set.files.length) die(`no seed file in ${dir}`);
  const kept = writeCanon(name, lang, { files: set.files, note: opt('note', `put from ${dir}`) });
  console.log(`${name} ${lang}: canonical set ${kept.key}\n${describe(kept.files)}`);
} else if (cmd === 'promote') {
  const [, name, lang] = pos;
  if (!learn || !name || lang === undefined) die('usage: promote <manifest> <lang> --learn <dir> [--key K]');
  const c = learnedSets(name).filter((s) => s.lang === lang && (!opt('key') || s.key === opt('key'))).sort((a, b) => b.sessions.length - a.sessions.length || b.at - a.at)[0];
  if (!c) die(`no learned set for ${name} ${lang}${opt('key') ? ' with key ' + opt('key') : ''}`);
  const kept = writeCanon(name, lang, { files: c.files, note: `promoted from the learned set ${c.key} (${c.sessions.length} reporter(s))` });
  console.log(`${name} ${lang}: canonical set ${kept.key}\n${describe(kept.files)}`);
} else if (cmd === 'show' || cmd === 'remove') {
  const [, name, lang] = pos;
  if (!learn || !name) die(`usage: ${cmd} <manifest> [<lang>] --learn <dir>`);
  if (cmd === 'remove') { for (const s of readCanon(name)) if (lang === undefined || s.lang === lang) writeCanon(name, s.lang, null); console.log('removed'); }
  for (const s of readCanon(name)) console.log(`${name} ${s.lang}: canonical set ${s.key}${s.note ? ' — ' + s.note : ''}\n${describe(s.files)}`);
} else {
  die('usage: node tools/profile-seed-make.mjs plan|make|put|promote|show|remove ... (see the header)');
}
