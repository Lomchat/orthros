#!/bin/bash
S=/tmp/orthros-scratch/data-r18
until grep -q "BUILD-END" $S/logs/build-d.log; do sleep 10; done
grep -q "BUILD-END 0" $S/logs/build-d.log || { echo "build failed"; exit 1; }
exec $S/bin/val.sh
