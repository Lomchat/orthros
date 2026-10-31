#!/bin/bash
# Full validation of r19dev-a (engine 515236e0e051, this tree's page at 18b5143) against the LIVE r18 (data/engines, read-only),
# interleaved (order alternated), one browser at a time; each server its own copy of v3/pristine (the live learned state and
# br-cache copied at 08:19, the br-cache frozen: the one lean package 2c6b8e83 both engines' openmw.data share)
S=/tmp/orthros-scratch/data-r19; V=$S/v3; R=$V/res; B=$V/bin
E18=openmw-web-v1.5.3-orthros-r18; EA=openmw-web-v1.5.3-orthros-r19dev-a
mkdir -p $R/perf $R/mp
step() { echo "=== $(date +%T) $*"; }
pair() { # pair <i> <fn18> <fn19>: odd i r18 first
  if [ $(($1 % 2)) = 1 ]; then $2; $3; else $3; $2; fi; }
FORCED='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native'
step warm-ups; $B/pl.sh 18 r18-warm $R/pl-r18-warm.jsonl --mode save --warm-only; $B/pl.sh 19a r19a-warm $R/pl-r19a-warm.jsonl --mode save --warm-only
for i in 1 2 3 4; do
  step save $i; pair $i "$B/pl.sh 18 r18-save-$i $R/pl-r18-save.jsonl --mode save" "$B/pl.sh 19a r19a-save-$i $R/pl-r19a-save.jsonl --mode save"
  step coe $i;  pair $((i+1)) "$B/pl.sh 18 r18-coe-$i $R/pl-r18-coe.jsonl --mode coe" "$B/pl.sh 19a r19a-coe-$i $R/pl-r19a-coe.jsonl --mode coe"
done
P="--query tier=mid --discard --seconds 60 --warm 0"
for i in 1 2 3 4 5 6 7 8; do
  step perf $i; pair $i "$B/perf.sh $E18 18961 $R/perf/r18-$i $P" "$B/perf.sh $EA 18962 $R/perf/r19a-$i $P"
done
for i in 1 2; do
  step new $i; pair $i "$B/pl.sh 18 r18-saveNew-$i $R/pl-r18-saveNew.jsonl --mode save --profile new --read-trace" "$B/pl.sh 19a r19a-saveNew-$i $R/pl-r19a-saveNew.jsonl --mode save --profile new --read-trace"
  step 85k $i; pair $((i+1)) "$B/pl.sh 18 r18-save85k-$i $R/pl-r18-save85k.jsonl --mode save --rate 85k --read-trace" "$B/pl.sh 19a r19a-save85k-$i $R/pl-r19a-save85k.jsonl --mode save --rate 85k --read-trace"
done
step frame-compare; $B/srvrun.sh $EA 18965 $R/fc tools/openmw/frame-compare.mjs --variant '' --variant jspi=0 --out $R/fc/out
step check; $B/srvrun.sh $EA 18966 $R/check-en tools/openmw/check.mjs --seconds 10; $B/srvrun.sh $EA 18967 $R/check-fr tools/openmw/check.mjs --lang fr --seconds 10
step mp
$B/mp.sh $EA $R/mp/r19a-1; $B/mp.sh $E18 $R/mp/r18-1; $B/mp.sh $EA $R/mp/r19a-2; $B/mp.sh $EA $R/mp/r19a-3; $B/mp.sh $E18 $R/mp/r18-2; $B/mp.sh $EA $R/mp/r19a-4
step forced
ORTHROS_CHROME_ARGS="$FORCED" $B/pl.sh 19a r19a-forced-save $R/pl-r19a-forced.jsonl --mode save
ORTHROS_CHROME_ARGS="$FORCED" $B/pl.sh 19a r19a-forced-coe $R/pl-r19a-forced.jsonl --mode coe
step glide
$B/pl.sh 19a r19a-glide85k-1 $R/pl-r19a-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
$B/pl.sh 18 r18-glide85k-1 $R/pl-r18-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
step VAL DONE
