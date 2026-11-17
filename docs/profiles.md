# Player profiles: one per game

The player's profile — the files a game writes: saves, settings, replays, the maps a player made — is kept **per game,
shared by all its versions**, as on a PC, where a patch keeps them (owner, 2026-11-09). A version whose saves another
one cannot read (a translation whose place names are save identifiers, an incompatible mod) keeps its own with
`"ownProfile": true` in its manifest entry (or the folder's `defaults`).

## The key

The catalog gives every version a generated `profileKey` (`src/server/game-catalog.js`, reserved in the manifest): the
game folder's id, or the version's own id with `ownProfile`. It is not the former folder's of a version moved from
another one (`formerGame` keeps the installation's key only): a moved version's saves join its new game's. A folder id
equal to another game's version id is refused (one key, one profile); so is `ownProfile` on the version that carries
the folder's id (its key is the game's), and versions of different runtimes sharing the game's key (a Windows profile
and a port's are not the same files: `ownProfile` on the odd ones). `/api/manifests` and `/api/manifest/<name>` give `profileKey`;
`/api/manifest/<name>` also `profileSources` — the versions sharing it, `[{ name, saveKey }]`, the version itself first.
Every runtime names its storage from the key through `src/vfs/profile-share.js` (and nothing else):

| Where | Profile (per game) | Per version, unchanged |
|---|---|---|
| Windows game, browser | OPFS `orthros-<key>` (`profileDir`) | caches `orthros-files-<name>`, snapshots `orthros-snapshot-<name>`, JIT cache, profile seeds |
| GoldSrc, re3, browser | IndexedDB `orthros-profile:<key>` (`portProfileDb`), store `profile` | `orthros-port:<game>:<dir>` (the saveKey): the game files fetched before |
| OpenMW, browser | IDBFS `orthros-profile:<key>[:user:<scope>]` for `/userdata` | the saveKey's multiplayer, session and launcher state |
| Account | `/api/cloud/<key>` (`cloud-sync.js` CloudSave `game`, `profileKeyOf`) | — |

A version's `profileKey` is in the worker's manifest too; the snapshot key leaves `profileSources` out (a version added
to the game is not the machine's).

## A new player's settings: `newProfileIni` (`src/vfs/profile-ini.js`)

A manifest (a version or the folder's `defaults`) may give the settings a **new player** starts with: for a player with
no settings of their own yet — the profile empty when the session starts: no browser copy, no account copy — keys set in
the profile's ini files once the shared first-launch files are in place (src/shared/profile-seed.js) and the manifest's
`profileMoves` applied, before the game sees them. Afterwards the files are the player's: never touched again.

```json
"newProfileIni": { "AppData/Roaming/Age of the Ring/Options.ini": { "": { "Resolution": "{modeWidth} {modeHeight}" } } }
```

`{ <profile path>: { <section; "" = the top of the file, before any header>: { <key>: <value> } } }`, edited through
`src/shared/ini.js` (shared with the re3 ports): a key set in place, a missing one added, the rest of the file byte for
byte. Only a file the profile has is edited: a SAGE game that finds its `Options.ini` skips its first-launch
measurement (`IdealStaticGameLOD`, which also picks the resolution), and one holding a single key would be measured
again. So the version needs a shared first-launch profile in each language (canonical sets, `tools/ops/profile-seed-make.mjs`;
added on 2026-11-17 for Age of the Ring en/fr, BFME 2.22 fr and BFME II 1.06, which had none). A value may name
`{modeWidth}` and `{modeHeight}`: the largest display mode the player's machine lists (docs/display-modes.md) — the
highest resolution of their screen, the owner's choice for BFME, BFME II, RotWK and Age of the Ring (2026-11-17, D127).
Such a version's snapshots are kept per mode (docs/snapshot.md "Per display mode"). A resolution the player chooses later is
saved by the game itself, when its confirmation is answered (docs/sage-display-mode-confirm.md).

## Merging copies: `src/vfs/profile-merge.js`

The one merge, the same in the browser and on the server: several copies of a profile (`{ label, at, files }`) become
one — every path of every copy kept (Windows' case ignored, the first casing seen kept); the same bytes under one
path, one file; different bytes: a settings file (`*.ini`, `*.cfg`, `*.opt`, and the manifest's `profileSettings`
globs) takes the newest copy, any other file keeps every distinct copy — the newest at its path, each older one beside
it as `name (<label>).ext` (`name (<label> 2).ext` when that name holds other bytes). Newest: the file's own date
(`mtime`, which the account's copies now carry: `encodeProfile`), else its copy's. Done again on its own result it
changes nothing.

## The copies of before

Until 2026-11-09 each version had its own profile, under its name. Nothing is deleted:

- **Browser** (`profile-share.js` `migrateProfile` — a marker `orthros.profileMerged.<key>[.<scope>]` in localStorage
  records each copy's content hash —, under an exclusive Web Lock): before a game's start under the key, its versions'
  copies new to the marker (all of them the first time; a version that joined the game later) or changed since (a page
  of before still open) are merged into the profile as it is; a copy that cannot be read stops it, no marker written
  (done at the next start) (Windows: `data-store.js` `mergeVersionProfiles`, from the page, before the account's sync
  and the worker; GoldSrc, re3: `src/ports/port-profile.js` `openPortProfile`; OpenMW: `migrateIdbfs`, before the
  engine's first read of `/userdata`). The marker keeps each copy's content hash and the result's. The copies stay; the
  data window lists them under "Old copies" (empty ones hidden), exportable; the player deletes those the marker names
  (the others: "not taken in yet", until the game is started). A Windows file written from another copy (this merge,
  the account's copy or an archive put in place) keeps that copy's date (`data-store.js`, localStorage
  `orthros.profileDates.<folder>`: OPFS dates a file with its write), so a late merge never makes old files look newest.
  The same record keeps the dates the guest saw across restarts: the worker reports `[path, OPFS date, own date]` for
  each file it flushes (`profile-opfs.js`, message `profile-dates`), the page stores them, and at the next start passes
  them (`profileDates`) so that `worker.js` `loadProfile` gives each restored file its own date (not the restore's:
  `GetFileTime` / `FindFirstFile` of a save keep its save time). The running game's dump to the account carries each
  file's `mtime` too. The headless harness does the same with the host files' dates (`--profile-dir`).
- **Locale** (`src/win32/locale.js`): the guest's locale follows the session's game language (else the browser's):
  `vm.locale` ('fr-FR'...), set by the worker. `GetUserDefaultLCID` / `GetSystemDefaultLangID` / `GetThreadLocale`,
  `GetLocaleInfo` (separators, date and time pictures, day and month names from the platform's CLDR data, code pages),
  `GetDateFormat` / `GetTimeFormat` (flags and format pictures) answer as a Windows in that language does (fr-FR:
  `dd/MM/yyyy`, `HH:mm:ss`, decimal `,`). Unknown languages answer en-US. The C runtime's `setlocale` stays "C".
- **Account** (`accounts.js` `migrateProfiles`, at the server's start — table `profile_migrations`, per player and key,
  the version of each name it merged): the latest copy of each version not merged yet, or newer than the one merged (a
  version that joined the game later), and the key's own latest, merged into the key's next version.
  The versions' rows stay readable (listed with `migratedTo`; the key's row lists `merged`), a PUT or DELETE to them
  answers 410 `{ error: 'migrated', profileKey }` (only for names merged that still share the key: a version given
  `ownProfile` since is its own again); deleting the key's copies deletes them too, and the account's space
  may evict them first. A merge over the account's limits (64 MB, 10,000 files, the player's or the site's space) is not
  made — logged, the versions' keys stay usable, tried again at the next start.
- **First sync** under the key (`cloud-sync.js`, the head of the file; OpenMW: `cloud.js`): a browser whose merged
  copies were all in step with the account (each record's hash the marker's, the account's `merged` naming it) and whose
  profile has not changed since takes the account's merged copy without a question; otherwise both are merged here and
  sent over the account's head — no conflict, nothing lost.

Two tabs on two versions of one game write the same profile: last writer wins, as two tabs of one version always did.
Versions that should get `ownProfile` are an owner's call per game (data/, not Git).
