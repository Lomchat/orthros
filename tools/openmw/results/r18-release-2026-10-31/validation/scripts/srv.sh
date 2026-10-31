#!/bin/bash
# usage: srv.sh <17|18> <port> <out dir> <tool script (r18-small's tools)> [args...]: a server of the side's tree
# (17: /srv/orthros main + live games = r17; 18: r18-small + games18 = r18) on a fresh learn copy and the frozen
# br-cache, the tool through the browser slot with --url, the server stopped
S=/tmp/orthros-scratch/r18-ship; T=/srv/orthros/.claude/worktrees/r18-small
side=$1; port=$2; out=$3; tool=$4; shift 4
case $side in 17) tree=/srv/orthros; games=/srv/orthros/data/games ;; 18) tree=$T; games=$S/games18 ;; 17x) tree=$T; games=/srv/orthros/data/games ;; 18x) tree=/srv/orthros; games=$S/games18 ;; esac
run=$S/srv-$port; /bin/rm -rf $run; mkdir -p $run $out
cp -a $S/pristine/learn $run/learn
/srv/orthros/tools/mem-check.sh -w 24
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) side=$side $tool $out $*" >> $S/logs/runs-started.txt
cd $tree
node src/host/server.js --port $port --games-dir $games --engines-dir /srv/orthros/data/engines --learn $run/learn --telemetry $run/tel --br-cache $S/pristine/brcache --br-cache-frozen --covers off --no-home-preload > $run/server.log 2>&1 &
srv=$!
for i in $(seq 60); do curl -sf http://127.0.0.1:$port/api/manifests >/dev/null && break; sleep 1; done
cd $T
/srv/orthros/tools/with-browser-slot.sh node $tool "$@" --url http://127.0.0.1:$port > $out/tool.log 2>&1
rc=$?
kill $srv; wait $srv 2>/dev/null
cp $run/server.log $out/server.log; /bin/rm -rf $run
echo "$tool rc=$rc $out" | tee -a $out/tool.log
