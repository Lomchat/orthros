// The multiplayer lobby of a browser port's page (docs/browser-ports.md): the games running on the version's servers —
// its permanent one and those players created — with their map and players, joined in a click, and the form that
// creates one on the Orthros server (/api/rooms/<manifest>): a name, a map picked on its picture (the game's own
// overview, /api/map-image) among the version's map groups (multiplayer.mapGroups: a game's classic modes), a size,
// bots, and the version's options (rooms.options: the bots' team, the starting money…), the chosen map large beside
// them with a summary of the game. The same element shows in the loading screen and over the game (the header's
// button). Nothing here names a game: maps, groups, options and their labels come from the server.

const STRINGS = {
  en: {
    title: 'Online games', create: '+ Create a game', join: 'Join', full: 'Full', starting: 'Starting…',
    close: 'Close', closing: 'Closing…', mine: 'your game', closeConfirm: (n) => `Close “${n}”? Its players go back to the menu.`, closeFailed: 'The game could not be closed.',
    players: (n, max) => `${n}/${max} players`, bots: (n) => `${n} bot${n > 1 ? 's' : ''}`, permanent: 'Always on', since: (m) => (m < 1 ? 'just created' : `created ${m} min ago`),
    empty: 'No game yet: create the first one.', offline: 'The game servers are not reachable right now.', online: (n) => `${n} playing`,
    name: 'Name', map: 'Map', size: 'Players', botsLabel: 'Bots', none: 'None', cancel: 'Cancel', submit: 'Create and join', maps: (n) => `${n} maps`,
    defaultName: (nick) => `${nick}'s game`, creating: 'Creating the game…', less: 'fewer', more: 'more',
    createTitle: 'Create a game', createLead: 'Pick a map and the rules: the game starts on the server, and anyone can join it from this list.',
    stepName: 'Name', stepMap: 'Map', stepRules: 'Rules', all: 'All', other: 'Other maps', summary: 'Your game', noName: 'Unnamed',
    slots: (free, bots) => `${free} place${free > 1 ? 's' : ''} for players` + (bots ? ` · ${bots} bot${bots > 1 ? 's' : ''}` : ''),
    errors: { name: 'Give it a name (2 characters at least).', map: 'Choose a map.', maxPlayers: 'Invalid number of players.', bots: 'Too many bots for that many players.', options: 'Invalid settings.',
      taken: 'A game already has that name.', owned: 'You already have a game running: join it, or wait for it to end.', ownedHere: 'You already have a game running: join it, or close it.', full: 'Every game slot is taken: join one, or wait for one to end.', wait: 'A game is already being created: wait a moment.',
      start: 'The game server did not start. Try again.', offline: 'The game servers are not reachable right now.', forbidden: 'Creating games is not offered here.', signin: 'Sign in to Orthros to create a game.' },
  },
  fr: {
    title: 'Parties en ligne', create: '+ Créer une partie', join: 'Rejoindre', full: 'Pleine', starting: 'Démarrage…',
    close: 'Fermer', closing: 'Fermeture…', mine: 'ta partie', closeConfirm: (n) => `Fermer « ${n} » ? Ses joueurs reviennent au menu.`, closeFailed: 'La partie n’a pas pu être fermée.',
    players: (n, max) => `${n}/${max} joueurs`, bots: (n) => `${n} bot${n > 1 ? 's' : ''}`, permanent: 'Permanente', since: (m) => (m < 1 ? 'à l’instant' : `créée il y a ${m} min`),
    empty: 'Aucune partie pour l’instant : crée la première.', offline: 'Les serveurs de jeu sont injoignables pour le moment.', online: (n) => `${n} en jeu`,
    name: 'Nom', map: 'Carte', size: 'Joueurs', botsLabel: 'Bots', none: 'Aucun', cancel: 'Annuler', submit: 'Créer et rejoindre', maps: (n) => `${n} cartes`,
    defaultName: (nick) => `Partie de ${nick}`, creating: 'Création de la partie…', less: 'moins', more: 'plus',
    createTitle: 'Créer une partie', createLead: 'Choisis une carte et les règles : la partie démarre sur le serveur, et chacun peut la rejoindre depuis cette liste.',
    stepName: 'Nom', stepMap: 'Carte', stepRules: 'Règles', all: 'Toutes', other: 'Autres cartes', summary: 'Ta partie', noName: 'Sans nom',
    slots: (free, bots) => `${free} place${free > 1 ? 's' : ''} pour des joueurs` + (bots ? ` · ${bots} bot${bots > 1 ? 's' : ''}` : ''),
    errors: { name: 'Donne-lui un nom (2 caractères au moins).', map: 'Choisis une carte.', maxPlayers: 'Nombre de joueurs invalide.', bots: 'Trop de bots pour ce nombre de joueurs.', options: 'Réglages invalides.',
      taken: 'Une partie porte déjà ce nom.', owned: 'Tu as déjà une partie en cours : rejoins-la, ou attends qu’elle se termine.', ownedHere: 'Tu as déjà une partie en cours : rejoins-la, ou ferme-la.', full: 'Toutes les places de parties sont prises : rejoins-en une, ou attends qu’une se termine.', wait: 'Une partie est déjà en cours de création : patiente un instant.',
      start: 'Le serveur de jeu n’a pas démarré. Réessaie.', offline: 'Les serveurs de jeu sont injoignables pour le moment.', forbidden: 'La création de parties n’est pas proposée ici.', signin: 'Connecte-toi à Orthros pour créer une partie.' },
  },
};

