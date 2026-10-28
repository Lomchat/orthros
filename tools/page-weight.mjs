#!/usr/bin/env node
// What a page's first visit downloads before it can run, from its HTML: its stylesheets, scripts and their static
// import graph (no build step: each module is a request), with their bytes as the server sends them (brotli 11,
// server.js sendSource) and the depth of the graph (the round trips one after another before the last module
// arrives). The dynamic imports (import()) are listed apart: fetched later, when used.
//   node tools/page-weight.mjs [src/host/web/index.html ...] [--kbps 85] [--rtt 80] [--json]
// --kbps/--rtt: the time on such a link, as the browser fetches it (each level of the graph a round trip, its bytes
// the link's).
//   node tools/page-weight.mjs src/host/web/index.html --preload-html <out.html>
// writes the page with a <link rel="modulepreload"> for each module of levels 2 and deeper of its static graph (level 1
// is in the HTML already) before its first module script: a modulepreload trial's page (tools/home-check.mjs --warm
// against a server run from a copy of the tree carrying it).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { moduleGraph, withPreloads } from '../src/host/module-graph.js';

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
function weigh(html) {
  const file = path.resolve(ROOT, html), { level, css, dynamic: dyn } = moduleGraph(ROOT, file);
  const mods = [...level].filter(([f]) => fs.existsSync(f)).map(([f, d]) => ({ file: path.relative(ROOT, f), depth: d, ...wire(f) }));
  const styles = css.map((f) => ({ file: path.relative(ROOT, f), ...wire(f) }));
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
const preloadOut = arg('--preload-html', null);
if (preloadOut) {
  // (what the server sends as the home: server.js homePage — this writes it for another page, or a trial's copy)
  const p = Object.keys(out)[0], file = path.resolve(ROOT, p), g = moduleGraph(ROOT, file), page = withPreloads(ROOT, g.text, g.level);
  if (page === g.text) { console.error(`${p}: no module script, or nothing deeper than its first level`); process.exit(1); }
  fs.writeFileSync(preloadOut, page);
  console.error(`${preloadOut}: ${[...g.level.values()].filter((d) => d >= 2).length} modulepreload links`);
  process.exit(0);
}
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
else for (const [p, w] of Object.entries(out)) {
  console.log(`${p}: ${w.total.requests} requests, ${(w.total.raw / 1024).toFixed(0)} KiB raw, ${(w.total.wire / 1024).toFixed(1)} KiB on the wire, graph depth ${w.total.depth}; at ${kbps} KB/s, ${rtt} ms: ${w.total.seconds} s`);
  for (const m of [w.page, ...w.styles, ...w.modules]) console.log(`  ${String(m.depth ?? '-').padStart(2)} ${(m.br / 1024).toFixed(1).padStart(7)} KiB  ${(m.raw / 1024).toFixed(1).padStart(7)} raw  ${m.file}`);
  if (w.dynamic.length) console.log(`  later (import()): ${w.dynamic.join(', ')}`);
}
