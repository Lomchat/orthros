#!/usr/bin/env node
// Guest time per guest function from V8 CPU profiles of the emulator thread (startbench --cpu-prof, one or more windows):
// the translated regions (WebAssembly functions named r_<entry>, tier 2's t2_ / w2_, library kernels lib_*) are grouped
// by the guest function holding their entry. Function boundaries come from the modules' PE files: every target of a
// `call rel32` found in their executable sections, their exports and entry point (a region's entry belongs to the
// closest function start at or below it — a 16-aligned address after int3 / nop padding also starts one; regions also run the callees they translate with them, so a function's time
// includes what its regions inlined). The rest of the profile is summed by kind (JavaScript of the emulator, GC, the
// runtime module). With two profiles, the difference per function: which guest routines explain the growth.
// Usage: node tools/dev/guest-profile.mjs <a.cpuprofile> [<b.cpuprofile>] --pe <file.exe|dll>[@base]... [--frames A[,B]]
//          [--top 30] [--idiom 20]
//   --idiom N: the N hottest guest functions of the last profile decoded (a linear sweep from their start to the next
//   function start): their instructions, and those of the x87 compare idiom FCOM-family / FNSTSW AX / TEST or AND AH /
//   Jcc (a static count: the idiom's share of each function's code, weighted by the function's time for the total)
//   --frames: frames in each window (from the phase reports): the figures in ms per frame, else in ms per window
import fs from 'node:fs';
import path from 'node:path';
import { PeImage } from '../../src/loader/pe.js';
import { decode, OP, OT } from '../../src/cpu/decoder.js';

const argv = process.argv.slice(2);
const files = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const opts = (k) => argv.flatMap((a, i) => (a === '--' + k ? [argv[i + 1]] : []));
if (!files.length) { console.error('usage: guest-profile.mjs <a.cpuprofile> [<b.cpuprofile>] --pe <file>[@base]... [--frames A[,B]] [--top 30]'); process.exit(2); }
const frames = (opt('frames') ?? '').split(',').filter(Boolean).map(Number);
const top = Number(opt('top', 30));

