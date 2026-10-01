// Micro-benchmark for the render-worker study (docs/render-worker.md): what recording a frame's WebGL work into a
// shared command ring costs the emulator's thread, and what a round trip to another thread costs (the synchronous
// dependencies: readbacks). Node worker_threads stand in for the render worker; the frame is a synthetic mix shaped
// like the measured ones (calls per frame by kind, uniform sizes, streamed bytes), not a real game's commands.
// Usage: node tools/cmdring-bench.mjs [--calls 1500] [--frames 2000]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const RING_WORDS = 1 << 20; // 4 MiB command ring (int32 words)
const CTL = { HEAD: 0, TAIL: 1, PING: 2, PONG: 3 };

if (!isMainThread) {
  // consumer: replays the commands (decode + dispatch to no-op handlers), publishes its read position
  const { ring, ctl } = workerData; const i32 = new Int32Array(ring), f32 = new Float32Array(ring), c = new Int32Array(ctl);
  let tail = 0, sink = 0;
  for (;;) {
    if (Atomics.load(c, CTL.PING) !== Atomics.load(c, CTL.PONG)) { Atomics.store(c, CTL.PONG, Atomics.load(c, CTL.PING)); Atomics.notify(c, CTL.PONG); }
    const head = Atomics.load(c, CTL.HEAD);
    if (head === -1) break;
    if (tail === head) { Atomics.wait(c, CTL.HEAD, head, 1); continue; }
    while (tail !== head) {
      const op = i32[tail], n = i32[tail + 1];
      switch (op) { case 1: sink += i32[tail + 2]; break; case 2: sink += f32[tail + 3]; break; case 3: sink += i32[tail + 2 + (n >> 1)]; break; default: sink += n; }
      tail += 2 + n; if (tail >= RING_WORDS - 4096) tail = 0;
    }
    Atomics.store(c, CTL.TAIL, tail);
  }
  parentPort.postMessage(sink);
} else {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const CALLS = arg('calls', 1500), FRAMES = arg('frames', 2000);
  const ring = new SharedArrayBuffer(RING_WORDS * 4), ctl = new SharedArrayBuffer(64);
  const i32 = new Int32Array(ring), f32 = new Float32Array(ring), u8r = new Uint8Array(ring), c = new Int32Array(ctl);
  const guest = new Uint8Array(new SharedArrayBuffer(64 << 20)); for (let i = 0; i < guest.length; i += 4097) guest[i] = i;
  const consts = new Float32Array(1024).map((_, i) => i * 0.5);
  // the frame: per 100 calls ~ 55 state/bind calls (2-4 ints), 25 uniforms (4-16 floats; 1 in 25 a 64-float block),
  // 15 draws (4 ints), 5 buffer updates (~1.5 KiB streamed from guest memory)
  const kinds = []; for (let i = 0; i < CALLS; i++) { const r = i % 100; kinds.push(r < 55 ? 0 : r < 80 ? (r === 79 ? 4 : 1) : r < 95 ? 2 : 3); }
  let head = 0;
  const room = (words) => { if (head + words >= RING_WORDS - 4096) head = 0; }; // (benchmark: the consumer keeps up; a real ring waits on TAIL)
  const enc = {
    state(op, a, b, cc) { room(5); i32[head] = 1; i32[head + 1] = 3; i32[head + 2] = a; i32[head + 3] = b; i32[head + 4] = cc; head += 5; },
    uniform(loc, src, off, n) { room(n + 3); i32[head] = 2; i32[head + 1] = n + 1; i32[head + 2] = loc; f32.set(src.subarray(off, off + n), head + 3); head += n + 3; },
    draw(mode, count, type, offset) { room(6); i32[head] = 4; i32[head + 1] = 4; i32[head + 2] = mode; i32[head + 3] = count; i32[head + 4] = type; i32[head + 5] = offset; head += 6; },
    data(target, addr, n) { const w = (n + 3) >> 2; room(w + 4); i32[head] = 3; i32[head + 1] = w + 2; i32[head + 2] = target; i32[head + 3] = n; u8r.set(guest.subarray(addr, addr + n), (head + 4) * 4); head += w + 4; },
  };
  let sink = 0;
  const direct = { state(op, a, b, cc) { sink += a ^ b ^ cc; }, uniform(loc, src, off, n) { sink += src[off + n - 1]; }, draw(m, n) { sink += m + n; }, data(t, a, n) { sink += guest[a + n - 1]; } };
  const frame = (o, f) => { for (let i = 0; i < CALLS; i++) { const k = kinds[i]; if (k === 0) o.state(i & 7, i, f, 3); else if (k === 1) o.uniform(i & 63, consts, (i * 4) & 511, (i & 3) === 0 ? 16 : 4); else if (k === 4) o.uniform(5, consts, 0, 64); else if (k === 2) o.draw(4, 300 + (i & 127), 5123, i * 6); else o.data(34962, (i * 6151) & 0x3fffff, 1536); } };
  const time = (o) => { const t0 = process.hrtime.bigint(); for (let f = 0; f < FRAMES; f++) { frame(o, f); if (o === enc) Atomics.store(c, CTL.HEAD, head), Atomics.notify(c, CTL.HEAD); } return Number(process.hrtime.bigint() - t0) / 1e6 / FRAMES; };
  const w = new Worker(new URL(import.meta.url), { workerData: { ring, ctl } });
  for (let k = 0; k < 3; k++) { time(direct); time(enc); } // warm-up
  const base = time(direct), rec = time(enc);
  // round trip: the emulator asks, the render worker answers at its next poll (what a synchronous readback waits at least)
  const rtt = []; for (let k = 0; k < 2000; k++) { const t0 = process.hrtime.bigint(); const v = Atomics.add(c, CTL.PING, 1) + 1; Atomics.notify(c, CTL.HEAD); while (Atomics.load(c, CTL.PONG) !== v) Atomics.wait(c, CTL.PONG, Atomics.load(c, CTL.PONG), 5); rtt.push(Number(process.hrtime.bigint() - t0) / 1000); }
  rtt.sort((a, b) => a - b);
  Atomics.store(c, CTL.HEAD, -1); Atomics.notify(c, CTL.HEAD);
  await new Promise((r) => w.once('message', r));
  console.log(`frame of ${CALLS} calls: no-op calls ${base.toFixed(3)} ms, recorded into the ring ${rec.toFixed(3)} ms (${((rec - base) * 1e6 / CALLS).toFixed(0)} ns per call over a plain call; ${(CALLS * 0.05 * 1536 / 1024).toFixed(0)} KiB streamed per frame included)`);
  console.log(`round trip to the consumer thread: median ${rtt[1000].toFixed(1)} us, p99 ${rtt[1980].toFixed(1)} us (sink ${sink & 1})`);
}
