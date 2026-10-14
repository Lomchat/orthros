#!/bin/sh
# Build the game modules of a GoldSrc browser port from pinned sources (lock.json "modules", docs/browser-ports.md) into
# a browser engine release data_engines/<id>/: the engine files of the release it extends (checked against lock.json
# "browser"), the client, menu and server modules compiled to WebAssembly in the pinned Emscripten image (no network),
# and the server library compiled natively (32-bit Linux) for the dedicated server (goldsrc.multiplayer.gameLibrary).
# Sources are cloned with their submodules in data_engines/src/<repository name> and stay as pinned; the build works on
# a copy in scratch where tools/goldsrc/patches/ are applied. Every WebAssembly module lock.json "modules.files" lists
# must come out identical. Needs git, Docker, Python 3, cmake, g++ with 32-bit libraries. An installed release is never
# overwritten.
# Usage: sh tools/goldsrc/build-modules.sh [<engines-dir>]
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
engines=${1:-$root/data_engines}
lock=$root/tools/goldsrc/lock.json
field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['modules'][sys.argv[2]])" "$lock" "$1"; }
id=$(field id); repository=$(field repository); commit=$(field commit); image=$(field emsdk)
source=$engines/src/$(basename "$repository")
build=/tmp/orthros-scratch/goldsrc-modules-build
release=$engines/$id
"$root/tools/disk-check.sh"
if [ -e "$release/release.json" ]; then echo 'Modules release already installed; preserving it.'; exit 0; fi
if [ -e "$release" ]; then echo "$release exists without release.json: review it before building." >&2; exit 1; fi
if [ ! -d "$source/.git" ]; then
  mkdir -p "$engines/src"
  git clone "$repository" "$source"
  git -C "$source" checkout --detach "$commit"
fi
test "$(git -C "$source" rev-parse HEAD)" = "$commit"
git -C "$source" submodule update --init --recursive
test -z "$(git -C "$source" status --porcelain --ignore-submodules=none)"
python3 - "$lock" "$source" <<'PY'
import json, subprocess, sys
want = json.load(open(sys.argv[1]))['modules']['submodules']
lines = subprocess.run(['git', '-C', sys.argv[2], 'submodule', 'status', '--recursive'], check=True, capture_output=True, text=True).stdout.splitlines()
have = {l.split()[1]: l.split()[0].lstrip('+-U') for l in lines}
if have != want: sys.exit(f'Submodules differ from lock.json: {sorted(set(have.items()) ^ set(want.items()))}')
PY
# (the pinned commit's time stands for the build time the sources record: the same sources give the same modules)
export SOURCE_DATE_EPOCH="$(git -C "$source" log -1 --format=%ct)"
rm -rf "$build"; mkdir -p "$build/wasm" "$build/out"
# (the copy keeps the submodules' relative git links: the patches go through git, which knows the files' line endings)
cp -a "$source" "$build/src"
python3 - "$lock" "$build/src" "$root/tools/goldsrc/patches" <<'PY'
import json, subprocess, sys
for repo, patch in json.load(open(sys.argv[1]))['modules']['patches'].items():
    subprocess.run(['git', '-C', f'{sys.argv[2]}/{repo}', 'apply', f'{sys.argv[3]}/{patch}'], check=True)
PY
docker run --rm --network none --cpus 8 -u "$(id -u):$(id -g)" -e SOURCE_DATE_EPOCH \
  -v "$build/src:/cs" -v "$build/wasm:/build" -v "$build/out:/out" -v "$root/tools/goldsrc/cmake:/cmake:ro" -w /cs "$image" sh -c '
  emcmake cmake -S /cs -B /build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/out \
    -DCMAKE_PROJECT_INCLUDE=/cmake/emscripten-side-modules.cmake -DCMAKE_PROJECT_regamedll_INCLUDE=/cmake/hidden-visibility.cmake \
    -DMAINUI_USE_STB=ON -DBUILD_YAPB=OFF -DBUILD_EXTRAS=OFF && cmake --build /build -j8 --target install'
CXX="g++ -m32" cmake -S "$build/src/3rdparty/ReGameDLL_CS" -B "$build/native" -DCMAKE_BUILD_TYPE=Release -DXASH_COMPAT=ON
cmake --build "$build/native" -j8
python3 - "$lock" "$engines" "$build" "$root/tools/goldsrc" <<'PY'
import hashlib, json, pathlib, shutil, sys
lock = json.load(open(sys.argv[1])); mods = lock['modules']
engines, build, tools = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
sha = lambda f: hashlib.sha256(f.read_bytes()).hexdigest()
stage = build / 'stage'
base = engines / mods['engine']
if lock['browser']['id'] != mods['engine'] or not (base / 'release.json').exists(): sys.exit(f'{base}: install the engine first (tools/goldsrc/install-engine.py)')
files = []
def put(src, rel, check=None):
    dest = stage / rel; dest.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(src, dest)
    digest = sha(dest)
    if check and digest != check: sys.exit(f'Integrity mismatch: {rel}')
    files.append({'path': rel, 'sha256': digest, 'bytes': dest.stat().st_size})
for entry in lock['browser']['files']:
    if entry['path'].startswith('engine/'): put(base / entry['path'], entry['path'], entry['sha256'])
want = {e['path']: e['sha256'] for e in mods['files']}
for kind in ['cl_dlls/client', 'cl_dlls/menu', 'dlls/cs']:
    rel = f"{mods['gameDir']}/{kind}_emscripten_wasm32.wasm"
    put(build / 'out' / 'cstrike' / f'{kind}_emscripten_wasm32.wasm', rel, want.get(rel))
put(build / 'native' / 'regamedll' / 'cs.so', f"{mods['gameDir']}/dlls/cs.so")
inputs = {str(f.relative_to(tools)): sha(f) for d in ['patches', 'cmake'] for f in sorted((tools / d).iterdir())}
release = {k: mods[k] for k in ('id', 'engine', 'repository', 'commit', 'submodules', 'emsdk')}
(stage / 'release.json').write_text(json.dumps({**release, 'inputs': inputs, 'files': files}, indent=2) + '\n')
PY
mv "$build/stage" "$release"
rm -rf "$build"
echo "Built $release"
