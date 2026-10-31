#!/bin/bash
# Full validation of r18dev-d (engine 67ba0ec0e388, this tree's page at 388dfce) against the live r17, interleaved, one browser at a time
S=/tmp/orthros-scratch/data-r18; V=$S/val2; E18=openmw-web-v1.5.3-orthros-r18dev-d; E17=openmw-web-v1.5.3-orthros-r17
mkdir -p $V/perf $V/mp
p17() { PLDIR=w17 $S/bin2/pl.sh 17 "$@"; }
p18() { PLDIR=w18 $S/bin2/pl.sh 18d "$@"; }
step() { echo "=== $(date +%T) $*"; }
for i in 1 2 3; do
  step save $i; p17 r17-save-$i $V/pl-r17-save.jsonl --mode save; p18 r18-save-$i $V/pl-r18-save.jsonl --mode save
  step coe $i; p17 r17-coe-$i $V/pl-r17-coe.jsonl --mode coe; p18 r18-coe-$i $V/pl-r18-coe.jsonl --mode coe
done
ln -sfn $S/w17/games-$E17 $S/sgames-$E17; ln -sfn $S/w18/games-$E18 $S/sgames-$E18
for i in 1 2 3 4; do
  step perf $i
  $S/bin2/perf.sh $E17 18961 $V/perf/r17-$i --query tier=mid --discard --seconds 60 --warm 0
  $S/bin2/perf.sh $E18 18962 $V/perf/r18-$i --query tier=mid --discard --seconds 60 --warm 0
done
for i in 1 2; do
  step new $i; p17 r17-saveNew-$i $V/pl-r17-saveNew.jsonl --mode save --profile new; p18 r18-saveNew-$i $V/pl-r18-saveNew.jsonl --mode save --profile new
  step 85k $i; p17 r17-save85k-$i $V/pl-r17-save85k.jsonl --mode save --rate 85k --read-trace; p18 r18-save85k-$i $V/pl-r18-save85k.jsonl --mode save --rate 85k --read-trace
done
step frame-compare; $S/bin2/srvrun.sh $E18 18965 $V/fc tools/openmw/frame-compare.mjs --variant '' --variant jspi=0 --out $V/fc/out
step check; $S/bin2/srvrun.sh $E18 18966 $V/check-en tools/openmw/check.mjs --seconds 10; $S/bin2/srvrun.sh $E18 18967 $V/check-fr tools/openmw/check.mjs --lang fr --seconds 10
step mp
for i in 1 2 3; do $S/bin2/mp.sh $E18 $V/mp/r18-$i; $S/bin2/mp.sh $E17 $V/mp/r17-$i; done
step forced
ORTHROS_CHROME_ARGS='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native' p18 r18-forced-save $V/pl-r18-forced.jsonl --mode save
ORTHROS_CHROME_ARGS='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native' p18 r18-forced-coe $V/pl-r18-forced.jsonl --mode coe
step blocking-paths
p17 r17-glide85k-1 $V/pl-r17-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
p18 r18-glide85k-1 $V/pl-r18-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
p17 r17-door-1 $V/pl-r17-door.jsonl --mode door --read-trace
p18 r18-door-1 $V/pl-r18-door.jsonl --mode door --read-trace
step VAL DONE
