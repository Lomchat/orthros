# STATUS — Orthros

**Palier courant : M1 CPU — atteint le 2026-09-18 ; M2 (loader PE + Win32 minimal) démarre.**

## Ce qui marche
- M0 : outillage (Node 24, Playwright Chromium, clang/lld-18), repo, `make test`, docs.
- M1 : décodeur x86-32 complet (1 octet, 0F, groupes, x87, MMX/SSE/SSE2/SSE3 partiel) et
  interpréteur de référence (`src/cpu/interp*.js`), validés contre l'**oracle natif** :
  `make test` régénère 6 suites × 1500 cas aléatoires (alu, stack, branch, string, x87, sse)
  assemblés par llvm-mc, exécutés sur le CPU du serveur (`build/oracle`, ELF 32 bits sans libc),
  et compare registres/drapeaux/mémoire/état x87/XMM/MMX. **0 écart** sur les 6 suites, et 0 écart
  sur 24 000 cas supplémentaires avec d'autres seeds (`tools/probe.mjs` pour le détail).
- Fidélité x87 : précision simple (PC=24) exacte y compris modes d'arrondi dirigés (termes d'erreur
  exacts TwoSum/TwoProduct), FPREM/FPREM1 exacts (quotient BigInt), réponses masquées
  (indéfini, débordement/sous-dépassement de pile, FCMOV sur registre vide).

## Limites connues (documentées, acceptées en v1)
- x87 émulé en f64 : PC=64 non reproduit (tolérance 1 ulp), arrondi dirigé en PC=53 non reproduit,
  transcendantales à ~1e-13 près, payload des NaN non conservé. Reste partiel FPREM (écart
  d'exposant ≥ 64) : N implémentation-dépendant → non testé.
- Pas de faute de page (mémoire identité 2 Go) ; pas de vérification des sélecteurs de segment.
- MMX stocké séparément des registres x87 (pas d'aliasing).

## Blocages
- Aucun.

## Prochaine action
- M2 : chargeur PE32 (`src/loader/pe.js`), thunks d'import, kernel32 minimal (WriteFile, ExitProcess,
  GetStdHandle…), un PE compilé par clang/lld-link sans CRT qui écrit sur stdout, puis un PE avec
  fenêtre GDI.

## Imports Win32 inconnus (rempli automatiquement à partir de M4)
- (vide)
