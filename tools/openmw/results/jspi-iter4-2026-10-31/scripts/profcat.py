# a place-load CPU profile's self time from the key to the world, by category: idle, (program), wasm, GC, the page's JS by file, natives
import json,gzip,sys,collections
d=sys.argv[1]; at=float(sys.argv[2])
p=json.load(open(d+'/load.cpuprofile')); tr=json.load(gzip.open(d+'/read-trace.json.gz','rt')); k=tr['keyAt']; w=tr.get('inWorldAt') or k+6000
lo=float(sys.argv[3]) if len(sys.argv)>3 else 0; hi=float(sys.argv[4]) if len(sys.argv)>4 else (w-k)
nodes={n['id']:n for n in p['nodes']}
c=collections.Counter(); acc=p['startTime']; ts=[]
for dt in p['timeDeltas']: acc+=dt; ts.append(acc)
for i,(sid,tt) in enumerate(zip(p['samples'],ts)):
  pt=at+(tt-p['startTime'])/1000-k
  if pt<lo or pt>hi: continue
  dt=(ts[i+1]-tt)/1000 if i+1<len(ts) else 0
  cf=nodes[sid]['callFrame']; f=cf['functionName']; u=cf.get('url','').split('/')[-1]
  cat=f if f in ('(idle)','(program)','(garbage collector)') else 'wasm' if u.endswith('.wasm') else ('js:'+u) if u else ('native:'+f)
  c[cat]+=dt
print(d.split('/')[-1][:14], f'{lo:.0f}-{hi:.0f} ms', ', '.join(f'{k} {v:.0f}' for k,v in c.most_common(14)))
