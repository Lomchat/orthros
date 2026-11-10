// The guest's locale (what GetLocaleInfo, GetDateFormat, GetTimeFormat and the LCID/LANGID calls answer): the language of
// the session (the game language the player chose, else the browser's), as a Windows installed in that language would
// answer. The C runtime's own locale ("C") is separate and unchanged (msvcrt.js setlocale).

const EUR = { cur: '€', curName: 'Euro', curIso: 'EUR', curPos: 3, curNeg: 8, measure: 0, paper: 9, firstDay: 0, listSep: ';', dateOrder: 1, am: '', pm: '', timeSep: ':', oem: 850, ansi: 1252 };
/**
 * Locales the guest can have: lcid; ISO 639 / 3166 / 639-2 names; Windows' English and native names; the user's formats
 * (short and long date, time) and separators as a default Windows install of that language has.
 */
const LOCALES = {
  'en-US': { lcid: 0x409, lang: 'en', ctry: 'US', abbrLang: 'ENU', abbrCtry: 'USA', iso3Lang: 'eng', engLang: 'English', engCtry: 'United States', natLang: 'English', natCtry: 'United States', oem: 437, ansi: 1252, shortDate: 'M/d/yyyy', longDate: 'dddd, MMMM dd, yyyy', time: 'h:mm:ss tt', yearMonth: 'MMMM, yyyy', dateSep: '/', timeSep: ':', am: 'AM', pm: 'PM', dec: '.', thou: ',', cur: '$', curName: 'US Dollar', curIso: 'USD', curPos: 0, curNeg: 0, measure: 1, paper: 1, firstDay: 6, ctryCode: '1', geo: 244, listSep: ',', dateOrder: 0 },
  'fr-FR': { ...EUR, lcid: 0x40c, lang: 'fr', ctry: 'FR', abbrLang: 'FRA', abbrCtry: 'FRA', iso3Lang: 'fra', engLang: 'French', engCtry: 'France', natLang: 'français', natCtry: 'France', shortDate: 'dd/MM/yyyy', longDate: 'dddd d MMMM yyyy', time: 'HH:mm:ss', yearMonth: 'MMMM yyyy', dateSep: '/', dec: ',', thou: ' ', ctryCode: '33', geo: 84 },
  'de-DE': { ...EUR, lcid: 0x407, lang: 'de', ctry: 'DE', abbrLang: 'DEU', abbrCtry: 'DEU', iso3Lang: 'deu', engLang: 'German', engCtry: 'Germany', natLang: 'Deutsch', natCtry: 'Deutschland', shortDate: 'dd.MM.yyyy', longDate: 'dddd, d. MMMM yyyy', time: 'HH:mm:ss', yearMonth: 'MMMM yyyy', dateSep: '.', dec: ',', thou: '.', ctryCode: '49', geo: 94 },
  'es-ES': { ...EUR, lcid: 0x40a, lang: 'es', ctry: 'ES', abbrLang: 'ESN', abbrCtry: 'ESP', iso3Lang: 'spa', engLang: 'Spanish', engCtry: 'Spain', natLang: 'español', natCtry: 'España', shortDate: 'dd/MM/yyyy', longDate: "dddd, d' de 'MMMM' de 'yyyy", time: 'H:mm:ss', yearMonth: "MMMM' de 'yyyy", dateSep: '/', dec: ',', thou: '.', ctryCode: '34', geo: 217 },
  'it-IT': { ...EUR, lcid: 0x410, lang: 'it', ctry: 'IT', abbrLang: 'ITA', abbrCtry: 'ITA', iso3Lang: 'ita', engLang: 'Italian', engCtry: 'Italy', natLang: 'italiano', natCtry: 'Italia', shortDate: 'dd/MM/yyyy', longDate: 'dddd d MMMM yyyy', time: 'HH:mm:ss', yearMonth: 'MMMM yyyy', dateSep: '/', dec: ',', thou: '.', ctryCode: '39', geo: 118 },
};
const DEFAULT = 'en-US';
const BY_LANG = new Map(Object.entries(LOCALES).map(([tag, l]) => [l.lang, tag]));
const BY_LCID = new Map(Object.entries(LOCALES).map(([tag, l]) => [l.lcid, tag]));

