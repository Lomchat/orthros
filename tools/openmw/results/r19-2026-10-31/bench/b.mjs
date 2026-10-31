// node b.mjs or in a page: times per call at each depth, plain vs promising
export async function bench(bytes, log = console.log) {
  const env = { now: () => performance.now(), imp: (x) => x + 1 };
  const { instance } = await WebAssembly.instantiate(bytes, { env });
  const run = instance.exports.run, prom = WebAssembly.promising(instance.exports.run2);
  const out = [];
  for (const mode of [0, 1]) for (const d of [0, 1, 2, 5, 10, 20, 50, 100, 200, 400, 800, 1024, 1500, 2000, 3000]) {
    const n = mode ? 200000 : 400000;
    const t = (f) => { let best = 1e9; for (let k = 0; k < 4; k++) { const t0 = performance.now(); const r = f(); best = Math.min(best, performance.now() - t0); } return best; };
    run(d, 1000, mode); await prom(d, 1000, mode);
    const a = t(() => run(d, n, mode));
    let b = 1e9; for (let k = 0; k < 4; k++) { const t0 = performance.now(); await prom(d, n, mode); b = Math.min(b, performance.now() - t0); }
    const row = { mode: mode ? 'import' : 'calls', depth: d, plainNs: +(a * 1e6 / n).toFixed(2), jspiNs: +(b * 1e6 / n).toFixed(2) };
    out.push(row); log(JSON.stringify(row));
  }
  return out;
}
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('b.mjs')) { const fs = await import('fs'); await bench(fs.readFileSync(new URL('./b.wasm', import.meta.url))); }
