# Orthros

Runtime navigateur qui exécute des jeux Windows **tels quels** (binaire inchangé) avec le CPU/RAM/GPU du client : émulation x86-32 (interpréteur de référence + recompilateur dynamique x86→WebAssembly), chargeur PE32, réimplémentation des API Win32/DirectX sur les API du navigateur, système de fichiers virtuel servi en HTTP.

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
lus une fois dans son stockage privé (OPFS) : les lancements suivants ne les retéléchargent pas.
