# Orthros

Runtime navigateur qui exécute des jeux Windows **tels quels** (binaire inchangé) avec le CPU/RAM/GPU du client : émulation x86-32 (interpréteur de référence + recompilateur dynamique x86→WebAssembly), chargeur PE32, réimplémentation des API Win32/DirectX sur les API du navigateur, système de fichiers virtuel servi en HTTP.

- `CLAUDE.md` — contraintes, architecture, conventions.
- `DECISIONS.md` — journal des décisions d'architecture.
- `STATUS.md` — état courant (palier, ce qui marche, blocages, prochaine action).

```
make test      # tests unitaires + conformité CPU
make serve     # serveur Orthros (http://localhost:8080)
make headless  # harnais Chromium headless
```
