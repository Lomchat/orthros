// The guest's time zone (src/win32/timezone.js): TIME_ZONE_INFORMATION derived from a zone's offsets (bias, the
// daylight-saving rules as Windows writes them), rules evaluated back, local <-> UTC conversions; synthetic zones so
// the test does not depend on the machine's time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeZoneInfo, tziOffsetAt, ruleLocalMs, localToUtc, utcZone } from '../src/win32/timezone.js';

/** last Sunday of a month (UTC date) */
const lastSunday = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
/** Central Europe: UTC+1, UTC+2 from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC */
const europe = (ms) => { const y = new Date(ms).getUTCFullYear(); const a = Date.UTC(y, 2, lastSunday(y, 2), 1), b = Date.UTC(y, 9, lastSunday(y, 9), 1); return ms >= a && ms < b ? 120 : 60; };
/** a southern zone: UTC+10, UTC+11 from the first Sunday of October 16:00 UTC (02:00 local) to the first Sunday of April 16:00 UTC (03:00 local) */
const firstSunday = (y, m) => { const d = new Date(Date.UTC(y, m, 1)); return 1 + ((7 - d.getUTCDay()) % 7); };
const south = (ms) => { const y = new Date(ms).getUTCFullYear(); const end = Date.UTC(y, 3, firstSunday(y, 3) - 1, 16), start = Date.UTC(y, 9, firstSunday(y, 9) - 1, 16); return ms < end || ms >= start ? 660 : 600; };

test('TIME_ZONE_INFORMATION of a northern zone with daylight saving', () => {
  const t = timeZoneInfo(europe, 2026, { standard: 'CET', daylight: 'CEST' });
  assert.equal(t.bias, -60);
  assert.equal(t.standardBias, 0);
  assert.equal(t.daylightBias, -60);
  // daylight saving starts on the last Sunday of March at 02:00 (local standard time), ends on the last Sunday of October at 03:00
  assert.deepEqual(t.daylightDate, { year: 0, month: 3, dayOfWeek: 0, day: 5, hour: 2, minute: 0 });
  assert.deepEqual(t.standardDate, { year: 0, month: 10, dayOfWeek: 0, day: 5, hour: 3, minute: 0 });
  assert.equal(t.standardName, 'CET');
  // the rule evaluated back gives the zone's offsets, around both changes and in another year
  for (const y of [2025, 2026, 2031]) {
    for (let ms = Date.UTC(y, 0, 1); ms < Date.UTC(y + 1, 0, 1); ms += 3 * 3600000 + 17 * 60000) assert.equal(tziOffsetAt(t, ms), europe(ms), new Date(ms).toISOString());
    const a = Date.UTC(y, 2, lastSunday(y, 2), 1);
    assert.equal(tziOffsetAt(t, a - 1), 60); assert.equal(tziOffsetAt(t, a), 120);
  }
});

test('TIME_ZONE_INFORMATION of a southern zone (daylight saving across the new year)', () => {
  const t = timeZoneInfo(south, 2026);
  assert.equal(t.bias, -600);
  assert.equal(t.daylightBias, -60);
  assert.deepEqual(t.daylightDate, { year: 0, month: 10, dayOfWeek: 0, day: 1, hour: 2, minute: 0 });
  assert.deepEqual(t.standardDate, { year: 0, month: 4, dayOfWeek: 0, day: 1, hour: 3, minute: 0 });
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 5 * 3600000 + 7 * 60000) assert.equal(tziOffsetAt(t, ms), south(ms), new Date(ms).toISOString());
});

test('zones without daylight saving; rule dates; local to UTC', () => {
  const u = timeZoneInfo(utcZone, 2026);
  assert.equal(u.bias, 0); assert.equal(u.daylightDate, null); assert.equal(u.standardName, 'Coordinated Universal Time');
  const india = () => 330;
  const i = timeZoneInfo(india, 2026);
  assert.equal(i.bias, -330); assert.equal(i.daylightDate, null); assert.equal(tziOffsetAt(i, Date.UTC(2026, 5, 1)), 330);
  // occurrence 5 = the last one, whether the month has four or five of that weekday
  assert.equal(new Date(ruleLocalMs({ month: 3, dayOfWeek: 0, day: 5, hour: 2, minute: 0 }, 2026)).toISOString(), '2026-03-29T02:00:00.000Z');
  assert.equal(new Date(ruleLocalMs({ month: 2, dayOfWeek: 1, day: 5, hour: 0, minute: 0 }, 2026)).toISOString(), '2026-02-23T00:00:00.000Z');
  assert.equal(new Date(ruleLocalMs({ month: 10, dayOfWeek: 0, day: 1, hour: 2, minute: 0 }, 2026)).toISOString(), '2026-10-04T02:00:00.000Z');
  // local wall-clock -> UTC, in both halves of the year
  assert.equal(localToUtc(europe, Date.UTC(2026, 0, 15, 12)), Date.UTC(2026, 0, 15, 11));
  assert.equal(localToUtc(europe, Date.UTC(2026, 6, 15, 12)), Date.UTC(2026, 6, 15, 10));
});
