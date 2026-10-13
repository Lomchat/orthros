import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserPorts } from '../src/host/web/browser-ports.js';

test('Optional browser ports fail closed without preventing the Windows home', async () => {
  assert.deepEqual(await loadBrowserPorts(async () => { throw new Error('offline'); }), []);
  assert.deepEqual(await loadBrowserPorts(async () => new Response('unavailable', { status: 503 })), []);
  assert.deepEqual(await loadBrowserPorts(async () => Response.json({ invalid: true })), []);
});

test('Only registered local port launch paths can be offered by the home', async () => {
  const item = { name: 'port-example-v1', gameId: 'example', title: 'Example', launchUrl: '/ports/example/example/v1/' };
  const items = await loadBrowserPorts(async url => {
    assert.equal(url, '/ports/api/manifests');
    return Response.json([item, { ...item, launchUrl: 'javascript:alert(1)' }, { ...item, launchUrl: '//other.example/' }, { ...item, name: 'bfme1' }]);
  });
  assert.deepEqual(items, [item]);
});
