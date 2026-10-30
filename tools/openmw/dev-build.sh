#!/bin/sh
# Incremental development builds of the OpenMW browser engine (docs/openmw.md): a tree kept by
# `sh tools/openmw/build.sh <dev id> --keep` (its sources with the dev build's patches applied, configured and compiled
# once, /tmp/orthros-scratch/openmw-build/<dev id>/root) recompiled with extra patches over it in minutes instead of a
# whole build, and installed as a release beside the dev build's own — for measuring and checking a change before it
# becomes an engine release of tools/openmw/build.sh. Nothing here is pinned: a release that ships is built by build.sh.
#
# The patches (git diffs with paths from the tree's root, as tools/openmw/patches/) are applied over the kept tree in
# the order given, after those of the previous run are reverted (the tree's .orthros-dev-patches lists them), so a run
# builds exactly its own set. One run at a time on a tree (flock): runs from parallel agents queue. In the pinned
# Emscripten image, without network, 8 CPUs, niced, once the load allows (CLAUDE.md "Shared server budget") and no
# other engine build runs.
#   --check: compile only the .cpp files the patches touch (OpenMW's and OSG's object files), then revert them — a
#            compile check; no link, nothing installed.
#   default: OSG (build-osg.sh: its ninja, incremental), OpenMW (ninja components openmw-lib), the link
#            (link-openmw.sh), then <release dir> made from <base release> (its other files hard-linked: never written
#            through) with the new e/<hash>/openmw.{js,wasm,data}, streamfs.js and index.html. The patches stay applied.
# Usage: sh tools/openmw/dev-build.sh <kept root> <base release> <release dir> [--check] [--patch <file>]...
#   e.g. sh tools/openmw/dev-build.sh /tmp/orthros-scratch/openmw-build/openmw-web-v1.5.3-orthros-r11dev/root \
#          /tmp/orthros-scratch/mw-perf/engines/openmw-web-v1.5.3-orthros-r11dev /tmp/orthros-scratch/mw-perf/engines/dev-a \
#          --patch /tmp/orthros-scratch/mw-perf/patches/A.patch
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# (one compile at a time for the whole project, and only with memory to spare: CLAUDE.md "Memory budget")
exec 8>/tmp/orthros-heavy-build.lock; flock 8
"$here/../mem-check.sh" -w "${ORTHROS_BUILD_MEM_MIN_GB:-24}"
[ $# -ge 3 ] || { sed -n '2,20p' "$0" >&2; exit 64; }
root=$(cd "$1" && pwd) base=$2 out=$3; shift 3
check=0 patches=
while [ $# -gt 0 ]; do
  case $1 in
    --check) check=1; shift ;;
    --patch) [ -f "$2" ] || { echo "no patch $2" >&2; exit 64; }; patches="$patches $(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 64 ;;
  esac
done
test -f "$root/build-wasm64/build.ninja" || { echo "$root is not a kept build tree (build.sh --keep)" >&2; exit 1; }
image=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['build']['image'])" "$here/lock.json")
cache=$(cd "$here/../.." && pwd)/data/engines/$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['build']['emscriptenCache'])" "$here/lock.json")
[ -d "$cache" ] || cache=/srv/orthros/data/engines/$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['build']['emscriptenCache'])" "$here/lock.json")
bin=$(dirname "$root")/bin
state=$root/.orthros-dev-patches

exec 9>"$(dirname "$root")/dev-build.lock"
flock 9

# (the previous run's patches reverted, newest first; then this run's applied in order)
if [ -s "$state" ]; then
  tac "$state" | while read -r p; do
    git -C "$root" apply -R --whitespace=nowarn "$root/.orthros-dev-applied/$(basename "$p")" || { echo "cannot revert $p: the kept tree needs a look" >&2; exit 1; }
  done
fi
: > "$state"; rm -rf "$root/.orthros-dev-applied"; mkdir -p "$root/.orthros-dev-applied"
for p in $patches; do
  if ! git -C "$root" apply --whitespace=nowarn "$p"; then
    echo "$p does not apply over the kept tree (with the patches before it)" >&2
    tac "$state" | while read -r q; do git -C "$root" apply -R --whitespace=nowarn "$root/.orthros-dev-applied/$(basename "$q")"; done
    : > "$state"; exit 2
  fi
  cp "$p" "$root/.orthros-dev-applied/$(basename "$p")"; echo "$p" >> "$state"
done

"$here/../disk-check.sh"
while [ "$(cut -d. -f1 /proc/loadavg)" -ge 24 ]; do echo "load $(cut -d' ' -f1 /proc/loadavg) >= 24, waiting"; sleep 60; done
run() {
  docker run --rm --network none --cpus 8 --memory ${ORTHROS_BUILD_MEM:-20g} --memory-swap ${ORTHROS_BUILD_MEM:-20g} -u "$(id -u):$(id -g)" -e HOME=/tmp \
    -e ROOT=/build -e EM_LIBEXEC=/emsdk/upstream/emscripten -e EMSDK_BIN=/emsdk/upstream/emscripten -e OMW_WASM64=1 -e JOBS=8 \
    -v "$root:/build" -v "$bin:/orthros-bin:ro" -v "$cache:/emsdk/upstream/emscripten/cache" -w /build "$image" nice -n 19 sh -c \
    "set -e; export PATH=/orthros-bin:\$PATH EMSDK_BIN=/emsdk/upstream/emscripten; $1"
}

