# STATUS — Orthros

**Palier courant : M5 atteint le 2026-09-18 — le menu principal du jeu est rendu par Direct3D 9 → WebGL2 dans Chromium headless (800×600 plein écran, ~37 fps sous SwiftShader), libellés compris, et un clic scripté sur OPTIONS ouvre l'écran des options complet (preuves : `build/proof/m5-menu.png`, `build/proof/m5-options.png`, reproductibles par `node tools/headless.mjs bfme-vanilla --seconds 215 --shots 1 --input "190:click:338,573"`). M6 en cours.**

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
- **Pile x87 en locaux WASM (D030)** : bench phase fpu 270 → 70 ms (3,8×), `round24` sorti du profil, suites x87 /
  verify_mech / sse vertes (88 tests + 2 todo documentant des écarts préexistants : bits IE/ES du mot d'état sur
  comparaison non ordonnée, arrondi PC=24 sur demi-ulp exact) ; en jeu 37 → 37,8 fps, p99 31-32 ms ; le code invité
  reste ~50 % du worker (logique du jeu elle-même), le reste : dispatch d'API 5 %, ordonnanceur/horloge ~9 %, GL 10 %.
- Constat (statistiques de Sleep par thread) : le thread principal du jeu appelle `Sleep(0)` + `timeGetTime` ~100 000
  fois/s en jeu (limiteur de cadence / attente active), 18 M d'appels en 5 min ; les autres threads dorment 1-2 ms.
  Le jeu se rythme donc lui-même (~38 fps en jeu, pas une limite CPU) ; mitigation générique : après 32 `Sleep(0)`
  consécutifs sans autre thread prêt, la tranche dort 1 ms (résolution des timers Windows).
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
  jeu atteint Direct3D à 26 s (au lieu de ~100 s) et le menu à ~70 s (au lieu de ~125 s). Les transcendantes x87 en WASM
  natif (en cours) accéléreront le benchmark lui-même (et son verdict de détail par défaut).
- **Détail High, 9 min headless (D032)** : la seconde scène du shell (forteresse, ~1 500 appels de dessin/image) se charge
  (~60 s sous SwiftShader) et tourne de 245 s à 540 s sans blocage ni plantage (`build/shots15`, run hl83) — le
  « plantage après ~5 min » précédent était le livelock ci-dessus vu de l'extérieur. 6-14 fps, p99 ≈ 500 ms sous
  SwiftShader (rasterisation logicielle de 1 500 dessins : à mesurer sur GPU réel ; replis interpréteur 50-90 k/s à
  identifier — transcendantes x87 en cours de traduction native).
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

## Prochaine action
- M6 : enchaîner les clics scriptés jusqu'au lancement d'une escarmouche (captures chaque seconde pour repérer les
  boutons), corriger ce que le jeu exerce en 3D, puis vérifier audio (sortie AudioWorklet) et sauvegardes (OPFS).

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
