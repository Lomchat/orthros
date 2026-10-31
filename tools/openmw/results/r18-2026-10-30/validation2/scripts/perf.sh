#!/bin/bash
# usage: perf.sh <engine> <port> <out dir> [perf.mjs options...]: a server of the tree on a fresh learn copy and the frozen br-cache, perf.mjs, the server stopped
S=/tmp/orthros-scratch/data-r18; W=/srv/orthros/.claude/worktrees/data-r15
eng=$1; port=$2; out=$3; shift 3
run=$S/srv-$port; /bin/rm -rf $run; mkdir -p $run $out
cp -a $S/pristine/learn $run/learn
/srv/orthros/tools/mem-check.sh -w 24
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) perf $eng $out $*" >> $S/logs2/runs-started.txt
cd $W
node src/host/server.js --port $port --games-dir $S/sgames-$eng --engines-dir $S/eng --learn $run/learn --telemetry $run/tel --br-cache $S/pristine/brcache --br-cache-frozen --covers off --no-home-preload > $run/server.log 2>&1 &
srv=$!
for i in $(seq 60); do curl -sf http://127.0.0.1:$port/api/manifests >/dev/null && break; sleep 1; done
/srv/orthros/tools/with-browser-slot.sh node tools/openmw/perf.mjs morrowind-goty-en --url http://127.0.0.1:$port --out $out "$@" > $out/perf.log 2>&1
rc=$?
kill $srv; wait $srv 2>/dev/null
cp $run/server.log $out/server.log; /bin/rm -rf $run
echo "perf rc=$rc $out"
