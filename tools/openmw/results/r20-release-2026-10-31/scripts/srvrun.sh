#!/bin/bash
# usage: srvrun.sh <port> <out dir> <tool script> <manifest> [args...]: a server of data-r15's code on the r20 overlay
# (games-r20: every Morrowind version on openmw-web-v1.5.3-orthros-r20), --engines-dir data/engines (read only), a fresh
# copy of the pristine learned state, the frozen br-cache copy (lean3 included); the tool through the browser slot
T=/tmp/orthros-scratch/r20-rel; W=/srv/orthros/.claude/worktrees/data-r15
port=$1; out=$2; tool=$3; shift 3
run=$T/srv-$port; /bin/rm -rf $run; mkdir -p $run $out
cp -a $T/pristine/learn $run/learn
/srv/orthros/tools/mem-check.sh -w 24 || exit 3
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) $tool $out $*" >> $T/logs/runs-started.txt
cd $W
node src/host/server.js --port $port --games-dir $T/games-r20 --engines-dir /srv/orthros/data/engines --learn $run/learn --telemetry $run/tel --br-cache $T/pristine/brcache --br-cache-frozen --covers off --no-home-preload > $run/server.log 2>&1 &
srv=$!
for i in $(seq 60); do curl -sf http://127.0.0.1:$port/api/manifests >/dev/null && break; sleep 1; done
curl -s http://127.0.0.1:$port/api/manifest/$1 > $out/manifest-api.json; curl -s "http://127.0.0.1:$port/ports/openmw/$1/app/index.html?src=hosted" | grep -o "/engines/[^\"]*" | head -3 > $out/engine-url.txt
/srv/orthros/tools/with-browser-slot.sh node $tool "$@" --url http://127.0.0.1:$port > $out/tool.log 2>&1
rc=$?
kill $srv; wait $srv 2>/dev/null
cp $run/server.log $out/server.log; /bin/rm -rf $run
echo "$tool rc=$rc $out" | tee -a $out/tool.log
