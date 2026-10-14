// Snapshot of the emulated machine (docs/snapshot.md, DECISIONS.md D071): the guest memory and the emulator's
// JavaScript state at a quiet point, restored in a fresh Vm built for the same game — the game goes on from there
// instead of running its start-up again.
//
// The JavaScript state is everything reachable from the Vm, walked field by field. A field is in the snapshot unless
// its class declares it transient (a cache, a link to the host: rebuilt at restore). The walk refuses what it cannot
// rebuild — a function, an object of a class nobody registered, an accessor, a view on a buffer it does not know — and
// names the path where it found it: state a later change adds cannot be left out silently, the snapshot is refused
// instead (the game then starts the usual way). Objects every Vm builds alike — the host's, and the whole graph its
// modules leave on the Vm once constructed (knowGraph) — are known: a snapshot refers to them by name and restores their
// contents into the restored Vm's own ones, so the closures holding them stay valid; a function there is code, the
// restored Vm's own, checked to be there. State kept in a closure and not handed over is invisible to the walk:
// tests/snapshot-lint.test.js looks for it in the sources.
import { GUEST_SPACE, PAGE_SIZE, JIT_HASH_BASE, THUNK_BASE, JIT_ALT_BASE, SMC_MAP_BASE, BLOCK_COUNTS_BASE, BLOCK_COUNTS_SLOTS } from '../cpu/memory.js';
import { ModuleBuilder, Code, T } from '../cpu/jit/wasm.js';

export const SNAPSHOT_FORMAT = 1;

/** Guest memory the JIT owns (its tables): left out of a snapshot, rebuilt by the restored Vm's JIT. */
export const JIT_RANGES = [[JIT_HASH_BASE, THUNK_BASE], [JIT_ALT_BASE, SMC_MAP_BASE], [SMC_MAP_BASE, BLOCK_COUNTS_BASE + BLOCK_COUNTS_SLOTS * 4]];

/** A snapshot cannot be taken or restored: `path` says where (e.g. "vm.proc.threads[2].wait.cond"). */
export class SnapshotError extends Error {
  constructor(message, path = '') { super(path ? `${message} at ${path}` : message); this.path = path; }
}
/** A snapshot that does not apply to this machine's start (another profile, registry, format): refused before any change. */
export class SnapshotStale extends SnapshotError {}

const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };

/**
 * What a snapshot may hold beyond plain data, for one Vm: registered classes (by name and prototype), known objects
 * (by name and identity: built by the host or by the modules of every Vm, restored in place) and constants (shared
 * frozen objects and functions: kept by identity).
 */
export class SnapRegistry {
  constructor() {
    /** @type {Map<string, ClassEntry>} */ this.byName = new Map();
    /** @type {Map<object, ClassEntry>} */ this.byProto = new Map();
    /** @type {Map<string, any>} */ this.knownByName = new Map();
    /** @type {Map<any, string>} */ this.knownName = new Map();
    /** @type {Map<string, {state: boolean, save?: Function, load?: Function}>} */ this.knownOpts = new Map();
    for (const e of GLOBAL_CLASSES.values()) this.addClass(e);
    for (const [name, obj] of GLOBAL_CONSTS) { this.knownByName.set(name, obj); this.knownName.set(obj, name); this.knownOpts.set(name, { state: false }); }
  }

  addClass(e) {
    const old = this.byName.get(e.name);
    if (old && old.proto !== e.proto) throw new SnapshotError(`two snapshot classes named ${e.name}`);
    this.byName.set(e.name, e); this.byProto.set(e.proto, e);
  }

  /** A class of this Vm only (defined in a module's closure): see snapshotClass. */
  cls(cls, opts = {}) { this.addClass(classEntry(cls, opts)); return cls; }

  /**
   * An object every Vm builds the same way (its host links, the containers a module keeps in its closure), known by
   * `name`: a snapshot refers to it by name, and restores its contents into the restored Vm's own one (`state`,
   * default true: a Map's entries, a Set's members, an object's fields; `save(obj) → data` and `load(obj, data)` for
   * others). `state: false`: identity only (the host's objects, constants).
   */
  known(name, obj, opts = {}) {
    if (this.knownByName.has(name) && this.knownByName.get(name) !== obj) throw new SnapshotError(`two known objects named ${name}`);
    this.knownByName.set(name, obj); this.knownName.set(obj, name);
    this.knownOpts.set(name, { state: opts.state ?? true, save: opts.save, load: opts.load, skip: new Set(opts.skip ?? []) });
    return obj;
  }

