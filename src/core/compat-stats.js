// Compatibility telemetry (docs/telemetry-compat.md): what a session asked of the Win32 runtime that it does not do —
// imports without an implementation that the game actually called (vm.js: proc.unknownImports), COM methods that
// answered E_NOTIMPL (com.js: Com.notImpl, implemented or not), shader instructions the translators left out
// (d3d8-webgl.js: the device's stats.unsupportedOps). The worker summarizes them with its stats messages; the page sends
// the summary as a `compat` telemetry event when the set of names changes (at most every 30 s) and at the end;
// telemetry-report.mjs prints them per session and, with --compat, per game over the sessions. Bounded: at most MAX
// names per kind (the most called), names cut to NAME_MAX characters — a few KB of JSON at worst.

export const MAX = 40, NAME_MAX = 96;

/** [name, count] pairs of a Map or a plain object, the most counted first, at most MAX (count: a number or { calls }). */
function top(src) {
  const all = [];
  if (src) for (const [k, v] of src instanceof Map ? src : Object.entries(src)) {
    const n = typeof v === 'number' ? v : v?.calls ?? 0;
    if (n > 0) all.push([String(k).slice(0, NAME_MAX), n]);
  }
  all.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { list: all.slice(0, MAX), total: all.length };
}

/**
 * The session's compatibility summary: `imports` (unknown imports called at least once: calls), `notImpl` (COM methods
 * that answered E_NOTIMPL: calls), `shaderOps` (untranslated shader instructions: programs that met them), each a list
 * of [name, count]; `more`: per kind, the names left out over MAX. Null when there is nothing to report.
 * @param {{ unknownImports?: Map<string, { calls: number }>|null, notImpl?: Map<string, number>|null, shaderOps?: Record<string, number>|null }} [src]
 */
export function compatSummary({ unknownImports = null, notImpl = null, shaderOps = null } = {}) {
  const kinds = { imports: top(unknownImports), notImpl: top(notImpl), shaderOps: top(shaderOps) };
  if (!Object.values(kinds).some((x) => x.total)) return null;
  const out = {}, more = {};
  for (const [k, x] of Object.entries(kinds)) { out[k] = x.list; if (x.total > x.list.length) more[k] = x.total - x.list.length; }
  if (Object.keys(more).length) out.more = more;
  return out;
}

/** What makes a summary worth sending again: its set of names (the counts change all the time). */
export function compatKey(c) {
  return c ? ['imports', 'notImpl', 'shaderOps'].map((k) => (c[k] ?? []).map((x) => x[0]).sort().join(',')).join('|') : '';
}
