#!/bin/bash
# usage: pl.sh <19L|20c> <tag> <out jsonl> [place-load options...]: jspi5's warm profiles (each side its own) and pristine learned state copy, data-r19's engines folder and save
S=/tmp/orthros-scratch/data-r19; J=/tmp/orthros-scratch/jspi5; F=/tmp/orthros-scratch/jspifair2; W=/srv/orthros/.claude/worktrees/data-r15
side=$1; tag=$2; out=$3; shift 3
case $side in
  19L) eng=(--engine openmw-web-v1.5.3-orthros-r19); dir=$J/w19L ;;
  20c) eng=(--engine openmw-web-v1.5.3-orthros-r20dev-c --engine-br); dir=$J/w20c ;;
  *) echo "side?"; exit 2 ;;
esac
/srv/orthros/tools/mem-check.sh -w 24 || exit 3
echo "$(date +%T) queued avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) place-load side=$side tag=$tag $* ${ORTHROS_LOAD_MAX:+loadmax=$ORTHROS_LOAD_MAX}" >> $F/logs/runs-started.txt
cd $W && exec /srv/orthros/tools/with-browser-slot.sh $F/bin/start-log.sh "start tag=$tag" node tools/openmw/place-load.mjs morrowind-goty-en --tree $W --warm-tree $W --scratch $dir --pristine $J/pristine --engines-dir $S/eng "${eng[@]}" --save $S/saves/-2_6.omwsave --runs 1 --tag "$tag" --out "$out" "$@"
