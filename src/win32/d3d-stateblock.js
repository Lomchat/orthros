// Direct3D 8 / 9 state blocks, for both device classes (d3d8.js Device, d3d9.js Device9 — the API layers keep only their
// COM signatures): the predefined blocks of CreateStateBlock (D3DSBT_ALL / PIXELSTATE / VERTEXSTATE, the states
// Microsoft documents for each type: "Saving All Device States / Pixel State / Vertex States with a StateBlock"),
// recording between BeginStateBlock and EndStateBlock (the setters write into the recording block instead of the device:
// the device keeps its state; the last value of a state set twice is the one kept), Capture (the block's own states
// read again from the device, never more) and Apply (only the block's states written, through each setter's effects:
// state tables, version counters, the backend's hooks, the JIT's issued-state shadow).
//
// A block is a plain object (snapshots: reachable from its device's `stateBlocks`), per kind of state the states it holds
// and their values — `undefined`: a single state not held:
//   rs          Map render state -> value
//   tss         Map stage * 64 + type -> value
//   samp        Map sampler * 32 + type -> value (Direct3D 9; samplers numbered as Device9's tables: 0-15, the
//               displacement map 16, the vertex samplers 17-20)
//   textures    Map stage / sampler -> COM pointer (a reference held)
//   transforms  Map state -> Float32Array(16), or null (never set: identity)
//   lights      Map index -> Float32Array(26) (the device's layout: type as a number, then the floats), or null (the light
//               does not exist)
//   lightOn     Map index -> enabled
//   clip        Map index -> Float32Array(4)
//   streams     Map stream -> { vb (a reference held), offset, stride }
//   freq        Map stream -> divider (Direct3D 9)
//   consts      { vsF, psF, vsI, psI, vsB, psB }: each { m: marks per register, v: values } or null
//   material (Float32Array 17), viewport, scissor (Direct3D 9; null: the render target's), indices { ib (a reference
//   held), base }, vs / ps (Direct3D 9: shader objects, a reference held; Direct3D 8: handles), decl (a declaration
//   object, a reference held) and fvf (Direct3D 9), palette, npatch
// A block holds references on the objects it holds, as Direct3D's do (a texture released by the game stays alive while
// a block holds it; Reset asks the application to release its blocks first): Apply binds live objects.
import { PROGRAM_RS, PROGRAM_TSS } from '../gfx/d3d8-shaders.js';

export const SBT_ALL = 1, SBT_PIXELSTATE = 2, SBT_VERTEXSTATE = 3;

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// Direct3D 9 pixel render states (the documentation's table): Z, fill and shade modes, alpha test and blending, dither,
// fog start / end / density, stencil, texture factor, WRAP0-15, local viewer, material sources, color write masks, blend
// operations, scissor test, depth biases, antialiased lines, two-sided stencil, blend factor, sRGB write, separate alpha
const PIXEL_RS9 = [7, 8, 9, 14, 15, 16, 19, 20, 23, 24, 25, 26, 27, 29, 36, 37, 38, ...range(52, 60), ...range(128, 135), 142, 145, 146, 147, 148, 168, 171, 174, 175, 176, ...range(185, 195), ...range(198, 209)];
// Direct3D 9 vertex render states (the documentation's table: culling, fog, lighting, material sources, vertex blending,
// clip planes, point sprites, multisampling, patches, tweening, tessellation) and D3DRS_FOGENABLE and
// D3DRS_NORMALIZENORMALS, vertex pipeline states the two tables both leave out (D3DSBT_ALL holds them)
const VERTEX_RS9 = [22, 28, 34, 35, 36, 37, 38, 48, 136, 137, 139, 140, 141, 142, 143, 145, 146, 147, 148, 151, 152, ...range(154, 163), 166, 167, 170, 172, 173, ...range(178, 184)];
// Direct3D 8: the same split of its own render states, with the ones Direct3D 9 renamed or replaced — LINEPATTERN,
// ZVISIBLE, EDGEANTIALIAS, ZBIAS (pixel), SOFTWAREVERTEXPROCESSING and PATCHSEGMENTS (vertex: Direct3D 9's
// SetSoftwareVertexProcessing and NPatch mode)
const PIXEL_RS8 = [...PIXEL_RS9.filter((s) => s <= 173), 10, 30, 40, 47];
const VERTEX_RS8 = [...VERTEX_RS9.filter((s) => s <= 173), 153, 164];
// texture stage states: pixel (color / alpha operations and arguments, bump mapping, coordinate index, transform flags,
// result argument, the per-stage constant), vertex (coordinate index, transform flags); Direct3D 8's stage states
// include the sampler states Direct3D 9 moved to SetSamplerState (address modes, border color, filters, LOD bias,
// max level / anisotropy: 13-21 and 25), pixel state
const PIXEL_TSS9 = [...range(1, 11), 22, 23, 24, 26, 27, 28, 32];
const PIXEL_TSS8 = [...range(1, 11), ...range(13, 28)];
const VERTEX_TSS = [11, 24];
// Direct3D 9 sampler states: pixel (address modes, border color, filters, LOD bias, max level / anisotropy, sRGB, element
// index), vertex (the displacement map offset)
const PIXEL_SAMP9 = range(1, 12);
const VERTEX_SAMP9 = [13];
// the transforms and clip planes of D3DSBT_ALL (with any other the device holds): view, projection, texture 0-7, world 0-3
const ALL_TRANSFORMS = [2, 3, ...range(16, 23), ...range(256, 259)];
const ALL_CLIP_PLANES = range(0, 5);

