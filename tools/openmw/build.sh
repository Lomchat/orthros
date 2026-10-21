#!/bin/sh
# Build Orthros' own releases of the OpenMW browser engine (docs/openmw.md) from the pinned upstream source
# (lock.json "source": openmw-web, installed in data_engines/src/<id>/ by install-engine.py) with a build's patches
# (tools/openmw/patches/, lock.json "builds"), into a release data_engines/<build id>/ laid out as the upstream one
# (index.html stamped with the engine's hash, e/<hash>/openmw.{js,wasm,data}, its .br siblings, streamfs.js), the
# upstream release's other files (lock.json "id": its asset pack, portal pages, notices) copied beside it.
# On the pattern of tools/re3/build.sh: the dependency sources (lock.json "build": OSG, Bullet, MyGUI, FFmpeg, Boost,
# Lua, LZ4 and the three archives OpenMW's CMake fetches) and Emscripten's ports are fetched once, with network,
# into data_engines/src/ and checked against the lock; every compilation then runs in the pinned Emscripten image
# (plus ninja and pkg-config, tools/openmw/emsdk.Dockerfile) without network, on a copy in scratch, with 8 CPUs.
# The engine's package also carries the upstream demo world (fsroot/gamedata, not in the source archive): it is taken
# from the upstream release's own package, checked against the lock. A build whose engine files differ from the
# lock's "files" is refused (an empty "files" prints them, to be pinned). An installed release is never overwritten.
# Needs git, Docker, Python 3, Node (brotli siblings).
# Usage: sh tools/openmw/build.sh [<build id>...] [--engines-dir <dir>] [--dest <dir>] [--keep]
#   --dest: where the releases go (default: the engines dir); --keep: leave the scratch build tree.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
here=$root/tools/openmw
engines=$root/data_engines dest= ids= keep=0
while [ $# -gt 0 ]; do
  case $1 in
    --engines-dir) engines=$2; shift 2 ;;
    --dest) dest=$2; shift 2 ;;
    --keep) keep=1; shift ;;
    *) ids="$ids $1"; shift ;;
  esac
done
[ -n "$dest" ] || dest=$engines
lock=$here/lock.json
build() { python3 -c "import json,sys; v=json.load(open(sys.argv[1]))['build'][sys.argv[2]]; print(' '.join(v) if isinstance(v, list) else v)" "$lock" "$1"; }
top() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$lock" "$1"; }
[ -n "$ids" ] || ids=$(python3 -c "import json,sys; print(' '.join(b['id'] for b in json.load(open(sys.argv[1]))['builds']))" "$lock")
upstream=$(top id); tag=$(top tag)
source=$engines/src/$upstream/openmw-web-$tag base=$engines/$upstream
deps=$engines/$(build deps) cache=$engines/$(build emscriptenCache) image=$(build image)
"$root/tools/disk-check.sh"
# (the shared server's budget, CLAUDE.md: no heavy job while the 1-minute load is half the cores)
waitload() { while [ "$(cut -d. -f1 /proc/loadavg)" -ge 24 ]; do echo "load $(cut -d' ' -f1 /proc/loadavg) >= 24, waiting"; sleep 60; done; }

# ---- the upstream source and release (install-engine.py)
test -d "$source/openmw" && test -f "$base/release.json" || { echo "Install the upstream engine first: python3 tools/openmw/install-engine.py" >&2; exit 1; }

# ---- the compiler image: the pinned Emscripten image + ninja, pkg-config
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -t "$image" -f "$here/emsdk.Dockerfile" "$here"
fi
python3 - "$lock" "$(docker run --rm --network none "$image" cat /usr/local/share/orthros-packages.txt)" <<'PY'
import json, sys
want = json.load(open(sys.argv[1]))['build']['imagePackages']
have = dict(l.split('\t') for l in sys.argv[2].splitlines())
if have != want: sys.exit(f'The compiler image packages differ from lock.json: {have}')
PY

