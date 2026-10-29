#!/usr/bin/env python3
# A Nexus Mods file downloaded through Nexus' public API, the way mod managers (Vortex) do — no website scraping, no
# CAPTCHA: the API key (NEXUS_API_KEY in /srv/orthros/.env, Site preferences > API Access) and, for an account
# without Premium, the "Mod manager download" link the player clicks on the file's page (nxm://<game>/mods/<mod>/files/
# <file>?key=…&expires=…: valid a few minutes). With Premium, a mod page URL with file_id is enough.
# The archive goes to its own new folder (untrusted data) with a receipt (mod, file, version, URL taken, size, MD5 checked
# against Nexus' own, SHA-256). Also --info <mod url or id>: the mod's files (ids, categories, versions).
# Usage: python3 -I tools/nexus-get.py <nxm://… | https://www.nexusmods.com/<game>/mods/<id>?tab=files&file_id=<f>> [--out <dir>]
#        python3 -I tools/nexus-get.py --info <https://www.nexusmods.com/<game>/mods/<id> | id> [--game morrowind]
import hashlib, json, os, pathlib, re, sys, urllib.parse, urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = 'https://api.nexusmods.com/v1'

def env(name):
    if os.environ.get(name):
        return os.environ[name]
    f = ROOT / '.env'
    if f.exists():
        for line in f.read_text().splitlines():
            m = re.match(rf'^{name}=(.*)$', line.strip())
            if m:
                return m.group(1).strip()
    sys.exit(f'{name} is not set (put it in {f})')

def call(path, params=None):
    url = f'{API}{path}' + ('?' + urllib.parse.urlencode(params) if params else '')
    req = urllib.request.Request(url, headers={'apikey': env('NEXUS_API_KEY'), 'Application-Name': 'orthros', 'Application-Version': '1.0',
                                               'User-Agent': 'orthros-nexus-get/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f'Nexus API {e.code} on {path}: {e.read().decode(errors="replace")[:300]}')

def parse(link):
    u = urllib.parse.urlparse(link)
    q = dict(urllib.parse.parse_qsl(u.query))
    if u.scheme == 'nxm':
        m = re.match(r'^/mods/(\d+)/files/(\d+)$', u.path)
        if not m:
            sys.exit(f'Not an nxm file link: {link}')
        return u.netloc, m.group(1), m.group(2), {k: q[k] for k in ('key', 'expires') if k in q}
    m = re.match(r'^/([^/]+)/mods/(\d+)', u.path)
    if not m or 'file_id' not in q:
        sys.exit(f'Expected nxm://… or a mod page URL with file_id: {link}')
    return m.group(1), m.group(2), q['file_id'], {}

def main(argv):
    if not argv:
        sys.exit(__doc__ or 'usage: nexus-get.py <link> [--out dir] | --info <mod>')
    game = argv[argv.index('--game') + 1] if '--game' in argv else 'morrowind'
    if argv[0] == '--info':
        target = argv[1]
        m = re.search(r'/([^/]+)/mods/(\d+)', target)
        game, mod = (m.group(1), m.group(2)) if m else (game, target)
        info = call(f'/games/{game}/mods/{mod}.json')
        print(f"{info['name']} {info['version']} (updated {info.get('updated_time')}) by {info.get('author')}\n{info.get('summary', '')}")
        for f in call(f'/games/{game}/mods/{mod}/files.json')['files']:
            print(f"  {f['file_id']}  {f['category_name']:<14} v{f['version']:<8} {f['size_kb']:>8} KB  {f['name']}")
        return
    game, mod, file_id, auth = parse(argv[0])
    info = call(f'/games/{game}/mods/{mod}.json')
    meta = call(f'/games/{game}/mods/{mod}/files/{file_id}.json')
    links = call(f'/games/{game}/mods/{mod}/files/{file_id}/download_link.json', auth or None)
    if not links:
        sys.exit('Nexus returned no download link')
    url = links[0]['URI']
    out = pathlib.Path(argv[argv.index('--out') + 1]) if '--out' in argv else ROOT / 'data/installers/nexus' / f'{game}-{mod}-{file_id}'
    out.mkdir(parents=True, exist_ok=False)
    name = re.sub(r'[^A-Za-z0-9._ -]', '_', meta.get('file_name') or f'{file_id}.bin')
    target = out / name
    md5, sha = hashlib.md5(), hashlib.sha256()
    req = urllib.request.Request(url, headers={'User-Agent': 'orthros-nexus-get/1.0'})
    with urllib.request.urlopen(req, timeout=600) as r, open(target, 'wb') as w:
        while chunk := r.read(1 << 20):
            w.write(chunk); md5.update(chunk); sha.update(chunk)
    if meta.get('md5') and meta['md5'] != md5.hexdigest():
        target.unlink()
        sys.exit(f'MD5 mismatch: Nexus says {meta["md5"]}, got {md5.hexdigest()}')
    os.chmod(target, 0o644)
    receipt = {'game': game, 'mod': int(mod), 'modName': info['name'], 'author': info.get('author'), 'fileId': int(file_id),
               'fileName': meta.get('file_name'), 'name': meta.get('name'), 'version': meta.get('version'), 'category': meta.get('category_name'),
               'page': f'https://www.nexusmods.com/{game}/mods/{mod}?tab=files&file_id={file_id}', 'bytes': target.stat().st_size,
               'md5': md5.hexdigest(), 'md5CheckedAgainstNexus': bool(meta.get('md5')), 'sha256': sha.hexdigest(),
               'downloadedAt': datetime.now(timezone.utc).isoformat(timespec='seconds')}
    (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))

if __name__ == '__main__':
    main(sys.argv[1:])
