#!/bin/bash
# r18 (installed, r18-small's code) against the live r17 (main's code), interleaved, one browser at a time
S=/tmp/orthros-scratch/r18-ship; V=$S/val; B=$S/bin
mkdir -p $V/mp $V/perf $V/check
step() { echo "=== $(date +%T) $*"; }
step check
$B/srv.sh 18 18761 $V/check/r18-en tools/openmw/check.mjs morrowind-goty-vanilla-plus-en --seconds 10
$B/srv.sh 18 18762 $V/check/r18-fr tools/openmw/check.mjs morrowind-goty-vanilla-plus-en --lang fr --seconds 10
step mp
for i in 1 2 3; do $B/mp.sh 18 $V/mp/r18-$i; $B/mp.sh 17 $V/mp/r17-$i; done
$B/mp.sh 18 $V/mp/r18-4
step perf
for i in 1 2 3; do
  $B/srv.sh 17 18763 $V/perf/r17-$i tools/openmw/perf.mjs morrowind-goty-en --out $V/perf/r17-$i --query tier=mid --discard --seconds 60 --warm 0
  $B/srv.sh 18 18764 $V/perf/r18-$i tools/openmw/perf.mjs morrowind-goty-en --out $V/perf/r18-$i --query tier=mid --discard --seconds 60 --warm 0
done
step save warm
for i in 1 2; do $B/pl.sh 17 r17-save-$i $V/pl-r17-save.jsonl --mode save; $B/pl.sh 18 r18-save-$i $V/pl-r18-save.jsonl --mode save; done
step save 85k
for i in 1 2; do $B/pl.sh 17 r17-save85k-$i $V/pl-r17-save85k.jsonl --mode save --rate 85k; $B/pl.sh 18 r18-save85k-$i $V/pl-r18-save85k.jsonl --mode save --rate 85k; done
step VAL DONE
