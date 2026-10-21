// The two-client check of a shared world (tools/re3/mmo-check.mjs): its pure parts — the command line, the reading of
// the engine's debug states, the respawn's rules, the admins file it may touch, the summary. (The run itself needs a
// browser and an engine: tools/with-browser-slot.sh node tools/re3/mmo-check.mjs …)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, scenarioList, SCENARIOS, vec, distance, offset, tpCommand, characterName, playerIn, seesAt, chatHas, census, netids, unarmed, dead,
  respawnChecks, adminsPathAllowed, withAdmin, summarize, entityAudit, persistentFaults, gathering, killLine } from '../tools/re3/mmo-check.mjs';
import { MMO_NAME } from '../src/host/mmo.js';

test('mmo check: its command line', () => {
  const d = parseArgs([]);
  assert.equal(d.manifest, 'vice-city-orthros'); assert.equal(d.url, 'http://127.0.0.1:8080'); assert.equal(d.seconds, 900);
  assert.deepEqual(d.scenarios, SCENARIOS); assert.equal(d.admins, null); assert.deepEqual([d.width, d.height], [480, 300]);
  const o = parseArgs(['other-version', '--url', 'http://localhost:9000/', '--seconds', '120', '--scenario', 'chat,basic', '--admins', '/tmp/orthros-scratch/x/admins.json', '--weapon', '17']);
  assert.equal(o.manifest, 'other-version'); assert.equal(o.url, 'http://localhost:9000');
  assert.equal(o.seconds, 120); assert.deepEqual(o.scenarios, ['basic', 'chat'], 'in their order');
  assert.equal(o.admins, '/tmp/orthros-scratch/x/admins.json'); assert.equal(o.weapon, 17);
  assert.equal(parseArgs(['--url', 'http://h', 'v2']).manifest, 'v2', 'an option\'s value is not the manifest');
  assert.throws(() => parseArgs(['--seconds', '5']), /--seconds/);
  assert.throws(() => parseArgs(['--scenario', 'basic,flying']), /unknown scenario flying/);
  assert.deepEqual(scenarioList('all'), SCENARIOS); assert.deepEqual(scenarioList(' Garage '), ['garage']);
});

test('mmo check: positions, players and lines as the engine publishes them', () => {
  assert.deepEqual(vec([1, 2, 3, 4]), [1, 2, 3]); assert.deepEqual(vec({ x: 1, y: 2, z: 3 }), [1, 2, 3]);
  assert.equal(vec([1, 2]), null); assert.equal(vec(null), null);
  assert.equal(distance([0, 0, 0], { x: 3, y: 4, z: 0 }), 5); assert.equal(distance(null, [0, 0, 0]), Infinity);
  assert.deepEqual(offset([1, 2, 3], 3), [4, 2, 3]);
  assert.equal(tpCommand([233.5, -1278.45, 11]), 'tp 233.50 -1278.45 11.00');
  const a = { pos: [10, 0, 0], players: [{ slot: 1, name: 'Bob', pos: [20.5, 0, 0], away: false, stars: 2 }], chat: ['Bob: hello there', { name: 'x', text: 'mmo-check B 1' }] };
  const b = { pos: [20, 0, 0], players: [{ slot: 0, name: 'alice', pos: { x: 13, y: 0, z: 0 } }] };
  assert.equal(playerIn(a, 'BOB').slot, 1); assert.equal(playerIn(a, 'carol'), null); assert.equal(playerIn({}, 'x'), null);
  assert.deepEqual(seesAt(a, b, 'bob'), { ok: true, dist: 0.5, seen: true });
  assert.deepEqual(seesAt(b, a, 'Alice'), { ok: false, dist: 3, seen: true });
  assert.deepEqual(seesAt(b, a, 'nobody'), { ok: false, dist: null, seen: false });
  assert.ok(chatHas(a, 'hello there') && chatHas(a, 'mmo-check B 1') && !chatHas(a, 'absent') && !chatHas({}, 'x'));
});

