# STATUS — Orthros

**Palier courant : M6 quasi atteint (partie jouable 10 min, audio, entrées, sauvegardes), M7 en cours (38 fps, p99 34 ms sous SwiftShader). Historique : M5 atteint le 2026-09-18 — le menu principal du jeu est rendu par Direct3D 9 → WebGL2 dans Chromium headless (800×600 plein écran, ~37 fps sous SwiftShader), libellés compris, et un clic scripté sur OPTIONS ouvre l'écran des options complet (preuves : `build/proof/m5-menu.png`, `build/proof/m5-options.png`, reproductibles par `node tools/headless.mjs bfme-vanilla --seconds 215 --shots 1 --input "190:click:338,573"`). M6 en cours.**

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
- GDI : police bitmap intégrée seulement (le navigateur pourra rasteriser via Canvas2D plus tard),
  régions rectangulaires, pas de dialogues/menus réels. GDI+ : pas de texte ni d'IStream.
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
- **Harnais** : ancres robustes `waitframe:min,max` (draws par image : écran de chargement puis partie, marche avec
  `--gl-discard`) et `waitpixel` ; `--capture-at @N` compte depuis la dernière ancre ; `--interp-range[-at]` (code
  interprété par la référence), `--gl-validate`, `--lose-context-at`.

## Prochaine action
- Mesure réelle sur GPU (critère M7) : `node bin/orthros.mjs run <dossier>` puis Chrome sur une machine cliente. À
  observer là (non mesurable sous SwiftShader) : ~2 400 appels GL par image en partie ; tampons dynamiques
  verrouillés en DISCARD mis à jour par `bufferSubData` (orphelinage `bufferData(taille)` possible, exact selon la
  sémantique Direct3D, si des attentes GPU apparaissent) ; temps de compilation des programmes à leur première
  utilisation (ANGLE traduit en HLSL/MSL) ; perte de contexte (gérée) ; mémoire du processus (~1,6-2 Go ici).
- Performance CPU : pression de registres dans les régions ; coût du chaînage entre régions x87 (vidage/rechargement
  de la pile) ; les mesures en jeu exigent des runs seuls (bruit A/A jusqu'à 3,7 % sur la machine partagée).
- Premier lancement sur réseau réel : téléchargement de fond de tout le dossier vers le magasin OPFS (à évaluer).

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
