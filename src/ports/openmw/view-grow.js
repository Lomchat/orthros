// The OpenMW engine page's view distance on a link that is not fast: near first, far in the background. The engine
// starts with a short view distance (VIEW.start: about the cells around the player — distant terrain and object paging
// stay on as the page's quality tier says: they cannot be turned on once it runs), then the page raises it by
// VIEW.step up to the tier's own once the game data is quiet (GameData.quiet, src/vfs/data-client.js: no read waited
// for the network for a while, the learned order has nothing left for the game's current step) and the frames are
// short; the loads of a step read the light copies of their textures (GameData.prefer('light'): their files come after
// them, for their next loads). Through Orthros' PLAYER script in the engine (view.lua: the camera's view distance,
// never the settings), which tells the page the player's own setting — changed in Options, the growth stops — and
// exterior cell. Loaded by the engine page (src/host/openmw.js, withProgressiveView) before the engine starts.
import { linkRate } from '../../vfs/data-client.js';

export const VIEW = {
  /** the boot view distance on a link that is not fast (engine units: one exterior cell) */
  start: 8192,
  /** each raise */
  step: 2048,
  /** no read waited for the network this long before a raise (and after one: the step is loaded) */
  quietMs: 3000,
  /**
   * a frame longer than this, and than `longFactor` times the page's usual one (the median of the frame meter's p99 over
   * the last half minute, frame-meter.js: a slow machine's frames are all long), holds the next raise…
   */
  longFrameMs: 50, longFactor: 2.5,
  /** …for this long after it */
  holdMs: 3000,
  /** the page's look at the game data and the script's reports */
  pollMs: 500,
};
/** Orthros' content in the engine (its /resources/vfs, a data folder of the engine's own). */
const ROOT = '/resources/vfs';
export const CONTENT = 'orthros.omwscripts';
export const VIEW_FILE = `${ROOT}/orthros/view.txt`;

/** The script's report 'orthros.view' ("<view distance> <the player's setting>"): numbers, or null. */
export function parseView(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/.exec(String(text ?? ''));
  return m ? { live: Number(m[1]), base: Number(m[2]) } : null;
}

/**
 * The player is in the world (streamfs.js marks the session playable then): alone, the first report of Orthros'
 * script (view.lua, 'orthros.view'); in multiplayer — no Orthros script there, the world's content list is its own —
 * the multiplayer script's world joined and simulated (its 'simReady').
 */
export function inWorld(win) {
  const state = win.omw?.state ?? {};
  return state['orthros.view'] !== undefined || (!!win.__omwMPEnabled && state.state === 'Joined' && state.simReady === '1');
}

/**
 * One look of the growth `s` ({ phase: 'wait'|'loading'|'done'|'stopped', start, target, value, since }) at the game:
 * `report` (parseView: null before the player is in the world), `exterior`, `quiet`, `framesOk`, `now`. Changes `s`;
 * returns what to do: { write } the view distance for the script, { prefer } the loads' kind (GameData.prefer).
 */
export function growStep(s, { report, exterior, quiet, framesOk, now }) {
  const out = {};
  if (s.phase === 'done' || s.phase === 'stopped' || !report) return out;
  // (the player's own setting is not the page's boot value: theirs — saved earlier, or changed in Options — wins)
  if (Math.abs(report.base - s.start) >= 1) { if (s.phase === 'loading') out.prefer = null; s.phase = 'stopped'; return out; }
  if (s.phase === 'loading') {
    if (Math.abs(report.live - s.value) < 1 && quiet && now - s.since >= VIEW.quietMs) { out.prefer = null; s.phase = s.value >= s.target ? 'done' : 'wait'; }
    return out;
  }
  if (s.value >= s.target) { s.phase = 'done'; return out; }
  // (raised in an exterior only: inside, nothing far loads — the step would pass at once, the whole view loading on the
  // way out)
  if (exterior && quiet && framesOk) {
    s.value = Math.min(s.target, s.value + VIEW.step); s.phase = 'loading'; s.since = now;
    out.write = s.value; out.prefer = 'light';
  }
  return out;
}

/**
 * Into the engine page `win` before its engine starts (window.orthrosViewReady holds the engine's load): the hooks its
 * boot calls — orthrosViewBoot(tierDistance) the boot view distance (window.orthrosViewStart, orthrosViewTarget),
 * orthrosContent(FS, cfgLines) Orthros' script written and its content line added (single player only: a multiplayer
 * world's content list is the world's own) — and, on a link that is not fast, the growth (neither in multiplayer nor in
 * the baked example world, ?nomw). `o.lua`: the script's text (else fetched); `o.slow`: the link's kind (else linkRate, the last measure);
 * `o.now`, `o.setInterval`, `o.clearInterval`: a test's clock.
 */
