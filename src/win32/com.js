// COM plumbing: interfaces are vtables of API thunks living in guest memory; objects are small
// guest blocks [vtable, marker, id] whose methods dispatch to JS implementations. Unimplemented
// methods are traced (once per method) and return E_NOTIMPL so the caller keeps going.
import { E } from './errors.js';
import { COM_MARKER, COM_REFS } from '../cpu/jit/runtime.js';
/** 'comx' log kind: the COM trace without the per-draw state setters, draws, buffer locks and reference counting */
const COM_SITE_MAX = 20; // 'comx': calls logged per (method, call site)
const COM_QUIET = /^(Set(RenderState|TextureStageState|SamplerState|Texture|Transform|StreamSource|Indices|FVF|VertexShader|PixelShader|VertexDeclaration|Material|Light|VertexShaderConstantF|PixelShaderConstantF|Viewport|SoftwareVertexProcessing|ClipPlane|ScissorRect)|LightEnable|Draw\w*|Get(Transform|RenderState|TextureStageState|Desc|LevelDesc|LevelCount|DeviceCaps|DisplayMode|Direct3D|Type|CurrentPosition|Status|DeviceData|DeviceState)|AddRef|Release|QueryInterface|Lock|Unlock|TestCooperativeLevel|BeginScene|EndScene|Present|Clear)$/;

export const S_OK = 0, S_FALSE = 1, E_NOTIMPL = 0x80004001, E_NOINTERFACE = 0x80004002, E_POINTER = 0x80004003, E_FAIL = 0x80004005, E_INVALIDARG = 0x80070057, E_OUTOFMEMORY = 0x8007000e, CLASS_E_NOAGGREGATION = 0x80040110, REGDB_E_CLASSNOTREG = 0x80040154;
export const IID_IUnknown = '00000000-0000-0000-c000-000000000046';
const MARKER = COM_MARKER; // '!COM'

/**
 * GUID in guest memory -> canonical lowercase string. The strings of the GUIDs met are kept by their four words (a
 * QueryInterface asks for the same few IIDs again and again: no string built per call); GUIDs past GUID_CACHE_MAX
 * distinct ones are formatted each time.
 */
export function readGuid(mem, a) {
  const u8 = mem.u8, p = a >>> 0;
  if (!u8 || p + 16 > u8.length) return formatGuid(mem, a);
  const w0 = (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) | 0, w1 = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) | 0;
  const w2 = (u8[p + 8] | (u8[p + 9] << 8) | (u8[p + 10] << 16) | (u8[p + 11] << 24)) | 0, w3 = (u8[p + 12] | (u8[p + 13] << 8) | (u8[p + 14] << 16) | (u8[p + 15] << 24)) | 0;
  let list = GUID_CACHE.get(w0);
  if (list !== undefined) for (let i = 0; i < list.length; i += 4) if (list[i] === w1 && list[i + 1] === w2 && list[i + 2] === w3) return list[i + 3];
  const s = formatGuid(mem, a);
  if (guidCached < GUID_CACHE_MAX) { if (list === undefined) GUID_CACHE.set(w0, (list = [])); list.push(w1, w2, w3, s); guidCached++; }
  return s;
}
const GUID_CACHE = new Map(), GUID_CACHE_MAX = 4096;
let guidCached = 0;
function formatGuid(mem, a) {
  const h = (v, n) => v.toString(16).padStart(n, '0');
  const b = mem.bytes(a, 16);
  return `${h(mem.read32(a), 8)}-${h(mem.read16(a + 4), 4)}-${h(mem.read16(a + 6), 4)}-${h(b[8], 2)}${h(b[9], 2)}-${Array.from(b.subarray(10, 16), (x) => h(x, 2)).join('')}`;
}
export function writeGuid(mem, a, s) {
  const p = s.toLowerCase().split('-');
  mem.write32(a, parseInt(p[0], 16)); mem.write16(a + 4, parseInt(p[1], 16)); mem.write16(a + 6, parseInt(p[2], 16));
  const tail = p[3] + p[4];
  for (let i = 0; i < 8; i++) mem.write8(a + 8 + i, parseInt(tail.slice(2 * i, 2 * i + 2), 16));
}

