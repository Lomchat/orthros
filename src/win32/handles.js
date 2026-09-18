// Handle table: Win32 HANDLEs are small integers (multiples of 4) mapping to host objects.

export class HandleTable {
  constructor() {
    /** @type {Map<number, any>} */
    this.map = new Map();
    this.next = 0x10;
  }

  /** @param {any} obj object with a `type` string */
  create(obj) {
    const h = this.next;
    this.next += 4;
    this.map.set(h, obj);
    if (obj) obj.handle = obj.handle ?? h;
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
    return nh;
  }
}
