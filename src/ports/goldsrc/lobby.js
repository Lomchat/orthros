// The multiplayer lobby of a browser port's page (docs/browser-ports.md): the games running on the version's servers —
// its permanent one and those players created — with their map and players, joined in a click, and the form that
// creates one on the Orthros server (/api/rooms/<manifest>): a name, a map picked on its picture (the game's own
// overview, /api/map-image), a size, bots, and the version's options (rooms.options: the bots' team, the starting
// money…). The same element shows in the loading screen and over the game (the header's button). Nothing here names
// a game: maps, options and their labels come from the server.

const STRINGS = {
  en: {
    title: 'Online games', create: '+ Create a game', join: 'Join', full: 'Full', starting: 'Starting…',
    close: 'Close', closing: 'Closing…', mine: 'your game', closeConfirm: (n) => `Close “${n}”? Its players go back to the menu.`, closeFailed: 'The game could not be closed.',
    players: (n, max) => `${n}/${max} players`, bots: (n) => `${n} bot${n > 1 ? 's' : ''}`, permanent: 'Always on', since: (m) => (m < 1 ? 'just created' : `created ${m} min ago`),
    empty: 'No game yet: create the first one.', offline: 'The game servers are not reachable right now.', online: (n) => `${n} playing`,
    name: 'Name', map: 'Map', size: 'Players', botsLabel: 'Bots', none: 'None', cancel: 'Cancel', submit: 'Create and join', maps: (n) => `${n} maps`,
    defaultName: (nick) => `${nick}'s game`, creating: 'Creating the game…', less: 'fewer', more: 'more',
    errors: { name: 'Give it a name (2 characters at least).', map: 'Choose a map.', maxPlayers: 'Invalid number of players.', bots: 'Too many bots for that many players.', options: 'Invalid settings.',
      taken: 'A game already has that name.', owned: 'You already have a game running: join it, or wait for it to end.', ownedHere: 'You already have a game running: join it, or close it.', full: 'Every game slot is taken: join one, or wait for one to end.', wait: 'A game is already being created: wait a moment.',
      start: 'The game server did not start. Try again.', offline: 'The game servers are not reachable right now.', forbidden: 'Creating games is not offered here.' },
  },
  fr: {
    title: 'Parties en ligne', create: '+ Créer une partie', join: 'Rejoindre', full: 'Pleine', starting: 'Démarrage…',
    close: 'Fermer', closing: 'Fermeture…', mine: 'ta partie', closeConfirm: (n) => `Fermer « ${n} » ? Ses joueurs reviennent au menu.`, closeFailed: 'La partie n’a pas pu être fermée.',
    players: (n, max) => `${n}/${max} joueurs`, bots: (n) => `${n} bot${n > 1 ? 's' : ''}`, permanent: 'Permanente', since: (m) => (m < 1 ? 'à l’instant' : `créée il y a ${m} min`),
    empty: 'Aucune partie pour l’instant : crée la première.', offline: 'Les serveurs de jeu sont injoignables pour le moment.', online: (n) => `${n} en jeu`,
    name: 'Nom', map: 'Carte', size: 'Joueurs', botsLabel: 'Bots', none: 'Aucun', cancel: 'Annuler', submit: 'Créer et rejoindre', maps: (n) => `${n} cartes`,
    defaultName: (nick) => `Partie de ${nick}`, creating: 'Création de la partie…', less: 'moins', more: 'plus',
    errors: { name: 'Donne-lui un nom (2 caractères au moins).', map: 'Choisis une carte.', maxPlayers: 'Nombre de joueurs invalide.', bots: 'Trop de bots pour ce nombre de joueurs.', options: 'Réglages invalides.',
      taken: 'Une partie porte déjà ce nom.', owned: 'Tu as déjà une partie en cours : rejoins-la, ou attends qu’elle se termine.', ownedHere: 'Tu as déjà une partie en cours : rejoins-la, ou ferme-la.', full: 'Toutes les places de parties sont prises : rejoins-en une, ou attends qu’une se termine.', wait: 'Une partie est déjà en cours de création : patiente un instant.',
      start: 'Le serveur de jeu n’a pas démarré. Réessaie.', offline: 'Les serveurs de jeu sont injoignables pour le moment.', forbidden: 'La création de parties n’est pas proposée ici.' },
  },
};

/**
 * A map's picture as a small image for the lobby: the game's overview drawn smaller, its keyed colour (pure green, which
 * the game shows as transparent) turned into the panel's dark; kept for the page's life. Null when there is none.
 */
