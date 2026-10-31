import json,sys,gzip,collections
# engine files (the release's openmw.js/wasm/data, lean or full) through the proxy: requests, wire MB, by url
for f in sys.argv[1:]:
  c=collections.defaultdict(lambda:[0,0])
  op=gzip.open if f.endswith('.gz') else open
  for l in op(f,'rt'):
    try: j=json.loads(l)
    except: continue
    u=j.get('url') or ''
    if 'openmw.data' in u or 'openmw.wasm' in u or 'openmw.js' in u:
      k=u.split('?')[0]; k=k[k.find('/e/'):] if '/e/' in k else k[-70:]
      c[(k, u.split('?')[1][:40] if '?' in u else '')][0]+=1; c[(k, u.split('?')[1][:40] if '?' in u else '')][1]+=j.get('wire',0)
  print('==',f)
  for k,v in sorted(c.items(), key=lambda x:-x[1][1])[:8]: print(' ',v[0],'req',round(v[1]/1e6,2),'MB',k)
