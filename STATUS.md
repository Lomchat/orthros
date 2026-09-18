# STATUS — Orthros

**Palier courant : M2 Loader + Win32 minimal — atteint le 2026-09-18 ; M3 (JIT x86→WASM) démarre.**

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

## Limites connues (documentées, acceptées en v1)
- x87 en f64 (voir D011). Pas de faute de page. MMX non aliasé sur x87.
- SEH (RaiseException/RtlUnwind/faults → handlers FS:[0]) pas encore dispatché : prévu en M4
  dès que le jeu (ou msvcr71) en a besoin.
- GDI : police bitmap intégrée seulement (le navigateur pourra rasteriser via Canvas2D plus tard),
  régions rectangulaires, pas de dialogues/menus réels.

## Blocages
- Aucun.

## Prochaine action
- M3 : recompilateur dynamique x86→WebAssembly (`src/cpu/jit/`) : émetteur de bytecode WASM,
  traduction par blocs/régions avec registres en locals, drapeaux paresseux, table funcref partagée
  pour le chaînage, gestion du code auto-modifiant ; même suite de conformité que M1 ; bench ≥ 10×
  l'interpréteur.

## Imports Win32 inconnus (rempli automatiquement à partir de M4)
- (vide)
