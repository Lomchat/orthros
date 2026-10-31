#!/bin/bash
# two more in-play pairs (r18-2's work p99 23.8 ms above r17's 19.4-20.9), after chain.sh
S=/tmp/orthros-scratch/r18-ship; V=$S/val; B=$S/bin
while pgrep -f '^/bin/bash /tmp/orthros-scratch/r18-ship/bin/(chain|oth)\.sh' >/dev/null; do sleep 20; done
for i in 4 5; do
  echo "=== $(date +%T) perf $i"
  $B/srv.sh 18 18764 $V/perf/r18-$i tools/openmw/perf.mjs morrowind-goty-en --out $V/perf/r18-$i --query tier=mid --discard --seconds 60 --warm 0
  $B/srv.sh 17 18763 $V/perf/r17-$i tools/openmw/perf.mjs morrowind-goty-en --out $V/perf/r17-$i --query tier=mid --discard --seconds 60 --warm 0
done
echo "=== $(date +%T) CHAIN2 DONE"