  /**
   * Every object reachable from `root` (known already) becomes known, named by its path: the graph a Vm's construction
   * leaves (its modules' tables, registries, initial state) is built alike by every Vm. `skip(obj, key)`: fields not
   * followed (the root's transient ones). Functions are not objects of the graph: values.
   */
  knowGraph(root, skip = () => false) {
    const queue = [[root, this.knownName.get(root)]];
    const visit = (v, path) => {
      if (v === null || typeof v !== 'object' || this.knownName.has(v)) return;
      this.known(path, v); queue.push([v, path]);
    };
    while (queue.length) {
      const [o, path] = queue.shift();
      const opts = this.knownOpts.get(path);
      if (opts && (!opts.state || opts.save)) continue; // (opaque, or saved by hooks: not followed)
      if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer) continue;
      if (Array.isArray(o)) { o.forEach((v, i) => visit(v, `${path}[${i}]`)); continue; }
      if (o instanceof Map) { let i = 0; for (const [k, v] of o) { visit(k, `${path}<key ${i}>`); visit(v, `${path}.get(${typeof k === 'object' ? `#${i}` : String(k)})`); i++; } continue; }
      if (o instanceof Set) { let i = 0; for (const v of o) visit(v, `${path}<member ${i++}>`); continue; }
      for (const k of Object.getOwnPropertyNames(o)) {
        if (opts?.skip.has(k) || skip(o, k)) continue;
        const d = Object.getOwnPropertyDescriptor(o, k);
        if ('value' in d) visit(d.value, `${path}.${k}`);
      }
    }
  }
}

/**
 * @typedef {object} ClassEntry
 * @property {string} name
 * @property {object} proto
 * @property {Set<string>} skip fields not in a snapshot (transient: caches, host links)
 * @property {(obj: any, vm: any) => void} [init] after a restore, rebuilds the skipped fields of `obj`
 * @property {(obj: any, vm: any) => (void|Promise<void>)} [resume] once the restored machine is whole: hands the new
 *   host what `obj` had shown the captured one (a display mode, a cursor, fonts...); a promise: what the host waits for
 *   before running the machine (vm.restoring)
 * @property {(obj: any) => any} [save] the object as plain data (no object references), instead of its fields
 * @property {(data: any, vm: any) => any} [load] the object from what save() returned
 */
const GLOBAL_CLASSES = new Map(), GLOBAL_CONSTS = new Map();
function classEntry(cls, opts) {
  return { name: opts.name ?? cls.name, proto: cls.prototype, skip: new Set(opts.skip ?? []), init: opts.init, resume: opts.resume, save: opts.save, load: opts.load };
}

/**
 * Declare a class (defined at a module's top level) whose instances a snapshot may hold. `skip`: transient fields
 * (rebuilt by `init(obj, vm)` after a restore); `resume(obj, vm)`: what the host showed, shown again once the machine
 * is restored; `save`/`load`: the object as plain data instead (a view on the guest memory, ...).
 */
export function snapshotClass(cls, opts = {}) {
  const e = classEntry(cls, opts);
  if (GLOBAL_CLASSES.has(e.name) && GLOBAL_CLASSES.get(e.name).proto !== e.proto) throw new SnapshotError(`two snapshot classes named ${e.name}`);
  GLOBAL_CLASSES.set(e.name, e);
  return cls;
}

// snapshot: constant, the keys cacheKey made
const CACHE_KEYS = new Set();
/**
 * A property key for a cache a module keeps on a plain object — code compiled from the object's data, values derived
 * from it: never in a snapshot, rebuilt where it is read (`obj[KEY] ??= build(obj)`). Any other symbol key is refused.
 */
export function cacheKey(name) { const k = Symbol(name); CACHE_KEYS.add(k); return k; }

/** `vm.snap.known(name, obj, opts)` on a Vm that has a snapshot registry (a test's minimal one may not): `obj`. */
export const snapKnown = (vm, name, obj, opts) => (vm.snap ? vm.snap.known(name, obj, opts) : obj);
/** `vm.snap.cls(cls, opts)` on a Vm that has a snapshot registry. */
export const snapClass = (vm, cls, opts) => (vm.snap ? vm.snap.cls(cls, opts) : cls);

/** A shared constant (a frozen object, a function) a snapshot may refer to, by name. */
export function snapshotConstant(name, obj) { GLOBAL_CONSTS.set(name, obj); return obj; }

// ---------------------------------------------------------------- the JavaScript state

const isPlainProto = (p) => p === Object.prototype || p === null;

/**
 * The state graph reachable from `root` (a known object): `{ root, objects }`, each object one record, references
 * between them by index; typed arrays' bytes in `blobs`. `problems`: an array to collect every refusal in (each
 * value refused left out) instead of throwing at the first — the list of what to declare.
 */
export function encodeGraph(root, reg, problems = null) {
  const ids = new Map(), objects = [], blobs = [], from = [];
  const refuse = (e) => { if (!problems) throw e; problems.push(e.message); return { u: 1 }; };
  const where = (id, key) => { const parts = [key]; for (let i = id; i >= 0; i = from[i][0]) parts.push(from[i][1]); return parts.reverse().join(''); };
  const queue = [];
  const ref = (v, parentId, key) => {
    let id = ids.get(v);
    if (id === undefined) { id = objects.length; ids.set(v, id); objects.push(null); from.push([parentId, key]); queue.push(v); }
    return { r: id };
  };
  const value = (v, parentId, key, code = false) => {
    if (code && typeof v === 'function' && !reg.knownName.has(v)) return { f: 1 }; // (code of a known object: the restored Vm's own)
    switch (typeof v) {
      case 'number': return Number.isFinite(v) && !Object.is(v, -0) ? v : { n: Object.is(v, -0) ? '-0' : String(v) };
      case 'string': case 'boolean': return v;
      case 'undefined': return { u: 1 };
      case 'bigint': return { b: v.toString() };
      case 'symbol': return refuse(new SnapshotError('a symbol', where(parentId, key)));
      case 'function': if (reg.knownName.has(v)) return ref(v, parentId, key); return refuse(new SnapshotError(`a function (${v.name || 'anonymous'})`, where(parentId, key)));
      default: return v === null ? null : ref(v, parentId, key);
    }
  };
  const fields = (o, id, skip, owner, code) => {
    const p = {};
    for (const k of Object.getOwnPropertyNames(o)) {
      if (skip?.has(k)) continue;
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!('value' in d)) { refuse(new SnapshotError(`an accessor (${owner})`, where(id, '.' + k))); continue; }
      p[k] = value(d.value, id, '.' + k, code);
    }
    if (Object.getOwnPropertySymbols(o).some((s) => !CACHE_KEYS.has(s))) refuse(new SnapshotError(`symbol keys (${owner})`, where(id, '')));
    return p;
  };
  const rootName = reg.knownName.get(root);
  if (rootName === undefined) throw new SnapshotError('the root is not a known object');
  ref(root, -1, rootName);
  // (known objects with state are in wherever they are referenced from, or not: the containers a module keeps in its
  // closure are reachable from nothing else)
  for (const [name, o] of reg.knownByName) if (reg.knownOpts.get(name).state) ref(o, -1, name);
  while (queue.length) {
    const o = queue.shift(), id = ids.get(o);
    const known = reg.knownName.get(o);
    if (known !== undefined) {
      const ko = reg.knownOpts.get(known);
      let s;
      if (ko.state) s = ko.save ? { d: ko.save(o) } : container(o, id, ko.skip, known);
      objects[id] = s === undefined ? { k: known } : { k: known, s };
      continue;
    }
    try { objects[id] = container(o, id, null, null); } catch (e) { if (!(e instanceof SnapshotError) || !problems) throw e; problems.push(e.message); objects[id] = { c: null, p: {} }; }
  }
  return { root: 0, objects, blobs };

  /** an object's contents as a record (known objects: their state, their functions code) */
  function container(o, id, skip, known) {
    const code = known !== null;
    if (Array.isArray(o)) {
      if (Object.getPrototypeOf(o) !== Array.prototype) throw new SnapshotError('an array subclass', where(id, ''));
      const a = new Array(o.length); for (let i = 0; i < o.length; i++) a[i] = value(o[i], id, `[${i}]`, code);
      return { a };
    }
    if (o instanceof Map) { const m = []; let i = 0; for (const [k, v] of o) { m.push([value(k, id, `<key ${i}>`), value(v, id, `.get(${typeof k === 'object' ? i : String(k)})`, code)]); i++; } return { m }; }
    if (o instanceof Set) { const st = []; let i = 0; for (const v of o) st.push(value(v, id, `<member ${i++}>`, code)); return { st }; }
    if (ArrayBuffer.isView(o)) {
      const name = o instanceof DataView ? 'DataView' : o.constructor?.name;
      if (name !== 'DataView' && (!TYPED[name] || Object.getPrototypeOf(o) !== TYPED[name].prototype)) throw new SnapshotError(`a buffer view (${name})`, where(id, ''));
      if (code && name !== 'DataView') { blobs.push(new Uint8Array(o.buffer, o.byteOffset, o.byteLength).slice()); return { t: name, b: blobs.length - 1 }; } // (a known array: its bytes, in place)
      // (a view: on its buffer — shared with other views, or the guest memory's, a known one — at its offset)
      return { t: name, buf: value(o.buffer, id, '.buffer'), off: o.byteOffset, len: name === 'DataView' ? o.byteLength : o.length };
    }
    if (o instanceof ArrayBuffer) { if (o.byteLength > 1 << 28) throw new SnapshotError(`an ArrayBuffer of ${o.byteLength} bytes (the guest memory's? register it)`, where(id, '')); blobs.push(new Uint8Array(o).slice()); return { ab: blobs.length - 1 }; }
    if (typeof SharedArrayBuffer !== 'undefined' && o instanceof SharedArrayBuffer) throw new SnapshotError('a SharedArrayBuffer (register it)', where(id, ''));
    const proto = Object.getPrototypeOf(o);
    if (isPlainProto(proto)) return { c: proto === null ? '' : null, p: fields(o, id, skip, 'object', code) };
    const e = reg.byProto.get(proto);
    if (!e) {
      if (known) return { p: fields(o, id, skip, known, code) }; // (a known object of any class: its fields, in place)
      throw new SnapshotError(`an object of class ${o.constructor?.name ?? '?'} (not registered)`, where(id, ''));
    }
    if (e.save) return { x: e.name, d: e.save(o) };
    return { c: e.name, p: fields(o, id, skip ? new Set([...skip, ...e.skip]) : e.skip, e.name, code) };
  }
}

/**
 * Restore a graph of encodeGraph into the world of `reg` (another Vm's registry): known objects are that Vm's own, their
 * state put in place; the others are created. Returns `{ root, reimpose }`: reimpose() puts the snapshot's contents again
 * into the same objects (undoing what ran since — see vm-snapshot.js, waits rebuilt by re-executing calls).
 */
export function decodeGraph(graph, reg, vm) {
  const { objects, blobs } = graph, out = new Array(objects.length), inits = [];
  // (pass 1: every object, empty; known ones resolved; buffers before the views on them)
  objects.forEach((rec, i) => {
    if (rec.k !== undefined) {
      if (!reg.knownByName.has(rec.k)) throw new SnapshotError(`no known object ${rec.k} in this Vm`);
      out[i] = reg.knownByName.get(rec.k);
    } else if (rec.ab !== undefined) out[i] = blobs[rec.ab].slice().buffer;
  });
  objects.forEach((rec, i) => {
    if (out[i] !== undefined) return;
    if (rec.a) out[i] = new Array(rec.a.length);
    else if (rec.m) out[i] = new Map();
    else if (rec.st) out[i] = new Set();
    else if (rec.t && rec.buf) { const buf = out[rec.buf.r]; out[i] = rec.t === 'DataView' ? new DataView(buf, rec.off, rec.len) : new TYPED[rec.t](buf, rec.off, rec.len); }
    else if (rec.t) out[i] = new TYPED[rec.t](blobs[rec.b].slice().buffer);
    else if (rec.x) { const e = reg.byName.get(rec.x); if (!e?.load) throw new SnapshotError(`no snapshot class ${rec.x} in this Vm`); out[i] = e.load(rec.d, vm); }
    else if (rec.c === null) out[i] = {};
    else if (rec.c === '') out[i] = Object.create(null);
    else { const e = reg.byName.get(rec.c); if (!e) throw new SnapshotError(`no snapshot class ${rec.c} in this Vm`); out[i] = Object.create(e.proto); if (e.init) inits.push([e, out[i]]); }
  });
  const v = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (x.r !== undefined) return out[x.r];
    if (x.u) return undefined;
    if (x.n !== undefined) return x.n === '-0' ? -0 : Number(x.n);
    if (x.b !== undefined) return BigInt(x.b);
    throw new SnapshotError('a malformed value');
  };
  // (pass 2: contents; a known object's state in place, its code — {f: 1} — the restored Vm's own, checked)
  const code = (fn, where) => { if (typeof fn !== 'function') throw new SnapshotError('the restored Vm has no function', where); return fn; };
  const fill = (again) => objects.forEach((rec, i) => {
    const o = out[i];
    const known = rec.k !== undefined || again, s = rec.k !== undefined ? rec.s : rec;
    if (!s || rec.x) return;
    if (known && s.d !== undefined) { reg.knownOpts.get(rec.k).load(o, s.d, vm); return; }
    const at = (key) => `${rec.k ?? `#${i}`}${key}`;
    if (s.a) { const old = known ? o.slice() : null; if (known) o.length = 0; s.a.forEach((x, j) => { o[j] = x?.f ? code(old?.[j], at(`[${j}]`)) : v(x); }); }
    else if (s.m) { const old = known ? new Map(o) : null; if (known) o.clear(); for (const [k, x] of s.m) { const key = v(k); o.set(key, x?.f ? code(old?.get(key), at(`.get(${String(key)})`)) : v(x)); } }
    else if (s.st) { if (known) o.clear(); for (const x of s.st) o.add(v(x)); }
    else if (s.t && s.b !== undefined && known) { const b = blobs[s.b]; if (b.length !== o.byteLength) throw new SnapshotError(`a ${s.t} of another size`, at('')); new Uint8Array(o.buffer, o.byteOffset, o.byteLength).set(b); }
    else if (s.ab !== undefined && again) new Uint8Array(o).set(blobs[s.ab]);
    else if (s.p) for (const [k, x] of Object.entries(s.p)) { if (x?.f) code(o[k], at(`.${k}`)); else o[k] = v(x); }
  });
  fill(false);
  for (const [e, o] of inits) e.init(o, vm);
  return {
    root: out[graph.root],
    reimpose() { fill(true); for (const [e, o] of inits) e.init(o, vm); },
    /** The resume hooks run; what they return that the host waits for (promises) before the machine goes on. */
    resume() {
      const waits = [];
      for (const o of out) { const e = o !== null && typeof o === 'object' ? reg.byProto.get(Object.getPrototypeOf(o)) : null; const r = e?.resume?.(o, vm); if (r?.then) waits.push(r); }
      return waits;
    },
  };
}

