// A fine depth sweep, plain vs promising, and the same in a dedicated worker (pthreads' entry is promising under -sJSPI)
export const sweepSrc = `
async function sweep(bytes) {
  const env = { now: () => performance.now(), imp: (x) => x + 1 };
  const { instance } = await WebAssembly.instantiate(bytes, { env });
  const run = instance.exports.run, prom = WebAssembly.promising(instance.exports.run2);
  const res = { calls: [], imports: [] };
  for (const [mode, key, n] of [[0, 'calls', 20000], [1, 'imports', 20000]]) {
    for (let d = 0; d <= 4000; d += (d < 400 ? 1 : 7)) {
      run(d, 200, mode); await prom(d, 200, mode);
      let a = 1e9, b = 1e9;
      for (let k = 0; k < 3; k++) { let t0 = performance.now(); run(d, n, mode); a = Math.min(a, performance.now() - t0); t0 = performance.now(); await prom(d, n, mode); b = Math.min(b, performance.now() - t0); }
      res[key].push([d, +(a * 1e6 / n).toFixed(1), +(b * 1e6 / n).toFixed(1)]);
    }
  }
  return res;
}`;