test('mmo check: ambient entities counted from counts or lists; network ids when published', () => {
  assert.deepEqual(census({ owned: { peds: 3, vehicles: 2 }, puppets: { peds: [1, 2], vehicles: { count: 4 } } }),
    { ownedPeds: 3, ownedVehicles: 2, puppetPeds: 2, puppetVehicles: 4, owned: 5, puppets: 6 });
  assert.deepEqual(census(null), { ownedPeds: 0, ownedVehicles: 0, puppetPeds: 0, puppetVehicles: 0, owned: 0, puppets: 0 });
  assert.equal(netids({ owned: { peds: 1 } }), null);
  assert.deepEqual([...netids({ owned: { ids: [5, 6] }, puppets: { ids: [7] } })], [5, 6, 7]);
  assert.deepEqual([...netids({ owned: { ids: [5] }, puppets: { ids: [7] } }, 'puppets')], [7]);
  assert.deepEqual([...netids({ netids: ['9'] })], [9]);
});

test('mmo check: the respawn\'s rules — $100, no weapon, alive, elsewhere', () => {
  assert.ok(unarmed({ weapon: 0 }) && unarmed({}) && unarmed({ weapon: 'unarmed' }) && !unarmed({ weapon: 17 }));
  assert.ok(dead({ health: 0 }) && dead({ mode: 'wasted' }) && !dead({ health: 50, mode: 'world' }));
  const ok = respawnChecks({ money: 1000, pos: [0, 0, 0] }, [0, 0, 0], { money: 900, weapon: 0, health: 100, pos: [500, 0, 0] });
  assert.deepEqual(ok.map((c) => c.ok), [true, true, true, true]);
  const bad = respawnChecks({ money: 50 }, [0, 0, 0], { money: 50, weapon: 26, health: 0, pos: [1, 0, 0] });
  assert.deepEqual(bad.map((c) => c.ok), [false, false, false, false]);
  assert.equal(bad[0].detail.expected, 0, 'never below zero');
});

test('mmo check: the admins file — a test server\'s only, the name added once, lowercase', () => {
  assert.ok(adminsPathAllowed('/tmp/orthros-scratch/mmo-test/mmo/admins.json'));
  assert.ok(!adminsPathAllowed('/var/lib/orthros2/accounts/mmo/admins.json'));
  assert.ok(!adminsPathAllowed('/var/lib/private/orthros2/accounts/mmo/admins.json'));
  assert.ok(!adminsPathAllowed('/srv/orthros/data/admins.json'));
  assert.deepEqual(withAdmin(['lomchat'], 'QA-Check-1'), ['lomchat', 'qa-check-1']);
  assert.deepEqual(withAdmin(['lomchat', 'qa-check-1'], 'qa-check-1'), ['lomchat', 'qa-check-1']);
  assert.deepEqual(withAdmin(null, 'a'), ['a']);
});

test('mmo check: character names follow the server\'s rule', () => {
  for (const u of ['qa-check-1-zr60d', 'qa-check-22-abcdefgh', '._x', 'a', 'lomchat', 'qa-check-12-abcd-x', 'a..b__', 'x-', '-'])
    assert.match(characterName(u), MMO_NAME, u);
  assert.equal(characterName('qa-check-1-zr60d'), 'qa-check-1-zr60d');
});

test('mmo check: the summary', () => {
  const s = summarize([{ scenario: 'setup', ok: true }, { scenario: 'basic', ok: true }, { scenario: 'basic', ok: false }, { scenario: 'world', ok: true, skipped: true }]);
  assert.equal(s.passed, false); assert.equal(s.failed, 1); assert.equal(s.skipped, 1);
  assert.deepEqual(s.scenarios.basic, { ok: false, passed: 1, failed: 1, skipped: 0 });
  assert.equal(summarize([{ scenario: 'a', ok: true }]).passed, true);
  assert.equal(summarize([]).passed, false, 'nothing checked is no pass');
});