// ---------------------------------------------------------------- the guest memory

const inJit = (a) => JIT_RANGES.some(([s, e]) => a >= s && a < e);

/** The guest memory's pages holding anything (zero pages implied), the JIT's tables left out. */
export function capturePages(mem) {
  const u8 = mem.u8, n = Math.min(u8.byteLength, GUEST_SPACE) / PAGE_SIZE;
  const index = [], data = [];
  const next = pageScanner(mem);
  for (let p = next(0, n); p < n; p = next(p + 1, n)) {
    const a = p * PAGE_SIZE;
    if (inJit(a)) continue;
    index.push(p); data.push(u8.subarray(a, a + PAGE_SIZE));
  }
  const all = new Uint8Array(index.length * PAGE_SIZE);
  data.forEach((d, i) => all.set(d, i * PAGE_SIZE));
  return { pageSize: PAGE_SIZE, index: Uint32Array.from(index), data: all };
}

// snapshot: cache, a scanner per memory
const scanners = new WeakMap();
/**
 * next(p, end): the first page in [p, end) holding a nonzero byte, else end. WebAssembly SIMD on the memory itself (2 GB
 * scanned in a fraction of the 850 ms a JavaScript loop takes: most of it never touched, the same zero page read again);
 * the JavaScript loop where it is not available.
 */
