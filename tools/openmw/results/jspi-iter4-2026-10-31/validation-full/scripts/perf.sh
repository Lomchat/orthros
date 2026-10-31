#!/bin/bash
# usage: perf.sh <side 19L|20b> <port> <out dir> [perf.mjs options...]: a server of the tree (fresh learn copy of v3/pristine,
# frozen br-cache) on that side's scratch games folder (place-load's), the tool through the browser slot with --url, the server stopped
S=/tmp/orthros-scratch/data-r19; V=$S/v3; J=/tmp/orthros-scratch/jspi5; W=/srv/orthros/.claude/worktrees/data-r15
side=$1; port=$2; out=$3; tool=perf; shift 3
case $side in 19L) eng=openmw-web-v1.5.3-orthros-r19 ;; 20*) eng=openmw-web-v1.5.3-orthros-r20dev-${side#20} ;; esac
games=$J/w$side/games-$eng
run=$J/srv-$port; /bin/rm -rf $run; mkdir -p $run $out
cp -a $J/pristine/learn $run/learn
/srv/orthros/tools/mem-check.sh -w 24 || exit 3
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) $tool $side $out $*" >> $J/logs/runs-started.txt
cd $W
node src/host/server.js --port $port --games-dir $games --engines-dir $S/eng --learn $run/learn --telemetry $run/tel --br-cache $J/pristine/brcache --br-cache-frozen --covers off --no-home-preload > $run/server.log 2>&1 &
srv=$!
for i in $(seq 60); do curl -sf http://127.0.0.1:$port/api/manifests >/dev/null && break; sleep 1; done
/srv/orthros/tools/with-browser-slot.sh node tools/openmw/perf.mjs morrowind-goty-en --url http://127.0.0.1:$port --out $out "$@" > $out/perf.log 2>&1
rc=$?
kill $srv; wait $srv 2>/dev/null
cp $run/server.log $out/server.log; /bin/rm -rf $run; tail -3 $out/perf.log
