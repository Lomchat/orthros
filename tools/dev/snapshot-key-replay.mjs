// How often a snapshot key would change over Orthros' history (docs/snapshot.md "A key from the state's shape"): for
// each state of a range — every commit (`--range a..b`, first parent) or every update of main the live tree served
// (`--reflog <since>`, main's reflog) — the snapshot sources' closure (src/server/snapshot-sources.js, today's
// definition, applied to that state's src/) and four candidate keys:
// - src: the closure's paths and contents (today's key);
// - stripped: the same without comments and whitespace;
// - shapeFile: per closure file, the property names it assigns (`.x =`, `.x ??=`, `x++`...) or writes in an object
//   literal (`{ x: ...}`) and its snapshot registrations' text (snapshotClass, snapClass, snapKnown, snapshotConstant,
//   known, cacheKey, knowGraph) — a static over-approximation of the state's shape (it sees no meaning: a changed unit,
//   a guest-memory layout);
// - shapeGlobal: the same names and registrations merged over the closure (a field moved between files is kept).
// Prints how many transitions change each key, and the transitions that change today's key.
// Usage (from the repository): node tools/dev/snapshot-key-replay.mjs --range <a>..<b> | --reflog '2026-10-28 16' [--json <out>]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { snapshotSourceFiles } from '../../src/server/snapshot-sources.js';

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const git = (c) => execSync(`git ${c}`, { maxBuffer: 1 << 28 }).toString();
const H = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Tokens of JavaScript source, comments and whitespace dropped (strings, templates and regexes one token each). */
export function tokens(src) {
  const out = [], n = src.length, isId = (c) => /[A-Za-z0-9_$]/.test(c);
  const OPS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '??=', '||=', '&&=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
  let i = 0, prevStr = false;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; } out.push(src.slice(i, j + 1)); i = j + 1; prevStr = true; continue; }
    if (c === '`') {
      let j = i + 1, depth = 0;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (!depth && src[j] === '`') break; if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; } if (depth && src[j] === '}') depth--; j++; }
      out.push(src.slice(i, j + 1)); i = j + 1; prevStr = true; continue;
    }
    if (c === '/') {
      const p = out[out.length - 1];
      if (!p || (!isId(p[p.length - 1]) && !')]}'.includes(p) && !prevStr) || /^(return|typeof|case|in|of|new|delete|void|throw)$/.test(p)) {
        let j = i + 1, cls = false;
        while (j < n && (src[j] !== '/' || cls) && src[j] !== '\n') { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
        j++; while (j < n && /[a-z]/.test(src[j])) j++;
        out.push(src.slice(i, j)); i = j; prevStr = true; continue;
      }
    }
    prevStr = false;
    if (isId(c)) { let j = i; while (j < n && isId(src[j])) j++; out.push(src.slice(i, j)); i = j; continue; }
    const op = OPS.find((o) => src.startsWith(o, i)) ?? c; out.push(op); i += op.length;
  }
  return out;
}