/** an empty block (BeginStateBlock) */
export function emptyBlock() {
  return { rs: new Map(), tss: new Map(), samp: new Map(), textures: new Map(), transforms: new Map(), lights: new Map(), lightOn: new Map(), clip: new Map(), streams: new Map(), freq: new Map(), consts: { vsF: null, psF: null, vsI: null, psI: null, vsB: null, psB: null }, material: undefined, viewport: undefined, scissor: undefined, indices: undefined, vs: undefined, ps: undefined, decl: undefined, fvf: undefined, palette: undefined, npatch: undefined };
}

/** the shader constants of the device (`kind`: vsF psF vsI psI vsB psB) — its array, and the values per register */
const CONST_ARRAYS = { vsF: ['vsConst', 4, 0], psF: ['psConst', 4, 1], vsI: ['vsConstI', 4, 2], psI: ['psConstI', 4, 3], vsB: ['vsConstB', 1, 4], psB: ['psConstB', 1, 5] };
/** a block's part for constants of `kind` (made on first use, the device's register count) */
function constPart(dev, sb, kind) {
  const [field, w] = CONST_ARRAYS[kind], a = dev[field];
  return sb.consts[kind] ??= { m: new Uint8Array(a.length / w), v: new a.constructor(a.length) };
}

/**
 * The reference-holding helpers of a device's COM objects: `hold(ptr)` / `drop(ptr)` on a COM pointer (0: nothing),
 * `swap(map, key, ptr)` a held pointer replaced, the object forms for Direct3D 9's shader and declaration objects.
 */
function refs(com) {
  const hold = (ptr) => { if (ptr) { const o = com.objectAt(ptr); if (o) com.addRef(o); } };
  const drop = (ptr) => { if (ptr) { const o = com.objectAt(ptr); if (o) com.release(o); } };
  return {
    hold, drop,
    swap(map, key, ptr) { const old = map.get(key); if (old === ptr) return; hold(ptr); map.set(key, ptr); drop(old); },
    obj(old, x) { if (old === x) return x; hold(x?.ptr ?? 0); if (old) drop(old.ptr ?? 0); return x; },
  };
}

/**
 * The state block functions of the Direct3D core (d3d8.js d3dCore): `H` = { com, noteState, TSS_NOTE_GROUPS,
 * SAMP_NOTE_GROUPS, MAX_STAGES }. Each takes the device first.
 */
