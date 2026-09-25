// Direct3D 9 shader support: D3DVERTEXELEMENT9 declarations and translation of vertex/pixel
// shader models 1.x–2.x (DX9 conventions: dcl-declared inputs/samplers, semantic-named
// attributes `a_s<usage>_<index>`, 256/32 float constants, integer/bool constants, static flow
// control) to GLSL ES 3.00. Public documentation of the token format only.
import { MAX_STAGES, D3D_TO_GL_POSITION, VS_INVARIANT, fragmentTail } from './d3d8-shaders.js';

export const DECLTYPE = { FLOAT1: 0, FLOAT2: 1, FLOAT3: 2, FLOAT4: 3, D3DCOLOR: 4, UBYTE4: 5, SHORT2: 6, SHORT4: 7, UBYTE4N: 8, SHORT2N: 9, SHORT4N: 10, USHORT2N: 11, USHORT4N: 12, UDEC3: 13, DEC3N: 14, FLOAT16_2: 15, FLOAT16_4: 16, UNUSED: 17 };
export const USAGE = { POSITION: 0, BLENDWEIGHT: 1, BLENDINDICES: 2, NORMAL: 3, PSIZE: 4, TEXCOORD: 5, TANGENT: 6, BINORMAL: 7, TESSFACTOR: 8, POSITIONT: 9, COLOR: 10, FOG: 11, DEPTH: 12, SAMPLE: 13 };
const FF_NAMES = { 0: 'pos', 9: 'pos', 1: 'blendweight', 2: 'blendindices', 3: 'normal', 4: 'psize' };
export const semName = (usage, index) => `s${usage}_${index}`;

/** Parse a D3DVERTEXELEMENT9 array from guest memory into per-stream attributes. */
export function declLayout9(mem, addr) {
  const streams = new Map();
  let rhw = false, elements = [], n = 0;
  for (let p = addr; n < 64; p += 8, n++) {
    const stream = mem.read16(p), offset = mem.read16(p + 2), type = mem.u8[p + 4], method = mem.u8[p + 5], usage = mem.u8[p + 6], index = mem.u8[p + 7];
    elements.push({ stream, offset, type, method, usage, index });
    if (stream === 0xff || type === DECLTYPE.UNUSED && stream === 0xff) break;
    if (type === DECLTYPE.UNUSED) continue;
    let st = streams.get(stream); if (!st) { st = { stride: 0, attrs: [] }; streams.set(stream, st); }
    const comps = [1, 2, 3, 4, 4, 4, 2, 4, 4, 2, 4, 2, 4, 3, 3, 2, 4][type] ?? 4;
    const size = [4, 8, 12, 16, 4, 4, 4, 8, 4, 4, 8, 4, 8, 4, 4, 4, 8][type] ?? 16;
    const kind = type === DECLTYPE.D3DCOLOR ? 'color' : type === DECLTYPE.UBYTE4 ? 'ubyte4' : type === DECLTYPE.UBYTE4N ? 'ubyte4n' : type === DECLTYPE.SHORT2 || type === DECLTYPE.SHORT4 ? 'short' : type === DECLTYPE.SHORT2N || type === DECLTYPE.SHORT4N ? 'shortn' : type === DECLTYPE.USHORT2N || type === DECLTYPE.USHORT4N ? 'ushortn' : type === DECLTYPE.FLOAT16_2 || type === DECLTYPE.FLOAT16_4 ? 'half' : 'float';
    let name = index === 0 ? FF_NAMES[usage] : undefined; // (a second position / normal — tweening — keeps its semantic name)
    if (usage === USAGE.COLOR) name = index === 0 ? 'diffuse' : 'specular';
    else if (usage === USAGE.TEXCOORD) name = 'tex' + index;
    if (usage === USAGE.POSITIONT) rhw = true;
    st.attrs.push({ name: name ?? semName(usage, index), sem: semName(usage, index), offset, comps, type: kind, usage, index, reg: usage === USAGE.TEXCOORD ? 7 + index : usage });
    st.stride = Math.max(st.stride, offset + size);
  }
  const all = [...streams.values()].flatMap((s) => s.attrs);
  return { streams, elements, rhw, texCount: all.filter((a) => a.usage === USAGE.TEXCOORD).length, blend: all.some((a) => a.usage === USAGE.BLENDWEIGHT) ? (all.find((a) => a.usage === USAGE.BLENDWEIGHT).comps + (all.some((a) => a.usage === USAGE.BLENDINDICES) ? 1 : 0)) : 0, attrs: all, dx9: true };
}

// ------------------------------------------------------------------ bytecode helpers
const SWZ = 'xyzw';
const swizzle = (tok) => { let s = ''; for (let i = 0; i < 4; i++) s += SWZ[(tok >> (16 + 2 * i)) & 3]; return s; };
const writeMask = (tok) => { let s = ''; for (let i = 0; i < 4; i++) if (tok & (1 << (16 + i))) s += SWZ[i]; return s || 'xyzw'; };
const regType = (tok) => ((tok >> 28) & 7) | ((tok >> 8) & 0x18);
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const asFloat = (v) => { u32[0] = v >>> 0; return f32[0]; };
const lit = (v) => { const s = Number.isFinite(v) ? v.toExponential(8) : v > 0 ? '1e38' : v < 0 ? '-1e38' : '0.0'; return s; };

