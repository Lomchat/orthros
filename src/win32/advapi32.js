// advapi32.dll: registry (backed by Registry), user/token/security stubs, crypto stubs.
import { E } from './errors.js';
import { Registry, HKEY, REG, encodeSz, encodeSzW } from './registry.js';

const ERROR_SUCCESS = 0, ERROR_FILE_NOT_FOUND = 2, ERROR_MORE_DATA = 234, ERROR_NO_MORE_ITEMS = 259, ERROR_INVALID_HANDLE = 6;

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerAdvapi32(api, vm) {
  const mem = vm.mem;
  const A = {};
  const reg = (c) => c.proc.registry ?? (c.proc.registry = vm.registry ?? (vm.registry = new Registry()));
  const keyPath = (c, h) => {
    const root = Registry.rootName(h);
    if (root) return root;
    const o = c.proc.handles.getAs(h, 'regkey');
    return o ? o.path : null;
  };
  const openKey = (c, h, sub, create, outIdx, dispIdx = -1) => {
    const base = keyPath(c, h);
    if (base === null) return ERROR_INVALID_HANDLE;
    const path = sub ? base + '\\' + sub : base;
    const r = reg(c);
    let disp = 2; // REG_OPENED_EXISTING_KEY
    if (!r.hasKey(path)) {
      if (!create) { vm.log('reg', `open ${path} -> not found`); return ERROR_FILE_NOT_FOUND; }
      r.createKey(path); disp = 1;
    }
    vm.log('reg', `${create ? 'create' : 'open'} ${path}`);
    const hk = c.proc.handles.create({ type: 'regkey', path: r.names.get(r.norm(path)) ?? path });
    mem.write32(c.arg(outIdx), hk);
    if (dispIdx >= 0 && c.arg(dispIdx)) mem.write32(c.arg(dispIdx), disp);
    return ERROR_SUCCESS;
  };
  A.RegOpenKeyA = [3, (c) => openKey(c, c.arg(0), c.str(1), false, 2)];
  A.RegOpenKeyW = [3, (c) => openKey(c, c.arg(0), c.wstr(1), false, 2)];
  A.RegOpenKeyExA = [5, (c) => openKey(c, c.arg(0), c.str(1), false, 4)];
  A.RegOpenKeyExW = [5, (c) => openKey(c, c.arg(0), c.wstr(1), false, 4)];
  A.RegCreateKeyA = [3, (c) => openKey(c, c.arg(0), c.str(1), true, 2)];
  A.RegCreateKeyW = [3, (c) => openKey(c, c.arg(0), c.wstr(1), true, 2)];
  A.RegCreateKeyExA = [9, (c) => openKey(c, c.arg(0), c.str(1), true, 7, 8)];
  A.RegCreateKeyExW = [9, (c) => openKey(c, c.arg(0), c.wstr(1), true, 7, 8)];
  A.RegCloseKey = [1, (c) => { if (!Registry.rootName(c.arg(0))) c.proc.handles.map.delete(c.arg(0)); return ERROR_SUCCESS; }];
  A.RegFlushKey = [1, () => ERROR_SUCCESS];
  A.RegDeleteKeyA = [2, (c) => { const base = keyPath(c, c.arg(0)); if (base === null) return ERROR_INVALID_HANDLE; return reg(c).deleteKey(base + '\\' + (c.str(1) ?? '')) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND; }];
  A.RegDeleteKeyW = [2, (c) => { const base = keyPath(c, c.arg(0)); if (base === null) return ERROR_INVALID_HANDLE; return reg(c).deleteKey(base + '\\' + (c.wstr(1) ?? '')) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND; }];
  A.RegDeleteValueA = [2, (c) => { const p = keyPath(c, c.arg(0)); if (p === null) return ERROR_INVALID_HANDLE; return reg(c).deleteValue(p, c.str(1) ?? '') ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND; }];
  A.RegDeleteValueW = [2, (c) => { const p = keyPath(c, c.arg(0)); if (p === null) return ERROR_INVALID_HANDLE; return reg(c).deleteValue(p, c.wstr(1) ?? '') ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND; }];
  const queryValue = (c, h, name, typeIdx, dataIdx, sizeIdx, wide) => {
    const p = keyPath(c, h);
    if (p === null) return ERROR_INVALID_HANDLE;
    const v = reg(c).getValue(p, name ?? '');
    if (!v) { vm.log('reg', `query ${p}\\${name} -> not found`); return ERROR_FILE_NOT_FOUND; }
    let data = v.data;
    if (wide && (v.type === REG.SZ || v.type === REG.EXPAND_SZ || v.type === REG.MULTI_SZ)) { let s = ''; for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]); data = encodeSzW(s.replace(/\0$/, '')); }
    if (typeIdx >= 0 && c.arg(typeIdx)) mem.write32(c.arg(typeIdx), v.type);
    const sizePtr = c.arg(sizeIdx);
    const dataPtr = dataIdx >= 0 ? c.arg(dataIdx) : 0;
    if (!sizePtr) return ERROR_SUCCESS;
    const cap = mem.read32(sizePtr);
    mem.write32(sizePtr, data.length);
    if (!dataPtr) return ERROR_SUCCESS;
    if (cap < data.length) return ERROR_MORE_DATA;
    mem.writeBytes(dataPtr, data);
    vm.log('reg', `query ${p}\\${name} -> ${v.type === REG.DWORD ? new DataView(v.data.buffer, v.data.byteOffset).getUint32(0, true) : JSON.stringify(String.fromCharCode(...v.data.subarray(0, 60)))}`);
    return ERROR_SUCCESS;
  };
  A.RegQueryValueExA = [6, (c) => queryValue(c, c.arg(0), c.str(1), 3, 4, 5, false)];
  A.RegQueryValueExW = [6, (c) => queryValue(c, c.arg(0), c.wstr(1), 3, 4, 5, true)];
  A.RegQueryValueA = [4, (c) => { const p = keyPath(c, c.arg(0)); if (p === null) return ERROR_INVALID_HANDLE; const sub = c.str(1); const v = reg(c).getValue(sub ? p + '\\' + sub : p, ''); const data = v ? v.data : encodeSz(''); const sizePtr = c.arg(3); const cap = mem.read32(sizePtr); mem.write32(sizePtr, data.length); if (c.arg(2)) { if (cap < data.length) return ERROR_MORE_DATA; mem.writeBytes(c.arg(2), data); } return ERROR_SUCCESS; }];
  const setValue = (c, h, name, type, dataPtr, size, wide) => {
    const p = keyPath(c, h);
    if (p === null) return ERROR_INVALID_HANDLE;
    let data = mem.bytes(dataPtr, size).slice();
    if (wide && (type === REG.SZ || type === REG.EXPAND_SZ)) data = encodeSz(mem.readWString(dataPtr, size / 2));
    reg(c).setValue(p, name ?? '', type, data);
    vm.log('reg', `set ${p}\\${name} type ${type}`);
    return ERROR_SUCCESS;
  };
  A.RegSetValueExA = [6, (c) => setValue(c, c.arg(0), c.str(1), c.arg(3), c.arg(4), c.arg(5), false)];
  A.RegSetValueExW = [6, (c) => setValue(c, c.arg(0), c.wstr(1), c.arg(3), c.arg(4), c.arg(5), true)];
  A.RegSetValueA = [5, (c) => { const p = keyPath(c, c.arg(0)); if (p === null) return ERROR_INVALID_HANDLE; const sub = c.str(1); reg(c).setValue(sub ? p + '\\' + sub : p, '', REG.SZ, encodeSz(mem.readCString(c.arg(3)))); return ERROR_SUCCESS; }];
  A.RegEnumKeyExA = [8, (c) => { const p = keyPath(c, c.arg(0)); if (p === null) return ERROR_INVALID_HANDLE; const subs = reg(c).subkeys(p); const i = c.arg(1); if (i >= subs.length) return ERROR_NO_MORE_ITEMS; const s = subs[i]; const cap = mem.read32(c.arg(3)); if (cap <= s.length) return ERROR_MORE_DATA; mem.writeCString(c.arg(2), s); mem.write32(c.arg(3), s.length); return ERROR_SUCCESS; }];
  A.RegEnumKeyA = [4, (c) => { const p = keyPath(c, c.arg(0)); if (p === null) return ERROR_INVALID_HANDLE; const subs = reg(c).subkeys(p); const i = c.arg(1); if (i >= subs.length) return ERROR_NO_MORE_ITEMS; mem.writeCString(c.arg(2), subs[i], c.arg(3)); return ERROR_SUCCESS; }];
  A.RegEnumValueA = [8, (c) => {
    const p = keyPath(c, c.arg(0)); if (p === null) return ERROR_INVALID_HANDLE;
    const vals = [...(reg(c).values(p) ?? new Map()).values()]; const i = c.arg(1);
    if (i >= vals.length) return ERROR_NO_MORE_ITEMS;
    const v = vals[i]; const cap = mem.read32(c.arg(3)); if (cap <= v.name.length) return ERROR_MORE_DATA;
    mem.writeCString(c.arg(2), v.name); mem.write32(c.arg(3), v.name.length);
    if (c.arg(5)) mem.write32(c.arg(5), v.type);
    if (c.arg(7)) { const dcap = mem.read32(c.arg(7)); mem.write32(c.arg(7), v.data.length); if (c.arg(6)) { if (dcap < v.data.length) return ERROR_MORE_DATA; mem.writeBytes(c.arg(6), v.data); } }
    return ERROR_SUCCESS;
  }];
  A.RegQueryInfoKeyA = [12, (c) => { const p = keyPath(c, c.arg(0)); if (p === null) return ERROR_INVALID_HANDLE; const subs = reg(c).subkeys(p), vals = reg(c).values(p) ?? new Map(); if (c.arg(3)) mem.write32(c.arg(3), subs.length); if (c.arg(4)) mem.write32(c.arg(4), Math.max(0, ...subs.map((s) => s.length))); if (c.arg(5)) mem.write32(c.arg(5), 0); if (c.arg(6)) mem.write32(c.arg(6), vals.size); if (c.arg(7)) mem.write32(c.arg(7), Math.max(0, ...[...vals.values()].map((v) => v.name.length))); if (c.arg(8)) mem.write32(c.arg(8), Math.max(0, ...[...vals.values()].map((v) => v.data.length))); return ERROR_SUCCESS; }];
  A.RegQueryInfoKeyW = A.RegQueryInfoKeyA;
  A.RegNotifyChangeKeyValue = [5, () => ERROR_SUCCESS];
  A.RegConnectRegistryA = [3, (c) => { mem.write32(c.arg(2), c.arg(1)); return ERROR_SUCCESS; }];
  A.RegOpenCurrentUser = [2, (c) => { mem.write32(c.arg(1), HKEY.CURRENT_USER); return ERROR_SUCCESS; }];
  A.RegSaveKeyA = [3, () => ERROR_SUCCESS]; A.RegRestoreKeyA = [3, () => ERROR_SUCCESS];

  // ---- users / tokens / security (single fake user with all privileges)
  A.GetUserNameA = [2, (c) => { const s = 'Player'; const cap = mem.read32(c.arg(1)); mem.write32(c.arg(1), s.length + 1); if (cap <= s.length) return c.fail(E.INSUFFICIENT_BUFFER); mem.writeCString(c.arg(0), s); return 1; }];
  A.GetUserNameW = [2, (c) => { const s = 'Player'; const cap = mem.read32(c.arg(1)); mem.write32(c.arg(1), s.length + 1); if (cap <= s.length) return c.fail(E.INSUFFICIENT_BUFFER); mem.writeWString(c.arg(0), s); return 1; }];
  A.OpenProcessToken = [3, (c) => { mem.write32(c.arg(2), c.proc.handles.create({ type: 'token' })); return 1; }];
  A.OpenThreadToken = [4, (c) => c.fail(1008)];
  A.GetTokenInformation = [5, (c) => { const cls = c.arg(1); const p = c.arg(2), cap = c.arg(3); if (cls === 1 || cls === 4) { const need = 12; c.out32(4, need); if (cap < need) return c.fail(E.INSUFFICIENT_BUFFER); mem.write32(p, p + 8); mem.write32(p + 4, 0); mem.fill(p + 8, 4, 0); return 1; } if (cls === 20) { c.out32(4, 4); if (cap < 4) return c.fail(E.INSUFFICIENT_BUFFER); mem.write32(p, 2); return 1; } c.out32(4, 0); return c.fail(E.NOT_SUPPORTED); }];
  A.AdjustTokenPrivileges = [6, (c) => { if (c.arg(5)) mem.write32(c.arg(5), 0); return 1; }];
  A.LookupPrivilegeValueA = [3, (c) => { mem.write32(c.arg(2), 20); mem.write32(c.arg(2) + 4, 0); return 1; }];
  A.LookupPrivilegeValueW = A.LookupPrivilegeValueA;
  A.LookupAccountNameA = [7, () => 0];
  A.LookupAccountSidA = [7, () => 0];
  A.GetSecurityDescriptorDacl = [4, () => 1];
  A.InitializeSecurityDescriptor = [2, () => 1];
  A.SetSecurityDescriptorDacl = [4, () => 1];
  A.SetFileSecurityA = [3, () => 1];
  A.GetFileSecurityA = [5, (c) => { c.out32(4, 0); return c.fail(E.NOT_SUPPORTED); }];
  A.AllocateAndInitializeSid = [11, (c) => { const p = c.proc.processHeap.alloc(12, true); mem.write32(c.arg(10), p); return 1; }];
  A.FreeSid = [1, () => 0];
  A.IsValidSid = [1, () => 1];
  A.EqualSid = [2, () => 1];
  A.CheckTokenMembership = [3, (c) => { mem.write32(c.arg(2), 1); return 1; }];
  A.DuplicateToken = [3, (c) => { mem.write32(c.arg(2), c.proc.handles.create({ type: 'token' })); return 1; }];
  A.ImpersonateLoggedOnUser = [1, () => 1];
  A.RevertToSelf = [0, () => 1];
  A.ConvertStringSecurityDescriptorToSecurityDescriptorA = [4, (c) => { mem.write32(c.arg(2), c.proc.processHeap.alloc(20, true)); return 1; }];
  A.CryptAcquireContextA = [5, (c) => { mem.write32(c.arg(0), c.proc.handles.create({ type: 'crypt' })); return 1; }];
  A.CryptAcquireContextW = A.CryptAcquireContextA;
  A.CryptReleaseContext = [2, () => 1];
  A.CryptGenRandom = [3, (c) => { const n = c.arg(1), p = c.arg(2); for (let i = 0; i < n; i++) mem.write8(p + i, (Math.random() * 256) | 0); return 1; }];
  A.CryptCreateHash = [5, (c) => { mem.write32(c.arg(4), c.proc.handles.create({ type: 'hash', data: [] })); return 1; }];
  A.CryptHashData = [4, (c) => { const h = c.proc.handles.getAs(c.arg(0), 'hash'); if (h) h.data.push(...mem.bytes(c.arg(1), c.arg(2))); return 1; }];
  A.CryptGetHashParam = [5, (c) => { if (c.arg(1) === 2) { const p = c.arg(2); if (p) { mem.fill(p, 16, 0); let x = 0x811c9dc5; const h = c.proc.handles.getAs(c.arg(0), 'hash'); for (const b of h?.data ?? []) x = Math.imul(x ^ b, 16777619); mem.write32(p, x >>> 0); } mem.write32(c.arg(3), 16); return 1; } if (c.arg(1) === 4) { mem.write32(c.arg(2), 16); mem.write32(c.arg(3), 4); return 1; } return 0; }];
  A.CryptDestroyHash = [1, () => 1];
  A.CryptDestroyKey = [1, () => 1];
  A.CryptImportKey = [6, () => 0]; A.CryptEncrypt = [7, () => 0]; A.CryptDecrypt = [6, () => 0]; A.CryptDeriveKey = [5, () => 0];
  A.RegisterEventSourceA = [2, (c) => c.proc.handles.create({ type: 'eventlog' })];
  A.DeregisterEventSource = [1, () => 1];
  A.ReportEventA = [9, () => 1];
  A.OpenSCManagerA = [3, () => c => 0];
  A.OpenSCManagerA = [3, (c) => c.fail(5)];
  A.OpenServiceA = [3, (c) => c.fail(5)];
  A.CloseServiceHandle = [1, () => 1];
  A.QueryServiceStatus = [2, () => 0];
  A.StartServiceA = [3, () => 0];
  A.ControlService = [3, () => 0];
  A.IsTextUnicode = [3, () => 0];
  A.GetCurrentHwProfileA = [1, (c) => { const p = c.arg(0); mem.write32(p, 4); mem.write32(p + 4, 0); mem.writeCString(p + 8, '{00000000-0000-0000-0000-000000000000}'); mem.writeCString(p + 47, 'Orthros'); return 1; }];
  A.SystemFunction036 = [2, (c) => { for (let i = 0; i < c.arg(1); i++) mem.write8(c.arg(0) + i, (Math.random() * 256) | 0); return 1; }];

  api.define('advapi32.dll', A);
}
