// Polling that waits (shared by every polling API: user32's PeekMessage, DirectInput's devices — Acquire, GetDeviceData,
// GetDeviceState, Poll — and the next ones). A thread calling such an API over and over with nothing new to get (a
// frame limiter waiting for its clock to reach the next frame, a video player waiting for its next picture: tens of
// thousands of calls per frame, no other API call between them but its clock reads, which run on the JIT's fast paths)
// would burn the worker. After POLL_STREAK + POLL_AGAIN empty polls in a row (each within 50 µs of the previous one,
// with at most one other JS API call of the thread and POLL_INSNS guest instructions between them — Vice City's
// PeekMessage polling: 64-127; Age of the Ring's intro, Acquire + GetDeviceData of the keyboard: 2-4 K for the pair,
// one poll each; a loop doing small chunks of work between its calls is not polling), and no other thread of its
// priority or above ready (a lower one runs during the wait, as on Windows), the call waits (woken early by what it
// polls: a message, the device's input), and again after every POLL_AGAIN polls while the polling goes on — what an
// OS preempting a spinning thread looks like to it.
// How long, so that the waits do not make the guest late: the times at which the last bouts of polling ended (the
// thread went on with other calls: its next frame) give the shortest interval between them, hence when the current
// bout should end. The thread waits until a margin before that (POLL_MARGIN plus the latest overshoot of its waits: a
// host whose timed waits follow a coarse system timer, other threads run after the wake-up; at most POLL_MAX ms at a
// time), then spins until shortly after it: a guest polling at a steady rate sees its clock reach its deadline at full
// speed, whatever its deadline rule. Without such an estimate (or past it) the waits are pollIdleMs() long (default
// 0.25 ms; ORTHROS_PEEK_IDLE_MS=0: never wait). A bout that ended right after a wait may have ended during it: its
// interval counts up to the start of that wait (shorter: more spinning, never later). docs/api-layer.md "PeekMessage
// polling" (2026-10-06) and "DirectInput polling" (2026-11-18).
//
// The state is the thread's (`t.pollIdle`, a plain object: kept in snapshots with the thread); the polls of every
// API of a thread form one chain — a loop polling the keyboard and the mouse, or the devices and its messages, is one
// polling loop.
import { PARK } from '../core/sched.js';

const POLL_STREAK = 56, POLL_AGAIN = 8, POLL_MARGIN = 0.4, POLL_AFTER = 0.5;
const POLL_INSNS = 4096; // (guest instructions between two polls of the loop, at most)
const POLL_MAX = 2; // (2 ms: the browser worker waits in Atomics.wait; longer waits go back to its event loop and its timers)

/** the short wait (ms; 0: polling never waits) — `?dbg=ORTHROS_PEEK_IDLE_MS=<ms>` */
export const pollIdleMs = () => { const v = globalThis.ORTHROS_PEEK_IDLE_MS; return v === undefined || v === '' ? 0.25 : Number(v); };

/**
 * An empty poll of thread `t` (an API call that found nothing new): how long it should wait (ms, 0: not at all; see
 * above).
 * @param {import('../core/vm.js').Vm} vm
 * @param {import('./process.js').Thread} t
 */
