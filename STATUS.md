# STATUS — Orthros

**Palier courant (2026-09-26) : deux jeux jouables** — La Bataille pour la Terre du Milieu (escarmouche, campagne jusqu'aux missions, sauvegarde/chargement, École de guerre, options) et La Bataille pour la Terre du Milieu II (escarmouche jusqu'à 4 joueurs, Guerre de l'Anneau, créateur de héros, sauvegarde/chargement ; la campagne ne démarre pas sur cette copie), écran de sélection des jeux. CPU seul sur ce serveur chargé : parties à la limite de 30 images/s du jeu (BFME2, carte à 2) ou ~37 (BFME1) ; grandes cartes à 4 ~20-22 images/s. Reste la mesure sur un vrai GPU client. (Historique : Palier courant (2026-09-24) — M6 atteint (partie jouable, audio, entrées, sauvegardes ; campagne jusqu'à la carte de la Terre du Milieu). M7 : critère tenu côté CPU sur ce serveur — escarmouche High, 30 min de partie : 38,4 fps, p99 30,6 ms (≤ 33 ms) ; reste la mesure sur un vrai GPU client (`node bin/orthros.mjs run <dossier>`). Fin de journée : deux bugs de rendu corrigés (sol des bases en Low/VeryLow, ombres portées au stencil en High), chargement d'une partie 116 → 67 s et démarrage 92 → 75 s (modes FPU, D050), registres XMM en locaux (D049). `orthros run <dossier>` lance un dossier de jeu quelconque sans fichier propre au jeu. Historique : M5 atteint le 2026-09-18 — le menu principal du jeu est rendu par Direct3D 9 → WebGL2 dans Chromium headless (800×600 plein écran, ~37 fps sous SwiftShader), libellés compris, et un clic scripté sur OPTIONS ouvre l'écran des options complet (preuves : `build/proof/m5-menu.png`, `build/proof/m5-options.png`, reproductibles par `node tools/headless.mjs bfme-vanilla --seconds 215 --shots 1 --input "190:click:338,573"`). M6 en cours.)

## Ce qui marche
- M0 : outillage (Node 24, Playwright Chromium, clang/lld-18), repo, `make test`, docs.
- M1 : décodeur x86-32 complet et interpréteur de référence validés contre l'**oracle natif**
  (6 suites × 1500 cas aléatoires, 0 écart ; 0 écart sur 24 000 cas supplémentaires).
