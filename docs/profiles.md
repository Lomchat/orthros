# Player profiles: one per game

The player's profile — the files a game writes: saves, settings, replays, the maps a player made — is kept **per game,
shared by all its versions**, as on a PC, where a patch keeps them (owner, 2026-11-09). A version whose saves another
one cannot read (a translation whose place names are save identifiers, an incompatible mod) keeps its own with
`"ownProfile": true` in its manifest entry (or the folder's `defaults`).

## The key

The catalog gives every version a generated `profileKey` (`src/host/game-catalog.js`, reserved in the manifest): the
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
