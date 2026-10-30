import json,gzip,sys,collections,re
d,rowf,lo,hi,symf=sys.argv[1],sys.argv[2],float(sys.argv[3]),float(sys.argv[4]),sys.argv[5]
pat=sys.argv[6] if len(sys.argv)>6 else 'LoadingScreen'
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
  return sym.get(int(m.group(1)),f) if m else f
incl=collections.Counter(); t=p['startTime']
for s,dt in zip(p['samples'],p['timeDeltas']):
  t+=dt; rel=(at+(t-p['startTime'])/1000-t0)/1000
  if not(lo<=rel<=hi): continue
  seen=set(); i=s
  while i in nodes:
    n=nm(i)
    if re.search(pat,n) and n not in seen: incl[n]+=dt/1000; seen.add(n)
    i=parent.get(i)
for k,v in incl.most_common(15): print(round(v),k[:150])
