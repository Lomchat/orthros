#!/bin/sh
# Build the game modules of a GoldSrc browser port from pinned sources (lock.json "modules", docs/browser-ports.md) into
# a browser engine release data_engines/<id>/ per build of "modules.builds": the engine files of the release it extends
# (checked against lock.json "browser"); the client, menu and server modules compiled to WebAssembly in the pinned
# Emscripten image (no network); the server library compiled natively (32-bit Linux) for the dedicated server
# (goldsrc.multiplayer.gameLibrary); the bots' archive (goldsrc.extras): their profiles and the navigation meshes the
# native server learns for the game's maps (bot-nav.mjs, the game's files and the dedicated-server release needed); a
# build's "assets": archives its generator writes (Python 3 with numpy and Pillow, tools/goldsrc/assets/).
# Sources are cloned with their submodules in data_engines/src/<repository name> and stay as pinned; each build works on
# a copy in scratch where its patches (tools/goldsrc/patches/) are applied. Every module lock.json lists must come out
# identical. Needs git, Docker, Python 3, Node, cmake, g++ with 32-bit libraries. An installed release is
# never overwritten.
# Usage: sh tools/goldsrc/build-modules.sh [<build id>...] [--engines-dir <dir>] [--games-dir <dir>] [--installers-dir <dir>]   (all builds by default)
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
engines=$root/data_engines games=$root/data_games installers=$root/data_installers ids=
while [ $# -gt 0 ]; do
  case $1 in
    --engines-dir) engines=$2; shift 2 ;;
    --games-dir) games=$2; shift 2 ;;
    --installers-dir) installers=$2; shift 2 ;;
    *) ids="$ids $1"; shift ;;
  esac
done
lock=$root/tools/goldsrc/lock.json
field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['modules'][sys.argv[2]])" "$lock" "$1"; }
[ -n "$ids" ] || ids=$(python3 -c "import json,sys; print(' '.join(b['id'] for b in json.load(open(sys.argv[1]))['modules']['builds']))" "$lock")
repository=$(field repository); commit=$(field commit); image=$(field emsdk)
source=$engines/src/$(basename "$repository")
"$root/tools/disk-check.sh"
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

for id in $ids; do
  release=$engines/$id
  if [ -e "$release/release.json" ]; then echo "$id: already installed; preserving it."; continue; fi
  if [ -e "$release" ]; then echo "$release exists without release.json: review it before building." >&2; exit 1; fi
  build=/tmp/orthros-scratch/goldsrc-modules-build/$id
  rm -rf "$build"; mkdir -p "$build/wasm" "$build/out" "$build/navs"
  # (the copy keeps the submodules' relative git links: the patches go through git, which knows the files' line endings)
  cp -a "$source" "$build/src"
  python3 - "$lock" "$id" "$build/src" "$root/tools/goldsrc/patches" <<'PY'
import json, subprocess, sys
build = next(b for b in json.load(open(sys.argv[1]))['modules']['builds'] if b['id'] == sys.argv[2])
for repo, patch in build['patches']:
    subprocess.run(['git', '-C', f'{sys.argv[3]}/{repo}', 'apply', f'{sys.argv[4]}/{patch}'], check=True)
PY
  docker run --rm --network none --cpus 8 -u "$(id -u):$(id -g)" -e SOURCE_DATE_EPOCH \
    -v "$build/src:/cs" -v "$build/wasm:/build" -v "$build/out:/out" -v "$root/tools/goldsrc/cmake:/cmake:ro" -w /cs "$image" sh -c '
    emcmake cmake -S /cs -B /build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/out \
      -DCMAKE_PROJECT_INCLUDE=/cmake/emscripten-side-modules.cmake -DCMAKE_PROJECT_regamedll_INCLUDE=/cmake/hidden-visibility.cmake \
      -DMAINUI_USE_STB=ON -DBUILD_YAPB=OFF -DBUILD_EXTRAS=OFF && cmake --build /build -j8 --target install'
  CXX="g++ -m32" cmake -S "$build/src/3rdparty/ReGameDLL_CS" -B "$build/native" -DCMAKE_BUILD_TYPE=Release -DXASH_COMPAT=ON
  cmake --build "$build/native" -j8
  # (the navigation meshes: learned by the native server on the game's maps)
  python3 -c "import json,sys; b=json.load(open(sys.argv[1]))['modules']['bots']; print(b['game']); print(','.join(b['maps'])); print(b['profiles'])" "$lock" > "$build/bots.txt"
  node "$root/tools/goldsrc/bot-nav.mjs" "$(sed -n 1p "$build/bots.txt")" --library "$build/native/regamedll/cs.so" \
    --profiles "$build/src/$(sed -n 3p "$build/bots.txt")" --out "$build/navs" --maps "$(sed -n 2p "$build/bots.txt")" \
    --games-dir "$games" --engines-dir "$engines"
  python3 - "$lock" "$id" "$engines" "$build" "$root/tools/goldsrc" "$installers" <<'PY'
