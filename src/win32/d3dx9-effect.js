// The D3DX effect framework (ID3DXEffect) over compiled effects (d3dx9-fxparse.js): parameters (values, textures,
// shaders, strings) addressed by handles or names, techniques and passes whose state assignments are applied to the
// device at BeginPass / CommitChanges — render, stage and sampler states, shaders with their constants laid out from
// the parameters by each shader's constant table, preshaders, array selectors — and restored at End.
import { parseEffect, PT, PC, STATES, isSamplerType, isTextureType } from './d3dx9-fxparse.js';
import { shaderInfo, expressionInfo, runPreshader, RSET } from './d3dx9-preshader.js';

const D3D_OK = 0, S_FALSE = 1, D3DERR_INVALIDCALL = 0x8876086c, E_FAIL = 0x80004005, E_NOTIMPL = 0x80004001;
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const fbits = (v) => { f32[0] = v; return u32[0]; };
const bitsf = (w) => { u32[0] = w; return f32[0]; };
/** a raw word of a scalar of type `t` as a number */
const wordToNum = (t, w) => (t === PT.FLOAT ? bitsf(w) : t === PT.BOOL ? (w ? 1 : 0) : w | 0);
/** a number as the raw word of a scalar of type `t` */
const numToWord = (t, v) => (t === PT.FLOAT ? fbits(v) : t === PT.BOOL ? (v ? 1 : 0) : (Math.trunc(v) | 0) >>> 0);

/** Effect interface methods in vtable order (ID3DXBaseEffect then ID3DXEffect), with their argument counts. */
export const EFFECT_METHODS = [['GetDesc', 1], ['GetParameterDesc', 2], ['GetTechniqueDesc', 2], ['GetPassDesc', 2], ['GetFunctionDesc', 2],
  ['GetParameter', 2], ['GetParameterByName', 2], ['GetParameterBySemantic', 2], ['GetParameterElement', 2], ['GetTechnique', 1], ['GetTechniqueByName', 1],
  ['GetPass', 2], ['GetPassByName', 2], ['GetFunction', 1], ['GetFunctionByName', 1], ['GetAnnotation', 2], ['GetAnnotationByName', 2],
  ['SetValue', 3], ['GetValue', 3], ['SetBool', 2], ['GetBool', 2], ['SetBoolArray', 3], ['GetBoolArray', 3], ['SetInt', 2], ['GetInt', 2], ['SetIntArray', 3], ['GetIntArray', 3],
  ['SetFloat', 2], ['GetFloat', 2], ['SetFloatArray', 3], ['GetFloatArray', 3], ['SetVector', 2], ['GetVector', 2], ['SetVectorArray', 3], ['GetVectorArray', 3],
  ['SetMatrix', 2], ['GetMatrix', 2], ['SetMatrixArray', 3], ['GetMatrixArray', 3], ['SetMatrixPointerArray', 3], ['GetMatrixPointerArray', 3],
  ['SetMatrixTranspose', 2], ['GetMatrixTranspose', 2], ['SetMatrixTransposeArray', 3], ['GetMatrixTransposeArray', 3], ['SetMatrixTransposePointerArray', 3], ['GetMatrixTransposePointerArray', 3],
  ['SetString', 2], ['GetString', 2], ['SetTexture', 2], ['GetTexture', 2], ['GetPixelShader', 2], ['GetVertexShader', 2], ['SetArrayRange', 3],
  ['GetPool', 1], ['SetTechnique', 1], ['GetCurrentTechnique', 0], ['ValidateTechnique', 1], ['FindNextValidTechnique', 2], ['IsParameterUsed', 2],
  ['Begin', 2], ['BeginPass', 1], ['CommitChanges', 0], ['EndPass', 0], ['End', 0], ['GetDevice', 1], ['OnLostDevice', 0], ['OnResetDevice', 0],
  ['SetStateManager', 1], ['GetStateManager', 1], ['BeginParameterBlock', 0], ['EndParameterBlock', 0], ['ApplyParameterBlock', 1], ['DeleteParameterBlock', 1],
  ['CloneEffect', 2], ['SetRawValue', 4]];

/** ID3DXEffectStateManager methods in vtable order (after IUnknown) */
const SM = { SetTransform: 3, SetMaterial: 4, SetLight: 5, LightEnable: 6, SetRenderState: 7, SetTexture: 8, SetTextureStageState: 9, SetSamplerState: 10, SetNPatchMode: 11, SetFVF: 12,
  SetVertexShader: 13, SetVertexShaderConstantF: 14, SetVertexShaderConstantI: 15, SetVertexShaderConstantB: 16, SetPixelShader: 17, SetPixelShaderConstantF: 18, SetPixelShaderConstantI: 19, SetPixelShaderConstantB: 20 };

/**
 * @param {Record<string, [number, Function]>} X d3dx9 function table
 * @param {import('../core/vm.js').Vm} vm
 * @param {{ callMethod: Function, textBuffer: Function }} h
 */
