// The harness's scenario language (tools/headless.mjs --input, tools/scenarios/*.txt), parsed and played without a
// harness: the page's bench mode (docs/real-machine-bench.md) runs a scenario inside a player's browser. No
// dependency: the page loads this module directly.
//
// A scenario is a list of steps `<time>:<kind>[:<args>]` separated by `;` or new lines (`#` starts a comment line).
// Times are seconds from the launch, `+N` seconds after the first Direct3D frame, and after a wait step (`waitfps`,
// `waitframe`, `waitpixel`) seconds from the moment that wait was satisfied (the anchor). Steps run in order of their
// times; a wait not yet satisfied holds every step after it.
//   move x,y | click x,y | rclick x,y | down x,y / up x,y (left button, drags) | key vk[,scan] | keydown / keyup vk[,scan]
//   text <string> | mark:<label> (phase boundary) | shot (screenshot: the harness only)
//   waitfps F: until the game presents more than F frames/s for 3 s
//   waitframe min,max[,min2,max2...]: until 3 successive checks (1 s apart) see new Direct3D frames whose draws per
//     frame are within one of the ranges
//   waitpixel x,y,r,g,b[,tol]: until a displayed pixel has that colour (the harness only)
//   nudge vk,every: while the next wait holds, the key vk pressed every `every` seconds (an intro or cutscenes skipped
//     until the screen waited for comes, however many there are)
// The browser ports' bench (bench-suite.js, page-meter.js) plays these too, and steps of their own (PORT_KINDS):
//   cmd <command> (the engine's console) | look dx,dy[,n[,ms]] (the mouse moved by dx,dy in n steps over ms: a captured
//   mouse's look) | glide x0,y0,vx,vy,z (the player carried in a straight line from x0,y0 at vx,vy units a second at
//   height z, by the engine's debug teleport, until the next glide; `glide` alone stops)

/** steps whose argument is one string (the rest: comma-separated numbers) */
const STRING_ARGS = new Set(['text', 'find', 'mark', 'jitlist', 'dbg', 'cmd']);
export const WAIT_KINDS = new Set(['waitfps', 'waitframe', 'waitpixel']);
/** the steps the page's player performs; `shot`, `blur` and `focus` are accepted and skipped there */
export const PLAYER_KINDS = new Set(['move', 'click', 'rclick', 'down', 'up', 'key', 'keydown', 'keyup', 'text', 'mark', 'waitfps', 'waitframe', 'nudge', 'shot', 'blur', 'focus']);
/** the steps the browser ports' bench performs besides (their engine's console, a captured mouse, a debug teleport) */
export const PORT_KINDS = new Set([...PLAYER_KINDS, 'cmd', 'look', 'glide']);
const POINTER_KINDS = new Set(['move', 'click', 'rclick', 'down', 'up']);

/**
 * @typedef {{ t: number, rel: boolean, anchored: boolean, kind: string, args: any[], src: string, index: number }} Step
 * @param {string} text
 * @returns {{ steps: Step[], errors: string[] }}
 */
export function parseScenario(text) {
  const steps = [], errors = [];
  let afterWait = false;
  const parts = String(text ?? '').split('\n').filter((l) => !l.trim().startsWith('#')).join(';').split(';').map((s) => s.trim()).filter(Boolean);
  for (const src of parts) {
    const [ts, kind = '', ...rest] = src.split(':');
    const a = rest.join(':');
    const t = Number(ts.replace(/^\+/, ''));
    if (!kind || !Number.isFinite(t) || ts.trim() === '') { errors.push(`bad step "${src}"`); continue; }
    const args = STRING_ARGS.has(kind) ? [a] : a === '' ? [] : a.split(',').map(Number);
    if (!STRING_ARGS.has(kind) && args.some((x) => !Number.isFinite(x))) errors.push(`bad arguments in "${src}"`);
    if (POINTER_KINDS.has(kind) && args.length < 2) errors.push(`"${src}": x,y expected`);
    if (kind === 'waitframe' && (args.length < 2 || args.length % 2)) errors.push(`"${src}": min,max pairs expected`);
    if (kind === 'waitfps' && args.length < 1) errors.push(`"${src}": a frame rate expected`);
    if (kind === 'nudge' && (args.length !== 2 || !(args[1] > 0))) errors.push(`"${src}": vk,every expected`);
    if (kind === 'look' && args.length < 2) errors.push(`"${src}": dx,dy expected`);
    if (kind === 'glide' && args.length !== 0 && args.length !== 5) errors.push(`"${src}": x0,y0,vx,vy,z (or nothing: stop) expected`);
    steps.push({ t, rel: ts.trim().startsWith('+'), anchored: afterWait, kind, args, src, index: steps.length });
    if (WAIT_KINDS.has(kind)) afterWait = true;
  }
  return { steps, errors };
}

/** Steps the page's player cannot perform (debugging steps of the harness, pixel waits); `kinds`: PORT_KINDS for a port. */
export function unsupportedSteps(steps, kinds = PLAYER_KINDS) { return steps.filter((s) => !kinds.has(s.kind)); }

/** Is `dpf` (draws per frame) within one of the `[min, max, min2, max2, ...]` ranges? */
export function inRanges(dpf, ranges) { for (let i = 0; i + 1 < ranges.length; i += 2) if (dpf >= ranges[i] && dpf <= ranges[i + 1]) return true; return false; }