- M2 : chargeur PE32 (sections, relocations, imports/exports/forwarders, TLS, ressources),
  espace d'adressage (VirtualAlloc & co), heaps, handles, processus/threads avec TEB/PEB/KUSER,
  thunks d'API (sortie vers JS à chaque appel d'import, D004), ordonnanceur green-threads (D003),
  rapports de crash (désassemblage, pile, trace des derniers appels API).
  Builtins : kernel32 (~300 fonctions), user32 (fenêtres, classes, messages, timers, entrées,
  modes d'affichage, ressources), gdi32 (DC, objets, blits/ROPs, DIB sections, texte bitmap).
  Trois PE de test compilés sans CRT (clang + lld-link) passent : `hello.exe` (WriteFile, heap, TLS,
  VirtualAlloc, fichiers), `window.exe` (fenêtre GDI, WM_PAINT, timers, souris/clavier, GetPixel,
  frame présentée au host), `threads.exe` (CreateThread, sections critiques, événements, Sleep).

- M3 : recompilateur dynamique x86→WebAssembly (`src/cpu/jit/`, voir D013) : émetteur binaire WASM,
  runtime (dispatcher + helper de drapeaux + `round24`), traducteur de régions (ISA entière complète,
  chaînes avec `memory.copy/fill`, x87 natif), repli interpréteur pour le reste (SSE, transcendantales,
  formes rares). Même conformité que M1 via le JIT (6 suites, 0 écart). **Bench : 65,8× l'interpréteur**
  (`node tools/bench.mjs`) — phases entier 87–136×, chaînes 39×, x87 56× ; ~0,8 G instr/s sur le serveur.
  Les 3 PE de test tournent sous le JIT. Invalidation de code sur SMC/VirtualFree/VirtualProtect/
  FlushInstructionCache/UnmapViewOfFile.

- **M4 (atteint)** : lanceur `node src/host/cli.js manifests/<jeu>.json` (dossier du jeu monté en lecture seule,
  profil utilisateur sur disque, registre amorcé par le manifest et persisté dans `registry.json`, profil CPU,
  liste automatique des imports inconnus). Le jeu charge sa CRT native (D017), crée sa fenêtre, lit le
  registre (`Language`, `UserDataLeafName` observés → amorçables), affiche son splash via **GDI+** réel
  (décodeurs JPEG/PNG/DEFLATE écrits de zéro, D019), énumère et ouvre toutes ses archives (jokers DOS, D018),
  lance sa **calibration CPU** puis sa **suite de benchmarks** (première exécution sans `Options.ini`) ; les
  exceptions C++ sont dispatchées et rattrapées via le SEH par continuation (D016). Ensuite il charge ses
  archives, écrit `Options.ini`, initialise Miles (DirectSound : tampons, notifications, thread de mixage, timers
  multimédia), DirectInput (clavier acquis), puis appelle **`Direct3DCreate9`** (traçé : « first Direct3D call »)
  et quitte proprement (code 1, boîte « DirectX Error ») faute de Direct3D — **critère M4 rempli**, ~92 s de
  bout en bout sous Node (`node src/host/cli.js manifests/bfme-vanilla.json --seconds 300`). Corrections
  majeures de cette phase : tas Win32 en mémoire invité (plus d'objet JS par bloc), table de hachage JIT 2^20 +
  réinsertion (D023), regroupement des modules WASM (D022), attentes déroulées (D021). Chemins rapides d'API
  en WASM (D015). **COM** générique (vtables de thunks en mémoire invité, D020) avec **DirectInput 8**
  (clavier/souris sur le flux d'entrées du gestionnaire de fenêtres, données immédiates et tamponnées),
  **DirectSound 8** (tampons en mémoire invité, curseurs pilotés par l'horloge, notifications, mixage
  flottant pour l'hôte) et la couche **Direct3D 8** (énumération d'un adaptateur DX8 générique, device qui
  suit tout l'état du pipeline, textures/surfaces/VB/IB en mémoire invité avec Lock/Unlock, backend
  branchable pour M5). **Hôte navigateur** : serveur COOP/COEP avec requêtes Range et listing JSON du dossier,
  page (canvases 2D + WebGL2 transférés à un worker, anneau d'entrées en SharedArrayBuffer, HUD perf,
  AudioWorklet alimenté par un anneau flottant), worker qui pompe la VM par tranches coopératives
  (`vm.runFor`, D021 : attentes déroulées), VFS HTTP-range avec cache de blocs, profil utilisateur en mémoire
  miroir OPFS, harnais Playwright headless (`tools/headless.mjs`, captures PNG). **Backend Direct3D 8 → WebGL2**
  (`src/gfx/d3d8-webgl.js` + `d3d8-shaders.js`) : génération GLSL du pipeline fixe (transformations, éclairage,
  étages de texture, brouillard, test alpha), traduction vs1.1 / ps1.x, textures (dont DXT décodé ou S3TC),
  VB/IB, cibles de rendu FBO, états de mélange/profondeur/stencil. Preuve : `tests/browser.test.js` fait tourner
  `window.exe` (GDI → canvas 2D) et `dx.exe` (Clear D3D → canvas WebGL) dans Chromium headless et vérifie les pixels.
  Tests : 25 (conformité, JIT, PE dont `gdiplus.exe` et `dx.exe`, codecs, navigateur).

## Limites connues (documentées, acceptées en v1)
- x87 en f64 (voir D011). Pas de faute de page. MMX non aliasé sur x87.
- GDI : texte avec les polices du jeu rastérisées par Canvas2D (D035) ; régions rectangulaires, pas de dialogues/menus
  réels. GDI+ : pas de texte ni d'IStream.
- Direct3D → WebGL2 : adressage BORDER / MIRRORONCE approché par CLAMP, biais de LOD non appliqué (non utilisés par le jeu,
  signalés par `--gl-validate`).
- `lstrcmp`/`lstrcmpi`/`CompareString` comparent en ordinal (Windows : tri linguistique).
- SEH : dispositions 0/1 seulement (pas de handlers imbriqués « nested exception »), pas de vectored handlers.

## Blocages
- Aucun.

## M5 (atteint)
- `src/win32/d3d9.js` : couche Direct3D 9 complète sur le cœur D3D partagé (déclarations de sommets, états
  d'échantillonneur, objets shaders vs/ps 1.x–2.x, state blocks, swap chain, requêtes, StretchRect/ColorFill/
  UpdateSurface, relecture `GetRenderTargetData`) ; `src/gfx/d3d9-shaders.js` : traduction SM 1.x–2.x avec `dcl`.
- Backend WebGL2 commun DX8/DX9 (`src/gfx/d3d8-webgl.js`) : orientation par cible (D024), diagnostics
  (erreurs GL, dump GLSL `--dump-shaders`, capture d'une image `--capture N`).
- Preuve : `node tools/headless.mjs bfme-vanilla --seconds 300` → le jeu crée un device 800×600 plein écran,
  ~30 appels de dessin par image, menu principal visible (fond 3D, logo, cadre des boutons, survol) ;
  `tests/browser.test.js` vérifie un triangle texturé DX9 et sa relecture pixel.
- Sens des faces corrigé (D024, `frontFace(CW)` à l'écran) : les libellés des boutons, tracés avec `D3DCULL_CW`,
  étaient éliminés ; `dx9.exe` teste désormais un triangle horaire visible et un anti-horaire éliminé.
- Images complètes uniquement (D025) : tampons arrière en FBO + trames explicites (`ImageBitmap`) vers la page ;
  device plein écran → mode d'affichage 800×600 et fenêtre en (0,0) (les clics arrivent aux bonnes coordonnées).
- Navigation souris : clic scripté sur OPTIONS → écran des options rendu en entier (~250 appels de dessin par image,
  ~24 fps sous SwiftShader, p99 84 ms — à mesurer sur GPU réel pour M7).

## M6 (en cours)
- Objectif : partie jouable 10 minutes (SOLO PLAY → escarmouche), audio via l'AudioWorklet, entrées, sauvegardes.
- Navigation scriptée SOLO PLAY → SKIRMISH → création de profil (saisie clavier) → START GAME : **la partie se lance**,
  carte 3D rendue (terrain, forteresse, arbres, unités, HUD) en fonctions fixes (détail « Very Low »), ~17 fps sous
  SwiftShader. Défauts visibles : quelques unités en magenta uni (texture manquante ?), enquête en cours (détecteur de
  textures « placeholder » + origine de création).
- Audio : le jeu diffuse sa musique (D026 — curseurs DirectSound pilotés par l'horloge) ; l'AudioWorklet consomme en
  temps réel (mixeur ~2 ms/s).
- **SSE/SSE2/SSE3/MMX traduits en WASM SIMD (D027)** : les ~2 M replis/s vectoriels ont disparu (2 k/s restants :
  PUSH/POP de segment, transcendantes x87) ; menu avec audio 20 → 39,5 fps ; bench phase SSE 2 989 ms (interpréteur)
  → 16 ms (JIT) ; ~4 500 cas oracle supplémentaires (`sse` étendue, `verify_float/int/mech`) verts sur les deux
  exécuteurs ; trois corrections de fidélité de l'interpréteur (EMMS/TOP, FTZ sur MIN/MAX, propagation des NaN).
  **En partie (escarmouche, carte 3D, ~250 appels de dessin/image) : 3 → 28-30 fps, p99 ≈ 47 ms sous SwiftShader**
  (`node tools/headless.mjs bfme-vanilla --seconds 330 --pump --fallback --input …`), replis restants 13 k/s
  (transcendantes x87, PUSH/POP de segment).
- **Transcendantes x87 traduites nativement** (F2XM1, FSCALE, FYL2X, FYL2XP1, FSIN, FCOS, FSINCOS, FPTAN, FPATAN) :
  noyaux WASM purs écrits de zéro dans le module runtime (`src/cpu/jit/fpmath-exp.js` exp2m1/log2/log2p1/scalb,
  `fpmath-trig.js` sin/cos/tan avec réduction Cody-Waite + Payne-Hanek, `fpmath-atan.js` atan2 ; constantes par
  `tools/gen_fpmath_exp.py`, `gen_pi_bits.py`, `gen_atan_table.py`), importés par les régions comme `round24`
  (WASM → WASM, D004). Précision ≤ 1 ulp vs référence exacte (exp/log), ≤ 0,5 ulp vs V8 (sin/cos), tan ≤ 1,6 ulp,
  atan2 ≤ 1 ulp ; 13-20 ns par appel ; FSINCOS par un noyau `sincos` à réduction unique (23 ns au lieu de 44) ;
  FSCALE arrondi une seule fois comme le matériel. Sémantique commune aux deux exécuteurs (C2 hors domaine
  |x| ≥ 2^63 fini avec ST inchangé, pas d'arrondi PC, C1 non modélisé). Suites oracle `x87` (1 237 cas, les cas IE
  sans SF ne sont plus sautés) et `verify_trans` (1 500 cas, coins matériels des transcendantes) : 0 écart, replis
  restants FLD/FSTP m80, FXAM, FPREM/FPREM1, FXTRACT. Bench phase `trans` (9 M transcendantes) : 1 510 → 288 ms
  (interpréteur 8 962 ms), 9 M replis → 0.
- **Exceptions x87 fidèles au matériel (D034)** : ES seulement sur exception démasquée, ±inf trigonométrique → IE +
  indéfini (poussé deux fois par FSINCOS/FPTAN), SNaN → IE + silencieux / QNaN propagé (signe, charge utile, plus
  grande mantisse de deux NaN), opérandes invalides (0·log2 0, 0·2^∞, √x<0…) → IE + indéfini, FYL2X(0, y) → ZE,
  F2XM1 hors [-1, 1] → ST(0) inchangé comme ce CPU, FSCALE dénormalisé arrondi une fois dans l'interpréteur aussi,
  NaN conservés par FLD/FSTP m80. Mesuré par `tools/gen/verify_trans_probe.py`, appliqué à l'identique dans
  l'interpréteur et le JIT (noyau `nan2`). `verify_trans` (1 500 cas) compare désormais motifs de NaN, IE|ZE|ES et
  FNSTSW : 0 écart sur les deux exécuteurs ; `verify_trans_known` (300 cas, non imposée) ne garde que C0/C3 conservés
  par le matériel, PE/DE/OE/UE non modélisés et FYL2XP1 pour x ≤ -1.
- Fidélité (trouvée par les traces) : mutex abandonnés à la sortie d'un thread (le rechargement du shell après un
  changement de détail attendait indéfiniment), `CreateProcess` → ERROR_FILE_NOT_FOUND quand l'image n'existe pas
  (les « TextureAssetBuilder.exe/assetCacheBuilder.exe » invoqués par le jeu sont absents du dossier), ordre NTFS de
  `FindFirstFile`, `ReadFile` avec OVERLAPPED (décalages intacts, pointeur avancé), formats D3D 32/33/35/36/81, R8G8B8
  non annoncé comme les pilotes réels.
- **Défaut connu (enquête bornée)** : quelques types d'unités sont rendus avec la texture « manquante » 1×1 magenta
  que le moteur génère lui-même (site `lotrbfme.exe+0x9ffd9b`, sans aucune lecture de fichier avant — recherche de nom
  infructueuse), aussi bien en détail Very Low (partie) qu'en détail High (menu 3D). Aucun HRESULT en échec, aucune
  lecture courte, ordre d'archives conforme, formats acceptés ; 3 textures sur ~1 500. À reprendre avec une trace des
  recherches de noms si le jeu expose un moyen générique (journal du moteur).
- Détail « High » : le menu principal devient une scène 3D (~2 000 appels de dessin/image, 4-6 fps sous SwiftShader,
  726 textures ≈ 150 Mo) et le renderer headless a fini par mourir (mémoire, à mesurer sur GPU réel) — piste M7.
- **Mesure M7 sur 10 min en partie (Very Low, SwiftShader, run hl98, `--frames-from 260`)** : 22 863 images en 601 s =
  **38,1 fps ; p50 26,1 ms, p90 28,9 ms, p99 34,2 ms, max 89 ms ; 1,42 % des images > 33 ms** (324), 20 > 50 ms — un
  épisode lent vers t = 727 s (30 fps, p99 50 ms sur 500 ms). Le critère p99 ≤ 33 ms est manqué de ~1 ms.
  Diagnostic des images lentes (`--log slowframe` : deltas de compteurs par image > 33 ms, run hl99 : 38,0 fps, p99
  34,3 ms, 1,41 % > 33 ms) : elles arrivent par **rafales de 10-20 s** (t ≈ 475-482, 590-602, 622-642 s) pendant
  lesquelles le travail par image est inchangé (≈ 6 000 appels d'API, 241 dessins, 30-45 tranches, 0 traduction JIT,
  0 envoi de texture, présentation 0,1 ms) mais le worker exécute 15-30 % de moins d'instructions et d'appels par
  seconde : ralentissement de l'hôte (processus GPU SwiftShader à ~950 % de CPU, suites de tests d'un workflow
  concurrentes) plutôt que travail de l'émulateur — à re-mesurer machine calme.
- **Stabilité 10 min en partie (Very Low, headless SwiftShader)** : `--seconds 840` → en jeu de 230 s à 840 s sans
  blocage ni plantage, 19 000 images, 25-34 fps, p99 40-50 ms (`build/shots7`, run hl57) ; entrées en jeu acceptées
  (clic, clic droit, Échap, déplacement au bord).
- **M7 (démarré)** — mesures en jeu (Very Low, SwiftShader, `--profile 290:20`) : avant = 28-30 fps, `bufferSubData`
  16 % du temps worker ; après envoi partiel des tampons (plage verrouillée), emplacements d'uniformes résolus une fois
  par programme (noms constants) et mémoïsation du programme par version d'état du device : **35-37 fps, p99 38 ms**,
  `bufferSubData` 0,4 %. Puis chaînage des régions par appels terminaux (D029) : dispatcher 10 % → 1,8 %, p99 33 ms,
  fps moyen 35 (worker saturé : profil plat — `dispatchThunk` 3,7 %, `applyState` 2,9 %, `u` 2,5 %, `programUncached`
  2,4 %, `materialize` 2,2 %, `surfaceToRgba` 2,1 %, COM 1,9 %). Tentative de drapeaux paresseux côté JS (repli à la
  lecture d'EFLAGS) abandonnée : le démarrage du jeu partait en boucle de continuation SEH — cause non isolée, repli
  eager conservé. Outils : régions nommées `r_<eip>` dans les profils, mix d'instructions des régions chaudes.
- Hôte graphique (suite) : groupes d'uniformes versionnés (transformations, lumières, viewport, constantes, états),
  cache d'état GL (enable/blend/depth/cull/masks/viewport/scissor, samplers, attributs) → 37,6 fps, **p99 29 ms**,
  `d3d8-webgl.js` 13,4 % → 9,6 % du worker ; conversion 32 bits des textures A8R8G8B8 par mots.
- Hôte graphique (suite, détail High : ~1 500 dessins/image, 17 k dessins/s) : versions de transformation **par
  emplacement** (une `SetTransform` par objet ne renvoie plus vue, projection et matrices de texture ; les lumières
  suivent la seule matrice de vue), `SetLight`/`SetMaterial`/`LightEnable` et `SetRenderState`/`SetTextureStageState`/
  `SetTexture` comparés à la valeur courante (les jeux renvoient les mêmes états avant chaque objet : plus de
  réinvalidation du programme ni de renvoi des uniformes). `uniformMatrix4fv` 13,5 % → matrice monde seule ; en jeu
  (Very Low) le worker passe de 12,9 % à 15,4 % de temps libre à fps égal. Sous SwiftShader chaque appel GL coûte
  ~5 µs : à High, ~16-22 % du worker reste dans les appels GL (attributs de sommets par dessin, uniformes des étages),
  le code invité en occupe 62-65 % (profil plat, 2 500 régions) — la limite à High est le débit du JIT, pas le rendu.
- **Pile x87 en locaux WASM (D030)** : bench phase fpu 270 → 70 ms (3,8×), `round24` sorti du profil, suites x87 /
  verify_mech / sse vertes (88 tests + 2 todo documentant des écarts préexistants : bits IE/ES du mot d'état sur
  comparaison non ordonnée, arrondi PC=24 sur demi-ulp exact) ; en jeu 37 → 37,8 fps, p99 31-32 ms ; le code invité
  reste ~50 % du worker (logique du jeu elle-même), le reste : dispatch d'API 5 %, ordonnanceur/horloge ~9 %, GL 10 %.
- Constat (statistiques de Sleep par thread) : le thread principal du jeu appelle `Sleep(0)` + `timeGetTime` ~100 000
  fois/s en jeu (limiteur de cadence / attente active), 18 M d'appels en 5 min ; les autres threads dorment 1-2 ms.
  Le jeu se rythme donc lui-même (~38 fps en jeu, pas une limite CPU) ; mitigation générique : après 32 `Sleep(0)`
  consécutifs sans autre thread prêt, la tranche dort 1 ms (résolution des timers Windows). Le compteur de série
  n'admettait qu'un seul appel intercalé alors que la boucle en fait deux (`Sleep(0)` + `timeGetTime`) : corrigé,
  la mitigation se déclenche (58 k fois en 5 min), `Sleep`/`timeGetTime` passent de ~115 k/s chacun à ~39 k/s, le
  worker dort 13 % du temps (`Atomics.wait`) à fps égal (38-40 fps, p99 29-34 ms, run hl96).
- **Détail High, menu 3D (D032)** : après ~25 s la scène du menu change (écran de chargement rendu par un thread dédié) ;
  le thread principal restait en livelock (`WaitForSingleObject(A, 1)`/`ReleaseMutex` à 1,2 M itérations/s : il ne voyait
  jamais le mutex tenu par le thread de chargement). Corrigé génériquement : attentes satisfaites à l'instant du signal
  (revendication au réveil, transfert à `ReleaseMutex`/`LeaveCriticalSection`/`SetEvent`/`ReleaseSemaphore`/sortie de
  thread) + drapeau `RESUMING` qui écarte les chemins rapides WASM d'API pendant la ré-exécution d'un appel garé
  (sans lui, `EnterCriticalSection` inline comptait une récursion et la section restait tenue : blocage au démarrage).
  Programme de test `sync.exe` (7 scénarios) ajouté aux tests PE. La seconde scène du shell (forteresse) s'affiche.
- Démarrage : la phase mono-thread initiale (~60-75 s à 500-800 MIPS, 1-2 M replis/s de F2XM1+FSCALE) est la **suite de
  benchmarks de première exécution** du jeu (absence d'`Options.ini`) ; le harnais headless repartait d'un profil vide à
  chaque run. Nouvelle option `--profile-dir <dossier>` (profil chargé au démarrage, réécrit à la fin) : au second run le
  jeu atteint Direct3D à 26 s (au lieu de ~100 s) et le menu à ~70 s (au lieu de ~125 s). Les transcendantes x87 en
  WASM natif (voir ci-dessus) ne raccourcissent pas cette phase : la suite de benchmarks est bornée en temps (chaque
  test tourne pendant une fenêtre fixe), le score monte (+31 % et +47 % de MIPS dans les deux fenêtres qui
  repliaient FSIN/FCOS puis F2XM1/FSCALE, 0 repli pendant tout le démarrage) mais `threads=3` arrive à 74-75 s et
  Direct3D à 83-84 s avant comme après ; `--profile-dir`/`--opfs` reste le seul moyen de sauter ces ~75 s.
- **Détail High, 9 min headless (D032)** : la seconde scène du shell (forteresse, ~1 500 appels de dessin/image) se charge
  (~60 s sous SwiftShader) et tourne de 245 s à 540 s sans blocage ni plantage (`build/shots15`, run hl83) — le
  « plantage après ~5 min » précédent était le livelock ci-dessus vu de l'extérieur. 6-14 fps, p99 ≈ 500 ms sous
  SwiftShader (rasterisation logicielle de 1 500 dessins : à mesurer sur GPU réel ; replis interpréteur 50-90 k/s à
  identifier — les transcendantes x87 sont maintenant natives, à re-mesurer ; au menu il reste PUSH/POP de segment
  ~880/s chacun, FXAM et XLAT ~79/s, FPREM ~39/s).
- Profil CPU du worker (menu, 37 fps) : `dispatchThunk` 15 %, `clock.now` + `performance.now` 20 %, `bufferSubData`
  8 %, ordonnanceur 13 %, code invité (WASM) 17 % seulement → l'hôte domine ; pistes M7 : horloge mise en cache par
  tranche, chemin d'appel d'API plus court, envois de tampons de sommets groupés.
- Harnais headless : entrées scriptées relatives à la première image Direct3D (`+35:click:…`), détecteur de blocage
  (worker muet > 15 s → pause CDP du worker et pile d'appels). Il a révélé un interblocage d'attentes imbriquées dans
  la WndProc (clic SKIRMISH), corrigé par les rappels au niveau invité (D028 : `DispatchMessage`/`SendMessage`/
  `CallWindowProc` sautent dans la WndProc sans frame JS, retour par le thunk `__callback_return`).
- Saisie clavier : `WM_CHAR` uniquement via `TranslateMessage` (le nom de profil n'est plus dupliqué).
- Sauvegardes : le jeu écrit `Options.ini`, `Skirmish.ini`, `<profil>SkirmishStats.ini` dans le profil. **Miroir OPFS
  vérifié** (`--opfs <user-data-dir>` : contexte navigateur persistant + port fixe, l'OPFS étant par origine) : au second
  run le jeu retrouve ses réglages et saute sa suite de benchmarks (Direct3D à 25 s, menu à 58 s, `build/shots20`).

## Rendu (2026-09-23, suite)
- **Texte avec les vraies polices** (D035) : le jeu extrait et enregistre ses polices (`AddFontResourceExA` : SachaWynterTight,
  Albertus MT), le moteur de texte GDI les réalise avec des métriques GDI et les rastérise par Canvas2D dans le worker ; menus,
  écran d'escarmouche, infobulles et HUD affichent maintenant le texte du jeu tel quel (fini la police bitmap 5×7).
- **Curseurs du jeu** : `LoadCursorFromFileA` (54 curseurs .ani/.cur) → curseur CSS animé sur la page (non visible en headless).
- Direct3D : règle des centres de pixels D3D8/9 (demi-pixel, texte/UI nets en filtrage bilinéaire — test damier dans `dx9.exe`),
  alpha test après pixel shaders, brouillard « table » sur la distance œil (w), DEPTHBIAS en unités de profondeur, rampe gamma
  (`SetGammaRamp`/`SetDeviceGammaRamp`, passe LUT au Present), `GetDC` sur surfaces, `UpdateSurface`/`CopyRects` DXT par blocs,
  P8 non annoncé (comme les vrais pilotes).
- Outils : `--capture-at <s|+s> [--capture-draws]` (textures de chaque draw avec tous les niveaux de mip, cible après chaque draw,
  état complet, premiers sommets, plages d'UV, matrices de texture, historique d'écriture des surfaces) ; histogramme complet des
  API en fin de run ; `--corpus` (formes d'instructions du code traduit).
- **CPU** (D036/D037) : suite de conformité `corpus` (762 formes réellement exécutées par le jeu, 7 134 cas ; 35 670 à 60 cas/forme)
  → 3 bugs x87 du JIT (arrondis dirigés en PC=24, FST m32 dirigé) et 2 de l'interpréteur corrigés ; noyaux WASM `arith24`/`f32rc`.
- **Détail High** : le sol était entièrement noir — le pixel shader ps_1_1 du terrain commence par `def c3, 0,0,0,0` et
  l'analyseur SM 1.x prenait ces zéros pour des instructions (D038). Corrigé : terrain, architecture et décor du menu 3D
  s'affichent correctement. Tables `ctype`/casse de la CRT native corrigées (chaînes comptées, D039). Cache de VAO et
  suppression des envois GL redondants (D040 ; écran Options : 10,4 appels GL/draw mesurés avant).
- Défauts restants en partie (détail Very Low) :
  - **3 textures « magenta »** (drapeaux des porte-étendards en partie ; en High, quelques soldats du menu) : le moteur crée
    via son D3DX lié statiquement une texture 1×1 remplie de magenta (sa texture « manquante ») puis, pour ces textures-là,
    ne tente *aucun* chargement (ni recherche de fichier, ni lecture d'archive — traces `apiburst`), alors que les autres
    proxies sont suivis d'une recherche puis d'une vraie texture. Déterministe (mêmes ressources avec le VFS HTTP et le VFS
    Node), CPU conforme sur toutes les formes d'instructions du jeu (suite `corpus`), et **l'interpréteur de référence se
    comporte exactement comme le JIT** (même proxy, même suite d'appels — test différentiel CLI `--interp`). Hypothèse restante :
    données absentes du dossier (outils `TextureAssetBuilder`/`assetCacheBuilder` introuvables).
  - **Sol de la forteresse en Very Low** en aplats gris : le draw échantillonne une zone « bande sombre » de l'atlas 256×128
    que le moteur compose lui-même sur le CPU (à partir de copies internes, sans verrou de lecture sur des textures) ; mapping
    (UV, mips, matrices) vérifié correct côté Orthros. **En détail High le même sol est correct** (pavage clair et herbe,
    `build/shots52`) : pas de bug d'émulation établi, point classé. Revu le 2026-09-24 : l'atlas 256×128 (herbe, dallage,
    zones de fondu, bande sombre) est identique au bit près avec les registres x87 f32 désactivés ; ses routines
    d'écriture (repérées par `--watch-tex`) sont des routines partagées très chaudes, trop lentes à interpréter
    (`--interp-range`, même activé juste avant la partie) pour atteindre la partie.
- **Partie en détail High** (headless, SwiftShader ~5 fps) : terrain, forteresse, arbres, unités corrects ; restent les
  drapeaux magenta. Régression corrigée le 2026-09-23 : traînées de blocs parasites dans les textures de terrain
  (DXT1 256×256 composées par le jeu) — une sortie de budget sur un arc arrière réécrivait les registres x87 f32
  après la rotation de la pile (ST(1) écrasé). Trouvée par bissection en jeu (`--no-f32`, `--f32-off
  arith,round,m32,const`, plages `part@lo:hi`), couverte par des programmes x87 aléatoires avec boucles et sauts
  exécutés en tranches de temps courtes. Scénario d'entrées : `tools/scenarios/bfme-skirmish-high.txt` (le menu 3D High est interactif plus tard
  et un premier clic passe son animation d'entrée).

## Performance CPU (2026-09-23)
- **Méthode** : en headless le rendu logiciel (SwiftShader) borne la cadence au détail High — le worker attend dans
  `bufferSubData`, et un gain CPU ne se voit pas en fps. `--gl-discard` (RASTERIZER_DISCARD : mêmes appels GL, rien
  de rastérisé) rend la mesure CPU-bound ; les comparaisons se font en **A/B simultanés** (worktree du commit de
  référence + HEAD, mêmes conditions de charge sur la machine partagée), menu 3D High, moyenne t = 200-265 s.
  `--jit-profile` compte les transitions (sauts avant/arrière, dispatchs, `ret`, chaînages) ; `--profile s:n` donne
  le profil CPU du worker et le mix d'instructions des régions chaudes ; `node tools/x87-bench.mjs [xform]`,
  `node tools/bench.mjs jit` pour les micro-mesures.
- **JIT** (D041, D042) : flot de contrôle structuré (boucles WASM, sauts avant directs), flags testés en début de bloc
  sans helper, `ret` locaux, budget en local, traduction 2,7× plus rapide ; régions x87 spécialisées sur le mot de
  contrôle, registres x87 en f32 en précision 24 bits, règle NaN matérielle. Appels COM différés pour les setters
  d'état Direct3D (file en mémoire invitée, vidée avant tout appel d'API JS).
- **Résultats** (menu High, `--gl-discard`) : 8,5 fps / 280 MIPS au début de la journée → 11,7 fps après les régions
  x87 en f32 → ~12,3 après la vivacité des flags (D043) ; les mesures suivantes, faites sur une machine moins chargée,
  donnent 14-15 fps pour le même code (seuls les A/B simultanés sont comparables ; bruit A/A ±2 %). bench.exe
  1 115 → ~420 ms ; transformation de sommets x87 24 bits 86 → 22 ns.
- **En partie** (escarmouche High, début de partie) : ~38 fps en CPU seul — la cadence plafond du jeu (D031) — avec
  ~14 % d'attente. Mesure du 2026-09-23 (`--gl-discard --frames-from 660`, 341 s de partie) : **38,3 fps, p50 26,0 ms,
  p90 27,8, p99 31,1, max 56 ms ; 0,50 % des images > 33 ms**. Les images lentes n'ont ni traduction ni upload :
  ce sont les bouffées de logique du jeu (seule une exécution plus rapide du code invité les réduit).
  **Critère M7 sur 10 min de partie (2026-09-23, run seul sur la machine, scénario de jeu
  `tools/scenarios/bfme-skirmish-high-play.txt` : sélection de la citadelle, recrutement, portes, défilement de
  caméra ; `--gl-discard --frames-from 700`) : 25 009 images en 651 s = 38,4 fps ; p50 26,1 ms, p90 27,8, p99 30,0,
  max 58 ms ; 0,29 % > 33 ms, 6 > 50 ms — p99 ≤ 33 ms tenu côté CPU.** Les pires images contiennent une lecture
  HTTP synchrone de 4 Mio (lecture anticipée d'un lecteur séquentiel, ~25 ms) ; le magasin OPFS supprime ces lectures
  aux lancements suivants (3e lancement : 0 requête). Un préchargement asynchrone des blocs suivants a été essayé
  (A/B au menu) : −9 % de temps synchrone pour +50 % d'octets transférés (accès surtout aléatoires dans les
  archives) — abandonné. Un run concurrent avec rendu SwiftShader sur la machine
  dégrade la mesure (p99 46 ms) : les mesures se font seules. **30 min de partie** (même protocole, 2026-09-24) :
  69 201 images en 1 802 s = 38,4 fps ; p50 26,0 ms, p90 28,4, p99 30,6, max 121 ms ; 0,31 % > 33 ms, 9 > 50 ms ;
  aucun plantage. Le menu 3D est la scène lourde
  (~17 k appels d'API, 1 700 draws et 25-37 M instructions par image).
- **Réglages mesurés en jeu** : régions de 48 blocs (24 : −16 %, 96 : = ; un chaînage coûte ~6 ns, ~10 ns entre
  régions x87, ~7 M/s au menu) ; boucles imbriquées structurées −13 % (V8, D044) : désactivées.
- **Appels dans les régions** (D045) : chemins f32 du x87 sans appel, étiquettes x87 statiques, aiguillage des flags
  sur toutes les sortes en ligne. Restent en jeu : `flags` pour BT*/ROL/CMPS et INC/DEC après SHL (~150 000 appels/s),
  `arith24`/`f32rc` dans les régions x87 en mode FPU inconnu (décodeur MP3 de Miles). Le profil `--profile` liste les
  appels de chaque région chaude (import@instruction).
- Constat structurel restant : trop de valeurs vivantes dans les régions (8 registres invités + 5 valeurs de flags
  paresseux + budget + bloc) pour les ~11 registres allouables par V8 : variables de boucle en pile. Tout appel dans
  une région (même sur un chemin froid) fait vider les registres — d'où les sorties vers l'interpréteur pour les cas
  rares plutôt que des appels.

## Backend, fichiers, audio, lancement générique (2026-09-23, fin de journée)
- **Programmes GL par signature numérique** : quand un état de la clé de programme change (bascules d'états entre
  draws en partie), les entrées de la clé sont relues comme entiers et retrouvées par hachage ; les chaînes de clé ne
  sont construites que pour une combinaison nouvelle. Profil en partie : `programUncached` 4,3 % + annexes → 1,6 % ;
  backend WebGL 17,2 % → 10,1 % du worker.
- **Appels GL par image en partie** : 2 573 (5,8/draw) ; `uniform1i` des échantillonneurs posés une fois au link (108/image
  en moins), `activeTexture` seulement quand l'unité change. **Bug corrigé** : les téléversements de textures liaient la
  texture sur l'unité active sans mettre à jour le cache de liaisons — un draw suivant pouvait échantillonner la texture
  téléversée. Re-téléversements en `texSubImage2D` (plus de réallocation), diagnostic « placeholder » limité au premier
  téléversement (il reconvertissait deux textures dynamiques 128×128 ~50 fois/s).
- **Magasin OPFS des fichiers du jeu** (`src/vfs/opfs-store.js`) : blocs lus une fois gardés dans le stockage privé
  du navigateur, relus de façon synchrone (3e lancement : 0 requête HTTP). Préchargement asynchrone essayé et abandonné
  (+50 % d'octets pour −9 % de temps synchrone).
- **Audio** : avance du tampon de sortie adaptative (93 → 280 ms selon les sous-alimentations, retour après 30 s calmes),
  mixage avant les attentes imbriquées ; au menu High, sous-alimentations après la création du tampon du jeu 12 400 →
  1 800 en 220 s ; en partie quasi nulles.
- **`orthros run <dossier>`** (`bin/orthros.mjs`, `src/host/manifest.js`) : sert un dossier de jeu quelconque avec un
  manifeste synthétisé par règles génériques ; le harnais headless et la CLI Node acceptent un dossier (vérifié avec un
  dossier contenant dx9.exe, setup.exe et uninstall.exe).
- Textures magenta : le jeu lance `TextureAssetBuilder.exe` / `assetCacheBuilder.exe` depuis son dossier (absents) et
  cherche des textures en fichiers libres (`trwagontraveled*`) sans les trouver — pas d'écart d'émulation identifiable
  (l'interpréteur de référence reproduit le même comportement ; avec le chargement non threadé du jeu, option
  `IsThreadedLoad = no` d'Options.ini, les mêmes unités restent magenta : pas une course du thread de chargement) :
  classé données/outils absents du dossier.

## Robustesse et démarrage (2026-09-24)
- **Bug x87 (arrondi dirigé en précision 24 bits)** : le chemin en ligne (masquage des bits) ne s'exécutait jamais (bits
  RC combinés à un booléen par un `and` binaire) et lisait des bits périmés ; tout résultat passait par le noyau exact.
  Corrigé, plus : résultat sur la grille 24 bits exact sans noyau pour des opérandes flottants (×, ÷, √ ; + et − si
  l'erreur TwoSum est nulle), `FST m32` d'une valeur déjà flottante sans `f32rc`. Profil des 110 premières secondes :
  `arith24` + `rnd24` + `f32rc` 20 % → hors profil. Tests x87 aléatoires : arrondi vers +∞ ajouté, 3 000 graines ×
  6 mots de contrôle conformes.
- **Démarrage** : ~90 s jusqu'au menu 3D en CPU seul, rythmé par des phases chronométrées du jeu (écran de
  démarrage, boucle de mesure, chargement) : ~18 M appels d'API rapides/s à un moment (verrous de la CRT) ; un
  trampoline qui les enchaînait sans repasser par le répartiteur n'a rien changé (ni démarrage ni menu) : non gardé.
- **Protections de pages des images** comme le chargeur Windows (en-têtes en lecture, sections selon leurs
  caractéristiques) ; `IsBad*Ptr` tient compte des protections ; `IsBadStringPtrA/W` sondent jusqu'au NUL.
- **Perte du contexte WebGL** (réinitialisation GPU, pilote) : contexte restauré, objets GL recréés et ressources
  re-téléversées depuis la mémoire invitée ; vérifié avec `--lose-context-at` au menu High.
- **30 min de partie** : 38,4 fps, p99 30,6 ms, aucun plantage (voir « Performance CPU »).
- **Versions de région par mode FPU** : une région x87 atteinte sous plusieurs modes (CRT partagée par des threads en
  24 et 53 bits, décodeur MP3) reçoit une version spécialisée par mode (jusqu'à 3, chaînées depuis la garde d'entrée)
  au lieu de devenir générique (tests de mode et appels de noyaux dans chaque opération).
- **Ombrage plat** (`D3DRS_SHADEMODE = FLAT`, utilisé par le jeu) : couleurs `flat` + convention du premier sommet
  (`WEBGL_provoking_vertex`). Toutes les opérations d'étage de texture utilisées par le jeu sont couvertes.
- **Validation du cache d'état GL** (`--gl-validate`) : aucun écart sur 5,5 M draws (menu) ; l'outil détecte le bug de
  liaison de textures corrigé si on le réintroduit.
- **Campagne** : menus Campagne → Bien → difficulté → carte parcheminée puis carte 3D de la Terre du Milieu (nuages,
  Mordor), zoom sur les Monts Brumeux avec la consigne « Select the Fellowship and click on Moria » et l'infobulle de la
  Communauté — rendus correctement, aucun avertissement ; vidéo VP6 du menu ouverte depuis `Data\Movies`.
- **Appels GL par image en partie** : 2 326 pour 447 draws (5,2/draw ; 5,8 avant : `activeTexture` 170 → 40,
  `uniform1i` 108 → 33). **Mémoire** : ~2 Go résidents au pic du chargement, ~1,6 Go au menu, stable.
- **Copie hors ligne** (option : case du menu, `?offline=1`, `--offline`) : tout le dossier du jeu (4 Gio) téléchargé en
  arrière-plan dans le magasin OPFS pendant la partie (~3 min en local), en cédant la priorité aux lectures du jeu ;
  lancement suivant jusqu'à une partie : 0 requête HTTP. **Mémoire sur 30 min de menu** : 1 612 → 1 677 Mo résidents
  après le démarrage (lente montée, scènes du menu 3D qui chargent de nouveaux contenus).
- **Harnais** : ancres robustes `waitframe:min,max` (draws par image : écran de chargement puis partie, marche avec
  `--gl-discard`) et `waitpixel` ; `--capture-at @N` compte depuis la dernière ancre ; `--interp-range[-at]` (code
  interprété par la référence), `--gl-validate`, `--lose-context-at`.

## Fidélité et performance (2026-09-24, suite)
- **Horloge et processeur virtuels cohérents** : RDTSC compte à `CPU_MHZ` (3 000) par microseconde comme le `~MHz` du
  registre (il comptait à 1 GHz) ; CPUID expose les feuilles étendues (0x80000000..8 : chaîne de marque, cache L2,
  tailles d'adresses — présentes sur tout processeur depuis le Pentium 4) avec la même chaîne de marque que
  `ProcessorNameString` ; clés `HKLM\Software\Microsoft\Direct3D` et `DirectDraw` créées comme par le runtime DirectX.
  Le jeu lit ces valeurs au démarrage (`--log cpuid`). Un profil neuf reste recommandé **VeryLow** par le banc d'essai
  du jeu : la recommandation ne vient pas de ces valeurs (mesure de vitesse du jeu lui-même, non faussée).
- **Registres XMM en locaux** (D049) : les phases chronométrées du premier lancement montrent une phase à 530 MIPS
  (maths : `pow` SSE2 de la CRT, sin/cos x87) contre 1 500-4 700 ailleurs ; cause : chaque instruction SSE relisait ses
  registres en mémoire (écriture 8 octets puis lecture 16 : transfert écriture→lecture en échec). Les XMM vivent
  maintenant en locaux v128 dans une région : `tools/sse-bench.mjs` 107,5 → 23,4 ns par itération ; phase maths
  530 → 825 MIPS ; menu High neutre.
- **Unités magenta, enquête close** : en choisissant la couleur rouge au lieu de « ? » (aléatoire), les chariots et la
  bannière de la citadelle passent au rouge (couleur du joueur correcte) mais les corps des ouvriers restent magenta :
  c'est la texture de remplacement du moteur (1×1 magenta, créée par le jeu lui-même) pour des textures absentes. Le
  moteur les cherche (ex. `cinmrdbnr01`, `trwagontraveled`) dans toutes ses dossiers de fichiers libres après ses
  archives, sans les trouver. Vérifié côté émulation : processeur (interpréteur de référence identique), octets servis
  (`tools/vfs-check.mjs` : 3 000 plages, 1,16 Gio comparés, 0 écart), ordre d'énumération des archives (collation NTFS,
  `_patch222*` après les lettres), échec de `CreateProcess` des outils `TextureAssetBuilder.exe`/`assetCacheBuilder.exe`
  absents du dossier (FALSE + `ERROR_FILE_NOT_FOUND` comme Windows). Classé : données absentes du dossier.
- **Mini-carte** : correcte (carte parcheminée de la carte, emplacements, unités, trapèze de la caméra). L'aperçu
  `MapPreviews\*.tga` écrit par le jeu est uni brun, avec ou sans rendu : calculé par le processeur à partir des
  données de la carte (aucun appel Direct3D avant l'écriture, `--log filectx`) — sortie du jeu lui-même.
- **Bug de rendu corrigé : sol des bases en détail Low/VeryLow** (le détail recommandé aux nouveaux joueurs). Le sol
  pavé de la citadelle s'affichait en gris uni avec des taches claires au lieu des dalles. Capture d'image : même
  maillage, mêmes coordonnées et même atlas qu'en High ; les taches valaient exactement la couleur de sommet (les deux
  échantillonneurs lisaient le blanc de la texture de brouillard de guerre), le gris foncé cette couleur × 7/15 (le
  gris A4R4G4B4 de cette texture). Cause : un draw lie ses étages dans l'ordre et téléverse une texture modifiée en y
  arrivant ; le téléversement liait la texture sur l'unité active — celle de l'étage lié juste avant, remplacée (le
  cache d'état suivait, donc `--gl-validate` ne voyait rien). Les téléversements passent maintenant par une unité
  réservée. Test avec un contexte GL enregistreur (échoue sans la correction). Preuves : `build/proof/low-floor-before.png`,
  `build/proof/low-floor-fixed.png`. La capture compare désormais chaque texture relue du GPU avec la mémoire invitée.
- **Bug de rendu corrigé : ombres portées absentes en High.** Le jeu dessine des volumes d'ombre au stencil (faces
  arrière INCR, faces avant DECRSAT, écriture couleur coupée, puis assombrissement là où le compte ≥ 1) avec une
  référence `STENCILREF = 0x80808080`. Direct3D garde les bits du stencil 8 bits (0x80) ; WebGL prend la référence en
  entier signé et la borne à [0, 255] : 0x80808080 devenait 0, le test `GREATER 0x80` des volumes n'était jamais vrai.
  Référence masquée à 8 bits. La citadelle, les tours de porte, les obélisques, les cyprès et les remparts projettent
  maintenant leurs ombres (`build/proof/high-shadows-before.png`, `build/proof/high-shadows-fixed.png`). Test avec le
  contexte GL enregistreur.
- **Chargement d'une partie 116 → 67 s** (High, CPU seul, A/B simultanés) : 82 % du chargement tenait dans quatre
  boucles x87 compilées en mode FPU générique — l'une restaure le mot de contrôle de l'appelant avant son `ret` (tout ce
  qui était atteignable depuis ce FLDCW devenait générique), une autre tourne entièrement en arrondi vers zéro (seul
  l'arrondi au plus près avait un chemin spécialisé). Transferts gardés au lieu de la propagation, arrondis dirigés en
  ligne (D050). Test : boucle qui alterne 24/53 bits à chaque tour avec un appel local qui sauve/tronque/restaure ;
  `FSTP m32` sous chaque arrondi dirigé à 53/64 bits sur des valeurs limites. Démarrage (même A/B) : première image
  39 → 33 s, menu 3D complet 92 → 75 s ; menu High neutre (18,8 / 18,4 fps). Jusqu'à 4 versions par mode FPU (24/53 bits
  × au plus près/troncature, les quatre modes vus pour du code partagé) : plus aucune région générique en jeu.
- **API rapides dans les régions** : pendant le chargement, le répartiteur traitait jusqu'à 17 M appels d'API rapides
  par seconde (sortie de région, répartiteur WASM, retour) — l'accès aux données par thread de la CRT (GetLastError,
  TlsGetValue, SetLastError) et les sections critiques de l'allocateur du jeu. Un `call dword ptr [slot]` (entrée d'import
  ou variable pointeur de fonction) ou un talon `jmp dword ptr [slot]` dont la case contient la thunk d'une API rapide à
  la traduction l'exécute maintenant dans la région (case et RESUMING vérifiés à l'exécution, cas lents vers le
  gestionnaire JavaScript). Chargement d'une partie 60 → 55 s (A/B simultanés), menu neutre ; restent ~30 k appels COM
  différés/s par vtable. `--jit-profile` compte les appels rapides par API et échantillonne leurs sites d'appel.
- **Contrôle de non-régression en partie** (5 min du scénario de jeu High, `--gl-discard`, runs successifs, machine
  partagée chargée — charge moyenne ~20) : code du matin 37,3 fps, p99 45,6 ms, 3,16 % > 33 ms, max 404 ms ; code du soir
  37,6 fps, p99 44,9 ms, 2,52 % > 33 ms, max 184 ms (partie atteinte 38 s plus tôt). Le p99 au-dessus de 33 ms vient de la
  charge de la machine (mesures M7 faites seul) ; à refaire seul ou sur la machine cliente. **15 min de partie** avec tout
  le code du jour : 33 736 images en 891 s = 37,9 fps, p50 26,1 ms, p90 28,1, p99 40,5 (machine chargée), aucun
  plantage, 5 avertissements connus.
- **Messages de débogage du jeu** (`--log debug`, `debugctx` : avec les appels API qui précèdent) : l'avertissement de
  D3DX sur `new(0)` renvoyant NULL vient du gestionnaire mémoire du jeu (notre `HeapAlloc(…, 0)` rend un bloc valide et
  n'est pas appelé à ce moment) ; « Could not find file » suit l'ouverture échouée de `shaders\Shrubs_darken.vso`,
  absent du dossier — données, comme les textures des unités magenta. Le lancement de `TextureAssetBuilder.exe` /
  `assetCacheBuilder.exe` suit directement l'initialisation du device et le démarrage d'un thread de chargement, sans
  lecture de dates de fichiers ni de registre juste avant (`--log procctx`) : pas de test de fraîcheur du cache qu'une
  date mal émulée ferait échouer.
- **Diagnostics** : `--profile-list N` (instructions des régions les plus chaudes), `--log comx` (appels COM sans les
  appels par draw, 20 par méthode et site), `--log filectx` (appels API précédant l'ouverture d'un fichier en
  écriture), `--log cpuid`, `tools/vfs-check.mjs <manifeste|dossier>` (exactitude des octets servis),
  `tools/sse-bench.mjs` ; `tools/jit-dump.mjs` charge les traducteurs x87/SSE (il les montrait en repli).
- Écart connu non corrigé : `lstrcmp`/`lstrcmpi`/`CompareString` comparent en ordinal (Windows : tri linguistique,
  minuscules avant majuscules d'une même lettre, tirets et apostrophes à part) — n'affecte que l'ordre de listes triées.

## Instance pour jouer (mise à jour 2026-09-29)
- **https://orthros.chalco.website** : accès public au menu des jeux, sans code d'entrée ; compteur d'images en haut à gauche (clic : compact / détaillé).
- Servie directement depuis `/srv/orthros` par `orthros.service` (127.0.0.1:8095, utilisateur dynamique),
  bloc Caddy `orthros.chalco.website` (pas de compression sur `/game/*`). Après une modification
  du serveur Node, redémarrer avec `systemctl restart orthros`. L’ancien projet BFME utilise
  `orthros-old.service` et `orthros-live.chalco.website`; `orth2.chalco.website` redirige vers le nouveau domaine.
- Depuis le 30 septembre, les jeux sont dans `/srv/orthros/data_games/` (manifestes BFME 1 et BFME 2 directs),
  les bundles de l'ancien site dans `data_games/bundles/` et le préfixe Wine dans `/srv/orthros/data_wine/`.
  Ces dossiers, ainsi que `.claude/` et `.charon-uploads/`, sont exclus de Git.
- Le menu « Mes données » gère les sauvegardes et le cache locaux, l'export et la restauration d'archives, ainsi qu'un
  compte facultatif pour les copies en ligne. L'API des comptes utilise la base SQLite persistante de
  `/var/lib/private/orthros2/accounts`. Les jeux sont accessibles sans compte et les comptes de l'ancien site ne sont
  pas repris. Les menus emploient le bleu nuit et l'orange de l'ancien site.
- **Écran d'accueil refait (2026-09-29)** : `src/host/web/home.js` + `home.css` + `embers.js`, montés par `main.js` (`mountHome`).
  Palette tirée du logo (bleu nuit, yeux ambre, rouge sang, os) ; mot-symbole ORTHROS en pixel-art dessiné cellule par cellule
  (SVG généré, sans police externe) ; le chien à deux têtes en grand, yeux qui pulsent et s'embrasent quand un jeu est survolé,
  braises (canvas, arrêtées pour de bon au lancement d'un jeu : plus aucun `requestAnimationFrame` de l'accueil, mesuré) ;
  bouton « Reprendre » (dernier jeu) ; cartes avec couverture, fond flouté qui suit le jeu survolé, navigation aux flèches par
  position réelle ; états chargement / vide / erreur ; options (copie hors ligne, journal) dans un popover ⚙ ; FR/EN selon le
  navigateur (`?lang=`, mémorisé). « Mes données » s'accroche à `[data-slot="data"]` (son dialogue reste en français ; le
  chargement et l'en-tête de jeu restent en anglais — à traduire si besoin). Les règles `#menu` de `data-manager.css` ont été retirées.
- Mesures des joueurs : `/var/lib/private/orthros2/telemetry/telemetry-<date>.jsonl` (échantillons ~0,5 s : fps, pire
  image, images > 33 / 50 ms, p99, MIPS, API/s, draws, Mo lus, état ; environnement navigateur / GPU en début de session).
- Vérifié de bout en bout par l'URL publique (Chromium headless, profil vierge) : isolation cross-origin, lecture des
  fichiers par plages, menu à ~38 fps après ~110 s (premier lancement : banc d'essai du jeu), aucune erreur.

## Retour du premier joueur (2026-09-24, soir)
- **Session du joueur** (Windows, Chrome 154, Intel Iris Xe, 20 cœurs) : arrêt du jeu (code 3) à 74 s, pendant le
  premier lancement. Reproduit ici en faisant perdre puis retrouver le focus à la page : **Reset du device** (état par
  défaut remis après les tampons arrière : cible de rendu 0 perdue) et **perte de device non émulée** (le jeu libère ses
  ressources à la désactivation et continuait à dessiner) — corrigés (D052) ; les sauts vers une adresse sans mémoire
  sont des violations d'accès précises (D053). Vérifié : 7/7 chargements avec perte/retour du focus arrivent au menu,
  deux Alt+Tab en pleine partie (pause puis reprise, image correcte).
- **Diagnostic à distance** : une sortie avec un code non nul envoie un rapport (état du thread, pile, derniers appels
  API, dernières exceptions avec le type C++ lancé) et la fin du journal dans l'événement de télémétrie ; les samples
  portent l'attente réseau (`net` ms, `netReq`).
- **Page joueur** : bandeau « loading… » tant qu'aucune nouvelle image n'est venue depuis 3 s (au lieu de « 0 fps »),
  « paused » quand la page n'a pas le focus, bouton Restart après un arrêt ; requêtes de fichiers réessayées (réseau).
- **Réseau** : plages compressées (D054). Temps mesurés ici : premier lancement ~109 s jusqu'au menu (dont ~60 s de
  calcul propre au premier lancement du jeu, proportionnel au travail : `?timescale` le montre), lancements suivants
  ~46 s (profil et blocs en OPFS).
- JIT : vivacité des drapeaux sur toute la région (INC/DEC ne préservent CF que si un successeur le lit) — gain dans
  le bruit (les appels à l'assistant de drapeaux étaient déjà rares dans les boucles chaudes du démarrage).
- **Préchargement appris** : le serveur retient l'ordre des blocs lus par les sessions (`--learn`), la page les
  télécharge en fond vers OPFS pendant que le jeu calcule. Réseau simulé 40 ms / 50 Mbit/s : première image 56 → 49 s,
  chargement d'une partie 93 → 72 s ; en réel (profil vierge, URL publique) 490 Mo préchargés pendant le premier
  lancement, le jeu ne lit ensuite que ~50 Mo par le réseau. Coût dans le worker : écritures 1,4 %, fetch 0,6 %, GC 0,5 %.
- **Préchargement qui suit le jeu** : (1) le serveur apprend aussi, par bloc, le masque des morceaux de 64 Kio lus
  (4e champ de la liste, absent pour les anciennes entrées) ; la page suit la position du jeu dans la liste apprise
  (premier contact avec un bloc listé) et va chercher d'avance les morceaux appris des 32 entrées suivantes (3 requêtes
  au plus, non annulées ; une lecture garée d'un morceau en vol l'attend) ; (2) la passe des blocs entiers repart de
  la position du jeu (puis le début de la liste) ; (3) elle ne s'arrête plus tant que le remplissage des blocs touchés
  a du travail : sous `--net 40:20` avec profil, ce remplissage ne se vidait jamais et la passe restait bloquée sur
  l'entrée 0 toute la session (0 bloc préchargé). Harnais `--opfs --net 40:20` (lien partagé), scénario
  bfme2-skirmish-sync, liste apprise avec masques (déduits d'une session, mêmes entrées des deux côtés), 1re session :
  première image 74 → 42 s, menu 88 → 67 s, chargement de la partie 77 → 55 s, images lentes avec E/S en jeu
  70 (17,9 s cumulées, attente E/S 22 s) → 28 (6,9 s, 8,3 s) ; requêtes du jeu 1 293 (158 s) → 581 (78 s).
  Une seule paire (machine partagée, charge 35-45 : les autres essais n'ont pas atteint 20 images/s au menu).
  2e session : le socle ne fait déjà plus qu'une requête réseau (tout est en OPFS après la 1re).
- **Entrées** : la souris est suivie sur toute la page, bornée aux bords du jeu (défilement aux bords sans capture) ;
  bouton « Fullscreen » cliquable ; un relâchement de bouton attend que le jeu ait présenté une image depuis l'appui
  (≤ 250 ms : un clic plus court qu'une image lente n'est plus perdu — vu au menu 3D High sous SwiftShader) ;
  GetAsyncKeyState rend le bit 0 (appuyé depuis l'appel précédent).
- **Attentes au démarrage** : AddFontResource garait le thread jusqu'au décodage de la police par le navigateur, mais
  rien ne relançait l'ordonnanceur avant l'échéance de 5 s — ~10 s perdues à chaque lancement (deux polices). Le moteur
  de texte réveille l'hôte ; le worker n'a plus qu'une relance en attente (un réveil remplace un minuteur au lieu
  d'ajouter une chaîne : chaque événement d'entrée en ajoutait une). Second lancement : première image 42 → 35 s.
  Diagnostics `hang` (tranche de plus d'une seconde, tous les threads en attente) et `--hang-after` au harnais.
- **x87 24 bits** : un produit/somme au milieu 24 bits avec un opérande double (0,9…) est tranché en ligne (erreur
  exacte TwoSum / Dekker) : 6,85 M pas d'interpréteur → 12 au premier lancement (temps dans le bruit).
- Partie de 24 min avec deux Alt+Tab (machine chargée par un autre projet, charge ~48) : aucun plantage, 34,6 fps,
  p99 57 ms ; A/B simultané contre le déploiement d'hier au menu High : 10,70 / 10,78 fps (pas de régression, la
  machine chargée divise le débit par ~1,7).
- Vérifié : changement de résolution dans Options (Reset 1024x768, rendu à cette taille, retour à 800x600 faute de
  confirmation, comportement du jeu) ; `tools/startbench.mjs` (premier lancement dans Node, temps CPU) : 72 s / 82 s CPU
  jusqu'au lancement des outils d'assets, boucles imbriquées structurées neutres (73,8 contre 73,3 s).

## Saccades en partie (2026-09-25)
- **Retour du joueur** : curseur invisible et souris qui sort de la fenêtre (corrigés, 0d603e2 : SetCursor(NULL)
  indépendant de ShowCursor, capture du pointeur au clic, curseur dessiné par la page) ; « petits lags de temps en
  temps, animations, constructions ». Sa télémétrie (Iris Xe) : 33 fps médian en partie, des pointes de 400-1200 ms
  toutes les ~10 s, sans compilation de programme au même moment.
- **Déchets et GC** (D055) : un VAO créé pour ~2 % des draws (600/s, tous jetés tous les 8 192) → un VAO par
  (programme, tampon, pas) ; allocations du worker 1 458 → 540 Mo par minute de partie (adresse du bloc d'état passée
  en indice de mot : elle était boxée à chaque sortie du JIT ; vues et chaînes par draw supprimées). Les pauses GC de
  150-400 ms vues sous le harnais sont un artefact de DevTools (Chrome lancé sans DevTools : ≤ 14 ms) — outils
  ajoutés : `--chrome-trace <début>:<durée>` (événements longs du worker et leur contenu), `--heap-snapshot <t>`,
  profil d'allocation avec les appelants des fonctions natives, `--api-times` (le temps par API n'est plus mesuré par
  défaut sous le harnais).
- **Programmes GL et régions de code appris** (D056) : partie scriptée, images ≥ 100 ms après le début de la partie
  22 → 15 → 11 (sans / programmes / programmes + régions), dépassement cumulé au-delà de 33 ms 13,8 → 7,8 → 4,5 s,
  programmes construits au premier draw 119 (974 ms) → 7 (24 ms). La préparation des régions n'utilise que les temps
  d'attente du jeu (rares ici sur la machine chargée, fréquents sur une machine rapide aux menus).
- **Télémétrie** : chaque échantillon porte la part de temps du worker occupé (`busy`) et le temps de traduction
  (`jit`) ; chaque image de 150 ms et plus envoie sa décomposition (traduction, programmes, lectures, attentes) :
  événement `slow`, les 150 premières par session.

## Second jeu : La Bataille pour la Terre du Milieu II, écran de sélection (2026-09-25, soir)
- **BFME2** (`manifests/bfme2.json`, dossier `/srv/orthros/data_games/bfme2`, exécutable `game.dat`) : menu principal, menu 3D
  (shell map), escarmouche rendue (terrain, eau, arbres, forteresse, unités, interface), son. Écrit pour lui, en
  générique : **d3dx9** (toutes les versions `d3dx9_24..43`, D057) — maths, textures depuis fichiers (DDS/TGA/BMP/JPEG/
  PNG, encodeur DXT), assembleur de shaders, **framework d'effets** (binaires fx_2_0, ID3DXEffect, préshaders) ; **shlwapi** ;
  MoveFileW, RemoveDirectoryW, GetDiskFreeSpace(Ex)W. Corrections de fidélité trouvées sur ses shaders (blocs de
  commentaires contenant 0x0000FFFF, adressage relatif vs 1.x, compteurs de boucles `defi`, `mova` masqué, instructions
  de contrôle à sources seules) et sur ses effets (dimensions des matrices, table des états).
- **Performance d'une partie** (CPU seul, `--gl-discard`, machine chargée) : ~13 → ~25 fps (runtime des effets, 9421968),
  puis **40,0 → 32,3 ms de CPU du worker par image** (changements de shader / déclaration comptés seulement s'ils changent
  vraiment, signature de programme réduite quand les deux étages sont programmables, préshaders compilés en JavaScript).
  Démarrage : ~56 s jusqu'au menu (second lancement, public), dont ~45 s de calcul du jeu lui-même (code invité à 92 %).
- **Écran de sélection** : une carte par jeu (image d'accueil du jeu désignée par le manifest, description, taille,
  dernier joué), flèches/Entrée, « Games » dans le coin et « Back to the games » après une sortie ; orth2 démarre
  sur cet écran (plus de `--default`).
- **Mesure** : `--cpu-window a:b` donne le temps CPU du fil du worker par image (lu dans /proc) — stable sous la charge,
  contrairement aux fps (les A/B simultanés ont un effet de position de ~13 %) ; `--control <fichier>` pilote une
  session en cours (clics, touches, captures) ; `--pump` donne la part du worker par thread invité (le thread principal
  du jeu : ~90 %).

## Nuit du 25 au 26 septembre
- **Traduction en arrière-plan** (D058) : les régions apprises sont traduites dans un second worker (mémoire invitée
  partagée) ; traduction sur le fil du jeu pendant le chargement 11,9 → 1,3 s (BFME2), 7,7 → 1,1 s (BFME1).
- **Effets D3DX : états calculés** — un état de passe donné par une expression (code de version 'FX' : AlphaTestEnable,
  AlphaBlendEnable, CullMode, ZWriteEnable… calculés depuis un paramètre) gardait sa constante. Corrigé : le menu 3D de
  BFME2 (statues de l'Argonath, falaises, arbres, rayons de lumière) est rendu correctement ; il n'en restait que des
  silhouettes noires et des arbres en carrés opaques.
- **Partie BFME2 (CPU seul)** : à la limite de 30 images/s du jeu sur ce serveur (p50 32,9 ms, p99 39,8 ms, 9 images
  > 50 ms en 100 s — des lectures de fichiers, locales pour un joueur après une première partie). BFME1 : p50 26 ms,
  p99 44 ms. Constantes de shader envoyées par plage modifiée ; IDCT JPEG 1,6× (chargements D3DX).
- **Vérifié en jeu (BFME2)** : sélection, menu radial, construction d'extensions, info-bulles, **sauvegarde et
  chargement** d'une partie. La campagne du Bien ne démarre pas (le choix de difficulté referme la boîte sans rien
  charger ni signaler) : comportement probable du patch communautaire 1.09 v3.1 de cette copie, non d'Orthros.
- Outils : `--control <fichier>` (session pilotée en direct), `--cpu-window` (CPU du worker et du processus GPU par
  image), entrée `burst:N` (trace d'API), `--dbg ORTHROS_FX_DESCRIBE=1` (états des passes d'effets avec leurs valeurs).
- **Audio mixé dans l'AudioWorklet** (D059) depuis la mémoire invitée partagée : plus de sous-alimentation quand le jeu
  est occupé (0 contre ~9 400 en 150 s sous charge), BFME1 et BFME2.
- **Moins de travail par image** : FXAM et XLAT traduits nativement (~1 900 replis/s chacun dans une partie BFME2),
  maths D3DX, effets, attentes et répartiteur sans allocation par appel (432 → 302 Mo alloués par 30 s), ~8-10 % de
  CPU du worker en moins.
- **Vérifié aussi (BFME2)** : tutoriel (carte, cinématique), changement de résolution (Reset du device aller-retour,
  le jeu revient à l'ancienne résolution faute de confirmation), options. « My Heroes » et la campagne ne s'ouvrent pas
  (le menu disparaît, rien n'est chargé, aucune erreur) : très probablement une restriction du patch 1.09 v3.1.
  Le menu radar est un croquis sur parchemin (voulu).
- **Chargement d'une carte BFME2** : textures D3DX (encodeur DXT sans objet par bloc, entrée de palette la plus proche
  par projection sur l'axe des extrémités, niveaux de mip filtrés depuis le RGBA du niveau précédent, conversions par
  format, rectangles écrits seuls) et allocateur d'espace d'adressage avec borne basse de recherche : plus aucun
  décodage DXT, part de D3DX dans la fenêtre de chargement mesurée ~33 % → ~29 % (→ ~17 % sur la seule phase textures).
- **Moins d'allers-retours vers JavaScript** : les setters de paramètres d'effets (SetVector/Matrix/Float/Int/Bool/
  Texture avec un handle de l'effet ; un nom passe toujours par JavaScript) sont mis en file par le JIT comme les états
  Direct3D (partie BFME2 : 32,8 → 31,1 et 35,1 → 32,1 ms de CPU par image, deux A/B) ; mutex non contendus (état en
  mémoire invitée, rendu au thread en attente par JavaScript dès qu'il y en a un) et timeGetTime / GetTickCount /
  QueryPerformanceCounter (horloge importée) traités en WebAssembly (partie BFME2 : 34,6 → 32,4 et 31,6 → 29,9 ms).
  Essayé puis retiré : détecter les rafales de Sleep(0) sur le temps propre du thread (le fil principal de BFME2 en
  fait ~1,6 M par partie) — il les endort plus souvent, mais ses Sleep(0) attendent aussi les autres threads : 29,6 →
  27,5 fps, p99 45 → 75 ms.
- **Blocage corrigé (BFME2, retour au menu après La Guerre de l'Anneau)** : l'objet x87 de l'interpréteur gardait
  l'état du thread courant à sa création ; toute instruction x87 interprétée pour un autre thread (replis du JIT :
  FPREM, FNSTENV/FLDENV, chargements m80...) travaillait sur les registres d'un autre thread. Le thread du second écran
  de chargement tournait dans le fmod du runtime C (FPREM ne remettait jamais son C2 à zéro) en tenant le verrou
  attendu par le fil principal. Trouvé avec les nouvelles commandes du harnais (`threads`, `dump`, `watch`,
  `--log sync`, `ORTHROS_TRACE_HANDLE`). Le JIT remet aussi C1 à zéro (une fois par bloc) comme le processeur.
  La campagne ne démarre toujours pas (EASY referme la boîte, aucun appel système, aucun thread, aucune lecture
  ensuite) — y compris quand tout le code passe à l'interpréteur de référence juste avant le clic : ce n'est pas le
  JIT ; décision interne au jeu (données / patch 1.09 v3.1 de cette copie, probablement). La campagne du Mal se
  comporte de même.
- **BFME2 « My Heroes »** (créateur de héros) s'ouvre maintenant (liste, classes, statistiques, portrait) — il ne
  s'ouvrait pas avant la correction x87 par thread — et un héros se crée de bout en bout (classe, apparence,
  attributs, nom, pouvoirs, enregistré dans la liste). Reste : dans l'aperçu 3D le héros est cadré trop bas (on ne
  voit que son buste en bas de l'image dans l'écran de création — il semble enfoncé dans le sol —, et plus du tout
  dans l'écran de sélection), la photo du héros ne montre donc que le ciel. Dans l'aperçu « Appearance » (ses tracés, maillages animés par os, ne produisent aucun pixel ; le décor du même aperçu, oui) :
  d'après les constantes de la capture, la caméra de l'aperçu regarde au-dessus de la scène (le héros se projette à
  y ≈ −2 en coordonnées normalisées, le sol de la scène n'est pas visible non plus) — placement calculé par le jeu,
  cause non trouvée ; identique quand tout le code passe à l'interpréteur de référence avant l'ouverture de l'écran
  (ce n'est pas le JIT).
- **Couleurs de sommets dans les shaders** : une entrée typée D3DCOLOR par la déclaration de sommets est lue (R, G, B, A)
  comme Direct3D la développe (octets B, G, R, A en mémoire) ; seul le pipeline fixe le faisait. Le terrain de BFME2
  (éclairage par sommet) avait le rouge et le bleu inversés : il sort maintenant chaud au lieu d'olive.
- **Charger une partie sauvegardée (BFME1) faisait planter la page** : le jeu recrée la carte de la sauvegarde sous
  « c:\users\player\...\save\map mp carrock.map » (tout en minuscules) ; les points de montage du VFS étaient
  comparés en respectant la casse (→ ERROR_PATH_NOT_FOUND), puis l'exception C++ qui a suivi a révélé l'emplacement
  unique de dispatch SEH par thread (une exception levée pendant un gestionnaire l'écrasait : ~12 000 avertissements
  en boucle, le moteur de rendu mourait). Corrigé (montages insensibles à la casse, pile de dispatchs SEH, tests) ;
  vérifié : sauvegarde puis chargement dans une escarmouche, et chargement depuis le menu Solo → Load dans une
  nouvelle session.
- **Vérifié (BFME2)** : La Guerre de l'Anneau démarre (profil créé, carte stratégique 3D, tour 1, phase tactique ; fin
  de phase → tour 2) ;
  sauvegarde d'une escarmouche, fermeture, puis « Load Game » depuis le menu dans une nouvelle session : la partie
  reprend. BFME1 : changement de résolution 800×600 → 1024×768 confirmé (le jeu revient en arrière sans confirmation
  sous 10 s, comme sous Windows ; il ne propose que des modes 4:3).
- **Vérifié (BFME2)** : escarmouche à 4 sur les Champs aux Iris (moi + IA facile, difficile, brutale) pendant 30 min :
  les armées des IA attaquent et se battent autour de ma forteresse (des dizaines d'unités), aucune erreur.
- **Vérifié (BFME1)** : École de guerre (leçons animées), escarmouche avec le Mordor (forteresse, unités, menu de
  construction radial, construction), détails « Ultra High » (le jeu avertit que sa machine pourrait être lente, puis
  la partie est rendue correctement).
- Les boutons de l'interface 3D des jeux (menu de jeu, carte de campagne) ignorent un clic synthétique trop bref : le
  harnais les pilote avec `down` / `up` espacés (un vrai clic dure 80-150 ms).
- **Vérifié (BFME1, détails élevés)** : campagne du Bien de bout en bout — carte de la Terre du Milieu en 3D, la
  Communauté envoyée en Moria, écran de chargement puis cinématique de la mission (~30 images/s). Sur la carte 3D, un
  clic synthétique trop bref (appui relâché dès l'image suivante) n'est pas pris : un vrai clic (80-150 ms) l'est.
- **Appels WebGL** (`--gl-count t:images`, sans les lectures de la capture) : partie BFME2 1 460 appels par image pour
  154 tracés (9,5 par tracé), aucune relecture ; partie BFME1 ~6,5 appels par tracé.
- **Bilan mesuré de la journée (partie BFME2, CPU du worker par image, `--gl-discard`)** : quatre paires simultanées
  « build de ce matin (7b09cdc) / build actuel » ; les deux navigateurs d'une paire ne sont pas à égalité (celui dont le
  processus GPU consomme ~348 ms/image au lieu de ~220 est plus lent de 2-4 ms, quel que soit l'ordre de lancement) :
  à emplacement égal, ~1 ms de moins par image (32,2 → 31,1 ms, ~3 %). Les A/B de chaque changement (5-9 %) étaient en
  partie gonflés par ce biais.
- **BFME1 en détails élevés (CPU seul)** : partie ~37 fps (24-25 ms de CPU par image) ; le menu 3D (grande bataille en
  fond) reste lourd, 13-18 fps (72-74 ms par image dont 75 % dans le code du jeu, calcul x87 réparti sur ~3 300
  régions). Sous SwiftShader (sans `--gl-discard`), la même partie tombe à 6-12 fps : c'est le rendu logiciel du
  serveur, pas le worker.

## 28 septembre : multijoueur, en-tête, écran de chargement
- **Multijoueur en réseau local virtuel (D061)** : tous les joueurs d'un jeu sur le serveur partagent un réseau local ;
  Winsock émulé (UDP/TCP) relayé par le serveur (WebSocket). BFME2 (Network → Open Play) et BFME1 (Multiplayer →
  Network) : un joueur crée une partie, l'autre la voit, la rejoint, ils jouent ensemble (vérifié avec deux navigateurs).
- **En-tête** (logo Orthros, jeu, images/s avec petit graphe, préchargement en arrière-plan, joueurs du réseau local,
  plein écran, retour aux jeux ; caché en plein écran) et **écran de chargement** (couverture du jeu floutée, barre avec
  pourcentage, étapes, débit, astuces).
- **Plantage au démarrage de BFME2 chez le joueur** (RangeError dans Heap.free_) : le tas ne suit plus une balise de
  bloc écrasée par le programme hors de l'espace d'adressage ; les blocs sont désormais alignés sur 8 octets comme sous
  Windows (un bloc sur deux ne l'était pas).

## Nuit du 28 au 29 septembre : chargement de BFME2, diagnostic du plantage du joueur
- **Plantage BFME2 chez le joueur (image-4)** : pile écrasée (retour vers 0x53524852, texte de noms de ressources) 3 ms
  après l'échec des lancements d'`assetCacheBuilder` & co. — les 3 sessions BFME2 du joueur (Iris Xe, 20 cœurs) ont
  planté, aucune des miennes. Non reproduit ici malgré : traduction d'arrière-plan terminée avant le démarrage
  (`--dbg ORTHROS_BG_FIRST=1`), réseau lent (`--net`), réseau local connecté, clics/Échap/Espace pendant le chargement,
  machine vue 10× plus rapide (`--timescale 0.1`), régions/programmes appris d'orth2 ; les plages servies par orth2
  sont identiques aux fichiers (364 blocs vérifiés). Robustesse et diagnostic déployés : une exception sans pile
  utilisable termine le processus avec un rapport (plus de RangeError dans `Seh.writeContext`) ; le premier saut vers
  une adresse non allouée journalise un rapport complet (registres, code, appels API récents, fichiers ouverts,
  octets de la pile en hexa/texte) envoyé avec la télémétrie ; une erreur de l'émulateur porte aussi le rapport de la VM.
  → attendre la prochaine session du joueur.
- **Éclairage du pipeline fixe** : matériau et lumières en tableaux de vec4 (un appel GL pour le matériau, un pour les
  lumières modifiées d'un tracé) au lieu d'un tableau de structures (un appel par champ, 11 par lumière) : menu 3D de
  BFME2 18,1 → 7,6 appels WebGL par tracé (6 300 → 2 340 par image). `Apply` d'un state block n'invalide plus ce qu'il
  ne contient pas.
- **Chargement BFME2 = ~75 s de calcul pur sur un thread** avant la fenêtre (40 appels API/s) : profils par tranches
  de 5 s → phases entières (1 400-4 700 MIPS), copies `memmove` arrière (`STD; REP MOVS`), maths SSE2 du runtime C et
  x87 `FSIN/FCOS` (570-860 MIPS), puissances x87 `F2XM1/FSCALE` (~1 200 MIPS). Première vague d'optimisations du JIT
  (5 agents en parallèle, chacune mesurée et relue par un second agent contre l'interpréteur de référence) :
  REP MOVS/STOS dans les deux sens par `memory.copy/fill` quand c'est équivalent (arrière n=64 : 39 → 11 ns ; corrige
  au passage l'absence de détection SMC des REP STOSW/D) ; voie 0 des registres XMM dans des locaux f32 pour le SSE
  scalaire (0,46 → 0,32 ns/instr., 0,92 → 0,32 avec des dénormaux dans les voies hautes) ; F2XM1/FSCALE/FSIN/FCOS en
  ligne pour les arguments courants, bit à bit identiques (séquence exp x87 27 → 14,5 ns) ; FNSAVE/FRSTOR/FNSTENV/
  FLDENV/FLD-FSTP m80 natifs au lieu de replis sur l'interpréteur ; prédiction des drapeaux paresseux d'un bloc à
  l'autre (DEC en tête de bloc 1,21 → 0,93 ns). 116 tests ajoutés (350 au total). Bout en bout (A/B simultanés) :
  fin du calcul 82 → 76 s et 80 → 76 s, menu jouable 92 → 85 s et 89 → 84 s ; menu 3D, CPU du worker par image
  (`--gl-discard`) 44,4 → 40,4 et 44,3 → 43,3 ms.
- **Seconde vague (5 agents, relus)** : x87 en précision 24 bits avec arrondi dirigé (troncature −11 % de cycles),
  ombres f64 de la voie basse des registres XMM pour le SSE2 scalaire double (sin du runtime C 22 → 15 ns), petites
  fonctions feuilles incluses dans la région appelante (20 appels : 253 → 179 ns), vérification SMC des écritures
  allégée (8 écritures : 6,1 → 4,0 ns ; corrige trois écritures non détectées sur du code traduit : STMXCSR à cheval
  sur deux pages, FNSTCW/FNSTSW m16), décodeur JPEG 2,5-4× plus rapide (1024² q90 : 105 → 30 ms). Bout en bout
  (2 A/B simultanés) : **pas de gain mesurable sur le démarrage de BFME2** (±1-5 s, bruit) — les noyaux synthétiques
  ne représentent pas le code chaud réel ; 388 tests.

## 29 septembre : lag en partie (BFME2 chez le joueur)
- **Cause mesurée (télémétrie de la session du joueur)** : presque chaque à-coup en partie (200 ms - 1 s) est une
  lecture synchrone d'un bloc de 1 Mio sur le réseau (`io 1/1024KB/500ms`) — un son, un modèle, une texture pas encore
  téléchargés ; tout l'émulateur attend.
- **Lectures par morceaux** : une lecture aléatoire manquante ne télécharge que les morceaux de 64 Kio qu'elle couvre
  (le bloc entier suit en arrière-plan dans le magasin persistant) ; un flux lu petit à petit (audio) passe par des
  fenêtres croissantes (64 → 256 Kio) avec ses blocs suivants en arrière-plan ; les blocs entiers d'avance seulement
  pour un fichier lu d'un bout à l'autre ; un téléchargement d'arrière-plan s'efface (interrompu, repris) quand le jeu
  a besoin du réseau. Escarmouche BFME2 sur un lien simulé à 20 Mbit/s : à-coups de lecture en partie 28 (49 s au
  total, pire 16 s) → 4 (5,8 s, pire 2 s) ; 522 → 354 Mo téléchargés.
- **Lectures parquées** (par défaut depuis 62f4096, `?asyncreads=0` pour les couper ; relues sous trois angles, 7 défauts corrigés) : un ReadFile dont les données sont encore sur le réseau
  parque son thread pendant un téléchargement asynchrone ; menu BFME2 65 s plus tôt sur ce lien (128 s contre 193 s) ;
  neutre en partie (c'est le fil principal du jeu qui lit).
- Le chargement d'une carte reste long sur un réseau lent la première fois (~20 Mo lus derrière l'écran de chargement).

## 30 septembre : textures au chargement d'une carte (BFME2)
- **Mesure** (harnais, nouvel événement de scénario `mark:<étiquette>` : CPU du worker et du processus GPU par phase,
  travail de textures et temps d'API par phase avec `--api-times`) : pendant le chargement d'une escarmouche BFME2
  (~30 s, ~29 s de CPU du worker), l'envoi des textures au GPU ne coûte que ~230 ms (dont la moitié en diagnostic de
  texture « magenta » qui reconvertissait chaque petite texture), mais D3DX ~5,7 s : 1 225 textures 256×256 chargées par
  `D3DXLoadSurfaceFromMemory` (X8R8G8B8 → DXT1 : encodage DXT) puis `D3DXFilterTexture` (mips A1R5G5B5 et DXT1).
- **Fait** : (1) conversions D3DX par table (8/16 bits : une table des valeurs de texel par format, construite avec la
  même conversion) et par mot (A8R8G8B8), source lue sur place — mêmes octets (test contre l'ancien code gardé en
  fixture) ; (2) encodage DXT en parallèle (D062) ; (3) envoi partiel : un niveau modifié seulement par des LockRect à
  rectangle n'envoie que leur union (comme le runtime Direct3D pour une texture managée) — vérifié en partie par la
  capture d'image (96 textures relues du GPU : identiques à la mémoire invitée) ; (4) le diagnostic magenta réutilise
  les pixels déjà convertis.
- **Résultat** (A/B alternés, même scénario, `--api-times` des deux côtés) : phase écran de chargement → partie, CPU du
  fil du worker 29,8 / 29,1 s → 25,4 / 26,4 s ; durée 31 / 30 s → 27 / 28 s ; D3DX 5,7 → 3,7-3,9 s ; envoi des
  textures 228-234 → 121-131 ms. (Les aides DXT prennent ~1 s de CPU sur d'autres cœurs.)
- **Essayé puis retiré** : envoyer au GPU, à chaque Present (4 ms), les textures écrites mais pas encore dessinées — la
  première image de la partie envoie toujours ~680 niveaux / 60 Mo (ces textures sont probablement remplies après la dernière image
  de l'écran de chargement), et le jeu crée beaucoup de textures jamais dessinées (+130 Mio envoyés pendant le
  chargement, +576 textures en 20 s de partie).
- Reste en D3DX au chargement : encodage DXT des mips 64×64 et moins (non parallélisés, ~0,6 s), décodage A1R5G5B5 et
  réductions (~1 s, surtout des allocations). Observé en passant : `SetCursor` ~11 s de temps d'API cumulé au menu
  (à comprendre : probablement du temps d'ordonnancement attribué à cet appel).
## 30 septembre : chargement d'une carte d'escarmouche (BFME2)
- Profil du chargement (clic « Lancer » → premières images en partie, ~40 s headless) : lectures de fichiers ~1/3
  (70 Mo en ~400 requêtes HTTP locales, le thread principal attend ~13,5 s dans ReadFile — chez le joueur ces données
  viennent de l'OPFS), code invité ~31 %, dessin de l'écran de chargement ~20 % (uniform4fv / getProgramParameter :
  contre-pression de SwiftShader, artefact headless), D3DX (conversions de texels, encodage DXT des mips) ~10 %, et
  ~15 % d'une **boucle d'attente active** de l'ordonnanceur.
- Corrigé : un timer de fenêtre échu dont le thread ne relève pas ses messages restait « prochain réveil » : la boucle
  idle tournait sans dormir ni rendre la main à la boucle d'événements. `nextWake` ignore désormais les timers déjà
  échus au dernier passage de `wakeBlocked` (test `sched-nextwake`). D3DX : conversions par tables / mots 32 bits,
  encodeur DXT sur mots (mêmes octets que la référence, tests).
- Mesure (3 A/B alternés, a78a967 vs ce lot, scénario bfme2-skirmish-sync ancré sur une image du menu) : temps CPU du
  worker pendant le chargement 37,2 / 35,5 / 34,1 s → 24,6 / 24,6 / 24,6 s (−31 %) ; durée murale inchangée
  (41,3 / 39,3 / 37,3 → 41,4 / 40,4 / 40,3 s, bruit de la machine partagée) : le chemin critique headless est la
  lecture des fichiers + le calcul, l'attente active ne faisait que brûler un cœur.
- Constaté, non corrigé : les timers attendables (`SetWaitableTimer`) ne passent jamais à l'état signalé et restent
  dans `proc.timers` après échéance.
## 29-30 septembre : boucles chaudes du démarrage BFME2 (JIT)
- **Outils** : listings de ce que le JIT émet pour une région d'un jeu en cours (`src/cpu/jit/listing.js`, entrée
  harness `jitlist:<eip>`, `--profile-wasm N`, compteurs par bloc `--block-counts`). (Banc `hotloop-bench` retiré à l'intégration : il contenait des octets du jeu.)
- **Constat** (fenêtres de profil de 5 s) : la moitié de la phase de calcul (~75 s) est une seule région (tri par tas,
  boucle de descente), le reste des boucles entières de même forme. Le code V8 de la boucle est déjà serré ; les
  opérandes de drapeaux paresseux y restaient vivants pour les seules sorties froides (tranche de temps, SMC).
- **Fait** : une sortie dont l'adresse de reprise ne lit aucun drapeau n'emporte plus d'opération paresseuse ; correctif
  d'exactitude : INC/DEC/NEG/ADC/SBB/décalages/rotations/XADD sur mémoire posent leurs drapeaux avant l'écriture (une
  sortie SMC reprenait avec les drapeaux de l'instruction précédente). Micro-banc : instructions hôte −16 % (7,9 → 6,7 G),
  cycles −2 %, temps −7 % (boucle limitée par les erreurs de prédiction). Bout en bout (3 A/B alternés, 105 s,
  `--jit-opts {"deadExitFlags":false}` pour A, machine à charge ~36) : fin du calcul (TextureAssetBuilder) A 90/93/>105 s,
  B >105/95/89 s ; **pas de différence mesurable** sous ce bruit ; menu non atteint en 105 s.
- **Revue** : l'abandon des drapeaux aux sorties SMC était faux (la liveness est calculée sur les octets traduits ; l'écriture
  qui prend la sortie peut réécrire le code qu'elle a parcouru : un JMP changé en JZ lisait un ZF perdu, test ajouté).
  Les sorties SMC gardent tout l'état paresseux ; seules les sorties de tranche de temps l'abandonnent. Le gain retombe :
  micro-banc instructions hôte −2 % (7,90–7,95 → 7,66–7,82 G), cycles et temps ~−3 % (4 paires alternées, charge ~47).
- Piste : le reste de la boucle (répartiteur `blk` en tête de boucle, décompte `icount` par bloc) coûte peu ; le gain
  réel demanderait de sortir du modèle (moins d'erreurs de prédiction : impossible côté JIT).

## 30 septembre : plantage BFME2 résolu, préchargement, textures, chargement des cartes
- **Plantage « 0x53524852 » trouvé et corrigé** (celui du joueur, image-4) : reproduit à chaque premier lancement
  (sans profil) sur la version en ligne. Cause : un tas créé par le jeu (HeapCreate) donnait un bloc libre dont le
  lien de liste avait été réécrit par le programme après libération — il pointait dans un autre tas, juste sous la
  pile du fil principal, avec une taille lue 0xffffffff ; le jeu y lisait 2 Mio d'`asset.dat`, à travers la pile.
  Le tas ne rend plus qu'un bloc réellement libre de ce tas (en-tête, pied et marque cohérents), sinon la liste est
  coupée (fuite plutôt que corruption). Trouvé avec de nouveaux crochets de débogage : `ORTHROS_HEAP_WATCH=<adresse>`,
  `ORTHROS_STACK_PATTERN=<texte>`, `ORTHROS_VERIFY_READS=1` (chaque ReadFile comparé au serveur), traces `fileio`
  avec l'allocation de la destination.
- **E/S de fichier sérialisées** avec une lecture parquée (un autre thread qui lit, écrit ou déplace le pointeur du
  même fichier attend, comme sous Windows).
- **Intégré (relu)** : préchargement réseau guidé par la position du jeu dans la liste apprise, par morceaux de
  64 Kio (premier lancement sur lien simulé 20 Mbit/s : première image 74 → 42 s, menu 88 → 67 s, carte 77 → 55 s,
  images ralenties par le réseau en partie 70 → 28) ; téléversements partiels de textures et conversions D3DX par
  tables, compression DXT en parallèle (CPU du chargement d'une carte −12 %) ; attente active de l'ordonnanceur
  supprimée (CPU du worker pendant le chargement d'une carte −31 %) ; listes JIT et compteurs par bloc en jeu.
  Mesuré ici sans réseau : carte chargée en 27 s au lieu de 28,5.
- **Non intégré** : programmes GL appris par leurs sources (branche `worktree-wf_47b80144-ae5-2`) — la préparation
  anticipée pendant le calcul initial ralentit le premier lancement de ~18 s (A/B : fin du calcul 82-84 → 101-102 s) ;
  à reprendre sans résolution synchrone des programmes avant le device.
- Premier lancement vs suivants : le long calcul initial (~75 s) n'a lieu qu'au premier lancement (sans Options.ini) ;
  ensuite la fenêtre arrive en ~20 s.

## Prochaine action
- BFME2 : la campagne ne démarre pas (décision interne au jeu, même sous l'interpréteur de référence : données ou
  patch de cette copie ?). Observation : au démarrage le jeu ouvre `HKLM\SOFTWARE\Electronic Arts\The Battle for
  Middle-earth II` (absente : c'est là qu'un installateur range la clé CD, « ergc ») ; le manifest ne la fournit pas —
  à tester avec la clé du joueur s'il le souhaite (aucune clé inventée ici) ; l'aperçu 3D du créateur de héros montre le décor sans le héros (caméra au-dessus de la
  scène) — vérifier si un héros créé apparaît en partie.
- Mesure réelle sur GPU (critère M7) : `node bin/orthros.mjs run <dossier>` puis Chrome sur une machine cliente (celle
  du joueur : Intel Iris Xe, 20 cœurs). À observer là (non mesurable sous SwiftShader) : ~1 460 appels GL par image en
  partie BFME2, ~3 100 en BFME1 (détails élevés) ; tampons dynamiques
  verrouillés en DISCARD mis à jour par `bufferSubData` (orphelinage `bufferData(taille)` possible, exact selon la
  sémantique Direct3D, si des attentes GPU apparaissent) ; temps de compilation des programmes à leur première
  utilisation (ANGLE traduit en HLSL/MSL) ; perte de contexte (gérée) ; mémoire du processus (~1,6-2 Go ici).
- Performance CPU : menu 3D High ~18 fps en CPU seul (71 % du temps dans le code invité, réparti sur ~2 600 régions :
  qualité générale du code des régions — pression de registres, ~7,5 M chaînages/s dont la moitié entre régions x87) ;
  chargement d'une partie ~55 s en CPU seul, dont la moitié dans une boucle x87 en arrondi vers zéro (limitée par la
  latence des passages f64 ↔ entier du masquage 24 bits). Chaînage : jusqu'à 22 M transitions chaînées/s au démarrage
  (~7 ns chacune, attribuées au répartiteur `run` dans les profils à cause des appels terminaux : ~15-17 % du temps) —
  fait : le budget d'instructions passe en paramètre (au lieu d'un aller-retour mémoire par transition) et TOP n'est plus
  écrit ni relu par les régions sans x87 (micro-mesure : 25,4 → 23,5 ns par appel/retour chaînés ; menu +1 %) ; piste
  suivante : passer la pile x87 en paramètres entre régions x87 (~3,8 M transitions/s au menu, chacune vide et recharge
  8 doubles, les étiquettes et TOP). Les mesures en jeu exigent des A/B simultanés (bruit A/A
  jusqu'à 3,7 % sur la machine partagée).
- Unités magenta : textures absentes du dossier de jeu (enquête close, voir plus haut) — à revérifier sur une copie
  complète du jeu si l'occasion se présente.
- Premier lancement sur réseau réel : plages compressées faites (D054) ; restent les requêtes en série (une à la fois,
  1-4 Mio) — piste : lectures anticipées asynchrones dans un worker d'E/S (mémoire partagée, attente seulement si le
  bloc n'est pas encore arrivé).
- Saccades : lire les événements `slow` de la prochaine partie du joueur (ce qui reste : traduction de code neuf non
  appris, lectures, autre) ; la traduction des régions apprises est déjà dans un second worker (D058).

## Imports Win32 inconnus (rempli automatiquement à partir de M4)
- `ole32.dll!OleRun` (référencé par lotrbfme.exe, 0 appel)
- `oleaut32.dll!CreateErrorInfo` (référencé par lotrbfme.exe, 0 appel)
- `kernel32.dll!MoveFileW` (référencé par msvcr71.dll, 0 appel)
- `kernel32.dll!RemoveDirectoryW` (référencé par msvcr71.dll, 0 appel)
- `kernel32.dll!ReadConsoleW` (référencé par msvcr71.dll, 0 appel)
- `kernel32.dll!PeekNamedPipe` (référencé par msvcr71.dll, 0 appel)
- `kernel32.dll!ReadConsoleInputW` (référencé par msvcr71.dll, 0 appel)
- `kernel32.dll!CreatePipe` (référencé par msvcr71.dll, 0 appel)
- `imm32.dll!ImmGetCandidateListCountW` (référencé par lotrbfme.exe, 0 appel)
- `imm32.dll!ImmGetCandidateListW` (référencé par lotrbfme.exe, 0 appel)
- `winmm.dll!waveOutGetID` (référencé par mss32.dll, 0 appel)
- `winmm.dll!waveInClose` (référencé par mss32.dll, 0 appel)
- `winmm.dll!waveInPrepareHeader` (référencé par mss32.dll, 0 appel)
- `winmm.dll!waveInAddBuffer` (référencé par mss32.dll, 0 appel)
- `winmm.dll!waveInReset` (référencé par mss32.dll, 0 appel)
- `winmm.dll!waveInUnprepareHeader` (référencé par mss32.dll, 0 appel)
- `winmm.dll!waveInStart` (référencé par mss32.dll, 0 appel)
- `winmm.dll!midiOutLongMsg` (référencé par mss32.dll, 0 appel)
- `winmm.dll!midiOutShortMsg` (référencé par mss32.dll, 0 appel)
- `winmm.dll!midiOutReset` (référencé par mss32.dll, 0 appel)
- `winmm.dll!midiOutPrepareHeader` (référencé par mss32.dll, 0 appel)
- `winmm.dll!auxGetDevCapsA` (référencé par mss32.dll, 0 appel)
- `winmm.dll!midiOutUnprepareHeader` (référencé par mss32.dll, 0 appel)
- `avifil32.dll!AVIFileCreateStreamA` (référencé par lotrbfme.exe, 0 appel)
- `avifil32.dll!AVIFileOpen` (référencé par lotrbfme.exe, 0 appel)
- `avifil32.dll!AVIFileReadData` (référencé par lotrbfme.exe, 0 appel)
- `avifil32.dll!AVIMakeCompressedStream` (référencé par lotrbfme.exe, 0 appel)
- `avifil32.dll!AVIStreamWrite` (référencé par lotrbfme.exe, 0 appel)