export async function install(win = globalThis, o = {}) {
  const lua = o.lua ?? await fetch(new URL('./view.lua', import.meta.url)).then((r) => { if (!r.ok) throw new Error(`view.lua: HTTP ${r.status}`); return r.text(); });
  const slow = o.slow ?? !linkRate.fast(), now = o.now ?? (() => performance.now());
  const s = { phase: 'off', start: 0, target: 0, value: 0, since: 0, longAt: -Infinity, p99s: [] };
  let FS = null, timer = null;
  win.orthrosViewState = () => ({ ...s });
  win.orthrosViewBoot = (tierDistance) => {
    const target = Math.round(Number(tierDistance)) || 0;
    // (the page's own file streaming only: its game data says when it is quiet — never the baked example world, ?nomw,
    // which reads no game data over the network and writes no openmw.cfg to start the growth; never a multiplayer
    // world: its content list, the world's own, has no Orthros script to raise the view)
    const example = !!win.__FORCE_NOMW || /[?&]nomw\b/.test(win.location?.search ?? '');
    const grow = slow && !example && !win.__omwMPEnabled && target > VIEW.start && typeof win.StreamFS?.data === 'function';
    win.orthrosViewTarget = target; win.orthrosViewStart = grow ? VIEW.start : target;
    if (grow) Object.assign(s, { phase: 'wait', start: VIEW.start, target, value: VIEW.start });
    return String(win.orthrosViewStart);
  };
  const write = (v) => FS.writeFile(VIEW_FILE, `${v} ${s.start}`);
  const tick = () => {
    const data = win.StreamFS?.data?.(); if (!data) return;
    const t = now(), f = win.orthrosFrames, state = win.omw?.state ?? {}, report = parseView(state['orthros.view']);
    // (the frames of play only — the player in the world, frames drawn —: the half seconds of a boot or a load without
    // a frame (p99 0) made the usual frame 0 for the next 30 s, every frame of a 20 fps machine then a long one holding
    // the raise — an engine whose boot yields to the page (OpenMW r20, JSPI) gave this look its turns all along the
    // boot, one that holds the page's thread none: its raise 13 s later, 2026-10-30)
    if (report && f && Number.isFinite(f.p99) && f.p99 > 0) {
      s.p99s.push(f.p99); if (s.p99s.length > 60) s.p99s.shift();
      // (the usual frame once known — 5 s of samples —, else the fixed bound alone)
      const usual = s.p99s.length >= 10 ? [...s.p99s].sort((a, b) => a - b)[s.p99s.length >> 1] : 0;
      if (f.p99 > Math.max(VIEW.longFrameMs, VIEW.longFactor * usual)) s.longAt = t;
    }
    const r = growStep(s, { now: t, report, exterior: !!state['orthros.cell'], quiet: data.quiet(VIEW.quietMs), framesOk: t - s.longAt >= VIEW.holdMs });
    if (r.write !== undefined) write(r.write);
    if ('prefer' in r) data.prefer(r.prefer);
    if (s.phase === 'done' || s.phase === 'stopped') { (o.clearInterval ?? clearInterval)(timer); timer = null; }
  };
  win.orthrosContent = (fs, cfg) => {
    // (a multiplayer world checks the client's content list against its own — the native simulation's, which has no
    // orthros.omwscripts: an extra file is refused, BAD_CONTENT)
    if (win.__omwMPEnabled) return cfg;
    FS = fs;
    fs.mkdirTree(`${ROOT}/scripts/orthros`); fs.mkdirTree(`${ROOT}/orthros`);
    fs.writeFile(`${ROOT}/${CONTENT}`, 'PLAYER: scripts/orthros/view.lua\n');
    fs.writeFile(`${ROOT}/scripts/orthros/view.lua`, lua);
    if (s.phase === 'wait') write(s.value); else fs.writeFile(VIEW_FILE, '0 0');
    if (!cfg.includes(`content=${CONTENT}`)) cfg.push(`content=${CONTENT}`);
    if (s.phase === 'wait' && !timer) timer = (o.setInterval ?? setInterval)(tick, VIEW.pollMs);
    return cfg;
  };
  return { state: s, tick };
}