# ---- the dependency sources, fetched once (network) and checked
mkdir -p "$deps/archives"
python3 - "$lock" "$deps" <<'PY'
import hashlib, json, pathlib, subprocess, sys, urllib.request
b = json.load(open(sys.argv[1]))['build']; deps = pathlib.Path(sys.argv[2])
for name, g in b['git'].items():
    d = deps / name
    if not (d / '.git').is_dir():
        subprocess.run(['git', 'clone', '-q', '--depth', '1', '--branch', g['tag'], g['url'], str(d)], check=True)
    head = subprocess.run(['git', '-C', str(d), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(['git', '-C', str(d), 'status', '--porcelain'], check=True, capture_output=True, text=True).stdout
    if head != g['commit'] or dirty: sys.exit(f'{name}: {head} (or modified), lock.json pins {g["commit"]}')
for name, a in b['archives'].items():
    f = deps / 'archives' / name
    if not f.is_file(): urllib.request.urlretrieve(a['url'], f)
    if hashlib.sha256(f.read_bytes()).hexdigest() != a['sha256']: sys.exit(f'{name} differs from lock.json')
PY

# ---- Emscripten's sysroot and ports (wasm64, threads), cached once (network: the ports' archives)
if [ ! -d "$cache/ports" ]; then
  mkdir -p "$cache"
  docker run --rm -u "$(id -u):$(id -g)" -v "$cache:/cache" "$image" sh -c 'cp -r /emsdk/upstream/emscripten/cache/. /cache/'
  docker run --rm --cpus 8 -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$cache:/emsdk/upstream/emscripten/cache" "$image" sh -c '
    set -e; cd /tmp; printf "int main(){return 0;}\n" > p.c
    emcc -m64 -pthread -sUSE_ICU=1 p.c -o icu.js
    emcc -m64 -pthread -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1 p.c -o gl.js
    emcc -m64 -pthread -fwasm-exceptions -sMALLOC=mimalloc -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_HARFBUZZ=1 -sUSE_LIBPNG=1 \
      -sUSE_LIBJPEG=1 -sUSE_ZLIB=1 -sUSE_OGG=1 -sUSE_VORBIS=1 -lopenal p.c -o ports.js
    emcc -m64 -pthread -sUSE_SDL=2 -sUSE_SDL_IMAGE=2 -sSDL2_IMAGE_FORMATS="[\"png\"]" p.c -o img.js'  # (MyGUI's CMake asks for it)
fi
python3 - "$lock" "$cache" <<'PY'
import hashlib, json, pathlib, sys
for name, digest in json.load(open(sys.argv[1]))['build']['emscriptenPorts'].items():
    f = pathlib.Path(sys.argv[2], 'ports', name)
    if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest() != digest: sys.exit(f'Emscripten port {name} missing or different from lock.json')
PY

for id in $ids; do
  release=$dest/$id
  if [ -e "$release/release.json" ]; then echo "$id: already installed; preserving it."; continue; fi
  if [ -e "$release" ]; then echo "$release exists without release.json: review it before building." >&2; exit 1; fi
  work=/tmp/orthros-scratch/openmw-build/$id
  rm -rf "$work"; mkdir -p "$work"
  # The tree the upstream build expects: the source, deps/src (dependency sources, OSG patched), deps/fetched (what
  # OpenMW's CMake would download), fsroot's demo world and ICU data, then the build's patches.
  python3 - "$lock" "$id" "$source" "$deps" "$cache" "$base" "$work/root" "$here/patches" <<'PY'
import hashlib, json, pathlib, re, shutil, subprocess, sys, tarfile, zipfile
lock = json.load(open(sys.argv[1])); spec = next(b for b in lock['builds'] if b['id'] == sys.argv[2]); b = lock['build']
source, deps, cache, base, root, patches = map(pathlib.Path, sys.argv[3:])
shutil.copytree(source, root, symlinks=True)
src = root / 'deps/src'; src.mkdir(parents=True)
for name in b['git']: shutil.copytree(deps / name, src / name, ignore=shutil.ignore_patterns('.git'))
fetched = root / 'deps/fetched'; fetched.mkdir()
for name, a in b['archives'].items():
    f = deps / 'archives' / name; into = fetched if a.get('fetchContent') else src
    if name.endswith('.zip'):
        with zipfile.ZipFile(f) as z: z.extractall(into)
    else:
        with tarfile.open(f) as t: t.extractall(into, filter='data')
    if a.get('fetchContent'): (into / a['dir']).rename(into / a['fetchContent'].lower())
subprocess.run(['git', 'apply', '--directory=deps/src/osg', 'wasm-build/patches/osg-emscripten.patch'], cwd=root, check=True)
(root / 'deps/shim').mkdir()  # (build-deps.sh's MyGUI char_traits shim: the one the engine's own build includes)
shutil.copy2(root / 'wasm-build/include/mygui_char_traits_fix.h', root / 'deps/shim/ushort_char_traits.h')
# The demo world, from the upstream release's package (its listing is in openmw.js)
demo = b['demoData']; ver = lock['engineVersion']
pkg = base / 'e' / ver / 'openmw.data'
if hashlib.sha256(pkg.read_bytes()).hexdigest() != demo['packageSha256']: sys.exit('The upstream package differs from lock.json')
listing = re.findall(r'\{filename:"([^"]*)",start:(\d+),end:(\d+)', (base / 'e' / ver / 'openmw.js').read_text())
with pkg.open('rb') as d:
    for name, start, end in listing:
        if not name.startswith(demo['prefix']): continue
        out = root / 'fsroot' / name.lstrip('/'); out.parent.mkdir(parents=True, exist_ok=True)
        d.seek(int(start)); out.write_bytes(d.read(int(end) - int(start)))
icu = cache / 'ports/icu/icu/source/data/in/icudt68l.dat'  # (where the upstream package has it: both places)
shutil.copy2(icu, root / 'fsroot/icudt68l.dat'); (root / 'fsroot/icu').mkdir(); shutil.copy2(icu, root / 'fsroot/icu/icudt68l.dat')
for patch in spec['patches']:
    subprocess.run(['git', 'apply', '--whitespace=nowarn', str(patches / patch)], cwd=root, check=True)
PY
  mkdir -p "$work/bin"
  printf '#!/bin/sh\nexec /usr/bin/ninja -j8 "$@"\n' > "$work/bin/ninja"; chmod +x "$work/bin/ninja"  # (8 jobs, never nproc)
  fc="-DFETCHCONTENT_FULLY_DISCONNECTED=ON $(python3 -c "
import json,sys
for a in json.load(open(sys.argv[1]))['build']['archives'].values():
    if a.get('fetchContent'): print(f\"-DFETCHCONTENT_SOURCE_DIR_{a['fetchContent'].upper()}=/build/deps/fetched/{a['fetchContent'].lower()}\", end=' ')" "$lock")"
  waitload
  start=$(date +%s)
  nice docker run --rm --network none --cpus 8 -u "$(id -u):$(id -g)" -e HOME=/tmp -e FC="$fc" \
    -e ROOT=/build -e EM_LIBEXEC=/emsdk/upstream/emscripten -e EMSDK_BIN=/emsdk/upstream/emscripten -e OMW_WASM64=1 -e JOBS=8 \
    -v "$work/root:/build" -v "$work/bin:/orthros-bin:ro" -v "$cache:/emsdk/upstream/emscripten/cache" -w /build "$image" sh -c '
    set -e; export PATH=/orthros-bin:$PATH EMSDK_BIN=/emsdk/upstream/emscripten  # (the image entrypoint drops EMSDK_* from -e)
    bash wasm-build/build-deps.sh em_ports openal_stub sdl2_cfg lz4 lua boost bullet mygui ffmpeg osg
    bash configure-openmw.sh $FC
    ninja -C build-wasm64 components openmw-lib
    bash wasm-build/link-openmw.sh' 2>&1 | tee "$work/build.log" | grep -E '^(=== |FAILED|.*error:|Linked)' || true
  test -f "$work/root/build-wasm64/openmw.wasm" -a -f "$work/root/build-wasm64/openmw.data" || { echo "$id: build failed, see $work/build.log" >&2; exit 1; }
  echo "$id: compiled in $(( $(date +%s) - start )) s"
  python3 - "$lock" "$id" "$work" "$release" "$base" "$here/patches" <<'PY'
import hashlib, json, pathlib, shutil, sys
lock = json.load(open(sys.argv[1])); spec = next(b for b in lock['builds'] if b['id'] == sys.argv[2])
work, release, base, patches = map(pathlib.Path, sys.argv[3:])
out, play = work / 'root/build-wasm64', work / 'root/play'
sha = lambda f: hashlib.sha256(f.read_bytes()).hexdigest()
built = {n: sha(out / n) for n in ('openmw.js', 'openmw.wasm', 'openmw.data')}
want = spec.get('files') or {}
if want and want != built:
    sys.exit(f'{spec["id"]}: files differ from lock.json: {sorted(k for k in set(want) | set(built) if want.get(k) != built.get(k))}')
# The upstream's content version (wasm-build/version-engine.sh): 12 hex digits over the files of e/<hash>/
h = hashlib.sha256()
for f in (out / 'openmw.wasm', out / 'openmw.js', out / 'openmw.data', play / 'streamfs.js'): h.update(f.read_bytes())
ver = h.hexdigest()[:12]
staging = release.with_name(release.name + '.partial'); shutil.rmtree(staging, ignore_errors=True)
upstream = json.loads((base / 'release.json').read_text())
skip = {'e', 'release.json', 'engine-version.txt', 'index.html'}
staging.mkdir(parents=True)
for f in base.iterdir():
    if f.name not in skip: (shutil.copytree if f.is_dir() else shutil.copy2)(f, staging / f.name)
e = staging / 'e' / ver; e.mkdir(parents=True)
for n in ('openmw.js', 'openmw.wasm', 'openmw.data', 'openmw.js.symbols'): shutil.copy2(out / n, e / n)
shutil.copy2(play / 'streamfs.js', e / 'streamfs.js')
index = (play / 'index.html').read_text().replace('__ENGINE_VERSION__', ver).replace('src="streamfs.js"', f'src="e/{ver}/streamfs.js"')
(staging / 'index.html').write_text(index); (staging / 'engine-version.txt').write_text(ver)
files = [f'e/{ver}/{n}' for n in ('openmw.js', 'openmw.wasm', 'openmw.data', 'streamfs.js')] + [f for f in upstream['files'] if not f.startswith('e/')]
info = {'schemaVersion': 1, 'id': spec['id'], 'runtime': 'openmw', 'engineVersion': ver,
        'upstream': {k: upstream[k] for k in ('id', 'tag', 'upstream', 'engineVersion', 'source')},
        'build': {k: lock['build'][k] for k in ('baseImage', 'imagePackages', 'emscriptenPorts', 'git', 'archives')},
        'patches': [{'patch': p, 'sha256': sha(patches / p)} for p in spec['patches']],
        'exports': spec.get('exports', []), 'engineFiles': built, 'files': files}
(staging / 'release.json').write_text(json.dumps(info, indent=2) + '\n')
(work / 'staging').write_text(str(staging))
if not want: print(json.dumps(built, indent=2))
PY
  staging=$(cat "$work/staging")
  # The brotli siblings the server sends a browser asking for a whole file (src/host/server.js)
  for f in "$staging"/e/*/openmw.js "$staging"/e/*/openmw.wasm "$staging"/e/*/openmw.data; do
    nice node -e "const z=require('zlib'),fs=require('fs');fs.writeFileSync(process.argv[1]+'.br',z.brotliCompressSync(fs.readFileSync(process.argv[1]),{params:{[z.constants.BROTLI_PARAM_QUALITY]:9,[z.constants.BROTLI_PARAM_LGWIN]:24,[z.constants.BROTLI_PARAM_SIZE_HINT]:fs.statSync(process.argv[1]).size}}))" "$f"
  done
  mv "$staging" "$release"
  echo "$id: installed in $release"
  [ "$keep" = 1 ] || rm -rf "$work"
done
