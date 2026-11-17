"""Age of the Ring's skirmish setup with a wider Army column, as version-folder overlay files (docs/gdi-text.md,
"Age of the Ring's army column widened, as game data").

The army names ("Royaume des Forêts", "Woodland Realm"...) do not fit EA's column. The Army combo box is widened by
DELTA units of the 1024x768 APT stage (64 by default), taken from the Captain column on its right:
- aotr/MpGameSetup.apt (AotR's own loose file): the row template's 'PlayerTemplate' (Army) scale, 'Hero' (Captain)
  position and scale, and the column headers 'Faction' and 'Hero' moved by DELTA / 2 — five floats, same file size;
- aotr/MpGameSetup_geometry/286.ru (the table's grid, from rotwk/apt/MpGameSetup.big): the Army|Captain line.
Every value is checked against AotR 10.0.2's before it is changed (another release: nothing written).

    python3 -I tools/ops/sage-text/aotr-army-column.py <game folder> <output folder> [delta]

e.g. <game folder> = data/games/age-of-the-ring, <output folder> = a scratch folder, then copy its aotr/ into
versions/10.0.2/ of the game folder (the version's files lie over base/).
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
GRID_X = '284.8'  # the Army|Captain line of geometry 286


def main():
    game, out = sys.argv[1], sys.argv[2]
    delta = float(sys.argv[3]) if len(sys.argv) > 3 else 64.0
    apt_path = os.path.join(game, 'base', 'aotr', 'MpGameSetup.apt')
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

    big = Big(os.path.join(game, 'base', 'rotwk', 'apt', 'MpGameSetup.big'))
    ru = big.read('MpGameSetup_geometry/286.ru')
    if ru is None:
        sys.exit('MpGameSetup_geometry/286.ru missing from rotwk/apt/MpGameSetup.big: nothing written')
    ru = ru.decode('latin1')
    line = re.compile(r'(?<![\d.])' + re.escape(GRID_X) + r'(?![\d])')
    if len(line.findall(ru)) != 10:
        sys.exit(f'286.ru: {len(line.findall(ru))} coordinates {GRID_X}, not AotR 10.0.2\'s 10: nothing written')
    ru = line.sub(('%.2f' % (float(GRID_X) + delta)).rstrip('0').rstrip('.'), ru)

    os.makedirs(os.path.join(out, 'aotr', 'MpGameSetup_geometry'), exist_ok=True)
    with open(os.path.join(out, 'aotr', 'MpGameSetup.apt'), 'wb') as f:
        f.write(bytes(d))
    with open(os.path.join(out, 'aotr', 'MpGameSetup_geometry', '286.ru'), 'wb') as f:
        f.write(ru.encode('latin1'))
    print(f'Army {w_army:.1f} -> {w_army + delta:.1f} units, Captain {w_captain:.1f} -> {w_captain - delta:.1f}: '
          f'{out}/aotr/MpGameSetup.apt, {out}/aotr/MpGameSetup_geometry/286.ru')


if __name__ == '__main__':
    main()
