// The flicker capture (src/gfx/flicker-capture.js) rides along every session's presents: until a probe sample finds
// strong flicker it must do nothing at all (no GL method wrapped, no query), then record a few frames once, give the
// context its own methods back, and send one record that names what differs between the frames; that record must fit
// the size the server takes (src/shared/flicker-record.js), which takes it while other telemetry keeps its own limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlickerProbe, PERIOD_MS, W, H } from '../src/gfx/flicker-probe.js';
import { CAPTURE_MAX_BYTES, CAPTURE_POST_MAX_BYTES, fitRecord, diffRecord } from '../src/shared/flicker-record.js';
import { createServer } from '../src/server/server.js';

/** A WebGL2 context whose methods live on its prototype (as a real one's: the capture wraps those), constants by name. */
function protoGl(answers) {
  const calls = [], enums = new Map();
  const E = (k) => { if (!enums.has(k)) enums.set(k, k === 'TEXTURE0' ? 0x84c0 : 0x10000 + enums.size); return enums.get(k); };
  class G {}
  for (const k of ['bindFramebuffer', 'framebufferTexture2D', 'framebufferRenderbuffer', 'blitFramebuffer', 'createTexture', 'createFramebuffer', 'createRenderbuffer', 'createBuffer', 'createVertexArray',
    'createProgram', 'createShader', 'shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'useProgram', 'getUniformLocation', 'uniform1i', 'uniform2i', 'uniform4fv', 'bindTexture', 'activeTexture',
    'texStorage2D', 'texParameteri', 'bindSampler', 'bindVertexArray', 'drawArrays', 'enable', 'disable', 'colorMask', 'viewport', 'bindBuffer', 'bufferData', 'readPixels', 'fenceSync', 'getSyncParameter',
    'deleteSync', 'deleteBuffer', 'deleteTexture', 'deleteFramebuffer', 'deleteRenderbuffer', 'getBufferSubData', 'renderbufferStorage', 'bindRenderbuffer', 'getError', 'getParameter', 'isEnabled',
    'checkFramebufferStatus', 'clear', 'getExtension', 'getSupportedExtensions', 'getContextAttributes', 'getShaderPrecisionFormat']) {
    G.prototype[k] = function (...a) { calls.push([k, ...a]); return answers[k]?.(...a); };
  }
  const obj = () => ({});
  Object.assign(answers, { createTexture: obj, createFramebuffer: obj, createRenderbuffer: obj, createBuffer: obj, createVertexArray: obj, createProgram: obj, createShader: obj, fenceSync: obj,
    getSyncParameter: () => E('SIGNALED'), checkFramebufferStatus: () => E('FRAMEBUFFER_COMPLETE'), getError: () => 0, getParameter: () => 0, isEnabled: () => false, getUniformLocation: (p, n) => ({ n }) });
  const gl = new Proxy(new G(), { get: (t, k, r) => (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? E(k) : k === 'drawingBufferWidth' ? 800 : k === 'drawingBufferHeight' ? 600 : Reflect.get(t, k, r)) });
  return { gl, calls, G };
}

test('no work until a sample flickers; then one capture of the next frames, the GL methods given back, a record that names what alternates', async () => {
  let flicker = false;
  const answers = { getBufferSubData: (t, off, px) => { if (px.length === W * H * 4) { if (flicker) for (let i = 0; i < W * H; i++) { px[4 * i] = 255; px[4 * i + 1] = 255; px[4 * i + 3] = 255; } } else px.fill(7); } };
  const { gl, calls, G } = protoGl(answers), orig = Object.fromEntries(Object.getOwnPropertyNames(G.prototype).map((k) => [k, G.prototype[k]]));
  const unwrapped = () => Object.keys(orig).every((k) => G.prototype[k] === orig[k]);
  let t = 0;
  const sent = [], probe = new FlickerProbe(gl, { now: () => t, send: (r) => sent.push(r), encode: async (imgs) => imgs.map(() => 'QUJD') });
  const fbo = {}, rt = {}, prog = {}, frame = (count) => { gl.bindFramebuffer(gl.FRAMEBUFFER, rt); gl.useProgram(prog); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.drawArrays(gl.TRIANGLES, 0, count); };
  // three sample periods without flicker: the probe's own work only
  for (let i = 0; i < 3 * 30 + 10; i++) { frame(6); probe.present(fbo, 800, 600); t += PERIOD_MS / 30; }
  assert.equal(probe.stats.n, 3, 'samples measured');
  assert.ok(unwrapped(), 'no GL method wrapped');
  assert.equal(calls.filter((c) => /^(getParameter|getSupportedExtensions|getError|isEnabled)$/.test(c[0])).length, 3, 'no query but the probe\'s getError, one per sample');
  // a sample that flickers: the next presents are the capture's (one warm-up frame, three kept)
  flicker = true; t += PERIOD_MS;
  let k = 0;
  while (!probe.cap && k++ < 10) { frame(6); probe.present(fbo, 800, 600); t += 33; }
  assert.ok(probe.cap, 'a capture started');
  assert.ok(!unwrapped(), 'the GL methods wrapped while it records');
  flicker = false;
  for (const count of [6, 6, 9, 6]) { frame(count); probe.present(fbo, 800, 600); t += 33; } // (the warm-up frame, then frames 1-3: the second draws 9)
  assert.ok(unwrapped(), 'the prototype has its own methods back');
  for (let i = 0; i < 3 && !sent.length; i++) { probe.present(fbo, 800, 600); await new Promise((r) => setTimeout(r, 0)); }
  assert.equal(sent.length, 1, 'one record sent');
  const rec = sent[0];
  assert.equal(rec.frames.length, 3); assert.deepEqual(rec.images, ['QUJD', 'QUJD', 'QUJD']); assert.equal(rec.trigger.still, 100);
  assert.deepEqual(rec.frames.map((f) => f.draws), [2, 2, 2]);
  assert.ok(JSON.stringify(rec).length <= CAPTURE_MAX_BYTES);
  assert.equal(rec.diff['1-3'].passes.length, 0, 'frames 1-3: the same');
  assert.deepEqual(rec.alt.fields, { call: 1 }, 'what alternates: that draw\'s call, alone');
  // later flicker: no second capture in the session
  flicker = true;
  for (let i = 0; i < 40; i++) { frame(6); probe.present(fbo, 800, 600); t += PERIOD_MS / 10; }
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1, 'once per session'); assert.ok(unwrapped());
});

