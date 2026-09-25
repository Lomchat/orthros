// Shader assembler (D3DXAssembleShader): Direct3D shader assembly text (vs/ps 1.1-3.0, the documented instruction
// set and register names) to shader bytecode tokens, after a small preprocessor (#define with or without
// parameters, #undef, #ifdef / #ifndef / #if / #else / #endif, #include through a callback).

const OPC = { nop: 0, mov: 1, add: 2, sub: 3, mad: 4, mul: 5, rcp: 6, rsq: 7, dp3: 8, dp4: 9, min: 10, max: 11, slt: 12, sge: 13, exp: 14, log: 15, lit: 16, dst: 17, lrp: 18, frc: 19,
  m4x4: 20, m4x3: 21, m3x4: 22, m3x3: 23, m3x2: 24, call: 25, callnz: 26, loop: 27, ret: 28, endloop: 29, label: 30, dcl: 31, pow: 32, crs: 33, sgn: 34, abs: 35, nrm: 36, sincos: 37,
  rep: 38, endrep: 39, if: 40, ifc: 41, else: 42, endif: 43, break: 44, breakc: 45, mova: 46, defb: 47, defi: 48, texcoord: 64, texkill: 65, tex: 66, texbem: 67, texbeml: 68,
  texreg2ar: 69, texreg2gb: 70, texm3x2pad: 71, texm3x2tex: 72, texm3x3pad: 73, texm3x3tex: 74, texm3x3spec: 76, texm3x3vspec: 77, expp: 78, logp: 79, cnd: 80, def: 81,
  texreg2rgb: 82, texdp3tex: 83, texm3x2depth: 84, texdp3: 85, texm3x3: 86, texdepth: 87, cmp: 88, bem: 89, dp2add: 90, dsx: 91, dsy: 92, texldd: 93, setp: 94, texldl: 95, breakp: 96, phase: 0xfffd };
/** instructions without a destination register */
const NO_DST = new Set([25, 26, 27, 28, 29, 30, 38, 39, 40, 41, 42, 43, 44, 45, 96, 0xfffd]);
const T = { TEMP: 0, INPUT: 1, CONST: 2, ADDR: 3, TEXTURE: 3, RASTOUT: 4, ATTROUT: 5, TEXCRDOUT: 6, OUTPUT: 6, CONSTINT: 7, COLOROUT: 8, DEPTHOUT: 9, SAMPLER: 10, CONSTBOOL: 14, LOOP: 15, MISC: 17, LABEL: 18, PREDICATE: 19 };
const COMPARE = { gt: 1, eq: 2, ge: 3, lt: 4, ne: 5, le: 6 };
const USAGE = { position: 0, blendweight: 1, blendindices: 2, normal: 3, psize: 4, texcoord: 5, tangent: 6, binormal: 7, tessfactor: 8, positiont: 9, color: 10, fog: 11, depth: 12, sample: 13 };
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/** Preprocess assembly text. `include(name)` returns the included text or null. */
export function preprocess(text, defines = new Map(), include = null, depth = 0) {
  const out = [], stack = [];
  const active = () => stack.every((s) => s.on);
  const expand = (line) => {
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      line = line.replace(/\b([A-Za-z_]\w*)\b(\s*\(([^()]*)\))?/g, (m, name, call, args) => {
        const d = defines.get(name);
        if (d === undefined) return m;
        changed = true;
        if (d.params && call !== undefined) { const vals = args.split(',').map((x) => x.trim()); return d.body.replace(/\b([A-Za-z_]\w*)\b/g, (w) => { const i = d.params.indexOf(w); return i >= 0 ? vals[i] ?? '' : w; }); }
        if (d.params) return m;
        return d.body + (call ?? '');
      });
      if (!changed) break;
    }
    return line;
  };
  const evalCond = (e) => {
    e = e.replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g, (_, a, b) => (defines.has(a ?? b) ? '1' : '0'));
    e = expand(e).replace(/\b[A-Za-z_]\w*\b/g, '0');
    try { return !!Function(`"use strict"; return (${e.replace(/[^-+*/%<>=!&|()0-9. xXa-fA-F]/g, '')});`)(); } catch { return false; }
  };
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    const pp = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (pp) {
      const [, dir, rest] = pp;
      if (dir === 'ifdef') { stack.push({ on: defines.has(rest.trim().split(/\s/)[0]), done: false }); stack[stack.length - 1].done = stack[stack.length - 1].on; continue; }
      if (dir === 'ifndef') { const on = !defines.has(rest.trim().split(/\s/)[0]); stack.push({ on, done: on }); continue; }
      if (dir === 'if') { const on = evalCond(rest); stack.push({ on, done: on }); continue; }
      if (dir === 'elif') { const s = stack[stack.length - 1]; if (s) { s.on = !s.done && evalCond(rest); s.done ||= s.on; } continue; }
      if (dir === 'else') { const s = stack[stack.length - 1]; if (s) { s.on = !s.done; s.done = true; } continue; }
      if (dir === 'endif') { stack.pop(); continue; }
      if (!active()) continue;
      if (dir === 'define') {
        const m = /^(\w+)(\(([^)]*)\))?\s*(.*)$/.exec(rest);
        if (m) defines.set(m[1], { params: m[2] ? m[3].split(',').map((x) => x.trim()).filter(Boolean) : null, body: m[4].replace(/\/\/.*$/, '').trim() });
        continue;
      }
      if (dir === 'undef') { defines.delete(rest.trim()); continue; }
      if (dir === 'include') { const name = /["<]([^">]+)[">]/.exec(rest)?.[1]; const inc = name && include && depth < 8 ? include(name) : null; if (inc !== null) out.push(preprocess(inc, defines, include, depth + 1)); continue; }
      continue; // (#pragma, #line, #error... ignored)
    }
    if (!active()) continue;
    out.push(expand(line));
  }
  return out.join('\n');
}

