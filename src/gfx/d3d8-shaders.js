// Direct3D 8 pipeline → GLSL ES 3.00: fixed-function vertex processing (transforms, lighting,
// texture coordinate generation/transform, fog), fixed-function texture stages (all D3DTOP ops,
// argument modifiers, alpha test, specular add, fog), FVF/vertex declaration layouts, and
// translation of vertex shader 1.1 / pixel shader 1.0–1.4 bytecode. Everything is written from
// the public DX8 documentation of the state machine; no reference to any implementation.

export const FVF = { XYZ: 0x002, XYZRHW: 0x004, XYZB1: 0x006, XYZB2: 0x008, XYZB3: 0x00a, XYZB4: 0x00c, XYZB5: 0x00e, POSITION_MASK: 0x00e, NORMAL: 0x010, PSIZE: 0x020, DIFFUSE: 0x040, SPECULAR: 0x080, TEXCOUNT_MASK: 0xf00, LASTBETA_UBYTE4: 0x1000, LASTBETA_D3DCOLOR: 0x8000 };
export const RS = { ZENABLE: 7, FILLMODE: 8, SHADEMODE: 9, ZWRITEENABLE: 14, ALPHATESTENABLE: 15, LASTPIXEL: 16, SRCBLEND: 19, DESTBLEND: 20, CULLMODE: 22, ZFUNC: 23, ALPHAREF: 24, ALPHAFUNC: 25, DITHERENABLE: 26, ALPHABLENDENABLE: 27, FOGENABLE: 28, SPECULARENABLE: 29, ZVISIBLE: 30, FOGCOLOR: 34, FOGTABLEMODE: 35, FOGSTART: 36, FOGEND: 37, FOGDENSITY: 38, EDGEANTIALIAS: 40, ZBIAS: 47, RANGEFOGENABLE: 48, STENCILENABLE: 52, STENCILFAIL: 53, STENCILZFAIL: 54, STENCILPASS: 55, STENCILFUNC: 56, STENCILREF: 57, STENCILMASK: 58, STENCILWRITEMASK: 59, TEXTUREFACTOR: 60, WRAP0: 128, CLIPPING: 136, LIGHTING: 137, AMBIENT: 139, FOGVERTEXMODE: 140, COLORVERTEX: 141, LOCALVIEWER: 142, NORMALIZENORMALS: 143, DIFFUSEMATERIALSOURCE: 145, SPECULARMATERIALSOURCE: 146, AMBIENTMATERIALSOURCE: 147, EMISSIVEMATERIALSOURCE: 148, VERTEXBLEND: 151, CLIPPLANEENABLE: 152, SOFTWAREVERTEXPROCESSING: 153, POINTSIZE: 154, POINTSIZE_MIN: 155, POINTSPRITEENABLE: 156, POINTSCALEENABLE: 157, MULTISAMPLEANTIALIAS: 161, PATCHEDGESTYLE: 163, DEBUGMONITORTOKEN: 165, POINTSIZE_MAX: 166, INDEXEDVERTEXBLENDENABLE: 167, COLORWRITEENABLE: 168, TWEENFACTOR: 170, BLENDOP: 171 };
export const TSS = { COLOROP: 1, COLORARG1: 2, COLORARG2: 3, ALPHAOP: 4, ALPHAARG1: 5, ALPHAARG2: 6, BUMPENVMAT00: 7, BUMPENVMAT01: 8, BUMPENVMAT10: 9, BUMPENVMAT11: 10, TEXCOORDINDEX: 11, ADDRESSU: 13, ADDRESSV: 14, BORDERCOLOR: 15, MAGFILTER: 16, MINFILTER: 17, MIPFILTER: 18, MIPMAPLODBIAS: 19, MAXMIPLEVEL: 20, MAXANISOTROPY: 21, BUMPENVLSCALE: 22, BUMPENVLOFFSET: 23, TEXTURETRANSFORMFLAGS: 24, ADDRESSW: 25, COLORARG0: 26, ALPHAARG0: 27, RESULTARG: 28 };
export const TOP = { DISABLE: 1, SELECTARG1: 2, SELECTARG2: 3, MODULATE: 4, MODULATE2X: 5, MODULATE4X: 6, ADD: 7, ADDSIGNED: 8, ADDSIGNED2X: 9, SUBTRACT: 10, ADDSMOOTH: 11, BLENDDIFFUSEALPHA: 12, BLENDTEXTUREALPHA: 13, BLENDFACTORALPHA: 14, BLENDTEXTUREALPHAPM: 15, BLENDCURRENTALPHA: 16, PREMODULATE: 17, MODULATEALPHA_ADDCOLOR: 18, MODULATECOLOR_ADDALPHA: 19, MODULATEINVALPHA_ADDCOLOR: 20, MODULATEINVCOLOR_ADDALPHA: 21, BUMPENVMAP: 22, BUMPENVMAPLUMINANCE: 23, DOTPRODUCT3: 24, MULTIPLYADD: 25, LERP: 26 };
export const TA = { DIFFUSE: 0, CURRENT: 1, TEXTURE: 2, TFACTOR: 3, SPECULAR: 4, TEMP: 5, SELECTMASK: 0xf, COMPLEMENT: 0x10, ALPHAREPLICATE: 0x20 };
export const TS_WORLD = 256, TS_VIEW = 2, TS_PROJECTION = 3, TS_TEXTURE0 = 16;
/** render / texture stage states the backend's program key depends on (a change bumps Device.programVersion) */
export const PROGRAM_RS = new Set([RS.SHADEMODE, RS.LIGHTING, RS.FOGENABLE, RS.FOGTABLEMODE, RS.FOGVERTEXMODE, RS.ALPHATESTENABLE, RS.ALPHAFUNC, RS.COLORVERTEX, RS.DIFFUSEMATERIALSOURCE,
  RS.SPECULARMATERIALSOURCE, RS.AMBIENTMATERIALSOURCE, RS.EMISSIVEMATERIALSOURCE, RS.SPECULARENABLE, RS.LOCALVIEWER, RS.NORMALIZENORMALS, RS.RANGEFOGENABLE, RS.VERTEXBLEND]);
export const PROGRAM_TSS = new Set([TSS.COLOROP, TSS.COLORARG1, TSS.COLORARG2, TSS.COLORARG0, TSS.ALPHAOP, TSS.ALPHAARG1, TSS.ALPHAARG2, TSS.ALPHAARG0, TSS.RESULTARG,
  TSS.TEXCOORDINDEX, TSS.TEXTURETRANSFORMFLAGS]);
export const MAX_STAGES = 8, MAX_LIGHTS = 8;

/**
 * Clip-space position from a D3D vertex pipeline to GL: z from [0, w] to [-w, w], y mirrored on texture targets
 * (u_flipY = -1), and the D3D8/9 rasterization rule — pixel centers on integer window coordinates, half a pixel
 * up-left of GL's — as a half-pixel shift in NDC (1/width right, 1/height down on the screen).
 */
