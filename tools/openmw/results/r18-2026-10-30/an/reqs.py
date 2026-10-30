import json,sys,gzip,re,urllib.parse
f=sys.argv[1]
recs=[json.loads(l) for l in gzip.open(f,'rt')]
mark=[r for r in recs if r['url'].startswith('/__qa/mark')]
t0=mark[0]['t'] if mark else 0
def kind(u):
  return 'want' if re.search(r'[?&]w=1',u) else 'bg' if re.search(r'[?&]p=1',u) else 'ahead' if re.search(r'[?&]a=1',u) else 'demand' if re.search(r'[?&]s=',u) else 'other'
for r in recs:
  u=r['url']
  if '/game' not in u and '/gamez/' not in u and '/__qa' not in u and '/api/' not in u: continue
  m=re.search(r'/gamez?/[^/]+/(.*?)\?r=(\d+)-(\d+)',u)
  name=urllib.parse.unquote(m.group(1)).split('/')[-1] if m else u[:70]
  rng=f"{int(m.group(2))}-{int(m.group(3))}" if m else ''
  sz=(int(m.group(3))-int(m.group(2))+1) if m else 0
  print(f"{(r['t']-t0)/1000:8.2f} {r.get('ms',-1000)/1000:6.2f} end {(r['t']+r.get('ms',0)-t0)/1000:7.2f} {kind(u):7} {r.get('wire',0)/1024:7.0f}K dec{sz/1024:7.0f}K {name} {rng}")
