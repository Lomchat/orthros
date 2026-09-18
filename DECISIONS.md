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

## D013 — 2026-09-18 — Structure du JIT x86→WASM
Une région = un ensemble de blocs de base atteignables par branchements directs depuis un point d'entrée (≤ 48 blocs / 400 instructions), traduite en **une fonction WASM** `(bloc, état) → EIP suivant | 0`. Les 8 registres, EFLAGS, l'état de drapeaux paresseux (kind, res, a, b), FS base et TOP x87 vivent dans des locals pour toute la région ; un `loop` + `br_table` dispatch les blocs, les sauts intra-région ne touchent pas la mémoire. Les sorties (saut inter-région, thunk d'import, faute, tranche de temps, SMC) réécrivent l'état dans le bloc d'état du thread. Un **dispatcher WASM** (module runtime) enchaîne les régions via une table de hachage EIP→(fonction, bloc) en mémoire invité et une `WebAssembly.Table` partagée ; un raté renvoie à JS qui traduit la région manquante. Les instructions sans traduction native passent par un import `fallback(eip)` qui exécute **une** instruction dans l'interpréteur de référence (registres flushés/rechargés autour) : le JIT est donc complet par construction et s'optimise instruction par instruction. Drapeaux paresseux : producteur connu statiquement dans le bloc → conditions inlinées ; sinon appel au helper WASM `flags()`. Précision x87 24 bits via `round24` (arrondi de mantisse exact à plage étendue). Détection de code auto-modifiant : test d'un bitmap de pages à chaque store non-pile (sortie SMC → invalidation des régions de la page). Mesure (bench.exe, entier + x87) : 65,8× l'interpréteur, ~0,8 G instructions/s sur le serveur.

## D014 — 2026-09-18 — Le JIT n'émule pas les fautes de pile x87
Les accès à un registre x87 vide (dépassement/sous-dépassement de pile) produisent des NaN indéfinis sur le matériel ; aucun programme valide ne s'y fie. Le JIT ne teste pas les tags (qu'il maintient quand même, pour l'interpréteur de repli). Les cas de conformité qui déclenchent une faute de pile (bit SF du FSW dans le résultat de l'oracle) sont exclus pour le JIT, pas pour l'interpréteur.

## D010 — 2026-09-18 — Outillage
Node 24 (tests `node --test`, serveur), Playwright + Chromium headless (harnais), clang-18/lld-18 (oracle natif, PE de test compilés sans CRT), python3 (générateurs de tests). Le serveur n'a pas de GPU exploitable (Matrox G200) : le headless valide la correction (SwiftShader), la perf se mesure sur un vrai client.

