#!/usr/bin/env node
// The relocations and fingerprints of src/cpu/jit/libkernels.js definitions, from a DLL: the DLL is mapped at its
// preferred base, each definition of its name (`msvcr71!floor` for msvcr71.dll) is looked up by export name — here
// only, to write the table: Orthros recognises the code by its content — and its ranges' absolute addresses (the DLL's
// base relocations falling in them) and fingerprint are printed, with whether they match the table's.
// Usage: node tools/gen/libkernel-sigs.mjs <dll>
import fs from 'node:fs';
import path from 'node:path';
import { GuestMemory } from '../../src/cpu/memory.js';
import { PeImage, mapImage, PE_DIR } from '../../src/loader/pe.js';
import { LIB_KERNELS, libFingerprint, libQuick } from '../../src/cpu/jit/libkernels.js';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/gen/libkernel-sigs.mjs <dll>'); process.exit(2); }
const img = new PeImage(new Uint8Array(fs.readFileSync(file)));
const mem = new GuestMemory();
const vmem = { isFree: () => true, reserve: (size, base) => base, commit() {}, protect() {} };
const mod = mapImage(img, mem, vmem, { name: path.basename(file), path: file });
// every relocated address (type 3, HIGHLOW) of the image
const relocs = [];
{
  const dir = img.dirs[PE_DIR.BASERELOC];
  for (let p = mod.base + dir.rva, end = p + dir.size; p + 8 <= end;) {
    const page = mem.read32(p), size = mem.read32(p + 4);
    if (size < 8) break;
    for (let i = 0; i < (size - 8) >> 1; i++) { const e = mem.read16(p + 8 + 2 * i); if (e >> 12 === 3) relocs.push(mod.base + page + (e & 0xfff)); }
    p += size;
  }
}
const dll = path.basename(file).toLowerCase().replace(/\.dll$/, '');
for (const d of LIB_KERNELS) {
  const [lib, fn] = d.name.split('!');
  if (lib !== dll) continue;
  const entry = mod.exports.get(fn);
  if (entry === undefined) { console.log(`${d.name}: no such export`); continue; }
  const rel = relocs.filter((a) => d.ranges.some(([o, n]) => a >= entry + o && a + 4 <= entry + o + n)).map((a) => a - entry).sort((x, y) => x - y);
  const h = libFingerprint(mem.u8, entry, { ...d, relocs: rel }), q = libQuick(mem.u8, entry, { ...d, relocs: rel });
  const same = JSON.stringify(rel) === JSON.stringify(d.relocs) && h[0] === d.hash[0] && h[1] === d.hash[1] && q === d.quick;
  console.log(`${d.name}: entry 0x${entry.toString(16)}${entry !== d.ref ? ` (table: 0x${d.ref.toString(16)})` : ''} first 0x${mem.u8[entry].toString(16)} relocs: [${rel.map((x) => '0x' + x.toString(16)).join(', ')}], hash: [0x${h[0].toString(16)}, 0x${h[1].toString(16)}], quick: 0x${q.toString(16)}${same ? ' (as in the table)' : ' (table differs)'}`);
}
