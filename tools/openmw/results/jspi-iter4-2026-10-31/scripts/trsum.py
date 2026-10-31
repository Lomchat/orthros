# a place-load browser trace: busy time by 100 ms of the renderer's main thread, the GPU main thread (and what ran there:
# top-level task names), and the renderer's long tasks; time 0 = the trace's first renderer main-thread task
import json,gzip,collections,sys
D=sys.argv[1]; t=json.load(gzip.open(D+'/load.trace.json.gz','rt')); ev=t['traceEvents'] if isinstance(t,dict) else t
pn={}; tn={}
for e in ev:
  if e.get('ph')=='M' and e['name']=='process_name': pn[e['pid']]=e['args']['name']
  if e.get('ph')=='M' and e['name']=='thread_name': tn[(e['pid'],e['tid'])]=e['args']['name']
def th(name, proc):
  return [k for k,v in tn.items() if v==name and pn.get(k[0])==proc]
rm=th('CrRendererMain','Renderer'); gm=th('CrGpuMain','GPU Process'); vz=th('VizCompositorThread','GPU Process')
X=[e for e in ev if e.get('ph')=='X' and 'dur' in e]
def top(k):
  es=sorted([e for e in X if (e['pid'],e['tid']) in k], key=lambda e:(e['ts'],-e['dur'])); out=[]; end=-1
  for e in es:
    if e['ts']>=end: out.append(e); end=e['ts']+e['dur']
  return out
R=top(rm); G=top(gm); V=top(vz)
t0=min(e['ts'] for e in R)
print('renderer long tasks (>80 ms): start s, ms, name')
for e in R:
  if e['dur']>80000: print(f"  {(e['ts']-t0)/1e6:6.2f} {e['dur']/1000:6.0f} {e['name']}")
B=int(sys.argv[2]) if len(sys.argv)>2 else 250
def buckets(L):
  b=collections.Counter()
  for e in L:
    s=e['ts']-t0; d=e['dur']
    while d>0:
      i=int(s//(B*1000)); n=min(d,(i+1)*B*1000-s); b[i]+=n; s+=n; d-=n
  return b
br=buckets(R); bg=buckets(G); bv=buckets(V)
names=collections.defaultdict(collections.Counter)
for e in G: names[int((e['ts']-t0)//(B*1000))][e['name']]+=e['dur']
print(f'per {B} ms: renderer main busy %, GPU main busy %, viz %, GPU top tasks')
for i in range(0, max(list(br)+list(bg))+1):
  print(f"  {i*B/1000:5.2f}  R{100*br[i]/(B*1000):4.0f}%  G{100*bg[i]/(B*1000):4.0f}%  V{100*bv[i]/(B*1000):4.0f}%  ", ', '.join(f"{n.split('::')[-1][:28]}:{v/1000:.0f}" for n,v in names[i].most_common(3)))
