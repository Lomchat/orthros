"""Translate the .str files of a SAGE game or mod, reusing the official localizations first.

Usage: python3 -I tools/sage-text/translate.py <prepare|check|collect|build> <config.json> [phase [chunk]]

config.json (paths relative to its folder unless absolute):
  tm, tmOrder        translation memory (tm.py) and the order its games are preferred in
  root               folder of the source files; files: globs of .str files under it
  dst: {from, to}    where a translated file goes: its path with the prefix `from` replaced by `to`
  out                folder the translated files are written under (build)
  chunkWords         words of English per chunk handed to a translator

prepare 1  units (unique English lines, numbers as {1}, {2}…) of the names (objects, upgrades, buttons…) in
           chunks/p1-NNN.json, each with the official glossary of the terms it uses
prepare 2  the other units, chunks/p2-NNN.json, glossary = official terms + the names translated in phase 1
check N    validates out/pN-*.tsv (the translators' answers: `id<TAB>French` lines) against their chunks
apply F    corrections (`English<TAB>French` lines) into memory.json
collect N  adds the valid answers of phase N to memory.json (English unit text -> French): what prepare skips, build uses
build      writes the French files: official text where the English is the official one, else the units'
           translations; hotkeys (&) as in the English; numbers put back; cp1252
"""
import collections
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sagetext import ENCODING, StrFile, norm  # noqa: E402

NAME_PREFIXES = {'OBJECT', 'UPGRADE', 'SIDE', 'INI', 'BANNERUI', 'LW', 'LWA', 'MAP', 'CAMPAIGNNAME', 'CAH',
                 'CREATEAHERO', 'CONTROLBAR', 'COLOR', 'LWSCENARIO'}
HOTKEY_SUFFIX = re.compile(r'\s*\(&([A-Za-z0-9\u00c0-\u00ff])\)')
HOTKEY = re.compile(r'&([A-Za-z0-9\u00c0-\u00ff])')
# (the game's printf codes: %d, %ls, %S, %.0f, %02d, %% — not "% d" in "+20% damage")
PRINTF = re.compile(r'%(?:\d+\$)?[-+#0]*\d*(?:\.\d+)?(?:ll|l|h)?[dsiufxXcS%]')
NUMBER = re.compile(r'(?<![A-Za-z\d.{])\d+(?:[.,]\d+)?(?![\d}])')
SEPARATOR = re.compile(r'((?:\s*\\n\s*)+)')
PLACEHOLDER = re.compile(r'\{\d+\}')
LETTERS = re.compile(r'[A-Za-z]{2}')
WORD = re.compile(r"[A-Za-z\u00c0-\u00ff0-9'-]+")


def hotkey(value):
    """(letter, style) of a value's hotkey: style 'suffix' for "Name (&R)", 'inline' for "&Name"; or None."""
    m = HOTKEY_SUFFIX.search(value)
    if m:
        return m.group(1), 'suffix'
    m = HOTKEY.search(value)
    return (m.group(1), 'inline') if m else None


def clean(value):
    """A value without its hotkey marks."""
    return HOTKEY.sub(r'\1', HOTKEY_SUFFIX.sub('', value))


def apply_hotkey(fr, key):
    """The French value with the English hotkey letter: before that letter in the text (a word's first letter
    preferred) when the English had it inline and the French has it, else as a " (&X)" suffix."""
    fr = clean(fr)
    if not key:
        return fr
    letter, style = key
    if style == 'inline':
        protected = re.sub(r'\{\d+\}|%\S|\\.', lambda m: '\0' * len(m.group(0)), fr)
        for pattern in (rf'(?<![A-Za-zÀ-ÿ]){re.escape(letter)}', re.escape(letter)):
            m = re.search(pattern, protected, re.I)
            if m:
                return fr[:m.start()] + '&' + fr[m.start():]
    return f'{fr} (&{letter.upper()})'


