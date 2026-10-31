#!/bin/bash
# usage: pl.sh <side: 18 | 19a | 19L (the live r19) | 20b (r20dev-b)...> <tag> <out jsonl> [place-load options...]: each side its own scratch and warm profile (v3/w18, v3/w19a, jspi4/w19<x>), made by its own warm-up
S=/tmp/orthros-scratch/data-r19; V=$S/v3; J=/tmp/orthros-scratch/jspi4; W=/srv/orthros/.claude/worktrees/data-r15
side=$1; tag=$2; out=$3; shift 3
case $side in
  18) eng=(--engine openmw-web-v1.5.3-orthros-r18); dir=$V/w18 ;;
  19a) eng=(--engine openmw-web-v1.5.3-orthros-r19dev-a --engine-br); dir=$V/w19a ;;
  19L) eng=(--engine openmw-web-v1.5.3-orthros-r19); dir=$J/w19L ;;
  20*) eng=(--engine openmw-web-v1.5.3-orthros-r20dev-${side#20} --engine-br); dir=$J/w$side ;;
  19*) eng=(--engine openmw-web-v1.5.3-orthros-r19dev-${side#19} --engine-br); dir=$J/w$side ;;
  *) echo "side?"; exit 2 ;;
esac
/srv/orthros/tools/mem-check.sh -w 24 || exit 3
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) place-load side=$side tag=$tag $* ${ORTHROS_CHROME_ARGS:+chrome-args=$ORTHROS_CHROME_ARGS} ${ORTHROS_PLACE_PROFILE:+profile}" >> $J/logs/runs-started.txt
cd $W && exec /srv/orthros/tools/with-browser-slot.sh node tools/openmw/place-load.mjs morrowind-goty-en --tree $W --warm-tree $W --scratch $dir --pristine $V/pristine --engines-dir $S/eng "${eng[@]}" --save $S/saves/-2_6.omwsave --runs 1 --tag "$tag" --out "$out" "$@"
