// The virtual LAN of the Windows games (src/host/lan.js) on a server with accounts: a signed-in player only, named
// after the account (the emulated machine's host name, the games' default player name).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lanUpgrades, lanName } from '../src/host/lan.js';

test('lanName: what Windows allows in a host name, 12 characters at most', () => {
  assert.equal(lanName('ana.b_c'), 'anabc');
  assert.equal(lanName('a-very-long-account-name'), 'a-very-long-');
  assert.equal(lanName('...'), null);
  assert.equal(lanName(undefined), null);
});

test('the LAN refuses a player without an account and names the signed-in one', async (t) => {
  let who = null;
  const lan = lanUpgrades(() => {}, { identify: () => who });
  const server = http.createServer();
  server.on('upgrade', (req, socket) => { if (!lan.handle(req, socket, new URL(req.url, 'http://x'))) socket.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `ws://127.0.0.1:${server.address().port}/api/lan?room=game`;
  const first = (u) => new Promise((resolve, reject) => {
    const ws = new WebSocket(u), got = [];
    ws.onmessage = (e) => { got.push(JSON.parse(e.data)); if (got[0].type !== 'refused') { ws.close(); resolve({ got, closed: false }); } };
    ws.onclose = () => resolve({ got, closed: true });
    ws.onerror = reject;
  });
  const refused = await first(url);
  assert.deepEqual(refused.got.map((m) => m.type), ['refused']); assert.equal(refused.closed, true);
  assert.equal(lan.rooms.size, 0, 'never in the room');
  who = { username: 'ana' };
  const joined = await first(url);
  assert.equal(joined.got[0].type, 'hello'); assert.equal(joined.got[0].name, 'ana'); assert.match(joined.got[0].ip, /^10\.77\./);
});
