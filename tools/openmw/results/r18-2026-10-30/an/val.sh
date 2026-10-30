#!/bin/bash
# The validation of r18 (r18dev-b + this tree's page) against the live r17, interleaved, one browser at a time
S=/tmp/orthros-scratch/data-r18; V=$S/val; E18=openmw-web-v1.5.3-orthros-r18dev-d; E17=openmw-web-v1.5.3-orthros-r17
p17() { PLDIR=v17 $S/bin/pl.sh 17 "$@"; }
p18() { PLDIR=v18d $S/bin/pl.sh 18d "$@"; }
step() { echo "=== $(date +%T) $*"; }
for i in 1 2 3; do
  step save $i; p17 r17-save-$i $V/pl-r17-save.jsonl --mode save; p18 r18-save-$i $V/pl-r18-save.jsonl --mode save
  step coe $i; p17 r17-coe-$i $V/pl-r17-coe.jsonl --mode coe; p18 r18-coe-$i $V/pl-r18-coe.jsonl --mode coe
done
for i in 1 2 3 4; do
  step perf $i
  $S/bin/perf.sh $E17 18961 $V/perf/r17-$i --query tier=mid --discard --seconds 60 --warm 0
  $S/bin/perf.sh $E18 18962 $V/perf/r18-$i --query tier=mid --discard --seconds 60 --warm 0
done
for i in 1 2; do
  step new $i; p17 r17-saveNew-$i $V/pl-r17-saveNew.jsonl --mode save --profile new; p18 r18-saveNew-$i $V/pl-r18-saveNew.jsonl --mode save --profile new
  step 85k $i; p17 r17-save85k-$i $V/pl-r17-save85k.jsonl --mode save --rate 85k --read-trace; p18 r18-save85k-$i $V/pl-r18-save85k.jsonl --mode save --rate 85k --read-trace
done
step frame-compare; $S/bin/srvrun.sh $E18 18965 $V/fc tools/openmw/frame-compare.mjs --variant '' --variant jspi=0 --out $V/fc/out
step check; $S/bin/srvrun.sh $E18 18966 $V/check-en tools/openmw/check.mjs --seconds 10; $S/bin/srvrun.sh $E18 18967 $V/check-fr tools/openmw/check.mjs --lang fr --seconds 10
step mp; $S/bin/mp.sh $E18 $V/mp/r18-1; $S/bin/mp.sh $E17 $V/mp/r17-1; $S/bin/mp.sh $E18 $V/mp/r18-2; $S/bin/mp.sh $E17 $V/mp/r17-2
step forced
ORTHROS_CHROME_ARGS='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native' p18 r18-forced-save $V/pl-r18-forced.jsonl --mode save
ORTHROS_CHROME_ARGS='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native' p18 r18-forced-coe $V/pl-r18-forced.jsonl --mode coe
step VAL DONE
