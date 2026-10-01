// GetLocaleInfo values: the LCTYPE constants of winnls.h map to the en-US values (a C runtime's setlocale reads the
// decimal separator from LOCALE_SDECIMAL: a wrong entry printed "7$00" instead of "7.00").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localeInfoValue } from '../src/win32/kernel32-file.js';

test('GetLocaleInfo en-US values by LCTYPE', () => {
  const LOCALE_ILANGUAGE = 0x1, LOCALE_SENGLANGUAGE = 0x1001, LOCALE_SABBREVLANGNAME = 0x3, LOCALE_IDEFAULTCODEPAGE = 0xb,
    LOCALE_IDEFAULTANSICODEPAGE = 0x1004, LOCALE_SDECIMAL = 0xe, LOCALE_STHOUSAND = 0xf, LOCALE_SGROUPING = 0x10,
    LOCALE_SCURRENCY = 0x14, LOCALE_SMONDECIMALSEP = 0x16, LOCALE_SDATE = 0x1d, LOCALE_STIME = 0x1e, LOCALE_SSHORTDATE = 0x1f,
    LOCALE_STIMEFORMAT = 0x1003, LOCALE_SDAYNAME1 = 0x2a, LOCALE_SMONTHNAME1 = 0x38, LOCALE_SABBREVMONTHNAME12 = 0x4f,
    LOCALE_SNEGATIVESIGN = 0x51, LOCALE_SISO639LANGNAME = 0x59, LOCALE_SISO3166CTRYNAME = 0x5a, LOCALE_NOUSEROVERRIDE = 0x80000000;
  assert.equal(localeInfoValue(LOCALE_ILANGUAGE), '0409');
  assert.equal(localeInfoValue(LOCALE_SENGLANGUAGE), 'English');
  assert.equal(localeInfoValue(LOCALE_SABBREVLANGNAME), 'ENU');
  assert.equal(localeInfoValue(LOCALE_IDEFAULTCODEPAGE), '437');
  assert.equal(localeInfoValue(LOCALE_IDEFAULTANSICODEPAGE), '1252');
  assert.equal(localeInfoValue(LOCALE_SDECIMAL), '.');
  assert.equal(localeInfoValue(LOCALE_STHOUSAND), ',');
  assert.equal(localeInfoValue(LOCALE_SGROUPING), '3;0');
  assert.equal(localeInfoValue(LOCALE_SCURRENCY), '$');
  assert.equal(localeInfoValue(LOCALE_SMONDECIMALSEP), '.');
  assert.equal(localeInfoValue(LOCALE_SDATE), '/');
  assert.equal(localeInfoValue(LOCALE_STIME), ':');
  assert.equal(localeInfoValue(LOCALE_SSHORTDATE), 'M/d/yyyy');
  assert.equal(localeInfoValue(LOCALE_STIMEFORMAT), 'h:mm:ss tt');
  assert.equal(localeInfoValue(LOCALE_SDAYNAME1), 'Monday');
  assert.equal(localeInfoValue(LOCALE_SMONTHNAME1), 'January');
  assert.equal(localeInfoValue(LOCALE_SABBREVMONTHNAME12), 'Dec');
  assert.equal(localeInfoValue(LOCALE_SNEGATIVESIGN), '-');
  assert.equal(localeInfoValue(LOCALE_SISO639LANGNAME), 'en');
  assert.equal(localeInfoValue(LOCALE_SISO3166CTRYNAME), 'US');
  assert.equal(localeInfoValue((LOCALE_SDECIMAL | LOCALE_NOUSEROVERRIDE) >>> 0), '.');
  assert.equal(localeInfoValue(0x7fff), undefined);
});
