// The render worker's replay loop (docs/render-worker.md section 5.6): replay what the emulator published, publish the
// words consumed (its fences, readbacks and frame pacing wait on them), sleep on the head word when caught up, return
// to the event loop regularly. Shared by the browser render worker (render-worker.js) and the tests (a Node worker).
import { CTL, TWO32, OP_NAMES } from './cmd-ring.js';

const BATCH = 16; // commands between two publications of the words consumed

/** the words consumed so far, published for the emulator (notified when it waits) */
export function publishTail(ctl, replayer) {
  Atomics.store(ctl, CTL.TAIL, replayer.reader.consumed % TWO32 | 0);
  if (Atomics.load(ctl, CTL.EMU_WAIT)) Atomics.notify(ctl, CTL.TAIL);
}

// (a return to the event loop without a timer's clamp, at the priority of the other tasks — messages, timers, the
// canvas's own work: scheduler.yield's continuation is served before them, and a loop yielding only that way starved
// them (no statistics, ImageBitmaps never released); in Node setImmediate, as messages to one port are drained in one
// go there)
const NODE = typeof setImmediate === 'function';
const yieldTask = NODE ? () => new Promise((r) => setImmediate(r)) : (() => { let ch = null, resolve = null; return () => new Promise((r) => { if (!ch) { ch = new MessageChannel(); ch.port1.onmessage = () => { const f = resolve; resolve = null; f?.(); }; } resolve = r; ch.port2.postMessage(0); }); })();

/**
 * Run until `stop()` is true. `backend`: the WebGL backend factory object (program prewarm and resolution between
 * batches) or null; `stats`: { ms (replaying), waitMs (sleeping) } updated.
 */
export async function replayLoop(ctl, replayer, backend, stats, stop = () => false, log = null) {
  const r = replayer.reader;
  let idle = true, lastYield = performance.now();
  // (the loop away 50 ms or more where it planned a short pause: its event loop's other tasks, garbage collection, or the
  // thread not scheduled — logged, the first 20)
  const late = (ms, what) => { if (ms >= 50 && (stats.lateResumes = (stats.lateResumes ?? 0) + 1) <= 20) log?.(`render worker: back ${ms.toFixed(0)} ms after ${what}`); };
  while (!stop()) {
    if (globalThis.ORTHROS_RW_STALL) { globalThis.ORTHROS_RW_STALL = 0; for (;;) Atomics.wait(ctl, CTL.HEARTBEAT + 1, 0, 60000); } // (testing: a render worker that stops answering — the emulator falls back)
    const head = Atomics.load(ctl, CTL.HEAD) >>> 0, avail = r.consumed + ((head - (r.consumed % TWO32) + TWO32) % TWO32);
    if (avail > r.consumed) {
      if (idle) { idle = false; backend?.beforeSlice(2); }
      const t0 = performance.now();
      let tb = t0;
      while (r.consumed < avail) {
        // (a command that throws is reported and skipped: the emulator must never wait for a dead loop)
        try { replayer.run(avail, BATCH); } catch (e) { stats.errors = (stats.errors ?? 0) + 1; if (stats.errors <= 20) log?.(`render worker: ${OP_NAMES[r.op] ?? r.op} failed: ${e?.stack ?? e}`); }
        publishTail(ctl, replayer);
        // (a batch of commands taking 50 ms or more: logged with its last command — what makes the emulator wait for frames)
        const tn = performance.now();
        if (tn - tb >= 50 && (stats.slowBatches = (stats.slowBatches ?? 0) + 1) <= 20) log?.(`render worker: ${(tn - tb).toFixed(0)} ms in a batch of at most ${BATCH} commands ending with ${OP_NAMES[r.op] ?? r.op}`);
        tb = tn;
        if (tn - t0 > 8) break;
      }
      const t1 = performance.now();
      stats.ms += t1 - t0;
      Atomics.add(ctl, CTL.HEARTBEAT, 1);
      if (t1 - lastYield > 8) { await yieldTask(); lastYield = performance.now(); late(lastYield - t1, 'a return to the event loop'); }
      continue;
    }
    if (!idle) { idle = true; backend?.afterSlice(); }
    if (backend && !backend.device) backend.prewarm();
    Atomics.add(ctl, CTL.HEARTBEAT, 1);
    Atomics.store(ctl, CTL.SLEEP, 1);
    const t0 = performance.now();
    // (caught up: sleep on the head word without blocking the event loop — waitAsync — at most 2 ms; in Node a pending
    // waitAsync does not keep a worker thread alive: a blocking wait, then a return to the event loop)
    if ((Atomics.load(ctl, CTL.HEAD) >>> 0) === head) {
      const w = Atomics.waitAsync && !NODE ? Atomics.waitAsync(ctl, CTL.HEAD, head | 0, 2) : null;
      if (w?.async) await w.value; else if (!w) { Atomics.wait(ctl, CTL.HEAD, head | 0, 2); await yieldTask(); }
    }
    Atomics.store(ctl, CTL.SLEEP, 0);
    const t1 = performance.now();
    stats.waitMs += t1 - t0;
    late(t1 - t0, 'a sleep of at most 2 ms');
    lastYield = t1;
  }
}
