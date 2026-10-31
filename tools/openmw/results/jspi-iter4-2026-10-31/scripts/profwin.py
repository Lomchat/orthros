# a place-load CPU profile split by the engine's state: suspended (the trace's 'suspended' spans) or running, from the key to the world
# usage: profwin.py <run dir> [at]  — self time by function (url-file:function), top 25 each
import json,gzip,sys,collections
d=sys.argv[1]
p=json.load(open(d+'/load.cpuprofile'))
tr=json.load(gzip.open(d+'/read-trace.json.gz','rt')); k=tr['keyAt']; w=tr.get('inWorldAt') or k+6000
at=float(sys.argv[2]) if len(sys.argv)>2 else None
nodes={n['id']:n for n in p['nodes']}
parent={}
for n in p['nodes']:
  for c in n.get('children',[]): parent[c]=n['id']
def name(n):
  cf=n['callFrame']; u=cf.get('url','').split('/')[-1]
  return (u+':' if u else '')+(cf['functionName'] or '(anon)')
sus=[(e['x'][1],e['x'][1]+e['x'][2],e['x'][0]) for e in tr['trace'] if e.get('k')=='jspi' and e.get('ev')=='suspended']
t=p['startTime']; base=at if at is not None else None
# page time of the profile start: the place-load row's cpuProfile.at
if base is None:
  for l in open(sys.argv[3] if len(sys.argv)>3 else '/dev/null'): pass
ts=[]; acc=t
for dt in p['timeDeltas']: acc+=dt; ts.append(acc)
agg={'susp':collections.Counter(),'run':collections.Counter()}; tot={'susp':0,'run':0}
for i,(sid,tt) in enumerate(zip(p['samples'],ts)):
  pt=base+(tt-t)/1000
  if pt<k or pt>w: continue
  dt=(ts[i+1]-tt)/1000 if i+1<len(ts) else 0
  s='susp' if any(a<=pt<b for a,b,_ in sus) else 'run'
  agg[s][name(nodes[sid])]+=dt; tot[s]+=dt
for s in agg:
  print(f'== {s} {tot[s]:.0f} ms')
  for f,ms in agg[s].most_common(25): print(f'  {ms:7.1f} {f}')
