// The saves on the player's Orthros account (src/host/web/cloud-sync.js): what is decided before a game starts, what is
// sent, and that nothing is overwritten without the player's choice — against a fake account API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decide, CloudSave, encodeProfile } from '../src/host/web/cloud-sync.js';

test('decide: restore, send, compare or ask, from what this device knows', () => {
  const known = { parent: 'A', local: 'L' };
  assert.equal(decide({ known: null, remoteHash: null, localEmpty: true, localUnchanged: false }), 'none');
  assert.equal(decide({ known: null, remoteHash: null, localEmpty: false, localUnchanged: false }), 'push', 'a first copy');
  assert.equal(decide({ known, remoteHash: 'A', localEmpty: false, localUnchanged: true }), 'same');
  assert.equal(decide({ known, remoteHash: 'A', localEmpty: false, localUnchanged: false }), 'push', 'played here since');
  assert.equal(decide({ known, remoteHash: 'B', localEmpty: false, localUnchanged: true }), 'restore', 'played elsewhere since');
  assert.equal(decide({ known, remoteHash: 'B', localEmpty: false, localUnchanged: false }), 'conflict', 'played on both');
  assert.equal(decide({ known: null, remoteHash: 'B', localEmpty: true, localUnchanged: false }), 'restore', 'a new device');
  assert.equal(decide({ known: null, remoteHash: 'B', localEmpty: false, localUnchanged: false }), 'compare', 'played here signed out');
});

/** The account's API for one game (PUT with the parent check, GET of the latest), a browser's storage, a profile. */
function world(remoteFiles = null) {
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  let head = null, puts = 0;
  if (remoteFiles) { const gz = gzipSync(Buffer.from(encodeProfile('g', remoteFiles))); head = { gz, hash: sha(gz) }; }
  const fetchImpl = async (url, o = {}) => {
    if (o.method === 'PUT') {
      const parent = o.headers['X-Orthros-Parent-Hash'], actual = head?.hash ?? 'none';
      if (parent !== actual) return new Response(JSON.stringify({ error: 'Une autre sauvegarde existe en ligne.', remoteHash: actual }), { status: 409 });
      const gz = Buffer.from(o.body); head = { gz, hash: sha(gz) }; puts++;
      return new Response(JSON.stringify({ hash: head.hash, version: puts }), { status: 201 });
    }
    return head ? new Response(head.gz, { headers: { 'X-Orthros-Backup-Hash': head.hash } }) : new Response('{}', { status: 404 });
  };
  const store = new Map(), storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const device = { files: [] };
  const save = (user = 'ana') => new CloudSave({ game: 'g', user, storage, fetchImpl, read: async () => device.files.map((f) => ({ ...f })), write: async (files) => { device.files = files; } });
  return { save, device, store, get head() { return head; }, get puts() { return puts; }, remote: () => JSON.parse(gunzipSync(head.gz)).files.map((f) => f.path) };
}
const file = (path, ...bytes) => ({ path, data: new Uint8Array(bytes) });

test('CloudSave: a new device gets the account\'s saves before the game starts, then sends only changes', async () => {
  const w = world([file('save/a.sav', 1, 2)]);
  const c = w.save();
  assert.equal(await c.pull(), 'restore');
  assert.deepEqual(w.device.files.map((f) => f.path), ['save/a.sav']);
  assert.equal((await c.push()).state, 'saved'); assert.equal(w.puts, 0, 'nothing new: nothing sent');
  w.device.files.push(file('save/b.sav', 3));
  const st = await c.push();
  assert.equal(st.state, 'saved'); assert.equal(st.version, 1); assert.deepEqual(w.remote(), ['save/a.sav', 'save/b.sav']);
});

test('CloudSave: played on two devices — a conflict, settled by the player, never overwritten silently', async () => {
  const w = world();
  w.device.files = [file('s', 1)];
  const a = w.save(); assert.equal(await a.pull(), 'push'); assert.equal(w.puts, 1);
  const before = w.head.hash;
  w.device.files = [file('s', 9)];
  // the account moves on from elsewhere: simulated by a second CloudSave with its own knowledge
  const store2 = new Map(); const b = new CloudSave({ game: 'g', user: 'ana', storage: { getItem: (k) => store2.get(k) ?? null, setItem: (k, v) => store2.set(k, v) }, fetchImpl: (u, o) => w.save().fetchImpl(u, o), read: async () => [file('s', 5)], write: async () => {} });
  store2.set('orthros.sync.ana.g', JSON.stringify({ parent: before, local: 'x' }));
  assert.equal((await b.push()).state, 'saved'); assert.equal(w.puts, 2);
  // this device changed too: its send is refused, the account's copy is untouched
  assert.equal((await a.push()).state, 'conflict'); assert.equal(w.puts, 2);
  assert.equal(await a.pull(), 'conflict');
  await a.resolve('account');
  assert.deepEqual([...w.device.files[0].data], [5], 'the account\'s copy put in place');
  w.device.files = [file('s', 7)];
  assert.equal((await a.push()).state, 'saved'); assert.equal(w.puts, 3);
});

test('CloudSave: a profile played signed out is compared, the same content is not a conflict', async () => {
  const w = world([file('s', 4)]);
  w.device.files = [file('s', 4)];
  assert.equal(await w.save().pull(), 'same');
  w.device.files = [file('s', 6)];
  const c = w.save('bob'); // (another account on this browser: this profile was ana's)
  w.store.set('orthros.owner.g', 'ana');
  assert.equal(await c.pull(), 'restore', 'another account\'s profile is not sent to this one');
});

test('CloudSave: signed out, nothing leaves the browser', async () => {
  const w = world(); w.device.files = [file('s', 1)];
  const c = w.save(null);
  assert.equal(await c.pull(), 'none'); assert.equal((await c.push()).state, 'off'); assert.equal(w.puts, 0);
});
