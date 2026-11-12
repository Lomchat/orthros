// vista.exe (tools/pe/vista.c): kernel32's Vista+ functions (SRW locks, condition variables, one-time initialization,
// SLists, Encode/DecodePointer, vectored handlers, the *Ex creation functions), imports through API set names, and an
// unimplemented import without a signature stopping its thread — under both executors. The values are Windows' (the
// lock and INIT_ONCE words in their documented layouts, ERROR_TIMEOUT, STATUS_ENTRYPOINT_NOT_FOUND).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/server/display.js';

const EXE = new URL('../build/pe/vista.exe', import.meta.url).pathname;

const EXPECTED = {
  srw_violations: 0, srw_readers_together: 1, srw_free: 0, srw_shared2_word: 0x21, srw_try_exclusive_while_shared: 0,
  srw_try_exclusive: 1, srw_exclusive_word: 1, srw_try_shared_while_exclusive: 0, srw_try_shared_writer_waiting: 0, srw2_free: 0,
  cv_consumed: 50, cv_timeout_result: 0, cv_timeout_error: 1460, cv_timeout_waited: 1, cv_timeout_cs_held: 1,
  cv_wake_one: 1, cv_wake_all: 2, srw4_free: 0, cv_srw_woken: 3,
  once_calls: 1, once_ctx_same: 1, once_word: 0x12342, once_fail_first: 0, once_fail_word: 0, once_fail_retry: 1,
  once_check_only: 0, once_begin: 1, once_begin_pending: 1, once_complete: 1, once_begin_done: 1, once_done_pending: 0, once_done_ctx: 0x400,
  slist_depth: 3, slist_pop_lifo: 1, slist_depth_after_pop: 2, slist_flush_chain: 1, slist_depth_flushed: 0, slist_pop_empty: 0,
  encode_roundtrip: 1, encode_changes: 1, encode_null_roundtrip: 1,
  veh_order_BA: 1, veh_code_ok: 1, veh_continue_handlers: 1, veh_remove: 2, veh_remove_again: 0,
  event_ex_manual: 1, mutex_ex_owned: 0x102, critsec_ex: 1,
  apiset_tick64: 1, apiset_family: 1, apiset_loadlibrary: 1, apiset_getprocaddress: 1, apiset_getmodulehandle: 1,
  unknown_import_thread_exit: 0xc0000139,
};

test('vista.exe: Vista+ kernel32 synchronization, vectored handlers, API sets, an unknown import stopping its thread', { skip: !fs.existsSync(EXE) && 'build/pe/vista.exe missing (make pe-tests)' }, () => {
  for (const jit of [true, false]) {
    const vfs = new Vfs(), dir = new MemBackend();
    vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
    dir.open('vista.exe', { create: true }).write(0, fs.readFileSync(EXE));
    const clock = new VirtualClock();
    const warnings = [];
    const vm = new Vm({ vfs, clock, host: new HeadlessHost({ clock, width: 320, height: 200 }), jit, logKinds: ['warn', 'crash'], log: (k, m) => warnings.push(`[${k}] ${m}`) });
    vm.createProcess({ exePath: 'C:\\Test\\vista.exe' });
    const code = vm.run();
    const got = Object.fromEntries(vm.stdout.join('').trim().split('\n').map((l) => l.split('=')).map(([k, v]) => [k, Number(v)]));
    assert.deepEqual(got, EXPECTED, `executor jit=${jit}`);
    assert.equal(code, 0);
    assert.ok(warnings.some((w) => w.includes('unimplemented import kernel32.dll!OrthrosNoSuchFunction') && w.includes('stopped')), 'the stop is reported with the import named');
  }
});

test('compatibility scan of vista.exe: API set imports resolved (host, family), the unimplemented import classified', { skip: !fs.existsSync(EXE) && 'build/pe/vista.exe missing (make pe-tests)' }, async () => {
  const { scanGame } = await import('../src/server/compat-scan.js');
  const r = scanGame({ name: 'vista', layers: [new URL('../build/pe/', import.meta.url).pathname], exe: 'vista.exe', only: 'vista.exe' });
  const p = r.programs.find((x) => x.file === 'vista.exe');
  assert.equal(p.role, 'main');
  assert.equal(p.format, 'PE32 x86');
  assert.ok(p.modules.includes('api-ms-win-core-sysinfo-l1-2-0.dll -> kernel32.dll'), p.modules.join(', '));
  assert.deepEqual(p.unimplemented.map((u) => `${u.dll}!${u.fn}:${u.signature}`), ['kernel32.dll!OrthrosNoSuchFunction:false'], 'OpenProcessToken found through the API set family (advapi32)');
  assert.match(p.verdict, /^partial: 1 imported function\(s\) not implemented, unknown signature/);
});
