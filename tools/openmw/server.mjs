// One pinned OpenMW-Web gateway and its native simulation peers. Docker's published port
// is localhost only; Orthros owns the public HTTP/WebSocket routes. No game data in images.
// Usage: node tools/openmw/server.mjs <manifest> [--games-dir dir] [--state-dir dir] [--origin url]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadGameCatalog, DEFAULT_GAMES_DIR } from '../../src/host/game-catalog.js';
import { linkGameLayers, engineFile, DEFAULT_ENGINES_DIR } from '../../src/host/goldsrc.js';
import { openmwInstalled } from '../../src/host/openmw.js';
import { resolveGameFile } from '../../src/host/game-files.js';

const args = process.argv.slice(2), id = args[0], arg = (k) => args.includes(k) ? args[args.indexOf(k) + 1] : null;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const games = path.resolve(arg('--games-dir') ?? DEFAULT_GAMES_DIR);
const man = loadGameCatalog(games).get(id);
if (man?.runtime !== 'openmw' || !man.openmw.multiplayer) throw new Error('Expected an OpenMW multiplayer manifest');
const missing = man.openmw.files.filter((f) => !resolveGameFile(man, f));
const engines = path.resolve(arg('--engines-dir') ?? DEFAULT_ENGINES_DIR);
if (!openmwInstalled(man, engines)) throw new Error(`Installation incomplete: ${missing.join(', ')}; install the engine and finish the declared mod stack before starting multiplayer`);
const release = JSON.parse(fs.readFileSync(engineFile(engines, man.openmw.engine, 'release.json')));
if (!/^ghcr\.io\/virtastic\/openmw-web-server@sha256:[a-f0-9]{64}$/.test(release.serverImage ?? '')) throw new Error('No pinned server image in this engine release');
const state = path.resolve(arg('--state-dir') ?? path.join(root, 'build/openmw', id));
const base = `/ports/openmw/${encodeURIComponent(id)}/app`;
const origin = new URL(arg('--origin') ?? process.env.ORTHROS_ORIGIN ?? 'http://localhost:8080').origin;
fs.mkdirSync(state, { recursive: true });
// Only this generated linked tree is rebuilt. The installed game and version files are read-only.
linkGameLayers(man, path.join(state, 'gamedata'));
fs.writeFileSync(path.join(state, 'modlist.json'), JSON.stringify({ version: 2, entries: [], mods: (man.openmw.mods ?? []).flatMap((mod) => (mod.parts ?? []).map((part, i) => ({
  slug: `${mod.id}-${i}`, name: mod.name, archive: mod.sha256 ?? mod.url ?? '', source: part.source,
  enabled: true, installedAt: mod.installedAt ?? '', plugins: part.plugins.map((file) => ({ file, enabled: true })), archives: part.archives, files: part.files, bytes: part.bytes,
}))) }, null, 2) + '\n');
if (!fs.existsSync(path.join(state, 'config.toml'))) fs.writeFileSync(path.join(state, 'config.toml'), `[server]\nname = ${JSON.stringify(man.name)}\nmaxPlayers = ${man.openmw.multiplayer.maxPlayers ?? 8}\n\n[setup]\ncompleted = true\ndeploymentMode = "multiplayer"\ndeliveryModel = "serve"\nhosting = "internal"\n\n[locker]\npublicBase = ${JSON.stringify(origin + base)}\n\n[auth]\nreturnUrl = ${JSON.stringify(origin + base + '/join')}\n\n[worlds]\nmemBudgetMb = 3072\ngatewayReserveMb = 256\n\n[rules]\npvp = false\n`, { mode: 0o600 });
fs.writeFileSync(path.join(state, '.mode'), 'gateway\n');
const child = spawn('docker', ['run', '--rm', '--init', '--name', `orthros-openmw-${id}`, '--cpus=2', '--memory=4g', '--pids-limit=256',
  '-p', `127.0.0.1:${man.openmw.multiplayer.port}:8080`, '-v', `${state}:/data`, '-v', `${games}:${games}:ro`,
  '--log-driver=json-file', '--log-opt=max-size=10m', '--log-opt=max-file=3', release.serverImage], { stdio: 'inherit' });
// Docker forwards terminal signals to its own container. Never signal another service/process.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
