#!/bin/bash
# Multi-title bring-up dashboard: boot every catalogued title with the boot probe, one at a
# time, and append one row per title to /srv/bfme/docs/dashboard.md (plus the raw logs under
# /srv/bfme/docs/dashboard/). Meant to run nightly (orthros-dashboard.timer) so a regression
# on any title shows up the next morning: first presentation time, faults, Worker errors,
# unimplemented APIs called, shader assembly, dangling JIT edges.
#
#   tools/examples/titles-dashboard.sh [bfme bfme2 rotwk]
export PATH=/opt/bun/bin:/root/.nvm/versions/node/v20.19.5/bin:/usr/local/bin:$PATH
cd /srv/bfme/app/orthros || exit 2
OUT=/srv/bfme/docs/dashboard.md
DIR=/srv/bfme/docs/dashboard
mkdir -p "$DIR"
TITLES=${*:-bfme bfme2 rotwk}
STAMP=$(date +%Y-%m-%d_%H%M)
WORKER=$(ls -t dist/assets/emulator.worker-*.js 2>/dev/null | head -1 | xargs -r basename)
BATCH=$(sha256sum /srv/bfme/data/bfme1-222-multi.wgb.aot-bridge.wasm 2>/dev/null | cut -c1-8)
[ -f "$OUT" ] || printf '# Tableau de bord des titres\n\nUne ligne par titre et par nuit : premier rendu (s), fautes, erreurs Worker, API absentes appelées, shaders assemblés, arêtes JIT pendantes, Worker et lot servis.\n\n| date | titre | premier rendu | fautes | erreurs Worker | API absentes | shaders ok/échecs | arêtes JIT | Worker | lot |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' > "$OUT"
for t in $TITLES; do
    case $t in
        bfme)  P=/srv/bfme/app/orthros/tmp/bfme1-fresh4; PORT=9543; TO=300 ;;
        bfme2) P=/srv/bfme/app/orthros/tmp/bfme2-b6c6795; PORT=9551; TO=600 ;;
        rotwk) P=/srv/bfme/app/orthros/tmp/rotwk-b6c6795; PORT=9552; TO=420 ;;
        *) echo "unknown title $t"; continue ;;
    esac
    LOG=$DIR/$STAMP-$t.log
    timeout 1500 bun tools/examples/bfme2-boot-probe.ts --game $t --profile "$P" --port $PORT --boot-timeout $TO --settle 10 > "$LOG" 2>&1
    FP=$(grep -oE "first present after [0-9]+s \(present=[0-9]+\)" "$LOG" | head -1 | sed -E 's/first present after ([0-9]+)s \(present=([0-9]+)\)/\1s (\2)/')
    FAULTS=$(grep -oE "^faults .*" "$LOG" | head -1 | sed 's/^faults //' | cut -c1-40)
    WERR=$(grep -oE "^worker errors .*" "$LOG" | head -1 | sed 's/^worker errors //' | cut -c1-40)
    API=$(grep -oE "^API-CENSUS n=[0-9]+" "$LOG" | head -1 | sed 's/API-CENSUS n=//')
    ASM=$(grep -oE "\"ok\":[0-9]+,\"failures\":\[[^]]*\]" "$LOG" | head -1 | sed -E 's/"ok":([0-9]+),"failures":\[([^]]*)\]/\1 ok, [\2]/' | cut -c1-40)
    DANG=$(grep -oE "\"danglingEdges\":[0-9]+" "$LOG" | head -1 | sed 's/"danglingEdges"://')
    printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' "$STAMP" "$t" "${FP:-aucun}" "${FAULTS:-?}" "${WERR:-?}" "${API:-?}" "${ASM:-?}" "${DANG:-?}" "${WORKER:-?}" "${BATCH:-?}" >> "$OUT"
done
# In-game probe: BFME II from the menu to a skirmish by the scripted path (label hit
# rectangles read from the APT textures), then two minutes of sensors. The row carries the
# per-15 s FPS series in the "premier rendu" column (load dip, then the in-game cadence).
case " $TITLES " in *" bfme2 "*)
    LOG=$DIR/$STAMP-bfme2-escarmouche.log
    timeout 900 bun tools/examples/nav-probe.ts --game bfme2 --profile /srv/bfme/app/orthros/tmp/bfme2-b6c6795 --port 9551 --actions tools/examples/bfme2-skirmish.actions --boot-timeout 600 > "$LOG" 2>&1
    FPS=$(grep -oE '"step":"wait 15","fps":-?[0-9.]+' "$LOG" | sed -E 's/.*"fps":(-?[0-9.]+)/\1/' | tr '\n' '/' | sed 's,/$,,')
    FAULTS=$(grep -oE '"step":"dbg faults","result":\[[^]]*\]' "$LOG" | head -1 | sed -E 's/.*"result"://' | cut -c1-40)
    MB=$(grep -oE '"step":"dbg messageBoxes","result":\[[^]]*\]' "$LOG" | head -1 | sed -E 's/.*"result"://' | cut -c1-40)
    STUBS=$(grep -oE '"step":"harness stubs","result":\[[^]]*\]' "$LOG" | head -1 | sed -E 's/.*"result"://' | cut -c1-60)
    printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' "$STAMP" "bfme2 escarmouche" "${FPS:-aucune}" "${FAULTS:-?}" "boîtes ${MB:-?}" "stubs ${STUBS:-?}" "-" "-" "${WORKER:-?}" "-" >> "$OUT"
    ;;
esac
case " $TITLES " in *" rotwk "*)
    LOG=$DIR/$STAMP-rotwk-escarmouche.log
    timeout 900 bun tools/examples/nav-probe.ts --game rotwk --profile /srv/bfme/app/orthros/tmp/rotwk-b6c6795 --port 9552 --actions tools/examples/rotwk-skirmish.actions --boot-timeout 600 > "$LOG" 2>&1
    FPS=$(grep -oE '"step":"wait 15","fps":-?[0-9.]+' "$LOG" | sed -E 's/.*"fps":(-?[0-9.]+)/\1/' | tr '\n' '/' | sed 's,/$,,')
    FAULTS=$(grep -oE '"step":"dbg faults","result":\[[^]]*\]' "$LOG" | head -1 | sed -E 's/.*"result"://' | cut -c1-40)
    MB=$(grep -oE '"step":"dbg messageBoxes","result":\[[^]]*\]' "$LOG" | head -1 | sed -E 's/.*"result"://' | cut -c1-40)
    STUBS=$(grep -oE '"step":"harness stubs","result":\[[^]]*\]' "$LOG" | head -1 | sed -E 's/.*"result"://' | cut -c1-60)
    printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' "$STAMP" "rotwk escarmouche" "${FPS:-aucune}" "${FAULTS:-?}" "boîtes ${MB:-?}" "stubs ${STUBS:-?}" "-" "-" "${WORKER:-?}" "-" >> "$OUT"
    ;;
esac
echo "$(date +%H:%M:%S) dashboard done ($TITLES)" > /tmp/dashboard.out