/**
 * Every generated vertex shader declares its position invariant: Direct3D computes the same position for the
 * same vertices and transforms in every pass (multipass rendering tests depth EQUAL against an earlier pass),
 * whereas a GLSL compiler may evaluate the same expression differently in different programs (fused
 * multiply-adds, reassociation) without it — z-fighting streaks between passes.
 */
export const VS_INVARIANT = 'invariant gl_Position;';
export const D3D_TO_GL_POSITION = (p) => `vec4(${p}.x + ${p}.w / u_viewport.z, (${p}.y - ${p}.w / u_viewport.w) * u_flipY, ${p}.z * 2.0 - ${p}.w, ${p}.w)`;

const DECL_REG_NAMES = ['pos', 'blendweight', 'blendindices', 'normal', 'psize', 'diffuse', 'specular', 'tex0', 'tex1', 'tex2', 'tex3', 'tex4', 'tex5', 'tex6', 'tex7', 'pos2', 'normal2'];

/**
 * Vertex layout from an FVF code: attributes with byte offsets in the stream.
 * @returns {{ stride: number, attrs: Array<{ name: string, offset: number, comps: number, type: 'float'|'color'|'ubyte4', reg: number }>, rhw: boolean, texCount: number, blend: number }}
 */
export function fvfLayout(fvf) {
  const attrs = []; let o = 0;
  const pos = fvf & FVF.POSITION_MASK;
  const rhw = pos === FVF.XYZRHW;
  let blend = 0;
  if (rhw) { attrs.push({ name: 'pos', offset: 0, comps: 4, type: 'float', reg: 0 }); o = 16; }
  else if (pos >= FVF.XYZB1) {
    blend = ((pos - FVF.XYZ) >> 1); // XYZB1=1 ... XYZB5=5
    attrs.push({ name: 'pos', offset: 0, comps: 3, type: 'float', reg: 0 }); o = 12;
    const ubyte = (fvf & FVF.LASTBETA_UBYTE4) !== 0;
    const nw = ubyte ? blend - 1 : blend;
    if (nw > 0) attrs.push({ name: 'blendweight', offset: o, comps: nw, type: 'float', reg: 1 });
    o += nw * 4;
    if (ubyte) { attrs.push({ name: 'blendindices', offset: o, comps: 4, type: 'ubyte4', reg: 2 }); o += 4; }
  } else { attrs.push({ name: 'pos', offset: 0, comps: 3, type: 'float', reg: 0 }); o = 12; }
  if (fvf & FVF.NORMAL) { attrs.push({ name: 'normal', offset: o, comps: 3, type: 'float', reg: 3 }); o += 12; }
  if (fvf & FVF.PSIZE) { attrs.push({ name: 'psize', offset: o, comps: 1, type: 'float', reg: 4 }); o += 4; }
  if (fvf & FVF.DIFFUSE) { attrs.push({ name: 'diffuse', offset: o, comps: 4, type: 'color', reg: 5 }); o += 4; }
  if (fvf & FVF.SPECULAR) { attrs.push({ name: 'specular', offset: o, comps: 4, type: 'color', reg: 6 }); o += 4; }
  const texCount = (fvf & FVF.TEXCOUNT_MASK) >> 8;
  for (let i = 0; i < texCount; i++) {
    const sz = (fvf >> (16 + 2 * i)) & 3;
    const comps = [2, 3, 4, 1][sz];
    attrs.push({ name: 'tex' + i, offset: o, comps, type: 'float', reg: 7 + i }); o += comps * 4;
  }
  return { stride: o, attrs, rhw, texCount, blend };
}

/**
 * Vertex layout from DX8 vertex shader declaration tokens: per stream attributes (v# registers).
 * @returns {{ streams: Map<number, { stride: number, attrs: any[] }>, consts: Array<{ reg: number, values: Float32Array }>, hasPos: boolean }}
 */
export function declLayout(tokens) {
  const streams = new Map(); const consts = [];
  let cur = null, off = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] >>> 0;
    if (t === 0xffffffff) break;
    const type = t >>> 29;
    if (type === 1) { const n = t & 0xf; cur = { stride: 0, attrs: [] }; streams.set(n, cur); off = 0; continue; }
    if (type === 2) {
      if (!cur) { cur = { stride: 0, attrs: [] }; streams.set(0, cur); off = 0; }
      if (t & 0x10000000) { const skip = (t >> 16) & 0xf; off += skip * 4; cur.stride = off; continue; } // SKIP
      const reg = t & 0x1f, dt = (t >> 16) & 0xf;
      const comps = [1, 2, 3, 4, 4, 4, 2, 4][dt] ?? 4;
      const kind = dt === 4 ? 'color' : dt === 5 ? 'ubyte4' : dt === 6 || dt === 7 ? 'short' : 'float';
      const size = dt === 4 || dt === 5 ? 4 : dt === 6 ? 4 : dt === 7 ? 8 : comps * 4;
      cur.attrs.push({ name: DECL_REG_NAMES[reg] ?? 'v' + reg, reg, offset: off, comps, type: kind });
      off += size; cur.stride = off;
      continue;
    }
    if (type === 4) { const count = (t >> 25) & 0xf, reg = t & 0x7f; const values = new Float32Array(count * 4); const dv = new DataView(new ArrayBuffer(4)); for (let k = 0; k < count * 4; k++) { dv.setUint32(0, tokens[i + 1 + k] >>> 0, true); values[k] = dv.getFloat32(0, true); } consts.push({ reg, values }); i += count * 4; continue; }
    // tessellator / extension tokens: ignored
  }
  return { streams, consts, hasPos: [...streams.values()].some((s) => s.attrs.some((a) => a.reg === 0)) };
}

// ------------------------------------------------------------------ fixed-function vertex shader
const LIGHT_DIRECTIONAL = 3, LIGHT_POINT = 1, LIGHT_SPOT = 2;

/**
 * @param {{ layout: any, lighting: boolean, lights: number[] (types by enabled index), colorVertex: boolean, diffuseSrc: number, specularSrc: number, ambientSrc: number, emissiveSrc: number, specularEnable: boolean, localViewer: boolean, normalize: boolean, fogVertex: number, rangeFog: boolean, stages: Array<{ tci: number, ttff: number, coordCount: number }>, rhw: boolean, blend: number, pointSize: boolean }} k
 */
