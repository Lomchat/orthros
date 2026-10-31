#!/bin/bash
# The pre-registered fair validation (plan.txt): r20dev-c against the live r19, one browser at a time, alternating, order swapped every pair
F=/tmp/orthros-scratch/jspifair2; R=$F/res; B=$F/bin
step() { echo "=== $(date +%T) $*"; }
pair() { if [ $(($1 % 2)) = 1 ]; then $2; $3; else $3; $2; fi; }
for i in 1 2 3 4 5 6; do
  step save $i; pair $i "$B/pl.sh 19L r19L-save-$i $R/pl-r19L-save.jsonl --mode save --input-trace --input-block 2000" "$B/pl.sh 20c r20c-save-$i $R/pl-r20c-save.jsonl --mode save --input-trace --input-block 2000"
done
P="--query tier=mid --discard --seconds 60 --warm 0"
for i in $(seq 1 16); do
  step perf $i; pair $i "$B/perf.sh 19L 18981 $R/perf/r19L-$i $P" "$B/perf.sh 20c 18982 $R/perf/r20c-$i $P"
done
for i in 1 2 3 4; do
  step new $i; pair $i "env ORTHROS_LOAD_MAX=16 $B/pl.sh 19L r19L-saveNew-$i $R/pl-r19L-saveNew.jsonl --mode save --profile new --read-trace" "env ORTHROS_LOAD_MAX=16 $B/pl.sh 20c r20c-saveNew-$i $R/pl-r20c-saveNew.jsonl --mode save --profile new --read-trace"
done
step VAL DONE