/** The locale tag ('fr-FR') for a game language or browser language code ('fr', 'fr-CA', 'fr_FR'); en-US when none is known. */
export function localeTag(code) {
  if (typeof code !== 'string') return DEFAULT;
  const c = code.replace('_', '-');
  return LOCALES[c] ? c : BY_LANG.get(c.split('-')[0].toLowerCase()) ?? DEFAULT;
}
/** The locale a known LCID names, else null (0, LOCALE_USER_DEFAULT 0x400, LOCALE_SYSTEM_DEFAULT 0x800: the session's). */
export function localeOfLcid(lcid) { return BY_LCID.get(lcid & 0xffff) ?? null; }
export const lcidOf = (tag) => LOCALES[tag].lcid;
export const oemCodePage = (tag) => LOCALES[tag].oem;

const names = new Map(); // snapshot: a cache of pure platform data (day and month names), not machine state
/** Day (0 = Sunday) and month names of a locale, long and abbreviated, from the platform's CLDR data. */
function nameTable(tag) {
  let t = names.get(tag);
  if (t) return t;
  const f = (opts, d) => new Intl.DateTimeFormat(tag, { ...opts, timeZone: 'UTC' }).format(d);
  const day = (w) => new Date(Date.UTC(2023, 0, 1 + w)); // 2023-01-01 is a Sunday
  const month = (m) => new Date(Date.UTC(2023, m, 15));
  t = {
    dayLong: [...Array(7)].map((_, i) => f({ weekday: 'long' }, day(i))),
    dayShort: [...Array(7)].map((_, i) => f({ weekday: 'short' }, day(i))),
    monLong: [...Array(12)].map((_, i) => f({ month: 'long' }, month(i))),
    monShort: [...Array(12)].map((_, i) => f({ month: 'short' }, month(i))),
  };
  names.set(tag, t);
  return t;
}

/** LCTYPE (flags removed) -> value of locale `tag`. */
function buildInfo(tag) {
  const l = LOCALES[tag], hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase(), n = nameTable(tag);
  const h24 = /H/.test(l.time);
  const m = new Map(Object.entries({
    0x01: hex4(l.lcid), 0x02: `${l.engLang} (${l.engCtry})`, 0x03: l.abbrLang, 0x04: l.natLang, 0x05: l.ctryCode, 0x06: l.engCtry, 0x07: l.abbrCtry,
    0x08: l.natCtry, 0x09: hex4(l.lcid), 0x0a: l.ctryCode, 0x0b: String(l.oem), 0x0c: l.listSep, 0x0d: String(l.measure), 0x0e: l.dec,
    0x0f: l.thou, 0x10: '3;0', 0x11: '2', 0x12: '1', 0x13: '0123456789', 0x14: l.cur, 0x15: l.curIso, 0x16: l.dec, 0x17: l.thou, 0x18: '3;0',
    0x19: '2', 0x1a: '2', 0x1b: String(l.curPos), 0x1c: String(l.curNeg), 0x1d: l.dateSep, 0x1e: l.timeSep, 0x1f: l.shortDate, 0x20: l.longDate,
    0x21: String(l.dateOrder), 0x22: String(l.dateOrder), 0x23: '0', 0x24: '1', 0x25: '0', 0x26: '0', 0x27: h24 ? '1' : '0', 0x28: l.am, 0x29: l.pm,
    0x50: '', 0x51: '-', 0x52: '3', 0x53: '0', 0x54: '1', 0x55: '0', 0x56: '1', 0x57: '0',
    0x59: l.lang, 0x5a: l.ctry, 0x5b: String(l.geo), 0x5c: tag, 0x67: l.iso3Lang, 0x68: l.abbrCtry,
    0x1001: l.engLang, 0x1002: l.engCtry, 0x1003: l.time, 0x1004: String(l.ansi), 0x1005: String(l.paper), 0x1006: l.yearMonth,
    0x1007: l.curName, 0x1008: l.curName, 0x1009: String(l.curPos), 0x100a: '1', 0x100b: String(l.firstDay), 0x100c: '6', 0x100d: '0',
    0x100e: '', 0x100f: '', 0x1010: '1', 0x1011: '10000', 0x1012: '037', 0x1014: '1',
  }).map(([k, v]) => [Number(k), v]));
  // (LOCALE_SDAYNAME1 is Monday, LOCALE_SABBREVDAYNAME1 too; months from January)
  for (let i = 0; i < 7; i++) { m.set(0x2a + i, n.dayLong[(i + 1) % 7]); m.set(0x31 + i, n.dayShort[(i + 1) % 7]); }
  for (let i = 0; i < 12; i++) { m.set(0x38 + i, n.monLong[i]); m.set(0x44 + i, n.monShort[i]); }
  return m;
}
const infos = new Map(); // snapshot: a cache of constant tables, not machine state
/** The value of a GetLocaleInfo LCTYPE in locale `tag` (flags such as LOCALE_NOUSEROVERRIDE and LOCALE_RETURN_NUMBER ignored); undefined when unknown. */
export function localeInfo(tag, lctype) {
  let m = infos.get(tag);
  if (!m) infos.set(tag, m = buildInfo(tag));
  return m.get(lctype & 0xffff);
}

