// Handle table: Win32 HANDLEs are small integers (multiples of 4) mapping to host objects.
import { MUTEX_HANDLES, MUTEX_HANDLE_END } from '../cpu/memory.js';

export class HandleTable {
  /** @param {import('../cpu/memory.js').GuestMemory=} mem where the JIT's mutex table is kept (memory.js MUTEX_HANDLES) */
  constructor(mem = null) {
    /** @type {Map<number, any>} */
    this.map = new Map();
    this.next = 0x10;
    this.mem = mem;
  }

  /** the JIT's mutex table entry of handle `h`: the state address of the mutex it names (kernel32.js Mutex), or 0 */
  mutexEntry(h, obj) { if (this.mem && h < MUTEX_HANDLE_END && obj?.stateAddr) this.mem.u32[(MUTEX_HANDLES + h) >>> 2] = obj.stateAddr; }

  /** @param {any} obj object with a `type` string */
  create(obj) {
    const h = this.next;
    this.next += 4;
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
    if (o.stateAddr && this.mem && (h >>> 0) < MUTEX_HANDLE_END) this.mem.u32[(MUTEX_HANDLES + (h >>> 0)) >>> 2] = 0;
    if (o.refs !== undefined && --o.refs > 0) return true;
    if (typeof o.close === 'function') o.close();
    return true;
  }

  /** Duplicate: same object under a new handle (ref counted if the object supports it). */
  dup(h) {
    const o = this.map.get(h >>> 0);
    if (!o) return 0;
    if (o.refs !== undefined) o.refs++;
    const nh = this.next;
    this.next += 4;
    this.map.set(nh, o);
    this.mutexEntry(nh, o);
    return nh;
  }
}