export function stateBlocks(H) {
  const { com, noteState, TSS_NOTE_GROUPS, SAMP_NOTE_GROUPS } = H, R = refs(com);

  // ---------------------------------------------------------------- recording (the setters, while a block records)
  const rec = {
    rs(sb, s, v) { sb.rs.set(s, v); },
    tss(sb, st, ty, v) { sb.tss.set(st * 64 + ty, v); },
    samp(sb, s, ty, v) { sb.samp.set(s * 32 + ty, v); },
    texture(sb, st, ptr) { R.swap(sb.textures, st, ptr); },
    transform(sb, st, m) { sb.transforms.set(st, m); },
    light(sb, i, l) { sb.lights.set(i, l); },
    lightOn(sb, i, on) { sb.lightOn.set(i, on); },
    clip(sb, i, v) { sb.clip.set(i, v); },
    stream(sb, n, vb, offset, stride) { const old = sb.streams.get(n); R.hold(vb); sb.streams.set(n, { vb, offset, stride }); if (old) R.drop(old.vb); },
    freq(sb, n, v) { sb.freq.set(n, v); },
    indices(sb, ib, base) { const old = sb.indices; R.hold(ib); sb.indices = { ib, base }; if (old) R.drop(old.ib); },
    /** Direct3D 9: a shader object (or null); Direct3D 8: a handle */
    vs(sb, x) { sb.vs = typeof x === 'object' ? R.obj(sb.vs, x) : x; },
    ps(sb, x) { sb.ps = typeof x === 'object' ? R.obj(sb.ps, x) : x; },
    /** SetVertexDeclaration / SetFVF as the device takes them: a declaration clears the FVF, a non-zero FVF the declaration */
    decl(sb, d) { sb.decl = R.obj(sb.decl, d); if (d) sb.fvf = 0; },
    fvf(sb, f) { sb.fvf = f; if (f) sb.decl = R.obj(sb.decl, null); },
    /** constants `kind` from register `reg`, `n` registers, value `i` of them read by `val(i)` */
    consts(dev, sb, kind, reg, n, val) { const p = constPart(dev, sb, kind), w = CONST_ARRAYS[kind][1]; for (let r = reg; r < reg + n; r++) p.m[r] = 1; for (let i = 0; i < n * w; i++) p.v[reg * w + i] = val(i); },
  };

  // ---------------------------------------------------------------- capture
  /** the block's states read again from the device (Capture, and the predefined blocks at creation) */
  function capture(dev, sb) {
    const api9 = !!dev.api9;
    for (const k of sb.rs.keys()) sb.rs.set(k, dev.rs.get(k) ?? 0);
    for (const k of sb.tss.keys()) sb.tss.set(k, dev.tss[k >> 6]?.get(k & 63) ?? 0);
    for (const k of sb.samp.keys()) sb.samp.set(k, dev.samplers?.[k >> 5]?.get(k & 31) ?? 0);
    for (const st of sb.textures.keys()) R.swap(sb.textures, st, dev.textures[st] ?? 0);
    for (const st of sb.transforms.keys()) { const m = dev.transforms.get(st); sb.transforms.set(st, m ? m.slice() : null); }
    for (const i of sb.lights.keys()) { const l = dev.lights.get(i); sb.lights.set(i, l ? l.slice() : null); }
    for (const i of sb.lightOn.keys()) sb.lightOn.set(i, dev.lightEnabled.has(i));
    for (const i of sb.clip.keys()) { const v = dev.clipPlanes.get(i); sb.clip.set(i, v ? v.slice() : new Float32Array(4)); }
    for (const n of sb.streams.keys()) { const s = dev.streams[n]; if (s) rec.stream(sb, n, s.vb, s.offset ?? 0, s.stride); }
    for (const n of sb.freq.keys()) sb.freq.set(n, dev.streams[n]?.freq ?? 1);
    if (sb.material !== undefined) sb.material = dev.material.slice();
    if (sb.viewport !== undefined) sb.viewport = { ...dev.viewport };
    if (sb.scissor !== undefined) sb.scissor = dev.scissor ? { ...dev.scissor } : null;
    if (sb.indices !== undefined) rec.indices(sb, dev.indices.ib, dev.indices.base);
    if (sb.vs !== undefined) sb.vs = api9 ? R.obj(sb.vs, dev.vsObj ?? null) : dev.vertexShader;
    if (sb.ps !== undefined) sb.ps = api9 ? R.obj(sb.ps, dev.psObj ?? null) : dev.pixelShader;
    if (sb.decl !== undefined) sb.decl = R.obj(sb.decl, dev.vertexDecl ?? null);
    if (sb.fvf !== undefined) sb.fvf = dev.fvf;
    if (sb.palette !== undefined) sb.palette = dev.currentPalette;
    if (sb.npatch !== undefined) sb.npatch = dev.npatch;
    for (const kind in CONST_ARRAYS) {
      const p = sb.consts[kind]; if (!p) continue;
      const a = dev[CONST_ARRAYS[kind][0]], w = CONST_ARRAYS[kind][1];
      for (let r = 0; r < p.m.length; r++) if (p.m[r]) for (let i = r * w; i < r * w + w; i++) p.v[i] = a[i];
    }
  }

  /** a predefined block (CreateStateBlock): the states of `type`, captured now; null for another type */
  function create(dev, type) {
    if (type !== SBT_ALL && type !== SBT_PIXELSTATE && type !== SBT_VERTEXSTATE) return null;
    const api9 = !!dev.api9, sb = emptyBlock(), all = type === SBT_ALL;
    const pixel = type !== SBT_VERTEXSTATE, vertex = type !== SBT_PIXELSTATE;
    // render, stage and sampler states
    if (pixel) for (const s of api9 ? PIXEL_RS9 : PIXEL_RS8) sb.rs.set(s, 0);
    if (vertex) for (const s of api9 ? VERTEX_RS9 : VERTEX_RS8) sb.rs.set(s, 0);
    if (all) for (const s of dev.rs.keys()) sb.rs.set(s, 0); // (any other the game set)
    const tssTypes = pixel ? (api9 ? PIXEL_TSS9 : PIXEL_TSS8) : VERTEX_TSS;
    for (let st = 0; st < dev.tss.length; st++) { for (const ty of tssTypes) sb.tss.set(st * 64 + ty, 0); if (all) for (const ty of dev.tss[st].keys()) sb.tss.set(st * 64 + ty, 0); }
    if (api9) {
      const sampTypes = all ? [...PIXEL_SAMP9, ...VERTEX_SAMP9] : pixel ? PIXEL_SAMP9 : VERTEX_SAMP9;
      for (let s = 0; s < dev.samplers.length; s++) for (const ty of sampTypes) sb.samp.set(s * 32 + ty, 0);
    }
    // shaders and their constants; the vertex declaration, lights, NPatch mode, stream dividers (vertex state)
    for (const kind of api9 ? ['vsF', 'psF', 'vsI', 'psI', 'vsB', 'psB'] : ['vsF', 'psF']) {
      if (kind[0] === 'p' ? !pixel : !vertex) continue;
      const p = constPart(dev, sb, kind); p.m.fill(1);
    }
    if (pixel) sb.ps = api9 ? null : 0;
    if (vertex) {
      sb.vs = api9 ? null : 0;
      for (const i of dev.lights.keys()) { sb.lights.set(i, null); sb.lightOn.set(i, false); } // (the lights existing now: Capture never adds one made later)
      if (api9) { sb.decl = null; sb.fvf = 0; sb.npatch = 0; for (let n = 0; n < dev.streams.length; n++) sb.freq.set(n, 1); }
    }
    // the rest of the device state (D3DSBT_ALL): textures, palette, streams, indices, viewport, scissor, transforms,
    // clip planes, material
    if (all) {
      for (let st = 0; st < dev.textures.length; st++) sb.textures.set(st, 0);
      sb.palette = 0;
      for (let n = 0; n < dev.streams.length; n++) sb.streams.set(n, null);
      sb.indices = null; sb.viewport = null; sb.material = null;
      if (api9) sb.scissor = null;
      for (const st of [...ALL_TRANSFORMS, ...dev.transforms.keys()]) sb.transforms.set(st, null);
      for (const i of [...ALL_CLIP_PLANES, ...dev.clipPlanes.keys()]) sb.clip.set(i, null);
    }
    capture(dev, sb);
    return sb;
  }

  // ---------------------------------------------------------------- apply
  /** the block's states written to the device, each with its setter's effects (only real changes counted) */
  function apply(dev, sb) {
    const api9 = !!dev.api9, gfx = dev.gfx;
    let changed = false, prog = false;
    for (const [s, v] of sb.rs) {
      if (dev.rs.get(s) === v) continue;
      changed = true; if (PROGRAM_RS.has(s)) prog = true;
      dev.rs.set(s, v); noteState(dev, 'rs', s, v); gfx?.setRenderState?.(s, v);
    }
    for (const [k, v] of sb.tss) {
      const st = k >> 6, ty = k & 63, t = dev.tss[st];
      if (!t || t.get(ty) === v) continue;
      changed = true; if (PROGRAM_TSS.has(ty)) prog = true;
      noteState(dev, TSS_NOTE_GROUPS[st] ?? 'tss' + st, ty, v); t.set(ty, v); gfx?.setTextureStageState?.(st, ty, v);
    }
    for (const [k, v] of sb.samp) {
      const s = k >> 5, ty = k & 31, t = dev.samplers?.[s];
      if (!t || t.get(ty) === v) continue;
      noteState(dev, SAMP_NOTE_GROUPS[s] ?? 'samp' + s, ty, v); t.set(ty, v); gfx?.setSamplerState?.(s, ty, v);
    }
    for (const [st, t] of sb.textures) if (dev.textures[st] !== t) dev.bindTexture(st, t);
    // transforms: only the slots whose matrix differs (effects restore their state with a block around every object:
    // a blanket invalidation made the backend send every matrix again at every draw)
    for (const [st, m] of sb.transforms) {
      const cur = dev.transforms.get(st);
      if (m ? cur && cur.every((x, i) => Object.is(x, m[i])) : !cur) continue;
      if (m) { if (cur) cur.set(m); else dev.transforms.set(st, m.slice()); } else dev.transforms.delete(st);
      dev.touchTransform(st); dev.shadowTransform(st); gfx?.setTransform?.(st, dev.transforms.get(st) ?? null);
    }
    // lights (data, then switches: LightEnable makes a light it does not find), material
    for (const [i, l] of sb.lights) {
      if (!l) continue;
      const old = dev.lights.get(i), cur = old ?? new Float32Array(l.length);
      let same = !!old;
      for (let k = 1; k < l.length; k++) if (cur[k] !== l[k]) { same = false; cur[k] = l[k]; }
      if (cur[0] !== l[0]) { same = false; if (dev.lightEnabled.has(i)) prog = true; cur[0] = l[0]; }
      if (same) continue;
      dev.lightVersion++; dev.lights.set(i, cur); dev.shadowLight(i); dev.shadowLightOn(i); gfx?.setLight?.(i, cur);
    }
    for (const [i, on] of sb.lightOn) dev.enableLight(i, on);
    if (sb.material) {
      const m = dev.material; let same = true;
      for (let k = 0; k < m.length; k++) if (m[k] !== sb.material[k]) { same = false; m[k] = sb.material[k]; }
      if (!same) { dev.lightVersion++; dev.shadowMaterial(); gfx?.setMaterial?.(m); }
    }
    // viewport, scissor rectangle, clip planes
    const vp = sb.viewport, cv = dev.viewport;
    if (vp && (vp.x !== cv.x || vp.y !== cv.y || vp.w !== cv.w || vp.h !== cv.h || !Object.is(vp.minZ, cv.minZ) || !Object.is(vp.maxZ, cv.maxZ))) { dev.viewportVersion++; dev.viewport = { ...vp }; gfx?.setViewport?.(dev.viewport); }
    if (sb.scissor !== undefined) {
      const a = sb.scissor, b = dev.scissor;
      if (!a !== !b || (a && (a.l !== b.l || a.t !== b.t || a.r !== b.r || a.b !== b.b))) { dev.viewportVersion++; dev.scissor = a ? { ...a } : null; }
    }
    for (const [i, v] of sb.clip) { dev.clipPlanes.set(i, v.slice()); gfx?.setClipPlane?.(i, v); }
    // vertex streams, their dividers, the index buffer
    for (const [n, x] of sb.streams) {
      const s = dev.streams[n]; if (!s) continue;
      if (s.vb !== x.vb) { R.hold(x.vb); R.drop(s.vb); s.vb = x.vb; } // (the new one held first: it may be the same object)
      s.stride = x.stride; if (api9) s.offset = x.offset;
      if (api9) gfx?.setStreamSource?.(n, x.vb ? com.implAt(x.vb) : null, x.stride, x.offset); else gfx?.setStreamSource?.(n, x.vb ? com.implAt(x.vb) : null, x.stride);
    }
    for (const [n, v] of sb.freq) if (dev.streams[n]) dev.streams[n].freq = v;
    if (sb.indices) {
      const ix = dev.indices, ib = sb.indices.ib;
      if (ix.ib !== ib) { R.hold(ib); R.drop(ix.ib); ix.ib = ib; }
      if (!api9) ix.base = sb.indices.base;
      gfx?.setIndices?.(ib ? com.implAt(ib) : null, api9 ? 0 : ix.base);
    }
    // shaders, the vertex declaration / FVF
    if (sb.vs !== undefined) {
      if (api9) { if (dev.vsObj !== sb.vs) prog = true; dev.vsObj = sb.vs; dev.vertexShader = sb.vs ? sb.vs.handle : 0; gfx?.setVertexShader?.(dev.vertexShader, sb.vs); }
      else { if (dev.vertexShader !== sb.vs) prog = true; dev.vertexShader = sb.vs; gfx?.setVertexShader?.(sb.vs, dev.vertexShaders.get(sb.vs)); }
    }
    if (sb.ps !== undefined) {
      if (api9) { if (dev.psObj !== sb.ps) prog = true; dev.psObj = sb.ps; dev.pixelShader = sb.ps ? sb.ps.handle : 0; gfx?.setPixelShader?.(dev.pixelShader, sb.ps); }
      else { if (dev.pixelShader !== sb.ps) prog = true; dev.pixelShader = sb.ps; gfx?.setPixelShader?.(sb.ps, dev.pixelShaders.get(sb.ps)); }
    }
    if (sb.decl !== undefined || sb.fvf !== undefined) {
      const d0 = dev.vertexDecl, f0 = dev.fvf;
      if (sb.decl !== undefined) { dev.vertexDecl = sb.decl; if (sb.decl) dev.fvf = 0; }
      if (sb.fvf !== undefined) { dev.fvf = sb.fvf; if (sb.fvf) dev.vertexDecl = null; }
      if (dev.vertexDecl !== d0 || dev.fvf !== f0) prog = true;
      dev.shadowFvf();
    }
    if (sb.palette !== undefined) dev.currentPalette = sb.palette;
    if (sb.npatch !== undefined) dev.npatch = sb.npatch;
    // shader constants
    for (const kind in CONST_ARRAYS) {
      const p = sb.consts[kind]; if (!p) continue;
      const [field, w, slot] = CONST_ARRAYS[kind], a = dev[field];
      let lo = Infinity, hi = -1;
      for (let r = 0; r < p.m.length; r++) if (p.m[r]) { for (let i = r * w; i < r * w + w; i++) a[i] = p.v[i]; if (r < lo) lo = r; hi = r; }
      if (hi < 0) continue;
      dev.constVersion++; if (kind[0] === 'v') dev.vsConstVersion++; else dev.psConstVersion++;
      gfx?.constTouched?.(slot, lo * w, (hi + 1) * w);
    }
    if (changed || prog) { dev.stateVersion++; if (prog) dev.programVersion++; }
    if (sb.streams.size || sb.indices) dev.syncRefShadow();
  }

  /** the references a block holds, released (the block deleted) */
  function release(sb) {
    for (const t of sb.textures.values()) R.drop(t);
    for (const x of sb.streams.values()) if (x) R.drop(x.vb);
    if (sb.indices) R.drop(sb.indices.ib);
    for (const k of ['vs', 'ps', 'decl']) if (sb[k] && typeof sb[k] === 'object') R.drop(sb[k].ptr ?? 0);
    sb.textures.clear(); sb.streams.clear(); sb.indices = undefined;
  }

  return { rec, capture, create, apply, release };
}