export function ffVertexShader(k) {
  const L = k.layout;
  const has = (n) => L.attrs.some((a) => a.name === n);
  const lines = ['#version 300 es', 'precision highp float;', VS_INVARIANT];
  for (const a of L.attrs) lines.push(`in ${a.type === 'float' && a.comps === 1 ? 'float' : a.type === 'float' ? 'vec' + a.comps : 'vec4'} a_${a.name};`);
  lines.push('uniform mat4 u_world[4]; uniform mat4 u_view; uniform mat4 u_proj; uniform mat4 u_texmat[8];');
  lines.push('uniform vec4 u_viewport; uniform vec2 u_depthRange; uniform float u_flipY;'); // x,y,w,h ; minZ,maxZ (for RHW) ; -1 when rendering into a texture
  lines.push('uniform vec4 u_matDiffuse, u_matAmbient, u_matSpecular, u_matEmissive; uniform float u_matPower; uniform vec4 u_ambient;');
  lines.push('struct Light { int type; vec4 diffuse; vec4 specular; vec4 ambient; vec3 position; vec3 direction; float range; float falloff; vec3 atten; float theta; float phi; };');
  lines.push(`uniform Light u_lights[${MAX_LIGHTS}]; uniform int u_numLights;`);
  lines.push('uniform vec4 u_fog; uniform float u_pointSize;'); // fog: start, end, density, unused
  lines.push('out vec4 v_color0; out vec4 v_color1; out float v_fog;');
  for (let i = 0; i < MAX_STAGES; i++) lines.push(`out vec4 v_tex${i};`);
  lines.push('void main() {');
  const colorIn = (n) => (has(n) ? `a_${n}.zyxw` : 'vec4(1.0)'); // D3DCOLOR bytes B,G,R,A
  if (k.rhw) {
    // pre-transformed: screen space x,y (pixel centers), z in [0,1], 1/w
    lines.push('  vec4 p = a_pos;');
    lines.push('  float rhw = p.w == 0.0 ? 1.0 : p.w;');
    // D3D8/9 pixel centers sit on integer screen coordinates, GL's on half-integers: +0.5 keeps the coverage and texel mapping
    lines.push('  float ndcX = ((p.x + 0.5 - u_viewport.x) / u_viewport.z) * 2.0 - 1.0;');
    lines.push('  float ndcY = 1.0 - ((p.y + 0.5 - u_viewport.y) / u_viewport.w) * 2.0;');
    lines.push('  float w = 1.0 / rhw;');
    lines.push('  gl_Position = vec4(ndcX * w, ndcY * u_flipY * w, (p.z * 2.0 - 1.0) * w, w);');
    lines.push('  vec3 posView = vec3(0.0); vec3 nView = vec3(0.0, 0.0, 1.0);');
    lines.push(`  v_color0 = ${has('diffuse') ? colorIn('diffuse') : 'vec4(1.0)'}; v_color1 = ${has('specular') ? colorIn('specular') : 'vec4(0.0)'};`);
    lines.push('  v_fog = v_color1.a;'); // fog factor from specular alpha for pre-transformed vertices
  } else {
    if (k.blend > 0 && has('blendweight')) {
      const nw = L.attrs.find((a) => a.name === 'blendweight').comps;
      const wexpr = (i) => (nw === 1 ? (i === 0 ? 'a_blendweight' : '(1.0 - a_blendweight)') : nw === 2 ? (i < 2 ? `a_blendweight[${i}]` : '(1.0 - a_blendweight.x - a_blendweight.y)') : (i < 3 ? `a_blendweight[${i}]` : '(1.0 - a_blendweight.x - a_blendweight.y - a_blendweight.z)'));
      const n = Math.min(4, k.blend);
      lines.push('  vec4 wp = vec4(0.0); vec3 wn = vec3(0.0);');
      for (let i = 0; i < n; i++) { lines.push(`  wp += (u_world[${i}] * vec4(a_pos, 1.0)) * ${wexpr(i)};`); if (has('normal')) lines.push(`  wn += (mat3(u_world[${i}]) * a_normal) * ${wexpr(i)};`); }
      lines.push('  vec4 posWorld = wp;');
      lines.push(has('normal') ? '  vec3 nWorld = wn;' : '  vec3 nWorld = vec3(0.0, 0.0, 1.0);');
      lines.push('  vec4 posView4 = u_view * posWorld; vec3 posView = posView4.xyz;');
      lines.push('  vec3 nView = mat3(u_view) * nWorld;');
    } else {
      lines.push('  vec4 posWorld = u_world[0] * vec4(a_pos, 1.0);');
      lines.push('  vec4 posView4 = u_view * posWorld; vec3 posView = posView4.xyz;');
      // normals go to camera space through the inverse transpose of world x view (D3D's rule: a scaled world matrix
      // shortens them, only D3DRS_NORMALIZENORMALS restores unit length)
      lines.push(has('normal') && k.lighting ? '  vec3 nView = transpose(inverse(mat3(u_view) * mat3(u_world[0]))) * a_normal;' : has('normal') ? '  vec3 nView = mat3(u_view) * mat3(u_world[0]) * a_normal;' : '  vec3 nView = vec3(0.0, 0.0, 1.0);');
    }
    if (k.normalize) lines.push('  nView = length(nView) > 0.0 ? normalize(nView) : nView;');
    lines.push('  vec4 clip = u_proj * posView4;');
    lines.push(`  gl_Position = ${D3D_TO_GL_POSITION('clip')};`);
    // colors
    const dif = has('diffuse') ? colorIn('diffuse') : 'vec4(1.0)', spc = has('specular') ? colorIn('specular') : 'vec4(0.0)';
    if (k.lighting) {
      const src = (s, mat) => (s === 1 && k.colorVertex && has('diffuse') ? dif : s === 2 && k.colorVertex && has('specular') ? spc : mat);
      lines.push(`  vec4 mDiffuse = ${src(k.diffuseSrc, 'u_matDiffuse')}; vec4 mSpecular = ${src(k.specularSrc, 'u_matSpecular')}; vec4 mAmbient = ${src(k.ambientSrc, 'u_matAmbient')}; vec4 mEmissive = ${src(k.emissiveSrc, 'u_matEmissive')};`);
      lines.push('  vec3 diffuseAcc = vec3(0.0); vec3 specAcc = vec3(0.0); vec3 ambientAcc = vec3(0.0);');
      lines.push(`  vec3 eye = ${k.localViewer ? 'normalize(-posView)' : 'vec3(0.0, 0.0, -1.0)'};`);
      lines.push('  for (int i = 0; i < u_numLights; i++) {');
      lines.push('    Light lt = u_lights[i]; vec3 ldir; float att = 1.0;');
      lines.push(`    if (lt.type == ${LIGHT_DIRECTIONAL}) { ldir = normalize(-lt.direction); }`);
      lines.push('    else { vec3 d = lt.position - posView; float dist = length(d); if (dist > lt.range) continue; ldir = d / max(dist, 1e-6); att = 1.0 / max(lt.atten.x + lt.atten.y * dist + lt.atten.z * dist * dist, 1e-6);');
      lines.push(`      if (lt.type == ${LIGHT_SPOT}) { float rho = dot(-ldir, normalize(lt.direction)); float ct = cos(lt.theta * 0.5), cp = cos(lt.phi * 0.5); if (rho <= cp) continue; if (rho < ct) att *= pow((rho - cp) / max(ct - cp, 1e-6), lt.falloff); } }`);
      lines.push('    ambientAcc += lt.ambient.rgb * att;');
      lines.push('    float ndl = max(dot(nView, ldir), 0.0); diffuseAcc += lt.diffuse.rgb * ndl * att;');
      if (k.specularEnable) lines.push('    if (ndl > 0.0) { vec3 h = normalize(ldir + eye); float ndh = max(dot(nView, h), 0.0); specAcc += lt.specular.rgb * pow(ndh, max(u_matPower, 1e-4)) * att; }');
      lines.push('  }');
      lines.push('  v_color0 = vec4(clamp(mEmissive.rgb + mAmbient.rgb * (u_ambient.rgb + ambientAcc) + mDiffuse.rgb * diffuseAcc, 0.0, 1.0), mDiffuse.a);');
      lines.push(k.specularEnable ? '  v_color1 = vec4(clamp(mSpecular.rgb * specAcc, 0.0, 1.0), 0.0);' : '  v_color1 = vec4(0.0);');
    } else {
      lines.push(`  v_color0 = ${dif}; v_color1 = ${spc};`);
    }
    // vertex fog
    if (k.fogVertex === 1) lines.push(`  { float d = ${k.rangeFog ? 'length(posView)' : 'abs(posView.z)'}; v_fog = exp(-d * u_fog.z); }`); // EXP
    else if (k.fogVertex === 2) lines.push(`  { float d = ${k.rangeFog ? 'length(posView)' : 'abs(posView.z)'}; float e = d * u_fog.z; v_fog = exp(-e * e); }`); // EXP2
    else if (k.fogVertex === 3) lines.push(`  { float d = ${k.rangeFog ? 'length(posView)' : 'abs(posView.z)'}; v_fog = clamp((u_fog.y - d) / max(u_fog.y - u_fog.x, 1e-6), 0.0, 1.0); }`); // LINEAR
    else lines.push('  v_fog = 1.0;');
  }
  // texture coordinates per stage
  for (let i = 0; i < MAX_STAGES; i++) {
    const st = k.stages[i];
    if (!st) { lines.push(`  v_tex${i} = vec4(0.0);`); continue; }
    const gen = st.tci & 0xffff0000, idx = st.tci & 0xffff;
    let src;
    if (gen === 0x10000) src = 'vec4(nView, 1.0)';
    else if (gen === 0x20000) src = 'vec4(posView, 1.0)';
    else if (gen === 0x30000) src = 'vec4(reflect(normalize(posView), nView), 1.0)';
    else if (has('tex' + idx)) { const a = L.attrs.find((x) => x.name === 'tex' + idx); src = a.comps === 1 ? `vec4(a_tex${idx}, 0.0, 0.0, 1.0)` : a.comps === 2 ? `vec4(a_tex${idx}, 0.0, 1.0)` : a.comps === 3 ? `vec4(a_tex${idx}, 1.0)` : `a_tex${idx}`; }
    else src = 'vec4(0.0, 0.0, 0.0, 1.0)';
    const count = st.ttff & 0xff;
    if (count) {
      // D3D texture transform: input vector padded (1.0 in the component after the input size), output `count` components
      lines.push(`  { vec4 tin = ${src}; vec4 tout = u_texmat[${i}] * tin; v_tex${i} = tout; }`);
      if (st.ttff & 0x100) lines.push(`  v_tex${i} = vec4(v_tex${i}.xyz / max(v_tex${i}[${count - 1}], 1e-6), 1.0);`); // PROJECTED: divide by the last output component
    } else lines.push(`  v_tex${i} = ${src};`);
  }
  if (k.pointSize) lines.push('  gl_PointSize = u_pointSize;');
  lines.push('}');
  return lines.join('\n');
}

