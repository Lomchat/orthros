// Cost of a wasm->JS import call on the page's own stack (a plain export) against on a JSPI stack (a promising export).
// Module: (import "e" "f" (func (result i32))) (func (export "run") (param i32) (result i32) loop: call f, sum, dec)
const u = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const sec = (id, body) => [id, ...u(body.length), ...body];
const str = (s) => [...u(s.length), ...Buffer.from(s)];
const types = [2, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f];
const imports = [1, ...str('e'), ...str('f'), 0, 0];
const funcs = [1, 1];
const exports = [1, ...str('run'), 0, 1];
// local 1: acc ; loop { acc += f(); n -= 1; br_if n } ; acc
const code = [1, 0x7f, 0x02, 0x03, 0x40, 0x20, 1, 0x10, 0, 0x6a, 0x21, 1, 0x20, 0, 0x41, 1, 0x6b, 0x22, 0, 0x0d, 0, 0x0b, 0x20, 1, 0x0b];
const body = [1, ...u(code.length + 2), 1, 1, 0x7f, ...code].slice(0);
// (locals: 1 entry of 1 i32) — rebuild properly
const fnBody = [1, 1, 0x7f, 0x03, 0x40, 0x20, 1, 0x10, 0, 0x6a, 0x21, 1, 0x20, 0, 0x41, 1, 0x6b, 0x22, 0, 0x0d, 0, 0x0b, 0x20, 1, 0x0b];
const codeSec = [1, ...u(fnBody.length), ...fnBody];
const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, types), ...sec(2, imports), ...sec(3, funcs), ...sec(7, exports), ...sec(10, codeSec)]);
const N = 2_000_000;
let k = 0; const f = () => (k++ & 1);
const plain = (await WebAssembly.instantiate(bytes, { e: { f } })).instance.exports.run;
const susp = (await WebAssembly.instantiate(bytes, { e: { f: new WebAssembly.Suspending(f) } })).instance.exports.run;
const prom = WebAssembly.promising(susp);
for (let r = 0; r < 3; r++) {
  let t = performance.now(); plain(N); const a = performance.now() - t;
  t = performance.now(); await prom(N); const b = performance.now() - t;
  const pp = WebAssembly.promising(plain); t = performance.now(); await pp(N); const c = performance.now() - t;
  console.log(`per call: plain export ${(a / N * 1e6).toFixed(0)} ns; promising export, Suspending import ${(b / N * 1e6).toFixed(0)} ns; promising export, plain import ${(c / N * 1e6).toFixed(0)} ns`);
}
