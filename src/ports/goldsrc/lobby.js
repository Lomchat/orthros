// The multiplayer lobby of a browser port's page (docs/browser-ports.md): the games running on the version's servers —
// its permanent one and those players created — with their map and players, joined in a click, and the form that
// creates one (a name, a map, a size, bots) on the Orthros server (/api/rooms/<manifest>). The same element shows in
// the loading screen and over the game (the header's button). Nothing here names a game.

const STRINGS = {
  en: {
    title: 'Online games', create: '+ Create a game', join: 'Join', full: 'Full', starting: 'Starting…',
    players: (n, max) => `${n}/${max} players`, bots: (n) => `${n} bot${n > 1 ? 's' : ''}`, permanent: 'Always on', since: (m) => (m < 1 ? 'just created' : `created ${m} min ago`),
    empty: 'No game yet: create the first one.', offline: 'The game servers are not reachable right now.', online: (n) => `${n} playing`,
    name: 'Name', map: 'Map', size: 'Players', botsLabel: 'Bots', none: 'None', cancel: 'Cancel', submit: 'Create and join',
    defaultName: (nick) => `${nick}'s game`, creating: 'Creating the game…',
    errors: { name: 'Give it a name (2 characters at least).', map: 'Choose a map.', maxPlayers: 'Invalid number of players.', bots: 'Too many bots for that many players.',
      taken: 'A game already has that name.', owned: 'You already have a game running: join it, or wait for it to end.', full: 'Every game slot is taken: join one, or wait for one to end.', wait: 'One game a minute: wait a moment.',
      start: 'The game server did not start. Try again.', offline: 'The game servers are not reachable right now.', forbidden: 'Creating games is not offered here.' },
  },
  fr: {
    title: 'Parties en ligne', create: '+ Créer une partie', join: 'Rejoindre', full: 'Pleine', starting: 'Démarrage…',
    players: (n, max) => `${n}/${max} joueurs`, bots: (n) => `${n} bot${n > 1 ? 's' : ''}`, permanent: 'Permanente', since: (m) => (m < 1 ? 'à l’instant' : `créée il y a ${m} min`),
    empty: 'Aucune partie pour l’instant : crée la première.', offline: 'Les serveurs de jeu sont injoignables pour le moment.', online: (n) => `${n} en jeu`,
    name: 'Nom', map: 'Carte', size: 'Joueurs', botsLabel: 'Bots', none: 'Aucun', cancel: 'Annuler', submit: 'Créer et rejoindre',
    defaultName: (nick) => `Partie de ${nick}`, creating: 'Création de la partie…',
    errors: { name: 'Donne-lui un nom (2 caractères au moins).', map: 'Choisis une carte.', maxPlayers: 'Nombre de joueurs invalide.', bots: 'Trop de bots pour ce nombre de joueurs.',
      taken: 'Une partie porte déjà ce nom.', owned: 'Tu as déjà une partie en cours : rejoins-la, ou attends qu’elle se termine.', full: 'Toutes les places de parties sont prises : rejoins-en une, ou attends qu’une se termine.', wait: 'Une partie par minute : patiente un instant.',
      start: 'Le serveur de jeu n’a pas démarré. Réessaie.', offline: 'Les serveurs de jeu sont injoignables pour le moment.', forbidden: 'La création de parties n’est pas proposée ici.' },
  },
};

/** The address the page's engine reaches a room at: the relay routes it (play.js Relay). */
export const roomAddress = (index) => `10.87.0.${index + 1}:27015`;

const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) e.setAttribute(k, v); }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
};

/**
 * The lobby of a version: `onJoin(room)` when the player joins one; `nickname()` the player's name (the default game
 * name). Returns its element and what shows, hides and refreshes it.
 */
