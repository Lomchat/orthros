// A WebGL2 context for Node tests: every call is recorded (objects by creation number, array data by a checksum), the
// queries answer as a working context would (programs linked, framebuffers complete, no error). Two backends fed
// the same Direct3D work through two of these must produce the same call log.
export function fakeGl(width = 800, height = 600) {
  const calls = [], ids = new WeakMap();
  let next = 1;
  const canvas = { width, height };
  const norm = (x) => {
    if (x === null || x === undefined || typeof x === 'number' || typeof x === 'boolean') return x;
    if (typeof x === 'string') return x.length > 40 ? `str${x.length}:${hash(new TextEncoder().encode(x))}` : x;
    if (ArrayBuffer.isView(x)) return `data${x.byteLength}:${hash(new Uint8Array(x.buffer, x.byteOffset, x.byteLength))}`;
    if (typeof x === 'object') { let id = ids.get(x); if (!id) ids.set(x, (id = next++)); return `#${id}`; }
    return String(x);
  };
  const obj = () => { const o = {}; ids.set(o, next++); return o; };
  const answers = {
    canvas, get drawingBufferWidth() { return canvas.width; }, get drawingBufferHeight() { return canvas.height; },
    createTexture: obj, createBuffer: obj, createFramebuffer: obj, createRenderbuffer: obj, createVertexArray: obj, createSampler: obj, createProgram: obj, createShader: obj, fenceSync: obj,
    getParameter: (p) => (p === E('MAX_COMBINED_TEXTURE_IMAGE_UNITS') ? 32 : p === E('MAX_TEXTURE_SIZE') ? 4096 : p === E('RENDERER') ? 'fake' : 0),
    getExtension: () => null,
    getProgramParameter: (p, q) => (q === E('ACTIVE_UNIFORMS') || q === E('ACTIVE_ATTRIBUTES') ? 0 : true),
    getShaderParameter: () => true, getProgramInfoLog: () => '', getShaderInfoLog: () => '',
    getUniformLocation: (p, n) => ({ n }), getActiveUniform: () => ({ name: '' }),
    checkFramebufferStatus: () => E('FRAMEBUFFER_COMPLETE'), getError: () => 0, getVertexAttrib: () => 0, getSyncParameter: () => E('SIGNALED'),
    isEnabled: () => false,
  };
  function E(name) { let v = enums.get(name); if (v === undefined) enums.set(name, (v = 0x1000 + enums.size)); return v; }
  const gl = new Proxy(answers, {
    get(t, k) {
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(k)) return k === 'TEXTURE0' ? 0x84c0 : E(k);
      const own = Object.getOwnPropertyDescriptor(t, k);
      if (own && !own.get && typeof own.value !== 'function') return own.value;
      if (own?.get) return t[k];
      const f = t[k];
      return (...a) => {
        // (a source view with an offset and length: only that range — the backend passes the whole guest memory)
        let args = a;
        if (k === 'bufferData' && ArrayBuffer.isView(a[1]) && a.length >= 5) args = [a[0], a[1].subarray(a[3], a[3] + a[4]), a[2]];
        else if (k === 'bufferSubData' && ArrayBuffer.isView(a[2]) && a.length >= 5) args = [a[0], a[1], a[2].subarray(a[3], a[3] + a[4])];
        calls.push([k, ...args.map(norm)]);
        return f ? f(...a) : undefined;
      };
    },
  });
  return { gl, calls, canvas };
}

const enums = new Map(); // (one numbering for every context: their logs compare)
function hash(b) { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193); return (h >>> 0).toString(16); }

/** index and context of the first difference between two call logs, or null */
export function firstDifference(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
    if (x !== y) return { index: i, a: a.slice(Math.max(0, i - 4), i + 3).map((c) => JSON.stringify(c)), b: b.slice(Math.max(0, i - 4), i + 3).map((c) => JSON.stringify(c)), lengths: [a.length, b.length] };
  }
  return null;
}
