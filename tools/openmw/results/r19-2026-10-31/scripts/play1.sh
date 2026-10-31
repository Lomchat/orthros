#!/bin/bash
# r19dev-a smoke check, then in play: r18 / r19dev-a alternating (6 a side), r19dev-d 3 interleaved; then worker profiles one a side
S=/tmp/orthros-scratch/data-r19; V=$S/res/play1; mkdir -p $V
E18=openmw-web-v1.5.3-orthros-r18; EA=openmw-web-v1.5.3-orthros-r19dev-a; ED=openmw-web-v1.5.3-orthros-r18dev-d
step() { echo "=== $(date +%T) $*"; }
step smoke; $S/bin/srvrun.sh $EA 18966 $V/check-en tools/openmw/check.mjs --seconds 10; grep -q "rc=0" $V/check-en/tool.log || { step SMOKE FAILED; exit 1; }
P="--query tier=mid --discard --seconds 60 --warm 0"
for i in 1 2 3 4 5 6; do
  step perf $i
  if [ $((i % 2)) = 1 ]; then $S/bin/perf.sh $E18 18961 $V/perf/r18-$i $P; $S/bin/perf.sh $EA 18962 $V/perf/r19a-$i $P
  else $S/bin/perf.sh $EA 18962 $V/perf/r19a-$i $P; $S/bin/perf.sh $E18 18961 $V/perf/r18-$i $P; fi
  [ $i -le 3 ] && $S/bin/perf.sh $ED 18963 $V/perf/r19d-$i $P
done
step workers
$S/bin/perf.sh $E18 18961 $V/perf/r18-w $P --profile --workers
$S/bin/perf.sh $ED 18963 $V/perf/r19d-w $P --profile --workers
$S/bin/perf.sh $EA 18962 $V/perf/r19a-w $P --profile --workers
step PLAY1 DONE
