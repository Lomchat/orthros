// A page's static module graph, read from its HTML (no build step: each module a request, each level of imports a round
// trip once the level before has arrived): tools/page-weight.mjs weighs it, the server tells the home's browser its
// deeper levels up front (homePreloads: <link rel="modulepreload">, all asked at once). Node only.
import fs from 'node:fs';
import path from 'node:path';

/** The file a page's URL `url` names, seen from `from` (null: another origin, data:, blob:). `root`: the server's root. */
export const urlFile = (root, url, from) => {
  if (/^(https?:|data:|blob:)/.test(url)) return null;
  const p = url.split(/[?#]/)[0];
  return p.startsWith('/') ? path.join(root, p) : path.resolve(path.dirname(from), p);
};
/** a module's static imports: `import ... from '...'`, `import '...'`, `export ... from '...'` (comments aside, roughly) */
export const staticImports = (src) => {
  const out = new Set(), code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g)) out.add(m[1]);
  return [...out];
};
/** a module's dynamic imports of a literal (fetched later, when used) */
export const dynamicImports = (src) => [...new Set([...src.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]))];

/**
 * The graph of the HTML page `file` (absolute) under `root`: { text (the page), css: [files], level: Map(file -> depth,
 * 1: named by the page), dynamic: Set(files) } — modules that do not exist out of `level`.
 */
export function moduleGraph(root, file) {
  const text = fs.readFileSync(file, 'utf8');
  const level = new Map(), css = [], dynamic = new Set();
  for (const m of text.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)) { const f = urlFile(root, m[1], file); if (f) css.push(f); }
  for (const m of text.matchAll(/<link[^>]+href="([^"]+)"[^>]*rel="stylesheet"/g)) { const f = urlFile(root, m[1], file); if (f && !css.includes(f)) css.push(f); }
  const roots = [];
  for (const m of text.matchAll(/<script[^>]+src="([^"]+)"/g)) { const f = urlFile(root, m[1], file); if (f) roots.push(f); }
  // (inline module scripts' imports)
  for (const m of text.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)) for (const s of staticImports(m[1])) { const f = urlFile(root, s, file); if (f) roots.push(f); }
  const queue = roots.map((f) => [f, 1]);
  while (queue.length) {
    const [f, d] = queue.shift();
    if (level.has(f) && level.get(f) <= d) continue;
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    level.set(f, d);
    for (const s of staticImports(src)) { const g = urlFile(root, s, f); if (g) queue.push([g, d + 1]); }
    for (const s of dynamicImports(src)) { const g = urlFile(root, s, f); if (g) dynamic.add(g); }
  }
  return { text, css: css.filter((f) => fs.existsSync(f)), level, dynamic };
}

/**
 * The page `text` with a <link rel="modulepreload"> for each module of `graph` (moduleGraph's `level`) at depth 2 or
 * more — level 1 is named by the page already —, the shallowest first, before its first module script (the page as it
 * is when it has none).
 */
export function withPreloads(root, text, level) {
  const deep = [...level].filter(([, d]) => d >= 2).sort((a, b) => a[1] - b[1]);
  const tags = deep.map(([f]) => `<link rel="modulepreload" href="/${path.relative(root, f).split(path.sep).join('/')}">`).join('\n');
  return tags && /<script type="module"/.test(text) ? text.replace(/<script type="module"/, `${tags}\n<script type="module"`) : text;
}