/** Iterate instructions: yields { op, ctrl, args (parameter tokens incl. relative address tokens), pos } */
function* instructions(code) {
  let i = 1;
  while (i < code.length) {
    const t = code[i] >>> 0;
    if (t === 0x0000ffff) return;
    if ((t & 0xffff) === 0xfffe) { i += ((t >> 16) & 0x7fff) + 1; continue; }
    const op = t & 0xffff, ctrl = (t >> 16) & 0xff, len = (t >> 24) & 0xf;
    if (op === 0xfffd) { yield { op, args: [] }; i++; continue; }
    const args = [];
    let j = i + 1;
    // SM 1.x has no length field: parameter tokens are recognized by bit 31, except the raw values of def/defi
    // (4 floats / ints, often 0) and defb (a bool)
    const n = len || (op === 81 || op === 48 ? 5 : op === 47 ? 2 : 0);
    if (n) { for (let k = 0; k < n; k++) args.push(code[j + k] >>> 0); j += n; }
    else { while (j < code.length && (code[j] >>> 31) === 1) { args.push(code[j] >>> 0); j++; } }
    yield { op, ctrl, args, coissue: (t & 0x40000000) !== 0 };
    i = j;
  }
}

/** Translate a DX9 vertex shader (vs_1_1 or vs_2_x with dcl inputs) to GLSL. */
export function translateVertexShader9(code) {
  const lines = ['#version 300 es', 'precision highp float;', VS_INVARIANT];
  const inputs = new Map(); // v# -> attribute name
  const version = code[0] & 0xffff, major = version >> 8;
  // pass 1: declarations
  for (const ins of instructions(code)) {
    if (ins.op === 31) { const usage = ins.args[0] & 0x1f, index = (ins.args[0] >> 16) & 0xf, reg = ins.args[1] & 0x7ff; if (regType(ins.args[1]) === 1) inputs.set(reg, semName(usage, index)); }
  }
  if (major < 2 && inputs.size === 0) for (let r = 0; r < 16; r++) inputs.set(r, 'v' + r); // no dcl: fall back to register names
  for (const [r, n] of inputs) lines.push(`in vec4 a_${n}; // v${r}`);
  lines.push('uniform vec4 u_vc[256]; uniform ivec4 u_vci[16]; uniform bool u_vcb[16]; uniform vec4 u_viewport; uniform float u_flipY;');
  lines.push('out vec4 v_color0; out vec4 v_color1; out float v_fog;');
  for (let i = 0; i < MAX_STAGES; i++) lines.push(`out vec4 v_tex${i};`);
  const body = [];
  body.push('  vec4 r[32]; for (int i = 0; i < 32; i++) r[i] = vec4(0.0);');
  body.push('  vec4 oPos = vec4(0.0), oD0 = vec4(1.0), oD1 = vec4(0.0), oFog = vec4(1.0), oPts = vec4(1.0); ivec4 a0 = ivec4(0); int aL = 0; bvec4 p0 = bvec4(false);');
  for (let i = 0; i < MAX_STAGES; i++) body.push(`  vec4 oT${i} = vec4(0.0);`);
  const consts = new Map();
  const regName = (tok, args, k) => {
    const type = regType(tok), n = tok & 0x7ff;
    const rel = (tok & 0x2000) !== 0;
    let name;
    switch (type) {
      case 0: name = `r[${n & 31}]`; break;
      case 1: name = inputs.has(n) ? `a_${inputs.get(n)}` : 'vec4(0.0)'; break;
      case 2: { let idx = `${n}`; if (rel) { const at = args[k + 1] >>> 0; const addr = regType(at) === 15 ? 'aL' : `a0.${SWZ[(at >> 16) & 3]}`; idx = `clamp(${n} + ${addr}, 0, 255)`; } name = consts.has(n) && !rel ? `c${n}` : `u_vc[${idx}]`; break; }
      case 3: name = 'vec4(a0)'; break;
      case 4: name = ['oPos', 'oFog', 'oPts'][n] ?? 'oPos'; break;
      case 5: name = `oD${n & 1}`; break;
      case 6: name = `oT${n & 7}`; break;
      case 7: name = `vec4(u_vci[${n & 15}])`; break;
      case 14: name = `vec4(u_vcb[${n & 15}] ? 1.0 : 0.0)`; break;
      case 15: name = 'vec4(float(aL))'; break;
      default: name = 'vec4(0.0)';
    }
    return { name, rel };
  };
  const src = (args, k) => {
    const tok = args[k]; const { name, rel } = regName(tok, args, k);
    let e = `${name}.${swizzle(tok)}`;
    const mod = (tok >> 24) & 0xf;
    switch (mod) { case 1: e = `(-${e})`; break; case 2: e = `(${e} - 0.5)`; break; case 3: e = `(0.5 - ${e})`; break; case 4: e = `(${e} * 2.0 - 1.0)`; break; case 5: e = `(1.0 - ${e} * 2.0)`; break; case 6: e = `(1.0 - ${e})`; break; case 7: e = `(${e} * 2.0)`; break; case 8: e = `(${e} * -2.0)`; break; case 11: e = `abs(${e})`; break; case 12: e = `(-abs(${e}))`; break; case 13: e = `(1.0 - ${e})`; break; }
    return { e, skip: rel ? 1 : 0 };
  };
  const dst = (tok) => ({ name: regName(tok, [], 0).name, mask: writeMask(tok), sat: ((tok >> 20) & 0xf) === 1, type: regType(tok) });
  const assign = (d, expr) => {
    let e = d.sat ? `clamp(${expr}, 0.0, 1.0)` : expr;
    if (d.type === 3) return `  a0 = ivec4(floor(${e}));`;
    if (d.mask === 'xyzw') return `  ${d.name} = ${e};`;
    return `  ${d.name}.${d.mask} = (${e}).${d.mask};`;
  };
  const cmpOp = ['', '>', '==', '>=', '<', '!=', '<='];
  for (const ins of instructions(code)) {
    const { op, args } = ins;
    if (op === 31 || op === 0) continue;
    if (op === 81) { const n = args[0] & 0x7ff; consts.set(n, true); body.push(`  vec4 c${n} = vec4(${[1, 2, 3, 4].map((k) => lit(asFloat(args[k]))).join(', ')});`); continue; }
    if (op === 48) { body.push(`  ivec4 ci${args[0] & 15} = ivec4(${args[1] | 0}, ${args[2] | 0}, ${args[3] | 0}, ${args[4] | 0});`); continue; }
    if (op === 47) { body.push(`  bool cb${args[0] & 15} = ${args[1] ? 'true' : 'false'};`); continue; }
    const d = args.length ? dst(args[0]) : null;
    const S = []; let k = 1; while (k < args.length) { const s = src(args, k); S.push(s.e); k += 1 + s.skip; }
    switch (op) {
      case 1: body.push(assign(d, S[0])); break;
      case 2: body.push(assign(d, `${S[0]} + ${S[1]}`)); break;
      case 3: body.push(assign(d, `${S[0]} - ${S[1]}`)); break;
      case 4: body.push(assign(d, `${S[0]} * ${S[1]} + ${S[2]}`)); break;
      case 5: body.push(assign(d, `${S[0]} * ${S[1]}`)); break;
      case 6: body.push(assign(d, `vec4(1.0 / (${S[0]}).x)`)); break;
      case 7: body.push(assign(d, `vec4(inversesqrt(abs((${S[0]}).x)))`)); break;
      case 8: body.push(assign(d, `vec4(dot((${S[0]}).xyz, (${S[1]}).xyz))`)); break;
      case 9: body.push(assign(d, `vec4(dot(${S[0]}, ${S[1]}))`)); break;
      case 10: body.push(assign(d, `min(${S[0]}, ${S[1]})`)); break;
      case 11: body.push(assign(d, `max(${S[0]}, ${S[1]})`)); break;
      case 12: body.push(assign(d, `vec4(lessThan(${S[0]}, ${S[1]}))`)); break;
      case 13: body.push(assign(d, `vec4(greaterThanEqual(${S[0]}, ${S[1]}))`)); break;
      case 14: case 78: body.push(assign(d, `vec4(exp2((${S[0]}).x))`)); break;
      case 15: case 79: body.push(assign(d, `vec4(log2(abs((${S[0]}).x)))`)); break;
      case 16: body.push(assign(d, `vec4(1.0, max((${S[0]}).x, 0.0), ((${S[0]}).x > 0.0 ? pow(max((${S[0]}).y, 0.0), clamp((${S[0]}).w, -128.0, 128.0)) : 0.0), 1.0)`)); break;
      case 17: body.push(assign(d, `vec4(1.0, (${S[0]}).y * (${S[1]}).y, (${S[0]}).z, (${S[1]}).w)`)); break;
      case 18: body.push(assign(d, `mix(${S[2]}, ${S[1]}, ${S[0]})`)); break;
      case 19: body.push(assign(d, `fract(${S[0]})`)); break;
      case 20: case 21: case 22: case 23: case 24: {
        const rows = { 20: 4, 21: 3, 22: 4, 23: 3, 24: 2 }[op], full = op === 20 || op === 21;
        const base = args[2] & 0x7ff, ctype = regType(args[2]);
        const cref = (r) => (ctype === 2 ? `u_vc[${base + r}]` : `r[${(base + r) & 31}]`);
        const parts = []; for (let r = 0; r < rows; r++) parts.push(full ? `dot(${S[0]}, ${cref(r)})` : `dot((${S[0]}).xyz, ${cref(r)}.xyz)`);
        while (parts.length < 4) parts.push(parts.length === 3 ? '1.0' : '0.0');
        body.push(assign(d, `vec4(${parts.join(', ')})`)); break;
      }
      case 32: body.push(assign(d, `vec4(pow(abs((${S[0]}).x), (${S[1]}).x))`)); break;
      case 33: body.push(assign(d, `vec4(cross((${S[0]}).xyz, (${S[1]}).xyz), 1.0)`)); break;
      case 34: body.push(assign(d, `sign(${S[0]})`)); break;
      case 35: body.push(assign(d, `abs(${S[0]})`)); break;
      case 36: body.push(assign(d, `vec4(normalize((${S[0]}).xyz), 1.0)`)); break;
      case 37: body.push(assign(d, `vec4(cos((${S[0]}).x), sin((${S[0]}).x), 0.0, 0.0)`)); break;
      case 46: body.push(`  a0 = ivec4(floor(${S[0]} + 0.5));`); break; // mova
      case 38: body.push(`  for (int rep${args[0] & 15} = 0; rep${args[0] & 15} < u_vci[${args[0] & 15}].x; rep${args[0] & 15}++) {`); break;
      case 39: body.push('  }'); break;
      case 27: body.push(`  for (aL = u_vci[${args[1] & 15}].y; aL < u_vci[${args[1] & 15}].y + u_vci[${args[1] & 15}].x; aL += u_vci[${args[1] & 15}].z) {`); break;
      case 29: body.push('  }'); break;
      case 40: body.push(`  if (${S[0]}.x != 0.0) {`); break;
      case 41: body.push(`  if ((${S[0]}).x ${cmpOp[ins.ctrl & 7]} (${S[1]}).x) {`); break;
      case 42: body.push('  } else {'); break;
      case 43: body.push('  }'); break;
      case 44: body.push('  break;'); break;
      case 45: body.push(`  if ((${S[0]}).x ${cmpOp[ins.ctrl & 7]} (${S[1]}).x) break;`); break;
      case 90: body.push(assign(d, `vec4(dot((${S[0]}).xy, (${S[1]}).xy) + (${S[2]}).x)`)); break;
      default: body.push(`  // unsupported vs op ${op}`);
    }
  }
  body.push(`  gl_Position = ${D3D_TO_GL_POSITION('oPos')};`);
  body.push('  v_color0 = oD0; v_color1 = oD1; v_fog = oFog.x; gl_PointSize = oPts.x;');
  for (let k = 0; k < MAX_STAGES; k++) body.push(`  v_tex${k} = oT${k};`);
  lines.push('void main() {', ...body, '}');
  return { glsl: lines.join('\n'), inputs };
}