/**
 * A map's picture as a small image for the lobby: the game's overview drawn smaller, its keyed colour (pure green, which
 * the game shows as transparent) turned into the panel's dark; kept for the page's life. Null when there is none.
 */
const thumbs = new Map();
export function mapThumb(name, map, w = 240) {
  const key = `${name}/${map}/${w}`;
  if (!thumbs.has(key)) thumbs.set(key, new Promise((resolve) => {
    const img = new Image(); img.decoding = 'async';
    img.onload = () => {
      try {
        // (the key replaced at full size, before smoothing blends it into its neighbours: no green fringe)
        const W = img.naturalWidth, H = img.naturalHeight, full = document.createElement('canvas'); full.width = W; full.height = H;
        const f = full.getContext('2d', { willReadFrequently: true }); f.drawImage(img, 0, 0);
        const px = f.getImageData(0, 0, W, H), d = px.data;
        for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 230 && d[i] < 40 && d[i + 2] < 40) { d[i] = 22; d[i + 1] = 24; d[i + 2] = 30; }
        f.putImageData(px, 0, 0);
        const h = Math.round(w * H / Math.max(1, W)), c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(full, 0, 0, w, h);
        resolve(c.toDataURL('image/webp', 0.85));
      } catch { thumbs.delete(key); resolve(null); }
    };
    img.onerror = () => { thumbs.delete(key); resolve(null); }; // (tried again next time)
    img.src = `/api/map-image/${encodeURIComponent(name)}/${encodeURIComponent(map)}`;
  }));
  return thumbs.get(key);
}

/**
 * The maps by group (multiplayer.mapGroups, in their order, then the others under `group: null`), each group's maps
 * sorted: a map goes to the first group naming it in `maps`, else to the first with one of its `prefix`es (any case).
 * Groups left empty are dropped.
 */
export function groupMaps(maps, groups = []) {
  const low = (v) => String(v).toLowerCase();
  const of = (m) => {
    const named = groups.findIndex((g) => (g.maps ?? []).some((n) => low(n) === low(m)));
    return named >= 0 ? named : groups.findIndex((g) => [g.prefix ?? []].flat().some((p) => low(m).startsWith(low(p))));
  };
  const sections = groups.map((group) => ({ group, maps: [] })), rest = { group: null, maps: [] };
  for (const m of maps) { const i = of(m); (i >= 0 ? sections[i] : rest).maps.push(m); }
  const byName = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
  return [...sections, rest].filter((s) => s.maps.length).map((s) => ({ ...s, maps: s.maps.sort(byName) }));
}

