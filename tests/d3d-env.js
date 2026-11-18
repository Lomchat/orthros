// A minimal VM for Direct3D (guest memory, allocator, COM objects, a call context): the render worker tests'
// (d3d-random.js) and the browser checks' (tools/check/draw-probe-check.mjs) — no Node module here, a page loads it too.
import { GuestMemory } from '../src/cpu/memory.js';
import { registerDirect3D9 } from '../src/win32/d3d9.js';
import { registerDirect3D8 } from '../src/win32/d3d8.js';

/** A minimal VM for Direct3D: guest memory, allocator, COM objects (pointers reused once released), a call context. */
export function d3dEnv(gfx, shared = false, sizeBytes = 64 << 20) { // (sizeBytes null: the whole guest space, for the JIT)
  const mem = new GuestMemory({ sizeBytes, shared });
  let top = 0x100000; const freed = new Map(); // size -> addresses (reused: memory recycled like a real heap)
  const alloc = (n) => { n = (Math.max(n, 16) + 15) & ~15; const l = freed.get(n); if (l?.length) return l.pop(); const a = top; top += n; if (top > (60 << 20)) throw new Error('test heap full'); return a; };
  const sizes = new Map();
  const vmem = { alloc: (n) => { const a = alloc(n); sizes.set(a, (Math.max(n, 16) + 15) & ~15); return a; }, release: (a) => { const n = sizes.get(a); if (!n) throw new Error(`release of ${a.toString(16)}: not allocated`); sizes.delete(a); mem.fill(a, n, 0xcd); (freed.get(n) ?? freed.set(n, []).get(n)).push(a); } };
  const proc = { mem, vmem, processHeap: { alloc: (n) => vmem.alloc(n), free_: (p) => vmem.release(p) }, symbolize: () => '?' };
  const objects = new Map();
  const com = {
    objects, interface() {}, supports: () => true,
    create(p, iface, impl, extra = 0) { const ptr = proc.processHeap.alloc(24 + extra); const obj = { ptr, impl, refs: 1, proc: p }; objects.set(ptr, obj); impl.comObject = obj; return ptr; },
    objectAt: (ptr) => objects.get(ptr >>> 0) ?? null, implAt: (ptr) => objects.get(ptr >>> 0)?.impl ?? null,
    addRef: (o) => ++o.refs,
    release(o) { if (--o.refs > 0) return o.refs; if (o.impl.keepAlive) { o.refs = 0; return 0; } com.dispose(o); return 0; },
    unpin(impl) { const o = impl?.comObject; if (o && objects.get(o.ptr) === o && o.refs <= 0) com.dispose(o); },
    dispose(o) { objects.delete(o.ptr); mem.write32(o.ptr + 4, 0); try { o.impl.destroy?.(o); } finally { mem.write32(o.ptr + 12, 0); mem.write32(o.ptr + 20, 0); proc.processHeap.free_(o.ptr); } }, // (as com.js)
  };
  const vm = { mem, com, proc, host: { gfx }, log() {}, clock: { now: () => 0 }, recentApiCalls: () => [], startApiBurst() {} };
  const defs = {};
  const api = { define(dll, d) { Object.assign(defs, d); } };
  registerDirect3D8(api, vm); registerDirect3D9(api, vm);
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  const ctx = (args) => ({ args, proc, thread: { id: 1 }, retAddr: 0, arg(i) { return (this.args[i] ?? 0) >>> 0; }, sarg(i) { return (this.args[i] ?? 0) | 0; }, argF32(i) { u32[0] = this.args[i] ?? 0; return f32[0]; }, out32(i, v) { const a = this.arg(i); if (a) mem.write32(a, v >>> 0); } });
  return { mem, proc, com, vm, defs, ctx, alloc: vmem.alloc };
}
