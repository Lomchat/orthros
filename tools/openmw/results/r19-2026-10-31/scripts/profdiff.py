# self time per wasm function (by symbol name) in two CPU profiles, ms per frame-second, the largest differences
import json,sys,re,collections,gzip
def sym(p):
  m={}
  for l in open(p):
    i,_,n=l.rstrip('\n').partition(':'); m[i]=n
  return m
def prof(path,syms):
  p=json.load(gzip.open(path,'rt') if path.endswith('.gz') else open(path))
  nodes={n['id']:n for n in p['nodes']}
  c=collections.Counter(); dt=p['timeDeltas']; s=p['samples']
  for i,sid in enumerate(s):
    w=dt[i+1] if i+1<len(dt) else 0
    cf=nodes[sid]['callFrame']; n=cf['functionName']
    m=re.match(r'wasm-function\[(\d+)\]',n) or re.match(r'\$?(\d+)$',n)
    if m: n=syms.get(m.group(1),n)
    elif cf.get('url','').endswith('.wasm') and n in syms: n=syms[n]
    c[n]+=w
  tot=(p['endTime']-p['startTime'])
  return c,tot
a,ta=prof(sys.argv[1],sym(sys.argv[2])); b,tb=prof(sys.argv[3],sym(sys.argv[4]))
print('span s',ta/1e6,tb/1e6)
keys=set(a)|set(b)
d=sorted(((b[k]/tb-a[k]/ta)*1000,k) for k in keys)  # ms per s
for v,k in d[:15]: print(f"{v:8.2f} ms/s  a {a[k]/ta*1000:7.2f} b {b[k]/tb*1000:7.2f}  {k[:110]}")
print('...')
for v,k in d[-30:]: print(f"{v:8.2f} ms/s  a {a[k]/ta*1000:7.2f} b {b[k]/tb*1000:7.2f}  {k[:110]}")
