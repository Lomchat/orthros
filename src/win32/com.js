// COM plumbing: interfaces are vtables of API thunks living in guest memory; objects are small
// guest blocks [vtable, marker, id] whose methods dispatch to JS implementations. Unimplemented
// methods are traced (once per method) and return E_NOTIMPL so the caller keeps going.
import { E } from './errors.js';

export const S_OK = 0, S_FALSE = 1, E_NOTIMPL = 0x80004001, E_NOINTERFACE = 0x80004002, E_POINTER = 0x80004003, E_FAIL = 0x80004005, E_INVALIDARG = 0x80070057, E_OUTOFMEMORY = 0x8007000e, CLASS_E_NOAGGREGATION = 0x80040110, REGDB_E_CLASSNOTREG = 0x80040154;
export const IID_IUnknown = '00000000-0000-0000-c000-000000000046';
const MARKER = 0x4d4f4321; // '!COM'

/** GUID in guest memory -> canonical lowercase string */
export function readGuid(mem, a) {
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

export class Com {
  /** @param {import('../core/vm.js').Vm} vm */
  constructor(vm) {
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

  /** Allocate the vtable of an interface once: one API thunk per method. */
  vtableOf(proc, iface) {
    if (iface.vtable) return iface.vtable;
    const n = iface.methods.length;
    const vt = proc.processHeap.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const m = iface.methods[i];
      const fname = `${iface.name}::${m.name}`;
      if (!this.api.lookup('com', fname)) {
        this.api.define('com', { [fname]: [m.argc + 1, (c) => this.dispatch(c, iface, i)] });
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
  create(proc, iface, impl) {
    if (typeof iface === 'string') iface = this.interfaces.get(iface);
    const ptr = proc.processHeap.alloc(16);
    this.mem.write32(ptr, this.vtableOf(proc, iface));
    this.mem.write32(ptr + 4, MARKER);
    this.mem.write32(ptr + 8, this.nextId);
    const obj = { ptr, iface, impl, refs: 1, id: this.nextId++, proc };
    this.objects.set(ptr, obj);
    impl.com = obj;
    return ptr;
  }

  /** JS object behind a guest interface pointer (null if unknown). */
  objectAt(ptr) { return this.objects.get(ptr >>> 0) ?? null; }
  implAt(ptr) { return this.objects.get(ptr >>> 0)?.impl ?? null; }

  addRef(obj) { return ++obj.refs; }
  release(obj) {
    if (--obj.refs > 0) return obj.refs;
    this.objects.delete(obj.ptr);
    try { obj.impl.destroy?.(obj); } finally { obj.proc.processHeap.free_(obj.ptr); }
    return 0;
  }

  /** Does `obj` implement the interface with this IID? (its own chain, plus impl.iids) */
  supports(obj, iid) {
    if (iid === IID_IUnknown) return true;
    for (let i = obj.iface; i; i = i.parent) if (i.iid === iid) return true;
    for (const x of obj.impl.iids ?? []) { const s = x.includes('-') ? x.toLowerCase() : this.interfaces.get(x)?.iid; if (s === iid) return true; }
    return false;
  }

  dispatch(ctx, iface, index) {
    const m = iface.methods[index];
    const self = ctx.arg(0);
    const obj = this.objects.get(self);
    if (!obj) { this.vm.warn(`COM: ${iface.name}::${m.name} on unknown object ${self.toString(16)} from ${ctx.proc.symbolize(ctx.retAddr)}`); return E_POINTER; }
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
    const fn = obj.impl[m.name];
    if (typeof fn !== 'function') {
      const key = `${iface.name}::${m.name}`;
      if (!this.tracedMissing.has(key)) { this.tracedMissing.add(key); this.vm.warn(`COM: ${key} not implemented (called from ${ctx.proc.symbolize(ctx.retAddr)})`); }
      const args = []; for (let i = 0; i < Math.min(m.argc, 8); i++) args.push('0x' + ctx.arg(1 + i).toString(16));
      this.vm.log('com', `${key}(${args.join(', ')}) -> E_NOTIMPL`);
      return obj.impl.notImpl ?? E_NOTIMPL;
    }
    if (this.vm.traceCom) { const args = []; for (let i = 0; i < Math.min(m.argc, 8); i++) args.push('0x' + ctx.arg(1 + i).toString(16)); this.vm.log('com', `${iface.name}::${m.name}(${args.join(', ')}) from ${ctx.proc.symbolize(ctx.retAddr)}`); }
    const r = fn.call(obj.impl, ctx, obj);
    return r === undefined ? S_OK : r;
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
