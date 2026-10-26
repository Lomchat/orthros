#!/bin/sh
# An Orthros server of this code tree (scratch, beside the live one) whose OpenMW pages run a development release
# (tools/openmw/dev-build.sh) in place of the engine the live manifests name: an engines directory in scratch whose
# entries of those names link to it (the upstream release linked as itself, for its assets), the live games read-only,
# a copy of the live learned orders (frozen: what the pages report is not kept), no brotli cache. For measuring and
# checking a development release with the live games' manifests unchanged.
# Usage: sh tools/openmw/dev-serve.sh <release dir> <port> [<scratch dir>]   (prints the server's pid; stop it with kill)
set -eu
release=$(cd "$1" && pwd) port=$2 dir=${3:-/tmp/orthros-scratch/openmw-dev-serve-$2}
root=$(cd "$(dirname "$0")/../.." && pwd) live=/srv/orthros
test -f "$release/index.html" || { echo "$release is not a release" >&2; exit 1; }
mkdir -p "$dir/engines" "$dir/learn"
# (the names the live manifests give their OpenMW engine, each linked to the release under test)
names=$(python3 - "$live/data/games" <<'PY'
import json, pathlib, sys
names = set()
for m in pathlib.Path(sys.argv[1]).glob('*/manifest.json'):
    try: d = json.loads(m.read_text())
    except Exception: continue
    for v in d.get('versions', []):
        e = (v.get('openmw') or {}).get('engine')
        if e: names.add(e)
# (and every Orthros release installed: a manifest switched to another one while the server runs keeps the release under test)
names |= {e.name for e in pathlib.Path(sys.argv[1]).parent.joinpath('engines').glob('openmw-web-*-orthros-r*') if '.' not in e.name.split('-r')[-1]}
print(' '.join(sorted(names)))
PY
)
for n in $names; do
  l="$dir/engines/$n"; [ -L "$l" ] && unlink "$l"; [ -e "$l" ] && { echo "$l exists and is not a link" >&2; exit 1; }
  ln -s "$release" "$l"
done
up="$dir/engines/openmw-web-v1.5.3"; [ -e "$up" ] || ln -s "$live/data/engines/openmw-web-v1.5.3" "$up"
cp /var/lib/orthros2/learn/*morrowind* "$dir/learn/"
cd "$root"
nohup node src/host/server.js --port "$port" --games-dir "$live/data/games" --engines-dir "$dir/engines" --learn "$dir/learn" \
  --br-cache off --covers off > "$dir/server.log" 2>&1 &
echo $!
