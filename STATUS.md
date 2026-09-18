# STATUS — Orthros

**Palier courant : M3 JIT — atteint le 2026-09-18 ; M4 (le jeu démarre) commence.**

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

## Limites connues (documentées, acceptées en v1)
- x87 en f64 (voir D011). Pas de faute de page. MMX non aliasé sur x87.
- SEH (RaiseException/RtlUnwind/faults → handlers FS:[0]) pas encore dispatché : prévu en M4
  dès que le jeu (ou msvcr71) en a besoin.
- GDI : police bitmap intégrée seulement (le navigateur pourra rasteriser via Canvas2D plus tard),
  régions rectangulaires, pas de dialogues/menus réels.

## Blocages
- Aucun.

## Prochaine action
- M4 : lanceur CLI (`orthros run <dossier>` avec manifest), SEH (RaiseException/RtlUnwind, chaîne FS:[0]),
  stub `Direct3DCreate8` traçant, lancer `lotrbfme.exe` en boucle et corriger la fidélité jusqu'au
  premier appel D3D ; imports inconnus listés ci-dessous automatiquement.

## Imports Win32 inconnus (rempli automatiquement à partir de M4)
- (vide)
