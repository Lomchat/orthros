import json,gzip,sys,collections,re
def run(d,rowf,lo,hi,symf):
  lo,hi=float(lo),float(hi)
  sym={}
  for l in open(symf):
    i,_,n=l.rstrip('\n').partition(':'); sym[int(i)]=n
  p=json.load(open(d+'/load.cpuprofile')); r=[json.loads(l) for l in open(rowf)][-1]; at=r['cpuProfile']['at']
  t0=json.load(gzip.open(d+'/read-trace.json.gz','rt'))['from']
  nodes={n['id']:n for n in p['nodes']}; parent={}
  for n in p['nodes']:
    for c in n.get('children',[]): parent[c]=n['id']
  def nm(i):
    f=nodes[i]['callFrame']['functionName']; m=re.match(r'wasm-function\[(\d+)\]',f)
    return re.sub(r'\(.*','',sym.get(int(m.group(1)),f)) if m else f
  incl=collections.Counter(); selfc=collections.Counter(); t=p['startTime']
  for s,dt in zip(p['samples'],p['timeDeltas']):
    t+=dt; rel=(at+(t-p['startTime'])/1000-t0)/1000
    if not(lo<=rel<=hi): continue
    seen=set(); i=s; selfc[nm(s)]+=dt/1000
    while i in nodes:
      n=nm(i)
      if n not in seen: incl[n]+=dt/1000; seen.add(n)
      i=parent.get(i)
  return incl,selfc
a,sa=run(*sys.argv[1:6]); b,sb=run(*sys.argv[6:11])
keys=set(k for k,v in a.items() if v>40)|set(k for k,v in b.items() if v>40)
rows=sorted(keys,key=lambda k:-(b[k]-a[k]))
print('inclusive r17 / r18 / diff')
for k in rows[:25]: print(f"{a[k]:7.0f} {b[k]:7.0f} {b[k]-a[k]:+7.0f}  {k[:110]}")
print('self top diffs')
ks=set(sa)|set(sb)
for k in sorted(ks,key=lambda k:-(sb[k]-sa[k]))[:15]: print(f"{sa[k]:7.0f} {sb[k]:7.0f} {sb[k]-sa[k]:+7.0f}  {k[:110]}")