// ------------------------------------------------------------------ fixed-function fragment shader
const CMP_GLSL = { 1: 'false', 2: 'a < r', 3: 'a == r', 4: 'a <= r', 5: 'a > r', 6: 'a != r', 7: 'a >= r', 8: 'true' };

/**
 * End of every pixel pipeline (fixed function or shader, the stages after the pixel shader in D3D8/9): alpha test
 * (8-bit comparison against D3DRS_ALPHAREF), then fog blending. Table fog measures eye distance (w) when the
 * projection is perspective ("W-friendly"), device depth z otherwise; vertex fog uses the interpolated factor.
 * Expects `vec4 result` and the uniforms u_alphaRef, u_fogColor, u_fogParams (start, end, density).
 * @param {{ alphaTest?: number, fog: number }} k
 */
export function fragmentTail(k) {
  const out = [];
  if (k.alphaTest && k.alphaTest !== 8) out.push(`  { float a = floor(clamp(result.a, 0.0, 1.0) * 255.0 + 0.5); float r = floor(u_alphaRef * 255.0 + 0.5); if (!(${CMP_GLSL[k.alphaTest] ?? 'true'})) discard; }`);
  const dist = 'float d = gl_FragCoord.w != 1.0 ? 1.0 / gl_FragCoord.w : gl_FragCoord.z;';
  if (k.fog === -1) out.push('  result.rgb = mix(u_fogColor.rgb, result.rgb, clamp(v_fog, 0.0, 1.0));');
  else if (k.fog === 1) out.push(`  { ${dist} float f = exp(-d * u_fogParams.z); result.rgb = mix(u_fogColor.rgb, result.rgb, clamp(f, 0.0, 1.0)); }`);
  else if (k.fog === 2) out.push(`  { ${dist} float e = d * u_fogParams.z; float f = exp(-e * e); result.rgb = mix(u_fogColor.rgb, result.rgb, clamp(f, 0.0, 1.0)); }`);
  else if (k.fog === 3) out.push(`  { ${dist} float f = (u_fogParams.y - d) / max(u_fogParams.y - u_fogParams.x, 1e-6); result.rgb = mix(u_fogColor.rgb, result.rgb, clamp(f, 0.0, 1.0)); }`);
  return out;
}

/**
 * @param {{ stages: Array<{ colorOp: number, colorArg1: number, colorArg2: number, colorArg0: number, alphaOp: number, alphaArg1: number, alphaArg2: number, alphaArg0: number, resultTemp: boolean, cube: boolean, projected: boolean, bound: boolean }>, alphaTest: number|0, specular: boolean, fog: number (table mode 0 none / 1 exp / 2 exp2 / 3 linear) | -1 for vertex fog, texEnabled: boolean }} k
 */
