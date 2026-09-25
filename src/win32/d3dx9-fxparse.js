// Compiled D3DX effects (fx_2_0 binaries, tag 0xFEFF0901): parameters with their types and default values, techniques
// with passes of state assignments, and the objects (shaders, strings) the states and parameters refer to.
// Layout: tag, offset of the tables (the data before them is a pool of type descriptions, names and values, all
// addressed by offsets from byte 8); tables: parameter / technique / object counts, parameters, techniques, then the
// strings and resources (shader bytecode, parameter names and array selectors bound to particular states).

/** D3DXPARAMETER_TYPE */
export const PT = { VOID: 0, BOOL: 1, INT: 2, FLOAT: 3, STRING: 4, TEXTURE: 5, TEXTURE1D: 6, TEXTURE2D: 7, TEXTURE3D: 8, TEXTURECUBE: 9, SAMPLER: 10, SAMPLER1D: 11, SAMPLER2D: 12, SAMPLER3D: 13, SAMPLERCUBE: 14, PIXELSHADER: 15, VERTEXSHADER: 16, PIXELFRAGMENT: 17, VERTEXFRAGMENT: 18 };
/** D3DXPARAMETER_CLASS */
export const PC = { SCALAR: 0, VECTOR: 1, MATRIX_ROWS: 2, MATRIX_COLUMNS: 3, OBJECT: 4, STRUCT: 5 };
export const isSamplerType = (t) => t >= PT.SAMPLER && t <= PT.SAMPLERCUBE;
export const isTextureType = (t) => t >= PT.TEXTURE && t <= PT.TEXTURECUBE;

/**
 * The effect state table: operation number -> [class, index]. Classes: rs (render state), tss (texture stage state,
 * index = D3DTSS_*), samp (sampler state), npatch, fvf, transform (D3DTS_*), material (0 diffuse, 1 ambient,
 * 2 specular, 3 emissive, 4 power), light (field), lightenable, vs, ps, const (vsf, vsb, vsi, vsf1..4, psf, psb, psi,
 * psf1..4), texture, sampler (a sampler object assigned to a register).
 */
export const STATES = (() => {
  const t = [];
  const rs = [7, 8, 9, 14, 15, 16, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 34, 35, 36, 37, 38, 48, 52, 53, 54, 55, 56, 57, 58, 59, 60,
    128, 129, 130, 131, 132, 133, 134, 135, // WRAP0-7
    136, 137, 139, 140, 141, 142, 143, 145, 146, 147, 148, 151, 152, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 165, 166, 167, 168,
    170, 171, 172, 173, 174, 175, 176, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195,
    198, 199, 200, 201, 202, 203, 204, 205, // WRAP8-15
    206, 207, 208, 209]; // (103 render states: the texture stage states start at operation 0x67)
  for (const s of rs) t.push(['rs', s]);
  for (const s of [1, 26, 2, 3, 4, 27, 5, 6, 28, 7, 8, 9, 10, 11, 22, 23, 24, 32]) t.push(['tss', s]); // COLOROP ... CONSTANT
  t.push(['npatch', 0], ['fvf', 0]);
  t.push(['transform', 3], ['transform', 2], ['transform', 256], ['transform', 16]); // PROJECTION, VIEW, WORLD, TEXTURE0
  for (let i = 0; i < 5; i++) t.push(['material', i]);
  for (let i = 0; i < 13; i++) t.push(['light', i]);
  t.push(['lightenable', 0], ['vs', 0], ['ps', 0]);
  // (VertexShaderConstantF/B/I, VertexShaderConstant, VertexShaderConstant1-4, then the same for pixel shaders: the
  // texture state lands on operation 0xa4 and the sampler states after it, as the effects' sampler blocks show)
  for (const k of ['vsf', 'vsb', 'vsi', 'vsf', 'vsf1', 'vsf2', 'vsf3', 'vsf4', 'psf', 'psb', 'psi', 'psf', 'psf1', 'psf2', 'psf3', 'psf4']) t.push(['const', k]);
  t.push(['texture', 0]);
  for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) t.push(['samp', s]); // ADDRESSU ... DMAPOFFSET
  t.push(['sampler', 0]);
  return t;
})();

/**
 * @typedef {{ type: number, cls: number, name: string, semantic: string, elements: number, rows: number, cols: number,
 *   members: TypeDesc[], bytes: number }} TypeDesc  bytes: size of one element's value (numeric data, 4 per scalar)
 * @typedef {{ op: number, index: number, type: TypeDesc, value: any, resource?: any }} StateAssign
 * @typedef {{ type: TypeDesc, flags: number, annotations: Param[], value: any, elements?: Param[], members?: Param[] }} Param
 */

