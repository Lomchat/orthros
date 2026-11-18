// The draw probe (src/gfx/draw-probe.js): the owner's RotWK pause menu showed its darkening layer fainter one frame in
// three on his GPU only, under one command signature. The probe must start by itself on such a screen (no click: a
// still screen whose commands stay the same over two flicker samples), copy the target around the frame's last draws
// only while it records (nothing per draw otherwise), take the game's own TEXTUREFACTOR from the producer — through
// the command ring when a render worker draws: a replay fault shows as the two differing —, send no uniform again, and
// send one record the server takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d3dEnv } from './d3d-random.js';
import { WebGLDevice } from '../src/gfx/d3d8-webgl.js';
import { FlickerProbe } from '../src/gfx/flicker-probe.js';
import { fakeGl } from './fake-gl.js';
import { Replayer } from '../src/gfx/d3d-mirror.js';
import { RenderLink, Recorder } from '../src/gfx/d3d-recorder.js';
import { DRAW_PROBE_MAX_BYTES, sanitizeDrawProbe } from '../src/shared/draw-probe.js';

const X8R8G8B8 = 22, D24S8 = 75, TF = 60;

for (const recorded of [false, true]) {
  test(`a still screen starts the draw probe by itself; the producer's TEXTUREFACTOR reaches it${recorded ? ' (render worker)' : ''}`, async () => {
    const { gl, calls } = fakeGl(320, 240), sent = [];
    let t = 0, link = null, resent = 0;
    const send = (m) => { if (m.event === 'draw-probe-stamp') { if (link) link.stampDraws = !!m.on; } else sent.push(m); };
    const fp = new FlickerProbe(gl, { send, now: () => t, errors: false });
    const probe = { flicker: fp, endRun() {}, frame() {} };
    const backend = (dev) => { const b = new WebGLDevice(gl, dev, {}); b.probe = probe; b.flickerResend = () => { resent++; }; return b; };
    let gfx = { createDevice: backend };
    if (recorded) {
      const words = new Int32Array(1 << 16), ack = new Int32Array(1 << 16).fill(-1);
      const replayer = new Replayer(words, { mem: null, ack, createBackend: backend });
      link = new RenderLink({ words, replayer, ack });
      gfx = { createDevice: (dev) => { replayer.mem = dev.proc.mem; return new Recorder(link, dev); } };
    }
    const { mem, ctx, com, defs, alloc } = d3dEnv(gfx);
    const pp = alloc(64), out = alloc(16), quad = alloc(80);
    [320, 240, X8R8G8B8, 1, 0, 0, 1, 0, 0, 1, D24S8, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    [[0, 0], [320, 0], [0, 240], [320, 240]].forEach(([x, y], i) => { const a = quad + 20 * i; mem.writeF32(a, x); mem.writeF32(a + 4, y); mem.writeF32(a + 8, 0.5); mem.writeF32(a + 12, 1); mem.write32(a + 16, 0xff000000); });
    const d3dPtr = defs.Direct3DCreate9[1](ctx([32])), d3d = com.implAt(d3dPtr);
    assert.equal(d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])), 0);
    const devPtr = mem.read32(out), dev = com.implAt(devPtr);
    const call = (name, ...args) => dev[name](ctx([devPtr, ...args]));
    call('SetFVF', 0x44); // (XYZRHW | DIFFUSE)
    call('SetTextureStageState', 0, 4, 2); call('SetTextureStageState', 0, 5, 3); // (alpha: SELECTARG1 TFACTOR — the veil's)
    call('SetRenderState', 27, 1); call('SetRenderState', 19, 5); call('SetRenderState', 20, 6); // (alpha blending)
    // (a pause screen: the same three draws every frame; the game's TEXTUREFACTOR lower one frame in three)
    let frame = 0;
    const step = () => {
      call('BeginScene'); call('Clear', 0, 0, 1, 0xff406080, 0x3f800000, 0);
      call('SetRenderState', TF, frame % 3 === 0 ? 0x28000000 : 0xcc000000);
      for (let i = 0; i < 3; i++) call('DrawPrimitiveUP', 5, 2, quad, 20);
      call('EndScene'); assert.equal(call('Present', 0, 0, 0, 0), 0);
      link?.publish(true); frame++; t += 100;
    };
    while (!fp.dp && t < 60000) step();
    assert.ok(fp.dp, 'started without being asked');
    assert.equal(fp.dp.trigger.why, 'still');
    const snaps = () => { let n = 0; for (let i = 0; i + 1 < calls.length; i++) if (calls[i][0] === 'blitFramebuffer' && calls[i + 1][0] === 'bindFramebuffer' && calls.slice(i + 2, i + 4).some((c) => c[0] === 'drawArrays')) n++; return n; };
    assert.equal(snaps(), 0, 'no copy between draws before it records');
    for (let k = 0; k < 400 && !sent.length; k++) { step(); if (fp.dp && !fp.dp.active) await new Promise((r) => setTimeout(r, 5)); }
    assert.equal(sent.length, 1, 'one record');
    const rec = sent[0], probed = rec.frames.filter((f) => !f.ctl);
    assert.equal(rec.path, recorded ? 'worker' : 'thread');
    assert.ok(rec.stamps, "the producer's values known");
    if (link) assert.equal(link.stampDraws, false, 'stamps asked for while it records only');
    // (a copy right before each probed draw — and one after it —: the three draws of every recorded frame)
    const n = snaps();
    assert.ok(n >= 3 * (probed.length - 1) && n <= 3 * probed.length, `copies before draws: ${n} for ${probed.length} recorded frames`);
    for (let k = 0; k < 30; k++) step();
    assert.equal(snaps(), n, 'nothing more once it is done');
    assert.equal(resent, 0, 'no uniform sent again');
    // (the values: the producer's and the backend's the same, both moving with the game's)
    const vals = probed.flatMap((f) => f.d.map((e) => rec.vals[e[2]]));
    assert.deepEqual([...new Set(vals.map((v) => v[0]))].sort((a, b) => a - b), [0x28000000, 0xcc000000], "the producer's TEXTUREFACTOR, both values");
    assert.ok(vals.every((v) => v[0] === v[1]), 'the backend read what the producer set');
    assert.ok(JSON.stringify(rec).length <= DRAW_PROBE_MAX_BYTES);
    assert.ok(sanitizeDrawProbe({ ...rec, session: 'abcd1234' }).ok, 'the server takes it');
    assert.ok(!fp.dp && fp.dpSent, 'once per session');
  });
}
