# Décisions d'architecture — Orthros

Chaque décision est numérotée, datée, et donne le pourquoi. Une décision révisée n'est pas effacée : on ajoute une entrée qui la remplace.

## D001 — 2026-09-18 — Langage : JavaScript ES modules + JSDoc, sans étape de build
Le navigateur charge `src/` tel quel et Node exécute les mêmes fichiers pour les tests. Pas de TypeScript/bundler : itération instantanée, zéro dépendance runtime. Le typage est apporté par JSDoc (vérifiable plus tard avec `tsc --checkJs` si utile). Les parties critiques en perf ne sont pas l'interpréteur (référence) mais le code WASM généré par le JIT.

## D002 — 2026-09-18 — Mémoire invité : identité totale sur une `WebAssembly.Memory` de 2 Go
Adresse invité = offset mémoire. Vérifié dans Node : allouer 2 Go (partagé ou non) prend 5 ms et ne coûte rien en RSS tant que les pages ne sont pas touchées. Conséquences : le JIT émet des `i32.load/store` directs (aucune traduction d'adresse), `VirtualAlloc` n'est que de la comptabilité, pas de détection de faute de page en v1 (une lecture d'une page non mappée renvoie 0). Région privée de l'émulateur : `0x7FF00000–0x7FFFFFFF` (états CPU des threads, TEB/PEB, données internes) ; thunks d'import : `0x7FE00000–0x7FEFFFFF`.

## D003 — 2026-09-18 — Threads invités : green threads sur un seul worker
Tous les threads Win32 du jeu s'exécutent sur un seul thread JS (un Web Worker), commutés (a) à chaque appel API bloquant, (b) par préemption à intervalle de temps aux frontières de blocs, uniquement au niveau de dispatch le plus externe. Raison : l'état Win32 reste mono-thread (pas de verrous ni RPC), WebGL est appelable depuis n'importe quel thread invité, et un jeu de 2004 a une boucle principale mono-thread. Limite connue : un thread bloqué dans un callback imbriqué qui attend un autre thread lui-même bloqué au-dessus de lui sur la pile JS ne peut pas être réveillé par timeout (faux deadlock rare). Plan B si ça bloque : un worker par thread invité + RPC vers un worker « noyau ».

## D004 — 2026-09-18 — Frontière API : le code JIT ne rappelle jamais JS de façon imbriquée
À chaque appel d'import Win32 (ou événement de sortie), le code WASM flush les registres dans la structure d'état du thread et **retourne** au dispatcher JS avec un code de sortie. La pile WASM est donc toujours vide à une frontière API : commutation de thread = changement de pointeur d'état ; callbacks (WndProc, thread start, qsort…) = boucle de dispatch imbriquée jusqu'au retour à une adresse trampoline. Coût : un aller-retour WASM→JS par appel API (~100 ns), négligeable.

## D005 — 2026-09-18 — JIT : modules WASM par région, table funcref partagée, drapeaux paresseux
Une région (fonction ou ensemble de blocs) = un module WASM généré à la volée ; registres dans des locals à l'intérieur d'une région, sauts intra-région par `br_table`, sauts inter-région par cache EIP→index dans une `WebAssembly.Table` partagée + `call_indirect`/`return_call_indirect`. Drapeaux calculés paresseusement (dernier résultat + opérandes). x87 émulé en f64 (précision 80 bits non reproduite : compromis classique acceptable pour un jeu). MMX stocké à part des registres x87 (pas d'aliasing exact).

## D006 — 2026-09-18 — Oracle de conformité CPU : le processeur natif du serveur
Le serveur est un x86-64 Linux capable d'exécuter des ELF 32 bits. Le « modèle de référence écrit à part » est donc un harnais natif 32 bits (C freestanding, syscalls directs) qui exécute les mêmes séquences d'instructions générées aléatoirement et renvoie registres/drapeaux/mémoire. Aucun second interpréteur à maintenir, et la vérité vient du silicium. Les drapeaux non définis par l'ISA sont masqués.

## D007 — 2026-09-18 — VFS : lecture synchrone par XHR range + cache dans le worker
`ReadFile` est synchrone côté invité. Dans le worker, XHR synchrone avec `Range` par blocs (1 Mo) + cache LRU + lecture anticipée, puis miroir OPFS (`createSyncAccessHandle`) pour les rechargements. Alternative écartée pour l'instant : dispatcher async/JSPI (contagieux, plus lent à mettre au point).

## D008 — 2026-09-18 — Exécution dans un Web Worker + OffscreenCanvas
Le cœur tourne dans un worker (WebGL2 via OffscreenCanvas, `Atomics.wait` pour dormir précisément). Le thread principal ne fait que HUD, transfert des entrées, et l'AudioWorklet alimenté par un ring buffer en SharedArrayBuffer.

## D009 — 2026-09-18 — Overrides de DLL génériques via manifest
Le dossier de la cible contient un `dsound.dll` tiers (wrapper) ; l'ordre de recherche Windows le chargerait avant l'implémentation intégrée. Mécanisme générique : `manifest.json` → `dllOverrides: { "dsound": "builtin" | "native" }`. C'est un flag de compat universel, pas du code spécifique au jeu.

## D011 — 2026-09-18 — Politique d'exactitude x87 en f64
Ce qui est exact : PC=53 en arrondi au plus près (le résultat f64 est le même que le 80 bits arrondi à 53), PC=24 dans tous les modes d'arrondi (via termes d'erreur exacts TwoSum/TwoProduct), conversions entières, FPREM/FPREM1 (écart d'exposant < 64), comparaisons, réponses masquées. Ce qui ne l'est pas : PC=64 (mantisse 64 bits impossible en f64), arrondi dirigé en PC=53, transcendantales (Math.* ≈ 1e-13 relatif), payload des NaN. Justification : un jeu MSVC de 2004 tourne en PC=53 (CRT) ou PC=24 (Direct3D sans FPU_PRESERVE) et en arrondi au plus près sauf autour de `_ftol` (FISTP avec RC=trunc, exact chez nous). Les cas non exacts sont couverts par une tolérance dans les tests de conformité, pas ignorés.

## D012 — 2026-09-18 — Générateur de conformité : llvm-mc + snippets aléatoires + drapeaux indéfinis masqués
Les cas sont assemblés par llvm-mc (encodages sûrs), les branches sont encodées à la main pour rester dans le snippet, et chaque cas porte un masque des drapeaux définis par l'ISA (les drapeaux « undefined » du SDM ne sont pas comparés). Les fautes natives (#DE…) sont comparées sur l'EIP fautif et l'état au moment de la faute, en ignorant la mémoire sous ESP (le noyau y écrit le signal frame).

## D010 — 2026-09-18 — Outillage
Node 24 (tests `node --test`, serveur), Playwright + Chromium headless (harnais), clang-18/lld-18 (oracle natif, PE de test compilés sans CRT), python3 (générateurs de tests). Le serveur n'a pas de GPU exploitable (Matrox G200) : le headless valide la correction (SwiftShader), la perf se mesure sur un vrai client.
