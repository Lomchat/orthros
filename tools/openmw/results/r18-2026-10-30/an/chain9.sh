#!/bin/bash
S=/tmp/orthros-scratch/data-r18
until grep -q "CHAIN8 DONE" $S/logs/chain8.log; do sleep 10; done
$S/bin/mp.sh openmw-web-v1.5.3-orthros-r18dev-b $S/mp/r18b-1
$S/bin/mp.sh openmw-web-v1.5.3-orthros-r17 $S/mp/r17-1
$S/bin/mp.sh openmw-web-v1.5.3-orthros-r18dev-b $S/mp/r18b-2
$S/bin/pl.sh 17 r17-glide85k-1 $S/res/d-r17-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
$S/bin/pl.sh 18b r18b-glide85k-1 $S/res/d-r18b-glide85k.jsonl --mode glide --rate 85k --seconds 90 --query preloadwait=1000 --read-trace
$S/bin/pl.sh 17 r17-door-1 $S/res/d-r17-door.jsonl --mode door --read-trace
$S/bin/pl.sh 18b r18b-door-1 $S/res/d-r18b-door.jsonl --mode door --read-trace
echo CHAIN9 DONE
