#!/usr/bin/env python3
"""Install the pinned GoldSrc browser engine release (lock.json "browser") into data_engines/<id>/.

The release is the published Xash3D FWGS WebAssembly package plus the game modules (client/server/menu compiled to
WebAssembly) the lock names, every file checked against its SHA-256. An installed release is never overwritten.
Usage: python3 tools/goldsrc/install-engine.py [--engines-dir <dir>]
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LOCK = json.loads((HERE / 'lock.json').read_text())['browser']
SCRATCH = Path('/tmp/orthros-scratch/goldsrc-engine')


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + '.partial')
    request = urllib.request.Request(url, headers={'User-Agent': 'Orthros'})
    with urllib.request.urlopen(request, timeout=90) as response, partial.open('wb') as output:
        shutil.copyfileobj(response, output, 1024 * 1024)
    partial.rename(target)
    return target


def safe_name(name):
    p = PurePosixPath(name)
    if p.is_absolute() or any(part in {'.', '..'} for part in p.parts) or '\\' in name:
        raise ValueError('Unsafe archive member: ' + name)
    return p


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engines-dir', default=str(ROOT / 'data_engines'))
    release = Path(parser.parse_args().engines_dir) / LOCK['id']
    subprocess.run([str(ROOT / 'tools/disk-check.sh')], check=True)
    if (release / 'release.json').exists():
        print('Engine release already installed; preserving it.')
        return
    if release.exists():
        raise RuntimeError(f'{release} exists without release.json: review it before installing')
    stage = SCRATCH / 'stage'
    shutil.rmtree(SCRATCH, ignore_errors=True)
    stage.mkdir(parents=True)
    artifact = download(LOCK['engineArtifact']['source'], SCRATCH / 'engine.tgz')
    if digest(artifact) != LOCK['engineArtifact']['sha256']:
        raise ValueError('Engine package integrity mismatch')
    with tarfile.open(artifact) as archive:
        for member in archive.getmembers():
            name = str(safe_name(member.name))
            if member.isfile() and name.startswith('package/dist/'):
                target = stage / 'engine' / name.removeprefix('package/dist/')
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
    # The published JS has extensionless (TypeScript-style) relative imports: resolved for direct browser ES modules.
    fixes = []
    for file in sorted((stage / 'engine').rglob('*.js')):
        def resolve(match):
            spec = match.group(2)
            if Path(spec).suffix:
                return match.group(0)
            dest = file.parent / spec
            suffix = '/index.js' if dest.is_dir() else '.js'
            if not Path(str(dest) + suffix).is_file():
                raise ValueError('Unresolved browser import: ' + spec)
            fixes.append(str(file.relative_to(stage)) + ':' + spec + suffix)
            return match.group(1) + spec + suffix + match.group(3)
        file.write_text(re.sub(r"((?:from|import)\s*['\"])(\.{1,2}/[^'\"]+)(['\"])", resolve, file.read_text()))
    for entry in LOCK['files']:
        if 'source' in entry:
            download(entry['source'], stage / entry['path'])
    for entry in LOCK['files']:
        if digest(stage / entry['path']) != entry['sha256']:
            raise ValueError('Integrity mismatch: ' + entry['path'])
    (stage / 'release.json').write_text(json.dumps({**{k: LOCK[k] for k in ('id', 'upstream', 'commit', 'engineArtifact')}, 'browserImportFixes': fixes, 'files': LOCK['files']}, indent=2) + '\n')
    release.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(stage), str(release))
    shutil.rmtree(SCRATCH, ignore_errors=True)
    print('Installed', release)


if __name__ == '__main__':
    main()
