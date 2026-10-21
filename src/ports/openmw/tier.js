// The OpenMW engine page's quality tier (its TIER: view distance, object paging's small-feature size, the shadow map's
// resolution and distance, water's render size, the page's file cache) from the machine's GPU and the frames measured,
// not from navigator.deviceMemory alone — which Chrome caps at 8, so every laptop of 8 GB or more got 'high' (an 8192
// shadow map, a 16384 view distance): a software renderer (SwiftShader, llvmpipe…) gets 'low', an integrated GPU 'mid',
// a discrete one 'high'; deviceMemory of 4 or less still means 'low'. A session whose frames stayed long in the world
// (FRAMES) on a tier above 'low' has the next session start a tier lower, on that same GPU. ?tier= and the player's own
// Options (the engine's user settings, read over the page's defaults) still win. Loaded by the engine page before its
// engine starts (src/host/openmw.js, withQualityTier): the page's tier choice calls window.orthrosTier(deviceMemory).
import { gpuClass, gpuInfo } from '../../host/web/gpu-class.js';
import { inWorld as worldShown } from './view-grow.js';

export const TIERS = ['low', 'mid', 'high'];
const BY_GPU = { software: 'low', integrated: 'mid', discrete: 'high' };
export const KEY = 'orthros.openmw.tier';
export const FRAMES = {
  /** the page's frame meter (frame-meter.js) looked at this often, in the world… */
  everyMs: 2000,
  /** …this many looks (a minute) before a verdict, once per session… */
  looks: 30,
  /** …a tier lower next time when the median of its p99 frame gaps passed this (under 20 frames a second) */
  slowP99Ms: 50,
};

const lower = (t) => TIERS[Math.max(0, TIERS.indexOf(t) - 1)];
const min = (a, b) => TIERS[Math.min(TIERS.indexOf(a), TIERS.indexOf(b))];

/**
 * The tier: `gpu` the renderer string (null: unknown), `deviceMemory` navigator's (0: unknown), `saved` what an earlier
 * session stored ({ gpu, tier }: a tier lower measured there, used on the same GPU only).
 */
export function chooseTier({ gpu = null, deviceMemory = 0, saved = null } = {}) {
  const kind = gpuClass(gpu);
  // (the page's own rule for what the GPU does not say: 8 GB or more high, 4 or less low, else mid)
  const memory = deviceMemory >= 8 ? 'high' : deviceMemory > 0 && deviceMemory <= 4 ? 'low' : 'mid';
  let tier = BY_GPU[kind] ? (deviceMemory > 0 && deviceMemory <= 4 ? 'low' : BY_GPU[kind]) : memory;
  if (saved && saved.gpu === (gpu ?? null) && TIERS.includes(saved.tier)) tier = min(tier, saved.tier);
  return { tier, kind };
}

/**
 * One look at the frames (`s`: { looks, p99s, done }): the frame meter's last measure `frames` ({ p99 }), whether the
 * player is in the world. Returns the tier for the next session once decided (a lower one), else null.
 */
export function framesLook(s, { frames, inWorld, tier }) {
  if (s.done || !inWorld || !frames || !Number.isFinite(frames.p99) || !(frames.p99 > 0)) return null;
  s.p99s.push(frames.p99);
  if (s.p99s.length < FRAMES.looks) return null;
  s.done = true;
  const median = [...s.p99s].sort((a, b) => a - b)[s.p99s.length >> 1];
  return median > FRAMES.slowP99Ms && tier !== 'low' ? lower(tier) : null;
}

/**
 * Into the engine page `win` before its engine starts: window.orthrosTier(deviceMemory) for the page's tier choice,
 * window.orthrosTierChoice what it chose and why, and the frames' look once the tier is used. `o.gpu`, `o.storage`,
 * `o.inWorld`, `o.setInterval`, `o.clearInterval`: a test's.
 */
export function install(win = globalThis, o = {}) {
  const storage = o.storage ?? win.localStorage;
  const gpu = o.gpu !== undefined ? o.gpu : gpuInfo().renderer;
  let saved = null;
  try { saved = JSON.parse(storage?.getItem(KEY) ?? 'null'); } catch { /* none */ }
  win.orthrosTier = (deviceMemory) => {
    const { tier, kind } = chooseTier({ gpu, deviceMemory: Number(deviceMemory) || 0, saved });
    win.orthrosTierChoice = { tier, gpu, kind, deviceMemory: Number(deviceMemory) || null, saved };
    // (a tier forced by the address, ?tier=, is the page's own: no verdict on it)
    if (!/[?&]tier=/.test(win.location?.search ?? '')) watch(tier);
    return tier;
  };
  const watch = (tier) => {
    const s = { p99s: [], done: false };
    // (the world shown — joined and simulated —, the one test of view-grow.js: no loading's frames in the looks)
    const inWorld = o.inWorld ?? (() => worldShown(win));
    const timer = (o.setInterval ?? setInterval)(() => {
      const next = framesLook(s, { frames: win.orthrosFrames, inWorld: inWorld(), tier });
      if (next) { try { storage?.setItem(KEY, JSON.stringify({ gpu: gpu ?? null, tier: next })); } catch { /* full */ } }
      if (s.done) (o.clearInterval ?? clearInterval)(timer);
    }, FRAMES.everyMs);
  };
  return { gpu };
}
