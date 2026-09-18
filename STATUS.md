# STATUS — Orthros

**Palier courant : M3 JIT — atteint le 2026-09-18 ; M4 (le jeu démarre) en cours : le jeu atteint sa suite de benchmarks de première exécution.**

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

- M4 (en cours) : lanceur `node src/host/cli.js manifests/<jeu>.json` (dossier du jeu monté en lecture seule,
  profil utilisateur sur disque, registre amorcé par le manifest et persisté dans `registry.json`, profil CPU,
  liste automatique des imports inconnus). Le jeu charge sa CRT native (D017), crée sa fenêtre, lit le
  registre (`Language`, `UserDataLeafName` observés → amorçables), affiche son splash via **GDI+** réel
  (décodeurs JPEG/PNG/DEFLATE écrits de zéro, D019), énumère et ouvre toutes ses archives (jokers DOS, D018),
  lance sa **calibration CPU** puis sa **suite de benchmarks** (première exécution sans `Options.ini`) ; les
  exceptions C++ sont dispatchées et rattrapées via le SEH par continuation (D016). Chemins rapides d'API
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
- Après la suite de benchmarks (~80 s sous le JIT) et l'initialisation de Miles (DirectSound), le processus
  Node gonfle jusqu'à l'épuisement du tas JS pendant le chargement du jeu (aucun appel d'API visible en boucle) :
  diagnostic en cours par instantané de tas (`--heapsnapshot-near-heap-limit`).

## Prochaine action
- M4 : laisser la suite de benchmarks se terminer, vérifier l'écriture d'`Options.ini`, continuer les traces
  jusqu'au premier appel D3D (`Direct3DCreate8`) ; implémenter au fur et à mesure ce qui manque (DirectSound,
  DirectInput, IStream…). Puis M5 : Direct3D 8 → WebGL2, capture headless du menu.

## Imports Win32 inconnus (rempli automatiquement à partir de M4)
- (vide)