function pageScanner(mem) {
  let next = mem.memory ? scanners.get(mem.memory) : undefined;
  if (next) return next;
  try {
    const shared = typeof SharedArrayBuffer !== 'undefined' && mem.memory.buffer instanceof SharedArrayBuffer;
    const m = new ModuleBuilder(), c = new Code(), P = 0, END = 1, A = 2, E = 3, ACC = 4;
    m.importMemory('env', 'memory', 1, shared ? 65536 : undefined, shared);
    const found = c.block(), pages = c.loop();
    c.get(P).get(END).ge_u().br_if(found);
    c.get(P).i32(12).shl().tee(A).i32(PAGE_SIZE).add().set(E);
    c.v128const(new Uint8Array(16)).set(ACC);
    const words = c.loop(); // (64 bytes a turn)
    c.get(ACC).get(A).v128load(0).v128or().get(A).v128load(16).v128or().get(A).v128load(32).v128or().get(A).v128load(48).v128or().set(ACC);
    c.get(A).i32(64).add().tee(A).get(E).lt_u().br_if(words);
    c.end();
    c.get(ACC).v128anytrue().br_if(found);
    c.get(P).i32(1).add().set(P).br(pages);
    c.end(); c.end(); void found;
    c.get(P);
    m.exportFunc('next', m.func([T.i32, T.i32], [T.i32], [T.i32, T.i32, T.v128], c, 'next'));
    next = new WebAssembly.Instance(new WebAssembly.Module(m.build()), { env: { memory: mem.memory } }).exports.next;
  } catch {
    const w = new Int32Array(mem.u8.buffer, 0, Math.min(mem.u8.byteLength, GUEST_SPACE) >>> 2), per = PAGE_SIZE >>> 2;
    next = (p, end) => {
      for (; p < end; p++) { let i = p * per; const e = i + per; while (i < e && (w[i] | w[i + 1] | w[i + 2] | w[i + 3]) === 0) i += 4; if (i < e) return p; }
      return end;
    };
  }
  if (mem.memory) scanners.set(mem.memory, next);
  return next;
}

