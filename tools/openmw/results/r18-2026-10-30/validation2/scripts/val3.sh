#!/bin/bash
# The rest of the validation after the first round's r18 warm profile was found without the engine's lean package
# (made by the server during that warm-up: every warm r18 run fetched it, 4.13 MB): r18's warm profile rebuilt, the warm runs again
S=/tmp/orthros-scratch/data-r18; V=$S/val2; E18=openmw-web-v1.5.3-orthros-r18dev-d; E17=openmw-web-v1.5.3-orthros-r17
p17() { PLDIR=w17 $S/bin2/pl.sh 17 "$@"; }
p18() { PLDIR=w18 $S/bin2/pl.sh 18d "$@"; }
step() { echo "=== $(date +%T) $*"; }
while kill -0 2596764 2>/dev/null; do sleep 10; done
step check; $S/bin2/srvrun.sh $E18 18966 $V/check-en tools/openmw/check.mjs --seconds 10; $S/bin2/srvrun.sh $E18 18967 $V/check-fr tools/openmw/check.mjs --lang fr --seconds 10
step mp
for i in 1 2 3; do $S/bin2/mp.sh $E18 $V/mp/r18-$i; $S/bin2/mp.sh $E17 $V/mp/r17-$i; done
step round2: r18 warm profile rebuilt
mkdir -p $V/round1 $S/w18/round1
for k in save coe save85k; do for s in r17 r18; do /bin/mv -f $V/pl-$s-$k.jsonl $V/round1/; done; done
/bin/mv -f $S/w18/profile-warm $S/w18/warm $S/w18/warm.json $S/w18/round1/
for i in 1 2 3; do
  step save $i; p17 r17-save-$i $V/pl-r17-save.jsonl --mode save; p18 r18-save-$i $V/pl-r18-save.jsonl --mode save
  step coe $i; p17 r17-coe-$i $V/pl-r17-coe.jsonl --mode coe; p18 r18-coe-$i $V/pl-r18-coe.jsonl --mode coe
done
for i in 1 2; do
  step 85k $i; p17 r17-save85k-$i $V/pl-r17-save85k.jsonl --mode save --rate 85k --read-trace; p18 r18-save85k-$i $V/pl-r18-save85k.jsonl --mode save --rate 85k --read-trace
done
step forced
ORTHROS_CHROME_ARGS='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native' p18 r18-forced-save $V/pl-r18-forced.jsonl --mode save
ORTHROS_CHROME_ARGS='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native' p18 r18-forced-coe $V/pl-r18-forced.jsonl --mode coe
step blocking-paths
p17 r17-glide85k-1 $V/pl-r17-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
p18 r18-glide85k-1 $V/pl-r18-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
p17 r17-door-1 $V/pl-r17-door.jsonl --mode door --read-trace
p18 r18-door-1 $V/pl-r18-door.jsonl --mode door --read-trace
step VAL DONE