export function ffFragmentShader(k) {
  const lines = ['#version 300 es', 'precision mediump float; precision mediump sampler2D; precision mediump samplerCube;'];
  lines.push('in vec4 v_color0; in vec4 v_color1; in float v_fog;');
  for (let i = 0; i < MAX_STAGES; i++) lines.push(`in vec4 v_tex${i};`);
  for (let i = 0; i < MAX_STAGES; i++) lines.push(k.stages[i]?.cube ? `uniform samplerCube u_cube${i};` : `uniform sampler2D u_tex${i};`);
  lines.push('uniform vec4 u_tfactor; uniform vec4 u_fogColor; uniform vec4 u_fogParams; uniform float u_alphaRef; uniform vec4 u_bumpEnv[8];');
  lines.push('out vec4 fragColor;');
  lines.push('void main() {');
  lines.push('  vec4 diffuse = v_color0; vec4 specular = v_color1; vec4 current = diffuse; vec4 temp = vec4(0.0); vec4 tex = vec4(0.0);');
  const arg = (a, alpha) => {
    let e;
    switch (a & TA.SELECTMASK) { case TA.DIFFUSE: e = 'diffuse'; break; case TA.CURRENT: e = 'current'; break; case TA.TEXTURE: e = 'tex'; break; case TA.TFACTOR: e = 'u_tfactor'; break; case TA.SPECULAR: e = 'specular'; break; case TA.TEMP: e = 'temp'; break; default: e = 'current'; }
    if (a & TA.ALPHAREPLICATE) e = `vec4(${e}.a)`;
    if (a & TA.COMPLEMENT) e = `(vec4(1.0) - ${e})`;
    return alpha ? `${e}.a` : `${e}.rgb`;
  };
  const op = (o, a1, a2, a0, alpha) => {
    const one = alpha ? '1.0' : 'vec3(1.0)', half = alpha ? '0.5' : 'vec3(0.5)';
    const ta = (a) => arg(a, alpha);
    switch (o) {
      case TOP.SELECTARG1: return ta(a1);
      case TOP.SELECTARG2: return ta(a2);
      case TOP.MODULATE: return `${ta(a1)} * ${ta(a2)}`;
      case TOP.MODULATE2X: return `${ta(a1)} * ${ta(a2)} * 2.0`;
      case TOP.MODULATE4X: return `${ta(a1)} * ${ta(a2)} * 4.0`;
      case TOP.ADD: return `${ta(a1)} + ${ta(a2)}`;
      case TOP.ADDSIGNED: return `${ta(a1)} + ${ta(a2)} - ${half}`;
      case TOP.ADDSIGNED2X: return `(${ta(a1)} + ${ta(a2)} - ${half}) * 2.0`;
      case TOP.SUBTRACT: return `${ta(a1)} - ${ta(a2)}`;
      case TOP.ADDSMOOTH: return `${ta(a1)} + ${ta(a2)} - ${ta(a1)} * ${ta(a2)}`;
      case TOP.BLENDDIFFUSEALPHA: return `mix(${ta(a2)}, ${ta(a1)}, diffuse.a)`;
      case TOP.BLENDTEXTUREALPHA: return `mix(${ta(a2)}, ${ta(a1)}, tex.a)`;
      case TOP.BLENDFACTORALPHA: return `mix(${ta(a2)}, ${ta(a1)}, u_tfactor.a)`;
      case TOP.BLENDTEXTUREALPHAPM: return `${ta(a1)} + ${ta(a2)} * (1.0 - tex.a)`;
      case TOP.BLENDCURRENTALPHA: return `mix(${ta(a2)}, ${ta(a1)}, current.a)`;
      case TOP.PREMODULATE: return ta(a1);
      case TOP.MODULATEALPHA_ADDCOLOR: return alpha ? ta(a1) : `${ta(a1)} + ${arg(a1, true)} * ${ta(a2)}`;
      case TOP.MODULATECOLOR_ADDALPHA: return alpha ? ta(a1) : `${ta(a1)} * ${ta(a2)} + ${arg(a1, true)}`;
      case TOP.MODULATEINVALPHA_ADDCOLOR: return alpha ? ta(a1) : `${ta(a1)} + (1.0 - ${arg(a1, true)}) * ${ta(a2)}`;
      case TOP.MODULATEINVCOLOR_ADDALPHA: return alpha ? ta(a1) : `(${one} - ${ta(a1)}) * ${ta(a2)} + ${arg(a1, true)}`;
      case TOP.DOTPRODUCT3: return alpha ? `dot(${arg(a1, false)} - vec3(0.5), ${arg(a2, false)} - vec3(0.5)) * 4.0` : `vec3(dot(${ta(a1)} - vec3(0.5), ${ta(a2)} - vec3(0.5)) * 4.0)`;
      case TOP.MULTIPLYADD: return `${ta(a1)} * ${ta(a2)} + ${ta(a0)}`;
      case TOP.LERP: return `mix(${ta(a2)}, ${ta(a0)}, ${ta(a1)})`;
      case TOP.BUMPENVMAP: case TOP.BUMPENVMAPLUMINANCE: return ta(a2);
      default: return ta(a1);
    }
  };
  for (let i = 0; i < MAX_STAGES; i++) {
    const st = k.stages[i];
    if (!st || st.colorOp === TOP.DISABLE) break;
    // bump environment mapping: the previous stage's texture perturbs this stage's coordinates
    let coord = `v_tex${i}`;
    if (i > 0 && (k.stages[i - 1].colorOp === TOP.BUMPENVMAP || k.stages[i - 1].colorOp === TOP.BUMPENVMAPLUMINANCE)) coord = `(v_tex${i} + vec4(dot(u_bumpEnv[${i - 1}].xy, bump${i - 1}.xy), dot(u_bumpEnv[${i - 1}].zw, bump${i - 1}.xy), 0.0, 0.0))`;
    if (st.bound) {
      if (st.cube) lines.push(`  tex = texture(u_cube${i}, ${coord}.xyz);`);
      else if (st.projected) lines.push(`  tex = textureProj(u_tex${i}, ${coord});`);
      else lines.push(`  tex = texture(u_tex${i}, ${coord}.xy);`);
    } else lines.push('  tex = vec4(0.0, 0.0, 0.0, 1.0);');
    if (st.colorOp === TOP.BUMPENVMAP || st.colorOp === TOP.BUMPENVMAPLUMINANCE) { lines.push(`  vec2 bump${i} = tex.xy * 2.0 - 1.0;`); continue; }
    const dst = st.resultTemp ? 'temp' : 'current';
    // DOTPRODUCT3 as the color operation replicates its result into alpha as well (the alpha operation is ignored)
    const alphaExpr = st.colorOp === TOP.DOTPRODUCT3 ? 'c.r' : st.alphaOp === TOP.DISABLE ? 'current.a' : op(st.alphaOp, st.alphaArg1, st.alphaArg2, st.alphaArg0, true);
    lines.push(`  { vec3 c = ${op(st.colorOp, st.colorArg1, st.colorArg2, st.colorArg0, false)}; float a = ${alphaExpr}; ${dst} = clamp(vec4(c, a), 0.0, 1.0); }`);
  }
  lines.push('  vec4 result = current;');
  if (k.specular) lines.push('  result.rgb += specular.rgb;');
  lines.push(...fragmentTail(k));
  lines.push('  fragColor = result;');
  lines.push('}');
  return lines.join('\n');
}

// ------------------------------------------------------------------ shader bytecode translation
const SWZ = 'xyzw';
function swizzle(tok) { let s = ''; for (let i = 0; i < 4; i++) s += SWZ[(tok >> (16 + 2 * i)) & 3]; return s; }
function writeMask(tok) { let s = ''; for (let i = 0; i < 4; i++) if (tok & (1 << (16 + i))) s += SWZ[i]; return s || 'xyzw'; }

