// How deep the randomized and exhaustive tests go. `make test` (the default) runs a quick pass — the whole suite in
// under a minute, every regression case and fixed seed kept —; `make test-full` (ORTHROS_TEST_FULL=1) runs every test at
// its full depth, as before 2026-11-09: nothing is lost, the long sweeps are only not run on every change.
export const FULL = process.env.ORTHROS_TEST_FULL === '1';
/** `n` iterations at full depth, `quick` (default: an eighth, at least 1) otherwise. */
export function depth(n, quick = Math.max(1, Math.ceil(n / 8))) {
  return FULL ? n : Math.min(n, quick);
}