/** modules: { name, base, end, starts (sorted absolute function starts), names (start -> export name) } */
const modules = [];
for (const spec of opts('pe')) {
  const [file, b] = spec.split('@');
  const img = new PeImage(new Uint8Array(fs.readFileSync(file)));
  const base = b ? parseInt(b, 16) : img.imageBase, starts = new Set(), names = new Map();
  const rvaOff = (rva) => { for (const s of img.sections) if (rva >= s.rva && rva < s.rva + Math.max(s.virtualSize, s.rawSize)) return rva - s.rva + s.rawPtr; return -1; };
  if (img.entryRva) starts.add(base + img.entryRva);
  for (const s of img.sections) {
    if (!(s.characteristics & 0x20000000)) continue; // (executable sections)
    const by = img.bytes, lo = s.rawPtr, hi = s.rawPtr + Math.min(s.rawSize, s.virtualSize || s.rawSize);
    for (let o = lo; o + 5 <= hi; o++) {
      if (by[o] !== 0xe8) continue;
      const t = (s.rva + (o - lo) + 5 + img.dv.getInt32(o + 1, true)) >>> 0;
      if (t >= s.rva && t < s.rva + s.virtualSize) starts.add(base + t);
    }
    // functions reached only through pointers (virtual methods): a 16-aligned start after the compiler's int3 / nop padding
    for (let o = lo + 16 - (lo & 15); o < hi; o += 16) if ((by[o - 1] === 0xcc || by[o - 1] === 0x90) && by[o] !== 0xcc && by[o] !== 0x90 && by[o] !== 0) starts.add(base + s.rva + (o - lo));
  }
  const ed = img.dirs[0];
  if (ed.rva) {
    const e = rvaOff(ed.rva), dv = img.dv;
    const nFn = dv.getUint32(e + 20, true), nNames = dv.getUint32(e + 24, true), fns = rvaOff(dv.getUint32(e + 28, true)), nms = rvaOff(dv.getUint32(e + 32, true)), ords = rvaOff(dv.getUint32(e + 36, true));
    for (let i = 0; i < nNames; i++) {
      const ord = dv.getUint16(ords + 2 * i, true); if (ord >= nFn) continue;
      const rva = dv.getUint32(fns + 4 * ord, true); if (rva >= ed.rva && rva < ed.rva + ed.size) continue; // (forwarder)
      starts.add(base + rva); names.set(base + rva, img.cstr(rvaOff(dv.getUint32(nms + 4 * i, true))));
    }
  }
  // (the image as mapped, for --idiom's decoding: addresses relative to the base)
  const mapped = new Uint8Array(img.sizeOfImage + 16);
  for (const s of img.sections) mapped.set(img.bytes.subarray(s.rawPtr, s.rawPtr + Math.min(s.rawSize, s.virtualSize || s.rawSize)), s.rva);
  modules.push({ name: path.basename(file).toLowerCase(), base, end: base + img.sizeOfImage, starts: Float64Array.from(starts).sort(), names, mem: { u8: mapped, i8: new Int8Array(mapped.buffer), dv: new DataView(mapped.buffer) } });
}
/** the guest function holding address a: "module!name" / "module!sub_<addr>", or the address */
function funcOf(a) {
  const m = modules.find((x) => a >= x.base && a < x.end);
  if (!m) return `?${a.toString(16)}`;
  let lo = 0, hi = m.starts.length - 1, f = -1;
  while (lo <= hi) { const k = (lo + hi) >> 1; if (m.starts[k] <= a) { f = k; lo = k + 1; } else hi = k - 1; }
  if (f < 0) return `${m.name}!?${a.toString(16)}`;
  const s = m.starts[f];
  return `${m.name}!${m.names.get(s) || 'sub_' + s.toString(16)}`;
}
/** the [start, end) of the function named by funcOf, and its module */
function funcRange(key) {
  const [mn, fn] = key.split('!'), m = modules.find((x) => x.name === mn); if (!m || !fn) return null;
  let s = fn.startsWith('sub_') ? parseInt(fn.slice(4), 16) : [...m.names].find(([, n]) => n === fn)?.[0];
  if (s === undefined) return null;
  const i = m.starts.indexOf(s); return { m, start: s, end: i + 1 < m.starts.length ? m.starts[i + 1] : m.end };
}
const X87_CMP = new Set(['FCOM', 'FCOMP', 'FCOMPP', 'FUCOM', 'FUCOMP', 'FUCOMPP', 'FICOM', 'FICOMP', 'FTST'].map((n) => OP[n]));
/** instructions of [start, end) and how many belong to compare idioms (FCOM-family, FNSTSW AX, TEST/AND AH, Jcc) */
function idiomCount({ m, start, end }) {
  const seq = [];
  for (let a = start - m.base; a < end - m.base && seq.length < 200000;) {
    let i; try { i = decode(m.mem, a); } catch { a++; continue; }
    seq.push(i); a = i.next;
  }
  let idiom = 0, sites = 0;
  for (let k = 0; k < seq.length; k++) {
    if (!X87_CMP.has(seq[k].op)) continue;
    // FNSTSW AX within the next two instructions, then TEST/AND AH (or SAHF), then Jcc
    for (let j = k + 1; j <= k + 3 && j < seq.length; j++) {
      if (seq[j].op !== OP.FNSTSW) continue;
      const t = seq[j + 1], c = seq[j + 2];
      const ahTest = t && ((t.op === OP.TEST || t.op === OP.AND) && t.ops[0]?.t === OT.REG && t.ops[0].size === 1 && t.ops[0].r === 4 || t.op === OP.SAHF);
      if (ahTest && c && c.op === OP.JCC) { idiom += 4; sites++; }
      break;
    }
  }
  return { insns: seq.length, idiom, sites };
}

/** self time (ms) per key of one profile: { byFunc, byKind, total } */
function read(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodeById = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < p.samples.length; i++) { const id = p.samples[i]; self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000); }
  const byFunc = new Map(), byKind = new Map(), byRegion = new Map(); let total = 0;
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  for (const [id, ms] of self) {
    const n = nodeById.get(id), name = n.callFrame.functionName || '(anonymous)', url = n.callFrame.url || '';
    total += ms;
    let r;
    if ((r = /^\$?(?:r|t2|w2)_([0-9a-f]+)$/.exec(name))) { add(byKind, 'guest: translated regions', ms); add(byFunc, funcOf(parseInt(r[1], 16)), ms); add(byRegion, name.replace(/^\$/, ''), ms); }
    else if (/^\$?lib_/.test(name)) { add(byKind, 'guest: library kernels', ms); add(byFunc, name, ms); }
    else if (name === '(idle)' || name === '(program)') add(byKind, name, ms);
    else if (name === '(garbage collector)') add(byKind, 'GC', ms);
    else if (url.startsWith('wasm://') || /^\$?wasm-function/.test(name)) add(byKind, 'wasm: runtime / other modules', ms);
    else {
      const f = url.replace(/^.*\/src\//, 'src/').replace(/^.*\/tools\//, 'tools/');
      const kind = /src\/cpu\/interp|decoder/.test(f) ? 'JS: interpreter' : /src\/cpu\/jit/.test(f) ? 'JS: JIT (translation, dispatch)' : /src\/(gfx|win32\/d3d)/.test(f) ? 'JS: Direct3D, recorder' : /src\/win32|src\/core/.test(f) ? 'JS: APIs, VM' : 'JS: other';
      add(byKind, kind, ms); add(byFunc, `[js] ${name} ${f.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`, ms);
    }
  }
  return { byFunc, byKind, byRegion, total };
}

