# a warm save's phases from its read trace: the loading screen (key -> serial esm reads: waits, reads, suspensions, the
# engine's own work), the serial esm reads, after them to the world; usage: phases.py <run dir>...
import json,gzip,sys
for d in sys.argv[1:]:
  tr=json.load(gzip.open(d+'/read-trace.json.gz','rt')); k=tr['keyAt']; T=tr['trace']; w=tr.get('inWorldAt')
  esm=[e for e in T if e['t']>=k and e.get('k') in ('sync','late','spin') and (e.get('f') or '').endswith('Morrowind.esm') and e.get('ms',0)>=50]
  if not esm: print(d.split('/')[-1][:14],'no serial esm'); continue
  e0=esm[0]['t']-k; e1=esm[-1]['t']+esm[-1]['ms']-k
  ww=[e for e in T if e['t']>=k and e.get('k')=='wwait' and e['t']-k<e0]
  rd=[e for e in T if e['t']>=k and e.get('k') in ('sync','late','spin') and e['t']-k<e0]
  sus=[e for e in T if e.get('k')=='jspi' and e.get('ev')=='suspended' and k<=e['x'][1]<(w or 1e18)]
  pre={}; post={}
  for e in sus: (pre if e['x'][1]-k<e0 else post)[e['x'][0]]=(pre if e['x'][1]-k<e0 else post).get(e['x'][0],0)+e['x'][2]
  W=sum(e.get('ms',0) for e in ww); Rm=sum(e.get('ms',0) for e in rd)
  print(f"{d.split('/')[-1][:14]:14s} world {round(w-k) if w else None:>5} | load {round(e0):>5} waits {W:>5} reads {len(rd):>3}/{Rm:>4} work {round(e0-W-Rm-pre.get('breath',0)-pre.get('present',0)-pre.get('settle',0)):>5} | esm {round(e1-e0):>5} | after {round(w-k-e1) if w else None:>5} susp {({a:round(b) for a,b in post.items() if b>=1})}")
