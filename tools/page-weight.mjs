#!/usr/bin/env node
// What a page's first visit downloads before it can run, from its HTML: its stylesheets, scripts and their static
// import graph (no build step: each module is a request), with their bytes as the server sends them (brotli 11,
// server.js sendSource) and the depth of the graph (the round trips one after another before the last module
// arrives). The dynamic imports (import()) are listed apart: fetched later, when used.
//   node tools/page-weight.mjs [src/host/web/index.html ...] [--kbps 85] [--rtt 80] [--json]
// --kbps/--rtt: the time on such a link, as the browser fetches it (each level of the graph a round trip, its bytes
// the link's).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const pages = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const kbps = Number(arg('--kbps', 85)), rtt = Number(arg('--rtt', 80));

const brSize = new Map();
const wire = (file) => {
  if (!brSize.has(file)) {
    const buf = fs.readFileSync(file);
    const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } });
    brSize.set(file, { raw: buf.length, br: /\.(m?js|html|css|json|svg|txt)$/.test(file) && br.length <= buf.length * 0.92 ? br.length : buf.length });
  }
  return brSize.get(file);
};
const urlFile = (url, from) => {
  if (/^(https?:|data:|blob:)/.test(url)) return null;
  const p = url.split(/[?#]/)[0];
  return p.startsWith('/') ? path.join(ROOT, p) : path.resolve(path.dirname(from), p);
};
// (the static imports: `import ... from '...'`, `import '...'`, `export ... from '...'` — comments and strings aside, roughly)
const staticImports = (src) => {
  const out = new Set(), code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g)) out.add(m[1]);
  return [...out];
};
const dynamicImports = (src) => [...new Set([...src.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]))];

function weigh(html) {
  const file = path.resolve(ROOT, html), text = fs.readFileSync(file, 'utf8');
  const level = new Map(); // file -> depth (1: named by the page)
  const css = [], dyn = new Set();
  for (const m of text.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)) { const f = urlFile(m[1], file); if (f) css.push(f); }
  for (const m of text.matchAll(/<link[^>]+href="([^"]+)"[^>]*rel="stylesheet"/g)) { const f = urlFile(m[1], file); if (f && !css.includes(f)) css.push(f); }
  const roots = [];
  for (const m of text.matchAll(/<script[^>]+src="([^"]+)"/g)) { const f = urlFile(m[1], file); if (f) roots.push(f); }
  // inline module scripts' imports
  for (const m of text.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)) for (const s of staticImports(m[1])) { const f = urlFile(s, file); if (f) roots.push(f); }
  const queue = roots.map((f) => [f, 1]);
  while (queue.length) {
    const [f, d] = queue.shift();
    if (level.has(f) && level.get(f) <= d) continue;
    level.set(f, d);
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const s of staticImports(src)) { const g = urlFile(s, f); if (g) queue.push([g, d + 1]); }
    for (const s of dynamicImports(src)) { const g = urlFile(s, f); if (g) dyn.add(g); }
  }
  const mods = [...level].filter(([f]) => fs.existsSync(f)).map(([f, d]) => ({ file: path.relative(ROOT, f), depth: d, ...wire(f) }));
  const styles = css.filter((f) => fs.existsSync(f)).map((f) => ({ file: path.relative(ROOT, f), ...wire(f) }));
  const page = { file: path.relative(ROOT, file), ...wire(file) };
  const sum = (a, k) => a.reduce((n, x) => n + x[k], 0);
  const depth = Math.max(0, ...mods.map((m) => m.depth));
  const bytes = page.br + sum(styles, 'br') + sum(mods, 'br');
  // (the page, then its styles and the first modules at once, then each level of the graph: a round trip each)
  const seconds = (bytes * 8) / (kbps * 1000 * 8) + ((depth + 1) * rtt) / 1000;
  return { page, styles, modules: mods.sort((a, b) => a.depth - b.depth || b.br - a.br), dynamic: [...dyn].filter((f) => !level.has(f)).map((f) => path.relative(ROOT, f)),
    total: { requests: 1 + styles.length + mods.length, raw: page.raw + sum(styles, 'raw') + sum(mods, 'raw'), wire: bytes, depth, seconds: +seconds.toFixed(2) } };
}

const out = Object.fromEntries((pages.length ? pages : ['src/host/web/index.html']).map((p) => [p, weigh(p)]));
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const [p, w] of Object.entries(out)) {
  console.log(`${p}: ${w.total.requests} requests, ${(w.total.raw / 1024).toFixed(0)} KiB raw, ${(w.total.wire / 1024).toFixed(1)} KiB on the wire, graph depth ${w.total.depth}; at ${kbps} KB/s, ${rtt} ms: ${w.total.seconds} s`);
  for (const m of [w.page, ...w.styles, ...w.modules]) console.log(`  ${String(m.depth ?? '-').padStart(2)} ${(m.br / 1024).toFixed(1).padStart(7)} KiB  ${(m.raw / 1024).toFixed(1).padStart(7)} raw  ${m.file}`);
  if (w.dynamic.length) console.log(`  later (import()): ${w.dynamic.join(', ')}`);
}
