# Backups (restic)

Everything here that cannot be regenerated has one copy on this machine's disks. Since 2026-10-26 a restic repository
keeps its history: a file deleted or changed by mistake — a game's file, a manifest, an engine release, a player's
world, a local note — comes back as it was on any snapshot's date. `tools/backup.sh` is the only entry point (its
header lists the commands); the README's « Sauvegardes » section is the short version of this page.

## What a snapshot holds

| Source | What | Left out (and why) |
|---|---|---|
| `/srv/orthros` | `data/` (games, engines and their pinned sources, installers, Wine prefix, corpus, proofs), `backups/manual/`, `.git` (every commit and branch, the unpushed ones too), the local notes `CLAUDE.md`, `DECISIONS.md`, `STATUS.md`, `STATUS-history.md` (outside Git), the working tree and its uncommitted changes, `.charon-uploads/` | `build/`, `node_modules/`, `tests/generated/`, `.claude/worktrees/` (disposable or rebuilt); `backups/restic`, `backups/cache`, `backups/mnt`, `backups/restore-*`, the password file (the backups themselves) |
| `/var/lib/private/orthros2` | the server's accounts (players' cloud saves, Google sign-in configuration), learned data (orders, GL programs, snapshots), telemetry | `brcache/` and `covers/`: precompressed copies of the games' files and light covers, remade on demand |
| `/var/lib/private/orthros-goldsrc` | the GoldSrc dedicated servers' state | `*/game`: the linked game trees, rebuilt at each start |
| `/var/lib/orthros-openmw` | the OpenMW gateways' worlds, accounts, operator credentials, configuration | `*/gamedata`: the linked game trees, rebuilt at each start |
| `/etc` | `orthros-openmw.env` and the `orthros*` systemd units | |

Repository: `backups/restic/` (same NVMe disk as `data/`), password `backups/restic-password` (root, 0600), cache
`backups/cache/`. `backups/` is mode 0700 and ignored by Git (`/backups`, no trailing slash: a link of that name is
ignored too).

Restic stores content in deduplicated, compressed, encrypted chunks: a file present in every snapshot is stored once,
and a snapshot costs only the chunks that changed since the previous one. Game data is already compressed (BIG, BSA,
WAD archives), so the repository is about the size of what it holds. Measured on 2026-10-26 (restic 0.16.4, 4 cores):
the first snapshot read 114,691 files, 72.9 GiB (the hard-link copy of four games and duplicated installers counted
again), of which 29.9 GiB of distinct content, stored as 22.3 GiB, in 3 min 43 s; the next one, nothing changed but a
few state files, 5.6 s and 87 KiB.

## Schedule and retention

`orthros-backup.timer` runs `tools/backup.sh daily` every night at 04:40 (up to 15 min later; `Persistent=true`: a run
missed while the machine was off happens at boot): a snapshot tagged `daily`, then the retention policy and a prune.
Kept: every snapshot of the last 14 days, one per week for 8 weeks, one per month for 24 months, and always those
tagged `manual` (taken by hand) or `pre-restore` (taken automatically before an in-place restore). The service runs
niced (`Nice=19`, idle I/O, batch CPU) on 4 cores at most (`GOMAXPROCS=4`): this machine is shared.

`systemctl list-timers orthros-backup.timer` shows the next run; `journalctl -u orthros-backup` the last ones. A run
that finds a file unreadable (gone while read) still saves the snapshot (restic's exit 3) and says so in the journal.

## Using it (as root)

```sh
tools/backup.sh snapshot -m "before replacing bfme2's patch"   # before any hand change in data/ or the services' state
tools/backup.sh list                                          # the snapshots: id, date, tags (the note is a tag "note:…")
tools/backup.sh diff 1a2b3c4d latest                          # +/-/M per file between two snapshots
tools/backup.sh find manifest.json                            # every snapshot holding a file of that name, with its path
tools/backup.sh ls latest /srv/orthros/data/games/bfme1       # a folder's files in a snapshot
tools/backup.sh mount                                         # all snapshots as plain folders under backups/mnt/ (Ctrl-C)
```

Restoring:

- **A copy beside, nothing touched**: `tools/backup.sh restore <id|latest> <path> --to /tmp/orthros-scratch/restore`
  writes `<dir>/<absolute path>` (the scratch budget applies: a whole game can be 10 GB — prefer a single folder).
- **In place** ("revert"): `tools/backup.sh restore <id|latest> <path>` restores the snapshot's `<path>` into a stage
  under `backups/` (the same disk as `data/`), shows the changes (`rsync --itemize-changes`) and asks; then it takes a
  `pre-restore` snapshot of the current state, and makes `<path>` exactly as it was — files added since are removed
  (`rsync -aHAX --delete`). `--yes` skips the question (scripts, agents: only after reading the change list). The
  stage is removed at the end. A restore can therefore always be undone with the newest `pre-restore` snapshot.
- **A service's state** (e.g. an OpenMW world): stop its unit first (`systemctl stop orthros-openmw@<manifest>`),
  restore, start it again — a running service would overwrite or not see the restored files.
- **Everything after a disaster** (the folder deleted, the disk replaced): the repository lives on the same disk, so
  first recover `backups/` itself (see Limits); then
  `restic -r <repository> --password-file <file> restore latest --target /` puts every path back where it was.

Integrity: `tools/backup.sh check` (the repository's structure and a 1 % sample of the data, a minute or two);
`check --full` reads all of it. A run killed in the middle leaves a stale lock: `tools/backup.sh restic unlock`.

## Limits — what this does not protect against

- **The disk's loss**: the repository is on the same NVMe disk as `data/` (the owner's choice: inside `/srv/orthros`).
  It covers deletion and modification by mistake (a person, an agent, a bad merge as on 2026-10-02), not a dead disk
  or a lost VPS. A second copy is one command away when wanted: `restic copy` into a repository elsewhere — the
  machine's other disk (`/`, sda) or another machine (SFTP / S3) — run after `daily`.
- **The password**: without `backups/restic-password` no snapshot can be read. Keep a copy outside this machine
  (a password manager): `cat /srv/orthros/backups/restic-password`.
- **Databases copied live**: SQLite files (OpenMW's `accounts.db`, …) are read while their service runs, with their
  `-wal` / `-shm` files; SQLite recovers such a copy in practice, but a restore of one is best done with the service
  stopped and checked after its start.
- Data under `build/` and `/tmp/orthros-scratch` is never kept: nothing irreplaceable goes there (CLAUDE.md, Layout).

## History

Before 2026-10-26: four folders `data_games`, `data_engines`, `data_installers`, `data_wine` at the repository's root,
the OpenMW state under `build/openmw` (erased by `make clean`), and as the only protection a hard-link copy of four
games' folders (`data_installers/game-library-backup`, made after the 2026-10-02 incident: it survived a deletion of
`data_games` but shared every file with it — a file changed in place was changed in the "backup" too). It was removed
once the first snapshot was checked. DECISIONS.md D105.