const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=', '||=', '&&=', '++', '--', '**=']);
const REG = new Set(['snapshotClass', 'snapClass', 'snapKnown', 'snapshotConstant', 'known', 'cacheKey', 'knowGraph']);
/** A file's shape: the property names it writes, its registrations' text; and its comment-free text. */
export function shapeOf(src) {
  const t = tokens(src), fields = new Set(), regs = [];
  for (let k = 0; k < t.length; k++) {
    const x = t[k];
    if (t[k - 1] === '.' && /^[A-Za-z_$]/.test(x) && ASSIGN.has(t[k + 1])) fields.add(x);
    if ((t[k - 1] === '{' || t[k - 1] === ',') && /^[A-Za-z_$'"]/.test(x) && t[k + 1] === ':') fields.add(x.replace(/['"]/g, ''));
    if (REG.has(x) && t[k + 1] === '(') { let d = 0, j = k + 1; for (; j < t.length; j++) { if (t[j] === '(') d++; else if (t[j] === ')' && --d === 0) break; } regs.push(t.slice(k, j + 1).join(' ')); }
  }
  return { fields: [...fields].sort(), regs, stripped: t.join(' ') };
}

function stateKeys(sha, tmp) {
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  execSync(`git archive ${sha} src | tar -x -C ${tmp}`);
  const files = snapshotSourceFiles(tmp), c = {}, sh = {};
  for (const f of files) { c[f] = fs.readFileSync(path.join(tmp, f), 'utf8'); sh[f] = shapeOf(c[f]); }
  return { sha, files: c, sh,
    src: H(files.map((f) => f + '\0' + c[f]).join('\0')),
    stripped: H(files.map((f) => f + '\0' + sh[f].stripped).join('\0')),
    shapeFile: H(files.map((f) => f + '\0' + sh[f].fields.join(',') + '\0' + sh[f].regs.join('\n')).join('\0')),
    shapeGlobal: H([...new Set(files.flatMap((f) => sh[f].fields))].sort().join(',') + '\0' + files.flatMap((f) => sh[f].regs).sort().join('\n')) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let shas, label = (s) => s;
  if (opt('--range')) { const r = opt('--range'); shas = [git(`rev-parse ${r.split('..')[0]}`).trim(), ...git(`rev-list --reverse --first-parent ${r}`).trim().split('\n')]; }
  else if (opt('--reflog')) {
    const since = opt('--reflog'), at = new Map();
    const st = git('reflog show main --date=iso --format=%H#%gd').trim().split('\n').map((l) => { const [sha, gd] = l.split('#'); return { sha, at: gd.slice(6, 25) }; })
      .filter((s) => s.at >= since).reverse();
    shas = st.map((s) => s.sha); st.forEach((s) => at.set(s.sha, s.at)); label = (s) => at.get(s);
  } else { console.error('usage: --range a..b | --reflog <since>'); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(process.env.ORTHROS_SCRATCH ?? (fs.mkdirSync('/tmp/orthros-scratch', { recursive: true }), '/tmp/orthros-scratch'), 'snapshot-key-replay-'));
  const KEYS = ['src', 'stripped', 'shapeFile', 'shapeGlobal'], rows = [];
  try {
    let prev = null;
    for (const sha of shas) {
      const cur = stateKeys(sha, tmp);
      if (prev) {
        const changed = [...new Set([...Object.keys(prev.files), ...Object.keys(cur.files)])].filter((f) => prev.files[f] !== cur.files[f]);
        const fields = [];
        for (const f of changed) {
          const A = new Set(prev.sh[f]?.fields ?? []), B = new Set(cur.sh[f]?.fields ?? []);
          for (const x of B) if (!A.has(x)) fields.push(`${f.slice(4)}:+${x}`);
          for (const x of A) if (!B.has(x)) fields.push(`${f.slice(4)}:-${x}`);
        }
        rows.push({ sha: sha.slice(0, 8), at: label(sha), subject: git(`log -1 --format=%s ${sha}`).trim().slice(0, 100),
          ...Object.fromEntries(KEYS.map((k) => [k, prev[k] !== cur[k]])), changed: changed.map((f) => f.slice(4)), fields });
      }
      prev = cur; process.stderr.write('.');
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.stderr.write('\n');
  const keyed = rows.filter((r) => r.src);
  console.log(`${rows.length} transitions; changed: ${KEYS.map((k) => `${k} ${rows.filter((r) => r[k]).length}`).join(', ')}`);
  console.log(`of the ${keyed.length} that change today's key, kept by: ${KEYS.slice(1).map((k) => `${k} ${keyed.filter((r) => !r[k]).length}`).join(', ')}`);
  for (const r of keyed) console.log(`${KEYS.slice(1).map((k) => (r[k] ? 'x' : '.')).join('')} ${r.sha} ${r.at === r.sha ? '' : r.at + ' '}${r.subject.slice(0, 70)} | ${r.fields.slice(0, 5).join(' ')}`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(rows, null, 1));
}
