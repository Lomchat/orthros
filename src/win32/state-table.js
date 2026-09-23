// Device state words (render / texture stage / sampler states) by small integer key: the Map interface the
// Direct3D devices and the WebGL backend use (get, set, has, iteration in first-set order, keys, size) over a
// plain array, as a draw reads dozens of them. Keys outside [0, capacity) (never set by well-formed code) go to a
// Map so that a stray value does not turn the array into a dictionary.
export class StateTable {
  /** @param {number} capacity @param {Iterable<[number, number]>} [init] */
  constructor(capacity, init) {
    this.v = new Array(capacity).fill(undefined);
    this.order = [];
    this.extra = null;
    if (init) for (const [k, x] of init) this.set(k, x);
  }
  get(k) { return k >= 0 && k < this.v.length ? this.v[k] : this.extra?.get(k); }
  has(k) { return this.get(k) !== undefined; }
  set(k, x) {
    if (k >= 0 && k < this.v.length) { if (this.v[k] === undefined) this.order.push(k); this.v[k] = x; }
    else { if (!(this.extra ??= new Map()).has(k)) this.order.push(k); this.extra.set(k, x); }
    return this;
  }
  get size() { return this.order.length; }
  keys() { return this.order.values(); }
  *entries() { for (const k of this.order) yield [k, this.get(k)]; }
  [Symbol.iterator]() { return this.entries(); }
}
