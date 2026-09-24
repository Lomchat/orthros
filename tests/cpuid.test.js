// The virtual processor describes itself the same way everywhere software looks: CPUID (vendor, extended leaves,
// brand string) and the registry (VendorIdentifier, ProcessorNameString, ~MHz, the RDTSC rate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCpuid } from '../src/cpu/interp.js';
import { CPU_MHZ, CPU_BRAND } from '../src/cpu/state.js';
import { Registry } from '../src/win32/registry.js';

const str = (regs) => regs.map((r) => String.fromCharCode(r & 0xff, (r >>> 8) & 0xff, (r >>> 16) & 0xff, r >>> 24)).join('');

test('CPUID: vendor, extended leaves and brand string agree with the registry', () => {
  const [max, b, c, d] = defaultCpuid(0, 0);
  assert.ok(max >= 1);
  assert.equal(str([b, d, c]), 'GenuineIntel');
  const maxExt = defaultCpuid(0x80000000, 0)[0] >>> 0;
  assert.ok(maxExt >= 0x80000004, 'brand string leaves present');
  const brand = str([0x80000002, 0x80000003, 0x80000004].flatMap((l) => defaultCpuid(l, 0))).replace(/\0+$/, '');
  assert.equal(brand, CPU_BRAND);
  assert.ok(brand.length <= 47, 'NUL-terminated within 48 bytes');
  assert.equal(defaultCpuid(0x80000001, 0)[3] & (1 << 29), 0, 'no long mode');
  const reg = new Registry();
  const cpu0 = 'HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0';
  const sz = (v) => String.fromCharCode(...v.data).replace(/\0+$/, ''); // (stored as ANSI bytes)
  assert.equal(sz(reg.getValue(cpu0, 'ProcessorNameString')), brand);
  assert.equal(sz(reg.getValue(cpu0, 'VendorIdentifier')), 'GenuineIntel');
  assert.equal(new DataView(reg.getValue(cpu0, '~MHz').data.buffer).getUint32(0, true), CPU_MHZ);
  assert.match(brand, new RegExp(`@ ${(CPU_MHZ / 1000).toFixed(2)}GHz$`));
});
