#!/usr/bin/env python3
"""Install a GoldSrc game language package into the library (docs/browser-ports.md, "Languages").

A package folder holds one folder per game id (data_games/<id>), each with the language folders the game's version
mounts over its own (goldsrc.languages.<code>.overlays), e.g. <package>/half-life/valve_french/. They are copied into
data_games/<id>/base/ — an existing different file is never replaced. Every `valve_<language>/resource/` folder also
gets the engine menu's own strings in that language (mainui_<language>.txt, from tools/goldsrc/l10n/mainui-<code>.py)
and its banner titles (gfx/shell/head_*.tga, tools/goldsrc/l10n/banners.py).
Usage: python3 -I tools/goldsrc/install-l10n.py <package> [--games-dir data_games] [--apply]"""
import filecmp, os, runpy, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LANGS = {'french': 'fr'}  # (Steam's folder suffixes, the l10n tables' codes)

def mainui(code):
    table = runpy.run_path(os.path.join(HERE, 'l10n', f'mainui-{code}.py'))['FR' if code == 'fr' else code.upper()]
    rows = '\n'.join(f'"{k}"\t"{v}"' for k, v in table.items())
    return f'"lang"\n{{\n"Language" "{code}"\n"Tokens"\n{{\n{rows}\n}}\n}}\n'

def main():
    args = sys.argv[1:]
    if not args: sys.exit(__doc__)
    package, apply = os.path.abspath(args[0]), '--apply' in args
    games = os.path.abspath(args[args.index('--games-dir') + 1]) if '--games-dir' in args else os.path.join(HERE, '../../data_games')
    for game in sorted(os.listdir(package)):
        src = os.path.join(package, game)
        if not os.path.isdir(src) or not os.path.isfile(os.path.join(games, game, 'manifest.json')): continue
        for top in sorted(os.listdir(src)):
            for root, _, files in os.walk(os.path.join(src, top)):
                for f in files:
                    a = os.path.join(root, f); rel = os.path.relpath(a, src); b = os.path.join(games, game, 'base', rel)
                    if os.path.exists(b):
                        if not filecmp.cmp(a, b, shallow=False): sys.exit(f'refusing: {b} exists and differs')
                        continue
                    print(('copy ' if apply else 'plan ') + f'{game}/base/{rel}')
                    if apply: os.makedirs(os.path.dirname(b), exist_ok=True); shutil.copy2(a, b)
            suffix = top.rsplit('_', 1)[-1]
            if top.lower().startswith('valve_') and suffix in LANGS:
                b = os.path.join(games, game, 'base', top, 'resource', f'mainui_{suffix}.txt')
                text = mainui(LANGS[suffix]).encode('utf-8')
                if os.path.exists(b) and open(b, 'rb').read() != text and '--replace-menu' not in args: sys.exit(f'refusing: {b} differs (--replace-menu)')
                print(('write ' if apply else 'plan ') + f'{game}/base/{top}/resource/mainui_{suffix}.txt')
                if apply: os.makedirs(os.path.dirname(b), exist_ok=True); open(b, 'wb').write(text)
                shell = os.path.join(games, game, 'base', top, 'gfx', 'shell')
                print(('write ' if apply else 'plan ') + f'{game}/base/{top}/gfx/shell/head_*.tga')
                if apply:
                    banners = runpy.run_path(os.path.join(HERE, 'l10n', 'banners.py'))
                    os.makedirs(shell, exist_ok=True)
                    for name, title in banners['TITLES'][LANGS[suffix]].items(): banners['banner'](title).save(os.path.join(shell, f'head_{name}.tga'))
    print('done' if apply else 'dry run: --apply to install')

main()