/**
 * Translate a DX9 pixel shader (ps_1_x or ps_2_x) to GLSL.
 * @param {{ cube: boolean[], volume?: boolean[], fog: number, projected: boolean[] }} env
 */
export function translatePixelShader9(code, env) {
  const version = code[0] & 0xffff, major = version >> 8, minor = version & 0xff;
  const is14 = major === 1 && minor >= 4, sm2 = major >= 2;
  const lines = ['#version 300 es', 'precision highp float; precision highp sampler2D; precision highp samplerCube; precision highp sampler3D;'];
  lines.push('in vec4 v_color0; in vec4 v_color1; in float v_fog;');
  for (let i = 0; i < MAX_STAGES; i++) lines.push(`in vec4 v_tex${i};`);
  const samplerKind = new Map(); // s# -> '2d' | 'cube' | 'volume'
  for (const ins of instructions(code)) if (ins.op === 31 && regType(ins.args[1]) === 10) { const t = (ins.args[0] >> 27) & 0xf; samplerKind.set(ins.args[1] & 0xf, t === 3 ? 'cube' : t === 4 ? 'volume' : '2d'); }
  for (let i = 0; i < 16; i++) { const kind = samplerKind.get(i) ?? (env.cube[i] ? 'cube' : env.volume?.[i] ? 'volume' : '2d'); lines.push(kind === 'cube' ? `uniform samplerCube u_cube${i};` : kind === 'volume' ? `uniform sampler3D u_vol${i};` : `uniform sampler2D u_tex${i};`); }
  lines.push('uniform vec4 u_pc[32]; uniform ivec4 u_pci[16]; uniform bool u_pcb[16]; uniform vec4 u_fogColor; uniform vec4 u_fogParams; uniform float u_alphaRef; uniform vec4 u_bumpEnv[8];');
  lines.push('out vec4 fragColor;');
  const body = ['  vec4 r[32]; for (int i = 0; i < 32; i++) r[i] = vec4(0.0);', '  vec4 oC0 = vec4(0.0); float oDepth = -1.0;'];
  for (let i = 0; i < MAX_STAGES; i++) body.push(`  vec4 t${i} = v_tex${i};`);
  const consts = new Map();
  const sample = (n, coordExpr, proj = false, bias = false) => {
    const kind = samplerKind.get(n) ?? (env.cube[n] ? 'cube' : '2d');
    if (kind === 'cube') return `texture(u_cube${n}, (${coordExpr}).xyz)`;
    if (kind === 'volume') return `texture(u_vol${n}, (${coordExpr}).xyz)`;
    if (proj || (!sm2 && env.projected[n])) return `textureProj(u_tex${n}, ${coordExpr})`;
    if (bias) return `texture(u_tex${n}, (${coordExpr}).xy, (${coordExpr}).w)`;
    return `texture(u_tex${n}, (${coordExpr}).xy)`;
  };
  // ps 1.x constants hold values in [-1, 1] (what the hardware reads after SetPixelShaderConstant / def)
  const constRef = (n) => { const c = consts.has(n) ? `c${n}` : `u_pc[${n & 31}]`; return sm2 ? c : `clamp(${c}, -1.0, 1.0)`; };
  const regName = (tok) => {
    const type = regType(tok), n = tok & 0x7ff;
    switch (type) { case 0: return `r[${n & 31}]`; case 1: return `v_color${n & 1}`; case 2: return constRef(n); case 3: return `t${n & 7}`; case 8: return 'oC0'; case 9: return 'vec4(oDepth)'; case 7: return `vec4(u_pci[${n & 15}])`; case 14: return `vec4(u_pcb[${n & 15}] ? 1.0 : 0.0)`; default: return 'vec4(0.0)'; }
  };
  let coRead = null; // co-issued instruction: registers it reads that the previous instruction writes -> snapshot name
  const src = (tok) => {
    const name = coRead?.get(regName(tok)) ?? regName(tok);
    let e = `${name}.${swizzle(tok)}`;
    const mod = (tok >> 24) & 0xf;
    switch (mod) { case 1: e = `(-${e})`; break; case 2: e = `(${e} - 0.5)`; break; case 3: e = `(0.5 - ${e})`; break; case 4: e = `(${e} * 2.0 - 1.0)`; break; case 5: e = `(1.0 - ${e} * 2.0)`; break; case 6: e = `(1.0 - ${e})`; break; case 7: e = `(${e} * 2.0)`; break; case 8: e = `(${e} * -2.0)`; break; case 9: e = `(${e} / (${name}).z)`; break; case 10: e = `(${e} / (${name}).w)`; break; case 11: e = `abs(${e})`; break; case 12: e = `(-abs(${e}))`; break; case 13: e = `(1.0 - ${e})`; break; }
    return e;
  };
  const dst = (tok) => ({ name: regName(tok), mask: writeMask(tok), sat: ((tok >> 20) & 0xf) === 1, shift: (tok >> 24) & 0xf, type: regType(tok) });
  const range = sm2 ? '' : is14 ? '8.0' : '1.0';
  const assign = (d, expr) => {
    let e = expr;
    const sh = d.shift > 7 ? d.shift - 16 : d.shift;
    if (sh) e = `(${e}) * ${Math.pow(2, sh).toFixed(4)}`;
    if (d.sat) e = `clamp(${e}, 0.0, 1.0)`;
    else if (range) e = `clamp(${e}, -${range}, ${range})`;
    if (d.type === 9) return `  oDepth = (${e}).x;`;
    if (d.mask === 'xyzw') return `  ${d.name} = ${e};`;
    return `  ${d.name}.${d.mask} = (${e}).${d.mask};`;
  };
  const cmpOp = ['', '>', '==', '>=', '<', '!=', '<='];
  let prev = null; // { dst name, body index } of the last instruction (co-issue pairs execute together)
  let coN = 0;
  for (const ins of instructions(code)) {
    const { op, args, ctrl } = ins;
    if (op === 31 || op === 0 || op === 0xfffd) continue;
    // a co-issued instruction (+) reads its sources before the paired one writes: snapshot the shared register
    coRead = null;
    if (ins.coissue && prev && args.length > 1 && args.slice(1).some((a) => regName(a) === prev.name)) {
      const snap = `co${coN++}`;
      body.splice(prev.at, 0, `  vec4 ${snap} = ${prev.name};`);
      coRead = new Map([[prev.name, snap]]);
    }
    prev = args.length && op !== 81 && op !== 48 && op !== 47 ? { name: regName(args[0]), at: body.length } : null;
    if (op === 81) { const n = args[0] & 0x7ff; consts.set(n, true); body.push(`  vec4 c${n} = vec4(${[1, 2, 3, 4].map((k) => lit(asFloat(args[k]))).join(', ')});`); continue; }
    if (op === 48) { body.push(`  ivec4 ci${args[0] & 15} = ivec4(${args[1] | 0}, ${args[2] | 0}, ${args[3] | 0}, ${args[4] | 0});`); continue; }
    if (op === 47) continue;
    const d = args.length ? dst(args[0]) : null;
    const S = args.slice(1).map(src);
    const dn = d ? (args[0] & 0x7ff) : 0;
    switch (op) {
      case 1: body.push(assign(d, S[0])); break;
      case 2: body.push(assign(d, `${S[0]} + ${S[1]}`)); break;
      case 3: body.push(assign(d, `${S[0]} - ${S[1]}`)); break;
      case 4: body.push(assign(d, `${S[0]} * ${S[1]} + ${S[2]}`)); break;
      case 5: body.push(assign(d, `${S[0]} * ${S[1]}`)); break;
      case 6: body.push(assign(d, `vec4(1.0 / (${S[0]}).x)`)); break;
      case 7: body.push(assign(d, `vec4(inversesqrt(abs((${S[0]}).x)))`)); break;
      case 8: body.push(assign(d, `vec4(dot((${S[0]}).xyz, (${S[1]}).xyz))`)); break;
      case 9: body.push(assign(d, `vec4(dot(${S[0]}, ${S[1]}))`)); break;
      case 10: body.push(assign(d, `min(${S[0]}, ${S[1]})`)); break;
      case 11: body.push(assign(d, `max(${S[0]}, ${S[1]})`)); break;
      case 14: body.push(assign(d, `vec4(exp2((${S[0]}).x))`)); break;
      case 15: body.push(assign(d, `vec4(log2(abs((${S[0]}).x)))`)); break;
      case 18: body.push(assign(d, `mix(${S[2]}, ${S[1]}, ${S[0]})`)); break;
      case 19: body.push(assign(d, `fract(${S[0]})`)); break;
      case 20: case 21: case 22: case 23: case 24: {
        const rows = { 20: 4, 21: 3, 22: 4, 23: 3, 24: 2 }[op], full = op === 20 || op === 21;
        const base = args[2] & 0x7ff, ctype = regType(args[2]);
        const cref = (r) => (ctype === 2 ? `u_pc[${(base + r) & 31}]` : `r[${(base + r) & 31}]`);
        const parts = []; for (let r = 0; r < rows; r++) parts.push(full ? `dot(${S[0]}, ${cref(r)})` : `dot((${S[0]}).xyz, ${cref(r)}.xyz)`);
        while (parts.length < 4) parts.push(parts.length === 3 ? '1.0' : '0.0');
        body.push(assign(d, `vec4(${parts.join(', ')})`)); break;
      }
      case 32: body.push(assign(d, `vec4(pow(abs((${S[0]}).x), (${S[1]}).x))`)); break;
      case 33: body.push(assign(d, `vec4(cross((${S[0]}).xyz, (${S[1]}).xyz), 1.0)`)); break;
      case 34: body.push(assign(d, `sign(${S[0]})`)); break;
      case 35: body.push(assign(d, `abs(${S[0]})`)); break;
      case 36: body.push(assign(d, `vec4(normalize((${S[0]}).xyz), 1.0)`)); break;
      case 37: body.push(assign(d, `vec4(cos((${S[0]}).x), sin((${S[0]}).x), 0.0, 0.0)`)); break;
      case 40: body.push(`  if (${S[0]}.x != 0.0) {`); break;
      case 41: body.push(`  if ((${S[0]}).x ${cmpOp[ctrl & 7]} (${S[1]}).x) {`); break;
      case 42: body.push('  } else {'); break;
      case 43: body.push('  }'); break;
      case 38: body.push(`  for (int rep${args[0] & 15} = 0; rep${args[0] & 15} < u_pci[${args[0] & 15}].x; rep${args[0] & 15}++) {`); break;
      case 39: body.push('  }'); break;
      case 44: body.push('  break;'); break;
      case 45: body.push(`  if ((${S[0]}).x ${cmpOp[ctrl & 7]} (${S[1]}).x) break;`); break;
      case 80: body.push(assign(d, `((${S[0]}).x > 0.5 ? ${S[1]} : ${S[2]})`)); break;
      case 88: body.push(assign(d, `mix(${S[2]}, ${S[1]}, vec4(greaterThanEqual(${S[0]}, vec4(0.0))))`)); break;
      case 90: body.push(assign(d, `vec4(dot((${S[0]}).xy, (${S[1]}).xy) + (${S[2]}).x)`)); break;
      case 91: body.push(assign(d, `dFdx(${S[0]})`)); break;
      case 92: body.push(assign(d, `dFdy(${S[0]})`)); break;
      case 64: // texcoord / texcrd
        if (is14 || sm2) body.push(assign(d, S[0] ?? `v_tex${dn}`)); else body.push(`  t${dn} = clamp(v_tex${dn}, 0.0, 1.0);`);
        break;
      case 65: body.push(`  if (any(lessThan((${S[0] ?? `t${dn}`}).xyz, vec3(0.0)))) discard;`); break;
      case 66: { // tex / texld: ps2 form is texld dst, coord, sampler
        if (sm2) { const sn = args[2] & 0xf; const proj = (ctrl & 1) !== 0, bias = (ctrl & 2) !== 0; body.push(assign(d, sample(sn, S[0], proj, bias))); }
        else if (is14) body.push(assign(d, sample(dn, S[0] ?? `v_tex${dn}`)));
        else body.push(`  t${dn} = ${sample(dn, `v_tex${dn}`)};`);
        break;
      }
      case 95: { const sn = args[2] & 0xf; body.push(assign(d, `textureLod(u_tex${sn}, (${S[0]}).xy, (${S[0]}).w)`)); break; } // texldl
      case 93: { const sn = args[2] & 0xf; body.push(assign(d, `textureGrad(u_tex${sn}, (${S[0]}).xy, (${S[2] ?? 'vec4(0.0)'}).xy, (${S[3] ?? 'vec4(0.0)'}).xy)`)); break; } // texldd
      case 67: case 68: body.push(`  t${dn} = ${sample(dn, `v_tex${dn} + vec4(dot(u_bumpEnv[${dn - 1}].xy, (${S[0]}).xy), dot(u_bumpEnv[${dn - 1}].zw, (${S[0]}).xy), 0.0, 0.0)`)};`); if (op === 68) body.push(`  t${dn}.rgb *= clamp((${S[0]}).z * u_bumpEnv[${dn - 1}].x + u_bumpEnv[${dn - 1}].y, 0.0, 1.0);`); break;
      case 69: body.push(`  t${dn} = ${sample(dn, `vec4((${S[0]}).a, (${S[0]}).r, 0.0, 1.0)`)};`); break;
      case 70: body.push(`  t${dn} = ${sample(dn, `vec4((${S[0]}).g, (${S[0]}).b, 0.0, 1.0)`)};`); break;
      case 82: body.push(`  t${dn} = ${sample(dn, `vec4((${S[0]}).rgb, 1.0)`)};`); break;
      case 85: body.push(`  t${dn} = vec4(dot((v_tex${dn}).xyz, (${S[0]}).xyz));`); break;
      case 83: body.push(`  t${dn} = ${sample(dn, `vec4(dot((v_tex${dn}).xyz, (${S[0]}).xyz), 0.0, 0.0, 1.0)`)};`); break;
      case 71: body.push(`  vec3 m3_${dn} = vec3(dot((v_tex${dn}).xyz, (${S[0]}).xyz), 0.0, 0.0);`); break;
      case 72: body.push(`  t${dn} = ${sample(dn, `vec4(m3_${dn - 1}.x, dot((v_tex${dn}).xyz, (${S[0]}).xyz), 0.0, 1.0)`)};`); break;
      case 73: body.push(`  vec3 m3_${dn} = vec3(${dn > 0 ? `m3_${dn - 1}.x` : '0.0'}, dot((v_tex${dn}).xyz, (${S[0]}).xyz), 0.0);`); break;
      case 74: body.push(`  t${dn} = ${sample(dn, `vec4(m3_${dn - 2}.x, m3_${dn - 1}.y, dot((v_tex${dn}).xyz, (${S[0]}).xyz), 1.0)`)};`); break;
      case 86: body.push(`  t${dn} = vec4(m3_${dn - 2}.x, m3_${dn - 1}.y, dot((v_tex${dn}).xyz, (${S[0]}).xyz), 1.0);`); break;
      case 76: case 77: body.push(`  { vec3 n = vec3(m3_${dn - 2}.x, m3_${dn - 1}.y, dot((v_tex${dn}).xyz, (${S[0]}).xyz)); vec3 e = ${op === 76 ? `(${S[1]}).xyz` : `vec3(v_tex${dn - 2}.w, v_tex${dn - 1}.w, v_tex${dn}.w)`}; vec3 rr = 2.0 * n * dot(n, e) / max(dot(n, n), 1e-6) - e; t${dn} = ${sample(dn, 'vec4(rr, 1.0)')}; }`); break;
      case 87: body.push(`  oDepth = clamp((${S[0] ?? `r[${dn}]`}).x / max((${S[0] ?? `r[${dn}]`}).y, 1e-6), 0.0, 1.0);`); break;
      case 89: body.push(assign(d, `${S[0]} + vec4(dot(u_bumpEnv[${dn}].xy, (${S[1]}).xy), dot(u_bumpEnv[${dn}].zw, (${S[1]}).xy), 0.0, 0.0)`)); break;
      default: body.push(`  // unsupported ps op ${op}`);
    }
  }
  body.push(`  vec4 result = ${sm2 ? 'oC0' : 'r[0]'};`);
  body.push(...fragmentTail(env));
  if (body.some((l) => /^\s+oDepth = /.test(l))) body.push('  gl_FragDepth = oDepth >= 0.0 ? oDepth : gl_FragCoord.z;'); // only shaders that write depth (texdepth / oDepth)
  body.push('  fragColor = result;');
  lines.push('void main() {', ...body, '}');
  return { glsl: lines.join('\n'), samplers: samplerKind };
}