export function parseEffect(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u = (o) => dv.getUint32(o, true);
  if (bytes.length < 8 || u(0) !== 0xfeff0901) throw new Error(`not an fx_2_0 effect (tag 0x${u(0).toString(16)})`);
  const base = 8;
  const str = (off) => { if (!off && off !== 0) return ''; const n = u(base + off); let s = ''; for (let i = 0; i < n; i++) { const ch = bytes[base + off + 4 + i]; if (!ch) break; s += String.fromCharCode(ch); } return s; };

  /** type description at a pool offset (struct members follow inline) */
  const readType = (off) => {
    let p = base + off;
    const type = u(p), cls = u(p + 4), name = str(u(p + 8)), semantic = str(u(p + 12)), elements = u(p + 16);
    p += 20;
    const d = { type, cls, name, semantic, elements, rows: 1, cols: 1, members: [], bytes: 0, end: 0 };
    // (two dimension words: scalars and vectors give columns then rows (a float3 is 3 x 1), matrices rows then
    // columns — a float4x3 World reads 4 x 3, its translation row surviving SetMatrixTranspose of a [R|t] matrix)
    if (cls <= PC.MATRIX_COLUMNS) { if (cls <= PC.VECTOR) { d.cols = u(p); d.rows = u(p + 4); } else { d.rows = u(p); d.cols = u(p + 4); } p += 8; d.bytes = 4 * d.rows * d.cols; }
    else if (cls === PC.STRUCT) { const n = u(p); p += 4; for (let i = 0; i < n; i++) { const m = readType(p - base); d.members.push(m); p = m.end; } d.bytes = d.members.reduce((s, m) => s + m.bytes * Math.max(1, m.elements), 0); }
    else d.bytes = 4; // (objects: one object id per element)
    d.end = p;
    return d;
  };
  /** value of a type at a pool offset, as a tree: numeric -> Uint32Array of raw words; object -> object ids; sampler -> states */
  const readValue = (t, off) => {
    const n = Math.max(1, t.elements);
    if (t.cls === PC.OBJECT && isSamplerType(t.type)) { // per element: state count, then states
      let p = base + off; const els = [];
      for (let e = 0; e < n; e++) { const cnt = u(p); p += 4; const st = []; for (let i = 0; i < cnt; i++) { st.push(readState(p)); p += 16; } els.push(st); }
      return { samplers: els };
    }
    const words = new Uint32Array((t.bytes * n) / 4);
    for (let i = 0; i < words.length; i++) words[i] = u(base + off + 4 * i);
    return words;
  };
  const readState = (p) => { const op = u(p), index = u(p + 4), type = readType(u(p + 8)); return { op, index, type, value: readValue(type, u(p + 12)) }; };
  const readAnnotations = (p, n) => { const out = []; for (let i = 0; i < n; i++) { const type = readType(u(p)); out.push({ type, value: readValue(type, u(p + 4)) }); p += 8; } return [out, p]; };

  let p = base + u(4);
  const nParams = u(p), nTech = u(p + 4), nObjects = u(p + 12);
  p += 16;
  const params = [];
  for (let i = 0; i < nParams; i++) {
    const type = readType(u(p)), value = readValue(type, u(p + 4)), flags = u(p + 8), nAnn = u(p + 12);
    p += 16;
    const [annotations, np] = readAnnotations(p, nAnn); p = np;
    params.push({ type, value, flags, annotations });
  }
  const techniques = [];
  for (let i = 0; i < nTech; i++) {
    const name = str(u(p)), nAnn = u(p + 4), nPass = u(p + 8);
    p += 12;
    const [annotations, np] = readAnnotations(p, nAnn); p = np;
    const passes = [];
    for (let k = 0; k < nPass; k++) {
      const pname = str(u(p)), pAnn = u(p + 4), nStates = u(p + 8);
      p += 12;
      const [pa, np2] = readAnnotations(p, pAnn); p = np2;
      const states = [];
      for (let s = 0; s < nStates; s++) { states.push(readState(p)); p += 16; }
      passes.push({ name: pname, annotations: pa, states });
    }
    techniques.push({ name, annotations, passes });
  }
  // strings and resources
  const nStrings = u(p), nRes = u(p + 4);
  p += 8;
  // the object table: id -> data (a string's characters, or a shader's bytecode for shader parameters / states)
  const objects = new Map(), strings = new Map();
  for (let i = 0; i < nStrings; i++) {
    const id = u(p), n = u(p + 4), data = bytes.slice(p + 8, p + 8 + n);
    objects.set(id, data);
    let s = ''; for (const ch of data) { if (!ch) break; s += String.fromCharCode(ch); } strings.set(id, s);
    p += 8 + ((n + 3) & ~3);
  }
  const resources = [];
  for (let i = 0; i < nRes; i++) {
    const technique = u(p), index = u(p + 4), element = u(p + 8), state = u(p + 12), usage = u(p + 16), n = u(p + 20);
    resources.push({ technique, index, element, state, usage, data: bytes.slice(p + 24, p + 24 + n) });
    p += 24 + ((n + 3) & ~3);
  }
  return { params, techniques, strings, objects, resources, objectCount: nObjects };
}

/** A readable outline of a parsed effect (diagnostics, tests). */
export function describeEffect(fx) {
  const lines = [];
  const tn = (t) => `${['void', 'bool', 'int', 'float', 'string', 'texture', 'texture1D', 'texture2D', 'texture3D', 'textureCUBE', 'sampler', 'sampler1D', 'sampler2D', 'sampler3D', 'samplerCUBE', 'pixelshader', 'vertexshader'][t.type] ?? t.type}${t.cls <= 3 && (t.rows > 1 || t.cols > 1) ? `${t.rows}x${t.cols}` : ''}${t.elements ? `[${t.elements}]` : ''}`;
  for (const pa of fx.params) lines.push(`param ${tn(pa.type)} ${pa.type.name}${pa.type.semantic ? ' : ' + pa.type.semantic : ''}${pa.annotations.length ? ` <${pa.annotations.map((a) => a.type.name).join(',')}>` : ''}`);
  for (const t of fx.techniques) {
    lines.push(`technique ${t.name}`);
    for (const ps of t.passes) lines.push(`  pass ${ps.name}: ${ps.states.map((s) => `${(STATES[s.op] ?? ['?', s.op]).join(':')}[${s.index}]=${tn(s.type)}`).join(' ')}`);
  }
  lines.push(`resources: ${fx.resources.map((r) => `t${r.technique} i${r.index} e${r.element} s${r.state} u${r.usage} ${r.data.length}B`).join(', ')}`);
  return lines.join('\n');
}
