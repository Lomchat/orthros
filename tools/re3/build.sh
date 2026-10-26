#!/bin/sh
# Build the re3-family engine of an "re3" browser port (docs/browser-ports.md, "re3 ports") from pinned sources
# (lock.json "engine": Orthros' fork, its browser branch — the browser build defined there; a build may add its own
# CMake options, "cmake": Orthros' modified game's -DREVC_ORTHROS_EXTRAS=ON) into a release
# data/engines/<id>/ per build of "builds": the engine compiled to WebAssembly (engine/revc.mjs, an Emscripten ES module,
# and engine/revc.wasm), with a build's patches if it names any (tools/re3/patches/), the engine's own game files
# (gamefiles/: laid over the game's by the server) and the sources' licence notices (notices/).
# The sources are cloned with their submodules in data/engines/src/<repository name> and stay as pinned; a build works
# on a copy in scratch. The compiler is the pinned Emscripten image, without network; its SDL2 and mpg123 ports come
# from a cache in data/engines/ (made once, with network, the archives checked against the lock). The pinned commit's
# time is the build time the sources record: a build whose files differ from the lock's "files" is refused (an empty
# "files" prints them, to be pinned). An installed release is never overwritten. Needs git, Docker, Python 3.
# Usage: sh tools/re3/build.sh [<build id>...] [--engines-dir <dir>]   (all builds by default)
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
engines=$root/data/engines ids=
while [ $# -gt 0 ]; do
  case $1 in
    --engines-dir) engines=$2; shift 2 ;;
    *) ids="$ids $1"; shift ;;
  esac
done
lock=$root/tools/re3/lock.json
field() { python3 -c "import json,sys; v=json.load(open(sys.argv[1]))['engine'][sys.argv[2]]; print(' '.join(v) if isinstance(v, list) else v)" "$lock" "$1"; }
[ -n "$ids" ] || ids=$(python3 -c "import json,sys; print(' '.join(b['id'] for b in json.load(open(sys.argv[1]))['builds']))" "$lock")
repository=$(field repository); commit=$(field commit); image=$(field emsdk)
source=$engines/src/$(basename "$repository") cache=$engines/$(field emscriptenCache)
"$root/tools/disk-check.sh"

# ---- the pinned sources
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
want = json.load(open(sys.argv[1]))['engine']['submodules']
lines = subprocess.run(['git', '-C', sys.argv[2], 'submodule', 'status', '--recursive'], check=True, capture_output=True, text=True).stdout.splitlines()
have = {l.split()[1]: l.split()[0].lstrip('+-U') for l in lines}
if have != want: sys.exit(f'Submodules differ from lock.json: {sorted(set(have.items()) ^ set(want.items()))}')
PY

# ---- Emscripten's ports (SDL2, mpg123), cached once
if [ ! -d "$cache/ports" ]; then
  mkdir -p "$cache"
  docker run --rm -u "$(id -u):$(id -g)" -v "$cache:/cache" "$image" sh -c 'cp -r /emsdk/upstream/emscripten/cache/. /cache/'
  docker run --rm -u "$(id -u):$(id -g)" -v "$cache:/emsdk/upstream/emscripten/cache" "$image" embuilder build sdl2 mpg123
fi
python3 - "$lock" "$cache" <<'PY'
import hashlib, json, pathlib, sys
for name, digest in json.load(open(sys.argv[1]))['engine']['emscriptenPorts'].items():
    f = pathlib.Path(sys.argv[2], 'ports', name)
    if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest() != digest: sys.exit(f'Emscripten port {name} missing or different from lock.json')
PY

export SOURCE_DATE_EPOCH="$(git -C "$source" log -1 --format=%ct)"
cmake_args=$(field cmake)
for id in $ids; do
  release=$engines/$id
  if [ -e "$release/release.json" ]; then echo "$id: already installed; preserving it."; continue; fi
  if [ -e "$release" ]; then echo "$release exists without release.json: review it before building." >&2; exit 1; fi
  build=/tmp/orthros-scratch/re3-build/$id
  rm -rf "$build"; mkdir -p "$build/wasm" "$build/out"
  cp -a "$source" "$build/src"
  python3 - "$lock" "$id" "$build/src" "$root/tools/re3/patches" <<'PY'
