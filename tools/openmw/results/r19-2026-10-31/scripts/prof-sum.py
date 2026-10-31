import gzip,json,sys,collections
p=json.load(gzip.open(sys.argv[1]))
nodes={n['id']:n for n in p['nodes']}
parent={}
for n in p['nodes']:
  for c in n.get('children',[]): parent[c]=n['id']
dt=p['timeDeltas']; s=p['samples']
t0=p['startTime']
win=(float(sys.argv[2])*1e6, float(sys.argv[3])*1e6) if len(sys.argv)>3 else (0,1e18)
self_=collections.Counter(); kind=collections.Counter()
t=0
for i,(sid,d) in enumerate(zip(s,dt)):
  t+=d
  if not(win[0]<=t<win[1]): continue
  n=nodes[sid]; cf=n['callFrame']; name=cf['functionName'] or '(anon)'; url=cf.get('url','')
  w = dt[i+1] if i+1<len(dt) else 0
  self_[(name,url.split('/')[-1][:30])]+=w
  k='wasm' if url.startswith('wasm') or 'wasm-function' in name or url.endswith('.wasm') else ('special' if name.startswith('(') else 'js')
  kind[k if k!='special' else name]+=w
tot=sum(kind.values())
print('total ms',tot/1000)
for k,v in kind.most_common(): print(f'  {k:30s} {v/1000:9.1f}')
for (n,u),v in self_.most_common(int(sys.argv[4]) if len(sys.argv)>4 else 25): print(f'{v/1000:9.1f} {n[:60]:60s} {u}')
