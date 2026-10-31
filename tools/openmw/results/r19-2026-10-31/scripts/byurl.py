import gzip,json,sys,collections
p=json.load(gzip.open(sys.argv[1],'rt')); nodes={n['id']:n for n in p['nodes']}
win=float(sys.argv[2])*1e6 if len(sys.argv)>2 else 1e18
c=collections.Counter(); f=collections.Counter(); t=0
for i,sid in enumerate(p['samples']):
  t+=p['timeDeltas'][i]
  if t>win: break
  w=p['timeDeltas'][i+1] if i+1<len(p['timeDeltas']) else 0
  cf=nodes[sid]['callFrame']; u=cf.get('url','').split('/')[-1] or cf['functionName']
  c[u]+=w; f[(u,cf['functionName'])]+=w
for k,v in c.most_common(14): print(f"{v/1000:8.1f} {k}")
print('--')
for (u,n),v in f.most_common(40):
  if not u.startswith('(') and not u.endswith('.wasm') and v>5000: print(f"{v/1000:8.1f} {u} {n}")