export function createLobby({ name, lang, onJoin, nickname, log = () => {} }) {
  const S = STRINGS[lang] ?? STRINGS.en;
  const list = el('ul', { class: 'lb-rooms' }), note = el('p', { class: 'lb-note' }), online = el('span', { class: 'lb-online' });
  const nameInput = el('input', { maxlength: '32', required: '', autocomplete: 'off' }), mapSelect = el('select'), sizeSelect = el('select'), botsSelect = el('select');
  const botsLabel = el('label', {}, el('span', {}, S.botsLabel), botsSelect), message = el('p', { class: 'lb-msg', role: 'status' });
  const submit = el('button', { type: 'submit', class: 'primary' }, S.submit);
  const form = el('form', { class: 'lb-create hidden' },
    el('label', { class: 'wide' }, el('span', {}, S.name), nameInput), el('label', {}, el('span', {}, S.map), mapSelect), el('label', {}, el('span', {}, S.size), sizeSelect), botsLabel,
    el('div', { class: 'lb-actions' }, el('button', { type: 'button', onclick: () => toggleForm(false) }, S.cancel), submit), message);
  const createButton = el('button', { type: 'button', class: 'lb-new', onclick: () => toggleForm(true) }, S.create);
  const root = el('section', { class: 'lobby' }, el('header', {}, el('h3', {}, S.title), online, createButton), form, list, note);
  let data = null, timer = null, busy = false, filled = false;

  function toggleForm(open) {
    form.classList.toggle('hidden', !open); createButton.classList.toggle('hidden', open); message.textContent = '';
    if (open) { if (!nameInput.value) nameInput.value = S.defaultName(nickname()).slice(0, 32); nameInput.focus(); nameInput.select(); }
  }
  function fillForm() {
    if (filled || !data?.maps?.length) return;
    filled = true;
    for (const m of data.maps) mapSelect.append(el('option', { value: m }, m));
    const first = data.rooms.find((r) => r.permanent)?.map; if (data.maps.includes(first)) mapSelect.value = first;
    for (let n = 2; n <= (data.maxPlayers ?? 16); n++) sizeSelect.append(el('option', { value: String(n) }, String(n)));
    sizeSelect.value = String(Math.min(10, data.maxPlayers ?? 16));
    botsLabel.classList.toggle('hidden', !data.bots);
    botsSelect.append(el('option', { value: '0' }, S.none));
    for (let n = 1; n <= (data.bots?.max ?? 0); n++) botsSelect.append(el('option', { value: String(n) }, String(n)));
    botsSelect.value = data.bots ? '4' : '0';
  }
  function render() {
    const rooms = data?.rooms ?? [];
    const humans = rooms.reduce((t, r) => t + r.humans, 0);
    online.textContent = humans ? S.online(humans) : '';
    createButton.classList.toggle('hidden', !data?.creatable || !form.classList.contains('hidden'));
    note.textContent = data?.offline ? S.offline : !rooms.length ? S.empty : '';
    list.replaceChildren(...rooms.map((r) => {
      const full = r.players >= r.maxPlayers, meta = [r.map, S.players(r.players, r.maxPlayers), r.bots ? S.bots(r.bots) : null, r.permanent ? S.permanent : S.since(Math.floor((Date.now() - r.since) / 60000))].filter(Boolean).join(' · ');
      return el('li', { class: 'room' + (r.permanent ? ' permanent' : '') },
        el('div', { class: 'info' }, el('b', {}, r.name), el('span', {}, meta)),
        el('button', { type: 'button', class: 'join', disabled: full || !r.up ? '' : null, onclick: () => onJoin(r) }, !r.up ? S.starting : full ? S.full : S.join));
    }));
  }
  async function refresh() {
    try { data = await (await fetch(`/api/rooms/${encodeURIComponent(name)}`, { cache: 'no-store' })).json(); }
    catch (error) { log('Lobby: ' + error.message); data = { rooms: [], maps: [], offline: true }; }
    try { fillForm(); } finally { render(); }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    busy = true; submit.disabled = true; message.textContent = S.creating; message.classList.remove('error');
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value, map: mapSelect.value, maxPlayers: Number(sizeSelect.value), bots: Number(botsSelect.value) }) });
      const out = await res.json().catch(() => ({}));
      if (res.status !== 201) { message.textContent = S.errors[out.error] ?? S.errors.start; message.classList.add('error'); return; }
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