test('a capture fits its size: the record cut on the page, taken by the server while other telemetry keeps 256 KB', async (t) => {
  // (a heavy frame: 40 passes x 1500 distinct draws per frame, pictures of 100-150 KB each)
  const frames = [0, 1, 2].map((f) => ({ ms: 33, info: {}, calls: 9000, draws: 60000, passes: Array.from({ length: 40 }, (_, p) => ({ fb: `F${p}`, ev: Array.from({ length: 1500 }, (_, i) => f === 1 && p === 7 ? 60000 + i : p * 1500 + i) })), ups: [], att: [], errs: [] }));
  const draws = []; for (let i = 0; i < 60000; i++) draws.push([`P${i % 300}`, `0:T${i % 900}/S2 1:T${i % 7}`, i % 40, '0,0,2560,1440', 'V3#a1b2c3', 'B9', `e TRIANGLES ${i} UNSIGNED_SHORT @0`, 'deadbeef', '']);
  for (let i = 0; i < 1500; i++) draws.push(draws[7 * 1500 + i].map((v, k) => (k === 1 ? v + '+1' : v)));
  const rec = { event: 'flicker-capture', v: 1, frames, draws, states: [], objs: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`T${i}`, { kind: 'tex', size: '512x512', fmt: 21 }])), drawFields: [] };
  rec.diff = diffRecord(rec, 24);
  await fitRecord(rec, async (q) => [0, 1, 2].map(() => 'A'.repeat(Math.round(200000 * q))));
  assert.ok(JSON.stringify(rec).length <= CAPTURE_MAX_BYTES, `${JSON.stringify(rec).length} characters`);
  assert.equal(rec.images.length, 3, 'the pictures kept'); assert.ok(rec.diff['1-2'].passes.length >= 1, 'the diff kept');
  assert.ok(rec.draws[rec.diff['1-2'].passes[0].changed[0][0]], 'with the draws it names');
  // the server: a capture up to its limit taken and written, a larger one and a larger batch refused
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-flicker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tel = path.join(root, 'tel'); fs.mkdirSync(tel); fs.mkdirSync(path.join(root, 'games'));
  const server = createServer({ gamesDir: path.join(root, 'games'), enginesDir: path.join(root, 'engines'), telemetryDir: tel, lanLog: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
  const capture = (bytes) => ({ ...rec, session: 'sess1234', images: ['QUJD'], pad: 'x'.repeat(bytes) });
  assert.equal(await post(capture(CAPTURE_MAX_BYTES - JSON.stringify(rec).length)), 204);
  assert.equal(await post(capture(CAPTURE_POST_MAX_BYTES)), 413);
  assert.equal(await post({ session: 'sess1234', samples: [{ pad: 'x'.repeat(300 * 1024) }] }), 413, 'a batch keeps its 256 KB');
  await new Promise((r) => setTimeout(r, 100));
  const lines = fs.readdirSync(tel).flatMap((f) => fs.readFileSync(path.join(tel, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1); assert.equal(lines[0].event, 'flicker-capture'); assert.equal(lines[0].pad, undefined, 'rebuilt from its known fields');
});
