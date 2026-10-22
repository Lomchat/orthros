// Host-timing probe (docs/real-machine-bench.md, docs/thread-scheduling.md "Host wake-up overshoot"): how late this
// browser wakes a worker up — Atomics.wait(1 ms), setTimeout(0) and setTimeout(1) (chained from their own callbacks, as
// a timer loop runs), a MessageChannel hop — and the battery state. On Windows the first three follow the system timer
// (15.625 ms by default, ~1 ms while a 1 ms resolution is held — Chrome drops it on battery): what made the frame
// limiter's waits oversleep. The bench runs it in a small worker of its own (the emulator's worker keeps running: the
// timer resolution is the process's) at the start and at each phase mark; its results go into the bench record and the
// summary panel. Runs in Node as well (the tests).
import { quantised } from '../../core/host-wait.js';

/** samples per kind */
export const PROBE_SAMPLES = 24;

/** { n, mean, p50, p90, max } of the overshoots (ms, rounded to 0.01) */
export function summarise(v) {
  if (!v.length) return null;
  const s = Float64Array.from(v).sort(), q = (x) => s[Math.min(s.length - 1, Math.floor(x * s.length))], r = (x) => Math.round(x * 100) / 100;
  return { n: s.length, mean: r(s.reduce((a, b) => a + b, 0) / s.length), p50: r(q(0.5)), p90: r(q(0.9)), max: r(s[s.length - 1]) };
}

/**
 * Measure the wake-ups. `q`: an injected coarse timer (ORTHROS_HOST_TIMER_Q, ms) applied to the timed waits — the probe
 * then shows what it would measure on such a host (a check of the reporting path, flagged `injected`).
 * @returns {Promise<{ atomicsWait1, atomicsWait1Timer, setTimeout0, setTimeout1, messageHop, injected }>}
 */
export async function measureHostTiming({ n = PROBE_SAMPLES, q = 0, now = () => performance.now() } = {}) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const waitMs = (ms) => { const t0 = now(); Atomics.wait(sab, 0, 0, quantised(t0, ms, q)); return now() - t0 - ms; };
  const out = { injected: q || 0 };
  // Atomics.wait(1): the emulator's own short waits (sched idle, the Sleep(0) throttle)
  let v = []; for (let i = 0; i < n; i++) v.push(waitMs(1));
  out.atomicsWait1 = summarise(v);
  // the same while a short timer is pending (Chrome may raise the timer resolution for pending short timers)
  const pending = setTimeout(() => {}, 4);
  v = []; for (let i = 0; i < n; i++) v.push(waitMs(1));
  clearTimeout(pending);
  out.atomicsWait1Timer = summarise(v);
  // setTimeout(d) chained from its own callback (overshoot past d; after 5 nested levels HTML clamps to 4 ms)
  const chain = (d) => new Promise((resolve) => {
    const r = []; let t0 = now();
    const step = () => { r.push(now() - t0 - d); if (r.length >= n) { resolve(r); return; } t0 = now(); setTimeout(step, d > 0 ? quantised(t0, d, q) : 0); };
    setTimeout(step, d > 0 ? quantised(t0, d, q) : 0);
  });
  out.setTimeout0 = summarise(await chain(0));
  out.setTimeout1 = summarise(await chain(1));
  // a MessageChannel hop (the worker's pump between slices)
  v = await new Promise((resolve) => {
    const ch = new MessageChannel(), r = []; let t0 = now();
    ch.port1.onmessage = () => { r.push(now() - t0); if (r.length >= n) { ch.port1.close(); resolve(r); return; } t0 = now(); ch.port2.postMessage(0); };
    ch.port2.postMessage(0);
  });
  out.messageHop = summarise(v);
  return out;
}

/** The battery as the page sees it ({ charging, level } or null without the Battery Status API). */
export async function batteryState(nav = globalThis.navigator) {
  try { const b = await nav?.getBattery?.(); return b ? { charging: !!b.charging, level: Math.round(b.level * 100) / 100 } : null; } catch { return null; }
}

/** One line for a person: the Atomics.wait / setTimeout / hop overshoots (p50 / p90 ms) and the battery. */
export function probeLine(p) {
  if (!p) return '';
  const f = (s) => (s ? `+${s.p50} / ${s.p90}` : '–');
  const bat = p.battery ? `; battery ${Math.round(p.battery.level * 100)} %${p.battery.charging ? ' charging' : ' on battery'}` : '';
  return `Atomics.wait(1) ${f(p.atomicsWait1)} (timer pending ${f(p.atomicsWait1Timer)}), setTimeout(0) ${f(p.setTimeout0)}, setTimeout(1) ${f(p.setTimeout1)}, hop ${p.messageHop ? `${p.messageHop.p50} / ${p.messageHop.p90}` : '–'} ms (p50 / p90)${bat}${p.injected ? ` [injected ${p.injected} ms timer]` : ''}`;
}

/**
 * The page side: a probe worker (this module) asked for a measurement; resolves to its results with the battery, or
 * null when workers or SharedArrayBuffer are missing. `q`: the injected timer, if any.
 */
export function runTimingProbe(q = 0, timeoutMs = 10000) {
  if (typeof Worker === 'undefined' || typeof SharedArrayBuffer === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let w;
    try { w = new Worker(import.meta.url, { type: 'module', name: 'orthros-timing-probe' }); } catch { resolve(null); return; }
    const done = (r) => { clearTimeout(timer); try { w.terminate(); } catch { /* gone */ } resolve(r); };
    const timer = setTimeout(() => done(null), timeoutMs);
    w.onmessage = async (e) => done({ ...e.data, battery: await batteryState() });
    w.onerror = () => done(null);
    w.postMessage({ q });
  });
}

// (this module as the probe worker)
if (typeof WorkerGlobalScope !== 'undefined' && globalThis.name === 'orthros-timing-probe') {
  globalThis.onmessage = async (e) => { globalThis.postMessage(await measureHostTiming({ q: Number(e.data?.q) || 0 })); };
}
