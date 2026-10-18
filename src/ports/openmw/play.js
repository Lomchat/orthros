const id = decodeURIComponent(location.pathname.split('/')[3]);
const $ = (s) => document.querySelector(s);
let user = null, pendingMode = null;
async function api(route, method = 'GET', body) {
  const r = await fetch(route, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error ?? 'Connexion indisponible.'); return data;
}
try {
  const lr = await fetch('/api/manifests');
  const mr = await fetch(`/api/manifest/${encodeURIComponent(id)}`);
  if (!mr.ok || !lr.ok) throw new Error('Version introuvable.');
  const man = await mr.json(), entries = await lr.json(), entry = entries.find((m) => m.name === id);
  const config = await api('/api/config');
  user = config.accounts ? (await api('/api/account')).user : null;
  $('#title').textContent = $('#gameTitle').textContent = man.name;
  document.title = `${man.name} · Orthros`;
  $('#description').textContent = man.descriptionFr ?? man.description ?? '';
  $('#status').textContent = entry?.available ? (man.openmw.example ? 'Démo libre du moteur, sans les fichiers de Morrowind.' : 'Fichiers du jeu et moteur installés.') : 'Les fichiers du jeu ou du moteur ne sont pas encore installés.';
  $('#help').textContent = man.openmw.multiplayer ? 'Un compte Orthros est nécessaire pour le multijoueur et les sauvegardes en ligne. La connexion au jeu est automatique. Crée un personnage, ouvre ton monde en mode Party et ajoute tes amis. La campagne avance dans le monde de son hôte.' : 'Chrome sur ordinateur requis. Connecte-toi à Orthros pour retrouver tes sauvegardes sur un autre appareil.';
  $('#accountStatus').textContent = user ? `Connecté : ${user.username}. Sauvegardes liées à ce compte.` : 'Sans compte, les sauvegardes solo restent sur cet appareil.';
  $('#accountToggle').hidden = !config.accounts || !!user;
  $('#accountToggle').onclick = () => { pendingMode = null; $('#accountForm').hidden = false; $('#username').focus(); };
  const language = $('#gameLanguage'), options = man.languages ?? ['en'];
  let saved; try { saved = localStorage.getItem(`orthros.gameLanguage.${man.gameId ?? id}`); } catch { /* optional preference */ }
  const wanted = new URLSearchParams(location.search).get('gameLang') ?? saved;
  if (wanted && man.languageLaunchUrls?.[wanted] && new URL(man.languageLaunchUrls[wanted], location.origin).pathname !== location.pathname) {
    const target = new URL(man.languageLaunchUrls[wanted], location.origin); target.searchParams.set('gameLang', wanted); location.replace(target.href);
  }
  for (const code of new Set(['fr', 'en', ...options])) {
    const o = document.createElement('option'); o.value = code; o.disabled = !options.includes(code);
    o.textContent = ({ fr: 'Français', en: 'English' }[code] ?? code) + (o.disabled ? ' — fichiers non installés' : ''); language.append(o);
  }
  language.value = options.includes(wanted) ? wanted : man.contentLanguages?.[0] ?? (options.includes('en') ? 'en' : options[0]);
  $('#languageHelp').textContent = options.includes('fr') ? 'Textes et voix selon la langue choisie. En multijoueur, choisis la même langue que tes amis. Les parties anglaises et françaises ont des sauvegardes séparées.' : 'Les textes et les voix français nécessitent les fichiers de l’édition française.';
  language.onchange = () => {
    try { localStorage.setItem(`orthros.gameLanguage.${man.gameId ?? id}`, language.value); } catch { /* optional preference */ }
    const url = man.languageLaunchUrls?.[language.value];
    if (url && new URL(url, location.origin).pathname !== location.pathname) { const target = new URL(url, location.origin); target.searchParams.set('gameLang', language.value); location.href = target.href; }
  };
  const launch = (relative) => {
    $('#game').src = `app/${relative}`; $('#game').hidden = false; $('#welcome').hidden = true; $('#game').focus();
  };
  async function enter(mode) {
    $('#status').textContent = 'Préparation de la partie…';
    try {
      if (mode === 'multi') {
        const data = await api(`/api/openmw/${encodeURIComponent(id)}/launch`, 'POST');
        $('#playerName').textContent = data.username ? `En jeu : ${data.username}` : '';
        const hash = new URLSearchParams({ mpticket: data.ticket, mpaccount: data.account, mplocker: data.locker });
        launch(`join#${hash}`);
      } else launch(man.openmw.example ? `index.html?nomw${man.openmw.startCell ? '&start=' + encodeURIComponent(man.openmw.startCell) : ''}` : 'index.html?src=hosted');
    } catch (e) { $('#status').textContent = e.message; }
  }
  $('#solo').disabled = !entry?.available;
  $('#solo').onclick = () => enter('solo');
  $('#multi').hidden = !man.openmw.multiplayer;
  $('#multi').disabled = !entry?.available || !config.accounts;
  $('#multi').onclick = () => {
    if (user) enter('multi');
    else { pendingMode = 'multi'; $('#accountForm').hidden = false; $('#username').focus(); }
  };
  $('#accountForm').onsubmit = async (event) => {
    event.preventDefault(); const submit = $('#accountSubmit'); submit.disabled = true;
    try {
      const action = $('#accountAction').value;
      user = (await api('/api/account/' + action, 'POST', { username: $('#username').value, password: $('#password').value })).user;
      $('#password').value = ''; $('#accountForm').hidden = true; $('#accountToggle').hidden = true;
      $('#accountStatus').textContent = `Connecté : ${user.username}. Sauvegardes liées à ce compte.`;
      if (pendingMode) await enter(pendingMode);
    } catch (e) { $('#accountError').textContent = e.message; }
    finally { submit.disabled = false; }
  };
  $('#accountAction').onchange = () => { $('#password').autocomplete = $('#accountAction').value === 'register' ? 'new-password' : 'current-password'; };
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== $('#game').contentWindow || event.data?.type !== 'orthros-save-status') return;
    $('#saveStatus').textContent = event.data.message; $('#saveStatus').classList.toggle('error', !!event.data.error);
  });
  $('#fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#game').requestFullscreen();
} catch (e) { $('#status').textContent = e.message; }
