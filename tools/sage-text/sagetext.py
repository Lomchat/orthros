"""Read and write the text files of EA's SAGE games (BFME, BFME II, RotWK and their mods).

- BIG archives (BIGF / BIG4): names and contents.
- .str string files (cp1252, `LABEL` / `"value"` / `END`, `\\n` escapes): parsed with their layout kept, so a
  translated copy differs from the original only inside the quoted values.
- .csf compiled string files (the official localizations): label -> text, converted to the .str escaped form.

Run with `python3 -I`; no third-party module.
"""
import re
import struct

ENCODING = 'cp1252'
# (a value line: the quoted text, then maybe a comment the game skips — `// ...` or `; ...`)
# (what follows the closing quote is kept as written: the game stops at that quote)
VALUE_LINE = re.compile(r'^(\s*)"((?:[^"\\]|\\.)*)"(.*)$')


class Big:
    """A BIG archive: `names()` (as stored), `read(name)` (case-insensitive, '/' or '\\')."""

    def __init__(self, path):
        self.path = path
        self.entries = {}
        with open(path, 'rb') as f:
            head = f.read(16)
            if head[:3] != b'BIG':
                raise ValueError(f'{path}: not a BIG archive')
            count = struct.unpack('>I', head[8:12])[0]
            for _ in range(count):
                offset, size = struct.unpack('>II', f.read(8))
                name = bytearray()
                while (c := f.read(1)) != b'\0':
                    name += c
                name = name.decode('latin1')
                self.entries[self.key(name)] = (name, offset, size)

    @staticmethod
    def key(name):
        return name.replace('/', '\\').lower()

    def names(self):
        return [n for n, _, _ in self.entries.values()]

    def read(self, name):
        hit = self.entries.get(self.key(name))
        if hit is None:
            return None
        with open(self.path, 'rb') as f:
            f.seek(hit[1])
            return f.read(hit[2])


def csf_to_str_value(text):
    """A .csf string as a .str value (without its quotes): newlines and quotes escaped."""
    return text.replace('\r\n', '\n').replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')


def parse_csf(data):
    """label (as written) -> value in .str escaped form (first string of each label)."""
    if data[:4] != b' FSC':
        raise ValueError('not a CSF file')
    _version, labels, _strings, _unused, _lang = struct.unpack('<5I', data[4:24])
    p = 24
    out = {}
    for _ in range(labels):
        if data[p:p + 4] != b' LBL':
            raise ValueError(f'CSF: label expected at {p}')
        count, length = struct.unpack('<II', data[p + 4:p + 12])
        p += 12
        label = data[p:p + length].decode('latin1')
        p += length
        value = None
        for i in range(count):
            tag = data[p:p + 4]
            n = struct.unpack('<I', data[p + 4:p + 8])[0]
            p += 8
            raw = bytes((~b) & 0xff for b in data[p:p + 2 * n])
            p += 2 * n
            if tag == b'WRTS':  # (an extra ASCII string follows: a sound file name)
                extra = struct.unpack('<I', data[p:p + 4])[0]
                p += 4 + extra
            if i == 0:
                value = raw.decode('utf-16-le')
        out[label] = csf_to_str_value(value or '')
    return out


class StrFile:
    """A .str file with its layout: `entries` [{label, value, line}] where value is the text between the quotes
    (escapes kept as written); `dump(values)` writes it back with some values replaced."""

    def __init__(self, data, encoding=ENCODING):
        text = data.decode(encoding) if isinstance(data, bytes) else data
        self.newline = '\r\n' if '\r\n' in text else '\n'
        self.lines = text.split(self.newline)
        self.entries = []
        label = None
        quoted = []
        for i, line in enumerate(self.lines):
            s = line.strip()
            if label is None:
                if s and not s.startswith('//') and not s.startswith(';'):
                    label = s
                    quoted = []
                continue
            if s.upper() == 'END':
                if len(quoted) == 1:
                    j = quoted[0]
                    m = VALUE_LINE.match(self.lines[j])
                    if m:
                        self.entries.append({'label': label, 'value': m.group(2), 'line': j})
                    else:
                        self.entries.append({'label': label, 'value': None, 'line': j, 'raw': True})
                else:
                    self.entries.append({'label': label, 'value': None, 'line': quoted[0] if quoted else i, 'raw': True})
                label = None
            elif s and not s.startswith('//'):
                quoted.append(i)

    def values(self):
        """label (lower case) -> value, first entry of each label (the one the game shows)."""
        out = {}
        for e in self.entries:
            if e['value'] is not None:
                out.setdefault(e['label'].lower(), e['value'])
        return out

    def dump(self, replace, encoding=ENCODING):
        """The file with entry i's value replaced by replace[i] (a dict index -> value); bytes."""
        lines = list(self.lines)
        for i, value in replace.items():
            e = self.entries[i]
            m = VALUE_LINE.match(lines[e['line']])
            lines[e['line']] = f'{m.group(1)}"{value}"{m.group(3)}'
        return self.newline.join(lines).encode(encoding)


def norm(value):
    """A value compared loosely: escaped newlines and runs of spaces as one space, no edges."""
    return ' '.join(value.replace('\\n', ' ').split())


def str_from_big(path, name='data\\lotr.str'):
    data = Big(path).read(name)
    return StrFile(data).values() if data else {}


def csf_from_big(path, name='lotr.csf'):
    data = Big(path).read(name)
    return parse_csf(data) if data else {}
