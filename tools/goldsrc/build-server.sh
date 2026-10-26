#!/bin/sh
# Build the native GoldSrc dedicated server (Xash3D FWGS at the commit pinned in lock.json "dedicatedServer") into
# data/engines/<id>/. Sources are cloned in data/engines/src/xash3d-fwgs; the build itself goes to scratch.
# Needs Python 3, gcc/g++ with 32-bit development libraries, git. An installed release is never overwritten.
# Usage: sh tools/goldsrc/build-server.sh [<engines-dir>]
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
engines=${1:-$root/data/engines}
lock=$root/tools/goldsrc/lock.json
field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['dedicatedServer'][sys.argv[2]])" "$lock" "$1"; }
id=$(field id); commit=$(field commit); repository=$(field repository)
source=$engines/src/xash3d-fwgs
build=/tmp/orthros-scratch/goldsrc-server-build
release=$engines/$id
"$root/tools/disk-check.sh"
if [ -e "$release/release.json" ]; then echo 'Dedicated-server release already installed; preserving it.'; exit 0; fi
if [ -e "$release" ]; then echo "$release exists without release.json: review it before building." >&2; exit 1; fi
if [ ! -d "$source/.git" ]; then
  mkdir -p "$engines/src"
  git clone "$repository" "$source"
  git -C "$source" checkout --detach "$commit"
fi
test "$(git -C "$source" rev-parse HEAD)" = "$commit"
test -z "$(git -C "$source" status --porcelain)"
git -C "$source" submodule update --init --recursive 3rdparty/library_suffix 3rdparty/libbacktrace/libbacktrace 3rdparty/mbedtls/mbedtls
rm -rf "$build"; mkdir -p "$build"
cd "$source"
./waf configure -d -T release --out="$build"
./waf build -j2 --out="$build"
mkdir -p "$release"
cp "$build/engine/xash" "$build/filesystem/filesystem_stdio.so" "$release/"
python3 - "$release" "$repository" "$commit" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
files = [{'path': n, 'sha256': hashlib.sha256((root / n).read_bytes()).hexdigest()} for n in ['xash', 'filesystem_stdio.so']]
(root / 'release.json').write_text(json.dumps({'repository': sys.argv[2], 'commit': sys.argv[3], 'files': files}, indent=2) + '\n')
PY
rm -rf "$build"
echo "Built $release"
