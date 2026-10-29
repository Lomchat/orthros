// Put into the OpenMW engine's page by the Orthros server (src/host/openmw.js withWasmStream), ahead of the engine's
// Module literal and glue: the engine's module compiled in a worker (wasm-compile-worker.js) and instantiated here,
// through the engine glue's Module.instantiateWasm (docs/openmw.md "Chrome's code cache off the main thread"). Chrome
// keeps a WebAssembly code cache for a module streamed from a fetched answer, and works it on the thread that compiled
// it: read at the compile (wasm.Deserialize, 270-320 ms), then — each time V8 has ~1 MB of new optimized code — the
// whole module serialized again (20-50 ms on a thread-pool thread) and its 18-25 MB copy handed to the cache by that
// thread (OnMoreFunctionsCanBeSerialized: 21-57 ms measured on the page's main thread, a task with no script —
// "(program)" in a profile; six in the first 30 s of play on a first visit after a release, one or two on later
// visits). Compiled in the worker, all of that runs on the worker's thread; the module is the same (its code, its
// tier-up shared with the page's instance and the pthreads, which instantiate the module the page posts them, as before).
// The worker is started as this script runs (its script and its isolate ready while the glue downloads), told the
// module's URL when the glue asks. The worker failing: the module streamed here as the glue did. The instantiation
// failing, or the module unavailable here as well: the glue's abort (Module.onAbort, the page's fatal overlay).
// ?omwenv=OPENMW_ORTHROS_WASMWORKER=0: the glue's own path.
(() => {
  const env = /[?&]omwenv=([^&]*)/.exec(location.search);
  let off = false; try { off = !!env && decodeURIComponent(env[1]).split(',').includes('OPENMW_ORTHROS_WASMWORKER=0'); } catch { /* a malformed address: on */ }
  if (off || typeof Worker !== 'function' || typeof WebAssembly !== 'object' || typeof WebAssembly.compileStreaming !== 'function') return;
  let worker = null; // (kept for the page's life: the cache's later writes run on its thread)
  /** @type {Promise<WebAssembly.Module>} the worker's answer */
  let answer;
  try {
    const w = worker = new Worker('/src/ports/openmw/wasm-compile-worker.js');
    answer = new Promise((resolve, reject) => {
      w.onmessage = (e) => (e.data && e.data.module instanceof WebAssembly.Module ? resolve(e.data.module) : reject(new Error((e.data && e.data.error) || 'no module')));
      w.onerror = (e) => { e.preventDefault(); reject(new Error(e.message || 'worker failed')); };
    });
  } catch (e) { worker = null; answer = Promise.reject(e); }
  answer.catch(() => { /* reported when the glue asks */ });
  // (the glue's Module.instantiateWasm(imports, receive): receive(instance, module) once instantiated; its return unused)
  window.orthrosInstantiateWasm = function (imports, receive) {
    const M = window.Module, url = new URL(M && M.locateFile ? M.locateFile('openmw.wasm') : 'openmw.wasm', location.href).href;
    const here = () => WebAssembly.instantiateStreaming(fetch(url, { credentials: 'same-origin' }), imports)
      .catch(() => fetch(url, { credentials: 'same-origin' }).then((r) => r.arrayBuffer()).then((b) => WebAssembly.instantiate(b, imports)));
    if (worker) worker.postMessage({ url });
    answer
      .then((module) => ({ module }), (e) => { console.warn('[orthros wasm] compiled here:', e && e.message); if (worker) worker.terminate(); worker = null; return null; })
      // (only the worker's failure falls back: an instantiation error would be the same here, so it is reported)
      .then((c) => (c ? WebAssembly.instantiate(c.module, imports).then((instance) => ({ instance, module: c.module })) : here()))
      .then((r) => receive(r.instance, r.module))
      .catch((e) => {
        // (as the glue's own path ends: its abort calls Module.onAbort, the page's fatal overlay, then throws)
        console.error('[orthros wasm] failed to prepare the module:', e);
        const m = window.Module;
        if (m && typeof m.onAbort === 'function') m.onAbort(e); else throw e;
      });
    return {};
  };
})();
