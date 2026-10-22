// The player's profile kept in OPFS (src/vfs/profile-opfs.js): a flush writes the new copies before it removes the old
// entries (a save moved by a manifest's profileMoves is never gone from both places), retries what failed; the
// harness's dump is null until the profile is complete, and a missing dump removes nothing from --profile-dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemBackend } from '../src/vfs/vfs.js';
import { applyProfileMoves } from '../src/vfs/profile-moves.js';
import { flushProfileOpfs, profileDumpOf, profileGone } from '../src/vfs/profile-opfs.js';

/** an OPFS directory in memory; `failWrites`: file names whose writes throw (a full disk, a worker killed meanwhile) */
class FakeDir {
  constructor(failWrites = new Set()) { this.entries = new Map(); this.failWrites = failWrites; }
  async getDirectoryHandle(name, { create } = {}) {
    let d = this.entries.get(name);
    if (!d) { if (!create) throw new Error('NotFoundError'); d = new FakeDir(this.failWrites); this.entries.set(name, d); }
    return d;
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.entries.has(name)) { if (!create) throw new Error('NotFoundError'); this.entries.set(name, { data: null }); }
    const f = this.entries.get(name), fail = this.failWrites;
    return { createWritable: async () => ({ write: async (d) => { if (fail.has(name)) throw new Error('QuotaExceededError'); f.next = new Uint8Array(d); }, close: async () => { f.data = f.next; } }) };
  }
  async removeEntry(name) { if (!this.entries.delete(name)) throw new Error('NotFoundError'); }
  /** every file path */
  files(prefix = '') { const out = []; for (const [n, e] of this.entries) { if (e instanceof FakeDir) out.push(...e.files(prefix + n + '/')); else if (e.data) out.push(prefix + n); } return out.sort(); }
}

const bytes = (s) => new TextEncoder().encode(s);
function profileWith(files) {
  const p = new MemBackend();
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) p.mkdir(parts.slice(0, i).join('/'));
    p.open(path, { create: true }).write(0, bytes(text));
  }
  return p;
}

test('a moved save is written at its new place before its old entry is removed; a failed write keeps both and is retried', async () => {
  const profile = profileWith({ 'AppData/Roaming/save1.sav': 'one', 'AppData/Roaming/Options.ini': 'opts' });
  const fail = new Set();
  const dir = new FakeDir(fail);
  await flushProfileOpfs(dir, profile, 0); // (the browser's copy as it was)
  assert.deepEqual(dir.files(), ['AppData/Roaming/Options.ini', 'AppData/Roaming/save1.sav']);
  // a manifest's move: everything of Roaming into the game's folder
  profile.changes = new Set();
  const { moved } = applyProfileMoves(profile, [{ from: 'AppData/Roaming', to: 'AppData/Roaming/Game Files' }]);
  assert.equal(moved.length, 2);
  fail.add('save1.sav');
  const r = await flushProfileOpfs(dir, profile, Date.now() + 1000);
  assert.equal(r.failed, 1);
  // the save's new copy failed: its old entry is still there (nothing removed until every write succeeded)
  assert.ok(dir.files().includes('AppData/Roaming/save1.sav'), dir.files().join(', '));
  assert.ok(dir.files().includes('AppData/Roaming/Game Files/Options.ini'));
  assert.ok(profile.changes.size > 0, 'what failed is kept for the next flush');
  // the next flush, the write working again: the new copy, then the old entries removed
  fail.clear();
  const r2 = await flushProfileOpfs(dir, profile, Date.now() + 1000);
  assert.equal(r2.failed, 0);
  assert.deepEqual(dir.files(), ['AppData/Roaming/Game Files/Options.ini', 'AppData/Roaming/Game Files/save1.sav']);
  assert.equal(profile.changes.size, 0);
});

test('the harness\'s profile dump: null until the profile is complete; no dump removes nothing', () => {
  const profile = profileWith({ 'Options.ini': 'x' });
  const list = (p) => [...p.files].map(([k, f]) => ({ path: k, data: f.data.subarray(0, f.len) }));
  const b64 = (d) => Buffer.from(d).toString('base64');
  assert.equal(profileDumpOf(null, false, list, b64), null);
  assert.equal(profileDumpOf(profile, false, list, b64), null, 'still loading');
  assert.deepEqual(profileDumpOf(profile, true, list, b64), [{ path: 'options.ini', data: b64(bytes('x')) }]);
  const loaded = ['Options.ini', 'Saves/one.sav'];
  assert.deepEqual(profileGone(loaded, null), [], 'not ready: the host folder kept whole');
  assert.deepEqual(profileGone(loaded, [{ path: 'options.ini' }]), ['Saves/one.sav']);
});