const profs = files.map(read);
const per = (ms, i) => (frames[i] ? ms / frames[i] : ms);
const unit = frames.length ? 'ms per frame' : 'ms';
const fmt = (v) => v.toFixed(frames.length ? 3 : 1);
profs.forEach((p, i) => {
  console.log(`== ${files[i]}: ${p.total.toFixed(0)} ms sampled${frames[i] ? `, ${frames[i]} frames (${fmt(per(p.total, i))} ${unit})` : ''}`);
  for (const [k, v] of [...p.byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(36)} ${fmt(per(v, i)).padStart(9)} ${unit}  ${(100 * v / p.total).toFixed(1)} %`);
  const g = (p.byKind.get('guest: translated regions') ?? 0) + (p.byKind.get('guest: library kernels') ?? 0);
  console.log(`  top guest functions and JS functions (self time; % of the guest's / of all):`);
  for (const [k, v] of [...p.byFunc].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`    ${fmt(per(v, i)).padStart(8)} ${unit}  ${k.startsWith('[js]') ? '      ' : (100 * v / g).toFixed(1).padStart(5) + '%'} ${(100 * v / p.total).toFixed(1).padStart(5)}%  ${k}`);
});
if (profs.length === 2) {
  const [a, b] = profs, keys = new Set([...a.byFunc.keys(), ...b.byFunc.keys()]);
  const da = (k) => per(a.byFunc.get(k) ?? 0, 0), db = (k) => per(b.byFunc.get(k) ?? 0, 1);
  const gap = per(b.total, 1) - per(a.total, 0);
  const ga = per((a.byKind.get('guest: translated regions') ?? 0) + (a.byKind.get('guest: library kernels') ?? 0), 0), gb = per((b.byKind.get('guest: translated regions') ?? 0) + (b.byKind.get('guest: library kernels') ?? 0), 1);
  console.log(`== difference (second - first): all ${fmt(gap)} ${unit}, translated guest code ${fmt(ga)} -> ${fmt(gb)} (${fmt(gb - ga)})`);
  for (const k of new Set([...a.byKind.keys(), ...b.byKind.keys()])) console.log(`  ${k.padEnd(36)} ${fmt(per(a.byKind.get(k) ?? 0, 0)).padStart(9)} -> ${fmt(per(b.byKind.get(k) ?? 0, 1)).padStart(9)}`);
  const rows = [...keys].map((k) => [k, da(k), db(k)]).sort((x, y) => (y[2] - y[1]) - (x[2] - x[1]));
  for (const [title, pick, denom] of [['guest functions', (k) => !k.startsWith('[js]'), gb - ga], ['JavaScript functions', (k) => k.startsWith('[js]'), gap]]) {
    let cum = 0;
    console.log(`  ${title} by growth (${unit}: first -> second, growth, share of the ${title === 'guest functions' ? "guest code's" : "whole profile's"} growth, cumulative):`);
    for (const [k, x, y] of rows.filter(([k]) => pick(k)).slice(0, top)) { cum += y - x; console.log(`    ${fmt(x).padStart(8)} -> ${fmt(y).padStart(8)}  ${(y - x >= 0 ? '+' : '') + fmt(y - x)}  ${(100 * (y - x) / denom).toFixed(1).padStart(5)}%  ${(100 * cum / denom).toFixed(1).padStart(5)}%  ${k}`); }
  }
}
if (opt('idiom')) {
  const p = profs[profs.length - 1], i = profs.length - 1;
  const g = [...p.byFunc].filter(([k]) => !k.startsWith('[js]') && !k.startsWith('lib_') && !k.startsWith('$lib_')).sort((a, b) => b[1] - a[1]).slice(0, Number(opt('idiom')));
  let wt = 0, wi = 0;
  console.log(`== x87 compare idiom (FCOM-family, FNSTSW AX, TEST/AND AH, Jcc) in the hottest guest functions of ${files[i]} (static)`);
  for (const [k, v] of g) {
    const r = funcRange(k); if (!r) { console.log(`    ${k}: no range`); continue; }
    const c = idiomCount(r);
    wt += v; wi += v * (c.insns ? c.idiom / c.insns : 0);
    console.log(`    ${fmt(per(v, i)).padStart(8)} ${unit}  ${k} (${(r.end - r.start)} bytes): ${c.insns} instructions, ${c.sites} idioms = ${(100 * c.idiom / Math.max(1, c.insns)).toFixed(1)} % of them`);
  }
  console.log(`  weighted by time: the idiom is ${(100 * wi / Math.max(1e-9, wt)).toFixed(1)} % of these functions' instructions`);
}
