#!/bin/bash
# r19dev-a against r19 (r18dev-d) and r18 on the same warm profile: save and COE, 2 rounds, rotating order
S=/tmp/orthros-scratch/data-r19; V=$S/res/load3; mkdir -p $V
export WARM=$S/warm/profile-warm
step() { echo "=== $(date +%T) $*"; }
run() { local side=$1 tag=$2 mode=$3; $S/bin/pl.sh $side $tag-$mode-$i $V/pl-$tag-$mode.jsonl --mode $mode --read-trace; }
while pgrep -f "bin/load2.sh" >/dev/null; do sleep 10; done
for i in 1 2; do
  step round $i
  if [ $i = 1 ]; then run 19d r19d save; run 19a r19a save; run 18 r18 save; run 19a r19a coe; run 19d r19d coe; run 18 r18 coe
  else run 18 r18 save; run 19d r19d save; run 19a r19a save; run 18 r18 coe; run 19a r19a coe; run 19d r19d coe; fi
done
step LOAD3 DONE
