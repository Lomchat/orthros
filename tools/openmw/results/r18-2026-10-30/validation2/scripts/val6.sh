#!/bin/bash
# A second glide pair (the first: the longest block r17 12.9 s, r18 24.2 s — opposite of the diagnosis' 42.3 / 32.5)
S=/tmp/orthros-scratch/data-r18; V=$S/val2
p17() { PLDIR=w17 $S/bin2/pl.sh 17 "$@"; }
p18() { PLDIR=w18 $S/bin2/pl.sh 18d "$@"; }
while kill -0 2729621 2>/dev/null; do sleep 10; done
echo "=== $(date +%T) glide 2"
p18 r18-glide85k-2 $V/pl-r18-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
p17 r17-glide85k-2 $V/pl-r17-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
echo "=== $(date +%T) VAL6 DONE"
