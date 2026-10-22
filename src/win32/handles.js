// Handle table: Win32 HANDLEs are small integers (multiples of 4) mapping to host objects.
import { MUTEX_HANDLES, MUTEX_HANDLE_END } from '../cpu/memory.js';

/**
 * Handle values a process of a process group takes at a time (core/procs.js): each process allocates from blocks of
 * its own, never another process's values — window handles are handles, so an hwnd names one window in the group.
 */
export const HANDLE_BLOCK = 0x10000;

export class HandleTable {
  /** @param {import('../cpu/memory.js').GuestMemory=} mem where the JIT's mutex table is kept (memory.js MUTEX_HANDLES) */
  constructor(mem = null) {
    /** @type {Map<number, any>} */
    this.map = new Map();
    this.next = 0x10;
    this.mem = mem;
    /** @type {Set<number> | null} the handles a child process inherits (bInheritHandle, HANDLE_FLAG_INHERIT) */
    this.inherit = null;
    /** @type {Map<string, any> | null} the kernel-object namespace of the named objects in this table (forgetName) */
    this.named = null;
    /** a process group's table (alloc): the end of its block of handle values (0: none), and the group handing out blocks */
    this.limit = 0;
    /** @type {{ takeHandles(): number } | null} */
    this.pool = null;
  }

  /** Mark handle `h` inheritable or not (SECURITY_ATTRIBUTES.bInheritHandle, SetHandleInformation). */
  setInherit(h, on) { h >>>= 0; if (on) (this.inherit ??= new Set()).add(h); else this.inherit?.delete(h); }

  /**
   * The inheritable handles into `child`'s table under the same values (CreateProcess with bInheritHandles): the
   * objects shared, each with one reference more. `child` hands out its own handles from blocks of its own (alloc).
   * @returns {any[]} the objects inherited
   */
  inheritInto(child) {
    const out = [];
    for (const h of this.inherit ?? []) {
      const o = this.map.get(h);
      if (!o) { this.inherit.delete(h); continue; }
      if (o.refs !== undefined) o.refs++;
      child.map.set(h, o); child.setInherit(h, true);
      out.push(o);
    }
    return out;
  }

  /** the JIT's mutex table entry of handle `h`: the state address of the mutex it names (kernel32.js Mutex), or 0 */
  mutexEntry(h, obj) { if (this.mem && h < MUTEX_HANDLE_END && obj?.stateAddr && !globalThis.ORTHROS_TRACE_HANDLE) this.mem.u32[(MUTEX_HANDLES + h) >>> 2] = obj.stateAddr; } // (a traced handle: every call through JavaScript)

  /**
   * The next handle value. A table of a process group (core/procs.js: `limit` and `pool` set) takes a new block from
   * the group when its own is used up; alone (no limit), values just grow.
   */
  alloc() {
    let h = this.next;
    if (this.limit && h >= this.limit) { h = this.pool.takeHandles(); this.limit = h + HANDLE_BLOCK; }
    this.next = h + 4;
    return h;
  }

  /** @param {any} obj object with a `type` string */
  create(obj) {
    const h = this.alloc();
    this.map.set(h, obj);
    if (obj) obj.handle = obj.handle ?? h;
    this.mutexEntry(h, obj);
    return h;
  }

  get(h) { return this.map.get(h >>> 0); }

  /** Get an object checking its type; returns null on mismatch. */
  getAs(h, type) {
    const o = this.map.get(h >>> 0);
    return o && o.type === type ? o : null;
  }

  close(h) {
    const o = this.map.get(h >>> 0);
    if (!o) return false;
    this.map.delete(h >>> 0);
    this.inherit?.delete(h >>> 0);
    if (o.stateAddr && this.mem && (h >>> 0) < MUTEX_HANDLE_END) this.mem.u32[(MUTEX_HANDLES + (h >>> 0)) >>> 2] = 0;
    if (o.refs !== undefined && --o.refs > 0) return true;
    this.forgetName(o);
    if (typeof o.close === 'function') o.close();
    return true;
  }

  /**
   * A named kernel object's last handle closed: its name leaves the namespace (`named`, kernel32's — a process group's,
   * every process's: core/procs.js), as on Windows, where a later Create* of that name makes a new object. A file
   * mapping keeps its name while views of it are mapped (they keep the section alive).
   */
  forgetName(o) {
    if (o.name && (o.refs ?? 0) <= 0 && !o.views?.length && this.named?.get(o.name) === o) this.named.delete(o.name);
  }

  /** Duplicate: same object under a new handle (ref counted if the object supports it). */
  dup(h) {
    const o = this.map.get(h >>> 0);
    if (!o) return 0;
    if (o.refs !== undefined) o.refs++;
    const nh = this.alloc();
    this.map.set(nh, o);
    this.mutexEntry(nh, o);
    return nh;
  }
}
