// The D3DX effect framework (ID3DXEffect) over compiled effects (d3dx9-fxparse.js): parameters (values, textures,
// shaders, strings) addressed by handles or names, techniques and passes whose state assignments are applied to the
// device at BeginPass / CommitChanges — render, stage and sampler states, shaders with their constants laid out from
// the parameters by each shader's constant table, preshaders, array selectors — and restored at End.
import { snapClass } from '../core/snapshot.js';
import { parseEffect, describeEffect, PT, PC, STATES, isSamplerType, isTextureType } from './d3dx9-fxparse.js';
import { shaderInfo, expressionInfo, compilePreshader, RSET } from './d3dx9-preshader.js';
import { DEFER_HANDLE_BYTES, COMMIT_LIST, COMMIT_LIST_WORDS, SHADOW_RS, SHADOW_TSS, SHADOW_SAMP, SHADOW_TEX, PARAM_DESC_SLOTS, PARAM_DESC_ENTRY, FX_SLOTS, FX_SLOT_BYTES } from '../cpu/jit/runtime.js';
import { apiOpt } from '../core/api-opt.js';

const D3D_OK = 0, S_FALSE = 1, D3DERR_INVALIDCALL = 0x8876086c, E_FAIL = 0x80004005, E_NOTIMPL = 0x80004001;
// snapshot: scratch
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
/** the device methods the effect runtime calls, by number (M.<name>): each resolved once per effect, see Effect.call */
const DEV_METHODS = ['SetRenderState', 'SetTextureStageState', 'SetSamplerState', 'SetFVF', 'SetNPatchMode', 'LightEnable', 'SetVertexShader', 'SetPixelShader', 'SetTexture', 'SetTransform',
  'SetVertexShaderConstantF', 'SetVertexShaderConstantI', 'SetVertexShaderConstantB', 'SetPixelShaderConstantF', 'SetPixelShaderConstantI', 'SetPixelShaderConstantB'];
const M = Object.fromEntries(DEV_METHODS.map((n, i) => [n, i]));

/**
 * @param {Record<string, [number, Function]>} X d3dx9 function table
 * @param {import('../core/vm.js').Vm} vm
 * @param {{ callMethod: Function, textBuffer: Function }} h
 */
/**
 * The resources of a parsed effect by key ("technique:pass:state", or "p<param>:<element>:<state>" for the states of
 * sampler parameters): shaders ("t:p:s" or "p<param>:<element>" -> { bytes }), expressions computing a state's value
 * or an array selector's index ({ name: the array (selectors) or null, prog }), referenced parameter names.
 */
export function effectResources(parsed) {
  const shaders = new Map(), exprs = new Map(), refs = new Map();
  for (const r of parsed.resources) {
    const key = r.technique === 0xffffffff ? `p${r.index}:${r.element}:${r.state}` : `${r.technique}:${r.index}:${r.state}`;
    // usage 0: compiled code — a shader, or (version token 'FX') an expression computing the state's value from
    // parameters (e.g. AlphaTestEnable = (a bool parameter)), evaluated whenever the pass is applied
    if (r.usage === 0 && r.data.length >= 4 && (new DataView(r.data.buffer, r.data.byteOffset).getUint32(0, true) >>> 16) === 0x4658) exprs.set(key, { name: null, prog: expressionInfo(r.data), P: null });
    else if (r.usage === 0) shaders.set(r.technique === 0xffffffff ? `p${r.index}:${r.element}` : key, shaderRecord(r.data));
    else if (r.usage === 1) refs.set(key, cstrOf(r.data));
    else if (r.usage === 2) { const n = new DataView(r.data.buffer, r.data.byteOffset).getUint32(0, true); const name = cstrOf(r.data.subarray(4, 4 + n)); exprs.set(key, { name, prog: expressionInfo(r.data.subarray(4 + ((n + 3) & ~3))), P: null }); }
  }
  return { shaders, exprs, refs };
}

/**
 * A shader of an effect (its bytecode; the device object and the constant-table bindings made at its first use, see
 * shaderAt), every field present from the start: the binding loops read these records (and the parameter nodes, see
 * buildParam) at every pass and commit, and objects of one shape keep those reads monomorphic.
 */
function shaderRecord(bytes) {
  return { bytes, ptr: 0, impl: null, info: null, vs: false, consts: null, samplers: null, pre: null, constVersion: -1, constAll: false, constRegs: null, preRuns: -1, guestCode: 0 };
}