import hashlib, json, pathlib, shutil, sys, zipfile
lock = json.load(open(sys.argv[1])); mods = lock['modules']
build_spec = next(b for b in mods['builds'] if b['id'] == sys.argv[2])
engines, build, tools = pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]), pathlib.Path(sys.argv[5])
sha = lambda f: hashlib.sha256(f.read_bytes()).hexdigest()
stage = build / 'stage'
base = engines / mods['engine']
if lock['browser']['id'] != mods['engine'] or not (base / 'release.json').exists(): sys.exit(f'{base}: install the engine first (tools/goldsrc/install-engine.py)')
want = {e['path']: e['sha256'] for e in build_spec['files']}
files = []
def put(src, rel, check=None):
    dest = stage / rel; dest.parent.mkdir(parents=True, exist_ok=True)
    if src: shutil.copyfile(src, dest)
    digest = sha(dest)
    if check and digest != check: sys.exit(f'Integrity mismatch: {rel}')
    if not check and rel in want and want[rel] != digest: sys.exit(f'{rel}: not the build lock.json pins')
    files.append({'path': rel, 'sha256': digest, 'bytes': dest.stat().st_size})
for entry in lock['browser']['files']:
    if entry['path'].startswith('engine/'): put(base / entry['path'], entry['path'], entry['sha256'])
for kind in ['cl_dlls/client', 'cl_dlls/menu', 'dlls/cs']:
    put(build / 'out' / 'cstrike' / f'{kind}_emscripten_wasm32.wasm', f"{mods['gameDir']}/{kind}_emscripten_wasm32.wasm")
put(build / 'native' / 'regamedll' / 'cs.so', f"{mods['gameDir']}/dlls/cs.so")
# (the bots' archive, reproducible: sorted entries, a fixed date)
bots = mods['bots']; rel = f"{mods['gameDir']}/{bots['archive']}"
(stage / rel).parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(stage / rel, 'w', zipfile.ZIP_DEFLATED) as z:
    entries = [('BotProfile.db', build / 'src' / bots['profiles'])] + [(f'maps/{n.name}', n) for n in sorted((build / 'navs').glob('*.nav'))]
    for name, src in entries:
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED; info.external_attr = 0o644 << 16
        z.writestr(info, src.read_bytes())
put(None, rel)
# (generated assets: archives a build's generator writes from our own code — e.g. the Half Strike Pokémon's models,
# sprites and sounds — deterministic, so the same inputs give the same archive)
import subprocess
import os
for asset in build_spec.get('assets', []):
    rel = f"{mods['gameDir']}/{asset['archive']}"
    (stage / rel).parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    # (input files the generator reads from outside Git — e.g. the owner's official models in data_installers/ —
    # checked against their pinned SHA-256 and handed over in an environment variable)
    for src in asset.get('sources', []):
        base = pathlib.Path(sys.argv[6]) / src['dir']
        for name, digest in src['files'].items():
            if not (base / name).is_file() or sha(base / name) != digest: sys.exit(f'{base / name}: missing, or not the file lock.json pins')
        env[src['env']] = str(base)
    subprocess.run(['python3', '-I', str(tools / asset['generator']), str(stage / rel)], check=True, stdout=subprocess.DEVNULL, env=env)
    put(None, rel)
dirs = ['patches', 'cmake'] + sorted({a['generator'].split('/')[0] for a in build_spec.get('assets', [])})
inputs = {str(f.relative_to(tools)): sha(f) for d in dirs for f in sorted((tools / d).rglob('*')) if f.is_file() and '__pycache__' not in f.parts}
release = {k: mods[k] for k in ('engine', 'repository', 'commit', 'submodules', 'emsdk')}
(stage / 'release.json').write_text(json.dumps({'id': build_spec['id'], **release, 'patches': build_spec['patches'], 'inputs': inputs, 'files': files}, indent=2) + '\n')
PY
  # (each compressible file's brotli 11 beside it: what the server sends a browser that takes it)
  node "$root/tools/engine-br.mjs" "$build/stage" > /dev/null
  mv "$build/stage" "$release"
  rm -rf "$build"
  echo "Built $release"
done
