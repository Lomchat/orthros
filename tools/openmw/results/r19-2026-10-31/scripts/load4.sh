#!/bin/bash
# r18, r19 (r18dev-d) and r19dev-a on ONE warm profile made by a fourth engine (r17's warm-up): no side's engine in its
# HTTP cache (each compiles its module fresh), the store the same; saves 3 rounds and a COE round, rotating order
S=/tmp/orthros-scratch/data-r19; V=$S/res/load4; mkdir -p $V
export WARM=$S/warm17/profile-warm
step() { echo "=== $(date +%T) $*"; }
run() { local side=$1 tag=$2 mode=$3; $S/bin/pl.sh $side $tag-$mode-$i $V/pl-$tag-$mode.jsonl --mode $mode --read-trace; }
step warm-up; i=0; $S/bin/pl.sh 17 r17-warm $V/pl-r17-warm.jsonl --mode save --warm-only
for i in 1 2 3; do
  step round $i
  case $i in
    1) run 18 r18 save; run 19d r19d save; run 19a r19a save ;;
    2) run 19a r19a save; run 18 r18 save; run 19d r19d save ;;
    3) run 19d r19d save; run 19a r19a save; run 18 r18 save ;;
  esac
done
i=1; step coe; run 19a r19a coe; run 18 r18 coe; run 19d r19d coe
step LOAD4 DONE
