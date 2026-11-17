// Multi-pass effects and depth: a pass drawn again over the same geometry (depth test LESSEQUAL / EQUAL, often no depth
// write) z-fights unless its vertex shader computes the position exactly as the first pass did. For every technique
// with several passes of the D3DX effects given (compiled .fxo files, or the .big archives of a SAGE game holding
// them), this prints each pass's vertex shaders with the instructions oPos depends on (temporary registers renamed by
// first use, `def` constants as K) and the GLSL statements the translator (gfx/d3d9-shaders.js) emits for them, and
// counts the distinct ones: passes sharing their position code get the same GLSL operations in the same order, and
// every generated vertex shader declares `invariant gl_Position` (docs/aotr-play.md "Shadows").
// Usage: node tools/dev/fx-position-check.mjs <file.fxo | archive.big>...
import fs from 'node:fs';
import { parseEffect, PT } from '../../src/win32/d3dx9-fxparse.js';
import { disasmShader9, translateVertexShader9 } from '../../src/gfx/d3d9-shaders.js';

/** the .fxo entries of a BIG archive (SAGE: offsets and sizes big-endian, NUL-terminated names) */
function bigEffects(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), tag = String.fromCharCode(...buf.subarray(0, 4)), out = [];
  if (tag !== 'BIGF' && tag !== 'BIG4') return out;
  let p = 16;
  for (let i = 0, n = dv.getUint32(8); i < n; i++) {
    const off = dv.getUint32(p), size = dv.getUint32(p + 4); p += 8;
    let name = ''; while (buf[p]) name += String.fromCharCode(buf[p++]); p++;
    if (/\.fxo$/i.test(name)) out.push([name, buf.subarray(off, off + size)]);
  }
  return out;
}
const words = (data) => new Uint32Array(data.buffer.slice(data.byteOffset, data.byteOffset + (data.length & ~3)));
const isVS = (data) => data && data.length >= 8 && (words(data)[0] >>> 16) === 0xfffe;
/** the statements oPos depends on: a backward walk over `lines` ({ dst, srcs, text }), registers renamed by first use */
function slice(lines, start = 'oPos') {
  const reg = (s) => /(o[A-Za-z]+\d*|r\d+|v\d+|c\d+|a0)/.exec(s.replace(/^-/, ''))?.[1];
  const need = new Set([start]), out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = reg(lines[i].dst); if (!d || !need.has(d)) continue;
    out.unshift(lines[i].text); if (!/\.[xyzw]+$/.test(lines[i].dst)) need.delete(d);
    for (const s of lines[i].srcs) { const r = reg(s); if (r && (r[0] === 'r' || r[0] === 'a')) need.add(r); }
  }
  const map = new Map();
  return out.map((l) => l.replace(/\br\d+\b/g, (m) => { if (!map.has(m)) map.set(m, `t${map.size}`); return map.get(m); })).join('; ');
}
function asmSlice(code) {
  const all = disasmShader9(code).split('\n').map((l) => l.trim()).filter(Boolean), defs = new Set(all.filter((l) => l.startsWith('def ')).map((l) => /def (c\d+)/.exec(l)?.[1]));
  return slice(all.filter((l) => !/^(vs_|dcl|def)/.test(l)).map((text) => { const m = /^\S+\s+(.*)$/.exec(text), ops = m ? m[1].split(',').map((s) => s.trim()) : []; return { text: text.replace(/\bc\d+\b/g, (c) => (defs.has(c) ? 'K' : c)), dst: ops[0] ?? '', srcs: ops.slice(1) }; }));
}
function glslSlice(code) {
  const g = translateVertexShader9(code, null, true).glsl.split('\n').map((l) => l.trim()), body = g.slice(g.indexOf('void main() {') + 1);
  const invariant = g.includes('invariant gl_Position;');
  const lines = body.map((text) => { const m = /^(\w+(?:\.[xyzw]+)?)\s*=\s*(.*);$/.exec(text); return m ? { text: text.replace(/;$/, '').replace(/\bc\d+\b/g, 'K'), dst: m[1], srcs: m[2].match(/\br\d+(?:\.[xyzw]+)?\b|\ba0\b/g) ?? [] } : { text, dst: '', srcs: [] }; });
  return `${invariant ? '' : '(NOT INVARIANT) '}${slice(lines)}`;
}
const effects = [];
for (const f of process.argv.slice(2)) { const b = new Uint8Array(fs.readFileSync(f)); if (f.toLowerCase().endsWith('.big')) effects.push(...bigEffects(b).map(([n, d]) => [`${f}:${n}`, d])); else effects.push([f, b]); }
if (!effects.length) { console.error('usage: node tools/dev/fx-position-check.mjs <file.fxo | archive.big>...'); process.exit(2); }
for (const [name, bytes] of effects) {
  let fx; try { fx = parseEffect(bytes); } catch { continue; }
  const arrays = fx.params.filter((p) => p.type.type === PT.VERTEXSHADER).map((p) => ({ name: p.type.name, ids: [...p.value] }));
  fx.techniques.forEach((t, ti) => {
    if (t.passes.length < 2) return;
    const rows = [];
    t.passes.forEach((ps, pi) => {
      const si = ps.states.findIndex((s) => s.type.type === PT.VERTEXSHADER);
      if (si < 0) { rows.push({ pass: pi, what: 'no vertex shader (fixed function)' }); return; }
      const res = fx.resources.find((r) => r.technique === ti && r.index === pi && r.state === si);
      let cands = [];
      if (res?.usage === 0 && isVS(res.data)) cands = [['', res.data]];
      else if (res?.usage === 1) { const nm = String.fromCharCode(...res.data).replace(/\0.*$/, ''); cands = (arrays.find((a) => a.name === nm)?.ids ?? []).map((id) => [nm, fx.objects.get(id)]); }
      else if (res?.usage === 2) for (const a of arrays) if (a.ids.length > 1) cands.push(...a.ids.map((id, k) => [`${a.name}[${k}]`, fx.objects.get(id)])); // (an expression picks one of an array: every array's shaders)
      for (const [what, data] of cands) if (isVS(data)) rows.push({ pass: pi, what, asm: asmSlice(words(data)), glsl: glslSlice(words(data)) });
      if (!cands.length) rows.push({ pass: pi, what: `unresolved (resource usage ${res?.usage})` });
    });
    const asm = new Set(rows.filter((r) => r.asm).map((r) => r.asm)), gl = new Set(rows.filter((r) => r.glsl).map((r) => r.glsl));
    const byPass = (p) => new Set(rows.filter((r) => r.pass === p && r.asm).map((r) => r.asm));
    const shared = [...byPass(0)].filter((a) => t.passes.every((_, p) => p === 0 || byPass(p).has(a))).length;
    console.log(`== ${name} technique ${t.name}: ${t.passes.length} passes, ${rows.length} vertex shaders, ${asm.size} distinct position codes (${gl.size} in GLSL), ${shared} of the first pass's found in every pass`);
    for (const r of rows) console.log(`  P${r.pass} ${r.what}${r.asm ? `\n     asm:  ${r.asm}\n     glsl: ${r.glsl}` : ''}`);
  });
}
