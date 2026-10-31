import gzip,json,sys
def load(run, upto):
  tr=json.load(gzip.open(run+'/read-trace.json.gz','rt'))['trace']
  d={}
  for e in tr:
    if e.get('k') in ('sync','late','spin') and e['t']<upto:
      k=(e.get('f'),e.get('off')); d.setdefault(k,[0,0,e['t']]); d[k][0]+=e.get('ms',0); d[k][1]+=1
  return d
a=load(sys.argv[1], float(sys.argv[3])); b=load(sys.argv[2], float(sys.argv[4]))
keys=set(a)|set(b)
rows=sorted(((b.get(k,[0])[0]-a.get(k,[0])[0]),k) for k in keys)
print('total a',sum(v[0] for v in a.values()),'b',sum(v[0] for v in b.values()), 'only a', sum(v[0] for k,v in a.items() if k not in b), 'only b', sum(v[0] for k,v in b.items() if k not in a))
for dlt,k in rows[:12]+rows[-25:]:
  print(f"{dlt:6d} a={a.get(k,[None,0,None])[0]} b={b.get(k,[None,0,None])[0]} tA={a.get(k,[0,0,0])[2]/1000:.1f} tB={b.get(k,[0,0,0])[2]/1000:.1f} {k[0].split('/')[-1]} {k[1]}")