const pad = (n, w) => String(n).padStart(w, '0');
/** A format picture ('dd/MM/yyyy', "h:mm:ss tt") filled with the fields of a date: { y, mo (1-12), d, wd (0 = Sunday), h, mi, s }. */
function picture(tag, pic, f) {
  const l = LOCALES[tag], n = nameTable(tag);
  let out = '';
  for (let i = 0; i < pic.length;) {
    const ch = pic[i];
    if (ch === "'") { // quoted text; '' is a quote
      let j = i + 1;
      while (j < pic.length) { if (pic[j] === "'") { if (pic[j + 1] === "'") { out += "'"; j += 2; continue; } break; } out += pic[j++]; }
      i = j + 1; continue;
    }
    if (!/[dMyghHmst]/.test(ch)) { out += ch; i++; continue; }
    let j = i; while (pic[j] === ch) j++;
    const k = j - i; i = j;
    switch (ch) {
      case 'd': out += k === 1 ? f.d : k === 2 ? pad(f.d, 2) : k === 3 ? n.dayShort[f.wd] : n.dayLong[f.wd]; break;
      case 'M': out += k === 1 ? f.mo : k === 2 ? pad(f.mo, 2) : k === 3 ? n.monShort[f.mo - 1] : n.monLong[f.mo - 1]; break;
      case 'y': out += k === 1 ? f.y % 100 : k === 2 ? pad(f.y % 100, 2) : pad(f.y, k === 3 ? 4 : k); break;
      case 'g': out += k >= 2 ? 'A.D.' : ''; break;
      case 'h': { const h = f.h % 12 || 12; out += k === 1 ? h : pad(h, 2); break; }
      case 'H': out += k === 1 ? f.h : pad(f.h, 2); break;
      case 'm': out += k === 1 ? f.mi : pad(f.mi, 2); break;
      case 's': out += k === 1 ? f.s : pad(f.s, 2); break;
      case 't': { const m = f.h < 12 ? l.am : l.pm; out += k === 1 ? m.slice(0, 1) : m; break; }
    }
  }
  return out;
}
const fields = (ms) => { const d = new Date(ms); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }; };

const DATE_LONGDATE = 2, DATE_YEARMONTH = 8;
/** GetDateFormat: `ms` (a date read off a UTC clock), the DATE_ flags, an optional format picture. */
export function formatDate(tag, flags, ms, pic) {
  const l = LOCALES[tag];
  return picture(tag, pic ?? (flags & DATE_LONGDATE ? l.longDate : flags & DATE_YEARMONTH ? l.yearMonth : l.shortDate), fields(ms));
}
const TIME_NOMINUTESORSECONDS = 1, TIME_NOSECONDS = 2, TIME_NOTIMEMARKER = 4, TIME_FORCE24HOURFORMAT = 8;
/** GetTimeFormat: the TIME_ flags apply to the locale's picture only. */
export function formatTime(tag, flags, ms, pic) {
  if (pic == null) {
    pic = LOCALES[tag].time;
    if (flags & TIME_FORCE24HOURFORMAT) pic = pic.replace(/h+/g, (m) => 'H'.repeat(m.length)).replace(/\s*t+/g, '');
    if (flags & TIME_NOMINUTESORSECONDS) pic = pic.replace(/[:.]?m+.*?(?=\s*t|$)/, '');
    else if (flags & TIME_NOSECONDS) pic = pic.replace(/[:.]?s+/, '');
    if (flags & TIME_NOTIMEMARKER) pic = pic.replace(/\s*t+/g, '');
  }
  return picture(tag, pic, fields(ms));
}
