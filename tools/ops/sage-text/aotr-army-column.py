"""Age of the Ring's skirmish setup with a wider Army column, as version-folder overlay files (docs/gdi-text.md,
"Age of the Ring's army column widened, as game data").

The army names ("Royaume des Forêts", "Woodland Realm"...) do not fit EA's column. The Army combo box is widened by
DELTA units of the 1024x768 APT stage (64 by default), taken from the Captain column on its right:
- aotr/MpGameSetup.apt (AotR's own loose file): the row template's 'PlayerTemplate' (Army) scale, 'Hero' (Captain)
  position and scale, and the column headers 'Faction' and 'Hero' moved by DELTA / 2 — five floats, same file size;
- the tables' grids with their Army|Captain line moved: aotr/MpGameSetup_geometry/363.ru (the 8-player table the
  skirmish shows) and 286.ru (the smaller one), from rotwk/apt/MpGameSetup.big. The game opens each geometry its
  archive lists from the loose folders first (C:\\Game\\aotr\\mpgamesetup_geometry\\<id>.ru, seen 2026-11-17), so a
  same-named loose file replaces the archive's; a loose file of an id the archive lacks is never opened.
Every value is checked against AotR 10.0.2's before it is changed (another release: nothing written). The files read
are the ones the version runs with: its own folder's (versions/<version>/, case-insensitive) over base/'s — a release
that ships its own MpGameSetup.apt is checked, not base/'s; a version folder that already holds this script's output is
refused (already widened).

    python3 -I tools/ops/sage-text/aotr-army-column.py <game folder> <output folder> [delta] [--version <folder>]

e.g. <game folder> = data/games/age-of-the-ring, <output folder> = a scratch folder, --version 10.0.2 (the default),
then copy its aotr/ into versions/10.0.2/ of the game folder (the version's files lie over base/).
"""
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sagetext import Big  # noqa: E402

# PlaceObject records of AotR 10.0.2's MpGameSetup.apt: offset -> (name, scale x, position x)
PLACEMENTS = {
    'army': (0x2388c, 'PlayerTemplate', 0.68835, 196.55),
    'captain': (0x2398c, 'Hero', 1.43874, 303.15),
    'army header': (0x2292c, 'Faction', 1.0, 215.40),
    'captain header': (0x229ac, 'Hero', 1.0, 329.65),
}
# the grids' geometries: id -> (the Army|Captain line's x, how many coordinates have it)
GRIDS = {363: ('285.05', 10), 286: ('284.8', 10)}


def find(root, rel):
    """`rel` ('a/b/c') under `root`, each component matched case-insensitively; None when absent."""
    p = root
    for part in rel.split('/'):
        if not os.path.isdir(p):
            return None
        names = {n.lower(): n for n in os.listdir(p)}
        if part.lower() not in names:
            return None
        p = os.path.join(p, names[part.lower()])
    return p


def main():
    args = sys.argv[1:]
    version = '10.0.2'
    if '--version' in args:
        i = args.index('--version')
        version = args[i + 1]
        del args[i:i + 2]
    game, out = args[0], args[1]
    delta = float(args[2]) if len(args) > 2 else 64.0

    def effective(rel):  # the file the version runs with: its own folder's, else base/'s
        return find(os.path.join(game, 'versions', version), rel) or find(os.path.join(game, 'base'), rel)

    apt_path = effective('aotr/MpGameSetup.apt')
    if not apt_path:
        sys.exit('aotr/MpGameSetup.apt not found in the version folder nor in base/: nothing written')
    d = bytearray(open(apt_path, 'rb').read())

    def f32(o):
        return struct.unpack('<f', d[o:o + 4])[0]

    def put(o, v):
        d[o:o + 4] = struct.pack('<f', v)

    at = {}
    for key, (off, name, sx, tx) in PLACEMENTS.items():
        kind, name_ptr = struct.unpack('<I', d[off:off + 4])[0], struct.unpack('<I', d[off + 52:off + 56])[0]
        found = d[name_ptr:d.index(b'\0', name_ptr)].decode('latin1') if kind == 3 else None
        if found != name or abs(f32(off + 16) - sx) > 1e-4 or abs(f32(off + 32) - tx) > 1e-3:
            sys.exit(f'{apt_path}: {key} is not AotR 10.0.2\'s ({found!r}, {f32(off + 16):.5f}, {f32(off + 32):.2f}): nothing written')
        at[key] = off
    army, captain = at['army'], at['captain']
    w_army = f32(captain + 32) - f32(army + 32)  # the Army box ends where the Captain box starts
    w0 = w_army / f32(army + 16)                 # the combo box's own width (154.9)
    w_captain = f32(captain + 16) * w0
    put(army + 16, (w_army + delta) / w0)
    put(captain + 32, f32(captain + 32) + delta)
    put(captain + 16, (w_captain - delta) / w0)
    for key in ('army header', 'captain header'):
        put(at[key] + 32, f32(at[key] + 32) + delta / 2)

    big_path = effective('rotwk/apt/MpGameSetup.big')
    big = Big(big_path) if big_path else None
    grids = {}
    for gid, (x, count) in GRIDS.items():
        loose = effective(f'aotr/MpGameSetup_geometry/{gid}.ru')  # (a loose one is what the game opens)
        ru = open(loose, 'rb').read() if loose else big.read(f'MpGameSetup_geometry/{gid}.ru') if big else None
        if ru is None:
            sys.exit(f'MpGameSetup_geometry/{gid}.ru missing (loose and in rotwk/apt/MpGameSetup.big): nothing written')
        ru = ru.decode('latin1')
        line = re.compile(r'(?<![\d.])' + re.escape(x) + r'(?![\d])')
        if len(line.findall(ru)) != count:
            sys.exit(f'{gid}.ru: {len(line.findall(ru))} coordinates {x}, not AotR 10.0.2\'s {count}: nothing written')
        grids[gid] = line.sub(('%.2f' % (float(x) + delta)).rstrip('0').rstrip('.'), ru)

    os.makedirs(os.path.join(out, 'aotr', 'MpGameSetup_geometry'), exist_ok=True)
    with open(os.path.join(out, 'aotr', 'MpGameSetup.apt'), 'wb') as f:
        f.write(bytes(d))
    for gid, ru in grids.items():
        with open(os.path.join(out, 'aotr', 'MpGameSetup_geometry', f'{gid}.ru'), 'wb') as f:
            f.write(ru.encode('latin1'))
    print(f'Army {w_army:.1f} -> {w_army + delta:.1f} units, Captain {w_captain:.1f} -> {w_captain - delta:.1f}: '
          f'{out}/aotr/MpGameSetup.apt, {out}/aotr/MpGameSetup_geometry/' + ', '.join(f'{g}.ru' for g in grids))


if __name__ == '__main__':
    main()
