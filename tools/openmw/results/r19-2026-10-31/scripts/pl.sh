#!/bin/bash
# usage: pl.sh <side: 18 | 19<dev suffix>> <tag> <out jsonl> [place-load options...]; WARM=<profile dir> (shared by both sides), PLDIR=<scratch subdir>
S=/tmp/orthros-scratch/data-r19; W=/srv/orthros/.claude/worktrees/data-r15
side=$1; tag=$2; out=$3; shift 3
case $side in
  17) eng=(--engine openmw-web-v1.5.3-orthros-r17); dir=${PLDIR:-pl17} ;;
  18) eng=(--engine openmw-web-v1.5.3-orthros-r18); dir=${PLDIR:-pl18} ;;
  19d) eng=(--engine openmw-web-v1.5.3-orthros-r18dev-d --engine-br); dir=${PLDIR:-pl19} ;;
  19*) eng=(--engine openmw-web-v1.5.3-orthros-r19dev-${side#19} --engine-br); dir=${PLDIR:-pl19${side#19}} ;;
esac
warm=(); [ -n "$WARM" ] && warm=(--profile-warm "$WARM")
/srv/orthros/tools/mem-check.sh -w 24 || exit 3
echo "$(date +%T) avail=$(/srv/orthros/tools/mem-check.sh | tr -d '\n')G load=$(cut -d' ' -f1 /proc/loadavg) side=$side tag=$tag $*" >> $S/logs/runs-started.txt
cd $W && exec /srv/orthros/tools/with-browser-slot.sh node tools/openmw/place-load.mjs morrowind-goty-en --tree $W --warm-tree $W --scratch $S/$dir --pristine $S/pristine --engines-dir $S/eng "${eng[@]}" "${warm[@]}" --save $S/saves/-2_6.omwsave --runs 1 --tag "$tag" --out "$out" "$@"
