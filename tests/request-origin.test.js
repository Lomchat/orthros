import test from 'node:test';
import assert from 'node:assert/strict';
import { requestHost, forwardedOrigin, sameOrigin } from '../src/server/request-origin.js';

const req = (headers) => ({ headers });

test('request-origin: the addressed host is the front proxy\'s, else Host; a page of it is same-origin', () => {
  // (behind Caddy: X-Forwarded-Host names the site in the address bar — the public name or a Worker's)
  assert.equal(requestHost(req({ host: 'orthros.example', 'x-forwarded-host': 'orthros.Mirror.test' })), 'orthros.mirror.test');
  assert.equal(requestHost(req({ host: '127.0.0.1:8095' })), '127.0.0.1:8095');
  assert.equal(requestHost(req({ host: '[::1]:8080' })), '[::1]:8080');
  assert.equal(requestHost(req({ host: 'a.test', 'x-forwarded-host': 'bad host/' })), 'a.test', 'a malformed forwarded host is ignored');
  assert.equal(requestHost(req({ 'x-forwarded-host': 'first.test, second.test' })), 'first.test');
  assert.equal(requestHost(req({})), '');
  assert.equal(forwardedOrigin(req({ 'x-forwarded-host': 'm.test', 'x-forwarded-proto': 'https' }), 'https://fallback.test'), 'https://m.test');
  assert.equal(forwardedOrigin(req({ 'x-forwarded-host': 'localhost:8080', 'x-forwarded-proto': 'http' }), null), 'http://localhost:8080');
  assert.equal(forwardedOrigin(req({ host: 'a.test' }), 'https://fallback.test'), 'https://fallback.test');
  assert.equal(sameOrigin(req({ host: 'orthros.example', 'x-forwarded-host': 'm.test', origin: 'https://m.test' })), true);
  assert.equal(sameOrigin(req({ host: 'orthros.example', 'x-forwarded-host': 'm.test', origin: 'https://orthros.example' })), false, 'the proxied name is not the addressed one');
  assert.equal(sameOrigin(req({ host: 'localhost:8080', origin: 'http://localhost:8080' })), true);
  assert.equal(sameOrigin(req({ host: 'localhost:8080', origin: 'http://elsewhere.test' })), false);
  assert.equal(sameOrigin(req({ host: 'localhost:8080' })), false, 'no Origin: refused');
  assert.equal(sameOrigin(req({ host: 'localhost:8080', origin: 'null' })), false);
  assert.equal(sameOrigin(req({ host: 'x.test', origin: 'file://x.test' })), false);
});