// ------------------------------------------------------------------ disassembly (diagnostics: --dump-shaders)
const OPN = { 0: 'nop', 1: 'mov', 2: 'add', 3: 'sub', 4: 'mad', 5: 'mul', 6: 'rcp', 7: 'rsq', 8: 'dp3', 9: 'dp4', 10: 'min', 11: 'max', 12: 'slt', 13: 'sge', 14: 'exp', 15: 'log', 16: 'lit', 17: 'dst', 18: 'lrp', 19: 'frc', 20: 'm4x4', 21: 'm4x3', 22: 'm3x4', 23: 'm3x3', 24: 'm3x2', 25: 'call', 26: 'callnz', 27: 'loop', 28: 'ret', 29: 'endloop', 30: 'label', 31: 'dcl', 32: 'pow', 33: 'crs', 34: 'sgn', 35: 'abs', 36: 'nrm', 37: 'sincos', 38: 'rep', 39: 'endrep', 40: 'if', 41: 'ifc', 42: 'else', 43: 'endif', 44: 'break', 45: 'breakc', 46: 'mova', 47: 'defb', 48: 'defi', 64: 'texcoord', 65: 'texkill', 66: 'tex', 67: 'texbem', 68: 'texbeml', 69: 'texreg2ar', 70: 'texreg2gb', 71: 'texm3x2pad', 72: 'texm3x2tex', 73: 'texm3x3pad', 74: 'texm3x3tex', 76: 'texm3x3spec', 77: 'texm3x3vspec', 78: 'expp', 79: 'logp', 80: 'cnd', 81: 'def', 82: 'texreg2rgb', 83: 'texdp3tex', 84: 'texm3x2depth', 85: 'texdp3', 86: 'texm3x3', 87: 'texdepth', 88: 'cmp', 89: 'bem', 90: 'dp2add', 91: 'dsx', 92: 'dsy', 93: 'texldd', 94: 'setp', 95: 'texldl', 96: 'breakp', 0xfffd: 'phase' };
const RTN = ['r', 'v', 'c', 't', 'o', 'oD', 'oT', 'i', 'oC', 'oDepth', 's', 'c', 'c', 'c', 'b', 'aL', 'h', 'misc', 'l', 'p'];
const SRCMOD = ['', '-', '_bias', '-_bias', '_bx2', '-_bx2', '1-', '_x2', '-_x2', '_dz', '_dw', '_abs', '-_abs', '!'];
/** Human-readable listing of SM 1.x-2.x bytecode (register names follow the pixel/vertex conventions). */
export function disasmShader9(code) {
  const version = code[0] >>> 0, ps = (version >>> 16) === 0xffff;
  const lines = [`${ps ? 'ps' : 'vs'}_${(version >> 8) & 0xff}_${version & 0xff}`];
  const reg = (tok) => { const t = regType(tok), n = tok & 0x7ff; if (!ps && t === 3) return 'a0'; if (!ps && t === 4) return ['oPos', 'oFog', 'oPts'][n] ?? 'o?'; return RTN[t] + (t === 9 ? '' : n); };
  const src = (tok) => { const m = (tok >> 24) & 0xf, sw = swizzle(tok); const r = reg(tok) + (sw === 'xyzw' ? '' : '.' + (new Set(sw).size === 1 ? sw[0] : sw)); return m === 1 || m === 3 || m === 5 || m === 8 || m === 12 ? SRCMOD[m][0] + r + SRCMOD[m].slice(1) : m === 6 ? '1-' + r : r + (SRCMOD[m] ?? ''); };
  const dst = (tok) => { const mask = writeMask(tok), mod = (tok >> 20) & 0xf, sh = (tok >> 24) & 0xf; return `${reg(tok)}${mask === 'xyzw' ? '' : '.' + mask}${mod & 1 ? '_sat' : ''}${sh ? (sh > 7 ? '_d' + (1 << (16 - sh)) : '_x' + (1 << sh)) : ''}`; };
  for (const ins of instructions(code)) {
    const name = OPN[ins.op] ?? `op${ins.op}`;
    if (ins.op === 81) { lines.push(`def ${reg(ins.args[0])}, ${[1, 2, 3, 4].map((k) => +asFloat(ins.args[k]).toPrecision(6)).join(', ')}`); continue; }
    if (ins.op === 31) { lines.push(`dcl${ps ? '' : '_' + (ins.args[0] & 0x1f) + '_' + ((ins.args[0] >> 16) & 0xf)} ${dst(ins.args[1])}`); continue; }
    if (!ins.args.length) { lines.push(name); continue; }
    const a = [dst(ins.args[0]), ...ins.args.slice(1).map(src)];
    lines.push(`${ins.coissue ? '+' : ''}${name}${ins.op === 41 || ins.op === 45 ? '_c' + (ins.ctrl & 7) : ''} ${a.join(', ')}`);
  }
  return lines.join('\n');
}
