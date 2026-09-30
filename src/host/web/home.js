// The home screen: hero (pixel wordmark, the hound, a resume button), the game library and the options. Only
// rendering and keyboard navigation live here — starting a game stays main.js's job (`onPlay`).
import { startEmbers } from './embers.js';
import { UI_LANGS, browserLangs, explicitLang, pickLang, endonym } from './lang.js';
import { h } from './dom.js';

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
    options: 'Options', myData: 'My data', language: 'Language', gameLanguage: 'Game language', gameLanguageShort: 'Language', gameVersion: 'Version', others: 'Others',
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
    options: 'Options', myData: 'Mes données', language: 'Langue', gameLanguage: 'Langue du jeu', gameLanguageShort: 'Langue', gameVersion: 'Version', others: 'Autres',
    offline: 'Copie hors ligne', offlineText: 'Télécharge tout le dossier du jeu dans le stockage du navigateur, en arrière-plan : les lancements suivants ne lisent plus rien sur le réseau.',
    log: 'Journal de débogage', logText: 'Affiche le journal de l’émulateur par-dessus le jeu.',
    keys: 'choisir', enter: 'jouer', foot: 'Tout s’exécute dans votre navigateur',
    size: (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} Go` : `${Math.round(b / 1e6)} Mo`),
  },
};

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

// ---------------------------------------------------------------- flags
// Drawn here as plain shapes on a 3:2 board (emoji flags are letters on Windows), one <symbol> each in a hidden sprite.
const bands = (dir, ...colors) => colors.map((c, i) => (dir === 'v' ? `<rect x="${i * 10}" width="10" height="20" fill="${c}"/>` : `<rect y="${i * 20 / colors.length}" width="30" height="${20 / colors.length + .01}" fill="${c}"/>`)).join('');
const FLAGS = {
  fr: bands('v', '#0055a4', '#fff', '#ef4135'),
  it: bands('v', '#009246', '#fff', '#ce2b37'),
  de: bands('h', '#111', '#dd0000', '#ffce00'),
  nl: bands('h', '#ae1c28', '#fff', '#21468b'),
  ru: bands('h', '#fff', '#0039a6', '#d52b1e'),
  pl: bands('h', '#fff', '#dc143c'),
  es: '<rect width="30" height="20" fill="#aa151b"/><rect y="5" width="30" height="10" fill="#f1bf00"/>',
  ja: '<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/>',
  // the Union Jack: blue board, white saltire, red saltire cut in counterchange, white then red cross
  en: '<symbol-viewbox 0 0 60 40/><clipPath id="hmf-gb-b"><path d="M0 0h60v40H0z"/></clipPath><clipPath id="hmf-gb-x"><path d="M30 20h30v20zM30 20v20H0zM30 20H0V0zM30 20V0h30z"/></clipPath>'
    + '<g clip-path="url(#hmf-gb-b)"><rect width="60" height="40" fill="#012169"/><path d="M0 0l60 40M60 0L0 40" stroke="#fff" stroke-width="8"/><path d="M0 0l60 40M60 0L0 40" clip-path="url(#hmf-gb-x)" stroke="#c8102e" stroke-width="5"/>'
    + '<path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="13"/><path d="M30 0v40M0 20h60" stroke="#c8102e" stroke-width="8"/></g>',
};
let spriteReady = false;
function flagEl(code) {
  if (!spriteReady) {
    spriteReady = true;
    const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sprite.setAttribute('aria-hidden', 'true'); sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    sprite.innerHTML = Object.entries(FLAGS).map(([c, body]) => `<symbol id="hmf-${c}" viewBox="${c === 'en' ? '0 0 60 40' : '0 0 30 20'}">${body.replace('<symbol-viewbox 0 0 60 40/>', '')}</symbol>`).join('');
    document.body.append(sprite);
  }
  const el = h('span', { class: 'hm-flag' + (FLAGS[code] ? '' : ' code'), 'aria-hidden': 'true' });
  if (FLAGS[code]) el.innerHTML = `<svg viewBox="0 0 30 20"><use href="#hmf-${code}" width="30" height="20"/></svg>`; else el.textContent = code.slice(0, 3).toUpperCase();
  return el;
}

// ---------------------------------------------------------------- a row of choices
/**
 * One row: its label, then the options as chips (flags for languages); past `max` options, the rest go into a select
 * ("Others") at the end. A single option is shown, not offered. `set(value)` moves the selection, `onPick` reports a choice.
 * @param {{ label: string, aria: string, items: { value: string, label?: string, flag?: string, title?: string, disabled?: boolean }[],
 *   max: number, more: string, onPick: (value: string) => void }} o
 */
function choiceRow({ label, aria, items, max, more, onPick }) {
  const solo = items.length === 1, shown = items.slice(0, max), rest = items.slice(max);
  const seg = h('div', { class: 'hm-seg', role: solo ? 'group' : 'radiogroup', 'aria-label': aria });
  for (const it of shown) {
    const inner = it.flag ? flagEl(it.flag) : it.label, common = { class: 'hm-opt' + (it.flag ? ' is-flag' : '') + (solo ? ' solo on' : ''), 'data-value': it.value, title: it.title ?? (it.flag ? it.label : null) };
    seg.append(solo ? h('span', { ...common, role: 'img', 'aria-label': it.title ?? it.label }, inner)
      : h('button', { ...common, type: 'button', role: 'radio', 'aria-label': it.flag ? (it.title ?? it.label) : null, disabled: it.disabled, onclick: () => onPick(it.value) }, inner));
  }
  const select = rest.length ? h('select', { class: 'hm-opt hm-more', 'aria-label': `${aria} — ${more}`, onchange: (e) => e.target.value && onPick(e.target.value) },
    h('option', { value: '', hidden: true }, more), rest.map((it) => h('option', { value: it.value, disabled: it.disabled }, it.label))) : null;
  if (select) seg.append(select);
  // left / right move between the options of the row (and choose, as in any group of radio buttons)
  seg.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.target.tagName === 'SELECT') return;
    const radios = [...seg.querySelectorAll('button.hm-opt:not(:disabled)')], i = radios.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault(); e.stopPropagation();
    const next = radios[(i + (e.key === 'ArrowLeft' ? -1 : 1) + radios.length) % radios.length];
    next.focus(); onPick(next.dataset.value);
  });
  const set = (value) => {
    if (!solo) {
      let on = null;
      for (const b of seg.querySelectorAll('.hm-opt[data-value]')) {
        const is = b.dataset.value === value;
        b.classList.toggle('on', is); b.setAttribute('aria-checked', String(is)); b.tabIndex = is ? 0 : -1;
        if (is) on = b;
      }
      if (!on) seg.querySelector('button.hm-opt:not(:disabled)')?.setAttribute('tabindex', '0'); // (the chosen one is in the select: the row stays reachable)
    }
    if (select) { const inRest = rest.some((it) => it.value === value); select.value = inRest ? value : ''; select.classList.toggle('on', inRest); }
  };
  return { el: h('div', { class: 'hm-row' }, h('span', { class: 'hm-row-label' }, label), seg), set };
}

/** Options shown as chips in a row before the rest go into the "Others" select. */
const MAX_VERSIONS = 3, MAX_LANGS = 6;

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
  let lang = pickLang(), explicit = explicitLang(), games = [], last = null, cards = [], resume = null, embers = null, drawn = false;
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
  // the flags of the languages the page speaks: the browser's language is the default, a click chooses (and is remembered)
  $('hmLang').replaceChildren(...UI_LANGS.map((code) => h('button', { type: 'button', 'data-lang': code, lang: code, title: endonym(code), 'aria-label': endonym(code),
    onclick: () => { lang = explicit = code; try { localStorage.setItem('orthros.lang', code); } catch { /* no storage */ } applyLang(); } }, flagEl(code))));

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
  /** The game's language for this version: the visitor's last choice, else the page's / the browser's language if the game has it. */
  const gameLang = (g, variant) => {
    const options = variant.languages ?? [], saved = pref('orthros.gameLanguage.' + g.id);
    if (options.includes(saved)) return saved;
    const wanted = explicit ? [explicit, ...browserLangs()] : [...browserLangs(), lang];
    return wanted.find((l) => options.includes(l)) ?? (options.includes('en') ? 'en' : options[0] ?? null);
  };
  const play = (g) => { const v = chosen(g); if (v?.available) onPlay(v.name, gameLang(g, v)); };
  function playPill(g) { const el = h('button', { type: 'button', class: 'hm-play', onclick: () => play(g) }); el.innerHTML = `${ICON.play}<span>${S().play}</span>`; return el; }

  // the cover of the game's chosen version behind the page (added, updated or removed as the choice changes)
  function syncBackdrop(g) {
    const v = chosen(g), d = [...backdrops.children].find((b) => b.dataset.name === g.id);
    if (!v?.cover || !v.available) { d?.remove(); return; }
    const bd = d ?? backdrops.appendChild(h('div', { class: 'hm-bd', 'data-name': g.id }));
    bd.style.backgroundImage = `url(/api/cover/${encodeURIComponent(v.name)})`;
  }
  /** The hero button: resume the last game, or start the first one. */
  function renderCta() {
    resume = games.find((g) => g.variants.some((v) => v.name === last && v.available)) ?? games.find((g) => chosen(g)?.available) ?? null;
    const cta = $('hmCta');
    cta.classList.toggle('hidden', !resume);
    if (!resume) return;
    cta.querySelector('small').textContent = chosen(resume)?.name === last ? S().resume : S().first;
    cta.querySelector('b').textContent = resume.title;
    cta.onclick = () => play(resume);
  }

  function card(g, i) {
    const el = h('article', { class: 'hm-card' + (drawn ? ' still' : ''), 'data-name': g.id, style: `--i:${i}`, role: 'group', 'aria-label': g.title });
    const cover = h('div', { class: 'hm-cover' }), desc = h('p'), meta = h('span', { class: 'hm-meta' }), playBtn = playPill(g), langSlot = h('div', { class: 'hm-slot' });
    let shown = null, langRow = null;
    // one row for the versions (chips, the oldest in a select past three), one for the game's languages (flags)
    const versions = g.variants.length && g.variants.some((v) => v.version) ? choiceRow({ label: S().gameVersion, aria: S().gameVersion, max: MAX_VERSIONS, more: S().others,
      items: g.variants.map((v) => ({ value: v.name, label: v.version ?? v.name, disabled: !v.available, title: v.available ? null : S().missing })),
      onPick: (name) => { savePref('orthros.version.' + g.id, name); sync(); syncBackdrop(g); setBackdrop(g.id); renderCta(); } }) : null;

    /** Everything that depends on the chosen version: cover, text, size, languages. */
    function sync() {
      const v = chosen(g), ok = !!v?.available;
      el.classList.toggle('unavailable', !ok); el.tabIndex = ok ? 0 : -1;
      cover.classList.toggle('none', !v?.cover);
      const src = v?.cover ? `/api/cover/${encodeURIComponent(v.name)}` : LOGO;
      if (src !== shown) { // (the new image fades in over the old one)
        shown = src;
        const img = h('img', { src, alt: '', decoding: 'async', draggable: 'false', class: v?.cover ? '' : 'glyph' });
        const put = () => { const old = [...cover.querySelectorAll('img')]; cover.insertBefore(img, cover.querySelector('.hm-badge')); requestAnimationFrame(() => { img.classList.add('loaded'); setTimeout(() => old.forEach((o) => o.remove()), 700); }); };
        if (v?.cover) img.onload = put; else put();
      }
      cover.querySelector('.hm-badge')?.remove();
      if (v?.name === last && ok) cover.append(h('span', { class: 'hm-badge' }, S().lastPlayed));
      desc.textContent = (lang === 'fr' ? v?.descriptionFr : null) ?? v?.description ?? '';
      meta.textContent = ok ? `${v.exe} · ${S().size(v.bytes)}` : S().missing; meta.title = v?.exe ?? '';
      playBtn.hidden = !ok;
      versions?.set(v?.name);
      langRow = v?.languages?.length ? choiceRow({ label: S().gameLanguageShort, aria: S().gameLanguage, max: MAX_LANGS, more: S().others,
        items: v.languages.map((code) => ({ value: code, flag: code, label: endonym(code) })),
        onPick: (code) => { savePref('orthros.gameLanguage.' + g.id, code); langRow.set(code); } }) : null;
      langRow?.set(gameLang(g, v));
      langSlot.replaceChildren(...(langRow ? [langRow.el] : []));
    }

    el.append(cover, h('div', { class: 'hm-body' }, h('h3', {}, g.title), desc,
      h('div', { class: 'hm-choices' }, versions?.el, langSlot),
      h('div', { class: 'hm-foot-row' }, meta, playBtn)));
    sync();
    el.onclick = (e) => { if (chosen(g)?.available && !e.target.closest('select, button, label')) play(g); };
    for (const [type, fn] of [['mouseenter', () => { if (chosen(g)?.available) { setBackdrop(g.id); heat(true); } }], ['mouseleave', () => { setBackdrop(resume?.id ?? null); heat(false); }],
      ['focus', () => { if (chosen(g)?.available) { setBackdrop(g.id); heat(true); } }], ['blur', () => { setBackdrop(resume?.id ?? null); heat(false); }]]) el.addEventListener(type, fn);
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
    renderCta();
    $('hmCount').textContent = S().games(games.length);
    // covers behind the page: the one of the game under the pointer, else the resumable one
    backdrops.replaceChildren();
    for (const g of games) syncBackdrop(g);
    setBackdrop(resume?.id ?? null);
    cards = games.map(card);
    drawn = true; // (later drawings — a language change — do not replay the entrance)
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
