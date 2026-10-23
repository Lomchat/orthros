#!/usr/bin/env python3
"""Install the pinned browser engine and its corresponding source, never game data."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
LOCK = json.loads(pathlib.Path(__file__).with_name('lock.json').read_text())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--engines-dir', type=pathlib.Path, default=ROOT / 'data_engines')
    p.add_argument('--archives', type=pathlib.Path, help='use already downloaded release archives')
    p.add_argument('--server', action='store_true', help='also pull the pinned native multiplayer image and build the gateway image derived from it')
    a = p.parse_args()
    subprocess.run([ROOT / 'tools/disk-check.sh'], check=True)
    scratch = pathlib.Path('/tmp/orthros-scratch/openmw-install')
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as temp:
        for key in ['bundle', 'source']:
            asset = LOCK[key]
            name = asset['url'].rsplit('/', 1)[1]
            archive = a.archives / name if a.archives else pathlib.Path(temp) / name
            if not archive.exists():
                archive.parent.mkdir(parents=True, exist_ok=True)
                urllib.request.urlretrieve(asset['url'], archive)
            with archive.open('rb') as f:
                if hashlib.file_digest(f, 'sha256').hexdigest() != asset['sha256']:
                    raise SystemExit(f'Hash mismatch: {archive}')
            dest = a.engines_dir / (LOCK['id'] if key == 'bundle' else f"src/{LOCK['id']}")
            # An installed release is immutable. Re-running only checks/writes the receipt.
            if not dest.exists():
                dest.mkdir(parents=True)
                if key == 'bundle':
                    with zipfile.ZipFile(archive) as z:
                        for member in z.namelist():
                            if not (dest / member).resolve().is_relative_to(dest.resolve()):
                                raise SystemExit('Unsafe archive path')
                        z.extractall(dest)
                else:
                    with tarfile.open(archive) as t:
                        t.extractall(dest, filter='data')
        dest = a.engines_dir / LOCK['id']
        source_web = a.engines_dir / 'src' / LOCK['id'] / f"openmw-web-{LOCK['tag']}" / 'server/web'
        (dest / 'portal').mkdir(exist_ok=True)
        for name in ['play.html', 'play.js', 'providers.js']:
            if not (dest / 'portal' / name).exists():
                shutil.copy2(source_web / name, dest / 'portal' / name)
        files = [f"e/{LOCK['engineVersion']}/{n}" for n in ['openmw.js', 'openmw.wasm', 'openmw.data', 'streamfs.js']]
        files += ['moddata/openmw-web-assets.bsa', 'LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md', 'portal/play.html', 'portal/play.js', 'portal/providers.js']
        for rel in ['index.html', 'launcher.html', *files]:
            if not (dest / rel).is_file():
                raise SystemExit(f'Incomplete release: {dest / rel}')
        (dest / 'release.json').write_text(json.dumps({**LOCK, 'runtime': 'openmw', 'files': files}, indent=2) + '\n')
    if a.server:
        subprocess.run(['docker', 'pull', LOCK['serverImage']], check=True)
        # (the gateway runs the image derived from it, its Node.js replaced: lock.json "serverBuild")
        if LOCK.get('serverBuild'):
            subprocess.run(['sh', ROOT / 'tools/openmw/build-server-image.sh'], check=True)
    print(f"Installed {LOCK['id']} in {dest}")


if __name__ == '__main__':
    main()
