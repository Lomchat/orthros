// The native dedicated server of a GoldSrc version (docs/browser-ports.md), run by systemd
// (tools/goldsrc/orthros-goldsrc@.service, instance = the manifest id): Xash3D FWGS built from pinned sources
// (build-server.sh) in data_engines/<goldsrc.multiplayer.server>/, serving the version's files read-only on
// 127.0.0.1:<goldsrc.multiplayer.port> only — players reach it through the Orthros server's relay (/api/udp/<manifest>).
// The game library is the one the game's files name, or goldsrc.multiplayer.gameLibrary: a native build in the browser
// release (tools/goldsrc/build-modules.sh). Its writable state (configuration, logs, the linked game files) goes to
// $STATE_DIRECTORY, or --state <dir>.
// Usage: node tools/goldsrc/server.mjs <manifest> [--games-dir <dir>] [--engines-dir <dir>] [--state <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadGameCatalog, DEFAULT_GAMES_DIR } from '../../src/host/game-catalog.js';
import { DEFAULT_ENGINES_DIR, engineFile, linkGameLayers } from '../../src/host/goldsrc.js';

const args = process.argv.slice(2), arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const id = args[0], stateArg = arg('--state') ?? process.env.STATE_DIRECTORY;
if (!id || !stateArg) { console.error('usage: server.mjs <manifest> [--games-dir d] [--engines-dir d] [--state d]'); process.exit(2); }
const state = path.resolve(stateArg);
const man = loadGameCatalog(path.resolve(arg('--games-dir') ?? DEFAULT_GAMES_DIR)).get(id);
const g = man?.runtime === 'goldsrc' ? man.goldsrc : null, mp = g?.multiplayer;
if (!mp) { console.error(`${id}: no GoldSrc version with a multiplayer server`); process.exit(2); }
const engines = path.resolve(arg('--engines-dir') ?? DEFAULT_ENGINES_DIR), release = path.join(engines, mp.server);
if (!fs.existsSync(path.join(release, 'xash'))) { console.error(`${release}: dedicated-server release not installed (tools/goldsrc/build-server.sh)`); process.exit(1); }
const gameLibrary = mp.gameLibrary === undefined ? null : engineFile(engines, g.engine, mp.gameLibrary);
if (mp.gameLibrary !== undefined && !gameLibrary) { console.error(`${g.engine}/${mp.gameLibrary}: game library not installed (tools/goldsrc/build-modules.sh)`); process.exit(1); }
// (one directory for the engine: the version's files over the base's, linked afresh at each start)
const game = path.join(state, 'game');
console.log(`${id}: ${linkGameLayers(man, game)} game files linked`);
// (the archives goldsrc.extras names in the game folder, as the page mounts them: bot profiles, navigation meshes)
const gameFolder = path.join(game, fs.readdirSync(game).find((n) => n.toLowerCase() === g.gameDir.toLowerCase()) ?? g.gameDir);
fs.mkdirSync(gameFolder, { recursive: true });
for (const extra of g.extras ?? []) {
  const file = engineFile(engines, g.engine, extra), dest = path.join(gameFolder, path.basename(extra));
  if (!file) { console.error(`${g.engine}/${extra}: archive not installed`); process.exit(1); }
  fs.rmSync(dest, { force: true }); fs.symlinkSync(file, dest);
}
fs.mkdirSync(path.join(state, g.gameDir), { recursive: true });
const cfg = path.join(state, g.gameDir, 'server.cfg');
if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, `hostname "Orthros - ${man.name}"\nsv_lan 1\nsv_cheats 0\nsv_maxrate 100000\nsv_minrate 10000\nmp_timelimit 30\n`);
const child = spawn(path.join(release, 'xash'), ['-dedicated', '-noip6', '-rodir', game, '-game', g.gameDir,
  ...(gameLibrary ? ['-dll', gameLibrary] : []), '-port', String(mp.port), '+ip', '127.0.0.1', '+maxplayers', String(mp.maxPlayers ?? 16),
  // (goldsrc.multiplayer.commands: the version's settings, before the map starts)
  ...(mp.commands ?? []).flatMap((c) => c.split(' ').map((w, i) => (i ? w : `+${w}`))), '+map', mp.map], {
  cwd: state,
  env: { ...process.env, XASH3D_BASEDIR: state, XASH3D_LIBDIR: release, LD_LIBRARY_PATH: release },
  stdio: 'inherit',
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