/** The address the page's engine reaches a room at: the relay routes it (play.js Relay). */
export const roomAddress = (index) => `10.87.0.${index + 1}:27015`;

const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v); }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};

/**
 * The lobby of a version: `onJoin(room)` when the player joins one; `nickname()` the player's name (the default game
 * name); `signedIn()` whether an Orthros account is signed in — multiplayer is for signed-in players: joining or
 * creating without one calls `needAccount()` instead. Returns its element and what shows, hides and refreshes it.
 */
export function createLobby({ name, lang, onJoin, nickname, signedIn = () => true, needAccount = () => {}, log = () => {} }) {
  const S = STRINGS[lang] ?? STRINGS.en;
  const label = (l) => (typeof l === 'string' ? l : l?.[lang] ?? l?.en ?? Object.values(l ?? {})[0] ?? '');
  const list = el('ul', { class: 'lb-rooms' }), note = el('p', { class: 'lb-note' }), online = el('span', { class: 'lb-online' });
  const nameInput = el('input', { id: `lb-name-${name}`, maxlength: '32', required: true, autocomplete: 'off', spellcheck: 'false' });
  const mapsGrid = el('div', { class: 'lb-maps', role: 'listbox', 'aria-label': S.map }), mapsCount = el('span', { class: 'lb-count' });
  const chips = el('div', { class: 'lb-chips hidden', role: 'radiogroup', 'aria-label': S.map });
  const settings = el('div', { class: 'lb-settings' }), message = el('p', { class: 'lb-msg', role: 'status', id: `lb-msg-${name}` });
  const nameError = el('p', { class: 'lb-fielderr hidden', id: `lb-nameerr-${name}` });
  const submit = el('button', { type: 'submit', class: 'primary' }, S.submit);
  // (the chosen map, large, and the game as it will be)
  const previewImgs = el('div', { class: 'lb-pv-imgs' }), previewNoImg = el('span', { class: 'lb-noimg' });
  const previewBadge = el('span', { class: 'lb-badge hidden' }), previewName = el('b', { class: 'lb-pv-name' }), previewMap = el('span', { class: 'lb-pv-map' });
  const previewDesc = el('p', { class: 'lb-pv-desc hidden' }), summary = el('dl', { class: 'lb-summary' }), slots = el('div', { class: 'lb-slots', 'aria-hidden': 'true' }), slotsText = el('p', { class: 'lb-slotstext' });
  const heading = (n, text, ...extra) => el('h4', { class: 'lb-step-title' }, el('span', { class: 'lb-num', 'aria-hidden': 'true' }, String(n)), text, ...extra);
  const form = el('form', { class: 'lb-create hidden', 'aria-labelledby': `lb-title-${name}` },
    el('div', { class: 'lb-formhead' }, el('h4', { id: `lb-title-${name}` }, S.createTitle), el('p', {}, S.createLead)),
    el('div', { class: 'lb-main' },
      el('section', { class: 'lb-sec lb-namesec' }, heading(1, el('label', { for: nameInput.id }, S.stepName)), nameInput, nameError),
      el('section', { class: 'lb-sec lb-mapsec' }, heading(2, S.stepMap, mapsCount), chips, mapsGrid),
      el('section', { class: 'lb-sec lb-rulesec' }, heading(3, S.stepRules), settings)),
    el('aside', { class: 'lb-side' },
      el('div', { class: 'lb-ticket' },
        el('div', { class: 'lb-preview' }, previewNoImg, previewImgs, previewBadge, el('div', { class: 'lb-pv-caption' }, previewName, previewMap)),
        previewDesc,
        el('div', { class: 'lb-sumhead' }, S.summary),
        summary, slots, slotsText)),
    // (the buttons below the form, kept in view while it scrolls)
    el('div', { class: 'lb-actions' }, message, el('div', { class: 'lb-buttons' }, el('button', { type: 'button', class: 'lb-cancel', onclick: () => toggleForm(false) }, S.cancel), submit)));
  const createButton = el('button', { type: 'button', class: 'lb-new', onclick: () => toggleForm(true) }, S.create);
  const root = el('section', { class: 'lobby' }, el('header', {}, el('h3', {}, S.title), online, createButton), form, list, note);
  let data = null, timer = null, busy = false, filled = false;
  // (the form's choices)
  const choice = { map: null, maxPlayers: 10, bots: 0, options: {} };
  const steppers = {}, segments = {};
  let groupOf = () => null; // (a map's group, once the maps are known)

  function toggleForm(open) {
    if (open && !signedIn()) { needAccount(); return; }
    const was = !form.classList.contains('hidden');
    form.classList.toggle('hidden', !open); createButton.classList.toggle('hidden', open); root.classList.toggle('creating', open); clearError();
    if (open) {
      if (!nameInput.value) nameInput.value = S.defaultName(nickname()).slice(0, 32);
      syncSummary();
      root.scrollIntoView({ block: 'start' });
      nameInput.focus({ preventScroll: true }); nameInput.select();
      showChosen();
    } else if (was) createButton.focus({ preventScroll: true });
  }
  /**
   * The chosen map's card scrolled into the maps' view, below its group's title (the maps' scroll-padding-top) — its
   * group from the top when the card shows so. (Offsets: the maps' box is the cards' offset parent.)
   */
  function showChosen() {
    const chosen = mapsGrid.querySelector('.lb-map[aria-selected="true"]'), group = chosen?.closest('.lb-group'); if (!chosen || group.classList.contains('hidden')) return;
    const pad = parseFloat(getComputedStyle(mapsGrid).scrollPaddingTop) || 0;
    mapsGrid.scrollTop = Math.max(0, chosen.offsetTop + chosen.offsetHeight - group.offsetTop <= mapsGrid.clientHeight ? group.offsetTop : chosen.offsetTop - pad);
  }
  /** The form closed (Escape: the overlay's own handler asks first). True when it showed. */
  function closeForm() {
    if (form.classList.contains('hidden')) return false;
    if (!busy) toggleForm(false);
    return true;
  }
  form.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeForm(); } });
  nameInput.addEventListener('input', () => { if (nameInput.hasAttribute('aria-invalid')) clearError(); syncSummary(); });

  /** An error the server returned: below the buttons, and on its field when it has one (marked, described, focused). */
  function showError(text, field) {
    message.textContent = text; message.classList.add('error');
    const control = field === 'name' || field === 'taken' ? nameInput : field === 'map' ? mapsGrid.querySelector('.lb-map[tabindex="0"]')
      : field === 'bots' || field === 'maxPlayers' ? settings.querySelector('.lb-step button:not(:disabled)') : null;
    if (!control) return;
    control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', control === nameInput ? nameError.id : message.id);
    if (control === nameInput) { nameError.textContent = text; nameError.classList.remove('hidden'); }
    control.focus();
  }
  function clearError() {
    message.textContent = ''; message.classList.remove('error'); nameError.classList.add('hidden');
    for (const c of form.querySelectorAll('[aria-invalid]')) { c.removeAttribute('aria-invalid'); c.removeAttribute('aria-describedby'); }
  }

  /** A number chosen with − and +, within [min(), max()]. */
  function stepper(key, title, min, max) {
    const value = el('output', { 'aria-live': 'polite' }), minus = el('button', { type: 'button', 'aria-label': `${title} ${S.less}` }, '−'), plus = el('button', { type: 'button', 'aria-label': `${title} ${S.more}` }, '+');
    const sync = () => { choice[key] = Math.min(max(), Math.max(min(), choice[key])); value.textContent = key === 'bots' && !choice.bots ? S.none : String(choice[key]); minus.disabled = choice[key] <= min(); plus.disabled = choice[key] >= max(); };
    minus.onclick = () => { choice[key]--; syncAll(); }; plus.onclick = () => { choice[key]++; syncAll(); };
    steppers[key] = sync;
    return el('div', { class: 'lb-row lb-steprow' }, el('span', { class: 'lb-label' }, title), el('div', { class: 'lb-step', role: 'group', 'aria-label': title }, minus, value, plus));
  }
  /** One of an option's choices, as buttons side by side. */
  function segmented(option) {
    const row = el('div', { class: 'lb-seg', role: 'radiogroup', 'aria-label': label(option.label), style: `--n: ${option.choices.length}` });
    for (const c of option.choices) row.append(el('button', { type: 'button', role: 'radio', 'data-id': c.id, title: label(c.label), onclick: () => { choice.options[option.id] = c.id; syncAll(); } }, label(c.label)));
    arrows(row, () => [...row.children], (b) => { choice.options[option.id] = b.dataset.id; syncAll(); });
    const field = el('div', { class: 'lb-row' + (option.choices.length > 3 ? ' wide' : '') }, el('span', { class: 'lb-label' }, label(option.label)), row);
    segments[option.id] = () => {
      field.classList.toggle('hidden', !!option.bots && !choice.bots);
      for (const b of row.children) { const on = b.dataset.id === choice.options[option.id]; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    };
    return field;
  }
  function syncAll() {
    if (message.classList.contains('error')) clearError();
    for (const f of Object.values(steppers)) f();
    for (const f of Object.values(segments)) f();
    steppers.maxPlayers?.(); // (the bots' maximum depends on the size, and the other way)
    syncSummary();
  }
  /** The summary beside the form: the game's name over its map, its size, bots and options. */
  function syncSummary() {
    previewName.textContent = nameInput.value.trim() || S.noName;
    const group = groupOf(choice.map);
    previewMap.textContent = choice.map ?? '';
    previewBadge.replaceChildren(...badgeContent(group, true)); previewBadge.classList.toggle('hidden', !group);
    previewDesc.textContent = group?.description ? label(group.description) : ''; previewDesc.classList.toggle('hidden', !group?.description);
    const rows = [[S.size, String(choice.maxPlayers)]];
    if (data?.bots) rows.push([S.botsLabel, choice.bots ? String(choice.bots) : S.none]);
    for (const o of data?.options ?? []) {
      if (o.bots && !choice.bots) continue;
      rows.push([label(o.label), label(o.choices.find((c) => c.id === choice.options[o.id])?.label)]);
    }
    summary.replaceChildren(...rows.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
    const free = Math.max(0, choice.maxPlayers - choice.bots);
    slots.replaceChildren(...Array.from({ length: choice.maxPlayers }, (_, i) => el('i', { class: i < free ? 'free' : 'bot' })));
    slotsText.textContent = S.slots(free, choice.bots);
  }
  /** A group's badge: its icon and its short label (or its label). */
  const badgeContent = (group, long = false) => (group ? [group.icon ? el('span', { class: 'lb-icon' }, group.icon) : null, label(long ? group.label : group.short ?? group.label)] : []);
  /**
   * The chosen map's picture: the card's (already drawn) at once, then the larger one, each faded in over the previous
   * map's, which stays until then; its name over a pattern only when it has no picture.
   */
  let previewFor = null, previewWidth = 0;
  function showPreview(map) {
    previewFor = map; previewWidth = 0; previewNoImg.textContent = map.replace(/^[a-z]+_/, '');
    if (!data?.mapImages) { previewImgs.replaceChildren(); return; }
    let failed = 0;
    for (const w of [240, 640]) mapThumb(name, map, w).then((url) => {
      if (previewFor !== map) return;
      if (!url) { if (++failed === 2) previewImgs.replaceChildren(); return; }
      if (w < previewWidth) return;
      previewWidth = w;
      const img = el('img', { src: url, alt: '', draggable: 'false' }); previewImgs.append(img);
      setTimeout(() => { if (img.isConnected) while (previewImgs.firstChild !== img) previewImgs.firstChild.remove(); }, 400); // (after its fade)
    });
  }
  function pickMap(map) {
    choice.map = map;
    for (const card of mapsGrid.querySelectorAll('.lb-map')) { card.setAttribute('aria-selected', String(card.dataset.map === map)); card.tabIndex = card.dataset.map === map ? 0 : -1; }
    if (previewFor !== map) showPreview(map);
    if (message.classList.contains('error')) clearError();
    syncSummary();
  }
  /**
   * Arrows, Home and End move the choice within a group (one Tab stop each: the chosen element). In a grid (`grid`),
   * up and down go to the nearest element of the row above or below, as drawn (rows broken by the groups' titles).
   */
  function arrows(container, items, pick, grid = false) {
    container.addEventListener('keydown', (event) => {
      const list = items(), i = list.indexOf(document.activeElement); if (i < 0) return;
      let next;
      if (grid && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) next = nearestRow(list, list[i], event.key === 'ArrowDown' ? 1 : -1);
      else {
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[event.key];
        if (step === undefined) return;
        next = list[Math.max(0, Math.min(list.length - 1, i + step))];
      }
      event.preventDefault();
      pick(next); next.focus(); next.scrollIntoView({ block: 'nearest' });
    });
  }
  function nearestRow(list, from, dir) {
    const r = from.getBoundingClientRect(), cx = r.left + r.width / 2;
    const boxes = list.map((e) => [e, e.getBoundingClientRect()]).filter(([, b]) => (dir > 0 ? b.top >= r.bottom - 2 : b.bottom <= r.top + 2));
    if (!boxes.length) return from;
    const top = dir > 0 ? Math.min(...boxes.map(([, b]) => b.top)) : Math.max(...boxes.map(([, b]) => b.top));
    const row = boxes.filter(([, b]) => Math.abs(b.top - top) < 2);
    return row.reduce((best, cur) => (Math.abs(cur[1].left + cur[1].width / 2 - cx) < Math.abs(best[1].left + best[1].width / 2 - cx) ? cur : best))[0];
  }
  const visibleCards = () => [...mapsGrid.querySelectorAll('.lb-map')].filter((c) => !c.closest('.lb-group.hidden'));
  arrows(mapsGrid, visibleCards, (card) => pickMap(card.dataset.map), true);

  function fillForm() {
    if (filled || !data?.maps?.length) return;
    filled = true;
    mapsCount.textContent = S.maps(data.maps.length);
    const sections = groupMaps(data.maps, data.mapGroups ?? []), grouped = sections.some((s) => s.group);
    const mapGroup = new Map(sections.flatMap((s) => s.maps.map((m) => [m, s.group])));
    groupOf = (m) => mapGroup.get(m) ?? null;
    // (a card a map: its picture when the version has them, its name over a pattern otherwise or when it fails)
    // (the pictures when a card comes into view: a few hundred kilobytes each)
    const seen = data.mapImages && 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        seen.unobserve(e.target);
        mapThumb(name, e.target.dataset.map).then((url) => { if (url) e.target.prepend(el('img', { src: url, alt: '', draggable: 'false' })); else setTimeout(() => seen.observe(e.target), 15000); });
      }
    }, { rootMargin: '120px', scrollMargin: '120px' }) : null; // (in the window, as the maps' box and the page's clip them)
    // (a section a group, its title above its cards; the others last. Without groups, the cards alone)
    const groupEls = sections.map((s, n) => {
      const cards = s.maps.map((m) => {
        const card = el('button', { type: 'button', class: 'lb-map', role: 'option', 'data-map': m, title: m, onclick: () => pickMap(m) },
          el('span', { class: 'lb-noimg' }, m.replace(/^[a-z]+_/, '')), s.group ? el('span', { class: 'lb-badge' }, ...badgeContent(s.group)) : null, el('span', { class: 'lb-mapname' }, m));
        seen?.observe(card);
        return card;
      });
      const id = `lb-g-${name}-${n}`;
      return el('div', { class: 'lb-group', role: 'group', 'aria-labelledby': grouped ? id : undefined, 'data-group': s.group?.id ?? '' },
        grouped ? el('div', { class: 'lb-grouptitle', id }, s.group?.icon ? el('span', { class: 'lb-icon' }, s.group.icon) : null, el('span', {}, s.group ? label(s.group.label) : S.other), el('span', { class: 'lb-count' }, String(s.maps.length))) : null,
        el('div', { class: 'lb-cards' }, ...cards));
    });
    mapsGrid.append(...groupEls);
    // (the groups as filters above the maps: all, or one)
    if (grouped) {
      const filter = (id) => {
        for (const g of groupEls) g.classList.toggle('hidden', id !== null && g.dataset.group !== id);
        for (const c of chips.children) { const on = c.dataset.group === (id ?? '*'); c.setAttribute('aria-checked', String(on)); c.tabIndex = on ? 0 : -1; }
        mapsGrid.scrollTop = 0;
        // (one Tab stop in the maps still: the chosen one, else the first shown)
        for (const c of mapsGrid.querySelectorAll('.lb-map')) c.tabIndex = c.dataset.map === choice.map ? 0 : -1;
        const shown = visibleCards(); if (shown.length && !shown.some((c) => c.tabIndex === 0)) shown[0].tabIndex = 0;
      };
      const chip = (id, text, count, icon) => el('button', { type: 'button', class: 'lb-chip', role: 'radio', 'data-group': id, 'aria-checked': 'false', onclick: () => filter(id === '*' ? null : id) },
        icon ? el('span', { class: 'lb-icon' }, icon) : null, text, el('span', { class: 'lb-count' }, String(count)));
      chips.append(chip('*', S.all, data.maps.length), ...sections.map((s) => chip(s.group?.id ?? '', s.group ? label(s.group.label) : S.other, s.maps.length, s.group?.icon)));
      arrows(chips, () => [...chips.children], (c) => filter(c.dataset.group === '*' ? null : c.dataset.group));
      chips.classList.remove('hidden'); filter(null);
    }
    const first = data.rooms?.find((r) => r.permanent)?.map;
    pickMap(data.maps.includes(first) ? first : sections[0].maps[0]);
    const maxPlayers = data.maxPlayers ?? 16;
    choice.maxPlayers = Math.min(10, maxPlayers); choice.bots = data.bots ? Math.min(4, data.bots.max) : 0;
    const counts = el('div', { class: 'lb-counts' }, stepper('maxPlayers', S.size, () => Math.max(2, choice.bots + 1), () => maxPlayers));
    if (data.bots) counts.append(stepper('bots', S.botsLabel, () => 0, () => Math.min(data.bots.max, choice.maxPlayers - 1)));
    settings.append(counts);
    for (const o of data.options ?? []) { choice.options[o.id] = o.default; settings.append(segmented(o)); }
    syncAll();
  }

  // (the rooms this browser created: their keys, kept to close them — index -> { key, since })
  const keysName = `orthros-rooms:${name}`;
  const keys = () => { try { return JSON.parse(localStorage.getItem(keysName) ?? '{}') ?? {}; } catch { return {}; } };
  const saveKeys = (k) => { try { localStorage.setItem(keysName, JSON.stringify(k)); } catch { /* private mode: not kept */ } };
  let closeFailedAt = 0; const closingNow = new Set(); // (rooms whose closing this page sent: their button stays disabled)
  const keyOf = (r) => { const k = keys()[r.index]; return k && k.since === r.since ? k.key : null; };
  async function closeRoom(r, button) {
    const key = keyOf(r); if (!key || !confirm(S.closeConfirm(r.name))) return;
    if (closingNow.has(r.index)) return;
    closingNow.add(r.index); button.disabled = true; button.textContent = S.closing;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(name)}/${r.index}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      if (res.status !== 200 && res.status !== 404) throw new Error(String(res.status));
      const k = keys(); delete k[r.index]; saveKeys(k);
    } catch (error) { log('Lobby: closing ' + error.message); closeFailedAt = Date.now(); }
    closingNow.delete(r.index);
    await refresh();
  }

  /** The room's shown settings (its options with `show`), by their labels. */
  const shownOptions = (r) => (data?.options ?? []).filter((o) => o.show && (!o.bots || r.bots > 0) && r.options?.[o.id]).map((o) => label(o.choices.find((c) => c.id === r.options[o.id])?.label));
  function render() {
    const rooms = data?.rooms ?? [];
    const humans = rooms.reduce((t, r) => t + r.humans, 0);
    online.textContent = humans ? S.online(humans) : '';
    createButton.classList.toggle('hidden', !data?.creatable || !form.classList.contains('hidden'));
    note.textContent = data?.offline ? S.offline : Date.now() - closeFailedAt < 8000 ? S.closeFailed : !rooms.length ? S.empty : '';
    list.replaceChildren(...rooms.map((r) => {
      const full = r.players >= r.maxPlayers;
      const meta = [r.map, S.players(r.players, r.maxPlayers), r.bots ? S.bots(r.bots) : null, ...shownOptions(r), r.permanent ? S.permanent : S.since(Math.floor((Date.now() - r.since) / 60000))].filter(Boolean).join(' · ');
      const thumb = data?.mapImages ? el('span', { class: 'thumb' }) : null;
      if (thumb) mapThumb(name, r.map).then((url) => { if (url) thumb.style.backgroundImage = `url(${url})`; });
      const mine = !r.permanent && !!keyOf(r);
      const close = mine ? el('button', { type: 'button', class: 'end', disabled: !!r.closing || closingNow.has(r.index), title: S.close, onclick: (e) => closeRoom(r, e.currentTarget) }, r.closing || closingNow.has(r.index) ? S.closing : S.close) : null;
      return el('li', { class: 'room' + (r.permanent ? ' permanent' : '') + (mine ? ' mine' : '') }, thumb,
        el('div', { class: 'info' }, el('b', {}, r.name), el('span', {}, mine ? `${S.mine} · ${meta}` : meta)), close,
        el('button', { type: 'button', class: 'join', disabled: full || !r.up, onclick: () => (signedIn() ? onJoin(r) : needAccount()) }, r.closing ? S.closing : !r.up ? S.starting : full ? S.full : S.join));
    }));
    // (the keys of rooms gone: forgotten)
    if (data && !data.offline && Array.isArray(data.rooms)) {
      const k = keys(), live = new Set(rooms.map((r) => `${r.index}:${r.since}`));
      const kept = Object.fromEntries(Object.entries(k).filter(([i, v]) => live.has(`${i}:${v?.since}`)));
      if (Object.keys(kept).length !== Object.keys(k).length) saveKeys(kept);
    }
  }
  async function refresh() {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(name)}`, { cache: 'no-store' });
      data = await res.json();
      if (!res.ok || !Array.isArray(data?.rooms)) data = { rooms: [], maps: [], offline: true };
    }
    catch (error) { log('Lobby: ' + error.message); data = { rooms: [], maps: [], offline: true }; }
    try { fillForm(); } finally { render(); }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    clearError(); busy = true; submit.disabled = true; message.textContent = S.creating;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value, map: choice.map, maxPlayers: choice.maxPlayers, bots: choice.bots, options: choice.options }) });
      const out = await res.json().catch(() => ({}));
      if (res.status !== 201) {
        const here = out.error === 'owned' && (data?.rooms ?? []).some((r) => !r.permanent && keyOf(r));
        showError((here ? S.errors.ownedHere : S.errors[out.error]) ?? S.errors.start, out.error); return;
      }
      if (out.key && out.room) saveKeys({ ...keys(), [out.room.index]: { key: out.key, since: out.room.since } });
      toggleForm(false); await refresh(); onJoin(out.room);
    } catch { showError(S.errors.offline); }
    finally { busy = false; submit.disabled = false; }
  });

  return {
    el: root,
    /** Shown: refreshed now and every 4 s. */
    show() { refresh(); clearInterval(timer); timer = setInterval(refresh, 4000); },
    hide() { clearInterval(timer); timer = null; },
    refresh,
    closeForm,
    get rooms() { return data?.rooms ?? []; },
  };
}
