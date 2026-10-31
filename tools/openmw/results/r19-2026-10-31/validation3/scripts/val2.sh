#!/bin/bash
# Two more new-device pairs (in the first two, r19a's menu 26.5-27.1 s against 25.1-25.8 and its F9 12.3 against 10.9-11.2): 4 a side
S=/tmp/orthros-scratch/data-r19; V=$S/v3; R=$V/res; B=$V/bin
while pgrep -f "^/bin/bash $V/bin/val.sh" >/dev/null; do sleep 10; done
for i in 3 4; do
  echo "=== $(date +%T) new $i"
  if [ $((i % 2)) = 1 ]; then
    $B/pl.sh 18 r18-saveNew-$i $R/pl-r18-saveNew.jsonl --mode save --profile new --read-trace; $B/pl.sh 19a r19a-saveNew-$i $R/pl-r19a-saveNew.jsonl --mode save --profile new --read-trace
  else
    $B/pl.sh 19a r19a-saveNew-$i $R/pl-r19a-saveNew.jsonl --mode save --profile new --read-trace; $B/pl.sh 18 r18-saveNew-$i $R/pl-r18-saveNew.jsonl --mode save --profile new --read-trace
  fi
done
echo "=== $(date +%T) VAL2 DONE"