/**
 * Assemble shader text to tokens (Uint32Array). Throws Error('line N: message') on a syntax error.
 * @param {string} text assembly (preprocessed or not)
 */
export function assembleShader(text, defines, include) {
  const src = preprocess(text, defines ?? new Map(), include ?? null);
  const tokens = [];
  let ps = false, major = 0, minor = 0, started = false;
  const err = (n, m) => { throw new Error(`line ${n + 1}: ${m}`); };
  const lines = src.split('\n');
  const regOf = (s, n, isDst) => {
    // relative addressing: c[a0.x + 5], c5[a0.x], c[a0.x]
    let rel = null;
    let m = /^([a-zA-Z]+)(\d*)\[\s*(?:(\d+)\s*\+\s*)?(a0|aL)(?:\.([xyzw]))?\s*(?:\+\s*(\d+))?\s*\]$/.exec(s);
    if (m) { rel = { reg: m[4], comp: m[5] ?? 'x' }; s = m[1] + (Number(m[2] || 0) + Number(m[3] || 0) + Number(m[6] || 0)); }
    else if ((m = /^([a-zA-Z]+)\[\s*(\d+)\s*\]$/.exec(s))) s = m[1] + m[2];
    m = /^([a-zA-Z]+)(\d*)$/.exec(s);
    if (!m) err(n, `bad register "${s}"`);
    const name = m[1], num = m[2] === '' ? 0 : Number(m[2]), lname = name.toLowerCase();
    let type;
    switch (lname) {
      case 'r': type = T.TEMP; break;
      case 'v': type = T.INPUT; break;
      case 'c': type = T.CONST; break;
      case 't': type = ps ? T.TEXTURE : T.TEXCRDOUT; break;
      case 'a': type = T.ADDR; break;
      case 'opos': return { type: T.RASTOUT, num: 0, rel };
      case 'ofog': return { type: T.RASTOUT, num: 1, rel };
      case 'opts': return { type: T.RASTOUT, num: 2, rel };
      case 'od': type = T.ATTROUT; break;
      case 'ot': type = T.TEXCRDOUT; break;
      case 'o': type = T.OUTPUT; break;
      case 'oc': type = T.COLOROUT; break;
      case 'odepth': return { type: T.DEPTHOUT, num: 0, rel };
      case 's': type = T.SAMPLER; break;
      case 'i': type = T.CONSTINT; break;
      case 'b': type = T.CONSTBOOL; break;
      case 'al': return { type: T.LOOP, num: 0, rel };
      case 'p': type = T.PREDICATE; break;
      case 'vpos': return { type: T.MISC, num: 0, rel };
      case 'vface': return { type: T.MISC, num: 1, rel };
      case 'l': type = T.LABEL; break;
      default: err(n, `unknown register "${s}"`);
    }
    void isDst;
    return { type, num, rel };
  };
  const regBits = (r) => (0x80000000 | (r.num & 0x7ff) | ((r.type & 7) << 28) | (((r.type >> 3) & 3) << 11) | (r.rel ? 0x2000 : 0)) >>> 0;
  const COMP = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
  const relToken = (rel) => { const c = COMP[rel.comp] ?? 0; const r = rel.reg === 'aL' ? { type: T.LOOP, num: 0 } : { type: T.ADDR, num: 0 }; return (regBits(r) | ((c | (c << 2) | (c << 4) | (c << 6)) << 16)) >>> 0; };
  const parseDst = (s, n) => {
    s = s.trim();
    const m = /^(.+?)(?:\.([xyzwrgba]{1,4}))?$/.exec(s);
    const r = regOf(m[1], n, true);
    let mask = 0xf;
    if (m[2]) { mask = 0; for (const ch of m[2]) mask |= 1 << COMP[ch]; }
    const toks = [(regBits(r) | (mask << 16)) >>> 0];
    if (r.rel && major >= 2) toks.push(relToken(r.rel));
    return toks;
  };
  const parseSrc = (s, n) => {
    s = s.trim();
    let mod = 0, neg = false, comp = false, abs = false;
    if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); }
    if (/^1\s*-/.test(s)) { comp = true; s = s.replace(/^1\s*-\s*/, ''); }
    if (s.startsWith('!')) { mod = 13; s = s.slice(1); }
    let m = /^abs\((.+)\)$/i.exec(s); if (m) { abs = true; s = m[1]; }
    let swz = null;
    m = /^(.+?)\.([xyzwrgba]{1,4})$/.exec(s); if (m) { s = m[1]; swz = m[2]; }
    let suffix = '';
    m = /^(.+?)(_bias|_bx2|_x2|_dz|_db|_dw|_da|_abs)$/i.exec(s); if (m) { s = m[1]; suffix = m[2].toLowerCase(); }
    if (!swz) { m = /^(.+?)\.([xyzwrgba]{1,4})$/.exec(s); if (m) { s = m[1]; swz = m[2]; } }
    const r = regOf(s, n, false);
    let sw = 0xe4;
    if (swz) { const cs = [...swz].map((ch) => COMP[ch]); while (cs.length < 4) cs.push(cs[cs.length - 1]); sw = cs[0] | (cs[1] << 2) | (cs[2] << 4) | (cs[3] << 6); }
    if (mod !== 13) {
      if (comp) mod = 6;
      else if (suffix === '_bias') mod = neg ? 3 : 2;
      else if (suffix === '_bx2') mod = neg ? 5 : 4;
      else if (suffix === '_x2') mod = neg ? 8 : 7;
      else if (suffix === '_dz' || suffix === '_db') mod = 9;
      else if (suffix === '_dw' || suffix === '_da') mod = 10;
      else if (abs || suffix === '_abs') mod = neg ? 12 : 11;
      else mod = neg ? 1 : 0;
    }
    const toks = [(regBits(r) | (sw << 16) | (mod << 24)) >>> 0];
    if (r.rel && major >= 2) toks.push(relToken(r.rel));
    return toks;
  };
  const floatTok = (x) => { f32[0] = Number(x); return u32[0]; };
  const emit = (op, ctrl, params, coissue = false, predicated = false) => {
    const len = major >= 2 ? params.length : 0;
    tokens.push((op | (ctrl << 16) | (len << 24) | (coissue ? 0x40000000 : 0) | (predicated ? 0x10000000 : 0)) >>> 0, ...params);
  };
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n].replace(/(;|\/\/).*$/, '').trim();
    if (!line) continue;
    for (let stmt of line.split(/\s*;\s*/)) {
      stmt = stmt.trim(); if (!stmt) continue;
      const vm = /^(vs|ps)[._](\d)[._](\d|sw|x)$/i.exec(stmt);
      if (vm) { ps = vm[1].toLowerCase() === 'ps'; major = +vm[2]; minor = vm[3] === 'x' || vm[3] === 'sw' ? (vm[3] === 'x' ? 1 : 0xff) : +vm[3]; tokens.push(((ps ? 0xffff0000 : 0xfffe0000) | (major << 8) | minor) >>> 0); started = true; continue; }
      if (!started) err(n, `instruction before the version (${stmt})`);
      let coissue = false, pred = null;
      if (stmt.startsWith('+')) { coissue = true; stmt = stmt.slice(1).trim(); }
      let pm = /^\((!?p0(?:\.[xyzw]{1,4})?)\)\s*(.*)$/.exec(stmt); if (pm) { pred = pm[1]; stmt = pm[2]; }
      const sp = stmt.search(/\s/);
      const head = (sp < 0 ? stmt : stmt.slice(0, sp)).toLowerCase(), rest = sp < 0 ? '' : stmt.slice(sp + 1);
      const args = rest ? rest.split(',').map((x) => x.trim()) : [];
      // dcl_usage[N] / dcl_2d / dcl_cube / dcl_volume / dcl (ps 2.0 inputs)
      if (head.startsWith('dcl')) {
        const kind = head.slice(4);
        let usageTok = 0x80000000;
        if (kind === '2d') usageTok |= 2 << 27; else if (kind === 'cube') usageTok |= 3 << 27; else if (kind === 'volume') usageTok |= 4 << 27;
        else if (kind) { const um = /^([a-z]+?)(\d*)$/.exec(kind); const u = USAGE[um?.[1]]; if (u === undefined) err(n, `unknown dcl "${head}"`); usageTok |= u | (Number(um[2] || 0) << 16); }
        const dst = parseDst(args[0], n);
        const mods = /_(pp|centroid)/.exec(head);
        if (mods) dst[0] |= (mods[1] === 'pp' ? 2 : 4) << 20;
        emit(31, 0, [usageTok >>> 0, dst[0] >>> 0]);
        continue;
      }
      if (head === 'def' || head === 'defi' || head === 'defb') {
        const dst = parseDst(args[0], n);
        if (head === 'defb') emit(47, 0, [dst[0], /^true$/i.test(args[1]) ? 1 : Number(args[1]) ? 1 : 0]);
        else emit(head === 'def' ? 81 : 48, 0, [dst[0], ...args.slice(1, 5).map((a) => (head === 'def' ? floatTok(a) : (Number(a) | 0) >>> 0))]);
        continue;
      }
      // opcode with modifiers: name[_mod...]
      const parts = head.split('_');
      let name = parts[0], ctrl = 0, dstMod = 0, shift = 0;
      if (name === 'texld' || name === 'texldp' || name === 'texldb') { ctrl = name === 'texldp' ? 1 : name === 'texldb' ? 2 : 0; name = 'tex'; }
      if (name === 'texcrd') name = 'texcoord';
      for (const p of parts.slice(1)) {
        if (p === 'sat') dstMod |= 1; else if (p === 'pp') dstMod |= 2; else if (p === 'centroid') dstMod |= 4;
        else if (p === 'x2') shift = 1; else if (p === 'x4') shift = 2; else if (p === 'x8') shift = 3; else if (p === 'd2') shift = 15; else if (p === 'd4') shift = 14; else if (p === 'd8') shift = 13;
        else if (COMPARE[p]) ctrl = COMPARE[p];
        else err(n, `unknown modifier "_${p}" on ${name}`);
      }
      if (name === 'if' && ctrl) name = 'ifc';
      if (name === 'break' && ctrl) name = 'breakc';
      const op = OPC[name];
      if (op === undefined) err(n, `unknown instruction "${name}"`);
      const params = [];
      if (NO_DST.has(op) || !args.length) args.forEach((a) => params.push(...parseSrc(a, n)));
      else {
        const d = parseDst(args[0], n);
        d[0] = (d[0] | (dstMod << 20) | (shift << 24)) >>> 0;
        params.push(...d);
        for (const a of args.slice(1)) params.push(...parseSrc(a, n));
      }
      if (pred) { const pt = parseSrc(pred.replace('!', ''), n); if (pred.startsWith('!')) pt[0] = (pt[0] & ~(0xf << 24)) | (13 << 24); params.splice(op === 0 ? 0 : 1, 0, ...pt); }
      emit(op, ctrl, params, coissue, !!pred);
    }
  }
  if (!started) throw new Error('no shader version');
  tokens.push(0x0000ffff);
  return Uint32Array.from(tokens);
}