import json, subprocess, sys
build = next(b for b in json.load(open(sys.argv[1]))['builds'] if b['id'] == sys.argv[2])
for repo, patch in build['patches']:
    subprocess.run(['git', '-C', f'{sys.argv[3]}/{repo}', 'apply', f'{sys.argv[4]}/{patch}'], check=True)
PY
  # (a build's own CMake options after the engine's: Orthros' modified game, say)
  build_args="$cmake_args $(python3 -c "import json,sys; print(' '.join(next(b for b in json.load(open(sys.argv[1]))['builds'] if b['id'] == sys.argv[2]).get('cmake', [])))" "$lock" "$id")"
  docker run --rm --network none --cpus 8 -u "$(id -u):$(id -g)" -e SOURCE_DATE_EPOCH -e CMAKE_ARGS="$build_args" \
    -v "$build/src:/revc" -v "$build/wasm:/build" -v "$cache:/emsdk/upstream/emscripten/cache" -w /revc "$image" sh -c '
    emcmake cmake -S /revc -B /build $CMAKE_ARGS && cmake --build /build -j8'
  python3 - "$lock" "$id" "$build" "$release" "$root/tools/re3/patches" <<'PY'
import hashlib, json, pathlib, shutil, sys
lock = json.load(open(sys.argv[1])); spec = next(b for b in lock['builds'] if b['id'] == sys.argv[2])
build, release, patches = pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]), pathlib.Path(sys.argv[5])
sha = lambda f: hashlib.sha256(f.read_bytes()).hexdigest()
staging = release.with_name(release.name + '.partial')
shutil.rmtree(staging, ignore_errors=True)
(staging / 'engine').mkdir(parents=True)
for name in ('revc.mjs', 'revc.wasm'): shutil.copy2(build / 'wasm/src' / name, staging / 'engine' / name)
shutil.copytree(build / 'src/gamefiles', staging / 'gamefiles')
(staging / 'notices').mkdir()
for src, dst in (('LICENSE.md', 'reVC-LICENSE.md'), ('PROOF_OF_USAGE.md', 'reVC-PROOF_OF_USAGE.md'), ('vendor/librw/LICENSE', 'librw-LICENSE')):
    if (build / 'src' / src).is_file(): shutil.copy2(build / 'src' / src, staging / 'notices' / dst)
files = {str(f.relative_to(staging)): sha(f) for f in sorted(staging.rglob('*')) if f.is_file() and f.parts[len(staging.parts)] in ('engine', 'gamefiles')}
want = spec.get('files') or {}
built = {k: v for k, v in files.items() if k.startswith('engine/')} # (the game files come from the pinned commit as they are)
if want and want != built:
    diff = sorted(k for k in set(want) | set(built) if want.get(k) != built.get(k))
    shutil.rmtree(staging); sys.exit(f'{spec["id"]}: files differ from lock.json: {diff}')
info = {'id': spec['id'], 'engine': {k: lock['engine'][k] for k in ('repository', 'commit', 'upstream', 'submodules', 'emsdk', 'emscriptenPorts', 'cmake')}, 'cmake': spec.get('cmake', []),
        'patches': [{'repo': r, 'patch': p, 'sha256': sha(patches / p)} for r, p in spec['patches']], 'files': files}
(staging / 'release.json').write_text(json.dumps(info, indent=2) + '\n')
staging.rename(release)
if not want: print(json.dumps(built, indent=2))
print(f'{spec["id"]}: installed in {release}')
PY
  # (each compressible file's brotli 11 beside it — after release.json, whose files are the build's: what the server
  # sends a browser that takes it, tools/engine-br.mjs)
  [ -e "$release/release.json" ] && node "$root/tools/engine-br.mjs" "$release" > /dev/null
  rm -rf "$build"
done
