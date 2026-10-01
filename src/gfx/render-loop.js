// The render worker's replay loop (docs/render-worker.md section 5.6): replay what the emulator published, publish the
// words consumed (its fences, readbacks and frame pacing wait on them), sleep on the head word when caught up, return
// to the event loop regularly. Shared by the browser render worker (render-worker.js) and the tests (a Node worker).
import { CTL, TWO32 } from './cmd-ring.js';

const BATCH = 16; // commands between two publications of the words consumed

/** the words consumed so far, published for the emulator (notified when it waits) */
export function publishTail(ctl, replayer) {
  Atomics.store(ctl, CTL.TAIL, replayer.reader.consumed % TWO32 | 0);
  if (Atomics.load(ctl, CTL.EMU_WAIT)) Atomics.notify(ctl, CTL.TAIL);
}

const yieldTask = (() => { let ch = null, resolve = null; return () => new Promise((r) => { if (!ch) { ch = new MessageChannel(); ch.port1.onmessage = () => { const f = resolve; resolve = null; f?.(); }; } resolve = r; ch.port2.postMessage(0); }); })();

/**
 * Run until `stop()` is true. `backend`: the WebGL backend factory object (program prewarm and resolution between
 * batches) or null; `stats`: { ms (replaying), waitMs (sleeping) } updated.
 */
export async function replayLoop(ctl, replayer, backend, stats, stop = () => false) {
  const r = replayer.reader;
  let idle = true, lastYield = performance.now();
  while (!stop()) {
    const head = Atomics.load(ctl, CTL.HEAD) >>> 0, avail = r.consumed + ((head - (r.consumed % TWO32) + TWO32) % TWO32);
    if (avail > r.consumed) {
      if (idle) { idle = false; backend?.beforeSlice(2); }
      const t0 = performance.now();
      while (r.consumed < avail) {
        replayer.run(avail, BATCH);
        publishTail(ctl, replayer);
        if (performance.now() - t0 > 8) break;
      }
      const t1 = performance.now();
      stats.ms += t1 - t0;
      Atomics.add(ctl, CTL.HEARTBEAT, 1);
      if (t1 - lastYield > 8) { await yieldTask(); lastYield = performance.now(); }
      continue;
    }
    if (!idle) { idle = true; backend?.afterSlice(); }
    if (backend && !backend.device) backend.prewarm();
    Atomics.add(ctl, CTL.HEARTBEAT, 1);
    Atomics.store(ctl, CTL.SLEEP, 1);
    const t0 = performance.now();
    if ((Atomics.load(ctl, CTL.HEAD) >>> 0) === head) Atomics.wait(ctl, CTL.HEAD, head | 0, 2);
    Atomics.store(ctl, CTL.SLEEP, 0);
    const t1 = performance.now();
    stats.waitMs += t1 - t0;
    if (t1 - lastYield > 8) { await yieldTask(); lastYield = performance.now(); }
  }
}
