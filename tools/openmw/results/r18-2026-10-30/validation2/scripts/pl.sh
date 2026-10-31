#!/bin/bash
# usage: pl.sh <side: 17|18> <tag> <out jsonl> [place-load options...]
S=/tmp/orthros-scratch/data-r18; W=/srv/orthros/.claude/worktrees/data-r15
side=$1; tag=$2; out=$3; shift 3
# side: 17 (live r17), 18 (r18dev), or 18<suffix> (r18dev-<suffix>, in pl18's scratch unless PLDIR says)
case $side in
  17) eng=(--engine openmw-web-v1.5.3-orthros-r17); dir=${PLDIR:-pl17} ;;
  17x) eng=(--engine openmw-web-v1.5.3-orthros-r17); dir=pl17x ;;
  18) eng=(--engine openmw-web-v1.5.3-orthros-r18dev --engine-br); dir=pl18 ;;
  18*) eng=(--engine openmw-web-v1.5.3-orthros-r18dev-${side#18} --engine-br); dir=${PLDIR:-pl18} ;;
esac
/srv/orthros/tools/mem-check.sh -w 24
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) side=$side tag=$tag $*" >> $S/logs2/runs-started.txt
cd $W && exec /srv/orthros/tools/with-browser-slot.sh node tools/openmw/place-load.mjs morrowind-goty-en --tree $W --warm-tree $W --scratch $S/$dir --pristine $S/pristine --engines-dir $S/eng "${eng[@]}" --save $S/saves/-2_6.omwsave --runs 1 --tag "$tag" --out "$out" "$@"
