// Development/serving host: static files (the page, the ES modules of the emulator), manifests,
// and the game folder served read-only with HTTP range requests + a JSON directory listing.
// Sends the COOP/COEP headers required for SharedArrayBuffer and Atomics.wait in the page.
// Usage: node src/host/server.js [--port 8080] [--manifests manifests/]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from './manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };

export function loadManifests(dir, extra = null) {
  const out = new Map();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      m.folder = path.resolve(dir, m.folder ?? '.');
      out.set(f.slice(0, -5), withDefaults(m));
    }
  }
  for (const [name, m] of extra ?? []) out.set(name, m); // (manifests given by the caller: `orthros run <folder>`)
  return out;
}

/** Recursive listing { name, size, dirs: {...}, files: {...} } with original case. */
export function listTree(dir) {
  const node = { dirs: {}, files: {} };
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) node.dirs[e.name] = listTree(path.join(dir, e.name));
    else if (e.isFile()) { const st = fs.statSync(path.join(dir, e.name)); node.files[e.name] = { size: st.size, mtime: st.mtimeMs }; }
  }
  return node;
}

/** Resolve a URL path (case-insensitively) inside a game folder; returns the real path or null. */
function resolveInsensitive(root, rel) {
  let cur = root;
  for (const part of rel.split('/').filter(Boolean)) {
    if (part === '..' || part === '.') return null;
    let names; try { names = fs.readdirSync(cur); } catch { return null; }
    const hit = names.find((n) => n === part) ?? names.find((n) => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

export function createServer(opts = {}) {
  const manifestDir = path.resolve(opts.manifests ?? path.join(ROOT, 'manifests'));
  let manifests = loadManifests(manifestDir, opts.extra);
  const trees = new Map();
  const headers = (extra = {}) => ({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
    ...extra,
  });
  const send = (res, code, body, extra) => { res.writeHead(code, headers({ 'Content-Type': 'text/plain; charset=utf-8', ...extra })); res.end(body); };
  const sendFile = (req, res, file, mime) => {
    let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
    if (!st.isFile()) return send(res, 404, 'not found');
    const range = req.headers.range;
    const h = headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() });
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return send(res, 416, 'bad range', { 'Content-Range': `bytes */${st.size}` });
      let start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      if (start > end || start >= st.size) return send(res, 416, 'bad range', { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(ROOT, 'src/host/web/index.html'), MIME['.html']);
      if (p === '/api/manifests') { manifests = loadManifests(manifestDir, opts.extra); return send(res, 200, JSON.stringify([...manifests].map(([name, m]) => ({ name, title: m.name ?? name, exe: m.exe }))), { 'Content-Type': 'application/json' }); }
      let m = /^\/api\/manifest\/([^/]+)$/.exec(p);
      if (m) { const man = manifests.get(m[1]); if (!man) return send(res, 404, 'no such manifest'); return send(res, 200, JSON.stringify({ ...man, folder: undefined }), { 'Content-Type': 'application/json' }); }
      m = /^\/api\/tree\/([^/]+)$/.exec(p);
      if (m) { const man = manifests.get(m[1]); if (!man) return send(res, 404, 'no such manifest'); if (!trees.has(m[1])) trees.set(m[1], JSON.stringify(listTree(man.folder))); return send(res, 200, trees.get(m[1]), { 'Content-Type': 'application/json' }); }
      m = /^\/game\/([^/]+)\/(.*)$/.exec(p);
      if (m) { const man = manifests.get(m[1]); if (!man) return send(res, 404, 'no such manifest'); const file = resolveInsensitive(man.folder, m[2]); if (!file) return send(res, 404, 'not found'); return sendFile(req, res, file, 'application/octet-stream'); }
      if (p.startsWith('/src/') || p.startsWith('/tools/') || p.startsWith('/tests/')) {
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
        return sendFile(req, res, file, MIME[path.extname(file)] ?? 'application/octet-stream');
      }
      return send(res, 404, 'not found');
    } catch (e) {
      return send(res, 500, String(e.stack || e));
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1] || 8080) || 8080;
  const manifests = args.includes('--manifests') ? args[args.indexOf('--manifests') + 1] : undefined;
  const server = createServer({ manifests });
  server.listen(port, '127.0.0.1', () => console.log(`orthros: http://127.0.0.1:${port}/`));
}
