// The OpenMW engine module compiled off the page's main thread (src/ports/openmw/wasm-code-cache.js): streamed from its
// fetched answer here, so Chrome's WebAssembly code cache — read at the compile, written again each time V8 has more
// optimized code — works on this worker's thread, the page's main thread never. The compiled module goes to the page
// (one module: the page's instance and its pthreads share its code and its tier-up). Kept alive by the page for that.
self.onmessage = (e) => {
  WebAssembly.compileStreaming(fetch(e.data.url, { credentials: 'same-origin' }))
    .then((module) => self.postMessage({ module }), (err) => self.postMessage({ error: String((err && err.message) || err) }));
};