test('mmo check: players and the scenarios run only when named', () => {
  assert.equal(parseArgs([]).players, 2);
  assert.equal(parseArgs(['--players', '4', '--scenario', 'crowd']).players, 4);
  assert.deepEqual(parseArgs(['--players', '3', '--scenario', 'crowd,chat']).scenarios, ['chat', 'crowd']);
  assert.throws(() => parseArgs(['--scenario', 'crowd']), /--players 3/);
  assert.throws(() => parseArgs(['--players', '5']), /--players/);
  assert.equal(parseArgs(['--scenario', 'freemode']).players, 1, 'the free mode: one page');
  assert.throws(() => parseArgs(['--scenario', 'freemode,chat']), /alone/);
  assert.ok(!scenarioList('all').includes('crowd') && scenarioList('all,perks').includes('perks'));
  assert.equal(parseArgs(['--players', '3', 'v']).manifest, 'v');
});

test('mmo check: the shared entities audited across players — one owner, copies near the others, no ghost', () => {
  const st = (pos, owned, puppets, near) => ({ pos, owned: { ids: owned }, puppets: { ids: puppets }, near });
  const good = entityAudit([
    { tag: 'A', slot: 0, state: st([0, 0, 0], [1, 2], [3], [{ id: 1, p: [5, 0, 0], o: 0, copy: false }, { id: 3, p: [9, 0, 0], o: 1, copy: true }]) },
    { tag: 'B', slot: 1, state: st([3, 0, 0], [3], [1, 2], [{ id: 3, p: [9, 0, 0], o: 1, copy: false }, { id: 1, p: [5, 0, 0], o: 0, copy: true }]) },
    { tag: 'C', slot: 2, state: st([500, 0, 0], [], [], []) },
  ]);
  assert.deepEqual(good.duplicates, []); assert.deepEqual(good.ghosts, []); assert.deepEqual(good.wrongOwner, []);
  assert.deepEqual(good.coverage, { expected: 2, present: 2, missing: [] }, 'C is far: nothing expected there');
  const bad = entityAudit([
    { tag: 'A', slot: 0, state: st([0, 0, 0], [1, 5], [7], [{ id: 1, p: [1, 0, 0], o: 0, copy: false }]) },
    { tag: 'B', slot: 1, state: st([2, 0, 0], [1], [5], [{ id: 5, p: [1, 0, 0], o: 1, copy: true }]) },
  ]);
  assert.deepEqual(bad.duplicates, [1]);
  assert.deepEqual(bad.ghosts, [{ tag: 'A', id: 7, owner: null }]);
  assert.deepEqual(bad.wrongOwner, [{ tag: 'B', id: 5, owner: 1, actual: ['A'] }]);
  assert.deepEqual(bad.coverage.missing, [], 'id 1 owned twice: B has no copy of it but owns it');
  const full = entityAudit([{ tag: 'A', slot: 0, state: st([0, 0, 0], Array.from({ length: 96 }, (_, i) => i + 100), [7], []) }]);
  assert.equal(full.complete, false); assert.deepEqual(full.ghosts, [], 'a full list may leave the owner out: no ghost judged');
  assert.deepEqual(persistentFaults([bad, bad]).duplicates, [1]);
  assert.deepEqual(persistentFaults([bad, good]).duplicates, [], 'a moment\'s fault is no fault');
});

test('mmo check: a crowd\'s places and the kill line', () => {
  const g = gathering([0, 0, 0], 4, 3);
  assert.deepEqual(g, [[0, 0, 0], [3, 0, 0], [0, 3, 0], [3, 3, 0]]);
  assert.ok(killLine({ chat: ['qa-a killed qa-b'] }, 'qa-b', 'qa-a') && killLine({ chat: [{ text: 'qa-a a tué qa-b' }] }, 'qa-b'));
  assert.equal(killLine({ chat: ['qa-a killed qa-c'] }, 'qa-b'), null);
  assert.equal(killLine({}, 'x'), null);
});