/**
 * The JavaScript side of a guest COM object. One class (one shape, the reference count's accessors on the prototype):
 * an object literal with its own getter / setter closures gave every object a map of its own, and the Direct3D
 * setters' AddRef / Release of the textures and buffers they bind went through megamorphic property accesses.
 */
class ComObject {
  constructor(mem, ptr, iface, impl, id, proc) {
    this.mem = mem; this.ptr = ptr; this.iface = iface; this.impl = impl; this.id = id; this.proc = proc;
    /** @type {any[]|null} methods resolved by index (Com.dispatch) */
    this.fns = null;
    /** impl.iids as lowercase IIDs (Com.supports), and the array they were made from */
    this.iidsNorm = undefined; this.iidsOf = undefined;
  }
  /** the reference count, in guest memory (the JIT's AddRef / Release fast path updates it there) */
  get refs() { return this.mem.read32(this.ptr + COM_REFS) | 0; }
  set refs(v) { this.mem.write32(this.ptr + COM_REFS, v >>> 0); }
}

export class Com {
  /** @param {import('../core/vm.js').Vm} vm */
  constructor(vm) {
    this.failedOnce = new Set(); // interface::method=hresult already reported
    this.comSites = new Map(); // 'comx' trace: calls logged per method@site
    this.vm = vm;
    this.mem = vm.mem;
    this.api = vm.api;
    /** @type {Map<string, Interface>} name -> interface */
    this.interfaces = new Map();
    /** @type {Map<string, Interface>} iid -> interface */
    this.byIid = new Map();
    /** @type {Map<number, ComObject>} guest pointer -> object */
    this.objects = new Map();
    /** @type {Map<string, (ctx, iid) => number|null>} clsid -> factory returning an object pointer */
    this.classes = new Map();
    this.nextId = 1;
    this.tracedMissing = new Set();
    this.interface('IUnknown', IID_IUnknown, null, [['QueryInterface', 2], ['AddRef', 0], ['Release', 0]]);
  }

  /**
   * Declare an interface. `methods`: [name, argc] in vtable order (after the parent's methods).
   * @returns {Interface}
   */
  interface(name, iid, parent, methods) {
    const p = parent ? this.interfaces.get(parent) : null;
    const all = [...(p ? p.methods : []), ...methods.map(([n, argc]) => ({ name: n, argc }))];
    const iface = { name, iid: iid?.toLowerCase() ?? null, parent: p, methods: all, vtable: 0 };
    this.interfaces.set(name, iface);
    if (iface.iid) this.byIid.set(iface.iid, iface);
    return iface;
  }

  /** Register a CoCreateInstance class. factory(ctx, iid) -> guest object pointer (or null to fail). */
  registerClass(clsid, factory) { this.classes.set(clsid.toLowerCase(), factory); }
  /** 'comx' trace: true once method@site has been logged COM_SITE_MAX times */
  comSiteSeen(name, site) { const k = `${name}@${site}`, n = this.comSites.get(k) ?? 0; this.comSites.set(k, n + 1); return n >= COM_SITE_MAX; }

