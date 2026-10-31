#!/bin/bash
# loads, r18 against r19dev-a, ONE warm profile (diag1's, made by r19's warm-up) for both; interleaved, alternate order
S=/tmp/orthros-scratch/data-r19; V=$S/res/load2; mkdir -p $V
export WARM=$S/warm/profile-warm
step() { echo "=== $(date +%T) $*"; }
p18() { $S/bin/pl.sh 18 "$@"; }
pa() { $S/bin/pl.sh 19a "$@"; }
while kill -0 3529217 2>/dev/null; do sleep 10; done
for i in 1 2 3; do
  step save $i
  if [ $((i % 2)) = 1 ]; then p18 r18-save-$i $V/pl-r18-save.jsonl --mode save --read-trace; pa r19a-save-$i $V/pl-r19a-save.jsonl --mode save --read-trace
  else pa r19a-save-$i $V/pl-r19a-save.jsonl --mode save --read-trace; p18 r18-save-$i $V/pl-r18-save.jsonl --mode save --read-trace; fi
  step coe $i
  if [ $((i % 2)) = 0 ]; then p18 r18-coe-$i $V/pl-r18-coe.jsonl --mode coe; pa r19a-coe-$i $V/pl-r19a-coe.jsonl --mode coe
  else pa r19a-coe-$i $V/pl-r19a-coe.jsonl --mode coe; p18 r18-coe-$i $V/pl-r18-coe.jsonl --mode coe; fi
done
for i in 1 2; do
  step new $i
  if [ $i = 1 ]; then p18 r18-saveNew-$i $V/pl-r18-saveNew.jsonl --mode save --profile new --read-trace; pa r19a-saveNew-$i $V/pl-r19a-saveNew.jsonl --mode save --profile new --read-trace
  else pa r19a-saveNew-$i $V/pl-r19a-saveNew.jsonl --mode save --profile new --read-trace; p18 r18-saveNew-$i $V/pl-r18-saveNew.jsonl --mode save --profile new --read-trace; fi
  step 85k $i
  if [ $i = 2 ]; then p18 r18-save85k-$i $V/pl-r18-save85k.jsonl --mode save --rate 85k --read-trace; pa r19a-save85k-$i $V/pl-r19a-save85k.jsonl --mode save --rate 85k --read-trace
  else pa r19a-save85k-$i $V/pl-r19a-save85k.jsonl --mode save --rate 85k --read-trace; p18 r18-save85k-$i $V/pl-r18-save85k.jsonl --mode save --rate 85k --read-trace; fi
done
step forced
ORTHROS_CHROME_ARGS='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native' pa r19a-forced-save $V/pl-r19a-forced.jsonl --mode save
ORTHROS_CHROME_ARGS='--memlog=all-renderers --memlog-sampling-rate=100000 --memlog-stack-mode=native' pa r19a-forced-coe $V/pl-r19a-forced.jsonl --mode coe
step glide
pa r19a-glide85k-1 $V/pl-r19a-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
p18 r18-glide85k-1 $V/pl-r18-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
step LOAD2 DONE