def template(segment):
    """(text with its numbers as {1}, {2}…, the numbers). 0 and 1 stay (French agrees with them: singular)."""
    shield = []
    text = PRINTF.sub(lambda m: shield.append(m.group(0)) or f'\x01{len(shield) - 1}\x01', segment)
    numbers = []

    def number(m):
        if m.group(0) in ('0', '1'):
            return m.group(0)
        numbers.append(m.group(0))
        return '{%d}' % len(numbers)
    text = NUMBER.sub(number, text)
    text = re.sub(r'\x01(\d+)\x01', lambda m: shield[int(m.group(1))], text)
    return text, numbers


def typography(text):
    """A translation punctuated as EA's French: a no-break space before ':' (the line never wraps there), none
    before '!' and '?'."""
    text = re.sub(r'[ \u00a0]+([!?])', r'\1', text)
    return re.sub(r'(?<=\S) +:', '\u00a0:', text)


def fill(text, numbers):
    """A translated template with its numbers back (French decimal comma)."""
    return PLACEHOLDER.sub(lambda m: numbers[int(m.group(0)[1:-1]) - 1].replace('.', ','), text)


def split(value):
    """[segments], [separators], prefix, suffix of a value cut at its \\n escapes."""
    stripped = value.strip(' ')
    prefix = value[:len(value) - len(value.lstrip(' '))]
    suffix = value[len(value.rstrip(' ')):] if stripped else ''
    parts = SEPARATOR.split(stripped)
    return parts[0::2], parts[1::2], prefix, suffix


