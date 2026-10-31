#!/bin/bash
# The shared page code (r18-small's http-backend) on the other runtimes, after the OpenMW validation; one browser at a time
S=/tmp/orthros-scratch/r18-ship; T=/srv/orthros/.claude/worktrees/r18-small; O=$S/oth; mkdir -p $O
step() { echo "=== $(date +%T) $*"; }
while pgrep -f '^/bin/bash /tmp/orthros-scratch/r18-ship/bin/val.sh' >/dev/null; do sleep 20; done
# origin <tree> <port> <dir>: a server of <tree> on the live games, fresh learn copy, frozen br-cache, scratch accounts
origin() { mkdir -p $3; cp -a $S/pristine/learn $3/learn; (cd $1 && exec node src/host/server.js --port $2 --games-dir /srv/orthros/data/games --engines-dir /srv/orthros/data/engines --accounts $3/accounts --learn $3/learn --telemetry $3/tel --br-cache $S/pristine/brcache --br-cache-frozen --covers off --no-home-preload > $3/server.log 2>&1) & echo $! > $3/server.pid
  for i in $(seq 60); do curl -sf http://127.0.0.1:$2/api/manifests >/dev/null && break; sleep 1; done; }
stop() { kill $(cat $1/server.pid) 2>/dev/null; sleep 1; /bin/rm -rf $1/learn; }
gate() { /srv/orthros/tools/mem-check.sh -w 24; echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) $*" >> $S/logs/runs-started.txt; }
step goldsrc; gate goldsrc
origin $T 18771 $O/goldsrc; cd $T; /srv/orthros/tools/with-browser-slot.sh node tools/goldsrc/check.mjs half-life-original-en solo --url http://127.0.0.1:18771 > $O/goldsrc/check.log 2>&1; echo "goldsrc rc=$?" | tee -a $O/goldsrc/check.log; stop $O/goldsrc
step re3; gate re3
origin $T 18772 $O/re3; cd $T; /srv/orthros/tools/with-browser-slot.sh node tools/re3/check.mjs vice-city-revc --url http://127.0.0.1:18772 --new-game > $O/re3/check.log 2>&1; echo "re3 rc=$?" | tee -a $O/re3/check.log; stop $O/re3
step win32 boot; gate win32 boot
mkdir -p $O/win32; cd $T; /srv/orthros/tools/with-browser-slot.sh node tools/headless.mjs bfme1-108 --games-dir /srv/orthros/data/games --seconds 60 --shots 20 --out $O/win32/shots > $O/win32/headless.log 2>&1; echo "win32 rc=$?" | tee -a $O/win32/headless.log
step thin
for side in main r18; do
  case $side in main) tree=/srv/orthros; p=18773 ;; r18) tree=$T; p=18774 ;; esac
  d=$O/thin-$side; gate thin $side; origin $tree $p $d
  (cd $T && exec node tools/net-proxy.mjs --upstream http://127.0.0.1:$p --listen 18775 --rate 85k --rtt 50 --log $d/proxy.jsonl --certs $d/certs > $d/proxy.out 2>&1) & pp=$!
  sleep 3
  cd $tree; /srv/orthros/tools/with-browser-slot.sh node tools/headless.mjs bfme1-108 --server-port $p --page-origin https://127.0.0.1:18775 --audio --seconds 300 --shots 60 --out $d/shots > $d/headless.log 2>&1; echo "thin $side rc=$?" | tee -a $d/headless.log
  kill $pp; stop $d
done
step OTH DONE