/** Translate a vertex shader 1.x function (Uint32Array of tokens) to a GLSL ES 3.00 vertex shader. */
export function translateVertexShader(code, layout) {
  const lines = ['#version 300 es', 'precision highp float;', VS_INVARIANT];
  const inputs = new Set();
  for (const s of layout.streams.values()) for (const a of s.attrs) inputs.add(a.reg);
  for (const r of inputs) lines.push(`in vec4 a_v${r};`);
  lines.push('uniform vec4 u_vc[96]; uniform vec4 u_viewport; uniform float u_flipY;');
  lines.push('out vec4 v_color0; out vec4 v_color1; out float v_fog;');
  for (let i = 0; i < MAX_STAGES; i++) lines.push(`out vec4 v_tex${i};`);
  const body = [];
  body.push('  vec4 r0 = vec4(0.0), r1 = vec4(0.0), r2 = vec4(0.0), r3 = vec4(0.0), r4 = vec4(0.0), r5 = vec4(0.0), r6 = vec4(0.0), r7 = vec4(0.0), r8 = vec4(0.0), r9 = vec4(0.0), r10 = vec4(0.0), r11 = vec4(0.0);');
  body.push('  vec4 oPos = vec4(0.0), oD0 = vec4(1.0), oD1 = vec4(0.0), oFog = vec4(1.0), oPts = vec4(1.0); int a0 = 0;');
  for (let i = 0; i < MAX_STAGES; i++) body.push(`  vec4 oT${i} = vec4(0.0);`);
  const defsV = new Set(); // constants defined in the shader (def)
  const reg = (tok, isSrc) => {
    const type = ((tok >> 28) & 7) | (((tok >> 8) & 0x18) ? 0 : 0); // VS1.x: bits 28-30
    const n = tok & 0x7ff;
    let name;
    switch (type) {
      case 0: name = `r${n}`; break;
      case 1: name = inputs.has(n) ? `a_v${n}` : 'vec4(0.0)'; break;
      case 2: name = (tok & 0x2000) ? `u_vc[clamp(${n} + a0, 0, 95)]` : defsV.has(n) ? `c${n}` : `u_vc[${n}]`; break;
      case 3: name = 'vec4(float(a0))'; break;
      case 4: name = ['oPos', 'oFog', 'oPts'][n] ?? 'oPos'; break;
      case 5: name = `oD${n}`; break;
      case 6: name = `oT${n}`; break;
      default: name = 'vec4(0.0)';
    }
    if (!isSrc) return name;
    let e = `${name}.${swizzle(tok)}`;
    const mod = (tok >> 24) & 0xf;
    if (mod === 1) e = `(-${e})`;
    return e;
  };
  const dst = (tok) => ({ name: reg(tok, false), mask: writeMask(tok) });
  const assign = (d, expr) => { const m = d.mask; if (d.name === 'a0') return `  a0 = int(floor((${expr}).x));`; if (m === 'xyzw') return `  ${d.name} = ${expr};`; return `  ${d.name}.${m} = (${expr}).${m};`; };
  let i = 1; // skip version token
  while (i < code.length) {
    const t = code[i] >>> 0;
    if (t === 0x0000ffff) break;
    if ((t & 0xffff) === 0xfffe) { i += ((t >> 16) & 0x7fff) + 1; continue; } // comment
    const op = t & 0xffff;
    if (op === 81) { // def c#, 4 floats: raw values, not recognizable by bit 31
      const n = code[i + 1] & 0x7ff; const dv = new DataView(new ArrayBuffer(16)); for (let k = 0; k < 4; k++) dv.setUint32(k * 4, code[i + 2 + k] >>> 0, true);
      body.push(`  vec4 c${n} = vec4(${[0, 1, 2, 3].map((k) => dv.getFloat32(k * 4, true).toExponential(6)).join(', ')});`);
      defsV.add(n); i += 6; continue;
    }
    const args = []; let j = i + 1;
    while (j < code.length && (code[j] >>> 31) === 1) { args.push(code[j] >>> 0); j++; }
    i = j;
    const d = args.length ? dst(args[0]) : null;
    const s = args.slice(1).map((a) => reg(a, true));
    switch (op) {
      case 0: break;
      case 1: body.push(assign(d, s[0])); break; // mov
      case 2: body.push(assign(d, `${s[0]} + ${s[1]}`)); break;
      case 3: body.push(assign(d, `${s[0]} - ${s[1]}`)); break;
      case 4: body.push(assign(d, `${s[0]} * ${s[1]} + ${s[2]}`)); break;
      case 5: body.push(assign(d, `${s[0]} * ${s[1]}`)); break;
      case 6: body.push(assign(d, `vec4(1.0 / (${s[0]}).w)`)); break; // rcp (uses the swizzled scalar; D3D replicates .w by convention)
      case 7: body.push(assign(d, `vec4(inversesqrt(abs((${s[0]}).w)))`)); break;
      case 8: body.push(assign(d, `vec4(dot((${s[0]}).xyz, (${s[1]}).xyz))`)); break;
      case 9: body.push(assign(d, `vec4(dot(${s[0]}, ${s[1]}))`)); break;
      case 10: body.push(assign(d, `min(${s[0]}, ${s[1]})`)); break;
      case 11: body.push(assign(d, `max(${s[0]}, ${s[1]})`)); break;
      case 12: body.push(assign(d, `vec4(lessThan(${s[0]}, ${s[1]}))`)); break;
      case 13: body.push(assign(d, `vec4(greaterThanEqual(${s[0]}, ${s[1]}))`)); break;
      case 14: case 78: body.push(assign(d, `vec4(exp2(floor((${s[0]}).w)), fract((${s[0]}).w), exp2((${s[0]}).w), 1.0)`)); break; // exp/expp
      case 15: case 79: body.push(assign(d, `vec4(floor(log2(abs((${s[0]}).w))), 1.0 / max(exp2(floor(log2(abs((${s[0]}).w)))), 1e-20), log2(abs((${s[0]}).w)), 1.0)`)); break;
      case 16: body.push(assign(d, `vec4(1.0, max((${s[0]}).x, 0.0), ((${s[0]}).x > 0.0 ? pow(max((${s[0]}).y, 0.0), clamp((${s[0]}).w, -128.0, 128.0)) : 0.0), 1.0)`)); break; // lit
      case 17: body.push(assign(d, `vec4(1.0, (${s[0]}).y * (${s[1]}).y, (${s[0]}).z, (${s[1]}).w)`)); break; // dst
      case 18: body.push(assign(d, `mix(${s[2]}, ${s[1]}, ${s[0]})`)); break; // lrp
      case 19: body.push(assign(d, `fract(${s[0]})`)); break;
      case 20: { const c = s[1].replace(/\.\w{4}$/, ''); body.push(assign(d, `vec4(dot(${s[0]}, ${c}), dot(${s[0]}, ${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 1}]`)}), dot(${s[0]}, ${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 2}]`)}), dot(${s[0]}, ${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 3}]`)}))`)); break; } // m4x4
      case 21: { const c = s[1].replace(/\.\w{4}$/, ''); body.push(assign(d, `vec4(dot(${s[0]}, ${c}), dot(${s[0]}, ${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 1}]`)}), dot(${s[0]}, ${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 2}]`)}), 1.0)`)); break; } // m4x3
      case 22: { const c = s[1].replace(/\.\w{4}$/, ''); body.push(assign(d, `vec4(dot((${s[0]}).xyz, (${c}).xyz), dot((${s[0]}).xyz, (${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 1}]`)}).xyz), dot((${s[0]}).xyz, (${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 2}]`)}).xyz), dot((${s[0]}).xyz, (${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 3}]`)}).xyz))`)); break; } // m3x4
      case 23: { const c = s[1].replace(/\.\w{4}$/, ''); body.push(assign(d, `vec4(dot((${s[0]}).xyz, (${c}).xyz), dot((${s[0]}).xyz, (${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 1}]`)}).xyz), dot((${s[0]}).xyz, (${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 2}]`)}).xyz), 1.0)`)); break; } // m3x3
      case 24: { const c = s[1].replace(/\.\w{4}$/, ''); body.push(assign(d, `vec4(dot((${s[0]}).xyz, (${c}).xyz), dot((${s[0]}).xyz, (${c.replace(/\[(\d+)\]/, (m, n) => `[${+n + 1}]`)}).xyz), 0.0, 1.0)`)); break; } // m3x2
      default: body.push(`  // unsupported vs op ${op}`);
    }
  }
  body.push(`  gl_Position = ${D3D_TO_GL_POSITION('oPos')};`);
  body.push('  v_color0 = oD0; v_color1 = oD1; v_fog = oFog.x; gl_PointSize = oPts.x;');
  for (let k = 0; k < MAX_STAGES; k++) body.push(`  v_tex${k} = oT${k};`);
  lines.push('void main() {', ...body, '}');
  return lines.join('\n');
}

