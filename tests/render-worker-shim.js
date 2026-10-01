// The browser render worker (src/gfx/render-worker.js) in a Node worker thread: `self`, OffscreenCanvas (a recording
// WebGL2 context, tests/fake-gl.js), ImageBitmap (an ArrayBuffer) shimmed. {type: 'test-calls'} answers the call log.
import { parentPort } from 'node:worker_threads';
import { fakeGl } from './fake-gl.js';

const canvases = [];
globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
parentPort.on('message', (m) => {
  if (m?.type === 'test-calls') { parentPort.postMessage({ type: 'test-calls', calls: canvases.find((c) => c.G)?.G.calls ?? [] }); return; }
  self.onmessage?.({ data: m });
});
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; this.G = null; canvases.push(this); }
  getContext() { this.G = fakeGl(this.width, this.height); return this.G.gl; }
  transferToImageBitmap() { return new ArrayBuffer(8); }
  addEventListener() {}
};
await import('../src/gfx/render-worker.js');