/** Write `pages` into `mem` (whose other pages, the JIT's tables aside, must be zero: a fresh Vm's). */
export function restorePages(mem, pages) {
  const u8 = mem.u8;
  pages.index.forEach((p, i) => { u8.set(pages.data.subarray(i * pages.pageSize, (i + 1) * pages.pageSize), p * pages.pageSize); });
}

// ---------------------------------------------------------------- a snapshot as bytes

/** The snapshot as one buffer (persisted, compared): a header, the graph as JSON, then the binary parts. */
export function encodeSnapshot(snap) {
  const enc = new TextEncoder();
  const bins = [snap.pages.index, snap.pages.data, ...snap.graph.blobs].map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  const json = enc.encode(JSON.stringify({ format: snap.format, meta: snap.meta, pageSize: snap.pages.pageSize, root: snap.graph.root, objects: snap.graph.objects, bins: bins.map((b) => b.length) }));
  const out = new Uint8Array(8 + json.length + bins.reduce((s, b) => s + b.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x4f534e50); dv.setUint32(4, json.length); // 'OSNP'
  out.set(json, 8);
  let at = 8 + json.length; for (const b of bins) { out.set(b, at); at += b.length; }
  return out;
}

export function decodeSnapshot(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== 0x4f534e50) throw new SnapshotError('not a snapshot');
  const len = dv.getUint32(4), head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
  if (head.format !== SNAPSHOT_FORMAT) throw new SnapshotError(`snapshot format ${head.format}, expected ${SNAPSHOT_FORMAT}`);
  let at = 8 + len; const bins = head.bins.map((n) => { const b = bytes.slice(at, at + n); at += n; return b; });
  return { format: head.format, meta: head.meta, pages: { pageSize: head.pageSize, index: new Uint32Array(bins[0].buffer), data: bins[1] }, graph: { root: head.root, objects: head.objects, blobs: bins.slice(2) } };
}

