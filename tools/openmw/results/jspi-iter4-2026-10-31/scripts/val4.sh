#!/bin/bash
# Iteration 4: r20dev-b (r1..r19 + orthros-r20.patch + r20x-b.patch) against the LIVE r19 (data/engines, read-only, its
# draw thread off as shipped), interleaved (order alternated every pair), one browser at a time; each side its own warm
# profile made by its own warm-up; servers on copies of v3/pristine (live learned state + frozen br-cache, lean 2c6b8e83)
J=/tmp/orthros-scratch/jspi4; R=$J/res/val; B=$J/bin
mkdir -p $R/perf $R/mp
step() { echo "=== $(date +%T) $*"; }
pair() { if [ $(($1 % 2)) = 1 ]; then $2; $3; else $3; $2; fi; }
[ -d $J/w20b/profile-warm ] || { step warm-up 20b; $B/pl.sh 20b r20b-warm $R/pl-r20b-warm.jsonl --mode save --warm-only; }
for i in 1 2 3 4; do
  step save $i; pair $i "$B/pl.sh 19L r19L-save-$i $R/pl-r19L-save.jsonl --mode save --read-trace" "$B/pl.sh 20b r20b-save-$i $R/pl-r20b-save.jsonl --mode save --read-trace"
  step coe $i;  pair $((i+1)) "$B/pl.sh 19L r19L-coe-$i $R/pl-r19L-coe.jsonl --mode coe" "$B/pl.sh 20b r20b-coe-$i $R/pl-r20b-coe.jsonl --mode coe"
done
P="--query tier=mid --discard --seconds 60 --warm 0"
for i in 1 2 3 4 5 6; do
  step perf $i; pair $i "$B/perf.sh 19L 18971 $R/perf/r19L-$i $P" "$B/perf.sh 20b 18972 $R/perf/r20b-$i $P"
done
for i in 1 2 3; do
  step new $i; pair $i "$B/pl.sh 19L r19L-saveNew-$i $R/pl-r19L-saveNew.jsonl --mode save --profile new --read-trace" "$B/pl.sh 20b r20b-saveNew-$i $R/pl-r20b-saveNew.jsonl --mode save --profile new --read-trace"
done
for i in 1 2; do
  step 85k $i; pair $i "$B/pl.sh 19L r19L-save85k-$i $R/pl-r19L-save85k.jsonl --mode save --rate 85k --read-trace" "$B/pl.sh 20b r20b-save85k-$i $R/pl-r20b-save85k.jsonl --mode save --rate 85k --read-trace"
done
step VAL4 DONE
