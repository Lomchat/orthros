#!/bin/bash
# the load frame's GPU wait cap through the engine's page (--entry engine), r19dev-a, against r18, on load4's neutral warm profile
S=/tmp/orthros-scratch/data-r19; V=$S/res/gl5; mkdir -p $V
export WARM=$S/warm17/profile-warm
step() { echo "=== $(date +%T) $*"; }
while pgrep -f "bin/load4.sh" >/dev/null; do sleep 10; done
for i in 1 2; do
  step round $i
  $S/bin/pl.sh 18 r18-eng-$i $V/pl-r18-eng.jsonl --mode save --entry engine --read-trace
  $S/bin/pl.sh 19a r19a-eng-$i $V/pl-r19a-eng.jsonl --mode save --entry engine --read-trace
  $S/bin/pl.sh 19a r19a-gl150-$i $V/pl-r19a-gl150.jsonl --mode save --entry engine --read-trace --query jspiglmax=150
  $S/bin/pl.sh 19a r19a-gl0-$i $V/pl-r19a-gl0.jsonl --mode save --entry engine --read-trace --query jspigl=0
done
step GL5 DONE
