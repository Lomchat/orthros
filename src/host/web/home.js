// The home screen: hero (pixel wordmark, the hound, a resume button), the game library and the options. Only
// rendering and keyboard navigation live here — starting a game stays main.js's job (`onPlay`).
import { startEmbers } from './embers.js';

const $ = (id) => document.getElementById(id);
const LOGO = '/src/host/web/orthros_logo.png';

const STRINGS = {
  en: {
    tagline: 'Windows games, run from their own files in your browser.',
    p1: 'Nothing to install', p2: 'The original game files', p3: 'Saves stay in your browser',
    library: 'Library', games: (n) => `${n} game${n > 1 ? 's' : ''}`,
    resume: 'Continue', first: 'Play', play: 'Play', lastPlayed: 'Last played',
    playAria: (t) => `Play ${t}`, missing: 'Game files not found on the server',
    emptyTitle: 'No game available', emptyText: 'This server offers no game yet. Add one with',
    errorTitle: 'Cannot reach the server', retry: 'Try again',
    options: 'Options', myData: 'My data', language: 'Language', gameLanguage: 'Game language', gameVersion: 'Version',
    offline: 'Offline copy', offlineText: 'Downloads the whole game folder into this browser’s storage in the background: later launches read nothing from the network.',
    log: 'Debug log', logText: 'Shows the emulator’s log over the game.',
    keys: 'choose', enter: 'play', foot: 'Runs entirely in your browser',
    size: (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`),
  },
  fr: {
    tagline: 'Vos jeux Windows, lancés depuis leurs propres fichiers, directement dans le navigateur.',
    p1: 'Rien à installer', p2: 'Les fichiers d’origine du jeu', p3: 'Sauvegardes dans votre navigateur',
    library: 'Bibliothèque', games: (n) => `${n} jeu${n > 1 ? 'x' : ''}`,
    resume: 'Reprendre', first: 'Jouer à', play: 'Jouer', lastPlayed: 'Dernière partie',
    playAria: (t) => `Jouer à ${t}`, missing: 'Fichiers du jeu introuvables sur le serveur',
    emptyTitle: 'Aucun jeu disponible', emptyText: 'Ce serveur ne propose aucun jeu pour l’instant. Ajoutez-en un avec',
    errorTitle: 'Serveur injoignable', retry: 'Réessayer',
    options: 'Options', myData: 'Mes données', language: 'Langue', gameLanguage: 'Langue du jeu', gameVersion: 'Version',
    offline: 'Copie hors ligne', offlineText: 'Télécharge tout le dossier du jeu dans le stockage du navigateur, en arrière-plan : les lancements suivants ne lisent plus rien sur le réseau.',
    log: 'Journal de débogage', logText: 'Affiche le journal de l’émulateur par-dessus le jeu.',
    keys: 'choisir', enter: 'jouer', foot: 'Tout s’exécute dans votre navigateur',
    size: (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} Go` : `${Math.round(b / 1e6)} Mo`),
  },
};

/** The page language: ?lang=, else the visitor's choice, else the browser's (French for French browsers, English otherwise). */
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  let saved = null; try { saved = localStorage.getItem('orthros.lang'); } catch { /* no storage */ }
  const l = q ?? saved ?? navigator.language ?? 'en';
  return String(l).toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** Tiny element builder: h('div', { class: 'x', onclick }, child, ...). */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el[k] = v; else if (k === 'style') el.style.cssText = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