export function defineEffects(X, vm, h) {
  const mem = vm.mem, com = vm.com;
  com.interface('ID3DXEffect', 'f6ceb4b3-4e4c-40dd-b883-8d8de5ea0cd5', 'IUnknown', EFFECT_METHODS);

  /** a guest string (names in descriptions: allocated once per effect object, freed with it) */
  const gstr = (fx, s) => { let a = fx.strAddrs.get(s); if (a === undefined) { a = fx.proc.processHeap.alloc(s.length + 1); mem.writeCString(a, s); fx.strAddrs.set(s, a); } return a; };

  class Effect {
    constructor(c, dev, parsed, flags) {
      this.proc = c.proc; this.dev = dev; this.fx = parsed; this.flags = flags;
      this.strAddrs = new Map();
      this.handles = new Map(); // handle -> node
      this.handleBlock = c.proc.processHeap.alloc(4 * 4096);
      this.nextHandle = 0;
      this.params = parsed.params.map((p, i) => this.buildParam(p.type, p.value, p.annotations, `${i}`, null, p.flags));
      this.byName = new Map(this.params.map((p) => [p.name, p]));
      this.techniques = parsed.techniques.map((t, ti) => ({ kind: 'technique', name: t.name, annotations: t.annotations.map((a, k) => this.buildParam(a.type, a.value, [], `t${ti}a${k}`)), passes: t.passes.map((ps, pi) => ({ kind: 'pass', name: ps.name, index: pi, technique: ti, states: ps.states, annotations: ps.annotations.map((a, k) => this.buildParam(a.type, a.value, [], `t${ti}p${pi}a${k}`)) })) }));
      for (const t of this.techniques) { this.handleOf(t); for (const ps of t.passes) this.handleOf(ps); }
      this.shaders = new Map(); // "t:p:s" or "param:element" -> { ptr, info, vs }
      this.exprs = new Map(); // "t:p:s" / "-1:param:element:state" -> { name, prog }
      this.refs = new Map(); // same keys -> referenced parameter name (usage 1)
      for (const r of parsed.resources) {
        const key = r.technique === 0xffffffff ? `p${r.index}:${r.element}:${r.state}` : `${r.technique}:${r.index}:${r.state}`;
        if (r.usage === 0) this.shaders.set(r.technique === 0xffffffff ? `p${r.index}:${r.element}` : key, { bytes: r.data, ptr: 0, info: null });
        else if (r.usage === 1) this.refs.set(key, cstrOf(r.data));
        else if (r.usage === 2) { const n = new DataView(r.data.buffer, r.data.byteOffset).getUint32(0, true); const name = cstrOf(r.data.subarray(4, 4 + n)); this.exprs.set(key, { name, prog: expressionInfo(r.data.subarray(4 + ((n + 3) & ~3))) }); }
      }
      this.technique = this.techniques[0] ?? null;
      this.saved = null; this.pass = null; this.stateManager = 0; this.recording = null; this.blocks = new Map(); this.nextBlock = 1;
    }
    handleOf(node) { if (!node.handle) { node.handle = this.handleBlock + 4 * (this.nextHandle++ % 4096); this.handles.set(node.handle, node); } return node.handle; }
    /** a parameter node: numeric words (views into one buffer per top-level parameter), objects per element leaf */
    buildParam(type, value, annotations, path, parent = null, flags = 0, words = null) {
      const node = { kind: 'param', name: type.name, semantic: type.semantic, type, flags, parent, annotations: [], elements: [], members: [], words: null, obj: null, samplerStates: null };
      const count = Math.max(1, type.elements);
      if (type.cls === PC.OBJECT) {
        if (isSamplerType(type.type)) node.samplerStates = value?.samplers ?? [];
        else if (type.elements) node.elements = Array.from({ length: type.elements }, (_, e) => this.buildParam({ ...type, elements: 0 }, value instanceof Uint32Array ? value.subarray(e, e + 1) : null, [], `${path}[${e}]`, node));
        else node.obj = { id: value instanceof Uint32Array ? value[0] : 0, ptr: 0 };
        if (isSamplerType(type.type) && type.elements) node.elements = Array.from({ length: type.elements }, (_, e) => { const el = this.buildParam({ ...type, elements: 0 }, { samplers: [node.samplerStates[e] ?? []] }, [], `${path}[${e}]`, node); return el; });
      } else {
        node.words = words ?? (value instanceof Uint32Array ? value.slice() : new Uint32Array((type.bytes * count) / 4));
        const elemWords = type.bytes / 4;
        if (type.elements) node.elements = Array.from({ length: type.elements }, (_, e) => this.buildParam({ ...type, elements: 0 }, null, [], `${path}[${e}]`, node, 0, node.words.subarray(e * elemWords, (e + 1) * elemWords)));
        else if (type.cls === PC.STRUCT) { let o = 0; node.members = type.members.map((m, k) => { const n = (m.bytes * Math.max(1, m.elements)) / 4, sub = this.buildParam(m, null, [], `${path}.${k}`, node, 0, node.words.subarray(o, o + n)); o += n; return sub; }); }
      }
      node.annotations = annotations.map((a, k) => this.buildParam(a.type, a.value, [], `${path}a${k}`, null));
      if (type.cls === PC.OBJECT && type.type === PT.STRING && node.obj) node.obj.string = this.fx.strings.get(node.obj.id) ?? '';
      for (const a of node.annotations) if (a.type.type === PT.STRING && a.obj) a.obj.string = this.fx.strings.get(a.obj.id) ?? '';
      return node;
    }
    /** a parameter by handle or name ("a", "a.b", "a[2]", "a[2].b"), relative to `parentH` (null: top level) */
    param(h, parentH = 0) {
      const n = this.handles.get(h >>> 0);
      if (n) return n.kind === 'param' ? n : null;
      if (!h) return null;
      return this.lookup(mem.readCString(h, 256), parentH ? this.handles.get(parentH >>> 0) : null);
    }
    lookup(name, parent) {
      let cur = null, list = parent ? parent.members : this.params;
      for (const part of name.split('.')) {
        const m = /^([^[]+)((?:\[\d+\])*)$/.exec(part); if (!m) return null;
        cur = list.find((p) => p.name === m[1]) ?? null;
        if (!cur) return null;
        for (const [, idx] of m[2].matchAll(/\[(\d+)\]/g)) { cur = cur.elements[+idx]; if (!cur) return null; }
        list = cur.members;
      }
      return cur;
    }
    tech(h) { const n = this.handles.get(h >>> 0); if (n) return n.kind === 'technique' ? n : null; if (!h) return null; const name = mem.readCString(h, 256); return this.techniques.find((t) => t.name === name) ?? null; }
    passOf(tech, h) { const n = this.handles.get(h >>> 0); if (n) return n.kind === 'pass' ? n : null; if (!h) return null; const name = mem.readCString(h, 256); return tech?.passes.find((p) => p.name === name) ?? null; }
    leafType(p) { let t = p.type; while (t.cls === PC.STRUCT && t.members.length) t = t.members[0]; return t.type; }

    // ---- descriptions
    GetDesc(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; mem.write32(p, gstr(this, 'Orthros D3DX')); mem.write32(p + 4, this.params.length); mem.write32(p + 8, this.techniques.length); mem.write32(p + 12, 0); }
    GetParameterDesc(c) {
      const n = this.param(c.arg(1)), p = c.arg(2); if (!n || !p) return D3DERR_INVALIDCALL;
      const t = n.type;
      mem.write32(p, n.name ? gstr(this, n.name) : 0); mem.write32(p + 4, n.semantic ? gstr(this, n.semantic) : 0);
      mem.write32(p + 8, t.cls); mem.write32(p + 12, t.type); mem.write32(p + 16, t.rows); mem.write32(p + 20, t.cols); mem.write32(p + 24, t.elements);
      mem.write32(p + 28, n.annotations.length); mem.write32(p + 32, t.members.length); mem.write32(p + 36, n.flags); mem.write32(p + 40, t.cls === PC.OBJECT ? 4 * Math.max(1, t.elements) : t.bytes * Math.max(1, t.elements));
    }
    GetTechniqueDesc(c) { const t = this.tech(c.arg(1)), p = c.arg(2); if (!t || !p) return D3DERR_INVALIDCALL; mem.write32(p, gstr(this, t.name)); mem.write32(p + 4, t.passes.length); mem.write32(p + 8, t.annotations.length); }
    GetPassDesc(c) {
      const ps = this.handles.get(c.arg(1) >>> 0), p = c.arg(2); if (!ps || ps.kind !== 'pass' || !p) return D3DERR_INVALIDCALL;
      mem.write32(p, gstr(this, ps.name)); mem.write32(p + 4, ps.annotations.length);
      const fn = (op) => { const k = ps.states.findIndex((s) => s.op === op); if (k < 0) return 0; const sh = this.stateShader(ps, k); if (!sh) return 0; if (!sh.guestCode) { sh.guestCode = this.proc.processHeap.alloc(sh.bytes.length); mem.writeBytes(sh.guestCode, sh.bytes); } return sh.guestCode; };
      mem.write32(p + 8, fn(0x92)); mem.write32(p + 12, fn(0x93));
    }
    GetFunctionDesc() { return E_NOTIMPL; }
    GetParameter(c) { const parent = c.arg(1) ? this.param(c.arg(1)) : null; const list = parent ? (parent.members.length ? parent.members : parent.elements) : this.params; const n = list[c.arg(2)]; return n ? this.handleOf(n) : 0; }
    GetParameterByName(c) { const n = c.arg(2) ? this.lookup(mem.readCString(c.arg(2), 256), c.arg(1) ? this.param(c.arg(1)) : null) : null; return n ? this.handleOf(n) : 0; }
    GetParameterBySemantic(c) { const s = c.arg(2) ? mem.readCString(c.arg(2), 256).toLowerCase() : ''; const parent = c.arg(1) ? this.param(c.arg(1)) : null; const n = (parent ? parent.members : this.params).find((p) => p.semantic.toLowerCase() === s); return n ? this.handleOf(n) : 0; }
    GetParameterElement(c) { const p = this.param(c.arg(1)); const n = p?.elements[c.arg(2)]; return n ? this.handleOf(n) : 0; }
    GetTechnique(c) { const t = this.techniques[c.arg(1)]; return t ? t.handle : 0; }
    GetTechniqueByName(c) { const t = c.arg(1) ? this.techniques.find((x) => x.name === mem.readCString(c.arg(1), 256)) : null; return t ? t.handle : 0; }
    GetPass(c) { const t = this.tech(c.arg(1)); const p = t?.passes[c.arg(2)]; return p ? p.handle : 0; }
    GetPassByName(c) { const t = this.tech(c.arg(1)); const name = c.arg(2) ? mem.readCString(c.arg(2), 256) : ''; const p = t?.passes.find((x) => x.name === name); return p ? p.handle : 0; }
    GetFunction() { return 0; }
    GetFunctionByName() { return 0; }
    annotationsOf(h) { const n = this.handles.get(h >>> 0) ?? (h ? this.param(h) ?? this.tech(h) : null); return n?.annotations ?? []; }
    GetAnnotation(c) { const a = this.annotationsOf(c.arg(1))[c.arg(2)]; return a ? this.handleOf(a) : 0; }
    GetAnnotationByName(c) { const name = c.arg(2) ? mem.readCString(c.arg(2), 256) : ''; const a = this.annotationsOf(c.arg(1)).find((x) => x.name === name); return a ? this.handleOf(a) : 0; }

    // ---- values
    touched(n) { if (this.recording) this.recording.add(n); for (let p = n; p; p = p.parent) p.version = (p.version ?? 0) + 1; this.dirty = true; }
    /** set `count` scalars of a numeric parameter from numbers */
    setNums(n, nums) { if (!n?.words) return D3DERR_INVALIDCALL; const t = this.leafType(n), cnt = Math.min(nums.length, n.words.length); for (let i = 0; i < cnt; i++) n.words[i] = numToWord(t, nums[i]); this.touched(n); return D3D_OK; }
    getNums(n, count) { const t = this.leafType(n), out = []; for (let i = 0; i < Math.min(count, n.words.length); i++) out.push(wordToNum(t, n.words[i])); return out; }
    SetValue(c) {
      const n = this.param(c.arg(1)), src = c.arg(2), bytes = c.arg(3); if (!n || !src) return D3DERR_INVALIDCALL;
      if (n.words) { const k = Math.min(bytes >>> 2, n.words.length); for (let i = 0; i < k; i++) n.words[i] = mem.read32(src + 4 * i); this.touched(n); return D3D_OK; }
      if (n.obj && isTextureType(n.type.type)) return this.setTexture(n, mem.read32(src));
      const leaves = n.elements.length ? n.elements : [n];
      leaves.forEach((l, i) => { if (l.obj && 4 * i < bytes) { if (isTextureType(l.type.type)) this.setTexture(l, mem.read32(src + 4 * i)); else l.obj.ptr = mem.read32(src + 4 * i); } });
      return D3D_OK;
    }
    GetValue(c) {
      const n = this.param(c.arg(1)), dst = c.arg(2), bytes = c.arg(3); if (!n || !dst) return D3DERR_INVALIDCALL;
      if (n.words) { const k = Math.min(bytes >>> 2, n.words.length); for (let i = 0; i < k; i++) mem.write32(dst + 4 * i, n.words[i]); return D3D_OK; }
      const leaves = n.elements.length ? n.elements : [n];
      leaves.forEach((l, i) => { if (4 * i < bytes) { const p = l.obj?.ptr ?? 0; mem.write32(dst + 4 * i, p); if (p && isTextureType(l.type.type)) com.addRef(com.objectAt(p)); } });
      return D3D_OK;
    }
    SetBool(c) { return this.setNums(this.param(c.arg(1)), [c.arg(2) ? 1 : 0]); }
    GetBool(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; mem.write32(c.arg(2), this.getNums(n, 1)[0] ? 1 : 0); }
    SetBoolArray(c) { const nums = []; for (let i = 0; i < c.arg(3); i++) nums.push(mem.read32(c.arg(2) + 4 * i) ? 1 : 0); return this.setNums(this.param(c.arg(1)), nums); }
    GetBoolArray(c) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; this.getNums(n, c.arg(3)).forEach((v, i) => mem.write32(c.arg(2) + 4 * i, v ? 1 : 0)); }
    SetInt(c) { return this.setNums(this.param(c.arg(1)), [c.sarg(2)]); }
    GetInt(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; mem.write32(c.arg(2), Math.trunc(this.getNums(n, 1)[0]) >>> 0); }
    SetIntArray(c) { const nums = []; for (let i = 0; i < c.arg(3); i++) nums.push(mem.readS32(c.arg(2) + 4 * i)); return this.setNums(this.param(c.arg(1)), nums); }
    GetIntArray(c) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; this.getNums(n, c.arg(3)).forEach((v, i) => mem.write32(c.arg(2) + 4 * i, Math.trunc(v) >>> 0)); }
    SetFloat(c) { return this.setNums(this.param(c.arg(1)), [c.argF32(2)]); }
    GetFloat(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; mem.writeF32(c.arg(2), this.getNums(n, 1)[0]); }
    SetFloatArray(c) { const nums = []; for (let i = 0; i < c.arg(3); i++) nums.push(mem.readF32(c.arg(2) + 4 * i)); return this.setNums(this.param(c.arg(1)), nums); }
    GetFloatArray(c) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; this.getNums(n, c.arg(3)).forEach((v, i) => mem.writeF32(c.arg(2) + 4 * i, v)); }
    /** a vector (4 floats at `src`) into element leaf `n`: its columns (vector) or all its scalars up to 4 */
    vecInto(n, src) { const t = this.leafType(n), k = Math.min(4, n.words.length); for (let i = 0; i < k; i++) n.words[i] = numToWord(t, mem.readF32(src + 4 * i)); }
    SetVector(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.vecInto(n, c.arg(2)); this.touched(n); }
    GetVector(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; const v = this.getNums(n, 4); for (let i = 0; i < 4; i++) mem.writeF32(c.arg(2) + 4 * i, v[i] ?? 0); }
    SetVectorArray(c) { const n = this.param(c.arg(1)); if (!n) return D3DERR_INVALIDCALL; const els = n.elements.length ? n.elements : [n]; for (let i = 0; i < Math.min(c.arg(3), els.length); i++) this.vecInto(els[i], c.arg(2) + 16 * i); this.touched(n); }
    GetVectorArray(c) { const n = this.param(c.arg(1)); if (!n) return D3DERR_INVALIDCALL; const els = n.elements.length ? n.elements : [n]; for (let i = 0; i < Math.min(c.arg(3), els.length); i++) { const v = this.getNums(els[i], 4); for (let k = 0; k < 4; k++) mem.writeF32(c.arg(2) + 16 * i + 4 * k, v[k] ?? 0); } }
    /** a 4x4 row-major matrix at `src` (transposed when `tr`) into leaf `n`: its rows x cols top-left block */
    matInto(n, src, tr) { const t = n.type, rows = Math.max(1, t.rows), cols = Math.max(1, t.cols), lt = this.leafType(n); for (let r = 0; r < rows && r < 4; r++) for (let k = 0; k < cols && k < 4; k++) n.words[r * cols + k] = numToWord(lt, mem.readF32(src + 4 * (tr ? k * 4 + r : r * 4 + k))); }
    matOut(n, dst, tr) { const t = n.type, rows = Math.max(1, t.rows), cols = Math.max(1, t.cols), lt = this.leafType(n); for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) { const v = r < rows && k < cols ? wordToNum(lt, n.words[r * cols + k]) : r === k ? 1 : 0; mem.writeF32(dst + 4 * (tr ? k * 4 + r : r * 4 + k), v); } }
    setMats(c, tr, ptrs) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; const els = n.elements.length ? n.elements : [n]; const cnt = ptrs ? c.arg(3) : c.arg(3) ?? 1; for (let i = 0; i < Math.min(cnt, els.length); i++) this.matInto(els[i], ptrs ? mem.read32(c.arg(2) + 4 * i) : c.arg(2) + 64 * i, tr); this.touched(n); return D3D_OK; }
    getMats(c, tr, ptrs) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; const els = n.elements.length ? n.elements : [n]; for (let i = 0; i < Math.min(c.arg(3), els.length); i++) this.matOut(els[i], ptrs ? mem.read32(c.arg(2) + 4 * i) : c.arg(2) + 64 * i, tr); return D3D_OK; }
    SetMatrix(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.matInto(n.elements[0] ?? n, c.arg(2), false); this.touched(n); }
    GetMatrix(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.matOut(n.elements[0] ?? n, c.arg(2), false); }
    SetMatrixTranspose(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.matInto(n.elements[0] ?? n, c.arg(2), true); this.touched(n); }
    GetMatrixTranspose(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.matOut(n.elements[0] ?? n, c.arg(2), true); }
    SetMatrixArray(c) { return this.setMats(c, false, false); }
    GetMatrixArray(c) { return this.getMats(c, false, false); }
    SetMatrixPointerArray(c) { return this.setMats(c, false, true); }
    GetMatrixPointerArray(c) { return this.getMats(c, false, true); }
    SetMatrixTransposeArray(c) { return this.setMats(c, true, false); }
    GetMatrixTransposeArray(c) { return this.getMats(c, true, false); }
    SetMatrixTransposePointerArray(c) { return this.setMats(c, true, true); }
    GetMatrixTransposePointerArray(c) { return this.getMats(c, true, true); }
    SetString(c) { const n = this.param(c.arg(1)); if (!n?.obj) return D3DERR_INVALIDCALL; n.obj.string = c.arg(2) ? mem.readCString(c.arg(2)) : ''; }
    GetString(c) { const n = this.param(c.arg(1)); if (!n?.obj || !c.arg(2)) return D3DERR_INVALIDCALL; mem.write32(c.arg(2), gstr(this, n.obj.string ?? '')); }
    setTexture(n, ptr) {
      const old = n.obj.ptr;
      if (ptr && com.objectAt(ptr)) com.addRef(com.objectAt(ptr));
      n.obj.ptr = ptr;
      if (old && com.objectAt(old)) com.release(com.objectAt(old));
      this.touched(n);
      return D3D_OK;
    }
    SetTexture(c) { const n = this.param(c.arg(1)); if (!n?.obj || !isTextureType(n.type.type)) return D3DERR_INVALIDCALL; return this.setTexture(n, c.arg(2)); }
    GetTexture(c) { const n = this.param(c.arg(1)); if (!n?.obj || !c.arg(2)) return D3DERR_INVALIDCALL; const p = n.obj.ptr; mem.write32(c.arg(2), p); if (p && com.objectAt(p)) com.addRef(com.objectAt(p)); }
    GetPixelShader(c) { return this.getShaderParam(c); }
    GetVertexShader(c) { return this.getShaderParam(c); }
    getShaderParam(c) { const n = this.param(c.arg(1)); if (!n || !c.arg(2)) return D3DERR_INVALIDCALL; const idx = this.params.indexOf(n.parent ?? n), el = n.parent ? n.parent.elements.indexOf(n) : 0; const sh = this.paramShader(idx, el); mem.write32(c.arg(2), sh?.ptr ?? 0); if (sh?.ptr) com.addRef(com.objectAt(sh.ptr)); }
    SetArrayRange() { return D3D_OK; }
    SetRawValue(c) {
      const n = this.param(c.arg(1)), src = c.arg(2), off = c.arg(3), bytes = c.arg(4); if (!n?.words || !src) return D3DERR_INVALIDCALL;
      for (let i = 0; i < bytes >>> 2 && (off >>> 2) + i < n.words.length; i++) n.words[(off >>> 2) + i] = mem.read32(src + 4 * i);
      this.touched(n);
    }

    // ---- techniques and passes
    GetPool(c) { if (c.arg(1)) mem.write32(c.arg(1), 0); return D3D_OK; }
    SetTechnique(c) { const t = this.tech(c.arg(1)); if (!t) return D3DERR_INVALIDCALL; this.technique = t; }
    GetCurrentTechnique() { return this.technique?.handle ?? 0; }
    ValidateTechnique(c) { return this.tech(c.arg(1)) ? D3D_OK : D3DERR_INVALIDCALL; }
    FindNextValidTechnique(c) { const t = c.arg(1) ? this.tech(c.arg(1)) : null; const i = t ? this.techniques.indexOf(t) + 1 : 0; const n = this.techniques[i]; if (c.arg(2)) mem.write32(c.arg(2), n ? n.handle : 0); return D3D_OK; }
    IsParameterUsed() { return 1; }
    GetDevice(c) { if (!c.arg(1)) return D3DERR_INVALIDCALL; mem.write32(c.arg(1), this.dev); com.addRef(com.objectAt(this.dev)); }
    OnLostDevice() {}
    OnResetDevice() {}
    SetStateManager(c) { const m = c.arg(1); if (m && com.objectAt(m)) com.addRef(com.objectAt(m)); this.stateManager = m; if (m) vm.log('gfx', `d3dx effect: state manager set (guest object 0x${m.toString(16)})`); }
    GetStateManager(c) { if (c.arg(1)) mem.write32(c.arg(1), this.stateManager); }
    BeginParameterBlock() { this.recording = new Set(); }
    EndParameterBlock() { if (!this.recording) return 0; const id = this.handleBlock + 4 * (4000 + (this.nextBlock++ % 90)); this.blocks.set(id, [...this.recording].map((n) => ({ n, words: n.words?.slice(), ptr: n.obj?.ptr }))); this.recording = null; return id; }
    ApplyParameterBlock(c) { const b = this.blocks.get(c.arg(1) >>> 0); if (!b) return D3DERR_INVALIDCALL; for (const e of b) { if (e.words) e.n.words.set(e.words); else if (e.n.obj && isTextureType(e.n.type.type)) this.setTexture(e.n, e.ptr); this.touched(e.n); } }
    DeleteParameterBlock(c) { return this.blocks.delete(c.arg(1) >>> 0) ? D3D_OK : D3DERR_INVALIDCALL; }
    CloneEffect(c) { if (!c.arg(2)) return D3DERR_INVALIDCALL; const e = new Effect(c, c.arg(1) || this.dev, this.fx, this.flags); mem.write32(c.arg(2), com.create(c.proc, 'ID3DXEffect', e)); com.addRef(com.objectAt(e.dev)); }

    Begin(c) {
      const t = this.technique; if (!t) return D3DERR_INVALIDCALL;
      if (c.arg(1)) mem.write32(c.arg(1), t.passes.length);
      const flags = c.arg(2);
      this.saved = (flags & 1) ? null : this.snapshot(c, t, flags);
      return D3D_OK;
    }
    BeginPass(c) { const ps = this.technique?.passes[c.arg(1)]; if (!ps) return D3DERR_INVALIDCALL; this.pass = ps; this.apply(c, ps, false); if (globalThis.ORTHROS_FX_BURST && (vm.fxPasses = (vm.fxPasses ?? 0) + 1) === globalThis.ORTHROS_FX_BURST) vm.startApiBurst(c.thread, 3000); }
    CommitChanges(c) { if (this.pass) this.apply(c, this.pass, true); }
    EndPass() { this.pass = null; }
    End(c) { if (this.saved) this.restore(c, this.saved); this.saved = null; this.pass = null; }
    destroy() {
      for (const p of this.allParams()) if (p.obj?.ptr && isTextureType(p.type.type) && com.objectAt(p.obj.ptr)) com.release(com.objectAt(p.obj.ptr));
      for (const sh of this.shaders.values()) if (sh.ptr && com.objectAt(sh.ptr)) com.release(com.objectAt(sh.ptr));
      if (com.objectAt(this.dev)) com.release(com.objectAt(this.dev));
    }
    *allParams() { const walk = function* (n) { yield n; for (const e of n.elements) yield* walk(e); for (const m of n.members) yield* walk(m); }; for (const p of this.params) yield* walk(p); }

    // ---- applying states
    /** the device (or the application's state manager) receiving a state call */
    call(c, name, args) {
      if (this.stateManager) {
        const vt = mem.read32(this.stateManager), fn = mem.read32(vt + 4 * SM[name]);
        return vm.callGuest(c.thread, fn, [this.stateManager, ...args]);
      }
      return h.callMethod(c, this.dev, name, args);
    }
    scratch(c, n) { return (c.proc.fxScratch ??= c.proc.processHeap.alloc(4096)) + n; }
    /** the shader object with this id (its bytecode in the effect's object table), created once */
    objectShader(id) {
      const key = `o${id}`;
      if (!this.shaders.has(key)) { const data = this.fx.objects.get(id); if (!data || data.length < 8) return null; this.shaders.set(key, { bytes: data, ptr: 0, info: null }); }
      return this.shaderAt(key);
    }
    /** the shader of element `el` of shader parameter `pi` (a resource of its own, else the object its value names) */
    paramShader(pi, el) {
      const sh = this.shaderAt(`p${pi}:${el}`);
      if (sh) return sh;
      const n = this.params[pi], leaf = n?.elements.length ? n.elements[el] : n;
      return leaf?.obj?.id ? this.objectShader(leaf.obj.id) : null;
    }
    shaderAt(key) {
      const sh = this.shaders.get(key);
      if (!sh) return null;
      if (!sh.info) {
        sh.info = shaderInfo(sh.bytes);
        sh.vs = (new DataView(sh.bytes.buffer, sh.bytes.byteOffset).getUint32(0, true) >>> 16) === 0xfffe;
        const code = this.proc.processHeap.alloc(sh.bytes.length); mem.writeBytes(code, sh.bytes);
        const out = this.proc.processHeap.alloc(4);
        const ctx = vm.effectCtx;
        const r = h.callMethod(ctx, this.dev, sh.vs ? 'CreateVertexShader' : 'CreatePixelShader', [code, out]);
        sh.ptr = r ? 0 : mem.read32(out);
        if (r) vm.log('gfx', `d3dx effect: ${sh.vs ? 'vertex' : 'pixel'} shader creation failed (0x${(r >>> 0).toString(16)})`);
        this.proc.processHeap.free_(out); this.proc.processHeap.free_(code);
      }
      return sh;
    }
    /** the shader of state k of a pass (its own bytecode, a referenced parameter's, or an array selector's pick) */
    stateShader(ps, k) {
      const key = `${ps.technique}:${ps.index}:${k}`;
      if (this.shaders.has(key)) return this.shaderAt(key);
      const ref = this.refs.get(key), ex = this.exprs.get(key);
      if (ref || ex) {
        const n = this.lookup(ref ?? ex.name, null); if (!n) return null;
        const pi = this.params.indexOf(n);
        const el = ex ? this.evalIndex(ex.prog, n.elements.length || 1) : 0;
        return this.paramShader(pi, el);
      }
      const v = ps.states[k].value; // (an object id of the table)
      return v instanceof Uint32Array && v[0] ? this.objectShader(v[0]) : null;
    }
    evalIndex(prog, count) {
      const inputs = new Float64Array(4 * 256), out = new Float32Array(4);
      this.fillInputs(prog.inputs, inputs);
      runPreshader(prog, inputs, out);
      return Math.max(0, Math.min(count - 1, Math.round(out[0])));
    }
    /** registers of constant-table entries filled from the parameters (float components; ints/bools as numbers) */
    fillInputs(entries, regs) {
      for (const e of entries) {
        const n = this.lookup(e.name, null); if (!n) continue;
        const vals = this.registersOf(n, e.type, e.count, e.set);
        for (let i = 0; i < vals.length && 4 * e.reg + i < regs.length; i++) regs[4 * e.reg + i] = vals[i];
      }
    }
    /**
     * A parameter laid out in `count` registers per its constant-table type: matrices by columns or rows, one
     * register per vector / scalar, elements then members in order. Returns numbers (4 per register).
     */
    registersOf(n, ctype, count, set) {
      const out = new Array(4 * count).fill(0);
      let reg = 0;
      const walk = (node, t) => {
        const els = t.elements > 1 && node.elements.length ? node.elements : [node];
        for (const el of els) {
          if (reg >= count) return;
          if (t.cls === PC.STRUCT) { t.members.forEach((m, k) => { const sub = el.members[k] ?? el.members.find((x) => x.name === m.name); if (sub) walk(sub, m.type); }); continue; }
          if (!el.words) { reg++; continue; }
          const lt = this.leafType(el), rows = Math.max(1, el.type.rows), cols = Math.max(1, el.type.cols);
          const at = (r, k) => (r < rows && k < cols ? wordToNum(lt, el.words[r * cols + k]) : 0);
          if (set === RSET.BOOL || set === RSET.INT4 ? false : t.cls === PC.MATRIX_COLUMNS) {
            for (let k = 0; k < t.cols && reg < count; k++, reg++) for (let r = 0; r < Math.min(4, t.rows); r++) out[4 * reg + r] = at(r, k);
          } else if (t.cls === PC.MATRIX_ROWS) {
            for (let r = 0; r < t.rows && reg < count; r++, reg++) for (let k = 0; k < Math.min(4, t.cols); k++) out[4 * reg + k] = at(r, k);
          } else if (set === RSET.BOOL) { out[4 * reg] = at(0, 0); reg++; }
          else { for (let k = 0; k < Math.min(4, t.rows * t.cols); k++) out[4 * reg + k] = wordToNum(lt, el.words[k] ?? 0); reg++; }
        }
      };
      walk(n, ctype);
      return out;
    }
    /** a shader set for the pass, its constants (from the parameters, and its preshader's outputs) and samplers */
    bindShader(c, sh) {
      const vs = sh.vs, info = sh.info;
      for (const e of info.constants) {
        const n = this.lookup(e.name, null);
        if (e.set === RSET.SAMPLER) { if (n) this.bindSampler(c, n, (vs ? 257 : 0) + e.reg); continue; }
        if (!n) continue;
        const vals = this.registersOf(n, e.type, e.count, e.set), p = this.scratch(c, 0);
        if (e.set === RSET.FLOAT4) { for (let i = 0; i < vals.length; i++) mem.writeF32(p + 4 * i, vals[i]); this.call(c, vs ? 'SetVertexShaderConstantF' : 'SetPixelShaderConstantF', [e.reg, p, e.count]); }
        else if (e.set === RSET.INT4) { for (let i = 0; i < vals.length; i++) mem.write32(p + 4 * i, Math.trunc(vals[i]) >>> 0); this.call(c, vs ? 'SetVertexShaderConstantI' : 'SetPixelShaderConstantI', [e.reg, p, e.count]); }
        else { for (let i = 0; i < e.count; i++) mem.write32(p + 4 * i, vals[4 * i] ? 1 : 0); this.call(c, vs ? 'SetVertexShaderConstantB' : 'SetPixelShaderConstantB', [e.reg, p, e.count]); }
      }
      const pre = info.preshader;
      if (pre) {
        const inputs = new Float64Array(4 * 512), out = new Float32Array(4 * 256);
        this.fillInputs(pre.inputs, inputs);
        runPreshader(pre, inputs, out);
        const p = this.scratch(c, 0);
        for (const [start, cnt] of pre.outRanges) {
          for (let i = 0; i < 4 * cnt; i++) mem.writeF32(p + 4 * i, out[4 * start + i]);
          this.call(c, vs ? 'SetVertexShaderConstantF' : 'SetPixelShaderConstantF', [start, p, cnt]);
        }
      }
    }
    /** a sampler parameter's states (and texture) applied to sampler register `reg` */
    bindSampler(c, n, reg) {
      const states = n.samplerStates?.[0] ?? (n.parent?.samplerStates?.[n.parent.elements.indexOf(n)]) ?? [];
      const pi = this.params.indexOf(n.parent ?? n), el = n.parent ? n.parent.elements.indexOf(n) : 0;
      states.forEach((s, k) => {
        const [cls, idx] = STATES[s.op] ?? [];
        const key = `p${pi}:${el}:${k}`;
        if (cls === 'texture') { const tn = this.refs.has(key) ? this.lookup(this.refs.get(key), null) : null; this.call(c, 'SetTexture', [reg, tn?.obj?.ptr ?? 0]); }
        else if (cls === 'samp') this.call(c, 'SetSamplerState', [reg, idx, this.stateWord(s, key)]);
      });
    }
    /** the raw value of a numeric state (a referenced parameter's first scalar, or its own constant) */
    stateWord(s, key) {
      const ref = this.refs.get(key);
      if (ref) { const n = this.lookup(ref, null); if (n?.words) return n.words[0]; }
      const ex = this.exprs.get(key);
      if (ex) { const inputs = new Float64Array(4 * 256), out = new Float32Array(4); this.fillInputs(ex.prog.inputs, inputs); runPreshader(ex.prog, inputs, out); return numToWord(s.type.type, out[0]); }
      return s.value instanceof Uint32Array ? s.value[0] ?? 0 : 0;
    }
    apply(c, ps, commit) {
      vm.effectCtx = c;
      ps.states.forEach((s, k) => {
        const [cls, idx] = STATES[s.op] ?? [];
        const key = `${ps.technique}:${ps.index}:${k}`;
        const dyn = this.refs.has(key) || this.exprs.has(key);
        if (commit && !dyn && cls !== 'vs' && cls !== 'ps' && cls !== 'sampler' && cls !== 'texture') return; // (CommitChanges: what depends on parameters)
        switch (cls) {
          case 'rs': this.call(c, 'SetRenderState', [idx, this.stateWord(s, key)]); break;
          case 'tss': this.call(c, 'SetTextureStageState', [s.index, idx, this.stateWord(s, key)]); break;
          case 'samp': this.call(c, 'SetSamplerState', [s.index, idx, this.stateWord(s, key)]); break;
          case 'fvf': this.call(c, 'SetFVF', [this.stateWord(s, key)]); break;
          case 'npatch': this.call(c, 'SetNPatchMode', [this.stateWord(s, key)]); break;
          case 'lightenable': this.call(c, 'LightEnable', [s.index, this.stateWord(s, key)]); break;
          case 'vs': case 'ps': {
            const sh = this.stateShader(ps, k);
            if (!sh?.ptr && (this.missing ??= new Set()).size < 32 && !this.missing.has(key)) { this.missing.add(key); vm.log('gfx', `d3dx effect: no ${cls} for technique ${this.techniques[ps.technique]?.name} pass ${ps.index} state ${k} (value ${s.value?.[0]}, ref ${this.refs.get(key) ?? '-'}, expr ${this.exprs.get(key)?.name ?? '-'}, own ${this.shaders.has(key)})`); }
            this.call(c, cls === 'vs' ? 'SetVertexShader' : 'SetPixelShader', [sh?.ptr ?? 0]);
            if (sh) this.bindShader(c, sh);
            break;
          }
          case 'texture': { const ref = this.refs.get(key); const tn = ref ? this.lookup(ref, null) : null; this.call(c, 'SetTexture', [s.index, tn?.obj?.ptr ?? 0]); break; }
          case 'sampler': { const ref = this.refs.get(key); const sn = ref ? this.lookup(ref, null) : null; if (sn) this.bindSampler(c, sn, s.index); break; }
          case 'transform': { const src = this.refs.has(key) ? this.lookup(this.refs.get(key), null)?.words : s.value; if (!src) break; const p = this.scratch(c, 2048); for (let i = 0; i < 16; i++) mem.write32(p + 4 * i, src[i] ?? (i % 5 === 0 ? 0x3f800000 : 0)); this.call(c, 'SetTransform', [idx + (idx === 256 || idx === 16 ? s.index : 0), p]); break; }
          case 'const': {
            const src = this.refs.has(key) ? this.lookup(this.refs.get(key), null)?.words : s.value; if (!src) break;
            const p = this.scratch(c, 2048); for (let i = 0; i < src.length; i++) mem.write32(p + 4 * i, src[i]);
            const n = Math.max(1, Math.ceil(src.length / 4)), vs = idx.startsWith('vs');
            const kind = idx.includes('b') ? 'B' : idx.includes('i') ? 'I' : 'F';
            this.call(c, `Set${vs ? 'Vertex' : 'Pixel'}ShaderConstant${kind}`, [s.index, p, kind === 'B' ? src.length : n]);
            break;
          }
          case 'material': case 'light': break; // (fixed-function lights/materials from effects: not used by shader effects)
          default: if ((this.unknownOps ??= new Set()).size < 16 && !this.unknownOps.has(s.op)) { this.unknownOps.add(s.op); vm.log('gfx', `d3dx effect: state operation 0x${s.op.toString(16)} not applied`); }
        }
      });
    }
    /** the device states a technique touches, as they are now (restored at End) */
    snapshot(c, t, flags) {
      const dev = com.implAt(this.dev); if (!dev) return null;
      const rs = new Map(), tss = new Map(), samp = new Map(), tex = new Map();
      for (const ps of t.passes) ps.states.forEach((s) => {
        const [cls, idx] = STATES[s.op] ?? [];
        if (cls === 'rs') rs.set(idx, dev.rs.get(idx) ?? 0);
        else if (cls === 'tss') tss.set(`${s.index}:${idx}`, dev.tss[s.index]?.get(idx) ?? 0);
        else if (cls === 'texture') tex.set(s.index, dev.textures[s.index] ?? 0);
      });
      const vs = (flags & 2) ? undefined : dev.vsObj?.comObject?.ptr ?? 0, ps = (flags & 2) ? undefined : dev.psObj?.comObject?.ptr ?? 0;
      void samp;
      return { rs, tss, tex, vs, ps };
    }
    restore(c, s) {
      for (const [k, v] of s.rs) this.call(c, 'SetRenderState', [k, v]);
      for (const [k, v] of s.tss) { const [st, ty] = k.split(':').map(Number); this.call(c, 'SetTextureStageState', [st, ty, v]); }
      for (const [st, t] of s.tex) this.call(c, 'SetTexture', [st, t]);
      if (s.vs !== undefined) this.call(c, 'SetVertexShader', [s.vs]);
      if (s.ps !== undefined) this.call(c, 'SetPixelShader', [s.ps]);
    }
  }

  const create = (c, dev, src, len, pEffect, pErrors, flags) => {
    if (pEffect) mem.write32(pEffect, 0);
    if (pErrors) mem.write32(pErrors, 0);
    if (!dev || !src || !len) return D3DERR_INVALIDCALL;
    let parsed;
    try { parsed = parseEffect(mem.bytes(src, len).slice()); }
    catch (e) {
      vm.log('gfx', `d3dx: effect not loaded: ${e.message}`);
      if (pErrors) mem.write32(pErrors, h.textBuffer(c, `Orthros: ${e.message}`));
      return E_FAIL;
    }
    vm.effectCtx = c;
    const fx = new Effect(c, dev, parsed, flags);
    com.addRef(com.objectAt(dev));
    if (pEffect) mem.write32(pEffect, com.create(c.proc, 'ID3DXEffect', fx));
    vm.log('gfx', `d3dx: effect loaded: ${parsed.params.length} parameters, techniques ${parsed.techniques.map((t) => t.name).join(', ')}`);
    return D3D_OK;
  };
  // (device, src, len, defines, include, flags, pool, ppEffect, ppErrors)
  X.D3DXCreateEffect = [9, (c) => { if (c.arg(6)) vm.log('gfx', 'd3dx: effect pool given (parameters are not shared across effects here)'); return create(c, c.arg(0), c.arg(1), c.arg(2), c.arg(7), c.arg(8), c.arg(5)); }];
  X.D3DXCreateEffectEx = [10, (c) => create(c, c.arg(0), c.arg(1), c.arg(2), c.arg(8), c.arg(9), c.arg(6))];
  const fromFile = (wide) => (c) => { // (device, file, defines, include, flags, pool, ppEffect, ppErrors)
    const name = wide ? c.wstr(1) : c.str(1), path = name ? c.proc.path(name) : null, st = path ? vm.vfs.stat(path) : null;
    if (!st) { if (c.arg(6)) mem.write32(c.arg(6), 0); vm.log('gfx', `d3dx: effect file ${name} not found`); return D3DERR_INVALIDCALL; }
    const data = vm.vfs.open(path).read(0, st.size), tmp = c.proc.processHeap.alloc(data.length);
    mem.writeBytes(tmp, data);
    const r = create(c, c.arg(0), tmp, data.length, c.arg(6), c.arg(7), c.arg(4));
    c.proc.processHeap.free_(tmp);
    return r;
  };
  X.D3DXCreateEffectFromFileA = [8, fromFile(false)];
  X.D3DXCreateEffectFromFileW = [8, fromFile(true)];
  X.D3DXCreateEffectPool = [1, (c) => { if (c.arg(0)) mem.write32(c.arg(0), 0); return E_NOTIMPL; }];
}

/** a NUL-terminated string at the start of `bytes` */
function cstrOf(bytes) { let s = ''; for (const b of bytes) { if (!b) break; s += String.fromCharCode(b); } return s; }
export { S_FALSE };
