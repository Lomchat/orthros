import fs from 'node:fs';

// A WebGL2 context for Node tests: every call is recorded (objects by creation number, array data by a checksum), the
// queries answer as a working context would (programs linked, framebuffers complete, no error). Two backends fed
// the same Direct3D work through two of these must produce the same call log.
// `{ reads: true }`: buffer contents are kept (bufferData / bufferSubData, with the vertex array objects' attribute
// pointers and element buffers) but their uploads and bindings are not logged; each draw is logged with a checksum
// of the bytes it reads instead — its indices and, for every vertex they name, every enabled attribute. Two backends
// that upload different ranges (a render worker copying only what draws read) must still log the same draws.
export function fakeGl(width = 800, height = 600, opts = {}) {
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
  function E(name) { let v = enums.get(name); if (v === undefined) { v = 0x10000; for (let i = 0; i < name.length; i++) v = (v * 31 + name.charCodeAt(i)) % 0xffff0000; v += 0x10000; enums.set(name, v); } return v; }
  const gl = new Proxy(answers, {
    get(t, k) {
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(k)) return k === 'TEXTURE0' ? 0x84c0 : E(k);
      const own = Object.getOwnPropertyDescriptor(t, k);
      if (own && !own.get && typeof own.value !== 'function') return own.value;
      if (own?.get) return t[k];
      const f = t[k];
      return (...a) => {
        if (sim) { const r = sim(k, a); if (r === SKIP) return f ? f(...a) : undefined; if (r !== undefined) { calls.push([k, ...a.map(norm), r]); return f ? f(...a) : undefined; } }
        // (a source view with an offset and length: only that range — the backend passes the whole guest memory)
        let args = a;
        if (k === 'bufferData' && ArrayBuffer.isView(a[1]) && a.length >= 5) args = [a[0], a[1].subarray(a[3], a[3] + a[4]), a[2]];
        else if (k === 'bufferSubData' && ArrayBuffer.isView(a[2]) && a.length >= 5) args = [a[0], a[1], a[2].subarray(a[3], a[3] + a[4])];
        calls.push([k, ...args.map(norm)]);
        return f ? f(...a) : undefined;
      };
    },
  });
  const sim = opts.reads ? readsSim(E) : null;
  return { gl, calls, canvas };
}

const SKIP = Symbol('skip');
/** the buffer side of `{ reads: true }`: a call handled (SKIP: not logged; a string: logged with it), else undefined */
function readsSim(E) {
  const data = new WeakMap(), vaos = new WeakMap(), none = { eab: null, attrs: [] };
  let arrayBuf = null, vao = none;
  const AB = E('ARRAY_BUFFER'), EAB = E('ELEMENT_ARRAY_BUFFER');
  const size = new Map([[E('FLOAT'), 4], [E('UNSIGNED_BYTE'), 1], [E('SHORT'), 2], [E('UNSIGNED_SHORT'), 2], [E('HALF_FLOAT'), 2], [E('UNSIGNED_INT'), 4]]);
  const target = (t) => (t === AB ? arrayBuf : t === EAB ? vao.eab : null);
  const bytes = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const read = (h, buf, lo, n) => { const d = buf ? data.get(buf) : null; if (!d || lo < 0 || lo + n > d.length) return Math.imul(h ^ 0x6f6f62, 0x01000193); for (let i = 0; i < n; i++) h = Math.imul(h ^ d[lo + i], 0x01000193); return h; };
  const vertex = (h, v) => { for (let i = 0; i < vao.attrs.length; i++) { const x = vao.attrs[i]; if (!x?.on || !x.p) continue; const n = x.p.comps * (size.get(x.p.type) ?? 4); h = read(Math.imul(h ^ i, 0x01000193), x.p.buf, x.p.offset + v * (x.p.stride || n), n); } return h; };
  const attr = (i) => (vao.attrs[i] ??= { on: false, p: null });
  return (k, a) => {
    switch (k) {
      case 'bindBuffer': if (a[0] === AB) arrayBuf = a[1]; else if (a[0] === EAB) vao.eab = a[1]; return SKIP;
      case 'bufferData': { const b = target(a[0]); if (!b) return SKIP; const src = a[1]; data.set(b, typeof src === 'number' ? new Uint8Array(src) : bytes(src).slice(a[3] ?? 0, a.length >= 5 ? (a[3] ?? 0) + a[4] : undefined)); return SKIP; }
      case 'bufferSubData': { const b = target(a[0]), d = b ? data.get(b) : null; if (!d) return SKIP; const src = bytes(a[2]).subarray(a[3] ?? 0, a.length >= 5 ? (a[3] ?? 0) + a[4] : undefined); d.set(src.subarray(0, Math.max(0, Math.min(src.length, d.length - a[1]))), a[1]); return SKIP; }
      case 'bindVertexArray': if (!a[0]) vao = none; else { let v = vaos.get(a[0]); if (!v) vaos.set(a[0], (v = { eab: null, attrs: [] })); vao = v; } return undefined;
      case 'enableVertexAttribArray': attr(a[0]).on = true; return undefined;
      case 'disableVertexAttribArray': attr(a[0]).on = false; return undefined;
      case 'vertexAttribPointer': attr(a[0]).p = { buf: arrayBuf, comps: a[1], type: a[2], stride: a[4], offset: a[5] }; return undefined;
      case 'drawArrays': { let h = 0x811c9dc5; for (let v = a[1]; v < a[1] + a[2]; v++) h = vertex(h, v); return `reads:${(h >>> 0).toString(16)}`; }
      case 'drawElements': {
        const isz = size.get(a[2]) ?? 2, d = vao.eab ? data.get(vao.eab) : null;
        let h = 0x811c9dc5;
        for (let i = 0; i < a[1]; i++) {
          const p = a[3] + i * isz;
          if (!d || p + isz > d.length) { h = Math.imul(h ^ 0x6f6f62, 0x01000193); continue; }
          const v = isz === 2 ? d[p] | d[p + 1] << 8 : isz === 1 ? d[p] : (d[p] | d[p + 1] << 8 | d[p + 2] << 16 | d[p + 3] << 24) >>> 0;
          h = vertex(Math.imul(h ^ v, 0x01000193), v);
        }
        return `reads:${(h >>> 0).toString(16)}`;
      }
      default: return undefined;
    }
  };
}

// one numbering for every context, in every thread (their logs compare): the names the backend uses, sorted
const enums = new Map();
for (const f of ['../src/gfx/d3d8-webgl.js']) {
  const names = [...new Set([...fs.readFileSync(new URL(f, import.meta.url), 'utf8').matchAll(/\bgl\.([A-Z][A-Z0-9_]+)\b/g)].map((m) => m[1]))].sort();
  for (const n of names) enums.set(n, 0x1000 + enums.size);
}
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
