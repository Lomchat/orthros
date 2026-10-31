#!/bin/bash
# After val4: r20dev-c (no GPU fence wait after the loading screen) warm saves against the live r19, and in-play controls
# (r20dev-b with ?jspi=0: the same binary, nothing suspends, every frame plain; r20dev-c) against it
J=/tmp/orthros-scratch/jspi4; R=$J/res/val; B=$J/bin
step() { echo "=== $(date +%T) $*"; }
pair() { if [ $(($1 % 2)) = 1 ]; then $2; $3; else $3; $2; fi; }
[ -d $J/w20c/profile-warm ] || { step warm-up 20c; $B/pl.sh 20c r20c-warm $R/pl-r20c-warm.jsonl --mode save --warm-only; }
for i in 5 6 7; do
  step save-c $i; pair $i "$B/pl.sh 19L r19L-save-$i $R/pl-r19Lc-save.jsonl --mode save --read-trace" "$B/pl.sh 20c r20c-save-$i $R/pl-r20c-save.jsonl --mode save --read-trace"
done
P="--query tier=mid --discard --seconds 60 --warm 0"
for i in 7 8; do
  step perf-c $i; $B/perf.sh 19L 18971 $R/perf/r19L-$i $P; $B/perf.sh 20b 18972 $R/perf/r20bj0-$i --query 'tier=mid&jspi=0' --discard --seconds 60 --warm 0; $B/perf.sh 20c 18973 $R/perf/r20c-$i $P
done
step VAL4C DONE
