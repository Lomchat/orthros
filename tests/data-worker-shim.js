// The data worker (src/vfs/data-worker.js) in a Node worker thread, for tests/http-backend-fuzz.test.js: the game's
// files answered by stand-ins of fetch (asynchronous, answered after a random moment) and of the synchronous
// XMLHttpRequest, every byte a function of its file and offset (byteOf), so that the emulator's side checks what it reads.
import { parentPort, workerData } from 'node:worker_threads';
import { createDataWorker } from '../src/vfs/data-worker.js';

const { sizes } = workerData;
/** The byte at `i` of file `name` (the test's own copy of this function says what a read must return). */
const byteOf = (name, i) => ((i * 2654435761) ^ (name.length * 40503) ^ (i >>> 11)) & 0xff;
const bytes = (url, a, b) => {
  const name = decodeURIComponent(/\/game\/[^/]+\/([^?]+)/.exec(url)[1]), size = sizes[name], out = new Uint8Array(Math.max(0, Math.min(b, size - 1) - a + 1));
  for (let i = 0; i < out.length; i++) out[i] = byteOf(name, a + i);
  return out;
};
let seed = 12345;
const rand = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
  const range = init.headers?.Range ?? init.headers?.range;
  if (!range) { reject(new Error('no range')); return; }
  const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range);
  const t = setTimeout(() => { const d = bytes(url, +a, +b); resolve({ ok: true, status: 206, headers: { get: () => null }, arrayBuffer: async () => d.buffer }); }, Math.floor(rand() * 4));
  init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('AbortError')); });
});
globalThis.XMLHttpRequest = class {
  open(m, url) { this.url = url; }
  setRequestHeader(k, v) { this.range = v; }
  getResponseHeader() { return null; }
  send() { const [, a, b] = /bytes=(\d+)-(\d+)/.exec(this.range); this.status = 206; this.response = bytes(this.url, +a, +b).buffer; }
};
const handle = createDataWorker((m) => parentPort.postMessage(m));
parentPort.on('message', handle);