## D015 — 2026-09-18 — Chemins rapides d'API en WASM (FAST_TABLE)
Le jeu appelle certaines API triviales des millions de fois (`timeGetTime`, `GetTickCount`, `InterlockedIncrement`…) : à ~1 µs le passage par JS, la calibration CPU du jeu (~20 M d'appels) coûtait des minutes. Le dispatcher WASM consulte une table d'un octet par thunk : les API marquées « rapides » sont exécutées en WASM (lecture de KUSER_SHARED, arithmétique) sans sortir vers JS ; le reste garde la sortie THUNK (D004). Le marquage est fait par l'`ApiRegistry` (hook `onThunk`), donc générique. Les appels rapides ne comptent pas dans `apiCalls` ni dans la trace des derniers appels.

## D016 — 2026-09-18 — SEH par continuation
Un handler MSVC (`_except_handler3`, `__CxxFrameHandler`) peut ne jamais revenir (goto non local vers `__except` après `RtlUnwind`). Le dispatch n'est donc pas une boucle JS qui appelle chaque handler : le handler est *entré* avec une adresse de retour vers un thunk interne (`__seh_return`) dont le côté JS lit la disposition et continue (frame suivant, ou reprise depuis le CONTEXT). `RtlUnwind` appelle les handlers en mode déroulement via `callGuest` (ils reviennent toujours), place son CONTEXT et ses frames **sous l'ESP courant** (les locals du handler C++ appelant sont vivants), fixe FS:[0] à la frame cible et revient normalement avec EAX = valeur de retour — équivalent au `ZwContinue` de NT sur x86 (TargetIp = adresse de retour). Un saut vers l'adresse 0 est une violation d'accès (pas une sortie « code 0 »).

## D017 — 2026-09-18 — CRT intégrée et DLL natives chargées telles quelles
`msvcr71.dll`/`msvcp71.dll`/`mfc71.dll` du dossier du jeu sont chargées **natives** (elles sont dans le dossier, l'ordre de recherche Windows les préfère) : leur code x86 tourne dans le JIT comme le jeu. L'implémentation intégrée `msvcrt.dll` (cdecl, `_except_handler3`, `_CxxThrowException`, qsort par rappel invité, math via `retDouble`) sert aux binaires qui importent la CRT système (dbghelp, PE de test). Pas de réécriture de la CRT du jeu.

## D018 — 2026-09-18 — Sémantique des jokers Win32 dans FindFirstFile
`*.` doit lister les noms sans extension (le jeu énumère ainsi ses sous-dossiers d'archives), `*.*` tout, `abc.*` aussi `abc`, `?` ne franchit pas un point. Implémentation de la sémantique `FsRtlIsNameInExpression` avec les jetons DOS (`DOS_STAR`, `DOS_QM`, `DOS_DOT`) que `FindFirstFile` produit, au lieu d'une simple regex glob.

## D019 — 2026-09-18 — GDI+ : images = surfaces 32 bits ARGB en mémoire invité
Le format mémoire de `PixelFormat32bppARGB` est celui de nos surfaces GDI (B,G,R,A) : `LockBits` en 32 bits rend directement le tampon de l'image (pas de copie), les autres formats passent par une conversion dans un tampon du heap. Les images créées sur un `scan0` de l'appelant restent liées à ce tampon (relecture avant lecture, réécriture après écriture). Décodeurs JPEG (base + progressif, suréchantillonnage « fancy » identique à libjpeg, YCbCr en virgule fixe) et PNG (tous types, Adam7) écrits de zéro et validés contre PIL (tolérance 3/255 pour le JPEG : IDCT entière ≠ flottante).

## D020 — 2026-09-18 — COM : vtables de thunks, objets en mémoire invité, méthodes JS
Une interface COM = une vtable allouée une fois dans le heap invité dont chaque entrée est un thunk d'API (`com.dll!Interface::Method`, argc = 1 + arguments) ; un objet = un bloc invité `[vtable, marqueur, id]` associé à une implémentation JS. `QueryInterface`/`AddRef`/`Release` sont génériques (chaîne d'héritage + `iids` supplémentaires déclarés par l'implémentation), les méthodes absentes sont tracées une fois et renvoient `E_NOTIMPL`. DirectInput, DirectSound et Direct3D 8 sont bâtis dessus ; `CoCreateInstance` résout les CLSID enregistrés (DirectSound). L'ordre des méthodes vient des en-têtes publics du SDK.

## D021 — 2026-09-18 — Attentes bloquantes déroulées (parking) au niveau supérieur
Le modèle « threads verts imbriqués » (D003) affamait le thread principal : un thread ouvrier bouclant sur `Sleep(1)` gardait la pile JS et le principal, pourtant prêt, ne tournait qu'une tranche par seconde. Désormais tous les threads s'exécutent en tranches depuis une boucle d'ordonnancement de niveau 1. Un appel d'API bloquant au niveau 1 (`Sleep`, `WaitFor*`, `EnterCriticalSection`, `GetMessage`…) **se déroule** : le handler lève `WaitUnwind`, l'appel est annulé (EIP/ESP remis à l'entrée du thunk), le thread est garé avec sa condition de réveil ; réveillé, il ré-exécute l'appel et `block()` lui rend le résultat enregistré. Les handlers ayant des effets de bord avant l'attente (`SignalObjectAndWait`, `SuspendThread`) consultent `thread.resuming`. Le blocage à l'intérieur d'un rappel (WndProc, DllMain) ne peut pas dérouler les frames JS de l'hôte : il exécute les autres threads imbriqués comme avant.