const thumbs = new Map();
export function mapThumb(name, map) {
  const key = `${name}/${map}`;
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
        const w = 240, h = Math.round(w * H / Math.max(1, W)), c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(full, 0, 0, w, h);
        resolve(c.toDataURL('image/webp', 0.85));
      } catch { thumbs.delete(key); resolve(null); }
    };
    img.onerror = () => { thumbs.delete(key); resolve(null); }; // (tried again next time)
    img.src = `/api/map-image/${encodeURIComponent(name)}/${encodeURIComponent(map)}`;
  }));
  return thumbs.get(key);
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
 * name). Returns its element and what shows, hides and refreshes it.
 */
export function createLobby({ name, lang, onJoin, nickname, log = () => {} }) {
  const S = STRINGS[lang] ?? STRINGS.en;
  const label = (l) => (typeof l === 'string' ? l : l?.[lang] ?? l?.en ?? Object.values(l ?? {})[0] ?? '');
  const list = el('ul', { class: 'lb-rooms' }), note = el('p', { class: 'lb-note' }), online = el('span', { class: 'lb-online' });
  const nameInput = el('input', { maxlength: '32', required: true, autocomplete: 'off', spellcheck: 'false' });
  const mapsGrid = el('div', { class: 'lb-maps', role: 'listbox', 'aria-label': S.map }), mapsCount = el('span', { class: 'lb-count' });
  const settings = el('div', { class: 'lb-settings' }), message = el('p', { class: 'lb-msg', role: 'status' });
  const submit = el('button', { type: 'submit', class: 'primary' }, S.submit);
  const form = el('form', { class: 'lb-create hidden' },
    el('label', { class: 'lb-field' }, el('span', {}, S.name), nameInput),
    el('div', { class: 'lb-field lb-mapsfield' }, el('span', {}, S.map, ' ', mapsCount), mapsGrid),
    settings,
    el('div', { class: 'lb-actions' }, message, el('button', { type: 'button', onclick: () => toggleForm(false) }, S.cancel), submit));
  const createButton = el('button', { type: 'button', class: 'lb-new', onclick: () => toggleForm(true) }, S.create);
  const root = el('section', { class: 'lobby' }, el('header', {}, el('h3', {}, S.title), online, createButton), form, list, note);
  let data = null, timer = null, busy = false, filled = false;
  // (the form's choices)
  const choice = { map: null, maxPlayers: 10, bots: 0, options: {} };
  const steppers = {}, segments = {};

  function toggleForm(open) {
    form.classList.toggle('hidden', !open); createButton.classList.toggle('hidden', open); root.classList.toggle('creating', open); message.textContent = '';
    if (open) { if (!nameInput.value) nameInput.value = S.defaultName(nickname()).slice(0, 32); nameInput.focus(); nameInput.select(); mapsGrid.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }
  }

  /** A number chosen with − and +, within [min(), max()]. */
  function stepper(key, title, min, max) {
    const value = el('output', {}), minus = el('button', { type: 'button', 'aria-label': `${title} ${S.less}` }, '−'), plus = el('button', { type: 'button', 'aria-label': `${title} ${S.more}` }, '+');
    const sync = () => { choice[key] = Math.min(max(), Math.max(min(), choice[key])); value.textContent = key === 'bots' && !choice.bots ? S.none : String(choice[key]); minus.disabled = choice[key] <= min(); plus.disabled = choice[key] >= max(); };
    minus.onclick = () => { choice[key]--; syncAll(); }; plus.onclick = () => { choice[key]++; syncAll(); };
    steppers[key] = sync;
    return el('div', { class: 'lb-field' }, el('span', {}, title), el('div', { class: 'lb-step' }, minus, value, plus));
  }
  /** One of an option's choices, as buttons side by side. */
  function segmented(option) {
    const row = el('div', { class: 'lb-seg', role: 'radiogroup', 'aria-label': label(option.label) });
    for (const c of option.choices) row.append(el('button', { type: 'button', role: 'radio', 'data-id': c.id, onclick: () => { choice.options[option.id] = c.id; syncAll(); } }, label(c.label)));
    arrows(row, () => [...row.children], (b) => { choice.options[option.id] = b.dataset.id; syncAll(); });
    const field = el('div', { class: 'lb-field' + (option.choices.length > 3 ? ' wide' : '') }, el('span', {}, label(option.label)), row);
    segments[option.id] = () => {
      field.classList.toggle('hidden', !!option.bots && !choice.bots);
      for (const b of row.children) { const on = b.dataset.id === choice.options[option.id]; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    };
    return field;
  }
  function syncAll() {
    for (const f of Object.values(steppers)) f();
    for (const f of Object.values(segments)) f();
    steppers.maxPlayers?.(); // (the bots' maximum depends on the size, and the other way)
  }
  function pickMap(map) {
    choice.map = map;
    for (const card of mapsGrid.children) { card.setAttribute('aria-selected', String(card.dataset.map === map)); card.tabIndex = card.dataset.map === map ? 0 : -1; }
  }
  /** Arrows, Home and End move the choice within a group (one Tab stop each: the chosen element). */
  function arrows(container, items, pick, columns = () => 1) {
    container.addEventListener('keydown', (event) => {
      const list = items(), i = list.indexOf(document.activeElement); if (i < 0) return;
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns(), Home: -Infinity, End: Infinity }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const next = list[Math.max(0, Math.min(list.length - 1, i + step))];
      pick(next); next.focus(); next.scrollIntoView({ block: 'nearest' });
    });
  }
  arrows(mapsGrid, () => [...mapsGrid.children], (card) => pickMap(card.dataset.map),
    () => Math.max(1, Math.round(mapsGrid.clientWidth / (mapsGrid.firstElementChild?.offsetWidth || 1))))

  function fillForm() {
    if (filled || !data?.maps?.length) return;
    filled = true;
    mapsCount.textContent = S.maps(data.maps.length);
    // (a card a map: its picture when the version has them, its name over a pattern otherwise or when it fails)
    // (the pictures when a card comes into view: a few hundred kilobytes each)
    const seen = data.mapImages && 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        seen.unobserve(e.target);
        mapThumb(name, e.target.dataset.map).then((url) => { if (url) e.target.prepend(el('img', { src: url, alt: '', draggable: 'false' })); else setTimeout(() => seen.observe(e.target), 15000); });
      }
    }, { root: mapsGrid, rootMargin: '120px' }) : null;
    for (const m of data.maps) {
      const card = el('button', { type: 'button', class: 'lb-map', role: 'option', 'data-map': m, title: m, onclick: () => pickMap(m) },
        el('span', { class: 'lb-noimg' }, m.replace(/^[a-z]+_/, '')), el('span', { class: 'lb-mapname' }, m));
      mapsGrid.append(card); seen?.observe(card);
    }
    const first = data.rooms?.find((r) => r.permanent)?.map;
    pickMap(data.maps.includes(first) ? first : data.maps[0]);
    const maxPlayers = data.maxPlayers ?? 16;
    choice.maxPlayers = Math.min(10, maxPlayers); choice.bots = data.bots ? Math.min(4, data.bots.max) : 0;
    settings.append(stepper('maxPlayers', S.size, () => Math.max(2, choice.bots + 1), () => maxPlayers));
    if (data.bots) settings.append(stepper('bots', S.botsLabel, () => 0, () => Math.min(data.bots.max, choice.maxPlayers - 1)));
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
        el('button', { type: 'button', class: 'join', disabled: full || !r.up, onclick: () => onJoin(r) }, r.closing ? S.closing : !r.up ? S.starting : full ? S.full : S.join));
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
    busy = true; submit.disabled = true; message.textContent = S.creating; message.classList.remove('error');
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value, map: choice.map, maxPlayers: choice.maxPlayers, bots: choice.bots, options: choice.options }) });
      const out = await res.json().catch(() => ({}));
      if (res.status !== 201) {
        const here = out.error === 'owned' && (data?.rooms ?? []).some((r) => !r.permanent && keyOf(r));
        message.textContent = (here ? S.errors.ownedHere : S.errors[out.error]) ?? S.errors.start; message.classList.add('error'); return;
      }
      if (out.key && out.room) saveKeys({ ...keys(), [out.room.index]: { key: out.key, since: out.room.since } });
      toggleForm(false); await refresh(); onJoin(out.room);
    } catch { message.textContent = S.errors.offline; message.classList.add('error'); }
    finally { busy = false; submit.disabled = false; }
  });

  return {
    el: root,
    /** Shown: refreshed now and every 4 s. */
    show() { refresh(); clearInterval(timer); timer = setInterval(refresh, 4000); },
    hide() { clearInterval(timer); timer = null; },
    refresh,
    get rooms() { return data?.rooms ?? []; },
  };
}
