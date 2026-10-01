// The guest's time zone: the host's (the browser's), as Windows describes it to programs. A zone is a function
// giving the offset of local time from UTC, in minutes east, at a UTC instant (the host's: -Date#getTimezoneOffset).
// From it: local <-> UTC conversions and the TIME_ZONE_INFORMATION of the current year (bias, the daylight-saving
// rule as "n-th weekday of a month at a local hour", names).

const HOUR = 3600000;

/** @typedef {(utcMs: number) => number} Zone (minutes east of UTC at that instant) */

/** @type {Zone} */
export const utcZone = () => 0;
/** @type {Zone} */
export const hostZone = (ms) => -new Date(ms).getTimezoneOffset();

/**
 * @typedef {{ year: number, month: number, dayOfWeek: number, day: number, hour: number, minute: number }} TzDate
 *   a SYSTEMTIME transition rule: year 0 (every year), month 1-12, weekday 0-6 (Sunday 0), day = occurrence 1-5 (5: last)
 * @typedef {{ bias: number, standardBias: number, daylightBias: number, standardDate: TzDate | null,
 *   daylightDate: TzDate | null, standardName: string, daylightName: string }} TimeZoneInfo (biases in minutes, UTC = local + bias)
 */

/** The transition rule of a local date-time (a UTC-like ms of the local wall clock). */
function ruleOf(localMs) {
  const d = new Date(localMs);
  const month = d.getUTCMonth(), dom = d.getUTCDate();
  const last = new Date(Date.UTC(d.getUTCFullYear(), month, dom + 7)).getUTCMonth() !== month;
  return { year: 0, month: month + 1, dayOfWeek: d.getUTCDay(), day: last ? 5 : Math.ceil(dom / 7), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** The instant (local wall-clock ms) a rule designates in a year. */
export function ruleLocalMs(rule, year) {
  const first = Date.UTC(year, rule.month - 1, 1);
  let dom = 1 + ((rule.dayOfWeek - new Date(first).getUTCDay() + 7) % 7) + 7 * (rule.day - 1);
  const days = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
  while (dom > days) dom -= 7; // (occurrence 5: the last one)
  return Date.UTC(year, rule.month - 1, dom, rule.hour, rule.minute);
}

/** Offset changes of a zone during a year: [{ at (UTC ms), from, to }] (hourly scan, then to the minute). */
function transitions(zone, year) {
  const out = [];
  let t = Date.UTC(year, 0, 1), prev = zone(t);
  const end = Date.UTC(year + 1, 0, 1);
  for (t += HOUR; t <= end; t += HOUR) {
    const o = zone(t);
    if (o === prev) continue;
    let lo = t - HOUR, hi = t; // zone(lo) = prev, zone(hi) = o
    while (hi - lo > 60000) { const mid = lo + Math.max(1, Math.floor((hi - lo) / 120000)) * 60000; if (zone(mid) === prev) lo = mid; else hi = mid; }
    out.push({ at: hi, from: prev, to: o });
    prev = o;
  }
  return out;
}

/**
 * TIME_ZONE_INFORMATION of a zone for a year: the standard offset is the smaller one, daylight saving the larger;
 * without two offsets in the year, no daylight rule.
 * @param {Zone} zone
 * @param {number} year
 * @param {{ standard?: string, daylight?: string }} [names]
 * @returns {TimeZoneInfo}
 */
export function timeZoneInfo(zone, year, names = {}) {
  const tr = transitions(zone, year);
  const jan = zone(Date.UTC(year, 0, 1)), jul = zone(Date.UTC(year, 6, 1));
  const std = Math.min(jan, jul), dst = Math.max(jan, jul);
  const standardName = names.standard ?? (std === 0 && dst === 0 ? 'Coordinated Universal Time' : 'Standard Time');
  const daylightName = names.daylight ?? (std === 0 && dst === 0 ? 'Coordinated Universal Time' : 'Daylight Time');
  const start = tr.find((x) => x.from === std && x.to === dst), stop = tr.find((x) => x.from === dst && x.to === std);
  if (std === dst || !start || !stop) return { bias: 0 - std, standardBias: 0, daylightBias: 0, standardDate: null, daylightDate: null, standardName, daylightName };
  return {
    bias: 0 - std, standardBias: 0, daylightBias: std - dst,
    daylightDate: ruleOf(start.at + std * 60000), // (the local standard time at which daylight saving starts)
    standardDate: ruleOf(stop.at + dst * 60000), // (the local daylight time at which it ends)
    standardName, daylightName,
  };
}

/** Minutes east of UTC that a TIME_ZONE_INFORMATION gives at a UTC instant (its daylight rule applied). */
export function tziOffsetAt(tzi, utcMs) {
  const std = -tzi.bias;
  if (!tzi.daylightDate?.month || !tzi.standardDate?.month) return std - tzi.standardBias;
  const year = new Date(utcMs + std * 60000).getUTCFullYear();
  const dst = std - tzi.daylightBias;
  const start = ruleLocalMs(tzi.daylightDate, year) - std * 60000; // (UTC instants)
  const stop = ruleLocalMs(tzi.standardDate, year) - dst * 60000;
  const inDst = start < stop ? utcMs >= start && utcMs < stop : utcMs >= start || utcMs < stop; // (southern hemisphere: across the new year)
  return inDst ? dst : std - tzi.standardBias;
}

/** UTC ms of a local wall-clock time in a zone (an ambiguous or skipped hour resolves to the offset before the change). */
export function localToUtc(zone, localMs) {
  let utc = localMs - zone(localMs) * 60000;
  utc = localMs - zone(utc) * 60000;
  return utc;
}

/** Time zone names of the host (Intl), e.g. "Central European Standard Time" / "Central European Summer Time". */
export function hostZoneNames(year) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' });
    const name = (ms) => f.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value;
    const jan = Date.UTC(year, 0, 1), jul = Date.UTC(year, 6, 1);
    const [std, dst] = hostZone(jan) <= hostZone(jul) ? [jan, jul] : [jul, jan];
    return { standard: name(std), daylight: name(dst) };
  } catch { return {}; }
}

