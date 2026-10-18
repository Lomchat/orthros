// Put into the OpenMW engine's pages by the Orthros server (src/host/openmw.js, withFrameMeter): the engine page's own
// interface — loading, multiplayer tour, social panel, chat, messages, the character choice — in the language of the
// Orthros page (the visitor's choice, else the browser's: as src/host/web/lang.js). Only the texts the engine writes
// are touched, by exact phrase (or a phrase's start, for the ones ending with a name or a number); the game is not.
(() => {
  let lang = null;
  try { lang = localStorage.getItem('orthros.lang'); } catch { /* storage off */ }
  if (!lang) lang = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => ['fr', 'en'].includes(l)) ?? 'en';
  if (lang !== 'fr') return;
  const FR = {
    // loading, starting, world changes
    'Loading': 'Chargement', 'Loading Morrowind': 'Chargement de Morrowind', 'Loading your library': 'Chargement de ta bibliothèque',
    'Preparing…': 'Préparation…', 'Preparing your game': 'Préparation de la partie', 'Preparing game files': 'Préparation des fichiers du jeu',
    'Downloading': 'Téléchargement', 'Downloading the game engine': 'Téléchargement du moteur', 'Downloading voices': 'Téléchargement des voix',
    'Unpacking voices': 'Décompression des voix', 'Downloading data... (x/y)': 'Téléchargement des données… (x/y)',
    'Reading the game data. The first visit can take a minute.': 'Lecture des données du jeu. La première visite peut prendre une minute.',
    'Starting Morrowind': 'Démarrage de Morrowind', 'All set. Starting Morrowind.': 'Tout est prêt. Démarrage de Morrowind.',
    'Starting your world': 'Démarrage de ton monde', 'Entering the world': 'Entrée dans le monde', 'Entering a new area': 'Entrée dans une nouvelle zone',
    'Entering a new area…': 'Entrée dans une nouvelle zone…', 'Placing you where you left off': 'Retour là où tu t’étais arrêté',
    'Putting you back in the world…': 'Retour dans le monde…', 'Putting you back in…': 'Retour en jeu…', 'Settling the world…': 'Le monde se met en place…',
    'Waiting for the world to be simulated…': 'En attente de la simulation du monde…', 'Waking the server, this takes a moment…': 'Réveil du serveur, un instant…',
    'Getting you a seat…': 'Recherche d’une place…', 'Joining your world': 'Connexion à ton monde', 'Changing world': 'Changement de monde',
    'Returning to your own world': 'Retour dans ton propre monde', 'Back to your own world…': 'Retour dans ton propre monde…', 'Going home': 'Retour chez toi',
    'Back in your own world': 'De retour dans ton monde', ' You are back in your own world. Nothing you did there is lost.': ' Te voilà de retour dans ton monde. Rien de ce que tu y as fait n’est perdu.',
    'Almost there': 'Presque prêt', 'Connecting to the server': 'Connexion au serveur', 'Connecting…': 'Connexion…', 'Checking…': 'Vérification…',
    'Fetching your files…': 'Récupération de tes fichiers…', 'Finding your files': 'Recherche de tes fichiers', 'Ready': 'Prêt', 'Running': 'En cours',
    'Saved to your account': 'Sauvegardé sur ton compte', 'Saves restored': 'Sauvegardes restaurées', 'Saving is disabled in multiplayer': 'La sauvegarde est désactivée en multijoueur',
    '☰ starting…': '☰ démarrage…', 'booting…': 'démarrage…',
    // the multiplayer tour
    'Multiplayer': 'Multijoueur', 'You are in the world': 'Tu es dans le monde', 'Next ▸': 'Suivant ▸', 'Got it': 'Compris', "Let's go ▸": 'C’est parti ▸',
    'Your character is saved to your account and follows you everywhere: solo, or with friends in a shared world. Multiplayer is now unlocked.':
      'Ton personnage est sauvegardé sur ton compte et te suit partout : en solo, ou avec tes amis dans un monde partagé. Le multijoueur est débloqué.',
    'Your character lives on the server, not in this browser. Progress, inventory and where you stood are kept for you, so clearing site data cannot lose them.':
      'Ton personnage vit sur le serveur, pas dans ce navigateur. Progression, inventaire et position sont gardés pour toi : effacer les données du site ne peut pas les perdre.',
    'Sign in on any browser, on any machine, and pick the same character up where you left it. Nothing to install and nothing to carry with you.':
      'Connecte-toi depuis n’importe quel navigateur, sur n’importe quelle machine, et reprends le même personnage là où tu l’as laissé. Rien à installer, rien à emporter.',
    'Play anywhere': 'Joue partout', 'Play your way': 'Joue à ta façon', 'One-time setup': 'Une seule fois',
    'The chat box in the corner. Hiding it does not leave any': 'La discussion, dans le coin. La masquer ne fait quitter aucun',
    ' channel - messages are still delivered, and unhiding shows what you missed.': ' canal : les messages arrivent toujours, et la réafficher montre ce que tu as manqué.',
    'Who may see which cell you are in and invite you. Private': 'Qui peut voir où tu te trouves et t’inviter. Privé',
    ' hides your location from friends too.': ' cache aussi ta position à tes amis.',
    // social panel, friends, worlds
    'Social': 'Social', 'Friends': 'Amis', 'Friend': 'Ami', 'Players': 'Joueurs', 'Players here': 'Joueurs ici', 'Party': 'Groupe', 'Solo': 'Solo', 'Public': 'Public',
    'Online': 'En ligne', 'Offline': 'Hors ligne', 'Playing': 'En jeu', 'Joined': 'Connecté', 'Join': 'Rejoindre', 'Leave': 'Partir', 'Add': 'Ajouter',
    'Visible to': 'Visible par', 'Everyone': 'Tout le monde', 'Nobody': 'Personne', 'You': 'Toi', 'That is you.': 'C’est toi.',
    'Add a friend by their username': 'Ajoute un ami par son nom d’utilisateur', 'add friend': 'ajouter en ami', 'accept friend': 'accepter',
    'No friends yet. Add someone below, or from Players.': 'Pas encore d’amis. Ajoute quelqu’un ci-dessous, ou depuis Joueurs.',
    'No one else is here right now.': 'Personne d’autre ici pour l’instant.', 'Nobody else is here right now.': 'Personne d’autre ici pour l’instant.',
    'Wants to be friends': 'Veut être ton ami', 'Request sent': 'Demande envoyée', 'Friend request sent.': 'Demande d’ami envoyée.',
    'Friend request accepted.': 'Demande d’ami acceptée.', 'You are already friends.': 'Vous êtes déjà amis.', 'You are not friends with them.': 'Vous n’êtes pas amis.',
    'No player by that name.': 'Aucun joueur de ce nom.', 'They are offline.': 'Ce joueur est hors ligne.', 'They are not accepting invitations.': 'Ce joueur n’accepte pas les invitations.',
    'Invitation sent.': 'Invitation envoyée.', 'That invitation has expired.': 'Cette invitation a expiré.', 'that invitation has expired': 'cette invitation a expiré',
    'Their world is not open to friends yet. Ask them to switch to Party.': 'Son monde n’est pas encore ouvert aux amis. Demande-lui de passer en Groupe.',
    'Your world is open to your friends.': 'Ton monde est ouvert à tes amis.', 'Your world is solo again.': 'Ton monde est de nouveau en solo.',
    'The host sent you home.': 'L’hôte t’a renvoyé chez toi.', 'Sent home.': 'Renvoyé chez lui.', 'send home': 'renvoyer chez lui', 'X sent you home': 'X t’a renvoyé chez toi',
    'The world you were in has closed.': 'Le monde où tu étais a fermé.', 'That world is no longer open to you: the host has gone solo.': 'Ce monde ne t’est plus ouvert : l’hôte est repassé en solo.',
    'You are no longer on the friends list that let you into that world.': 'Tu n’es plus dans la liste d’amis qui t’ouvrait ce monde.',
    'This server runs a single world, so there is nowhere else to join.': 'Ce serveur n’a qu’un seul monde : il n’y a nulle part ailleurs où aller.',
    'Could not change world': 'Impossible de changer de monde', 'You cannot do that with this player.': 'Impossible avec ce joueur.',
    'Blocked': 'Bloqué', 'Muted': 'Muet', 'Nobody is blocked.': 'Personne n’est bloqué.', 'Nobody is muted.': 'Personne n’est muet.',
    'What did they do?': 'Qu’a fait ce joueur ?', 'Send report': 'Envoyer le signalement', 'Report sent to the moderators.': 'Signalement envoyé aux modérateurs.',
    'You changed your handle too recently.': 'Tu as changé de pseudo trop récemment.', 'That handle is already taken.': 'Ce pseudo est déjà pris.',
    'That handle is reserved.': 'Ce pseudo est réservé.', 'Pick a handle to continue.': 'Choisis un pseudo pour continuer.',
    'Letters, numbers, _ and - only. No spaces.': 'Lettres, chiffres, _ et - uniquement. Pas d’espaces.',
    // chat
    'Chat': 'Discussion', 'Show chat': 'Afficher la discussion', 'Hide chat': 'Masquer la discussion', 'Chat shown.': 'Discussion affichée.', 'Chat hidden.': 'Discussion masquée.',
    'Type a message…': 'Écris un message…', 'Enter send &middot; Tab channel &middot; Esc close': 'Entrée envoie · Tab canal · Échap ferme', '[World]': '[Monde]',
    // characters (the launcher of a returning player)
    'Choose your character': 'Choisis ton personnage', 'New character': 'Nouveau personnage', 'Delete this character?': 'Supprimer ce personnage ?',
    'Delete forever': 'Supprimer définitivement', 'Deleting…': 'Suppression…', 'Creating…': 'Création…', 'Saving…': 'Enregistrement…',
    'Each character has their own story, journal and solo world.': 'Chaque personnage a sa propre histoire, son journal et son monde solo.',
    'Could not create the character.': 'Impossible de créer le personnage.', 'Could not delete.': 'Impossible de supprimer.', 'Could not save. Try again.': 'Enregistrement impossible. Réessaie.',
    'That character no longer exists — go back and pick another.': 'Ce personnage n’existe plus : reviens en arrière et choisis-en un autre.',
    'Create your character first': 'Crée d’abord ton personnage', 'Finish creating your character first.': 'Termine d’abord la création de ton personnage.',
    'Finish a character first': 'Termine d’abord un personnage', 'Adventurer': 'Aventurier', 'Choose your username': 'Choisis ton nom d’utilisateur',
    'Username': 'Nom d’utilisateur', 'Username must be at least 3 characters.': 'Le nom d’utilisateur doit avoir au moins 3 caractères.',
    'Play': 'Jouer', 'Play now': 'Jouer maintenant', 'Play together': 'Jouer ensemble', 'Continue': 'Continuer', 'Close': 'Fermer', 'Close (O)': 'Fermer (O)', 'Cancel': 'Annuler',
    'Go back': 'Retour', 'Back to the launcher': 'Retour au lanceur', 'Back to your characters': 'Retour à tes personnages', '‹ Back to launcher': '‹ Retour au lanceur',
    'Friends playing now': 'Amis en jeu', 'Experimental': 'Expérimental', 'Hosted here': 'Hébergé ici',
    // settings of the engine page
    'Settings': 'Réglages', 'Video': 'Vidéo', 'Sound': 'Son', 'Music': 'Musique', 'Voices': 'Voix', 'Interface': 'Interface', 'Gamma': 'Gamma', 'Fonts': 'Polices',
    'Antialiasing': 'Anticrénelage', 'Loading screens': 'Écrans de chargement', 'Videos': 'Vidéos', 'Pointer lock': 'Capture de la souris', 'Privacy': 'Confidentialité',
    'increase if interiors are too dark': 'à augmenter si les intérieurs sont trop sombres',
    // problems
    'Connection lost': 'Connexion perdue', 'Connection lost, reconnecting': 'Connexion perdue, reconnexion', 'Reconnecting': 'Reconnexion', 'Reconnecting…': 'Reconnexion…',
    'Reconnected.': 'Reconnecté.', 'Disconnected': 'Déconnecté', 'Reload': 'Recharger', 'Failed': 'Échec', 'Info': 'Info',
    'Check your connection and reload.': 'Vérifie ta connexion et recharge la page.', 'Check your connection and reload. Your saves are safe.': 'Vérifie ta connexion et recharge la page. Tes sauvegardes ne risquent rien.',
    'Reload to keep playing. Your progress is saved on the server.': 'Recharge pour continuer à jouer. Ta progression est sauvegardée sur le serveur.',
    'Reload to play again.': 'Recharge pour rejouer.', 'Your saves are safe. Reloading…': 'Tes sauvegardes ne risquent rien. Rechargement…',
    'The server could not be reached': 'Le serveur est injoignable', 'Could not reach the server. Try again.': 'Serveur injoignable. Réessaie.',
    'Could not reach the server.': 'Serveur injoignable.', 'The server is restarting': 'Le serveur redémarre', 'The server is busy': 'Le serveur est occupé',
    'The server is full right now. Try again shortly.': 'Le serveur est plein. Réessaie dans un moment.', 'Try again in a few minutes.': 'Réessaie dans quelques minutes.',
    'Too many requests pending — try again shortly.': 'Trop de demandes en attente : réessaie dans un moment.', 'Please try again': 'Réessaie',
    'Could not reach the multiplayer server. It may be down, try again shortly.': 'Le serveur multijoueur est injoignable. Il est peut-être arrêté, réessaie bientôt.',
    'Could not open your world': 'Impossible d’ouvrir ton monde', 'Your world is still shutting down from your last session. Try again in a few seconds.': 'Ton monde est encore en train de se fermer depuis ta dernière session. Réessaie dans quelques secondes.',
    'You already have as many worlds open as this server allows. Exit one and try again.': 'Tu as déjà autant de mondes ouverts que le serveur le permet. Quittes-en un et réessaie.',
    'The world’s simulation is restarting… ': 'La simulation du monde redémarre… ', 'The world is still starting (a big mod set takes a few minutes). ': 'Le monde démarre encore (beaucoup de mods : quelques minutes). ',
    'The world’s mod list changed since this page loaded — reload to fetch it.': 'La liste des mods du monde a changé depuis le chargement de la page : recharge pour la récupérer.',
    'This session has lost its sign-in. Exit to the menu and sign in again — your character is safe on the server.': 'Cette session a perdu sa connexion. Reviens au menu et reconnecte-toi : ton personnage ne risque rien sur le serveur.',
    'Session expired': 'Session expirée', 'Please sign in again to keep playing.': 'Reconnecte-toi pour continuer à jouer.', 'Your session has ended. Sign in again.': 'Ta session est terminée. Reconnecte-toi.',
    'Multiplayer sign-in needed': 'Connexion multijoueur requise', 'Sign-in needed': 'Connexion requise', 'Signing in': 'Connexion', 'Signing in…': 'Connexion…', 'Sign in': 'Se connecter',
    'Can’t join multiplayer': 'Impossible de rejoindre le multijoueur', 'This account is not allowed on the server.': 'Ce compte n’est pas autorisé sur le serveur.',
    'This account is banned from this server.': 'Ce compte est banni de ce serveur.',
    'The game engine crashed': 'Le moteur du jeu a planté', 'The game hit a fatal error': 'Le jeu a rencontré une erreur fatale', 'Engine failed to load': 'Le moteur n’a pas pu se charger',
    'Morrowind has exited': 'Morrowind s’est fermé', 'Could not load Morrowind data': 'Impossible de charger les données de Morrowind', 'Could not download the game': 'Impossible de télécharger le jeu',
    'Graphics context lost': 'Contexte graphique perdu', 'GPU context lost': 'Contexte graphique perdu', 'GPU context restored': 'Contexte graphique restauré',
    'The browser reset the GPU context (driver reset or resource pressure). ': 'Le navigateur a réinitialisé le contexte graphique (pilote ou manque de ressources). ',
    'Your game files do not match the server.': 'Tes fichiers de jeu ne correspondent pas à ceux du serveur.', 'Your game files are incomplete': 'Tes fichiers de jeu sont incomplets',
    'Browser not supported': 'Navigateur non pris en charge', 'This needs a desktop browser': 'Il faut un navigateur d’ordinateur', 'Page Unresponsive': 'La page ne répond plus',
    'Leave site?': 'Quitter le site ?', 'Streaming unavailable': 'Lecture en continu indisponible',
    'Your browser is hiding a graphics feature': 'Ton navigateur masque une fonction graphique', 'Unexpected error: ': 'Erreur inattendue : ',
  };
  // (phrases ending with a name, a number or an error: their start)
  const STARTS = [
    ['Friend request sent to ', 'Demande d’ami envoyée à '], ['Could not add: ', 'Ajout impossible : '], ['Now visible to: ', 'Visible maintenant par : '],
    ['Joining ', 'Connexion à '], ['Continue with ', 'Continuer avec '], ['Unexpected error: ', 'Erreur inattendue : '], ['Upload failed: ', 'Envoi impossible : '],
    ['Could not load the game engine (', 'Impossible de charger le moteur du jeu ('], ['Your sign-in could not be verified (', 'Ta connexion n’a pas pu être vérifiée ('],
    ['Redirecting to ', 'Redirection vers '],
  ];
  const ENDS = [[' invited you to join them.', ' t’invite à le rejoindre.'], [' sent you a friend request.', ' t’a envoyé une demande d’ami.'], [' players here.', ' joueurs ici.']];
  const tr = (s) => {
    if (!s || s.length > 400) return null;
    const t = s.trim(); if (!t) return null;
    let out = FR[t] ?? FR[s];
    if (out === undefined) { const p = STARTS.find(([a]) => t.startsWith(a)); if (p) out = p[1] + t.slice(p[0].length); }
    if (out === undefined) { const e = ENDS.find(([a]) => t.endsWith(a)); if (e) out = t.slice(0, -e[0].length) + e[1]; }
    if (out === undefined) return null;
    return FR[s] !== undefined ? out : s.replace(t, out);
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CANVAS', 'CODE', 'PRE']);
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  function node(n) {
    if (n.nodeType === 3) { if (n.parentNode && !SKIP.has(n.parentNode.nodeName)) { const o = tr(n.nodeValue); if (o !== null && o !== n.nodeValue) n.nodeValue = o; } return; }
    if (n.nodeType !== 1 || SKIP.has(n.nodeName)) return;
    for (const a of ATTRS) { const v = n.getAttribute(a); if (v) { const o = tr(v); if (o !== null && o !== v) n.setAttribute(a, o); } }
    if (n.nodeName === 'INPUT' && ['button', 'submit'].includes(n.type)) { const o = tr(n.value); if (o !== null) n.value = o; }
    for (const c of n.childNodes) node(c);
  }
  const start = () => {
    node(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') node(m.target);
        else if (m.type === 'attributes') node(m.target);
        else for (const a of m.addedNodes) node(a);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    document.documentElement.lang = 'fr';
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