if [ "$check" = 1 ]; then
  # (each touched .cpp's object file, in OpenMW's build or OSG's: a script run in the image)
  {
    echo 'set -e'
    for p in $patches; do sed -n 's|^+++ b/\(.*\.cpp\)$|\1|p' "$p"; done | sort -u | while read -r f; do
      case $f in
        deps/src/osg/*) dir=deps/src/osg/build-wasm64 rel=${f#deps/src/osg/} ;;
        openmw/*) dir=build-wasm64 rel=${f#openmw/} ;;
        *) continue ;;
      esac
      echo "t=\$(ninja -C $dir -t targets all | cut -d: -f1 | grep -F '/$(basename "$rel").o' | grep -F '$(basename "$(dirname "$rel")")' | head -3)"
      echo "[ -n \"\$t\" ] || { echo 'no object file for $f'; exit 1; }"
      echo "ninja -C $dir \$t"
    done
  } > "$root/.orthros-dev-check.sh"
  status=0
  run 'sh .orthros-dev-check.sh' > "$root/.orthros-dev-check.log" 2>&1 || status=$?
  grep -E 'error|FAILED|no object file' "$root/.orthros-dev-check.log" | head -60 || true
  tac "$state" | while read -r q; do git -C "$root" apply -R --whitespace=nowarn "$root/.orthros-dev-applied/$(basename "$q")"; done
  : > "$state"
  [ "$status" = 0 ] && echo "check: compiled ($(grep -c '\.o$\|Building' "$root/.orthros-dev-check.log") step(s))" || { echo "check: compile errors (above; whole log $root/.orthros-dev-check.log)" >&2; exit 3; }
  exit 0
fi

# (not two engine compilations at once on the shared machine: another one running — build.sh's, another tree's — is
# waited for; a --check is a few files, it does not wait)
while [ -n "$(docker ps -q --filter "ancestor=$image")" ]; do echo "another engine build is running, waiting"; sleep 30; done
start=$(date +%s)
run 'bash wasm-build/build-osg.sh >/tmp/osg.log 2>&1 || { tail -40 /tmp/osg.log; exit 1; }; ninja -C build-wasm64 components openmw-lib; bash wasm-build/link-openmw.sh' \
  > "$root/.orthros-dev-build.log" 2>&1 || true
grep -E '^(FAILED|Linked)|error:' "$root/.orthros-dev-build.log" | head -60 || true
test "$root/build-wasm64/openmw.wasm" -nt "$state" || { echo "build failed (no new openmw.wasm; whole log $root/.orthros-dev-build.log)" >&2; exit 1; }
echo "built in $(( $(date +%s) - start )) s"
python3 - "$root" "$base" "$out" <<'PY'
import hashlib, json, os, pathlib, shutil, sys
root, base, out = map(pathlib.Path, sys.argv[1:])
build, play = root / 'build-wasm64', root / 'play'
h = hashlib.sha256()
for f in (build / 'openmw.wasm', build / 'openmw.js', build / 'openmw.data', play / 'streamfs.js'): h.update(f.read_bytes())
ver = h.hexdigest()[:12]
if out.exists(): shutil.rmtree(out)
out.mkdir(parents=True)
def link(src, dst):
    # (hard links within one file system; across file systems — a live release under data/ as the base — symlinks)
    try: os.link(src, dst)
    except OSError as e:
        if e.errno != 18: raise
        os.symlink(os.path.abspath(src), dst)
for f in base.iterdir():
    if f.name in ('e', 'index.html', 'release.json', 'engine-version.txt'): continue
    # (the base release's other files linked, never written: the portal, notices, the asset pack)
    (shutil.copytree(f, out / f.name, copy_function=link) if f.is_dir() else link(f, out / f.name))
e = out / 'e' / ver; e.mkdir(parents=True)
for n in ('openmw.js', 'openmw.wasm', 'openmw.data', 'openmw.js.symbols'): shutil.copy2(build / n, e / n)
shutil.copy2(play / 'streamfs.js', e / 'streamfs.js')
(out / 'index.html').write_text((play / 'index.html').read_text().replace('__ENGINE_VERSION__', ver).replace('src="streamfs.js"', f'src="e/{ver}/streamfs.js"'))
(out / 'engine-version.txt').write_text(ver)
info = json.loads((base / 'release.json').read_text())
patches = [l for l in (root / '.orthros-dev-patches').read_text().split('\n') if l]
info.update({'id': out.name, 'engineVersion': ver, 'devPatches': patches,
             'files': [f'e/{ver}/{n}' for n in ('openmw.js', 'openmw.wasm', 'openmw.data', 'streamfs.js')] + [f for f in info['files'] if not f.startswith('e/')]})
(out / 'release.json').write_text(json.dumps(info, indent=2) + '\n')
print(f'installed {out} (engine {ver})')
PY
