// Page protections of a mapped image, as the Windows loader leaves them: headers read-only, each section by its
// characteristics (writable ones copy-on-write). Not enforced on accesses; VirtualQuery / IsBad*Ptr report them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GuestMemory } from '../src/cpu/memory.js';
import { VMem } from '../src/win32/vmem.js';
import { PeImage, mapImage } from '../src/loader/pe.js';

const EXE = new URL('../build/pe/threads.exe', import.meta.url).pathname;

test('mapped image: section protections from the characteristics, seen by query and isAccessible', { skip: !fs.existsSync(EXE) && 'build/pe not built (make tools)' }, () => {
  const img = new PeImage(new Uint8Array(fs.readFileSync(EXE)));
  const mem = new GuestMemory(), vmem = new VMem();
  const mod = mapImage(img, mem, vmem, { name: 'threads.exe', path: 'C:\\threads.exe' });
  assert.equal(vmem.query(mod.base).protect, 0x02, 'headers PAGE_READONLY');
  assert.equal(vmem.query(mod.base).allocProtect, 0x80);
  let seen = 0;
  for (const s of img.sections) {
    const c = s.characteristics >>> 0, a = mod.base + s.rva, q = vmem.query(a);
    const want = c & 0x20000000 ? (c & 0x80000000 ? 0x80 : 0x20) : c & 0x80000000 ? 0x08 : 0x02;
    assert.equal(q.protect, want, `${s.name} protection`);
    assert.equal(vmem.isAccessible(a, 4, false), true, `${s.name} readable`);
    assert.equal(vmem.isAccessible(a, 4, true), (c & 0x80000000) !== 0, `${s.name} writable`);
    seen |= (c & 0x20000000 ? 1 : 0) | (c & 0x80000000 ? 2 : 0);
  }
  assert.equal(seen & 3, 3, 'an executable and a writable section');
  // a code page made writable (the pattern of code patching: VirtualProtect, write, restore)
  const text = img.sections.find((s) => s.characteristics & 0x20000000);
  assert.equal(vmem.protect(mod.base + text.rva, 4, 0x40), 0x20);
  assert.equal(vmem.isAccessible(mod.base + text.rva, 4, true), true);
  assert.equal(vmem.isAccessible(mod.base + mod.size, 4, false), false, 'past the image');
});