export function defineEffects(X, vm, h) {
  const mem = vm.mem, com = vm.com;
  com.interface('ID3DXEffect', 'f6ceb4b3-4e4c-40dd-b883-8d8de5ea0cd5', 'IUnknown', EFFECT_METHODS);

  /** a guest string (names in descriptions: allocated once per effect object, freed with it) */
  const gstr = (fx, s) => { let a = fx.strAddrs.get(s); if (a === undefined) { a = fx.proc.processHeap.alloc(s.length + 1); mem.writeCString(a, s); fx.strAddrs.set(s, a); } return a; };
  /** an effect's guest object; +12 holds its handle block (runtime.js DEFER_HANDLE: setters given a handle are queued by the JIT) */
  const createEffect = (c, fx) => { const p = com.create(c.proc, 'ID3DXEffect', fx); mem.write32(p + 12, fx.handleBlock); return p; };

  class Effect {
    constructor(c, dev, parsed, flags) {
      this.proc = c.proc; this.dev = dev; this.fx = parsed; this.flags = flags;
      this.strAddrs = new Map();
      this.handles = new Map(); // handle -> node
      this.handleNodes = []; // (the same by slot: (handle - handleBlock) / 4, see param)
      // (followed by the cache of parameter descriptions the JIT's GetParameterDesc reads, runtime.js FID_PARAM_DESC, and
      // the technique slots of the queued technique calls, FX_SLOTS; the word at each technique's handle: its pass count)
      this.handleBlock = c.proc.processHeap.alloc(FX_SLOTS + FX_SLOT_BYTES);
      mem.fill(this.handleBlock, FX_SLOTS + FX_SLOT_BYTES, 0);
      this.nextHandle = 0;
      this.params = parsed.params.map((p, i) => this.buildParam(p.type, p.value, p.annotations, `${i}`, null, p.flags));
      this.byName = new Map(this.params.map((p) => [p.name, p]));
      // (techniques and passes, as parameter nodes, with every field they get later: see buildParam)
      this.techniques = parsed.techniques.map((t, ti) => ({ kind: 'technique', name: t.name, handle: 0, touched: null, restoreList: 0, restoreShadow: 0, restoreVals: null, annotations: t.annotations.map((a, k) => this.buildParam(a.type, a.value, [], `t${ti}a${k}`)),
        passes: t.passes.map((ps, pi) => ({ kind: 'pass', name: ps.name, handle: 0, index: pi, technique: ti, states: ps.states, ops: null, allFns: null, dynFns: null, shaderSel: null, commitEntries: undefined, annotations: ps.annotations.map((a, k) => this.buildParam(a.type, a.value, [], `t${ti}p${pi}a${k}`)) })) }));
      for (const t of this.techniques) { this.handleOf(t); for (const ps of t.passes) this.handleOf(ps); }
      ({ shaders: this.shaders, exprs: this.exprs, refs: this.refs } = effectResources(parsed));
      this.technique = this.techniques[0] ?? null;
      mem.write32(this.handleBlock + FX_SLOTS, this.technique?.passes.length ?? 0);
      this.saved = null; this.pass = null; this.stateManager = 0; this.recording = null; this.blocks = new Map(); this.nextBlock = 1;
      // (filled at first use; declared here so that every effect object has one shape: the per-call methods read them)
      this.comObject = null; this.devImpl = null; this.devObj = null; this.fastCtx = null; this.devFns = null; this.vsRegsRaw = undefined; this.psRegsRaw = undefined;
      this.paramShaders = null; this.missing = null; this.unknownOps = null; this.commitBlock = 0; this.commitPublished = null; this.commitShadow = 0; this.noRestore = 0;
    }
    handleOf(node) {
      if (!node.handle) {
        const k = this.nextHandle++ % (DEFER_HANDLE_BYTES / 4);
        node.handle = this.handleBlock + 4 * k; this.handles.set(node.handle, node); this.handleNodes[k] = node;
        mem.write32(node.handle, node.kind === 'technique' ? node.passes.length : 0); // (runtime.js DEFER_TECH: a technique's pass count)
        const e = this.descEntry(node.handle); if (mem.read32(e) === node.handle) mem.write32(e, 0); // (a handle given again: its old description gone)
      }
      return node.handle;
    }
    /** the description cache entry of handle `h` (runtime.js FID_PARAM_DESC) */
    descEntry(h) { return this.handleBlock + DEFER_HANDLE_BYTES + (((h - this.handleBlock) >>> 2) & (PARAM_DESC_SLOTS - 1)) * PARAM_DESC_ENTRY; }
    /**
     * A parameter node: numeric words (views into one buffer per top-level parameter), objects per element leaf. Every
     * field a node gets later is there from the start (its handle, its version, its compiled sampler states): the setters
     * and the bindings read nodes of every parameter at the same sites, which stay monomorphic with one shape for all.
     */
    buildParam(type, value, annotations, path, parent = null, flags = 0, words = null) {
      const node = { kind: 'param', name: type.name, semantic: type.semantic, type, leaf: leafTypeOf(type), flags, parent, handle: 0, version: 0, annotations: [], elements: [], members: [], words: null, obj: null, samplerStates: null,
        samplerOps: null, samplerConst: false, samplerTexOps: null, samplerSeen: null };
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
      const k = (h - this.handleBlock) >>> 0; // (a handle: its slot in handleNodes, no hash lookup)
      const n = k < DEFER_HANDLE_BYTES && (k & 3) === 0 && !apiOpt.fxRef ? this.handleNodes[k >>> 2] : this.handles.get(h >>> 0);
      if (n) return n.kind === 'param' ? n : null;
      if (!h) return null;
      return this.lookup(mem.readCString(h, 256), parentH ? this.handles.get(parentH >>> 0) : null);
    }
    lookup(name, parent) {
      if (!parent && !name.includes('.') && !name.includes('[')) return this.byName.get(name) ?? null;
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
    leafType(p) { return p.leaf; }

    // ---- descriptions
    GetDesc(c) { const p = c.arg(1); if (!p) return D3DERR_INVALIDCALL; mem.write32(p, gstr(this, 'Orthros D3DX')); mem.write32(p + 4, this.params.length); mem.write32(p + 8, this.techniques.length); mem.write32(p + 12, 0); }
    GetParameterDesc(c) {
      const n = this.param(c.arg(1)), p = c.arg(2); if (!n || !p) return D3DERR_INVALIDCALL;
      const t = n.type;
      mem.write32(p, n.name ? gstr(this, n.name) : 0); mem.write32(p + 4, n.semantic ? gstr(this, n.semantic) : 0);
      mem.write32(p + 8, t.cls); mem.write32(p + 12, t.type); mem.write32(p + 16, t.rows); mem.write32(p + 20, t.cols); mem.write32(p + 24, t.elements);
      mem.write32(p + 28, n.annotations.length); mem.write32(p + 32, t.members.length); mem.write32(p + 36, n.flags); mem.write32(p + 40, t.cls === PC.OBJECT ? 4 * Math.max(1, t.elements) : t.bytes * Math.max(1, t.elements));
      // (a parameter given by its handle: its description kept for the JIT's fast path, which answers the next calls)
      const h = c.arg(1) >>> 0;
      if (n.handle === h && h - this.handleBlock < DEFER_HANDLE_BYTES && p >= 0x10000 && p < 0x7fff0000 - 64) { const e = this.descEntry(h); mem.write32(e, h); mem.copy(e + 4, p, PARAM_DESC_ENTRY - 4); }
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
    touched(n) { if (this.recording) this.recording.add(n); for (let p = n; p !== null; p = p.parent) p.version++; }
    /**
     * A numeric parameter written (`ch`: a word changed): its version moves only on a real change — games set most
     * parameters again with the values they hold (three writes in four in BFME2 play), and an unmoved version spares
     * the shader bindings and the preshaders reading it (dbg:ORTHROS_API_OPT_OFF=1: moved at every write, as before).
     */
    wrote(n, ch) { if (ch || apiOpt.fxRef) this.touched(n); else if (this.recording) this.recording.add(n); }
    /** set `count` scalars of a numeric parameter from numbers */
    setNums(n, nums) { if (!n?.words) return D3DERR_INVALIDCALL; const t = this.leafType(n), cnt = Math.min(nums.length, n.words.length); let ch = false; for (let i = 0; i < cnt; i++) { const w = numToWord(t, nums[i]); if (n.words[i] !== w) { n.words[i] = w; ch = true; } } this.wrote(n, ch); return D3D_OK; }
    /** setNums of one number (SetBool / SetInt / SetFloat: no array per call) */
    setNum(n, v) {
      if (n === null || n.words === null) return D3DERR_INVALIDCALL;
      const w = n.words; let ch = false;
      if (w.length !== 0) { const x = numToWord(n.leaf, v); if (w[0] !== x) { w[0] = x; ch = true; } }
      this.wrote(n, ch); return D3D_OK;
    }
    getNums(n, count) { const t = this.leafType(n), out = []; for (let i = 0; i < Math.min(count, n.words.length); i++) out.push(wordToNum(t, n.words[i])); return out; }
    SetValue(c) {
      const n = this.param(c.arg(1)), src = c.arg(2), bytes = c.arg(3); if (!n || !src) return D3DERR_INVALIDCALL;
      if (n.words) { const k = Math.min(bytes >>> 2, n.words.length), w = n.words; let ch = false; for (let i = 0; i < k; i++) { const x = mem.read32(src + 4 * i); if (w[i] !== x) { w[i] = x; ch = true; } } this.wrote(n, ch); return D3D_OK; }
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
    SetBool(c) { return this.setNum(this.param(c.arg(1)), c.arg(2) ? 1 : 0); }
    GetBool(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; mem.write32(c.arg(2), this.getNums(n, 1)[0] ? 1 : 0); }
    SetBoolArray(c) { const nums = []; for (let i = 0; i < c.arg(3); i++) nums.push(mem.read32(c.arg(2) + 4 * i) ? 1 : 0); return this.setNums(this.param(c.arg(1)), nums); }
    GetBoolArray(c) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; this.getNums(n, c.arg(3)).forEach((v, i) => mem.write32(c.arg(2) + 4 * i, v ? 1 : 0)); }
    SetInt(c) { return this.setNum(this.param(c.arg(1)), c.sarg(2)); }
    GetInt(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; mem.write32(c.arg(2), Math.trunc(this.getNums(n, 1)[0]) >>> 0); }
    SetIntArray(c) { const nums = []; for (let i = 0; i < c.arg(3); i++) nums.push(mem.readS32(c.arg(2) + 4 * i)); return this.setNums(this.param(c.arg(1)), nums); }
    GetIntArray(c) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; this.getNums(n, c.arg(3)).forEach((v, i) => mem.write32(c.arg(2) + 4 * i, Math.trunc(v) >>> 0)); }
    SetFloat(c) { return this.setNum(this.param(c.arg(1)), c.argF32(2)); }
    GetFloat(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; mem.writeF32(c.arg(2), this.getNums(n, 1)[0]); }
    SetFloatArray(c) { const nums = []; for (let i = 0; i < c.arg(3); i++) nums.push(mem.readF32(c.arg(2) + 4 * i)); return this.setNums(this.param(c.arg(1)), nums); }
    GetFloatArray(c) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; this.getNums(n, c.arg(3)).forEach((v, i) => mem.writeF32(c.arg(2) + 4 * i, v)); }
    /** a vector (4 floats at `src`) into element leaf `n`: its columns (vector) or all its scalars up to 4 */
    vecInto(n, src) {
      const t = this.leafType(n), k = Math.min(4, n.words.length), w = n.words;
      let ch = false; // (whether a word changed)
      if (t === PT.FLOAT && !apiOpt.fxRef) { for (let i = 0; i < k; i++) { const x = mem.read32(src + 4 * i); if (w[i] !== x) { w[i] = x; ch = true; } } return ch; } // (float words as they are: bits kept)
      for (let i = 0; i < k; i++) { const x = numToWord(t, mem.readF32(src + 4 * i)); if (w[i] !== x) { w[i] = x; ch = true; } }
      return ch;
    }
    SetVector(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.wrote(n, this.vecInto(n, c.arg(2))); }
    GetVector(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; const v = this.getNums(n, 4); for (let i = 0; i < 4; i++) mem.writeF32(c.arg(2) + 4 * i, v[i] ?? 0); }
    SetVectorArray(c) { const n = this.param(c.arg(1)); if (!n) return D3DERR_INVALIDCALL; const els = n.elements.length ? n.elements : [n]; let ch = false; for (let i = 0; i < Math.min(c.arg(3), els.length); i++) if (this.vecInto(els[i], c.arg(2) + 16 * i)) ch = true; this.wrote(n, ch); }
    GetVectorArray(c) { const n = this.param(c.arg(1)); if (!n) return D3DERR_INVALIDCALL; const els = n.elements.length ? n.elements : [n]; for (let i = 0; i < Math.min(c.arg(3), els.length); i++) { const v = this.getNums(els[i], 4); for (let k = 0; k < 4; k++) mem.writeF32(c.arg(2) + 16 * i + 4 * k, v[k] ?? 0); } }
    /** a 4x4 row-major matrix at `src` (transposed when `tr`) into leaf `n`: its rows x cols top-left block */
    matInto(n, src, tr) {
      const t = n.type, rows = Math.max(1, t.rows), cols = Math.max(1, t.cols), lt = this.leafType(n), w = n.words;
      let ch = false; // (whether a word changed)
      if (lt === PT.FLOAT && !apiOpt.fxRef) { // (float words as they are: bits kept)
        for (let r = 0; r < rows && r < 4; r++) for (let k = 0; k < cols && k < 4; k++) { const x = mem.read32(src + 4 * (tr ? k * 4 + r : r * 4 + k)), i = r * cols + k; if (w[i] !== x) { w[i] = x; ch = true; } }
        return ch;
      }
      for (let r = 0; r < rows && r < 4; r++) for (let k = 0; k < cols && k < 4; k++) { const x = numToWord(lt, mem.readF32(src + 4 * (tr ? k * 4 + r : r * 4 + k))), i = r * cols + k; if (w[i] !== x) { w[i] = x; ch = true; } }
      return ch;
    }
    matOut(n, dst, tr) { const t = n.type, rows = Math.max(1, t.rows), cols = Math.max(1, t.cols), lt = this.leafType(n); for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) { const v = r < rows && k < cols ? wordToNum(lt, n.words[r * cols + k]) : r === k ? 1 : 0; mem.writeF32(dst + 4 * (tr ? k * 4 + r : r * 4 + k), v); } }
    setMats(c, tr, ptrs) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; const els = n.elements.length ? n.elements : [n]; const cnt = ptrs ? c.arg(3) : c.arg(3) ?? 1; let ch = false; for (let i = 0; i < Math.min(cnt, els.length); i++) if (this.matInto(els[i], ptrs ? mem.read32(c.arg(2) + 4 * i) : c.arg(2) + 64 * i, tr)) ch = true; this.wrote(n, ch); return D3D_OK; }
    getMats(c, tr, ptrs) { const n = this.param(c.arg(1)); if (!n?.words) return D3DERR_INVALIDCALL; const els = n.elements.length ? n.elements : [n]; for (let i = 0; i < Math.min(c.arg(3), els.length); i++) this.matOut(els[i], ptrs ? mem.read32(c.arg(2) + 4 * i) : c.arg(2) + 64 * i, tr); return D3D_OK; }
    SetMatrix(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.wrote(n, this.matInto(n.elements[0] ?? n, c.arg(2), false)); }
    GetMatrix(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.matOut(n.elements[0] ?? n, c.arg(2), false); }
    SetMatrixTranspose(c) { const n = this.param(c.arg(1)); if (!n?.words || !c.arg(2)) return D3DERR_INVALIDCALL; this.wrote(n, this.matInto(n.elements[0] ?? n, c.arg(2), true)); }
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
      if (old !== ptr || apiOpt.off) { // (the same texture again: its reference taken then dropped — nothing to do but the touch)
        const o = ptr ? com.objectAt(ptr) : null;
        if (o) com.addRef(o);
        n.obj.ptr = ptr;
        const oo = old ? com.objectAt(old) : null;
        if (oo) com.release(oo);
      }
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
      let ch = false;
      for (let i = 0; i < bytes >>> 2 && (off >>> 2) + i < n.words.length; i++) { const x = mem.read32(src + 4 * i), k = (off >>> 2) + i; if (n.words[k] !== x) { n.words[k] = x; ch = true; } }
      this.wrote(n, ch);
    }

    // ---- techniques and passes
    GetPool(c) { if (c.arg(1)) mem.write32(c.arg(1), 0); return D3D_OK; }
    SetTechnique(c) { const t = this.tech(c.arg(1)); if (!t) return D3DERR_INVALIDCALL; this.technique = t; mem.write32(this.handleBlock + FX_SLOTS, t.passes.length); }
    GetCurrentTechnique() { return this.technique?.handle ?? 0; }
    ValidateTechnique(c) { return this.tech(c.arg(1)) ? D3D_OK : D3DERR_INVALIDCALL; }
    FindNextValidTechnique(c) { const t = c.arg(1) ? this.tech(c.arg(1)) : null; const i = t ? this.techniques.indexOf(t) + 1 : 0; const n = this.techniques[i]; if (c.arg(2)) mem.write32(c.arg(2), n ? n.handle : 0); return D3D_OK; }
    IsParameterUsed() { return 1; }
    GetDevice(c) { if (!c.arg(1)) return D3DERR_INVALIDCALL; mem.write32(c.arg(1), this.dev); com.addRef(com.objectAt(this.dev)); }
    OnLostDevice() {}
    OnResetDevice() {}
    // (with a state manager, the calls the JIT would queue go to JavaScript at once: +12 cleared, see runtime.js DEFER_OBJ)
    SetStateManager(c) { const m = c.arg(1); if (m && com.objectAt(m)) com.addRef(com.objectAt(m)); this.stateManager = m; mem.write32(c.arg(0) + 12, m ? 0 : this.handleBlock); if (m) vm.log('gfx', `d3dx effect: state manager set (guest object 0x${m.toString(16)})`); }
    GetStateManager(c) { if (c.arg(1)) mem.write32(c.arg(1), this.stateManager); }
    BeginParameterBlock() { this.recording = new Set(); }
    /**
     * A parameter block: per parameter recorded, its words (numbers) or object, and (ver) the version of its top-level
     * parameter when its words last equalled the block's — recorded, or applied since: any write changing a word of the
     * parameter moves that version (see touched), so while it has not moved the block's words are there already.
     */
    EndParameterBlock() {
      if (!this.recording) return 0;
      const id = this.handleBlock + 4 * (4000 + (this.nextBlock++ % 90));
      this.blocks.set(id, [...this.recording].map((n) => { let top = n; while (top.parent !== null) top = top.parent; return { n, top, words: n.words ? n.words.slice() : null, ptr: n.obj?.ptr, ver: top.version }; }));
      this.recording = null; return id;
    }
    ApplyParameterBlock(c) {
      const b = this.blocks.get(c.arg(1) >>> 0); if (!b) return D3DERR_INVALIDCALL;
      for (let k = 0; k < b.length; k++) {
        const e = b[k];
        if (e.words !== null && !apiOpt.fxRef) { // (a version move only for a real change, as the setters)
          if (e.top.version === e.ver) { if (this.recording) this.recording.add(e.n); continue; } // (the block's words there already)
          const w = e.n.words, x = e.words; let ch = false;
          for (let i = 0; i < x.length; i++) if (w[i] !== x[i]) { w[i] = x[i]; ch = true; }
          this.wrote(e.n, ch); e.ver = e.top.version;
          continue;
        }
        if (e.words !== null) e.n.words.set(e.words); else if (e.n.obj && isTextureType(e.n.type.type)) this.setTexture(e.n, e.ptr);
        this.touched(e.n);
      }
    }
    DeleteParameterBlock(c) { return this.blocks.delete(c.arg(1) >>> 0) ? D3D_OK : D3DERR_INVALIDCALL; }
    CloneEffect(c) { if (!c.arg(2)) return D3DERR_INVALIDCALL; const e = new Effect(c, c.arg(1) || this.dev, this.fx, this.flags); mem.write32(c.arg(2), createEffect(c, e)); com.addRef(com.objectAt(e.dev)); }

    Begin(c) {
      const t = this.technique; if (!t) return D3DERR_INVALIDCALL;
      if (c.arg(1)) mem.write32(c.arg(1), t.passes.length);
      const flags = c.arg(2);
      this.saved = (flags & 1) ? null : this.snapshot(c, t, flags);
      mem.write32(this.handleBlock + FX_SLOTS + 4, this.restoreList(c, t, this.saved !== null)); // (for a queued End: runtime.js DEFER_END)
      return D3D_OK;
    }
    BeginPass(c) { const ps = this.technique?.passes[c.arg(1)]; if (!ps) return D3DERR_INVALIDCALL; this.pass = ps; this.apply(c, ps, false); this.publishCommit(c, ps); if (globalThis.ORTHROS_FX_BURST && (vm.fxPasses = (vm.fxPasses ?? 0) + 1) === globalThis.ORTHROS_FX_BURST) vm.startApiBurst(c.thread, 3000); }
    CommitChanges(c) { if (this.pass) this.apply(c, this.pass, true); }
    EndPass() { this.pass = null; }
    End(c) { if (this.saved) this.restore(c, this.saved); this.saved = null; this.pass = null; mem.write32(this.handleBlock + FX_SLOTS + 4, 0); }
    destroy() {
      for (const p of this.allParams()) if (p.obj?.ptr && isTextureType(p.type.type) && com.objectAt(p.obj.ptr)) com.release(com.objectAt(p.obj.ptr));
      for (const sh of this.shaders.values()) if (sh.ptr && com.objectAt(sh.ptr)) com.release(com.objectAt(sh.ptr));
      if (com.objectAt(this.dev)) com.release(com.objectAt(this.dev));
      // (its process-heap blocks; every queued call on it ran before this Release: Vm.dispatchThunkBody drains first)
      const heap = this.proc.processHeap;
      for (const t of this.techniques) if (t.restoreList) { heap.free_(t.restoreList); t.restoreList = 0; t.restoreShadow = 0; }
      if (this.commitBlock) { heap.free_(this.commitBlock); this.commitBlock = 0; }
      if (this.noRestore) { heap.free_(this.noRestore); this.noRestore = 0; }
      if (this.handleBlock) { heap.free_(this.handleBlock); this.handleBlock = 0; }
    }
    *allParams() { const walk = function* (n) { yield n; for (const e of n.elements) yield* walk(e); for (const m of n.members) yield* walk(m); }; for (const p of this.params) yield* walk(p); }

    // ---- applying states
    /** the device (or the application's state manager) receiving a state call */
    /** device method `name` with `n` arguments x0..x2 (the state manager's instead when the application set one) */
    call(c, id, n, x0, x1, x2) {
      if (this.stateManager) {
        const vt = mem.read32(this.stateManager), fn = mem.read32(vt + 4 * SM[DEV_METHODS[id]]);
        return vm.callGuest(c.thread, fn, [this.stateManager, x0, x1, x2].slice(0, n + 1));
      }
      // (the device's own method, with a reused argument holder: no guest stack, no object per call)
      const dev = this.devImpl ??= com.implAt(this.dev);
      const fc = this.fastCtx ??= fastCtx(this.dev);
      fc.proc = c.proc; fc.thread = c.thread;
      const a = fc.a; a[1] = x0; a[2] = x1; a[3] = x2; // (a fixed-size holder: a method reads only its own arguments)
      let r;
      if (apiOpt.fxRef) r = dev?.[DEV_METHODS[id]]?.(fc, this.devObj ??= com.objectAt(this.dev));
      else { // (the method found once: no lookup by name per call)
        const fns = this.devFns ??= new Array(DEV_METHODS.length).fill(undefined);
        let fn = fns[id];
        if (fn === undefined) { const m = dev?.[DEV_METHODS[id]]; fn = fns[id] = typeof m === 'function' ? m : null; }
        if (fn !== null) r = fn.call(dev, fc, this.devObj ??= com.objectAt(this.dev));
      }
      return r === undefined ? D3D_OK : r;
    }
    /** the device when its own state setters receive the calls and no state block records them, else null */
    plainDev() {
      if (this.stateManager || apiOpt.off) return null;
      const d = this.devImpl ??= com.implAt(this.dev);
      return d && !d.recording ? d : null;
    }
    scratch(c, n) { return (c.proc.fxScratch ??= c.proc.processHeap.alloc(4096)) + n; }
    /**
     * Shader constants from values (Float32Array / Int32Array, 4 per register; bools: one per register): straight into
     * the device's constant arrays (only a real change moves its version), or through the state manager.
     */
    setConsts(c, vs, set, reg, count, vals, vo = 0) { // (vals from index vo)
      if (!this.stateManager) {
        const dev = this.devImpl ??= com.implAt(this.dev);
        if (!dev) return;
        let changed = false;
        if (set === RSET.FLOAT4) {
          const dst = vs ? dev.vsConst : dev.psConst, o = 4 * reg, n = Math.min(4 * count, dst.length - o);
          for (let i = 0; i < n; i++) { const v = vals[vo + i]; if (dst[o + i] !== v && !(dst[o + i] !== dst[o + i] && v !== v)) { dst[o + i] = v; changed = true; } }
          if (changed) dev.gfx?.constTouched?.(vs ? 0 : 1, o, o + n);
        } else if (set === RSET.INT4) {
          const dst = vs ? dev.vsConstI : dev.psConstI, o = 4 * reg, n = Math.min(4 * count, dst.length - o);
          for (let i = 0; i < n; i++) if (dst[o + i] !== vals[vo + i]) { dst[o + i] = vals[vo + i]; changed = true; }
          if (changed) dev.gfx?.constTouched?.(vs ? 2 : 3, o, o + n);
        } else {
          const dst = vs ? dev.vsConstB : dev.psConstB, n = Math.min(count, dst.length - reg);
          for (let i = 0; i < n; i++) { const b = vals[vo + 4 * i] ? 1 : 0; if (dst[reg + i] !== b) { dst[reg + i] = b; changed = true; } }
          if (changed) dev.gfx?.constTouched?.(vs ? 4 : 5, reg, reg + n);
        }
        if (changed) { dev.constVersion++; if (vs) dev.vsConstVersion++; else dev.psConstVersion++; }
        return;
      }
      const p = this.scratch(c, 0);
      if (set === RSET.FLOAT4) { for (let i = 0; i < 4 * count; i++) mem.writeF32(p + 4 * i, vals[vo + i]); this.call(c, vs ? M.SetVertexShaderConstantF : M.SetPixelShaderConstantF, 3, reg, p, count); }
      else if (set === RSET.INT4) { for (let i = 0; i < 4 * count; i++) mem.write32(p + 4 * i, vals[vo + i] >>> 0); this.call(c, vs ? M.SetVertexShaderConstantI : M.SetPixelShaderConstantI, 3, reg, p, count); }
      else { for (let i = 0; i < count; i++) mem.write32(p + 4 * i, vals[vo + 4 * i] ? 1 : 0); this.call(c, vs ? M.SetVertexShaderConstantB : M.SetPixelShaderConstantB, 3, reg, p, count); }
    }
    /** the shader object with this id (its bytecode in the effect's object table), created once */
    objectShader(id) {
      const key = `o${id}`;
      if (!this.shaders.has(key)) { const data = this.fx.objects.get(id); if (!data || data.length < 8) return null; this.shaders.set(key, shaderRecord(data)); }
      return this.shaderAt(key);
    }
    /** the shader of element `el` of shader parameter `pi` (a resource of its own, else the object its value names) */
    paramShader(pi, el) {
      // (found once: the resources and the object ids of shader parameters do not change after loading)
      const memo = this.paramShaders ??= new Map(), mk = pi * 65536 + el;
      let sh = memo.get(mk);
      if (sh !== undefined && !apiOpt.off) return sh;
      sh = this.shaderAt(`p${pi}:${el}`);
      if (!sh) { const n = this.params[pi], leaf = n?.elements.length ? n.elements[el] : n; sh = leaf?.obj?.id ? this.objectShader(leaf.obj.id) : null; }
      if (sh) memo.set(mk, sh);
      return sh;
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
        sh.ptr = r ? 0 : mem.read32(out); sh.impl = sh.ptr ? com.implAt(sh.ptr) : null;
        if (r) vm.log('gfx', `d3dx effect: ${sh.vs ? 'vertex' : 'pixel'} shader creation failed (0x${(r >>> 0).toString(16)})`);
        this.proc.processHeap.free_(out); this.proc.processHeap.free_(code);
        // constant-table bindings resolved once: parameter, register layout plan, sampler parameters
        sh.consts = []; sh.samplers = [];
        for (const e of sh.info.constants) {
          const n = this.lookup(e.name, null); if (!n) continue;
          if (e.set === RSET.SAMPLER) sh.samplers.push({ n, reg: (sh.vs ? 257 : 0) + e.reg, tbl: null, ver: -1 });
          else {
            let top = n; while (top.parent) top = top.parent;
            const vals = e.set === RSET.FLOAT4 ? new Float32Array(4 * e.count) : new Int32Array(4 * e.count);
            // (ver: the parameter version vals were filled at; dv: the version last compared with the device's registers
            // straight from the parameter (all-float plans); u: float registers; vi: vals' raw words)
            sh.consts.push({ e, top, ver: -1, dv: -1, set: e.set, reg: e.reg, count: e.count, plan: this.planOf(n, e.type, e.count, e.set), vals, u: e.set === RSET.FLOAT4, vi: new Int32Array(vals.buffer) });
          }
        }
        if (sh.info.preshader) sh.pre = this.programOf(sh.info.preshader);
      }
      return sh;
    }
    /** a preshader / expression with its input plans, its register files and a cache of its last outputs */
    programOf(prog) {
      const inputs = prog.inputs.map((e) => { const n = this.lookup(e.name, null); if (!n) return null; let top = n; while (top.parent) top = top.parent; return { e, n, top, plan: this.planOf(n, e.type, e.count, e.set) }; }).filter(Boolean);
      let maxReg = 0; for (const i of inputs) maxReg = Math.max(maxReg, i.e.reg + i.e.count);
      const regs = new Float64Array(4 * Math.max(1, maxReg));
      const out = new Float32Array(4 * 256);
      return { prog, inputs, regs, out, outW: new Int32Array(out.buffer), versions: null, runs: 0, run: compilePreshader(prog, regs.length) };
    }
    /** run a program if one of its inputs changed since its last run (outputs kept otherwise) */
    runProgram(P) {
      // (the version of the input's top-level parameter: a write to the whole parameter moves it, not its elements')
      let changed = !P.versions;
      if (!changed) for (let i = 0; i < P.inputs.length; i++) if (P.inputs[i].top.version !== P.versions[i]) { changed = true; break; }
      if (!changed) return P.out;
      const vs = P.versions ??= new Float64Array(P.inputs.length);
      for (let i = 0; i < P.inputs.length; i++) vs[i] = P.inputs[i].top.version;
      for (const i of P.inputs) this.fill(i.plan, P.regs, 4 * i.e.reg);
      P.run(P.regs, P.out);
      P.runs++;
      return P.out;
    }
    /** the shader of state k of a pass (its own bytecode, a referenced parameter's, or an array selector's pick) */
    stateShader(ps, k) {
      // how state k picks its shader, resolved once per pass (the effect's resources and parameters are fixed once loaded):
      // [0] its own bytecode (key), [1] a parameter (n, pi) maybe indexed by an array selector (ex), [2] an object id
      const sel = ps.shaderSel ??= [];
      let e = sel[k];
      if (e === undefined || apiOpt.off) {
        const key = `${ps.technique}:${ps.index}:${k}`;
        const ref = this.refs.get(key), ex0 = this.exprs.get(key), ex = ex0?.name ? ex0 : null; // (an array selector names its array)
        if (this.shaders.has(key)) e = [0, key];
        else if (ref || ex) { const n = this.lookup(ref ?? ex.name, null); e = n ? [1, n, this.params.indexOf(n), ex] : [1, null]; }
        else e = [2, ps.states[k].value];
        sel[k] = e;
      }
      if (e[0] === 0) return this.shaderAt(e[1]);
      if (e[0] === 1) {
        const n = e[1]; if (!n) return null;
        const ex = e[3], el = ex ? this.evalIndex(ex, n.elements.length || 1) : 0;
        return this.paramShader(e[2], el);
      }
      const v = e[1]; // (an object id of the table)
      return v instanceof Uint32Array && v[0] ? this.objectShader(v[0]) : null;
    }
    /**
     * stateShader for a pass state whose shader an expression picks in an array (the other kinds resolve once, see
     * compilePass): the array's shaders kept by element on the state's resolution (sel[k][4]), the expression evaluated.
     */
    pickShader(ps, k) {
      if (apiOpt.off) return this.stateShader(ps, k);
      const e = ps.shaderSel?.[k];
      if (e === undefined || e[0] !== 1 || e[1] === null || !e[3]) return this.stateShader(ps, k);
      const el = this.evalIndex(e[3], e[1].elements.length || 1), cands = e[4] ??= [];
      let sh = cands[el];
      if (sh === undefined) { sh = this.paramShader(e[2], el); if (sh !== null) cands[el] = sh; }
      return sh;
    }
    /** every shader state k of pass ps may pick: each element of the array an expression indexes, else its one shader */
    stateShaderCandidates(ps, k) {
      const one = this.stateShader(ps, k), e = ps.shaderSel[k];
      if (e[0] === 1 && e[1] && e[3]) { const out = []; for (let el = 0; el < Math.max(1, e[1].elements.length); el++) { const sh = this.paramShader(e[2], el); if (sh) out.push(sh); } return out; }
      return one ? [one] : [];
    }
    evalIndex(ex, count) { const out = this.runProgram(ex.P ??= this.programOf(ex.prog)); return Math.max(0, Math.min(count - 1, Math.round(out[0]))); }
    /**
     * The register layout of a parameter for a constant-table entry, as a plan: for each of the 4 * count register
     * components, the parameter word it takes (-1: zero) and how to read it (0 float, 1 int, 2 bool). Matrices by
     * columns or rows per the table's class, one register per vector / scalar, elements then members in order.
     */
    planOf(n, ctype, count, set) {
      const src = new Int32Array(4 * count).fill(-1), kind = new Uint8Array(4 * count), root = n.words;
      let reg = 0;
      const base = (el) => (root && el.words ? (el.words.byteOffset - root.byteOffset) >> 2 : 0);
      const put = (i, w, lt) => { src[i] = w; kind[i] = lt === PT.FLOAT ? 0 : lt === PT.BOOL ? 2 : 1; };
      const walk = (node, t) => {
        const els = t.elements > 1 && node.elements.length ? node.elements : [node];
        for (const el of els) {
          if (reg >= count) return;
          if (t.cls === PC.STRUCT) { t.members.forEach((m, k) => { const sub = el.members[k] ?? el.members.find((x) => x.name === m.name); if (sub) walk(sub, m.type); }); continue; }
          if (!el.words) { reg++; continue; }
          const lt = this.leafType(el), rows = Math.max(1, el.type.rows), cols = Math.max(1, el.type.cols), b = base(el);
          const at = (i, r, k) => { if (r < rows && k < cols) put(i, b + r * cols + k, lt); };
          if (set !== RSET.BOOL && set !== RSET.INT4 && t.cls === PC.MATRIX_COLUMNS) {
            for (let k = 0; k < t.cols && reg < count; k++, reg++) for (let r = 0; r < Math.min(4, t.rows); r++) at(4 * reg + r, r, k);
          } else if (t.cls === PC.MATRIX_ROWS) {
            for (let r = 0; r < t.rows && reg < count; r++, reg++) for (let k = 0; k < Math.min(4, t.cols); k++) at(4 * reg + k, r, k);
          } else if (set === RSET.BOOL) { at(4 * reg, 0, 0); reg++; }
          else { for (let k = 0; k < Math.min(4, t.rows * t.cols, el.words.length); k++) put(4 * reg + k, b + k, lt); reg++; }
        }
      };
      if (root) walk(n, ctype);
      // (allFloat: every component a float word or zero — compared with the registers as raw words, rootW, see
      // bindShader; a gather by src: matrices by columns take every third or fourth word, no runs to copy)
      let allFloat = true;
      for (let i = 0; i < src.length; i++) if (src[i] >= 0 && kind[i] !== 0) allFloat = false;
      return { root, rootW: root ? new Int32Array(root.buffer, root.byteOffset, root.length) : null, src, kind, allFloat };
    }
    // (fill for one output type each, the call sites monomorphic: fillF32, fillI32; fill itself for the preshaders' inputs)
    /** a plan with integer or bool components into float registers (`out` a Float32Array): as fill */
    fillF32(plan, out) {
      const root = plan.root, src = plan.src, kind = plan.kind;
      for (let i = 0; i < src.length; i++) {
        const w = src[i];
        if (w < 0) { out[i] = 0; continue; }
        const v = root[w], k = kind[i];
        out[i] = k === 0 ? bitsf(v) : k === 2 ? (v ? 1 : 0) : v | 0;
      }
    }
    /** a plan into integer or bool registers (`out` an Int32Array): as fill */
    fillI32(plan, out) {
      const root = plan.root, src = plan.src, kind = plan.kind;
      for (let i = 0; i < src.length; i++) {
        const w = src[i];
        if (w < 0) { out[i] = 0; continue; }
        const v = root[w], k = kind[i];
        out[i] = k === 0 ? bitsf(v) : k === 2 ? (v ? 1 : 0) : v | 0;
      }
    }
    /** values of a plan into `out` from offset `o` (numbers: float bits decoded, ints, bools as 0/1) */
    fill(plan, out, o = 0) {
      const { root, src, kind } = plan;
      for (let i = 0; i < src.length; i++) {
        const w = src[i];
        if (w < 0) { out[o + i] = 0; continue; }
        const v = root[w], k = kind[i];
        out[o + i] = k === 0 ? bitsf(v) : k === 2 ? (v ? 1 : 0) : v | 0;
      }
    }
    /**
     * A shader set for the pass, its constants (from the parameters, and its preshader's outputs) and samplers. A binding
     * is converted again only when its parameter changed (every write to a parameter or to any part of it moves the
     * version of its top-level parameter, see touched), and compared with the device's registers only when it changed
     * or when some constant of the device's stage (vertex / pixel) changed since this shader's last binding (its version).
     * Float registers are compared and written as raw words in one pass — bits kept, -0 against +0 or another NaN
     * payload a change (an upload more, never a value lost) — straight from the parameter's words when every component
     * is a float word or zero (no copy, no decoding; dv: the parameter version compared last).
     */
    bindShader(c, sh) {
      if (apiOpt.fxRef || this.stateManager) return this.bindShaderRef(c, sh);
      const dev = this.devImpl ??= com.implAt(this.dev);
      if (!dev) return;
      const vs = sh.vs, regs = vs ? dev.vsConst : dev.psConst;
      const same = sh.constVersion === (vs ? dev.vsConstVersion : dev.psConstVersion) && sh.constAll === false && sh.constRegs === regs;
      let ra = vs ? this.vsRegsRaw : this.psRegsRaw; // (the registers' raw words, as Int32Array: kept per register array)
      if (ra === undefined || ra.f !== regs) { ra = { f: regs, w: new Int32Array(regs.buffer, regs.byteOffset, regs.length) }; if (vs) this.vsRegsRaw = ra; else this.psRegsRaw = ra; }
      const raw = ra.w, consts = sh.consts;
      let wrote = false;
      for (let i = 0; i < consts.length; i++) {
        const b = consts[i], v = b.top.version;
        if (b.u && b.plan.allFloat) {
          if (b.dv === v && same) continue;
          this.setFloatPlan(dev, vs, raw, b.reg, b.count, b.plan);
          b.dv = v; wrote = true;
          continue;
        }
        if (b.ver !== v) { if (b.u) this.fillF32(b.plan, b.vals); else this.fillI32(b.plan, b.vals); b.ver = v; }
        else if (same) continue;
        if (b.u) this.setFloatWords(dev, vs, raw, b.reg, b.count, b.vi, 0);
        else this.setConsts(c, vs, b.set, b.reg, b.count, b.vals);
        wrote = true;
      }
      const smp = sh.samplers;
      for (let i = 0; i < smp.length; i++) this.bindShaderSampler(c, dev, smp[i]);
      const P = sh.pre;
      if (P) { // (after the constants, as always: its outputs win where they share registers)
        const runs = P.runs;
        this.runProgram(P);
        if (!same || wrote || runs !== P.runs || sh.preRuns !== runs) { const r = P.prog.outRanges; for (let k = 0; k < r.length; k++) this.setFloatWords(dev, vs, raw, r[k][0], r[k][1], P.outW, 4 * r[k][0]); }
        sh.preRuns = P.runs;
      }
      sh.constVersion = vs ? dev.vsConstVersion : dev.psConstVersion; sh.constAll = false; sh.constRegs = regs;
    }
    /** float constants (raw words `vals` from index vo, 4 per register) compared with and written into the registers' raw words `dst` */
    setFloatWords(dev, vs, dst, reg, count, vals, vo) {
      const o = 4 * reg, n = Math.min(4 * count, dst.length - o);
      if (n <= 0) return;
      let changed = false;
      for (let i = 0; i < n; i++) { const w = vals[vo + i]; if (dst[o + i] !== w) { dst[o + i] = w; changed = true; } }
      if (changed) { dev.gfx?.constTouched?.(vs ? 0 : 1, o, o + n); dev.constVersion++; if (vs) dev.vsConstVersion++; else dev.psConstVersion++; }
    }
    /** the float registers of an all-float plan compared with and written from the parameter's words (zeros where it has none) */
    setFloatPlan(dev, vs, dst, reg, count, plan) {
      const o = 4 * reg, n = Math.min(4 * count, dst.length - o);
      if (n <= 0) return;
      const root = plan.rootW, src = plan.src;
      let changed = false;
      for (let i = 0; i < n; i++) { const k = src[i], w = k < 0 ? 0 : root[k]; if (dst[o + i] !== w) { dst[o + i] = w; changed = true; } }
      if (changed) { dev.gfx?.constTouched?.(vs ? 0 : 1, o, o + n); dev.constVersion++; if (vs) dev.vsConstVersion++; else dev.psConstVersion++; }
    }
    /** bindShader as it was (dbg:ORTHROS_API_OPT_OFF=1: the reference; and with a state manager) */
    bindShaderRef(c, sh) {
      const vs = sh.vs;
      const dev = this.stateManager ? null : (this.devImpl ??= com.implAt(this.dev));
      const regs = dev ? (vs ? dev.vsConst : dev.psConst) : null;
      // (this stage's constants only; dbg:ORTHROS_API_OPT_OFF=1: any constant, as before — measurement)
      const all = apiOpt.off, ver = dev === null ? -1 : all ? dev.constVersion : vs ? dev.vsConstVersion : dev.psConstVersion;
      const same = dev !== null && sh.constVersion === ver && sh.constAll === all && sh.constRegs === regs;
      let wrote = false;
      for (const b of sh.consts) {
        const v = b.top.version;
        if (b.ver !== v) { this.fill(b.plan, b.vals); b.ver = v; }
        else if (same) continue;
        this.setConsts(c, vs, b.e.set, b.e.reg, b.e.count, b.vals); wrote = true;
      }
      for (const s of sh.samplers) this.bindSampler(c, s.n, s.reg);
      if (sh.pre) { // (after the constants, as always: its outputs win where they share registers)
        const runs = sh.pre.runs, out = this.runProgram(sh.pre);
        if (!same || wrote || runs !== sh.pre.runs || sh.preRuns !== runs) for (const [start, cnt] of sh.pre.prog.outRanges) this.setConsts(c, vs, RSET.FLOAT4, start, cnt, out, 4 * start);
        sh.preRuns = sh.pre.runs;
      }
      // (sent to a state manager instead: the device's registers may not hold them, compared again once it is removed)
      if (dev) { sh.constVersion = all ? dev.constVersion : vs ? dev.vsConstVersion : dev.psConstVersion; sh.constAll = all; sh.constRegs = regs; } else sh.constRegs = null;
    }
    /** a sampler parameter's states (and texture) applied to sampler register `reg`, compiled once per parameter */
    /** a sampler parameter's states compiled once: { tex } (its texture) or { type, word() } (a sampler state) */
    samplerOpsOf(n) {
      if (!n.samplerOps) {
        const states = n.samplerStates?.[0] ?? (n.parent?.samplerStates?.[n.parent.elements.indexOf(n)]) ?? [];
        const pi = this.params.indexOf(n.parent ?? n), el = n.parent ? n.parent.elements.indexOf(n) : 0;
        n.samplerOps = states.map((s, k) => {
          const [cls, idx] = STATES[s.op] ?? [];
          const key = `p${pi}:${el}:${k}`;
          if (cls === 'texture') { const tn = this.refs.has(key) ? this.lookup(this.refs.get(key), null) : null; return { tex: tn }; }
          if (cls === 'samp') return { type: idx, word: this.wordOf(s, key), cst: !this.refs.has(key) && !this.exprs.has(key) };
          return null;
        }).filter(Boolean);
        n.samplerConst = n.samplerOps.every((o) => o.tex !== undefined || o.cst); // (its states constants: see bindSampler)
        n.samplerTexOps = n.samplerOps.filter((o) => o.tex !== undefined);
      }
      return n.samplerOps;
    }
    /**
     * bindSampler for sampler binding `s` of a shader ({ n, reg }), the device's own setters receiving the calls: the
     * register's state table it last applied its constant states to (and that table's version) kept on the binding.
     */
    bindShaderSampler(c, dev, s) {
      const n = s.n, reg = s.reg, ops = n.samplerOps ?? this.samplerOpsOf(n);
      const tbl = n.samplerConst && !dev.recording && dev.samplers !== undefined ? dev.samplers[reg] : undefined;
      if (tbl !== undefined && s.tbl === tbl && s.ver === tbl.ver) { // (only its texture may differ: the state operations not walked)
        const t = n.samplerTexOps;
        for (let i = 0; i < t.length; i++) { const p = t[i].tex?.obj?.ptr ?? 0; if (dev.textures[reg] !== p) this.call(c, M.SetTexture, 2, reg, p); }
        return;
      }
      for (let i = 0; i < ops.length; i++) {
        const o = ops[i];
        if (o.tex !== undefined) { const p = o.tex?.obj?.ptr ?? 0; if (dev.textures[reg] !== p) this.call(c, M.SetTexture, 2, reg, p); }
        else { const v = o.word() >>> 0; if ((dev.samplers?.[reg]?.get(o.type) ?? -1) !== v) this.call(c, M.SetSamplerState, 3, reg, o.type, v); }
      }
      if (tbl !== undefined) { s.tbl = tbl; s.ver = tbl.ver; }
    }
    bindSampler(c, n, reg) {
      // (a state the device already holds is not set again: sampler states are re-applied at every pass)
      const dev = this.stateManager ? null : (this.devImpl ??= com.implAt(this.dev));
      const ops = this.samplerOpsOf(n);
      // constant states already applied to this register, its state table untouched since (its version): not compared again
      const tbl = dev !== null && n.samplerConst && !dev.recording && !apiOpt.off ? dev.samplers?.[reg] : undefined;
      const seen = tbl !== undefined ? n.samplerSeen?.[reg] : undefined;
      const skip = seen !== undefined && seen.tbl === tbl && seen.ver === tbl.ver;
      if (skip) { // (only its texture may differ: the state operations not walked)
        const t = n.samplerTexOps;
        for (let i = 0; i < t.length; i++) { const p = t[i].tex?.obj?.ptr ?? 0; if (dev.textures[reg] !== p) this.call(c, M.SetTexture, 2, reg, p); }
        return;
      }
      for (const o of ops) {
        if (o.tex !== undefined) { const p = o.tex?.obj?.ptr ?? 0; if (!dev || dev.textures[reg] !== p) this.call(c, M.SetTexture, 2, reg, p); }
        else if (!skip) { const v = o.word() >>> 0; if (!dev || (dev.samplers?.[reg]?.get(o.type) ?? -1) !== v) this.call(c, M.SetSamplerState, 3, reg, o.type, v); }
      }
      if (tbl !== undefined && !skip) { const sv = (n.samplerSeen ??= [])[reg] ??= { tbl: null, ver: -1 }; sv.tbl = tbl; sv.ver = tbl.ver; }
    }
    /** a function giving a numeric state's raw value (a referenced parameter's first scalar, an expression, or its constant) */
    wordOf(s, key) {
      const ref = this.refs.get(key);
      if (ref) { const n = this.lookup(ref, null); if (n?.words) { const w = n.words; return () => w[0]; } }
      const ex = this.exprs.get(key);
      if (ex) { const P = this.programOf(ex.prog), t = s.type.type; return () => numToWord(t, this.runProgram(P)[0]); }
      const v = s.value instanceof Uint32Array ? s.value[0] ?? 0 : 0;
      return () => v;
    }
    /**
     * A pass compiled once into state operations ({ f(c, d), dyn: depends on parameters, touches }), with their functions
     * listed for BeginPass (all) and CommitChanges (the dynamic ones). `d` (apply): the device when its own setters
     * receive the calls and no state block records them (plainDev), else null — found once per pass applied.
     */
    opsOf(ps) {
      if (ps.ops === null) {
        const ops = this.compilePass(ps);
        ps.allFns = ops.map((o) => o.f); ps.dynFns = ops.filter((o) => o.dyn).map((o) => o.f);
        ps.ops = ops;
      }
      return ps.ops;
    }
    compilePass(ps) {
      const ops = [];
      ps.states.forEach((s, k) => {
        const [cls, idx] = STATES[s.op] ?? [];
        const key = `${ps.technique}:${ps.index}:${k}`;
        const dyn = this.refs.has(key) || this.exprs.has(key);
        const word = this.wordOf(s, key);
        let f = null, touches = null; // (touches: the shadowed device states the operation sets, see commitEntries)
        switch (cls) {
          // (a state the device already holds is left alone, as its handler would: no call at all — a pass sets its
          // states at every BeginPass)
          // (a constant value — no parameter, no expression — taken once)
          case 'rs': {
            const v0 = dyn ? 0 : word() >>> 0;
            f = dyn ? (c, d) => { const v = word() >>> 0; if (d === null || d.rs.get(idx) !== v) this.call(c, M.SetRenderState, 2, idx, v, 0); }
              : (c, d) => { if (d === null || d.rs.get(idx) !== v0) this.call(c, M.SetRenderState, 2, idx, v0, 0); };
            touches = { rs: idx }; break;
          }
          case 'tss': {
            const st = s.index, v0 = dyn ? 0 : word() >>> 0;
            f = dyn ? (c, d) => { const v = word() >>> 0; if (d === null || d.tss[st]?.get(idx) !== v) this.call(c, M.SetTextureStageState, 3, st, idx, v); }
              : (c, d) => { if (d === null || d.tss[st]?.get(idx) !== v0) this.call(c, M.SetTextureStageState, 3, st, idx, v0); };
            touches = { tss: [st, idx] }; break;
          }
          case 'samp': {
            const r = s.index, v0 = dyn ? 0 : word() >>> 0;
            f = dyn ? (c, d) => { const v = word() >>> 0; if (d === null || r >= 16 || d.samplers?.[r]?.get(idx) !== v) this.call(c, M.SetSamplerState, 3, r, idx, v); }
              : (c, d) => { if (d === null || r >= 16 || d.samplers?.[r]?.get(idx) !== v0) this.call(c, M.SetSamplerState, 3, r, idx, v0); };
            touches = { samp: [r, idx] }; break;
          }
          case 'fvf': f = (c) => this.call(c, M.SetFVF, 1, word()); break;
          case 'npatch': f = (c) => this.call(c, M.SetNPatchMode, 1, word()); break;
          case 'lightenable': f = (c) => this.call(c, M.LightEnable, 2, s.index, word()); break;
          case 'vs': case 'ps': {
            const vsState = cls === 'vs', setId = vsState ? M.SetVertexShader : M.SetPixelShader, fixed = this.exprs.has(key) ? null : this.stateShader(ps, k);
            touches = fixed ? { shader: fixed } : { shaderState: k }; // (picked by an expression: one of its array's, see commitEntries)
            f = (c, d) => {
              const sh = fixed ?? this.pickShader(ps, k);
              if (sh === null || !sh.ptr) this.noShader(key, cls, ps, k);
              // (the shader the device already has: no call, its handler would change nothing — the device's shader
              // object compared with the one created for this record, sh.impl)
              if (d === null || (vsState ? d.vsObj : d.psObj) !== (sh === null ? null : sh.impl)) this.call(c, setId, 1, sh === null ? 0 : sh.ptr, 0, 0);
              if (sh !== null) this.bindShader(c, sh);
            };
            break;
          }
          case 'texture': { const ref = this.refs.get(key); const tn = ref ? this.lookup(ref, null) : null; f = (c) => this.call(c, M.SetTexture, 2, s.index, tn?.obj?.ptr ?? 0); touches = { tex: s.index }; break; }
          case 'sampler': { const ref = this.refs.get(key); const sn = ref ? this.lookup(ref, null) : null; if (sn) { f = (c) => this.bindSampler(c, sn, s.index); touches = { sampler: [sn, s.index] }; } break; }
          case 'transform': { const ref = this.refs.get(key); const tn = ref ? this.lookup(ref, null) : null; f = (c) => { const src = tn ? tn.words : s.value; if (!src) return; const p = this.scratch(c, 2048); for (let i = 0; i < 16; i++) mem.write32(p + 4 * i, src[i] ?? (i % 5 === 0 ? 0x3f800000 : 0)); this.call(c, M.SetTransform, 2, idx + (idx === 256 || idx === 16 ? s.index : 0), p); }; break; }
          case 'const': {
            const ref = this.refs.get(key); const tn = ref ? this.lookup(ref, null) : null;
            const vs = idx.startsWith('vs'), set = idx.includes('b') ? RSET.BOOL : idx.includes('i') ? RSET.INT4 : RSET.FLOAT4;
            f = (c) => {
              const src = tn ? tn.words : s.value; if (!src) return;
              const n = Math.max(1, Math.ceil(src.length / 4)), vals = set === RSET.FLOAT4 ? new Float32Array(4 * n) : new Int32Array(4 * n);
              for (let i = 0; i < src.length; i++) vals[set === RSET.BOOL ? 4 * i : i] = set === RSET.FLOAT4 ? bitsf(src[i]) : src[i] | 0;
              this.setConsts(c, vs, set, s.index, set === RSET.BOOL ? src.length : n, vals);
            };
            break;
          }
          case 'material': case 'light': break; // (fixed-function lights/materials from effects: not used by shader effects)
          default: if ((this.unknownOps ??= new Set()).size < 16 && !this.unknownOps.has(s.op)) { this.unknownOps.add(s.op); vm.log('gfx', `d3dx effect: state operation 0x${s.op.toString(16)} not applied`); }
        }
        if (f) ops.push({ f, dyn: dyn || cls === 'vs' || cls === 'ps' || cls === 'sampler' || cls === 'texture', touches });
      });
      return ops;
    }
    /** a pass state with no shader to set (its log line, once per state) */
    noShader(key, cls, ps, k) {
      if ((this.missing ??= new Set()).size < 32 && !this.missing.has(key)) { this.missing.add(key); vm.log('gfx', `d3dx effect: no ${cls} for technique ${this.techniques[ps.technique]?.name} pass ${ps.index} state ${k}`); }
    }
    /**
     * The device states CommitChanges may set for pass `ps`, for the JIT's issued-state filter (runtime.js COMMIT_LIST):
     * the shadow entries of the render / stage / sampler states its dynamic operations set — a queued CommitChanges
     * forgets them instead of switching the whole filter off until the queue has run. null: any (a shader picked by an
     * expression, an effect without a device shadow).
     */
    commitEntries(ps) {
      if (ps.commitEntries !== undefined) return ps.commitEntries;
      const out = new Set();
      const rs = (i) => { if (i >= 0 && i < 256) out.add(SHADOW_RS + i); };
      const tss = (st, t) => { if (st >= 0 && st < 8 && t >= 0 && t < 40) out.add(SHADOW_TSS + 40 * st + t); };
      const samp = (r, t) => { if (r >= 0 && r < 16 && t >= 0 && t < 16) out.add(SHADOW_SAMP + 16 * r + t); };
      const tex = (st) => { if (st >= 0 && st < 16) out.add(SHADOW_TEX + st); }; // (a texture bound: runtime.js DEFER_F_TEX)
      const sampler = (n, reg) => { for (const o of this.samplerOpsOf(n)) if (o.tex === undefined) samp(reg, o.type); else tex(reg); };
      let any = false;
      for (const o of this.opsOf(ps)) {
        if (!o.dyn) continue;
        const t = o.touches;
        if (!t) continue;
        if (t.any) { any = true; break; }
        if (t.rs !== undefined) rs(t.rs);
        else if (t.tss) tss(t.tss[0], t.tss[1]);
        else if (t.samp) samp(t.samp[0], t.samp[1]);
        else if (t.sampler) sampler(t.sampler[0], t.sampler[1]);
        else if (t.tex !== undefined) tex(t.tex);
        else if (t.shader) for (const x of t.shader.samplers ?? []) sampler(x.n, x.reg);
        else if (t.shaderState !== undefined) { for (const sh of this.stateShaderCandidates(ps, t.shaderState)) for (const x of sh.samplers ?? []) sampler(x.n, x.reg); }
      }
      return (ps.commitEntries = any ? null : Uint32Array.from(out));
    }
    /** the commit list of the pass now begun, where the effect's guest object points at +20 (runtime.js COMMIT_LIST) */
    publishCommit(c, ps) {
      const self = this.comObject?.ptr; if (!self) return;
      const dev = this.devImpl ??= com.implAt(this.dev);
      const list = this.commitBlock ||= c.proc.processHeap.alloc(4 * COMMIT_LIST_WORDS);
      const shadow = dev?.shadow ?? 0;
      // (the block holds this pass's list already — the same pass begun again on the same device shadow: nothing to
      // write; only this function writes the block)
      if (this.commitPublished === ps && this.commitShadow === shadow && !apiOpt.off) { mem.write32(self + COMMIT_LIST, list); return; }
      this.commitPublished = ps; this.commitShadow = shadow;
      const e = shadow ? this.commitEntries(ps) : null;
      mem.write32(list, shadow);
      if (!e || e.length > COMMIT_LIST_WORDS - 2) mem.write32(list + 4, 0xffffffff);
      else { mem.write32(list + 4, e.length); for (let i = 0; i < e.length; i++) mem.write32(list + 8 + 4 * i, e[i]); }
      mem.write32(self + COMMIT_LIST, list);
    }
    apply(c, ps, commit) {
      vm.effectCtx = c;
      if (ps.ops === null) this.opsOf(ps);
      const fns = commit ? ps.dynFns : ps.allFns; // (CommitChanges: what depends on parameters)
      const d = this.plainDev(); // (no operation starts or ends a state block, nor sets a state manager: one answer for all)
      for (let i = 0; i < fns.length; i++) fns[i](c, d);
    }
    /**
     * The device states a technique touches, as they are now (restored at End): the states are listed once per
     * technique (render states, stage states as stage * 256 + type, texture stages), their values kept in an array
     * reused at every Begin (Begin / End pairs of one effect do not nest).
     */
    snapshot(c, t, flags) {
      const dev = this.devImpl ??= com.implAt(this.dev); if (!dev) return null;
      let s = t.touched;
      if (!s) {
        const rs = new Set(), tss = new Set(), tex = new Set();
        for (const ps of t.passes) for (const st of ps.states) {
          const [cls, idx] = STATES[st.op] ?? [];
          if (cls === 'rs') rs.add(idx); else if (cls === 'tss') tss.add(st.index * 256 + idx); else if (cls === 'texture') tex.add(st.index);
        }
        s = t.touched = { rs: Int32Array.from(rs), tss: Int32Array.from(tss), tex: Int32Array.from(tex), vals: new Uint32Array(rs.size + tss.size + tex.size), vs: undefined, ps: undefined };
      }
      let k = 0;
      for (let i = 0; i < s.rs.length; i++) s.vals[k++] = dev.rs.get(s.rs[i]) ?? 0;
      for (let i = 0; i < s.tss.length; i++) { const x = s.tss[i]; s.vals[k++] = dev.tss[x >> 8]?.get(x & 255) ?? 0; }
      for (let i = 0; i < s.tex.length; i++) s.vals[k++] = dev.textures[s.tex[i]] ?? 0;
      s.vs = (flags & 2) ? undefined : dev.vsObj?.comObject?.ptr ?? 0; s.ps = (flags & 2) ? undefined : dev.psObj?.comObject?.ptr ?? 0;
      return s;
    }
    /**
     * The restore list of a Begin (runtime.js DEFER_END): the shadow entries its End sets, each with the value it saved —
     * a queued End gives them these values (the issued state); textures are marked to be forgotten instead (bit 31: a
     * texture released meanwhile is not bound again). Entries once per technique and device shadow, values at every
     * Begin; `saving` false (nothing saved): no entries. 0 when the device keeps no shadow.
     */
    restoreList(c, t, saving) {
      const dev = this.devImpl ??= com.implAt(this.dev), shadow = dev?.shadow ?? 0;
      if (!shadow) return 0;
      if (!saving) return this.emptyList(c, shadow);
      const s = t.touched;
      if (t.restoreList === 0 || t.restoreShadow !== shadow) {
        const e = [], k = []; // (entry, index of its saved value: s.vals holds render states, stage states, textures in that order)
        let j = 0;
        for (let i = 0; i < s.rs.length; i++, j++) if (s.rs[i] >= 0 && s.rs[i] < 256) { e.push(SHADOW_RS + s.rs[i]); k.push(j); }
        for (let i = 0; i < s.tss.length; i++, j++) { const st = s.tss[i] >> 8, ty = s.tss[i] & 255; if (st >= 0 && st < 8 && ty < 40) { e.push(SHADOW_TSS + 40 * st + ty); k.push(j); } }
        for (let i = 0; i < s.tex.length; i++, j++) if (s.tex[i] >= 0 && s.tex[i] < 16) { e.push((SHADOW_TEX + s.tex[i]) | 0x80000000); k.push(j); }
        const list = t.restoreList || (t.restoreList = c.proc.processHeap.alloc(8 + 8 * e.length));
        mem.write32(list, shadow); mem.write32(list + 4, e.length);
        for (let i = 0; i < e.length; i++) mem.write32(list + 8 + 8 * i, e[i] >>> 0);
        t.restoreShadow = shadow; t.restoreVals = Int32Array.from(k);
      }
      const list = t.restoreList, map = t.restoreVals;
      for (let i = 0; i < map.length; i++) mem.write32(list + 12 + 8 * i, s.vals[map[i]]);
      return list;
    }
    /** a list of no entries (Begin without saving states: nothing to restore at End) */
    emptyList(c, shadow) {
      const list = this.noRestore ||= c.proc.processHeap.alloc(8);
      mem.write32(list, shadow); mem.write32(list + 4, 0);
      return list;
    }
    restore(c, s) {
      let k = 0;
      const d = this.plainDev(); // (a state the device already holds: no call, as its handler would do nothing)
      for (let i = 0; i < s.rs.length; i++) { const v = s.vals[k++]; if (d === null || d.rs.get(s.rs[i]) !== v) this.call(c, M.SetRenderState, 2, s.rs[i], v); }
      for (let i = 0; i < s.tss.length; i++) { const x = s.tss[i], v = s.vals[k++]; if (d === null || d.tss[x >> 8]?.get(x & 255) !== v) this.call(c, M.SetTextureStageState, 3, x >> 8, x & 255, v); }
      for (let i = 0; i < s.tex.length; i++) this.call(c, M.SetTexture, 2, s.tex[i], s.vals[k++]);
      if (s.vs !== undefined) this.call(c, M.SetVertexShader, 1, s.vs);
      if (s.ps !== undefined) this.call(c, M.SetPixelShader, 1, s.ps);
    }
  }
  for (const C of [Effect]) snapClass(vm, C, { name: `d3dx9-effect.${C.name}` }); // (snapshots: core/vm-snapshot.js)

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
    if (pEffect) mem.write32(pEffect, createEffect(c, fx));
    vm.log('gfx', `d3dx: effect loaded: ${parsed.params.length} parameters, techniques ${parsed.techniques.map((t) => t.name).join(', ')}`);
    if (globalThis.ORTHROS_FX_DESCRIBE) vm.log('gfx', `d3dx: effect ${(vm.fxCount = (vm.fxCount ?? 0) + 1)}:\n${describeEffect(parsed)}`); // (debugging: --dbg ORTHROS_FX_DESCRIBE=1)
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

/** the scalar type of a parameter type's first scalar (a struct's: its first member's, recursively) */
function leafTypeOf(t) { while (t.cls === PC.STRUCT && t.members.length) t = t.members[0]; return t.type; }

/** a NUL-terminated string at the start of `bytes` */
function cstrOf(bytes) { let s = ''; for (const b of bytes) { if (!b) break; s += String.fromCharCode(b); } return s; }
export { S_FALSE };

/** An argument holder for device methods called by the effect runtime (arg(i), sarg(i), argF32(i), out32...). */
function fastCtx(self) {
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  return {
    a: [self, 0, 0, 0], proc: null, thread: null, retAddr: 0,
    arg(i) { return (this.a[i] ?? 0) >>> 0; },
    sarg(i) { return (this.a[i] ?? 0) | 0; },
    argF32(i) { u32[0] = this.a[i] ?? 0; return f32[0]; },
    setLastError() {}, fail() { return 0; },
  };
}
