// The native multiplayer gateway's image (tools/openmw/lock.json "serverBuild", build-server-image.sh,
// server-node.Dockerfile): derived from the pinned upstream image, its Node.js a pinned official release of the same
// major version; tools/openmw/server.mjs runs it by its pinned ID for the releases built on that upstream image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openmwGatewayImage } from '../src/host/openmw.js';

const tools = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/openmw');
const lock = JSON.parse(fs.readFileSync(path.join(tools, 'lock.json'), 'utf8'));

test('lock: the derived gateway image is pinned, on the upstream image, with a checked Node.js release', () => {
  const b = lock.serverBuild;
  assert.equal(b.base, lock.serverImage);
  assert.match(b.image, /^sha256:[a-f0-9]{64}$/);
  assert.match(b.config, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isInteger(b.sourceDateEpoch));
  assert.ok(fs.existsSync(path.join(tools, b.dockerfile)));
  const [major, minor, patch] = b.node.version.split('.').map(Number);
  // (the upstream image's Node is 22.23.3: same major — the gateway's N-API addon —, at least 22.23.4, CVE-2026-111497)
  assert.equal(major, 22);
  assert.ok(minor > 23 || (minor === 23 && patch >= 4), b.node.version);
  assert.equal(b.node.url, `https://nodejs.org/dist/v${b.node.version}/node-v${b.node.version}-linux-x64.tar.xz`);
  assert.match(b.node.sha256, /^[a-f0-9]{64}$/);
  assert.ok(b.tag.endsWith(`-node${b.node.version}`));
});

test('gateway image: the derived one for a release on that upstream image, its own image otherwise', () => {
  const upstream = { id: lock.id, serverImage: lock.serverImage };
  const releases = { [lock.id]: upstream };
  const releaseOf = (id) => releases[id];
  assert.deepEqual(openmwGatewayImage(upstream, releaseOf, lock), { image: lock.serverBuild.image, base: lock.serverImage, tag: lock.serverBuild.tag });
  // (a release built here: its upstream's)
  const built = { id: `${lock.id}-orthros-r9`, upstream: { id: lock.id } };
  assert.equal(openmwGatewayImage(built, releaseOf, lock).image, lock.serverBuild.image);
  // (another upstream release, another image: its own pinned one, not the derived)
  const other = { id: 'openmw-web-v9.9.9', serverImage: `ghcr.io/virtastic/openmw-web-server@sha256:${'1'.repeat(64)}` };
  assert.equal(openmwGatewayImage(other, releaseOf, lock).image, other.serverImage);
  assert.equal(openmwGatewayImage(upstream, releaseOf, { ...lock, serverBuild: undefined }).image, lock.serverImage);
  // (no pinned upstream image; a derived image not pinned)
  assert.throws(() => openmwGatewayImage({ id: 'x' }, releaseOf, lock), /No pinned server image/);
  assert.throws(() => openmwGatewayImage(upstream, releaseOf, { ...lock, serverBuild: { ...lock.serverBuild, image: '' } }), /not pinned/);
});
