#!/bin/sh
# Build the native multiplayer gateway's image (tools/openmw/server-node.Dockerfile, docs/openmw.md): the pinned
# upstream image (lock.json "serverImage", pulled by install-engine.py --server) with the Node.js release of lock.json
# "serverBuild"."node". The tarball is fetched once (or given with --archive), checked against the lock, used from a
# scratch context and deleted; the build itself runs without network, timestamps fixed (SOURCE_DATE_EPOCH), so the
# same inputs give the same image ID. The ID is compared with lock.json "serverBuild"."image" (an empty one is
# printed, to be pinned; "config" is its config's digest, the ID a classic Docker image store gives); a different ID is
# refused unless --any-id. Tagged lock.json "serverBuild"."tag"; tools/openmw/server.mjs runs it by its ID.
# Usage: sh tools/openmw/build-server-image.sh [--archive <node-vX-linux-x64.tar.xz>] [--any-id]
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
here=$root/tools/openmw
archive= anyid=0
while [ $# -gt 0 ]; do
  case $1 in
    --archive) archive=$2; shift 2 ;;
    --any-id) anyid=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
get() { python3 -I -c "import json,sys; v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split('.'): v=v[k]
print(v)" "$here/lock.json" "$1"; }
base=$(get serverImage) version=$(get serverBuild.node.version) url=$(get serverBuild.node.url) sha=$(get serverBuild.node.sha256)
tag=$(get serverBuild.tag) want=$(get serverBuild.image) config=$(get serverBuild.config) epoch=$(get serverBuild.sourceDateEpoch)
dockerfile=$here/$(get serverBuild.dockerfile)
[ "$(get serverBuild.base)" = "$base" ] || { echo "serverBuild.base is not serverImage" >&2; exit 1; }
"$root/tools/disk-check.sh"
docker image inspect "$base" >/dev/null 2>&1 || docker pull "$base"
scratch=/tmp/orthros-scratch/openmw-server-image
mkdir -p "$scratch"
ctx=$(mktemp -d "$scratch/ctx.XXXXXX")
trap 'rm -rf "$ctx"; rmdir "$scratch" 2>/dev/null || :' EXIT
if [ -n "$archive" ]; then cp "$archive" "$ctx/node.tar.xz"; else curl -fsSL -o "$ctx/node.tar.xz" "$url"; fi
echo "$sha  $ctx/node.tar.xz" | sha256sum -c -
SOURCE_DATE_EPOCH=$epoch docker build --no-cache --network none --pull=false --provenance=false --sbom=false -f "$dockerfile" \
  --build-arg BASE="$base" --build-arg NODE_VERSION="$version" --build-arg NODE_SHA256="$sha" \
  --output type=image,name="$tag",rewrite-timestamp=true,unpack=false "$ctx"
# (the image ID: its manifest's digest in Docker's containerd image store, its config's in the classic one)
id=$(docker image inspect --format '{{.Id}}' "$tag")
echo "built $tag $id ($(docker run --rm --network none --entrypoint node "$id" --version))"
if [ -z "$want" ]; then echo "pin it: lock.json serverBuild.image = $id"
elif [ "$id" != "$want" ] && [ "$id" != "$config" ]; then
  echo "image ID $id differs from lock.json's $want" >&2
  [ $anyid = 1 ] || exit 1
fi
