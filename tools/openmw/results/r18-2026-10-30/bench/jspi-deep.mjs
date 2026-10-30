// Cost of one suspension and resume of a promising export at stack depth D (wasm frames below the suspending call).
const u = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const sec = (id, body) => [id, ...u(body.length), ...body];
const str = (s) => [...u(s.length), ...new TextEncoder().encode(s)];
// type0: (i32)->i32 ; import f: type0 ; func1 rec(n): if n==0 then f(0) else rec(n-1)+0 ; export "rec"
const types = [1, 0x60, 1, 0x7f, 1, 0x7f];
const imports = [1, ...str('e'), ...str('f'), 0, 0];
const funcs = [1, 0];
const exports = [1, ...str('rec'), 0, 1];
const fn = [0, 0x20, 0, 0x45, 0x04, 0x7f, 0x41, 0, 0x10, 0, 0x05, 0x20, 0, 0x41, 1, 0x6b, 0x10, 1, 0x41, 1, 0x6a, 0x0b, 0x0b];
const code = [1, ...u(fn.length), ...fn];
const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, types), ...sec(2, imports), ...sec(3, funcs), ...sec(7, exports), ...sec(10, code)]);
const f = new WebAssembly.Suspending(async () => { await null; return 0; });
const rec = WebAssembly.promising((await WebAssembly.instantiate(bytes, { e: { f } })).instance.exports.rec);
for (const D of [0, 1024, 4096]) {
  for (let i = 0; i < 200; i++) await rec(D);
  const N = 5000, t = performance.now(); for (let i = 0; i < N; i++) await rec(D);
  console.log(`depth ${D}: ${((performance.now() - t) / N * 1000).toFixed(1)} us per call with one suspension`);
}
