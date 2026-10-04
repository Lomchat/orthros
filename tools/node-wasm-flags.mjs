// Node's V8 (13.6, Node 24) ignores WebAssembly branch hints unless --experimental-wasm-branch-hinting is set, while
// Chrome honours them (shipped in Chrome 137): the translator's hints (wasm.js Code.hint) put exits, fault and slow
// paths out of line, which changes the code layout — Node measurements of translated code without the flag do not
// show the browser's instruction-cache behaviour (docs/jit-code-shape.md). Imported first by the measurement tools.
import v8 from 'node:v8';

v8.setFlagsFromString('--experimental-wasm-branch-hinting');
