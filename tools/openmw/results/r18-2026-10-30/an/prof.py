import json,gzip,sys,collections
d,rowf,lo,hi=sys.argv[1],sys.argv[2],float(sys.argv[3]),float(sys.argv[4])
p=json.load(open(d+'/load.cpuprofile'))
r=[json.loads(l) for l in open(rowf)][-1]
at=r['cpuProfile']['at']; t0=r['P']['from'] if 'P' in r else None
tr=json.load(gzip.open(d+'/read-trace.json.gz','rt')); t0=tr['from']
nodes={n['id']:n for n in p['nodes']}
t=p['startTime']; self=collections.Counter(); js=collections.Counter()
for s,dt in zip(p['samples'],p['timeDeltas']):
  t+=dt; rel=(at+(t-p['startTime'])/1000-t0)/1000
  if lo<=rel<=hi:
    cf=nodes[s]['callFrame']; n=cf['functionName'] or '(anon)'; u=cf['url'].split('/')[-1]
    cat='idle' if n=='(idle)' else 'gc' if n=='(garbage collector)' else 'program' if n=='(program)' else 'wasm' if n.startswith('wasm-function') or u.endswith('.wasm') else 'js'
    self[cat]+=dt/1000
    if cat=='js': js[f'{n} {u}']+=dt/1000
print({k:round(v) for k,v in self.items()})
for k,v in js.most_common(25): print(round(v,1),k)
