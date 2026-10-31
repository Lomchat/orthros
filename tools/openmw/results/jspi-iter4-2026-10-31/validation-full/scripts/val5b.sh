#!/bin/bash
# Supplementary to val5 (decided after its 8 in-play pairs gave r20c a work p99 median 0.85 ms over the live one and one
# new-device menu 0.1 s over the live spread + 0.3 s): 4 more in-play pairs and 2 more new-device pairs, the same way.
# Reported beside the primary sample, never in place of it.
J=/tmp/orthros-scratch/jspi5; R=$J/res; B=$J/bin
step() { echo "=== $(date +%T) $*"; }
pair() { if [ $(($1 % 2)) = 1 ]; then $2; $3; else $3; $2; fi; }
P="--query tier=mid --discard --seconds 60 --warm 0"
for i in 9 10 11 12; do
  step perf $i; pair $i "$B/perf.sh 19L 18971 $R/perf/r19L-$i $P" "$B/perf.sh 20c 18972 $R/perf/r20c-$i $P"
done
for i in 5 6; do
  step new $i; pair $i "$B/pl.sh 19L r19L-saveNew-$i $R/pl-r19L-saveNewB.jsonl --mode save --profile new --read-trace" "$B/pl.sh 20c r20c-saveNew-$i $R/pl-r20c-saveNewB.jsonl --mode save --profile new --read-trace"
done
step VAL5B DONE
