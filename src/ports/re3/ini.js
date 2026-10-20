// The settings a game language puts in the engine's ini files (the manifest's re3.languages.<code>.ini,
// docs/browser-ports.md "re3 ports"): each key set in its section, everything else of the file kept byte for byte — its
// other lines, their order, comments, spacing and line endings. A file is edited as its bytes, one character each
// (latin1): the manifest's names and values are printable ASCII (src/host/re3.js), so what did not change is written
// back as it was read.

const BOM = '\xef\xbb\xbf'; // (UTF-8's, read as latin1)
const SECTION = /^\s*\[([^\]]*)\]/;
// (a key line: its indentation, name, separator with its spaces, value; a name never starts a comment nor a section)
const KEY = /^(\s*)([^\s=;#[][^=]*?)(\s*=[ \t]*)(.*)$/;

/** A file's bytes as text, one character per byte. */
export function bytesToText(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}
/** Text of one character per byte back to its bytes. */
export const textToBytes = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

/**
 * `text` with each key of `sections` ({ <section>: { <key>: <value> } }) set: in place where the section has it (in
 * every section of that name, every line of that key: whichever one the engine reads), else added after the section's
 * last line, a missing section added at the end. Section and key names compare without case, as ini readers do; a
 * value is written and compared without the spaces around it, as they read it (the line's own spacing kept). Nothing to
 * change: `text` itself — the same settings set again change nothing.
 */
export function setIni(text, sections) {
  const bom = text.startsWith(BOM) ? BOM : '', body = text.slice(bom.length);
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const wanted = new Map(Object.entries(sections).map(([name, keys]) => [name.toLowerCase(),
    { name, last: -1, keys: new Map(Object.entries(keys).map(([key, value]) => [key.toLowerCase(), { key, value: String(value).trim(), found: false }])) }]));
  let current = null;
  lines.forEach((line, i) => {
    const content = line.replace(/\r?\n$/, ''), end = line.slice(content.length);
    const s = SECTION.exec(content);
    if (s) { current = wanted.get(s[1].trim().toLowerCase()) ?? null; if (current) current.last = i; return; }
    if (!current) return;
    if (content.trim()) current.last = i; // (the section's last line that is not blank: added keys go after it)
    const k = KEY.exec(content), entry = k && current.keys.get(k[2].toLowerCase());
    if (!entry) return;
    entry.found = true;
    if (k[4].trimEnd() !== entry.value) lines[i] = k[1] + k[2] + k[3] + entry.value + end;
  });
  const added = (keys) => [...keys.values()].filter((e) => !e.found).map((e) => `${e.key}=${e.value}${eol}`);
  // (into the sections there, the last first: the earlier ones keep their place)
  for (const w of [...wanted.values()].filter((w) => w.last >= 0).sort((a, b) => b.last - a.last)) {
    const more = added(w.keys); if (!more.length) continue;
    if (!lines[w.last].endsWith('\n')) lines[w.last] += eol;
    lines.splice(w.last + 1, 0, ...more);
  }
  const missing = [...wanted.values()].filter((w) => w.last < 0 && w.keys.size);
  if (missing.length) {
    if (lines.length && !lines.at(-1).endsWith('\n')) lines[lines.length - 1] += eol;
    for (const w of missing) lines.push(...(lines.length && lines.at(-1).trim() ? [eol] : []), `[${w.name}]${eol}`, ...added(w.keys));
  }
  const out = bom + lines.join('');
  return out === text ? text : out;
}

/** `text`'s keys: section (lowercase) → key (lowercase) → value, without the spaces around; a key's last line wins. */
export function readIni(text) {
  const out = new Map(); let current = null;
  for (const line of text.replace(/^\xef\xbb\xbf/, '').split(/\r?\n/)) {
    const s = SECTION.exec(line);
    if (s) { const name = s[1].trim().toLowerCase(); current = out.get(name) ?? new Map(); out.set(name, current); continue; }
    const k = current && KEY.exec(line);
    if (k) current.set(k[2].toLowerCase(), k[4].trim());
  }
  return out;
}

/** The section where an ini file records the defaults it got (setIniDefaults): `<section>.<key>=<value>` each. */
export const DEFAULTS_SECTION = 'OrthrosDefaults';
/**
 * `text` with defaults ({ <section>: { <key>: <value> } }) set once: a key whose default the file has not got yet takes
 * it, and the file records it (DEFAULTS_SECTION, which the engine keeps as any section of its file); afterwards the
 * player's own choice stays. A default the manifest changes is set once more.
 */
export function setIniDefaults(text, defaults) {
  const got = readIni(text).get(DEFAULTS_SECTION.toLowerCase()) ?? new Map(), set = {}, marks = {};
  for (const [section, keys] of Object.entries(defaults)) {
    for (const [key, value] of Object.entries(keys)) {
      const mark = `${section}.${key}`;
      if (got.get(mark.toLowerCase()) === String(value).trim()) continue;
      (set[section] ??= {})[key] = value; marks[mark] = value;
    }
  }
  return Object.keys(marks).length ? setIni(setIni(text, set), { [DEFAULTS_SECTION]: marks }) : text;
}