class Job:
    def __init__(self, config_path):
        self.base = os.path.dirname(os.path.abspath(config_path))
        self.config = json.load(open(config_path))
        tm = json.load(open(self.path(self.config['tm'])))['games']
        order = self.config['tmOrder']
        self.by_label = {}
        for game in reversed(order):
            self.by_label.update(tm[game])
        self.by_text = {}
        for game in reversed(order):
            for en, fr in tm[game].values():
                self.by_text[norm(clean(en))] = fr
        self.official_glossary = self.glossary_from(tm, order)
        root = self.path(self.config['root'])
        self.files = []
        for pattern in self.config['files']:
            for path in sorted(glob.glob(os.path.join(root, pattern))):
                self.files.append((os.path.relpath(path, root), StrFile(open(path, 'rb').read())))

    def path(self, p):
        return p if os.path.isabs(p) else os.path.join(self.base, p)

    @staticmethod
    def glossary_from(tm, order):
        """English term -> official French, for the names (objects, upgrades, factions, buttons, places)."""
        out = {}
        for game in reversed(order):
            for label, (en, fr) in tm[game].items():
                prefix = label.split(':')[0].upper()
                if prefix not in NAME_PREFIXES or 'tooltip' in label or '\\n' in en:
                    continue
                en, fr = ' '.join(clean(en).split()), ' '.join(clean(fr).split())
                # (not a name with extra words the French added: "King Brand" = "Prince Brand, capitaine de Dale")
                if en and fr and en != fr and len(en.split()) <= 5 and LETTERS.search(en) and LETTERS.search(fr) \
                        and ',' not in fr and len(fr.split()) <= 2 * len(en.split()) + 2:
                    out[en] = fr
        return out

    def plan(self):
        """For every entry of every file: ('keep'|'official', French) or ('units', parts)."""
        units = {}
        plan = []
        for fi, (rel, s) in enumerate(self.files):
            for ei, e in enumerate(s.entries):
                value, label = e['value'], e['label']
                if value is None or not LETTERS.search(value.replace('\\n', '')):
                    plan.append((fi, ei, 'keep', None))
                    continue
                key = norm(clean(value))
                official = self.by_label.get(label.lower())
                if official and norm(clean(official[0])) == key:
                    plan.append((fi, ei, 'official', official[1]))
                    continue
                if key in self.by_text:
                    plan.append((fi, ei, 'official', self.by_text[key]))
                    continue
                segments, separators, prefix, suffix = split(clean(value))
                prefix_label = label.split(':')[0].upper()
                is_name = (prefix_label in NAME_PREFIXES and 'tooltip' not in label.lower() and len(segments) == 1
                           and len(segments[0].split()) <= 8)
                parts = []
                for seg in segments:
                    text, numbers = template(seg)
                    if not LETTERS.search(text):
                        parts.append((None, seg, numbers))
                        continue
                    u = units.get(text)
                    if u is None:
                        u = units[text] = {'id': f'u{len(units) + 1:05d}', 'en': text, 'n': 0, 'phase': 2,
                                           'ex': f'{label} ({rel}): {clean(value)[:400]}'}
                        if official:
                            u['hint'] = {'oldEnglish': clean(official[0])[:600], 'officialFrench': clean(official[1])[:600]}
                    u['n'] += 1
                    if is_name:
                        u['phase'] = 1
                    parts.append((u['id'], text, numbers))
                plan.append((fi, ei, 'units', (parts, separators, prefix, suffix)))
        return plan, units

    def chunk_dir(self):
        d = self.path('chunks')
        os.makedirs(d, exist_ok=True)
        os.makedirs(self.path('out'), exist_ok=True)
        return d

    def memory(self):
        """English unit text -> French: the answers collected so far (memory.json), kept by text so that a chunk
        prepared again (other ids) loses nothing."""
        p = self.path('memory.json')
        return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}

    def collect(self, phase):
        """The valid answers of a phase's chunks added to memory.json (replacing what it had for the same English:
        collect a phase once, before corrections are applied to it)."""
        memory = self.memory()
        added = 0
        for p in sorted(glob.glob(os.path.join(self.chunk_dir(), f'p{phase}-*.json'))):
            out_path = os.path.join(self.path('out'), os.path.basename(p).replace('.json', '.tsv'))
            if not os.path.exists(out_path):
                continue
            answers = read_answers(out_path)
            for u in json.load(open(p, encoding='utf-8'))['units']:
                fr = answers.get(u['id'])
                if not check_unit(u['en'], fr):
                    added += memory.get(u['en']) != fr
                    memory[u['en']] = fr
        with open(self.path('memory.json'), 'w', encoding='utf-8') as f:
            json.dump(memory, f, ensure_ascii=False, indent=0, sort_keys=True)
        print(f'memory: {len(memory)} translations ({added} new or changed)')

    def prepare(self, phase):
        plan, units = self.plan()
        memory = self.memory()
        todo = [u for u in units.values() if u['en'] not in memory and (u['phase'] == phase or phase == 2)]
        glossary = dict(self.official_glossary)
        terms_file = self.path('terms.tsv')  # (a reviewer's canonical terms: English<TAB>French<TAB>source)
        if phase == 2 and os.path.exists(terms_file):
            for line in open(terms_file, encoding='utf-8'):
                cols = line.rstrip('\n').split('\t')
                if len(cols) >= 2 and cols[0] and cols[1]:
                    glossary.setdefault(cols[0], cols[1])
        if phase == 2:
            for u in units.values():
                if u['phase'] == 1 and u['en'] in memory and '{' not in u['en']:
                    glossary.setdefault(u['en'], memory[u['en']])
        # (official entries right in their own place only — a map's "Gondor" = "Belfalas" — named in the config)
        for term in self.config.get('glossaryExclude', []):
            glossary.pop(term, None)
        glossary = {en: fr for en, fr in glossary.items() if '&' not in fr}
        terms = sorted(glossary, key=len, reverse=True)
        longest = max((len(WORD.findall(t)) for t in terms), default=1)
        limit = self.config.get('chunkWords', 6000)
        max_units = self.config.get('chunkUnits', 700)
        chunks, current, words = [], [], 0
        for u in todo:
            w = len(u['en'].split()) + (len(u['ex'].split()) // 4 if phase == 2 else 0)
            if current and (words + w > limit or len(current) >= max_units):
                chunks.append(current)
                current, words = [], 0
            current.append(u)
            words += w
        if current:
            chunks.append(current)
        d = self.chunk_dir()
        for p in glob.glob(os.path.join(d, f'p{phase}-*.json')) + glob.glob(os.path.join(d, f'p{phase}-*.txt')):
            os.remove(p)
        for i, chunk in enumerate(chunks, 1):
            text = '\n'.join(u['en'] + ' ' + (u['ex'] if phase == 2 else '') for u in chunk)
            # (the terms whose words appear in a row in the chunk: its word sequences up to the longest term's)
            words = WORD.findall(text)
            spans = {' '.join(words[i:i + n]) for n in range(1, longest + 1) for i in range(len(words) - n + 1)}
            used = {}
            for t in terms:
                if len(used) >= 400:
                    break
                if ' '.join(WORD.findall(t)) in spans:
                    used[t] = glossary[t]
            items = [{k: u[k] for k in ('id', 'en', 'ex', 'hint') if k in u} for u in chunk]
            with open(os.path.join(d, f'p{phase}-{i:03d}.json'), 'w', encoding='utf-8') as f:
                json.dump({'phase': phase, 'units': items, 'glossary': used}, f, ensure_ascii=False, indent=0)
            with open(os.path.join(d, f'p{phase}-{i:03d}.txt'), 'w', encoding='utf-8') as f:
                f.write(chunk_text(items, used))
        print(f'phase {phase}: {len(todo)} units, {sum(len(u["en"].split()) for u in todo)} words, {len(chunks)} chunks')

    def check(self, phase, only=None):
        """Problems of the answers of a phase (or of one chunk, `only`: p1-003, each problem printed)."""
        problems = {}
        missing_total = 0
        for p in sorted(glob.glob(os.path.join(self.chunk_dir(), f'p{phase}-*.json'))):
            name = os.path.basename(p)
            if only and name != f'{only}.json':
                continue
            chunk = json.load(open(p, encoding='utf-8'))
            out_path = os.path.join(self.path('out'), name.replace('.json', '.tsv'))
            answers = read_answers(out_path) if os.path.exists(out_path) else {}
            for u in chunk['units']:
                fr = answers.get(u['id'])
                issue = check_unit(u['en'], fr)
                if issue:
                    problems.setdefault(name, []).append({'id': u['id'], 'en': u['en'], 'fr': fr, 'issue': issue})
                    missing_total += fr is None
        for name, items in problems.items():
            print(f'{name}: {len(items)} problems, e.g. {items[0]["id"]} {items[0]["issue"]}')
            if only:
                for item in items:
                    print(f'  {item["id"]}: {item["issue"]} | EN: {item["en"]} | FR: {item["fr"]}')
        print(f'phase {phase}: {sum(len(v) for v in problems.values())} problems ({missing_total} missing)')
        if only:
            return
        with open(self.path(f'problems-p{phase}.json'), 'w', encoding='utf-8') as f:
            json.dump(problems, f, ensure_ascii=False, indent=1)

    def apply(self, path):
        """Corrections by English text (`English<TAB>French` lines, e.g. a reviewer's) put into memory.json."""
        memory = self.memory()
        done, refused = 0, []
        for line in open(path, encoding='utf-8'):
            cols = line.rstrip('\n').split('\t')
            if len(cols) != 2 or not cols[0]:
                continue
            en, fr = cols
            issue = 'not a translated unit' if en not in memory else check_unit(en, fr)
            if issue:
                refused.append(f'{en} -> {fr}: {issue}')
                continue
            done += memory[en] != fr
            memory[en] = fr
        with open(self.path('memory.json'), 'w', encoding='utf-8') as f:
            json.dump(memory, f, ensure_ascii=False, indent=0, sort_keys=True)
        print(f'{done} corrections applied, {len(refused)} refused')
        for r in refused[:40]:
            print('  refused:', r)

    def build(self):
        plan, units = self.plan()
        memory = self.memory()
        by_id = {u['id']: u for u in units.values()}
        replace = collections.defaultdict(dict)
        stats = collections.Counter()
        untranslated = []
        for fi, ei, kind, data in plan:
            if kind == 'keep':
                continue
            s = self.files[fi][1]
            value = s.entries[ei]['value']
            if kind == 'official':
                fr = data
                stats['official'] += 1
            else:
                parts, separators, prefix, suffix = data
                out = []
                complete = True
                for uid, text, numbers in parts:
                    if uid is None:
                        out.append(text)
                        continue
                    t = memory.get(by_id[uid]['en'])
                    if t is None or check_unit(by_id[uid]['en'], t):
                        complete = False
                        t = by_id[uid]['en']
                    out.append(fill(typography(t), numbers))
                fr = prefix + ''.join(seg + (separators[i] if i < len(separators) else '') for i, seg in enumerate(out)) + suffix
                stats['translated' if complete else 'partly-english'] += 1
                if not complete:
                    untranslated.append(s.entries[ei]['label'])
            fr = apply_hotkey(fr, hotkey(value))
            fr = fr.encode(ENCODING, errors='replace').decode(ENCODING)
            replace[fi][ei] = fr
        frm, to = self.config['dst']['from'], self.config['dst']['to']
        written = []
        for fi, (rel, s) in enumerate(self.files):
            rel = rel.replace(os.sep, '/')
            dst = to + rel[len(frm):] if rel.startswith(frm) else rel
            target = os.path.join(self.path(self.config['out']), dst)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as f:
                f.write(s.dump(replace[fi]))
            written.append((rel, dst))
        with open(self.path('built.json'), 'w', encoding='utf-8') as f:
            json.dump({'files': written, 'stats': stats, 'untranslated': untranslated}, f, ensure_ascii=False, indent=1)
        print(f'{len(written)} files, {dict(stats)}, {len(untranslated)} entries still partly English')


def chunk_text(items, glossary):
    """A chunk as the translator reads it: the glossary, then one block per unit."""
    out = ['# GLOSSARY (official French of the games: use these exactly)']
    out += [f'{en} = {fr}' for en, fr in glossary.items()]
    out.append('')
    out.append('# UNITS')
    for u in items:
        out.append(f'### {u["id"]}')
        out.append(f'EN: {u["en"]}')
        if u.get('ex') and u['ex'].split(': ', 1)[-1] != u['en']:
            out.append(f'CONTEXT: {u["ex"]}')
        elif u.get('ex'):
            out.append(f'LABEL: {u["ex"].split(" ", 1)[0]}')
        if u.get('hint'):
            out.append(f'OLD EN: {u["hint"]["oldEnglish"]}')
            out.append(f'OLD OFFICIAL FR: {u["hint"]["officialFrench"]}')
    return '\n'.join(out) + '\n'


def read_answers(path):
    """A translator's answer file: one `id<TAB>French` per line (other lines skipped)."""
    out = {}
    for line in open(path, encoding='utf-8'):
        m = re.match(r'^\s*(u\d{5})\t(.*?)\s*$', line.rstrip('\n'))
        if m:
            out[m.group(1)] = m.group(2)
    return out


def check_unit(en, fr):
    """Why a translation cannot be used, or None."""
    if fr is None:
        return 'missing'
    if not isinstance(fr, str) or not fr.strip():
        return 'empty'
    if sorted(PLACEHOLDER.findall(en)) != sorted(PLACEHOLDER.findall(fr)):
        return 'numbers {n} differ'
    if PRINTF.findall(en) != PRINTF.findall(fr):
        return 'printf % codes differ'
    if '\\n' in fr:
        return 'line break added'
    if en.count('\\"') != fr.count('\\"') or fr.replace('\\"', '').count('"'):
        return 'quotes: keep \\" as in the English'
    if HOTKEY.search(fr):
        return 'hotkey & in the translation'
    try:
        fr.encode(ENCODING)
    except UnicodeEncodeError as e:
        return f'character not in cp1252: {fr[e.start:e.end]!r}'
    return None


def main():
    command, config = sys.argv[1], sys.argv[2]
    job = Job(config)
    if command == 'prepare':
        job.prepare(int(sys.argv[3]))
    elif command == 'check':
        job.check(int(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else None)
    elif command == 'apply':
        job.apply(sys.argv[3])
    elif command == 'collect':
        job.collect(int(sys.argv[3]))
    elif command == 'build':
        job.build()
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