// ---------------------------------------------------------------- the pixel wordmark
// 5 x 7 letters, drawn cell by cell like the hound: one SVG, a continuous gradient from bone to ember to blood across
// all the letters, and a half-cell shadow.
const GLYPHS = {
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
};
function wordmark(text) {
  const NS = 'http://www.w3.org/2000/svg', el = (t, a = {}) => { const n = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) n.setAttribute(k, v); return n; };
  let d = '';
  [...text].forEach((ch, i) => {
    GLYPHS[ch].forEach((row, y) => { for (const m of row.matchAll(/#+/g)) d += `M${i * 6 + m.index} ${y}h${m[0].length}v1h-${m[0].length}z`; });
  });
  const cols = text.length * 6 - 1;
  const svg = el('svg', { viewBox: `0 0 ${cols + 1} 8`, 'shape-rendering': 'crispEdges', 'aria-hidden': 'true', focusable: 'false' });
  const grad = el('linearGradient', { id: 'hmGrad', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 0, y2: 7 });
  for (const [o, c] of [[0, '#fff1cf'], [0.38, '#ffc06a'], [0.68, '#f8901f'], [1, '#d2381f']]) grad.append(el('stop', { offset: o, 'stop-color': c }));
  svg.append(el('defs', {}), el('path', { d, fill: '#03050c', 'fill-opacity': '.62', transform: 'translate(.5 .5)' }), el('path', { d, fill: 'url(#hmGrad)' }));
  svg.firstChild.append(grad);
  return svg;
}

const ICON = {
  play: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.6v10.8a.6.6 0 0 0 .92.5l8.5-5.4a.6.6 0 0 0 0-1L4.92 2.1A.6.6 0 0 0 4 2.6z" fill="currentColor"/></svg>',
};

/**
 * Mounts the home screen (the #menu element of index.html) and shows it, with placeholders until the games arrive.
 * @param {{ onPlay: (name: string, gameLanguage?: string) => void }} opts
 */
export function mountHome({ onPlay }) {
  const menu = $('menu'), grid = $('hmGrid'), nav = $('hmNav');
  const cleanup = [];
  let lang = pickLang(), games = [], last = null, cards = [], resume = null, embers = null;
  let view = { kind: 'loading' }; // (loading, games, error)
  const S = () => STRINGS[lang];
  const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); cleanup.push(() => target.removeEventListener(type, fn, o)); };

  // ---- static pieces
  $('hmTitle').replaceChildren(wordmark('ORTHROS'), h('span', { class: 'sr' }, 'Orthros'));
  const hound = $('hmHound');
  const eyes = [['35.3%', '25.6%'], ['77.1%', '23.4%']];
  hound.replaceChildren(h('div', { class: 'hm-halo' }),
    h('div', { class: 'hm-sprite' }, h('img', { src: LOGO, width: 140, height: 143, alt: '', draggable: 'false' }), ...eyes.map(([x, y]) => h('span', { class: 'hm-eye', style: `--x:${x};--y:${y}` }))),
    h('div', { class: 'hm-floor' }));

  function applyLang() {
    document.documentElement.lang = lang;
    for (const el of menu.querySelectorAll('[data-i18n]')) el.textContent = S()[el.dataset.i18n];
    for (const b of menu.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    const data = menu.querySelector('[data-slot="data"] button'); if (data) data.textContent = S().myData;
    $('hmOptionsBtn').setAttribute('aria-label', S().options);
    $('hmLang').setAttribute('aria-label', S().language);
    renderView();
  }
  for (const b of menu.querySelectorAll('[data-lang]')) b.onclick = () => { lang = b.dataset.lang; try { localStorage.setItem('orthros.lang', lang); } catch { /* no storage */ } applyLang(); };

  // options popover: placed under its button (top layer, closes on outside click and Escape by itself)
  const pop = $('hmOptions'), popBtn = $('hmOptionsBtn');
  pop.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    const r = popBtn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 10}px`; pop.style.right = `${Math.max(12, innerWidth - r.right)}px`;
  });

  // the header turns opaque once the page scrolls under it
  on(menu, 'scroll', () => nav.classList.toggle('scrolled', menu.scrollTop > 8), { passive: true });

  // ---- the library
  const backdrops = $('hmBackdrops');
  function setBackdrop(name) { for (const b of backdrops.children) b.classList.toggle('on', b.dataset.name === name); }
  function heat(on_) { menu.toggleAttribute('data-hot', on_); } // (the hound's eyes flare while a game is under the pointer)

  const pref = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const savePref = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage disabled */ } };
  const chosen = (g) => g.variants.find((v) => v.name === pref('orthros.version.' + g.id) && v.available)
    ?? g.variants.find((v) => v.name === last && v.available)
    ?? g.variants.find((v) => v.available) ?? g.variants[0];
  const gameLang = (g, variant) => {
    const options = variant.languages ?? [], saved = pref('orthros.gameLanguage.' + g.id);
    return options.includes(saved) ? saved : options.includes(lang) ? lang : options[0] ?? null;
  };
  const play = (g) => { const v = chosen(g); if (v?.available) onPlay(v.name, gameLang(g, v)); };
  function playPill(g) { const el = h('button', { type: 'button', class: 'hm-play', onclick: () => play(g) }); el.innerHTML = `${ICON.play}<span>${S().play}</span>`; return el; }
  function card(g, i) {
    const v = chosen(g), title = g.title, ok = !!v?.available;
    const cover = h('div', { class: 'hm-cover' + (v?.cover ? '' : ' none') });
    if (v?.cover) cover.append(h('img', { src: `/api/cover/${encodeURIComponent(v.name)}`, alt: '', decoding: 'async', draggable: 'false', onload: (e) => e.target.classList.add('loaded') }));
    else cover.append(h('img', { src: LOGO, alt: '', class: 'loaded glyph', draggable: 'false' }));
    if (v.name === last && ok) cover.append(h('span', { class: 'hm-badge' }, S().lastPlayed));
    const choices = h('div', { class: 'hm-choices' });
    if (g.variants.length > 1) {
      const select = h('select', { 'aria-label': S().gameVersion, class: 'hm-version' },
        g.variants.map((item) => h('option', { value: item.name, disabled: !item.available }, item.version ?? item.name)));
      select.value = v.name;
      select.onchange = () => { savePref('orthros.version.' + g.id, select.value); renderGames(); grid.querySelector(`[data-name="${CSS.escape(g.id)}"] .hm-version`)?.focus(); };
      choices.append(h('label', {}, h('span', {}, S().gameVersion), select));
    } else if (v.version) choices.append(h('div', { class: 'hm-version-label' }, h('span', {}, S().gameVersion), h('strong', {}, v.version)));
    if (v.languages?.length) {
      const select = h('select', { 'aria-label': S().gameLanguage, class: 'hm-game-lang' },
        v.languages.map((code) => h('option', { value: code }, code === 'fr' ? 'Français' : 'English')));
      select.value = gameLang(g, v);
      select.onchange = () => savePref('orthros.gameLanguage.' + g.id, select.value);
      choices.append(h('label', {}, h('span', {}, S().gameLanguage), select));
    }
    const body = h('div', { class: 'hm-body' },
      h('h3', {}, title),
      h('p', {}, (lang === 'fr' ? v.descriptionFr : null) ?? v.description ?? ''), choices,
      h('div', { class: 'hm-foot-row' },
        h('span', { class: 'hm-meta', title: v.exe }, ok ? `${v.exe} · ${S().size(v.bytes)}` : S().missing),
        ok ? playPill(g) : null));
    const el = h('article', { class: 'hm-card' + (ok ? '' : ' unavailable'), 'data-name': g.id, style: `--i:${i}`, tabindex: ok ? 0 : -1, role: 'group', 'aria-label': title }, cover, body);
    if (ok) {
      el.onclick = (e) => { if (!e.target.closest('select, button, label')) play(g); };
      el.addEventListener('mouseenter', () => { setBackdrop(g.id); heat(true); });
      el.addEventListener('mouseleave', () => { setBackdrop(resume?.id ?? null); heat(false); });
      el.addEventListener('focus', () => { setBackdrop(g.id); heat(true); });
      el.addEventListener('blur', () => { setBackdrop(resume?.id ?? null); heat(false); });
    }
    return el;
  }

  /** What the library shows: placeholders while the games load, the error, the empty server, or the games. */
  function renderView() {
    const cta = $('hmCta');
    if (view.kind === 'loading') {
      cta.classList.add('hidden'); $('hmCount').textContent = '';
      grid.style.setProperty('--n', 2);
      grid.replaceChildren(...[0, 1].map((i) => h('div', { class: 'hm-card skeleton', style: `--i:${i}`, 'aria-hidden': 'true' }, h('div', { class: 'hm-cover' }), h('div', { class: 'hm-body' }, h('h3', {}, ' '), h('p', {}, ' ')))));
      grid.setAttribute('aria-busy', 'true');
    } else if (view.kind === 'error') {
      cta.classList.add('hidden'); $('hmCount').textContent = '';
      message('error', S().errorTitle, view.text, h('button', { class: 'hm-btn', onclick: view.retry }, S().retry));
    } else if (!games.length) {
      cta.classList.add('hidden'); $('hmCount').textContent = '';
      message('empty', S().emptyTitle, [S().emptyText + ' ', h('code', {}, 'orthros run <folder>')]);
    } else renderGames();
  }
  function renderGames() {
    const focused = document.activeElement?.dataset?.name;
    resume = games.find((g) => g.variants.some((v) => v.name === last && v.available)) ?? games.find((g) => chosen(g)?.available) ?? null;
    // hero button: resume the last game, or start the first one
    const cta = $('hmCta');
    cta.classList.toggle('hidden', !resume);
    if (resume) {
      cta.querySelector('small').textContent = chosen(resume)?.name === last ? S().resume : S().first;
      cta.querySelector('b').textContent = resume.title;
      cta.onclick = () => play(resume);
    }
    $('hmCount').textContent = S().games(games.length);
    // covers behind the page: the one of the game under the pointer, else the resumable one
    backdrops.replaceChildren(...games.filter((g) => chosen(g)?.cover && chosen(g)?.available).map((g) => h('div', { class: 'hm-bd', 'data-name': g.id, style: `background-image:url(/api/cover/${encodeURIComponent(chosen(g).name)})` })));
    setBackdrop(resume?.id ?? null);
    cards = games.map(card);
    grid.style.setProperty('--n', games.length);
    grid.replaceChildren(...cards);
    grid.setAttribute('aria-busy', 'false');
    if (focused) grid.querySelector(`[data-name="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function message(kind, title, text, action) {
    grid.style.setProperty('--n', 2);
    grid.replaceChildren(h('div', { class: 'hm-empty ' + kind },
      h('img', { src: LOGO, alt: '', width: 70, height: 71, draggable: 'false' }),
      h('div', {}, h('h3', {}, title), h('p', {}, text), action)));
    grid.setAttribute('aria-busy', 'false');
  }

  // ---- keyboard: arrows move between the games (nearest card in that direction), Enter / Space plays
  on(menu, 'keydown', (e) => {
    if (e.target.closest?.('#hmOptions, input, textarea, select')) return;
    const list = cards.filter((c) => !c.classList.contains('unavailable')), i = list.indexOf(document.activeElement);
    if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); play(games.find((g) => g.id === list[i].dataset.name)); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || !list.length) return;
    if (i < 0 && document.activeElement !== document.body && document.activeElement !== menu) return; // (arrows on a button stay the button's)
    e.preventDefault();
    if (i < 0) { (list.find((c) => c.dataset.name === resume?.id) ?? list[0]).focus(); return; }
    // (layout positions, not bounding boxes: the hover lift of a card must not make it look lower than its neighbour)
    const mid = (c) => [c.offsetLeft + c.offsetWidth / 2, c.offsetTop + c.offsetHeight / 2], [cx, cy] = mid(list[i]);
    let best = null, bestScore = Infinity;
    for (const c of list) {
      if (c === list[i]) continue;
      const [mx, my] = mid(c), dx = mx - cx, dy = my - cy;
      const along = { ArrowLeft: -dx, ArrowRight: dx, ArrowUp: -dy, ArrowDown: dy }[e.key], across = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx);
      if (along <= 8) continue;
      const score = along + across * 3;
      if (score < bestScore) { best = c; bestScore = score; }
    }
    best?.focus();
  });

  // ---- alive
  embers = startEmbers($('hmEmbers'), () => {
    const r = hound.getBoundingClientRect();
    return r.bottom > 40 && r.bottom < innerHeight + 60 ? { x: r.left + r.width * 0.15, y: r.bottom - r.height * 0.06, w: r.width * 0.7 } : null;
  });

  // ---- go
  applyLang();
  menu.classList.remove('hidden');

  return {
    /** The games to show (`last`: the one played last, for the badge and the resume button). */
    setGames(list, lastPlayed) {
      const groups = new Map();
      for (const variant of list) {
        const id = variant.gameId ?? variant.name;
        if (!groups.has(id)) groups.set(id, { id, title: variant.title, variants: [] });
        groups.get(id).variants.push(variant);
      }
      games = [...groups.values()];
      for (const group of games) group.variants.sort((a, b) => (b.versionOrder ?? 0) - (a.versionOrder ?? 0));
      last = lastPlayed; view = { kind: 'games' };
      applyLang();
      (cards.find((c) => c.dataset.name === resume?.id) ?? cards.find((c) => !c.classList.contains('unavailable')))?.focus({ preventScroll: true });
    },
    setError(text, retry) { view = { kind: 'error', text, retry }; renderView(); },
    setLoading() { view = { kind: 'loading' }; renderView(); },
    /** Leaves the screen for good (a game starts): the animations stop, the listeners go. */
    destroy() {
      embers?.stop(); for (const fn of cleanup) fn();
      menu.classList.add('hidden');
    },
  };
}
