#!/bin/bash
# Diagnosis 1: r19 (r18dev-d) against the live r18, ONE warm profile (made by r19's warm-up) for both sides; read traces; CPU profiles; new device; in play profiles
S=/tmp/orthros-scratch/data-r19; V=$S/res/diag1; mkdir -p $V
export WARM=$S/warm/profile-warm
step() { echo "=== $(date +%T) $*"; }
p18() { $S/bin/pl.sh 18 "$@"; }
p19() { $S/bin/pl.sh 19d "$@"; }
for i in 1 2; do
  step save $i; p19 r19-save-$i $V/pl-r19-save.jsonl --mode save --read-trace; p18 r18-save-$i $V/pl-r18-save.jsonl --mode save --read-trace
done
step prof; ORTHROS_PLACE_PROFILE=1 p19 r19-saveprof-1 $V/pl-r19-saveprof.jsonl --mode save; ORTHROS_PLACE_PROFILE=1 p18 r18-saveprof-1 $V/pl-r18-saveprof.jsonl --mode save
step new; p19 r19-saveNew-1 $V/pl-r19-saveNew.jsonl --mode save --profile new --read-trace; p18 r18-saveNew-1 $V/pl-r18-saveNew.jsonl --mode save --profile new --read-trace
ln -sfn $S/pl18/games-openmw-web-v1.5.3-orthros-r18 $S/sgames-openmw-web-v1.5.3-orthros-r18; ln -sfn $S/pl19/games-openmw-web-v1.5.3-orthros-r18dev-d $S/sgames-openmw-web-v1.5.3-orthros-r18dev-d
step perfprof
$S/bin/perf.sh openmw-web-v1.5.3-orthros-r18 18961 $V/perf/r18-prof --query tier=mid --discard --seconds 60 --warm 0 --profile
$S/bin/perf.sh openmw-web-v1.5.3-orthros-r18dev-d 18962 $V/perf/r19-prof --query tier=mid --discard --seconds 60 --warm 0 --profile
step DIAG1 DONE
