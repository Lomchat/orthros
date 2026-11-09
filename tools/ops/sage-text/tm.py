"""Build a translation memory from official localizations of SAGE games.

Usage: python3 -I tools/ops/sage-text/tm.py <sources.json> <out tm.json>

sources.json: {"root": "<folder the paths are relative to>",
               "games": [{"name": "rotwk-2.01", "en": [["<archive.big>", "<member>"], ...], "fr": [...]}, ...]}
Members ending in .csf are compiled string tables, others .str files (a member may also be a loose file: archive
path "" and member the file). Later entries of a list override earlier ones (a patch over its base).

tm.json: {"games": {name: {label (lower case): [en, fr]}}} for the labels present in both languages, values in the
.str escaped form.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sagetext import Big, StrFile, parse_csf  # noqa: E402


def load(root, specs):
    table = {}
    for archive, member in specs:
        if archive:
            data = Big(os.path.join(root, archive)).read(member)
            if data is None:
                raise SystemExit(f'{archive}: no {member}')
        else:
            data = open(os.path.join(root, member), 'rb').read()
        values = parse_csf(data) if member.lower().endswith('.csf') else StrFile(data).values()
        table.update({k.lower(): v for k, v in values.items()})
    return table


def main():
    sources = json.load(open(sys.argv[1]))
    root = sources.get('root', '.')
    out = {'games': {}}
    for game in sources['games']:
        en, fr = load(root, game['en']), load(root, game['fr'])
        pairs = {k: [en[k], fr[k]] for k in en if k in fr}
        out['games'][game['name']] = pairs
        print(f"{game['name']}: {len(en)} en, {len(fr)} fr, {len(pairs)} pairs", file=sys.stderr)
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)


if __name__ == '__main__':
    main()
