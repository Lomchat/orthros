// The home's "Lancer mon jeu" entry (?dropgame=1 until validated — docs/drop-game.md): the player picks a Windows game
// folder already installed on their machine (showDirectoryPicker, else an <input webkitdirectory>) or a CD image
// (.iso); its files are copied into this browser (src/vfs/local-games.js, by the whole-game download's worker) and the
// game runs as any other (main.js start: the manifest name 'local-…'). Nothing of it is sent to the server.
import { h } from './dom.js';
import { filesOfHandle, filesOfList, filesOfIso, folderTree, localId, localManifest, saveLocal, listLocal, removeLocal } from '../vfs/local-games.js';

const STRINGS = {
  en: {
    entry: 'Run my game', title: 'Run a game of your own',
    text: 'Pick the folder of a Windows game installed on your computer (or a CD image, .iso). It is copied into this browser, never sent to the server, and runs here like the other games. Experimental.',
    folder: 'Pick a folder', iso: 'CD image (.iso)', play: 'Play', remove: 'Remove',
    reading: 'Reading the folder…', copying: (a, b) => `Copying into this browser: ${a} / ${b} MB`, copied: (s) => `Copied in ${s} s.`,
    failed: (e) => `Could not copy this game: ${e}`, size: (mb) => `${mb} MB`,
  },
  fr: {
    entry: 'Lancer mon jeu', title: 'Lancer un jeu à toi',
    text: 'Choisis le dossier d’un jeu Windows installé sur ton ordinateur (ou une image de CD, .iso). Il est copié dans ce navigateur, jamais envoyé au serveur, et se lance ici comme les autres jeux. Expérimental.',
    folder: 'Choisir un dossier', iso: 'Image de CD (.iso)', play: 'Jouer', remove: 'Supprimer',
    reading: 'Lecture du dossier…', copying: (a, b) => `Copie dans ce navigateur : ${a} / ${b} Mo`, copied: (s) => `Copié en ${s} s.`,
    failed: (e) => `Impossible de copier ce jeu : ${e}`, size: (mb) => `${mb} Mo`,
  },
};

/**
 * The entry, after `anchor` (the library's heading). `lang()`: the page's language; `onPlay(name)`: starts a game.
 * The state of a copy is also in window.orthrosDrop ({ status: 'reading' | 'copying' | 'ready' | 'error', id, bytes,
 * total, ms, error }), which the harness reads (tools/headless.mjs --drop).
 */
export function mountDropGame(anchor, { lang, onPlay }) {
  const S = () => STRINGS[lang()] ?? STRINGS.en;
  const status = h('div', { class: 'hm-drop-status', role: 'status' });
  const list = h('ul', { class: 'hm-drop-list' });
  const folderInput = h('input', { type: 'file', webkitdirectory: true, hidden: true, id: 'dropFolder' });
  const isoInput = h('input', { type: 'file', accept: '.iso', hidden: true, id: 'dropIso' });
  const panel = h('div', { class: 'hm-drop-panel', hidden: true });
  const entry = h('button', { type: 'button', class: 'hm-btn hm-drop-entry', id: 'dropEntry', onclick: () => { panel.hidden = !panel.hidden; if (!panel.hidden) renderList(); } });
  const box = h('div', { class: 'hm-drop' }, entry, panel, folderInput, isoInput);
  const state = window.orthrosDrop = { status: 'idle' };
  function render() {
    entry.textContent = S().entry;
    panel.replaceChildren(h('h3', {}, S().title), h('p', {}, S().text),
      h('div', { class: 'hm-drop-actions' },
        h('button', { type: 'button', class: 'hm-btn', onclick: pickFolder }, S().folder),
        h('button', { type: 'button', class: 'hm-btn', onclick: () => isoInput.click() }, S().iso)),
      status, list);
  }
  async function renderList() {
    const games = await listLocal();
    list.replaceChildren(...games.filter((g) => g.complete).map((g) => h('li', {}, h('span', {}, `${g.name} · ${S().size(Math.round(g.bytes / 1048576))}`),
      h('button', { type: 'button', class: 'hm-btn', onclick: () => onPlay(g.id) }, S().play),
      h('button', { type: 'button', class: 'hm-btn', onclick: async () => { await removeLocal(g.id).catch(() => {}); renderList(); } }, S().remove))));
  }
  const say = (text) => { status.textContent = text; };
  async function pickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') { folderInput.click(); return; }
    let dir; try { dir = await window.showDirectoryPicker({ mode: 'read' }); } catch { return; } // (cancelled)
    go(() => filesOfHandle(dir));
  }
  folderInput.onchange = () => { if (folderInput.files?.length) go(() => filesOfList(folderInput.files)); };
  isoInput.onchange = () => { const f = isoInput.files?.[0]; if (f) go(() => filesOfIso(f), true); };
  /** Reads the dropped files, describes the game, copies it into its store, then starts it. */
  async function go(read, iso = false) {
    if (state.status === 'reading' || state.status === 'copying') return;
    Object.assign(state, { status: 'reading', error: null }); panel.hidden = false; say(S().reading);
    try {
      const got = await read();
      // (the folder's own manifest.json, as `orthros run <folder>` reads it: its options over the guess)
      const own = got.files.find((f) => f.path.toLowerCase() === 'manifest.json');
      let over = {}; if (own) { try { const j = JSON.parse(await own.file.text()); if (j && typeof j === 'object' && j.schemaVersion === undefined) over = j; } catch { /* not ours */ } }
      const id = await localId(got.name, got.files);
      const manifest = localManifest(id, got.name, got.files, over, iso ? got.label : null);
      const total = got.files.reduce((n, f) => n + f.size, 0);
      const meta = { id, name: got.name, manifest, tree: folderTree(got.files), bytes: total, files: got.files.length, complete: false, at: Date.now() };
      await saveLocal(meta);
      Object.assign(state, { status: 'copying', id, bytes: 0, total });
      const ms = await copy(id, got.files);
      meta.complete = true; await saveLocal(meta);
      Object.assign(state, { status: 'ready', ms }); say(S().copied((ms / 1000).toFixed(0)));
      if (!window.__orthrosDropNoPlay) onPlay(id); else renderList();
    } catch (e) {
      Object.assign(state, { status: 'error', error: String(e?.message ?? e) }); say(S().failed(state.error));
    }
  }
  /** The files into the game's store, by the download worker (OPFS sync handles: a dedicated worker's); the time taken. */
  function copy(id, files) {
    return new Promise((resolve, reject) => {
      const w = new Worker('/src/web/download-worker.js', { type: 'module' });
      let end = null;
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress' && m.kind === 'import') {
          state.bytes = m.bytes; say(S().copying(Math.round(m.bytes / 1048576), Math.round(m.total / 1048576)));
          if (m.error) end = () => reject(new Error(m.error)); else if (m.done) end = () => resolve(m.ms);
        } else if (m.type === 'stopped') { w.terminate(); (end ?? (() => reject(new Error('stopped'))))(); }
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker error')); };
      w.postMessage({ type: 'import', name: id, files: files.map(({ path, file, size, mtime }) => ({ path, file, size, mtime })) });
    });
  }
  render();
  anchor.after(box);
  return { render, destroy: () => box.remove() };
}