/**
 * Translate a pixel shader 1.0–1.4 function to a GLSL ES 3.00 fragment shader.
 * @param {Uint32Array} code
 * @param {{ cube: boolean[], fog: number, projected: boolean[] }} env
 */
export function translatePixelShader(code, env) {
  const version = code[0] & 0xffff, minor = version & 0xff, is14 = minor >= 4;
  const lines = ['#version 300 es', 'precision mediump float; precision mediump sampler2D; precision mediump samplerCube;'];
  lines.push('in vec4 v_color0; in vec4 v_color1; in float v_fog;');
  for (let i = 0; i < MAX_STAGES; i++) lines.push(`in vec4 v_tex${i};`);
  for (let i = 0; i < 6; i++) lines.push(env.cube[i] ? `uniform samplerCube u_cube${i};` : `uniform sampler2D u_tex${i};`);
  lines.push('uniform vec4 u_pc[8]; uniform vec4 u_fogColor; uniform vec4 u_fogParams; uniform float u_alphaRef; uniform vec4 u_bumpEnv[8];');
  lines.push('out vec4 fragColor;');
  // constants: the 8 ps 1.x registers hold values in [-1, 1] (def overrides one in the shader)
  const body = ['  vec4 r0 = vec4(0.0), r1 = vec4(0.0), r2 = vec4(0.0), r3 = vec4(0.0), r4 = vec4(0.0), r5 = vec4(0.0);', `  vec4 ${Array.from({ length: 8 }, (_, k) => `c${k} = clamp(u_pc[${k}], -1.0, 1.0)`).join(', ')};`];
  for (let i = 0; i < 6; i++) body.push(`  vec4 t${i} = v_tex${i};`);
  const defs = new Map();
  const sample = (n, coordExpr) => (env.cube[n] ? `texture(u_cube${n}, (${coordExpr}).xyz)` : env.projected[n] ? `textureProj(u_tex${n}, ${coordExpr})` : `texture(u_tex${n}, (${coordExpr}).xy)`);
  const reg = (tok, isSrc) => {
    const type = (tok >> 28) & 7, n = tok & 0x7ff;
    let name;
    switch (type) { case 0: name = `r${n}`; break; case 1: name = `v_color${n}`; break; case 2: name = `c${n & 7}`; break; case 3: name = `t${n}`; break; default: name = 'vec4(0.0)'; }
    if (!isSrc) return name;
    name = coRead?.get(name) ?? name;
    let e = `${name}.${swizzle(tok)}`;
    const mod = (tok >> 24) & 0xf;
    switch (mod) {
      case 1: e = `(-${e})`; break;
      case 2: e = `(${e} - 0.5)`; break;
      case 3: e = `(0.5 - ${e})`; break;
      case 4: e = `(${e} * 2.0 - 1.0)`; break;
      case 5: e = `(1.0 - ${e} * 2.0)`; break;
      case 6: e = `(1.0 - ${e})`; break;
      case 7: e = `(${e} * 2.0)`; break;
      case 8: e = `(${e} * -2.0)`; break;
      case 9: e = `(${e} / (${name}).z)`; break;
      case 10: e = `(${e} / (${name}).w)`; break;
    }
    return e;
  };
  const dstInfo = (tok) => ({ name: reg(tok, false), mask: writeMask(tok), sat: ((tok >> 20) & 0xf) === 1, shift: ((tok >> 24) & 0xf) });
  const assign = (d, expr) => {
    let e = expr;
    const sh = d.shift > 7 ? d.shift - 16 : d.shift;
    if (sh) e = `(${e}) * ${Math.pow(2, sh).toFixed(4)}`;
    if (d.sat) e = `clamp(${e}, 0.0, 1.0)`;
    e = `clamp(${e}, -${is14 ? '8.0' : '1.0'}, ${is14 ? '8.0' : '1.0'})`; // register range of the shader model
    if (d.mask === 'xyzw') return `  ${d.name} = ${e};`;
    return `  ${d.name}.${d.mask} = (${e}).${d.mask};`;
  };
  let i = 1, phase = 0, coRead = null, prevDst = null, coN = 0;
  while (i < code.length) {
    const t = code[i] >>> 0;
    if (t === 0x0000ffff) break;
    if ((t & 0xffff) === 0xfffe) { i += ((t >> 16) & 0x7fff) + 1; continue; }
    const op = t & 0xffff;
    if (op === 0xfffd) { phase = 1; i++; continue; } // phase
    if (op === 81) { // def c#, 4 floats
      const n = code[i + 1] & 0x7ff; const dv = new DataView(new ArrayBuffer(16)); for (let k = 0; k < 4; k++) dv.setUint32(k * 4, code[i + 2 + k] >>> 0, true);
      defs.set(n, true); body.push(`  c${n & 7} = clamp(vec4(${[0, 1, 2, 3].map((k) => dv.getFloat32(k * 4, true).toExponential(6)).join(', ')}), -1.0, 1.0);`);
      i += 6; continue;
    }
    const args = []; let j = i + 1;
    while (j < code.length && (code[j] >>> 31) === 1) { args.push(code[j] >>> 0); j++; }
    i = j;
    // co-issued instruction (+, bit 30): its sources are read before the paired instruction writes
    coRead = null;
    if ((t & 0x40000000) && prevDst && args.slice(1).some((a) => reg(a, false) === prevDst.name)) {
      const snap = `co${coN++}`; body.splice(prevDst.at, 0, `  vec4 ${snap} = ${prevDst.name};`); coRead = new Map([[prevDst.name, snap]]);
    }
    prevDst = args.length ? { name: reg(args[0], false), at: body.length } : null;
    const d = args.length ? dstInfo(args[0]) : null;
    const s = args.slice(1).map((a) => reg(a, true));
    const dn = d ? (args[0] & 0x7ff) : 0;
    switch (op) {
      case 0: break;
      case 1: body.push(assign(d, s[0])); break;
      case 2: body.push(assign(d, `${s[0]} + ${s[1]}`)); break;
      case 3: body.push(assign(d, `${s[0]} - ${s[1]}`)); break;
      case 4: body.push(assign(d, `${s[0]} * ${s[1]} + ${s[2]}`)); break;
      case 5: body.push(assign(d, `${s[0]} * ${s[1]}`)); break;
      case 8: body.push(assign(d, `vec4(dot((${s[0]}).xyz, (${s[1]}).xyz))`)); break;
      case 9: body.push(assign(d, `vec4(dot(${s[0]}, ${s[1]}))`)); break;
      case 18: body.push(assign(d, `mix(${s[2]}, ${s[1]}, ${s[0]})`)); break;
      case 80: body.push(assign(d, `((${s[0]}).x > 0.5 ? ${s[1]} : ${s[2]})`)); break; // cnd
      case 88: body.push(assign(d, `mix(${s[2]}, ${s[1]}, vec4(greaterThanEqual(${s[0]}, vec4(0.0))))`)); break; // cmp
      case 64: // texcoord (1.0-1.3) / texcrd (1.4)
        if (is14) body.push(assign(d, s[0] ? s[0] : `v_tex${dn}`)); else body.push(`  t${dn} = clamp(v_tex${dn}, 0.0, 1.0);`);
        break;
      case 65: body.push(`  if (any(lessThan((${s[0] ?? `t${dn}`}).xyz, vec3(0.0)))) discard;`); break; // texkill
      case 66: // tex (1.0-1.3) / texld (1.4)
        if (is14) body.push(assign(d, sample(dn, s[0] ?? `v_tex${dn}`))); else body.push(`  t${dn} = ${sample(dn, `v_tex${dn}`)};`);
        break;
      case 67: case 68: // texbem / texbeml: perturb this stage's coordinates by the previous stage's result
        body.push(`  t${dn} = ${sample(dn, `v_tex${dn} + vec4(dot(u_bumpEnv[${dn - 1}].xy, (${s[0]}).xy), dot(u_bumpEnv[${dn - 1}].zw, (${s[0]}).xy), 0.0, 0.0)`)};`);
        if (op === 68) body.push(`  t${dn}.rgb *= clamp((${s[0]}).z * u_bumpEnv[${dn - 1}].x + u_bumpEnv[${dn - 1}].y, 0.0, 1.0);`);
        break;
      case 69: body.push(`  t${dn} = ${sample(dn, `vec4((${s[0]}).a, (${s[0]}).r, 0.0, 1.0)`)};`); break; // texreg2ar
      case 70: body.push(`  t${dn} = ${sample(dn, `vec4((${s[0]}).g, (${s[0]}).b, 0.0, 1.0)`)};`); break; // texreg2gb
      case 82: body.push(`  t${dn} = ${sample(dn, `vec4((${s[0]}).rgb, 1.0)`)};`); break; // texreg2rgb
      case 85: body.push(`  t${dn} = vec4(dot((v_tex${dn}).xyz, (${s[0]}).xyz));`); break; // texdp3
      case 83: body.push(`  t${dn} = ${sample(dn, `vec4(dot((v_tex${dn}).xyz, (${s[0]}).xyz), 0.0, 0.0, 1.0)`)};`); break; // texdp3tex
      case 71: body.push(`  vec3 m3_${dn} = vec3(dot((v_tex${dn}).xyz, (${s[0]}).xyz), 0.0, 0.0);`); break; // texm3x2pad
      case 72: body.push(`  t${dn} = ${sample(dn, `vec4(m3_${dn - 1}.x, dot((v_tex${dn}).xyz, (${s[0]}).xyz), 0.0, 1.0)`)};`); break; // texm3x2tex
      case 73: body.push(`  vec3 m3_${dn} = vec3(${dn > 0 ? `m3_${dn - 1}.xy` : 'vec2(0.0)'}, dot((v_tex${dn}).xyz, (${s[0]}).xyz)); m3_${dn} = ${dn > 0 ? `vec3(m3_${dn - 1}.x, m3_${dn - 1}.y, m3_${dn}.z)` : `vec3(m3_${dn}.z, 0.0, 0.0)`};`); break; // texm3x3pad
      case 74: body.push(`  t${dn} = ${sample(dn, `vec4(m3_${dn - 2}.x, m3_${dn - 1}.y, dot((v_tex${dn}).xyz, (${s[0]}).xyz), 1.0)`)};`); break; // texm3x3tex
      case 86: body.push(`  t${dn} = vec4(m3_${dn - 2}.x, m3_${dn - 1}.y, dot((v_tex${dn}).xyz, (${s[0]}).xyz), 1.0);`); break; // texm3x3
      case 76: case 77: body.push(`  { vec3 n = vec3(m3_${dn - 2}.x, m3_${dn - 1}.y, dot((v_tex${dn}).xyz, (${s[0]}).xyz)); vec3 e = ${op === 76 ? `(${s[1]}).xyz` : `vec3(v_tex${dn - 2}.w, v_tex${dn - 1}.w, v_tex${dn}.w)`}; vec3 rr = 2.0 * n * dot(n, e) / max(dot(n, n), 1e-6) - e; t${dn} = ${sample(dn, 'vec4(rr, 1.0)')}; }`); break; // texm3x3spec / vspec
      case 87: body.push(`  gl_FragDepth = clamp((${s[0] ?? `r${dn}`}).x / max((${s[0] ?? `r${dn}`}).y, 1e-6), 0.0, 1.0);`); break; // texdepth
      case 89: body.push(assign(d, `${s[0]} + vec4(dot(u_bumpEnv[${dn}].xy, (${s[1]}).xy), dot(u_bumpEnv[${dn}].zw, (${s[1]}).xy), 0.0, 0.0)`)); break; // bem
      default: body.push(`  // unsupported ps op ${op}`);
    }
  }
  void phase;
  body.push('  vec4 result = r0;');
  body.push(...fragmentTail(env));
  body.push('  fragColor = result;');
  lines.push('void main() {', ...body, '}');
  return lines.join('\n');
}