  /** Allocate the vtable of an interface once: one API thunk per method. */
  vtableOf(proc, iface) {
    if (iface.vtable) return iface.vtable;
    const n = iface.methods.length;
    const vt = proc.processHeap.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const m = iface.methods[i];
      const fname = `${iface.name}::${m.name}`;
      if (!this.api.lookup('com', fname)) {
        this.api.define('com', { [fname]: [m.argc + 1, (c) => this.dispatch(c, iface, i), { com: { iface, index: i } }] });
      }
      this.mem.write32(vt + 4 * i, this.api.thunkFor('com', fname));
    }
    iface.vtable = vt;
    return vt;
  }

  /**
   * Create a guest object exposing `iface` (an Interface or its name), implemented by `impl`.
   * `impl` may list extra interface names it answers to in `impl.iids` (array of IIDs or names).
   * @returns {number} guest pointer (refcount 1)
   */
  create(proc, iface, impl, extra = 0) {
    if (typeof iface === 'string') iface = this.interfaces.get(iface);
    // [vtable, marker, id, a word for the object's fast paths (runtime.js: effect handle block, device state shadow,
    // surface description), reference count, an effect's commit list] — the count in guest memory: AddRef/Release run
    // on the JIT's fast path (runtime.js FID_ADDREF); `extra` bytes after them for the implementation (freed with it)
    const ptr = proc.processHeap.alloc(24 + extra);
    this.mem.write32(ptr, this.vtableOf(proc, iface));
    this.mem.write32(ptr + 4, MARKER);
    this.mem.write32(ptr + 8, this.nextId);
    this.mem.write32(ptr + 12, 0);
    this.mem.write32(ptr + COM_REFS, 1);
    this.mem.write32(ptr + 20, 0); // (runtime.js COMMIT_LIST: an effect's)
    const obj = new ComObject(this.mem, ptr, iface, impl, this.nextId++, proc);
    this.objects.set(ptr, obj);
    impl.comObject = obj;
    return ptr;
  }

  /** JS object behind a guest interface pointer (null if unknown). */
  objectAt(ptr) { return this.objects.get(ptr >>> 0) ?? null; }
  implAt(ptr) { return this.objects.get(ptr >>> 0)?.impl ?? null; }

  addRef(obj) { return ++obj.refs; }
  release(obj) {
    if (--obj.refs > 0) return obj.refs;
    // (an object another one owns — a device's back buffers, a texture's levels — stays valid at the same address
    // without references while its owner lives, as Direct3D's do: software keeps such pointers after Release)
    if (obj.impl.keepAlive) { obj.refs = 0; return 0; }
    this.dispose(obj);
    return 0;
  }
  /** The owner of a kept-alive object is gone: the object is destroyed now if nothing references it. */
  unpin(impl) {
    const obj = impl?.comObject;
    if (obj && this.objects.get(obj.ptr) === obj && obj.refs <= 0) this.dispose(obj);
  }
  dispose(obj) {
    this.objects.delete(obj.ptr);
    this.mem.write32(obj.ptr + 4, 0); // (no longer an object for the fast paths)
    // (debugging, ?dbg=ORTHROS_RELEASE_WATCH=1: the guest memory of a released object is reused only 4096 releases later —
    // a call through a pointer kept after the release then reaches no object, reported, instead of the next object)
    try { obj.impl.destroy?.(obj); } finally {
      if (globalThis.ORTHROS_RELEASE_WATCH) { (this.quarantine ??= []).push(obj); if (this.quarantine.length > 4096) { const o = this.quarantine.shift(); o.proc.processHeap.free_(o.ptr); } }
      else obj.proc.processHeap.free_(obj.ptr);
    }
    return 0;
  }

  /** Does `obj` implement the interface with this IID? (its own chain, plus impl.iids) */
  supports(obj, iid) {
    if (iid === IID_IUnknown) return true;
    for (let i = obj.iface; i; i = i.parent) if (i.iid === iid) return true;
    const iids = obj.impl.iids;
    if (!iids) return false;
    // impl.iids normalized once per array (the implementations assign a new array when it changes)
    let norm = obj.iidsNorm;
    if (norm === undefined || obj.iidsOf !== iids || norm.length !== iids.length) { norm = obj.iidsNorm = iids.map((x) => (x.includes('-') ? x.toLowerCase() : this.interfaces.get(x)?.iid)); obj.iidsOf = iids; }
    for (let k = 0; k < norm.length; k++) if (norm[k] === iid) return true;
    return false;
  }

  dispatch(ctx, iface, index) {
    const m = iface.methods[index];
    const self = ctx.arg(0);
    const obj = this.objects.get(self);
    if (!obj) { const dead = this.quarantine?.find((o) => o.ptr === self); this.vm.warn(`COM: ${iface.name}::${m.name} on unknown object ${self.toString(16)} from ${ctx.proc.symbolize(ctx.retAddr)}${dead ? ` (released: ${dead.iface.name} #${dead.id})` : ''} [t${ctx.thread.id}]`); return E_POINTER; }
    switch (index) {
      case 0: { // QueryInterface(riid, ppv)
        const riid = readGuid(this.mem, ctx.arg(1)), ppv = ctx.arg(2);
        if (!ppv) return E_POINTER;
        if (this.supports(obj, riid)) { this.mem.write32(ppv, self); this.addRef(obj); return S_OK; }
        const custom = obj.impl.queryInterface?.(ctx, riid, obj);
        if (custom) { this.mem.write32(ppv, custom); return S_OK; }
        this.mem.write32(ppv, 0);
        this.vm.log('com', `${iface.name}::QueryInterface(${this.byIid.get(riid)?.name ?? riid}) -> E_NOINTERFACE`);
        return E_NOINTERFACE;
      }
      case 1: return this.addRef(obj);
      case 2: return this.release(obj);
    }
    // the method resolved once per object (a property lookup by name is megamorphic across implementations)
    const fns = obj.fns ?? (obj.fns = []);
    let fn = fns[index];
    if (fn === undefined) fn = fns[index] = obj.impl[m.name] ?? null;
    if (typeof fn !== 'function') {
      const key = `${iface.name}::${m.name}`;
      if (!this.tracedMissing.has(key)) { this.tracedMissing.add(key); this.vm.warn(`COM: ${key} not implemented (called from ${ctx.proc.symbolize(ctx.retAddr)})`); }
      const args = []; for (let i = 0; i < Math.min(m.argc, 8); i++) args.push('0x' + ctx.arg(1 + i).toString(16));
      this.vm.log('com', `${key}(${args.join(', ')}) -> E_NOTIMPL`);
      return obj.impl.notImpl ?? E_NOTIMPL;
    }
    if (this.vm.traceCom && !(this.vm.traceComQuiet && (COM_QUIET.test(m.name) || this.comSiteSeen(m.name, ctx.retAddr)))) { const args = []; for (let i = 0; i < Math.min(m.argc, 8); i++) args.push('0x' + ctx.arg(1 + i).toString(16)); this.vm.logFn('com', `${iface.name}::${m.name}(${args.join(', ')}) from ${ctx.proc.symbolize(ctx.retAddr)}`); }
    const r = fn.call(obj.impl, ctx, obj);
    if (typeof r === 'number' && (r >>> 0) >= 0x80000000) this.failed(ctx, iface, m, r);
    return r === undefined ? S_OK : r;
  }
  /** a failed HRESULT: traced once per method/value (fidelity diagnostics) */
  failed(ctx, iface, m, r) {
    const k = `${iface.name}::${m.name}=${(r >>> 0).toString(16)}`;
    if (!this.failedOnce.has(k)) { this.failedOnce.add(k); this.vm.log('gfx', `com: ${iface.name}::${m.name} -> 0x${(r >>> 0).toString(16)} (first from ${ctx.proc.symbolize(ctx.retAddr)})`); }
  }
  /**
   * A call the JIT queued (Vm.drainDeferred), on the object `self`: its method resolved before, called directly; anything
   * else (an unknown object, a method not resolved yet or missing, COM tracing on) through dispatch. The result is not
   * returned: a queued call's caller already received D3D_OK.
   */
  callQueued(ctx, self, iface, index) {
    const obj = this.objects.get(self);
    const fn = obj !== undefined && !this.vm.traceCom ? obj.fns?.[index] : undefined;
    if (typeof fn !== 'function') { this.dispatch(ctx, iface, index); return; }
    const r = fn.call(obj.impl, ctx, obj);
    if (typeof r === 'number' && (r >>> 0) >= 0x80000000) this.failed(ctx, iface, iface.methods[index], r);
  }

  /** CoCreateInstance backend. */
  createInstance(ctx, clsid, iid, ppv) {
    const f = this.classes.get(clsid.toLowerCase());
    if (!f) return undefined; // not registered: the caller reports it
    const ptr = f(ctx, iid.toLowerCase());
    if (!ptr) return REGDB_E_CLASSNOTREG;
    const obj = this.objects.get(ptr);
    if (obj && !this.supports(obj, iid)) { this.release(obj); this.mem.write32(ppv, 0); return E_NOINTERFACE; }
    this.mem.write32(ppv, ptr);
    return S_OK;
  }
}

/**
 * @typedef {{ name: string, iid: string|null, parent: Interface|null, methods: {name: string, argc: number}[], vtable: number }} Interface
 * @typedef {{ ptr: number, iface: Interface, impl: any, refs: number, id: number, proc: any }} ComObject
 */
export { E };
