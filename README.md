# Orthros

Runtime navigateur qui exécute des jeux Windows **tels quels** (binaire inchangé) avec le CPU/RAM/GPU du client : émulation x86-32 (interpréteur de référence + recompilateur dynamique x86→WebAssembly), chargeur PE32, réimplémentation des API Win32/DirectX sur les API du navigateur, système de fichiers virtuel servi en HTTP.

Second type de jeu, sur le même accueil et le même serveur : les **portages navigateur** (`"runtime": "goldsrc"` dans le
manifeste). Les fichiers d'origine du jeu y tournent sur un moteur GoldSrc tiers épinglé, compilé en WebAssembly, dans
sa propre page (`src/ports/goldsrc/`), sans passer par l'émulateur ; le multijoueur passe par un serveur dédié natif
(Half-Life, Counter-Strike 1.6). Moteurs installés hors Git dans `data_engines/` : voir
[docs/browser-ports.md](docs/browser-ports.md). Même principe pour les portages re3 (`"runtime": "re3"`, un objet `re3`
à la place de `exe`) : un moteur décompilé de la famille re3 (reVC pour GTA Vice City) compilé en WebAssembly, en solo,
dans sa page `src/ports/re3/` — moteur construit depuis notre fork public [Lomchat/reVC](https://github.com/Lomchat/reVC)
(branche `orthros`), une carte à part sur l'accueil, sur les fichiers de la version Windows du jeu.

- `CLAUDE.md` — contraintes, architecture, conventions.
- `DECISIONS.md` — journal des décisions d'architecture.
- `STATUS.md` — état courant (palier, ce qui marche, blocages, prochaine action).

```
make test      # tests unitaires + conformité CPU
make serve     # serveur Orthros (http://localhost:8080)
make headless  # harnais Chromium headless

node bin/orthros.mjs run <dossier-du-jeu> [--open]   # sert un dossier de jeu quelconque, affiche l'URL à ouvrir dans Chrome
node bin/orthros.mjs cli <dossier-du-jeu>            # exécution Node sans rendu (diagnostic)
```

`orthros run` n'a besoin d'aucun fichier propre au jeu : l'exécutable principal est choisi par des règles génériques
(installateurs, désinstalleurs, lanceurs et outils écartés ; nom proche de celui du dossier, puis le plus gros). Un
`manifest.json` dans le dossier, ou `--exe` / `--args`, imposent un autre choix. Le navigateur garde les fichiers du jeu
lus une fois dans son stockage privé (OPFS) : les lancements suivants ne les retéléchargent pas. L'option « Copie hors ligne »
des paramètres du menu (bouton ⚙, onglet Général, ou `?offline=1`) télécharge tout le dossier en arrière-plan pour ne plus rien lire sur le réseau ;
le bouton « Télécharger d'abord » de chaque jeu de l'accueil télécharge tout le jeu avant de jouer (taille, débit mesuré, temps
restant, reprise à la visite suivante). Sur une connexion lente, les lectures du jeu passent avant tout téléchargement
d'arrière-plan, et la page affiche le débit mesuré et le temps estimé de l'étape en cours (docs/slow-network.md).

Souris, la même pour tous les jeux : un clic dans le jeu la capture (verrouillage du pointeur ; Échap la libère, un
nouveau clic la reprend, aussi après une perte de focus ou la fin d'une mesure `?bench=`). Capturée, seuls ses
mouvements relatifs existent : DirectInput les reçoit sans bornage (caméras à la souris), le curseur du jeu part de sa
position à lui (un `SetCursorPos` de recentrage compris) et s'arrête aux bords de l'écran et du rectangle `ClipCursor`
(défilement par les bords) ; la page le dessine. Libre, le pointeur ne transmet de mouvement que tant qu'il reste
sur le jeu (src/host/web/pointer.js). Au-dessus du jeu, la page montre le curseur système du jeu et lui seul, visible
quand Windows le montrerait : compteur de `ShowCursor` ≥ 0, une forme posée (`SetCursor(NULL)` l'ôte ; `WM_SETCURSOR`
envoyé à chaque mouvement, `DefWindowProc` pose le curseur de la classe), aucune souris DirectInput exclusive acquise.
Caché (un jeu qui dessine son propre curseur), la page n'en montre aucun, capturée ou non ; montré, sa forme (curseur
CSS, ou curseur dessiné par la page sous capture) — jamais la flèche du navigateur par-dessus le curseur du jeu.

Les jeux installés sont hors Git dans `/srv/orthros/data_games/<jeu>/`. **Chaque dossier immédiat représente un jeu**
et doit contenir `manifest.json`, `base/` et `versions/<version>/`. Le serveur découvre ces dossiers automatiquement :
pour ajouter un jeu, il suffit d'ajouter son dossier et de recharger la page. Le contrat du manifeste est décrit dans
[docs/game-manifest.schema.json](docs/game-manifest.schema.json). Exemple minimal :

```json
{
  "schemaVersion": 1,
  "id": "mon-jeu",
  "name": "Mon jeu",
  "defaultVersion": "mon-jeu-1.0",
  "defaults": { "mount": "C:\\Game" },
  "versions": [
    { "id": "mon-jeu-1.0", "dir": "1.0", "version": "1.0", "exe": "jeu.exe", "languages": ["fr"] }
  ]
}
```

Les identifiants de version sont stables : ils servent aux caches et sauvegardes. `exe` est recherché dans la
superposition de `base/` et de `versions/<dir>/`. Un portage navigateur déclare `"runtime": "goldsrc"` et un objet
`goldsrc` (moteur, dossier du jeu, modules, modes) à la place de `exe` (docs/browser-ports.md). Les dépendances éventuelles se déclarent avec
`requires: [{"game":"autre-jeu","version":"autre-jeu-1.0","mount":"C:\\AutreJeu"}]`.
Un jeu qui vérifie la présence de son disque se déclare avec `"cdrom": "D"` (ou `{"drive":"D","label":"…"}`) :
ses propres fichiers servent aussi de lecteur de CD-ROM.
Chaque manifeste assemble la base et les fichiers de sa version ;
les fichiers de version remplacent ceux de la base sans recopier les données communes. L'installeur a fourni les
versions BFME1 1.03 et 2.22 v7.0.4, BFME2 1.06 et 1.09 v3.01, et RotWK 2.01 et 2.02 v9.7.7. Les fichiers
anglais et français requis ont été vérifiés par MD5 ; les fichiers absents ont été récupérés depuis les adresses
du manifeste de l'installeur. Leurs caches et sauvegardes restent séparés par identifiant de manifeste. RotWK
monte également les fichiers de BFME2 1.06 dans son second lecteur virtuel.

Le menu permet de choisir la version et la langue avant le lancement. BFME1 2.22 ne propose que l'anglais car ses
menus ne passent pas en français. BFME2 1.06 est installé mais quitte encore pendant l'initialisation sous Orthros ;
sa 1.09 fonctionne. La langue du site se règle indépendamment dans l'en-tête. Le préfixe Wine de diagnostic est
dans `/srv/orthros/data_wine/wine-prefix/` ; les installateurs et ressources de réimportation sont dans
`/srv/orthros/data_installers/`. Ces trois dossiers sont exclus de Git. Le préfixe Wine ne conserve que les outils et
manifests de l'installeur, sans copies installées des jeux ni cache de téléchargement. `/srv/orthros/data_engines/`
(moteurs des portages navigateur et leurs sources épinglées) est lui aussi hors Git et à préserver comme `data_games/`.

## Paramètres et compte facultatif

En haut à droite de l'accueil : la langue (drapeaux), le bouton Paramètres (⚙) et le compte (le petit bonhomme). Les
paramètres ouvrent une fenêtre à trois onglets : Général (copie hors ligne, journal), Cet appareil (sauvegardes et cache
locaux) et En ligne (copies sur le compte) ; le compte a sa propre fenêtre. Le site et les jeux restent
accessibles sans compte. L'onglet Cet appareil affiche l'espace occupé, permet de demander la conservation du stockage par
le navigateur, d'exporter ou restaurer une archive `.orthros-save`, et d'effacer séparément le cache du jeu et ses
sauvegardes. Une restauration conserve une copie des données locales précédentes.

Un compte facultatif permet de copier les sauvegardes sur ce serveur et de les retrouver sur un autre appareil. La
synchronisation vérifie les changements et demande une décision en cas de conflit ; l'historique conserve jusqu'à 20
versions par jeu. Seuls les profils et sauvegardes sont transférés, jamais les fichiers du jeu. Les comptes de cette
version sont distincts de ceux de l'ancien site. Il n'y a pas encore de récupération du mot de passe par e-mail.

Pour activer les comptes sur une instance auto-hébergée, ajouter `--accounts <dossier-de-données>` au serveur. Ce
dossier contient la base SQLite et doit être persistant. Sur l'instance publique, il se trouve sous
`/var/lib/private/orthros2/accounts` ; ne pas le placer dans le répertoire servi au navigateur.

Connexion avec Google (facultative) : dans la console Google Cloud, créer un écran de consentement OAuth (externe,
champs d'application `openid`, `email`, `profile`) puis un identifiant client OAuth de type « Application Web » dont
l'URI de redirection autorisée est `<origine publique>/api/account/google/callback`
(`https://orthros.chalco.website/api/account/google/callback` sur l'instance publique). Écrire
`{ "clientId": "…", "clientSecret": "…" }` dans `google.json`, à côté de la base des comptes (lisible par le service
seulement) : le bouton « Continuer avec Google » apparaît sans redémarrage, et disparaît si le fichier est retiré.

## Diagnostic (harnais `tools/headless.mjs <manifeste | dossier>`)

- Scénarios : `--input "t:click:x,y;…"` (étapes `click`, `rclick`, `move`, `down`/`up`, `key`, `text`, `shot`, ancres
  `waitframe:min,max` / `waitpixel` / `waitfps`, temps relatifs `+t` depuis la première image), `tools/scenarios/`.
- Mesure : `--gl-discard` (CPU seul), `--frames-from s` (percentiles des temps d'image), `--profile s:n` (profil du
  worker, appelants des entrées chaudes, mix d'instructions des régions ; `--profile-list N` : leur listing),
  `--jit-profile` (transitions, chaînages, appels d'API rapides par API et sites d'appel).
- Images lentes : chaque étape `mark:<nom>` ouvre une phase ; la précédente (et la dernière, `end`, à la fin) reçoit un
  rapport `[frames]` — images > 33 / 40 / 50 ms par minute, percentiles, temps par catégorie (code invité, API, draws,
  JIT, programmes GL, textures, lectures, attentes, réveils tardifs…) des images et des images lentes, pires images ;
  `--phases <fichier>` les écrit en JSON (docs/frame-accounting.md). Télémétrie des joueurs :
  `node tools/telemetry-report.mjs /var/lib/private/orthros2/telemetry [--from AAAA-MM-JJ] [--to …] [--bench [nom]]`
  (machine, version, mode de rendu, résumés de 20 s : percentiles, images lentes, draws et appels GL par image, temps
  GPU par image quand le navigateur le mesure, attentes du worker de rendu ; mesures `bench` et leur comparaison).
- Réseau lent (docs/slow-network.md) : `--net <ms>:<Mbit/s>` simule le lien d'un joueur (85 Ko/s : `50:0.68`, 1 Mo/s :
  `50:8`, 5 Mo/s : `50:40`), `--net-trace <fichier>` journalise chaque plage servie ; validation standard d'un lien fin :
  `node tools/slow-net-check.mjs --bench vicecity-drive,bfme2-skirmish --speeds 85k,1m,5m --learn-from <copie du dossier
  learn du serveur> --games-dir /srv/orthros/data_games` (profil neuf, temps des phases, octets demandés / d'arrière-plan).
- Mesures sur une vraie machine (docs/real-machine-bench.md) : ouvrir un lien de mesure dans Chrome, cliquer « Start
  the measurement », ne plus toucher la souris ni le clavier jusqu'au résumé ; les résultats partent dans la télémétrie
  du serveur. BFME II : <https://orthros.chalco.website/?bench=bfme2-skirmish> (1.06 : ajouter `&manifest=bfme2-106`),
  Vice City : <https://orthros.chalco.website/?bench=vicecity-drive>, RotWK : `?bench=rotwk-skirmish`, BFME :
  `?bench=bfme1-skirmish`. Scénarios : `tools/scenarios/bench/` (vérifier
  au harnais : `--ui --bench <nom> --telemetry <dossier>` ; `--input-file <fichier>` joue un fichier de scénario).
- Rendu : `--capture-at @s` (une image : états de chaque draw, textures, cohérence GPU ↔ mémoire invitée ;
  `--capture-draws` : cible après chaque draw), `--gl-validate` (cache d'état GL, états approchés), `--dump-shaders`.
- Journaux `--log kinds` : `api`, `apisite` (premiers appels de chaque site), `com` / `comx` (COM sans les appels par
  draw), `file`, `filectx`, `procctx`, `reg`, `cpuid`, `debug` / `debugctx` (messages du jeu), `gfx`, `tex`, `jit`, `video`
  (vidéos et fichiers son lus par DirectShow ou MCI : docs/media-playback.md).
- Outils : `tools/vfs-check.mjs` (octets servis), `tools/sse-bench.mjs`, `tools/x87-bench.mjs`, `tools/chain-bench.mjs`,
  `tools/jit-dump.mjs` (WASM émis par instruction).
