// The OpenMW engine page's module compiled in a worker (src/ports/openmw/wasm-code-cache.js, wasm-compile-worker.js,
// src/host/openmw.js withWasmStream): the glue's Module.instantiateWasm given the page's hook, the module the worker
// compiled from the engine's URL instantiated here; the worker failing, the module streamed here; an instantiation that
// fails, or no module anywhere: Module.onAbort, as the glue's abort; ?omwenv=OPENMW_ORTHROS_WASMWORKER=0 leaves no hook
// (the glue's own path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { withWasmStream } from '../src/host/openmw.js';

const SCRIPT = fs.readFileSync(new URL('../src/ports/openmw/wasm-code-cache.js', import.meta.url), 'utf8');
/** The smallest WebAssembly module (its header). */
const EMPTY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** A module that imports a.b (a function): its instantiation with no such import fails. */
const IMPORTING = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 7, 1, 1, 97, 1, 98, 0, 0]);

/**
 * The script run in a page at `search` whose worker answers `answer(url)` ({ module } or { error }), fails to load
 * (`answer` null) or cannot be made (`answer` 'throw'); `fetchFails`: every fetch rejected. The page's window, the
 * workers made, what fetch and instantiateStreaming were asked and what Module.onAbort was given.
 */
function page(search, answer, { fetchFails = false } = {}) {
  const workers = [], fetched = [], streamed = [], aborted = [];
  class FakeWorker {
    constructor(src) { if (answer === 'throw') throw new Error('SecurityError'); this.src = src; this.terminated = false; workers.push(this); }
    postMessage(m) {
      this.posted = m;
      setTimeout(() => (answer ? this.onmessage({ data: answer(m.url) }) : this.onerror({ message: 'blocked', preventDefault() {} })), 0);
    }
    terminate() { this.terminated = true; }
  }
  const WA = { Module: WebAssembly.Module, Instance: WebAssembly.Instance, instantiate: WebAssembly.instantiate.bind(WebAssembly), compileStreaming() {},
    instantiateStreaming: (source, imports) => Promise.resolve(source).then((r) => { streamed.push(r); return WebAssembly.instantiate(EMPTY, imports); }) };
  const window = { location: { search, href: 'http://x/ports/openmw/m/app/index.html' + search }, Module: { locateFile: (p) => '/engines/_c/abc/' + p, onAbort: (w) => aborted.push(w) } };
  const context = vm.createContext({ window, location: window.location, WebAssembly: WA, Worker: FakeWorker, URL, Promise, Error, setTimeout, decodeURIComponent, console: { warn() {}, error() {} },
    fetch: (url, o) => { fetched.push({ url, o }); return fetchFails ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response(EMPTY, { headers: { 'content-type': 'application/wasm' } })); } });
  vm.runInContext(SCRIPT, context);
  return { window, workers, fetched, streamed, aborted };
}

/** The page's hook called as the glue does, for a failure: what Module.onAbort got (receive must not be called). */
const failing = (p, imports = {}) => new Promise((resolve, reject) => {
  p.window.orthrosInstantiateWasm(imports, () => reject(new Error('received')));
  const wait = () => (p.aborted.length ? resolve(p.aborted[0]) : setTimeout(wait, 1));
  wait();
});

/** The page's hook called as the glue does: (instance, module) once received. */
const instantiate = (p, imports = {}) => new Promise((resolve) => { const back = p.window.orthrosInstantiateWasm(imports, (instance, module) => resolve({ instance, module })); assert.deepEqual(Object.keys(back), []); });

test("withWasmStream puts the script in the page's head, ahead of the Module literal, and gives the glue its hook", () => {
  const out = withWasmStream('<html><head><script src="/src/ports/openmw/frame-meter.js"></script></head><script>\n var Module = {\n   locateFile: f,\n</script></html>');
  assert.ok(out.startsWith('<html><head><script src="/src/ports/openmw/wasm-code-cache.js"></script><script src="/src/ports/openmw/frame-meter.js">'));
  assert.ok(out.includes('var Module = {\n   instantiateWasm: window.orthrosInstantiateWasm,\n   locateFile: f,'));
});

test("the worker's module, compiled from the engine's URL, instantiated here; the worker started early and kept", async () => {
  const module = new WebAssembly.Module(EMPTY);
  const p = page('?src=hosted', () => ({ module }));
  assert.equal(p.workers.length, 1); assert.equal(p.workers[0].posted, undefined); // (made as the script ran, before the glue asks)
  const r = await instantiate(p);
  assert.equal(p.workers.length, 1);
  assert.equal(p.workers[0].src, '/src/ports/openmw/wasm-compile-worker.js');
  assert.deepEqual(Object.keys(p.workers[0].posted), ['url']); assert.equal(p.workers[0].posted.url, 'http://x/engines/_c/abc/openmw.wasm');
  assert.equal(r.module, module); assert.ok(r.instance instanceof WebAssembly.Instance);
  assert.equal(p.workers[0].terminated, false);
  assert.equal(p.fetched.length, 0);
});

test('a worker that fails or answers no module: the module streamed here from the same URL', async () => {
  for (const answer of [null, () => ({ error: 'CompileError' }), () => ({ module: {} }), 'throw']) {
    const p = page('', answer);
    const r = await instantiate(p);
    assert.equal(p.fetched.length, 1); assert.equal(p.fetched[0].url, 'http://x/engines/_c/abc/openmw.wasm'); assert.equal(p.fetched[0].o.credentials, 'same-origin');
    assert.equal(p.streamed.length, 1);
    assert.ok(r.instance instanceof WebAssembly.Instance);
    if (answer === 'throw') assert.equal(p.workers.length, 0); else assert.equal(p.workers[0].terminated, true);
    assert.deepEqual(p.aborted, []);
  }
});

test("the worker's module failing to instantiate: reported through Module.onAbort, not compiled again here", async () => {
  const p = page('', () => ({ module: new WebAssembly.Module(IMPORTING) }));
  const reason = await failing(p);
  assert.ok(reason instanceof Error, String(reason));
  assert.equal(p.fetched.length, 0); assert.equal(p.streamed.length, 0);
});

test('the worker failing and the module unavailable here too: Module.onAbort, as the glue\'s abort', async () => {
  const p = page('', () => ({ error: 'NetworkError' }), { fetchFails: true });
  const reason = await failing(p);
  assert.match(String(reason && reason.message), /Failed to fetch/);
  assert.equal(p.fetched.length, 2); // (streamed, then as a whole)
});

test('?omwenv=OPENMW_ORTHROS_WASMWORKER=0 gives no hook (the glue compiles as before)', () => {
  for (const q of ['?omwenv=OPENMW_ORTHROS_WASMWORKER=0', '?x=1&omwenv=OPENMW_ORTHROS_UNIFORMS=0%2COPENMW_ORTHROS_WASMWORKER=0']) assert.equal(page(q, null).window.orthrosInstantiateWasm, undefined, q);
  assert.equal(typeof page('?omwenv=OPENMW_ORTHROS_UNIFORMS=0', null).window.orthrosInstantiateWasm, 'function');
});
