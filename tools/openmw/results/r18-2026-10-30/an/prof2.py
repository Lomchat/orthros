import json,gzip,sys,collections
d,rowf,lo,hi=sys.argv[1],sys.argv[2],float(sys.argv[3]),float(sys.argv[4])
p=json.load(open(d+'/load.cpuprofile')); r=[json.loads(l) for l in open(rowf)][-1]; at=r['cpuProfile']['at']
t0=json.load(gzip.open(d+'/read-trace.json.gz','rt'))['from']
nodes={n['id']:n for n in p['nodes']}; parent={}
for n in p['nodes']:
  for c in n.get('children',[]): parent[c]=n['id']
WAIT={'fetchSync','wantWaitFor','fetchSpin','wantWaitSoon','wantWaitForAsync','(idle)'}
def anc(i):
  out=[]
  while i in nodes and len(out)<40: out.append(nodes[i]['callFrame']['functionName']); i=parent.get(i)
  return out
t=p['startTime']; c=collections.Counter()
for s,dt in zip(p['samples'],p['timeDeltas']):
  t+=dt; rel=(at+(t-p['startTime'])/1000-t0)/1000
  if not (lo<=rel<=hi): continue
  a=anc(s); n=a[0]
  if n=='(idle)' or any(x in WAIT for x in a): k='wait'
  elif n=='(program)': k='program'
  elif n=='(garbage collector)': k='gc'
  elif n.startswith('wasm-function'): k='wasm'
  else: k='js'
  c[k]+=dt/1000
print({k:round(v) for k,v in c.items()}, 'total', round(sum(c.values())))