// ---------------------------------------------------------------- comparing snapshots

/**
 * Where two snapshots differ (empty: they are the same machine): guest memory bytes, then objects, named by the path
 * the walk first reached them by. `ignore`: patterns of field paths not compared (fields read against the host's clock).
 * The oracle of tests/snapshot.test.js and tools/snapshot-check.mjs: a machine restored from a snapshot and the one it
 * was taken from, run alike, must stay the same.
 */
export function snapshotsDiffer(a, b, { ignore = [], max = 20 } = {}) {
  const out = [];
  const pa = new Map(), pb = new Map();
  a.pages.index.forEach((p, i) => pa.set(p, i)); b.pages.index.forEach((p, i) => pb.set(p, i));
  const page = (s, i) => (i === undefined ? null : s.pages.data.subarray(i * s.pages.pageSize, (i + 1) * s.pages.pageSize));
  for (const p of new Set([...pa.keys(), ...pb.keys()])) {
    if (out.length >= max) return out;
    const x = page(a, pa.get(p)), y = page(b, pb.get(p));
    for (let j = 0, n = a.pages.pageSize; j < n; j++) if ((x?.[j] ?? 0) !== (y?.[j] ?? 0)) { out.push(`memory at ${(p * n + j).toString(16)}: ${x?.[j] ?? 0} vs ${y?.[j] ?? 0}`); break; }
  }
  const names = (g) => {
    const n = new Array(g.objects.length);
    const queue = [g.root]; n[g.root] = g.objects[g.root].k ?? 'root';
    while (queue.length) {
      const i = queue.shift(), r = g.objects[i], s = r.k !== undefined ? r.s : r;
      if (r.k !== undefined) n[i] = r.k;
      const visit = (x, key) => { if (x && typeof x === 'object' && x.r !== undefined && n[x.r] === undefined) { n[x.r] = n[i] + key; queue.push(x.r); } };
      if (s?.p) for (const [k, x] of Object.entries(s.p)) visit(x, '.' + k);
      s?.a?.forEach((x, j) => visit(x, `[${j}]`));
      s?.m?.forEach(([k, x], j) => { visit(k, `<key ${j}>`); visit(x, `.get(${typeof k === 'object' ? j : k})`); });
      s?.st?.forEach((x, j) => visit(x, `<member ${j}>`));
    }
    return n;
  };
  const na = names(a.graph), nb = names(b.graph);
  const blob = (s, x) => s.graph.blobs[x];
  const same = (x, y, ga, gb) => JSON.stringify(x) === JSON.stringify(y);
  if (a.graph.objects.length !== b.graph.objects.length) out.push(`${a.graph.objects.length} vs ${b.graph.objects.length} objects`);
  for (let i = 0; i < Math.min(a.graph.objects.length, b.graph.objects.length) && out.length < max; i++) {
    const x = a.graph.objects[i], y = b.graph.objects[i], path = na[i] ?? `#${i}`;
    if (path !== (nb[i] ?? `#${i}`)) { out.push(`object ${i}: ${path} vs ${nb[i]}`); continue; }
    const sx = x.k !== undefined ? x.s : x, sy = y.k !== undefined ? y.s : y;
    if (sx?.p && sy?.p) {
      for (const k of new Set([...Object.keys(sx.p), ...Object.keys(sy.p)])) {
        const fp = `${path}.${k}`;
        if (ignore.some((re) => re.test(fp))) continue;
        if (!same(sx.p[k], sy.p[k])) out.push(`${fp}: ${JSON.stringify(sx.p[k])?.slice(0, 80)} vs ${JSON.stringify(sy.p[k])?.slice(0, 80)}`);
      }
      continue;
    }
    const bx = sx?.b !== undefined ? blob(a, sx.b) : sx?.ab !== undefined ? blob(a, sx.ab) : null, by = sy?.b !== undefined ? blob(b, sy.b) : sy?.ab !== undefined ? blob(b, sy.ab) : null;
    if (bx || by) { if (!bx || !by || bx.length !== by.length || bx.some((v, j) => v !== by[j])) out.push(`${path}: bytes differ`); continue; }
    if (!same(sx, sy)) out.push(`${path}: ${JSON.stringify(sx)?.slice(0, 100)} vs ${JSON.stringify(sy)?.slice(0, 100)}`);
  }
  return out.slice(0, max);
}
