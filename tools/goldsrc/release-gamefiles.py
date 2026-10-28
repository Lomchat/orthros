#!/usr/bin/env python3
# A GoldSrc engine release's own game files as loose files (docs/browser-ports.md "The release's own game files"): the
# members of the archives Orthros builds for a release (the bots' profiles and navigation meshes, a build's generated
# assets — tools/goldsrc/build-modules.sh) written under the release's gamefiles/<game folder>/, which the server lays
# over the version's files (src/host/game-files.js releaseGameFiles). There they are game data — listed in the version's
# tree, read by pieces through /gamez, kept in the OPFS store, ordered by what sessions read —, not archives the page
# fetches whole before the menu (the engine reads every member's header of a mounted .pk3 at its mount: xash3d-fwgs
# filesystem/zip.c FS_LoadZip). The archives stay in the release (an older manifest's goldsrc.extras still names them);
# release.json lists each loose file ({ path, sha256, bytes }) and the archives they come from (`gameFilesFrom`).
# A loose file's time is its bytes' (`content_mtime`: a time drawn from its sha256), never its archive's — the archive is
# written anew by every build, and the browsers' blocks are keyed by path, size and time (src/vfs/opfs-store.js): a
# rebuild changes only the files whose bytes changed, and a changed file never keeps its old key, whatever its size.
# An archive given as --map-precache=<archive>: its members are what the game's server precaches at every map's load
# without the map naming them (a build's generated assets its game DLL precaches — its clients load them too);
# release.json lists them, relative to the game folder (`mapPrecache`), and the page announces them with each map it
# loads (src/ports/goldsrc/bsp-reads.js mapReads), fetched in parallel instead of a demand read each.
# An archive's game folder is the folder it lies in (counterstrike/cstrike/x.pk3 -> gamefiles/cstrike/). Two archives
# giving one path (whatever its case), a member outside its folder, or a path already there: refused.
#
# Usage:
#   python3 -I tools/goldsrc/release-gamefiles.py <release dir> [--map-precache=]<archive>...
#       the archives (release paths) of a release being built (its staging folder: build-modules.sh)
#   python3 -I tools/goldsrc/release-gamefiles.py --derive <engines dir> <from id> <new id> [--map-precache=]<archive>...
#       a new release made from an installed one without rebuilding it: its files copied (times kept), its id changed
#       (`derivedFrom`: the release it was made from), then the archives' members written; staged beside, then renamed
#       in place. An installed release is never overwritten. Run tools/engine-br.mjs on it afterwards (release.json).
import hashlib
import json
import os
import pathlib
import shutil
import sys
import zipfile

def safe(name):
    parts = name.split('/')
    return name and '\\' not in name and not name.startswith('/') and all(p and p not in ('.', '..') for p in parts)


EPOCH = 315532800  # (1980-01-01 UTC: the zip format's first date)


def content_mtime(digest):
    """A loose file's time from its bytes' sha256 (hex): the same bytes the same time in every build, other bytes
    (almost surely) another — within 34 years from 1980, never in the future."""
    return EPOCH + int(digest[:8], 16) % (1 << 30)


MAP_PRECACHE = '--map-precache='


def unpack(release, archives):
    """Every archive's members written under release/gamefiles/<its folder>/; release.json updated. Returns the count.
    An archive written `--map-precache=<archive>`: its members also listed in release.json `mapPrecache`."""
    marked = {a[len(MAP_PRECACHE):] for a in archives if a.startswith(MAP_PRECACHE)}
    archives = [a[len(MAP_PRECACHE):] if a.startswith(MAP_PRECACHE) else a for a in archives]
    release = pathlib.Path(release)
    meta_file = release / 'release.json'
    meta = json.loads(meta_file.read_text())
    files = meta.setdefault('files', [])
    if not isinstance(files, list):
        sys.exit(f'{meta_file}: files must be a list of {{ path, sha256, bytes }}')
    taken = {f['path'].lower() for f in files}
    seen, added, reads = {}, [], []
    for rel in archives:
        src = release / rel
        if not safe(rel) or not src.is_file() or not rel.lower().endswith('.pk3'):
            sys.exit(f'{rel}: not an archive (.pk3) of the release')
        parts = rel.split('/')
        if len(parts) < 2:
            sys.exit(f'{rel}: an archive lies in its game folder')
        game = parts[-2]
        with zipfile.ZipFile(src) as z:
            for info in sorted(z.infolist(), key=lambda i: i.filename):
                if info.is_dir():
                    continue
                if not safe(info.filename):
                    sys.exit(f'{rel}: member {info.filename!r} outside its folder')
                out = f'gamefiles/{game}/{info.filename}'
                key = out.lower()
                if key in seen:
                    sys.exit(f'{out}: in {seen[key]} and {rel}')
                if key in taken:
                    sys.exit(f'{out}: already in the release')
                seen[key] = rel
                data = z.read(info)
                dest = release / out
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                digest = hashlib.sha256(data).hexdigest()
                os.utime(dest, (content_mtime(digest), content_mtime(digest)))
                added.append({'path': out, 'sha256': digest, 'bytes': len(data)})
                if rel in marked:
                    reads.append(info.filename)
    files.extend(added)
    meta['gameFilesFrom'] = sorted(set(meta.get('gameFilesFrom', [])) | set(archives))
    if reads:
        meta['mapPrecache'] = sorted(set(meta.get('mapPrecache', [])) | set(reads))
    meta_file.write_text(json.dumps(meta, indent=2) + '\n')
    return len(added)


def derive(engines, old, new, archives):
    engines = pathlib.Path(engines)
    src, dest, stage = engines / old, engines / new, engines / f'.{new}.staging'
    if not (src / 'release.json').is_file():
        sys.exit(f'{src}: not an installed release')
    if dest.exists():
        sys.exit(f'{dest}: already there; an installed release is never overwritten')
    if (src / 'gamefiles').exists():
        sys.exit(f'{src}: has its gamefiles/ already')
    shutil.rmtree(stage, ignore_errors=True)
    shutil.copytree(src, stage, symlinks=False, copy_function=shutil.copy2)
    meta = json.loads((stage / 'release.json').read_text())
    meta = {'id': new, 'derivedFrom': old, **{k: v for k, v in meta.items() if k != 'id'}}
    (stage / 'release.json').write_text(json.dumps(meta, indent=2) + '\n')
    try:
        n = unpack(stage, archives)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)  # (refused: nothing left beside the releases)
        raise
    os.rename(stage, dest)
    return n


def main(argv):
    if argv[:1] == ['--derive'] and len(argv) >= 5:
        n = derive(argv[1], argv[2], argv[3], argv[4:])
        print(f'{argv[3]}: {n} game files from {", ".join(argv[4:])}')
    elif len(argv) >= 2 and not argv[0].startswith('-'):
        n = unpack(argv[0], argv[1:])
        print(f'{argv[0]}: {n} game files from {", ".join(argv[1:])}')
    else:
        sys.exit('usage: release-gamefiles.py <release dir> <archive>... | --derive <engines dir> <from id> <new id> <archive>...')


if __name__ == '__main__':
    main(sys.argv[1:])
