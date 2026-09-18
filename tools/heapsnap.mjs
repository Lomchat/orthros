// Summarize a V8 heap snapshot: live bytes by node type/name (top N), plus the most common
// retainer edges into the biggest category. Scans the file as a Buffer (snapshots exceed the
// maximum JS string length). Usage: node --max-old-space-size=16000 tools/heapsnap.mjs <file.heapsnapshot> [topN]
import fs from 'node:fs';

const file = process.argv[2], top = Number(process.argv[3] || 25);
const buf = fs.readFileSync(file);
const idx = (s, from = 0) => buf.indexOf(s, from, 'latin1');
const iNodes = idx('"nodes":['), iEdges = idx('"edges":['), iStrings = idx('"strings":[');
const meta = JSON.parse(buf.toString('latin1', 0, iNodes).replace(/,\s*$/, '') + '}').snapshot.meta;

/** parse a JSON array of integers starting right after '[' at position p; returns Int32Array/Float64Array */
function ints(p) {
  const out = [];
  let v = 0, inNum = false;
  for (let i = p; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); inNum = true; }
    else if (c === 44) { if (inNum) out.push(v); v = 0; inNum = false; }
    else if (c === 93) { if (inNum) out.push(v); break; }
  }
  return out;
}
const nodes = ints(iNodes + 9), edges = ints(iEdges + 9);
const strings = JSON.parse(buf.toString('utf8', iStrings + 10, buf.lastIndexOf(']') + 1));

const nf = meta.node_fields, ef = meta.edge_fields;
const nTypes = meta.node_types[0], eTypes = meta.edge_types[0];
const N = nf.length, E = ef.length;
const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iSize = nf.indexOf('self_size'), iEdgeCount = nf.indexOf('edge_count');
const eiType = ef.indexOf('type'), eiName = ef.indexOf('name_or_index'), eiTo = ef.indexOf('to_node');
const count = nodes.length / N;
const short = (s) => (s.length > 70 ? s.slice(0, 70) + '…' : s);
const keyOf = (i) => { const b = i * N; return `${nTypes[nodes[b + iType]]}: ${short(strings[nodes[b + iName]])}`; };
const byName = new Map();
let total = 0;
for (let i = 0; i < count; i++) {
  const b = i * N, size = nodes[b + iSize];
  total += size;
  const key = keyOf(i);
  const e = byName.get(key) ?? { size: 0, n: 0 };
  e.size += size; e.n++;
  byName.set(key, e);
}
console.log(`nodes ${count}, edges ${edges.length / E}, total self size ${(total / 1048576).toFixed(0)} MB`);
const sorted = [...byName].sort((a, b) => b[1].size - a[1].size).slice(0, top);
for (const [k, v] of sorted) console.log(`${(v.size / 1048576).toFixed(1).padStart(8)} MB ${String(v.n).padStart(9)} ${k}`);

for (const target of (process.argv[4] ? [process.argv[4]] : sorted.slice(0, 3).map((x) => x[0]))) {
  const inCat = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (keyOf(i) === target) inCat[i] = 1;
  const ret = new Map();
  let ei = 0;
  for (let i = 0; i < count; i++) {
    const b = i * N, ne = nodes[b + iEdgeCount];
    const fromName = keyOf(i);
    for (let k = 0; k < ne; k++, ei += E) {
      const to = edges[ei + eiTo] / N;
      if (!inCat[to]) continue;
      const et = eTypes[edges[ei + eiType]];
      const en = et === 'element' || et === 'hidden' ? `[${edges[ei + eiName]}]` : strings[edges[ei + eiName]];
      const key = `${fromName} --${et}:${String(en).slice(0, 40)}-->`;
      ret.set(key, (ret.get(key) ?? 0) + 1);
    }
  }
  console.log(`\nretainers of "${target}":`);
  for (const [k, v] of [...ret].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${String(v).padStart(9)} ${k}`);
}