export function pollIdle(vm, t) {
  const ms = pollIdleMs();
  if (!(ms > 0)) return 0;
  const st = t.pollIdle ??= { streak: 0, last: -1, lastPeek: -1, lastApi: 0, polled: false, waitAt: -1, waitEnd: -1, sinceWait: -1, over: 0, endAt: -1, ivs: [], predEnd: -1,
    parks: 0, longParks: 0, ends: 0, cut: 0, near: 0, late: 0, lateMs: 0, insns: 0, loose: 0, busy: 0 };
  const now = vm.clock.now(), own = t.apiCalls - st.lastApi <= 2, insns = vm.guestInsns - st.insns;
  // (polling, not work: a few guest instructions since the previous call — a loop pumping messages between small
  // chunks of computation, none calling an API, is not slowed down; the call after a wait, other threads ran)
  const tight = own && (st.waitEnd >= 0 || insns <= POLL_INSNS);
  if (globalThis.ORTHROS_PEEK_INSNS_HIST && own && st.waitEnd < 0) { const h = (st.hist ??= new Array(33).fill(0)); h[32 - Math.clz32(insns)]++; }
  if (own && !tight && st.streak >= POLL_STREAK) st.loose++;
  st.insns = vm.guestInsns;
  const afterWait = st.waitEnd >= 0;
  if (afterWait) { const o = now - st.waitEnd; if (own) st.over = Math.max(o > 0 ? o : 0, st.over * 0.995); st.waitEnd = -1; } // (the call after a wait, none between)
  if (!own) {
    // the end of a bout of empty calls: when it was polling, the time of its last call
    if (st.polled) {
      st.ends++; if (st.predEnd >= 0 && st.lastPeek > st.predEnd) { st.late++; st.lateMs += st.lastPeek - st.predEnd; }
      if (st.endAt >= 0) {
        const cut = st.sinceWait >= 0 && st.sinceWait <= POLL_AGAIN + 1; // (ended right after a wait)
        const iv = (cut ? st.waitAt : st.lastPeek) - st.endAt; if (cut) st.cut++;
        if (iv >= 2 && iv <= 250) { st.ivs.push(iv); if (st.ivs.length > 8) st.ivs.shift(); }
      }
      st.endAt = st.lastPeek;
      st.predEnd = st.ivs.length >= 3 ? st.endAt + Math.min(...st.ivs) : -1;
    }
    st.polled = false; st.sinceWait = -1;
  }
  // (the call after a wait goes on with the run however late it comes: the thread did nothing of its own meanwhile —
  // a lower-priority thread that ran during the wait keeps the processor until its slice ends; counted as overshoot)
  st.streak = tight && (afterWait || now - st.last < (st.streak >= POLL_STREAK ? 0.2 : 0.05)) ? st.streak + 1 : 0;
  st.last = now; st.lastPeek = now; st.lastApi = t.apiCalls;
  if (st.sinceWait >= 0) st.sinceWait++;
  if (st.streak < POLL_STREAK + POLL_AGAIN) return 0;
  st.polled = true;
  let wait = ms;
  if (st.predEnd >= 0 && now <= st.predEnd + POLL_AFTER + st.over) {
    const room = st.predEnd - POLL_MARGIN - st.over - now;
    if (room < ms) { st.near++; return 0; } // (close to the expected end: spin)
    wait = Math.min(room, POLL_MAX);
  }
  // (a ready thread of a priority at least this one's, a starved one counted higher, runs at the slice's end anyway: the
  // polling goes on until then; a lower one runs during the wait — Age of the Ring's intro has one ready most of the
  // time, at THREAD_PRIORITY_BELOW_NORMAL: counted, it kept the polling from ever waiting)
  if (vm.sched.hasYieldTarget(t)) { st.busy++; return 0; }
  st.parks++; if (wait > ms) st.longParks++;
  st.streak = POLL_STREAK; st.last = st.waitEnd = now + wait; st.waitAt = now; st.sinceWait = 0;
  return wait;
}

/**
 * An empty poll of the calling thread, from its API handler: the wait it takes when it is part of polling (pollIdle),
 * woken early once `ready()` holds (what it polls has something). PARK: the handler returns it at once (the call runs
 * again once woken: that is the bout's latest call); else the call goes on: 0 without a wait, the wait's length (ms)
 * after a nested wait (one that cannot unwind: the other threads ran on top of this call meanwhile).
 * @param {import('../core/vm.js').Vm} vm
 * @param {import('./ctx.js').Ctx} c
 * @param {() => boolean} ready
 * @returns {typeof PARK | number}
 */
export function pollWait(vm, c, ready) {
  const t = c.thread, wait = pollIdle(vm, t);
  if (wait <= 0) return 0;
  if (vm.sched.park(t, ready, wait, 'poll') === PARK) return PARK;
  t.pollIdle.lastPeek = vm.clock.now(); // (a nested wait, over: the bout's latest moment)
  return wait;
}

/**
 * A poll of `t` that found something (a message, input). Within a bout of polling (no other call since its last poll)
 * the bout ended early, for it — not at its deadline: the polling's timing chain restarts. After other calls (the
 * frame's work: Age of the Ring's intro gets a message every frame there, between its bouts of DirectInput polling) the
 * bout had ended already: its next poll counts that end as usual.
 */
export function pollFound(t) {
  const st = t.pollIdle; if (!st || t.apiCalls - st.lastApi > 2) return;
  st.streak = 0; st.polled = false; st.endAt = -1; st.sinceWait = -1;
}
