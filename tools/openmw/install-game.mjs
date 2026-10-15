// Import a purchased Data Files folder, or initialize the pending installation and the free
// engine example. Original files are copied only into an empty base; never overwritten.
// Usage: node tools/openmw/install-game.mjs [--games-dir dir] [--data-files folder]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), arg = (k) => args.includes(k) ? args[args.indexOf(k) + 1] : null;
const games = path.resolve(arg('--games-dir') ?? path.join(here, '../../data_games'));
const lock = JSON.parse(fs.readFileSync(path.join(here, 'lock.json')));
function writeGame(spec) {
  const dir = path.join(games, spec.id); fs.mkdirSync(path.join(dir, 'base'), { recursive: true });
  for (const v of spec.versions) fs.mkdirSync(path.join(dir, 'versions', v.dir), { recursive: true });
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(spec, null, 2) + '\n');
  if (!fs.existsSync(path.join(dir, 'cover.svg'))) fs.copyFileSync(path.join(here, 'cover.svg'), path.join(dir, 'cover.svg'));
  return dir;
}
const spec = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json')));
const game = writeGame(spec);
writeGame({ schemaVersion: 1, id: 'openmw-example', name: 'OpenMW · Free example', defaultVersion: 'openmw-example-1.5.3',
  defaults: { runtime: 'openmw', coverFile: 'cover.svg' }, versions: [{ id: 'openmw-example-1.5.3', dir: '1.5.3', version: 'Démo libre · OpenMW-Web 1.5.3',
    description: 'A small freely licensed example world. This is not Morrowind.', descriptionFr: 'Un petit monde de démonstration libre. Le jeu Morrowind est à installer séparément.',
    openmw: { engine: lock.id, example: true, files: [], startCell: 'Village' } }] });
const input = arg('--data-files');
if (input) {
  const source = fs.realpathSync(input), dest = path.join(game, 'base');
  if (!fs.statSync(source).isDirectory()) throw new Error('Expected the Data Files folder');
  const names = new Map(fs.readdirSync(source).map((s) => [s.toLowerCase(), s]));
  for (const f of spec.versions[0].openmw.files) if (!names.has(f.toLowerCase())) throw new Error(`Missing ${f} in ${source}`);
  if (fs.readdirSync(dest).length) throw new Error(`${dest} is not empty; original game files will not be overwritten`);
  fs.cpSync(source, dest, { recursive: true, dereference: true, errorOnExist: true, force: false });
  console.log(`Imported original game files into ${dest}. Install the mod stack next.`);
} else console.log(`Prepared ${game}; original game files and pending mods are still required.`);
