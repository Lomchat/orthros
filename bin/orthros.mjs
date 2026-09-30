#!/usr/bin/env node
// Orthros command line.
//
//   orthros run <game-folder | manifest.json> [--port 8080] [--exe game.exe] [--args "..."] [--open]
//       serve the folder (its manifest.json, else a manifest synthesized from the folder: see src/host/manifest.js)
//       and print the page URL that starts it in Chrome; --open launches the system Chrome/Chromium on it
//   orthros serve [--port 8080] [--manifests dir]      the page with every manifest of the directory
//   orthros cli <game-folder | manifest.json> [...]    headless Node run (no rendering): src/host/cli.js options
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/host/server.js';
import { folderManifest, withDefaults } from '../src/host/manifest.js';
import { defaultGameManifest } from '../src/host/game-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const FLAGS = new Set(['--open']); // options without a value
const opt = (name, def) => { const i = rest.indexOf('--' + name); return i >= 0 && i + 1 < rest.length ? rest[i + 1] : def; };
const positional = [];
for (let i = 0; i < rest.length; i++) { if (!rest[i].startsWith('--')) positional.push(rest[i]); else if (!FLAGS.has(rest[i])) i++; }

function listen(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); });
}

/** A system Chrome / Chromium executable, or null. */
function findChrome() {
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) for (const n of names) { const p = path.join(dir, n); if (fs.existsSync(p)) return p; }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']) if (fs.existsSync(p)) return p;
  return null;
}

async function run() {
  const target = positional[0];
  if (!target) { console.error('usage: orthros run <game-folder | manifest.json> [--port N] [--exe name] [--args "..."] [--open]'); process.exit(2); }
  let manifest;
  if (target.endsWith('.json')) {
    const spec = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (path.basename(target) === 'manifest.json' && spec.schemaVersion === 1) {
      manifest = defaultGameManifest(path.dirname(target));
    } else {
      manifest = withDefaults(spec);
      manifest.folder = path.resolve(path.dirname(target), manifest.folder ?? '.');
    }
    if (opt('exe')) manifest.exe = opt('exe');
    if (opt('args') !== undefined) manifest.args = opt('args');
  } else if (fs.existsSync(path.join(target, 'manifest.json')) && JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')).schemaVersion === 1) {
    manifest = defaultGameManifest(target);
    if (opt('exe')) manifest.exe = opt('exe');
    if (opt('args') !== undefined) manifest.args = opt('args');
  } else manifest = folderManifest(target, { exe: opt('exe'), args: opt('args') });
  const name = path.basename(manifest.folder).replace(/[^A-Za-z0-9._-]/g, '_') || 'game';
  const server = createServer({ extra: new Map([[name, manifest]]) });
  const port = await listen(server, Number(opt('port', 8080)));
  const url = `http://127.0.0.1:${port}/?manifest=${encodeURIComponent(name)}`;
  console.log(`orthros: ${manifest.name ?? name} — ${manifest.exe} from ${manifest.folder}`);
  console.log(`orthros: open ${url}`);
  if (rest.includes('--open')) {
    const chrome = findChrome();
    if (chrome) spawn(chrome, [url], { stdio: 'ignore', detached: true }).unref();
    else console.log('orthros: no Chrome/Chromium found on this machine: open the URL above in Chrome');
  }
}

async function serve() {
  const server = createServer({ manifests: opt('manifests'), gamesDir: opt('games-dir') });
  const port = await listen(server, Number(opt('port', 8080)));
  console.log(`orthros: http://127.0.0.1:${port}/`);
}

function cli() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/host/cli.js'), ...rest], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
}

if (cmd === 'run') await run();
else if (cmd === 'serve') await serve();
else if (cmd === 'cli') cli();
else { console.error('usage: orthros run <game-folder | manifest.json> | orthros serve | orthros cli <folder> (see bin/orthros.mjs)'); process.exit(2); }