/**
 * Plays a parsed scenario against the page's stats. `tick(now, stats)` (now: seconds since the launch; stats: the
 * worker's latest stats message, `stats.seq` changing with each new one) returns the steps due, in order, as actions
 * { kind, args } with pointer coordinates scaled from the scenario's space (`from`: [w, h]) to the game's display
 * (`display()`: [w, h]). Wait conditions follow the harness: waitfps counts 3 s of new samples above the rate;
 * waitframe checks once a second.
 */
export class ScenarioPlayer {
  /**
   * @param {Step[]} steps
   * @param {{ from?: [number, number] | null, display?: () => [number, number] | null }} [opts]
   */
  constructor(steps, opts = {}) {
    this.steps = steps.map((s) => ({ ...s, done: false }));
    this.from = opts.from ?? null; this.display = opts.display ?? (() => null);
    this.anchorAt = null; this.firstFrameAt = null;
    this.lastSeq = undefined; this.fpsStreak = 0; this.marks = [];
    this.nudge = null; // ({ vk, every, next }: a nudge step's key, pressed while the next wait holds)
  }
  get done() { return this.steps.every((s) => s.done); }
  /** steps done / all */
  get progress() { return [this.steps.filter((s) => s.done).length, this.steps.length]; }
  /** the wait holding the scenario, or null */
  get waiting() { const s = this.steps.find((x) => !x.done); return s && WAIT_KINDS.has(s.kind) ? s : null; }
  /** the label of the last mark played */
  get phase() { return this.marks.length ? this.marks[this.marks.length - 1].label : null; }
  /** pointer coordinates from the scenario's space to the display's */
  scale(x, y) {
    const d = this.display(), f = this.from;
    if (!d || !f || (d[0] === f[0] && d[1] === f[1])) return [x, y];
    return [Math.max(0, Math.min(d[0] - 1, Math.round(x * d[0] / f[0]))), Math.max(0, Math.min(d[1] - 1, Math.round(y * d[1] / f[1])))];
  }
  due(s) { return s.anchored ? (this.anchorAt === null ? Infinity : this.anchorAt + s.t) : s.rel ? (this.firstFrameAt === null ? Infinity : this.firstFrameAt + s.t) : s.t; }
  /**
   * @param {number} now seconds since the launch
   * @param {any} stats the latest stats message (fps, dt, d3d: { frames, draws }), with `seq` new for each message
   * @returns {{ kind: string, args: any[], at: number, step: Step }[]}
   */
  tick(now, stats) {
    const out = [];
    const fresh = stats && stats.seq !== this.lastSeq; if (fresh) this.lastSeq = stats.seq;
    if (this.firstFrameAt === null && stats?.d3d?.frames > 0) this.firstFrameAt = now;
    // (a wait that holds this tick: the key of the nudge before it, when due; a wait satisfied ends the nudge)
    const hold = () => { const n = this.nudge; if (n && now >= n.next) { n.next = now + n.every; out.push({ kind: 'key', args: [n.vk], at: now, step: n.step }); } };
    const satisfied = (s, extra = {}) => { s.done = true; this.anchorAt = now; this.nudge = null; out.push({ kind: s.kind, args: s.args, at: now, step: s, ...extra }); };
    for (const s of this.steps) {
      if (s.done) continue;
      const due = this.due(s);
      if (s.kind === 'waitfps') {
        if (now < due) { hold(); break; }
        if (fresh) { this.fpsStreak = (stats.fps ?? 0) > s.args[0] ? this.fpsStreak + (stats.dt ?? 0.5) : 0; }
        if (this.fpsStreak >= 3 - 1e-6) { this.fpsStreak = 0; satisfied(s); continue; } // (the steps due at the anchor run at once)
        hold(); break;
      }
      if (s.kind === 'waitframe') {
        if (now < due) { hold(); break; }
        if (s.checkAt !== undefined && now - s.checkAt < 1) { hold(); break; } // (once a second, as the harness polls)
        s.checkAt = now;
        const d3d = stats?.d3d, prev = s.prev;
        if (!d3d || (prev && d3d.frames === prev.frames)) { hold(); break; } // (no new frame since the last check: a slow loading screen)
        s.prev = { draws: d3d.draws, frames: d3d.frames };
        const dpf = prev ? (d3d.draws - prev.draws) / (d3d.frames - prev.frames) : -1;
        s.streak = prev && inRanges(dpf, s.args) ? (s.streak ?? 0) + 1 : 0;
        if (s.streak >= 3) { satisfied(s, { dpf }); continue; }
        hold(); break;
      }
      if (s.kind === 'waitpixel') break; // (not playable in the page: unsupportedSteps rejects such a scenario first)
      if (now < due) continue;
      s.done = true;
      if (s.kind === 'nudge') { this.nudge = { vk: s.args[0], every: s.args[1], next: now, step: s }; continue; }
      let args = s.args;
      if (POINTER_KINDS.has(s.kind)) args = this.scale(args[0], args[1]);
      if (s.kind === 'mark') this.marks.push({ label: String(args[0]), at: now });
      out.push({ kind: s.kind, args, at: now, step: s });
    }
    return out;
  }
}
