const id = decodeURIComponent(location.pathname.split('/')[3]);
const $ = (s) => document.querySelector(s);
try {
  const lr = await fetch('/api/manifests');
  const mr = await fetch(`/api/manifest/${encodeURIComponent(id)}`);
  if (!mr.ok || !lr.ok) throw new Error('Version introuvable.');
  const man = await mr.json(), entry = (await lr.json()).find((m) => m.name === id);
  $('#title').textContent = $('#gameTitle').textContent = man.name;
  document.title = `${man.name} · Orthros`;
  $('#description').textContent = man.descriptionFr ?? man.description ?? '';
  $('#status').textContent = entry?.available ? (man.openmw.example ? 'Démo libre du moteur, sans les fichiers de Morrowind.' : 'Fichiers du jeu et moteur installés.') : 'Les fichiers du jeu ou du moteur ne sont pas encore installés.';
  $('#help').textContent = man.openmw.multiplayer ? 'En multi, connecte-toi avec ton compte OpenMW, puis crée un personnage. Ouvre ton monde en mode Party et ajoute tes amis pour qu’ils le rejoignent. La campagne avance dans le monde de son hôte.' : 'Chrome sur ordinateur requis. Les sauvegardes du solo restent dans ce navigateur.';
  const launch = (relative) => {
    $('#game').src = `app/${relative}`; $('#game').hidden = false; $('#welcome').hidden = true;
    $('#game').focus();
  };
  $('#solo').disabled = !entry?.available;
  $('#solo').onclick = () => launch(man.openmw.example ? `index.html?nomw${man.openmw.startCell ? '&start=' + encodeURIComponent(man.openmw.startCell) : ''}` : 'index.html?src=hosted');
  $('#multi').hidden = !man.openmw.multiplayer;
  $('#multi').disabled = !entry?.available;
  $('#multi').onclick = () => launch('');
  $('#fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#game').requestFullscreen();
} catch (e) { $('#status').textContent = e.message; }
