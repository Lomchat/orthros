import json,sys
for f in sys.argv[1:]:
  for l in open(f):
    d=json.loads(l); p=d.get('jspiProbe') or {}; e=d.get('engineStart') or {}; L=d.get('load') or {}
    print(f"{d['tag']:18s} menu {e.get('menuS')} ff {e.get('firstFrameS')} inWorld {L.get('inWorldS')} steady {L.get('steadyS')} frozen {L.get('frozenMs')} block {p.get('blockMaxMs')} inP50 {p.get('inputP50Ms')} inP95 {p.get('inputP95Ms')} gapMax {p.get('frameGapMaxMs')} lateOld {(d.get('precompile') or {}).get('lateOld')} demandWait {e.get('toMenu',{}).get('demandWaitS')} faults {len(d.get('faults') or [])}")
