// Navigation meshes of a GoldSrc game's bots (docs/browser-ports.md), for maps that ship none: the native dedicated
// server (lock.json "dedicatedServer") runs each map with the given game library and its bot support on (-bots); one
// bot added to a map without a mesh learns it and saves maps/<map>.nav. A few servers at once, 127.0.0.1 only.
// Usage: node tools/goldsrc/bot-nav.mjs <manifest> --library <game library> --profiles <BotProfile.db> --out <dir>
//   --maps <a,b,...> [--games-dir <dir>] [--engines-dir <dir>] [--jobs 4]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadGameCatalog, DEFAULT_GAMES_DIR } from '../../src/host/game-catalog.js';
import { DEFAULT_ENGINES_DIR, linkGameLayers } from '../../src/host/goldsrc.js';

const args = process.argv.slice(2), arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const id = args[0], library = arg('--library'), profiles = arg('--profiles'), out = arg('--out'), maps = arg('--maps')?.split(',').filter(Boolean);
if (!id || !library || !profiles || !out || !maps?.length) { console.error('usage: bot-nav.mjs <manifest> --library l --profiles p --out d --maps a,b [--jobs n]'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lock.json'), 'utf8'));
const man = loadGameCatalog(path.resolve(arg('--games-dir') ?? DEFAULT_GAMES_DIR)).get(id);
if (man?.runtime !== 'goldsrc') { console.error(`${id}: no GoldSrc version`); process.exit(2); }
const gameDir = man.goldsrc.gameDir, release = path.join(path.resolve(arg('--engines-dir') ?? DEFAULT_ENGINES_DIR), lock.dedicatedServer.id);
if (!fs.existsSync(path.join(release, 'xash'))) { console.error(`${release}: dedicated-server release not installed (tools/goldsrc/build-server.sh)`); process.exit(1); }

fs.mkdirSync('/tmp/orthros-scratch', { recursive: true });
const work = fs.mkdtempSync('/tmp/orthros-scratch/goldsrc-bot-nav-');
const game = path.join(work, 'game');
linkGameLayers(man, game);
fs.mkdirSync(out, { recursive: true });

/** One map: a server whose single bot learns it, until the mesh is saved (or the time is up). */
function learn(map, port) {
  const state = path.join(work, `state-${map}`), maps = path.join(state, gameDir, 'maps');
  fs.mkdirSync(maps, { recursive: true }); // (the mesh is written there, relative to the server's working directory)
  fs.copyFileSync(profiles, path.join(state, gameDir, 'BotProfile.db'));
  fs.writeFileSync(path.join(state, gameDir, 'server.cfg'), 'sv_lan 1\n');
  const nav = path.join(maps, `${map}.nav`);
  return new Promise((resolve) => {
    const child = spawn(path.join(release, 'xash'), ['-dedicated', '-bots', '-noip6', '-rodir', game, '-game', gameDir, '-dll', path.resolve(library),
      '-port', String(port), '+ip', '127.0.0.1', '+maxplayers', '4', '+map', map], {
      cwd: state, env: { ...process.env, XASH3D_BASEDIR: state, XASH3D_LIBDIR: release, LD_LIBRARY_PATH: release }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let log = '', done = false;
    const finish = (ok) => {
      if (done) return; done = true; clearTimeout(timer); clearInterval(poll);
      child.stdin.end('quit\n'); setTimeout(() => child.kill('SIGKILL'), 3000);
      if (ok) fs.copyFileSync(nav, path.join(out, `${map}.nav`));
      resolve({ map, ok, tail: ok ? '' : log.slice(-400) });
    };
    child.stdout.on('data', (d) => { log += d; if (/started/.test(log) && !/bot_add sent/.test(log)) { log += '\nbot_add sent\n'; setTimeout(() => child.stdin.write('bot_add\n'), 2000); } });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', () => finish(false));
    // (saved when the file has its final size: two equal readings a second apart)
    let last = -1;
    const poll = setInterval(() => {
      const size = fs.existsSync(nav) ? fs.statSync(nav).size : -1;
      if (size > 0 && size === last && /saved/.test(log)) finish(true);
      last = size;
    }, 1000);
    const timer = setTimeout(() => finish(false), 600000);
  });
}

const queue = [...maps], jobs = Number(arg('--jobs') ?? 4), results = [];
let port = 28400;
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) {
    const map = queue.shift(), t = Date.now(), r = await learn(map, port++);
    results.push(r);
    console.log(`${map}: ${r.ok ? `saved in ${Math.round((Date.now() - t) / 1000)} s` : `FAILED\n${r.tail}`}`);
  }
}));
fs.rmSync(work, { recursive: true, force: true });
process.exit(results.every((r) => r.ok) ? 0 : 1);
