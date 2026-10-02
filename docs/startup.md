# Start-up and first use

What Orthros does so that a game reaches its menu sooner and does not stall the first time it uses something. All
of it is generic (nothing names a game) and each part can be switched off.

## Shared first-launch profile (`src/host/profile-seed.js`)

Some games do a long piece of work on their very first launch only — while no settings file exists in the user
profile they measure the machine, build caches, choose detail levels — and skip it at every later launch (BFME2 and
RotWK: ~70 s of computation before the first frame under Orthros). A player's browser starts with an empty emulated
profile (`C:\Users\Player`), so every new player paid it.

- **Learning.** A session whose profile was empty at start watches it. At the first click that finds files in the
  profile (the game reached a screen the player acts on, its first-launch work written), or at the first character
  typed (whatever is there then), it takes a snapshot of the profile's small files: not under `Temp`, ≤ 64 KiB each,
  ≤ 128 KiB and 32 files in all (saves, previews and caches stay out). The snapshot is taken as the input arrives,
  before the game sees it: nothing the player types is in it. Once the session has gone on (600 more frames over at
  least a minute: not a launch that failed), it is posted to `POST /api/profile-seed/<manifest>` with the game
  language and the session id.
- **Consensus.** The server keeps, per manifest and game language, the distinct sets reported (identified by
  content) with the sessions that reported each. A set is offered only once `--profile-seed-quorum` distinct sessions
  (default 2) reported it identical — the most reported one wins. Identical files from independent sessions are the
  game's defaults, not one player's data. Bounded: 16 sets per manifest (least recently reported out), 32 session
  ids per set. Stored in `<learn dir>/profileseed-<manifest>.json`; a server without this feature ignores the file,
  and the page asks for it only when `/api/config` says `profileSeed: true` (old pages and servers keep working).
- **Use.** A session whose profile is empty (first launch in this browser) asks
  `GET /api/profile-seed/<manifest>?lang=<game language>` (3 s at most) and writes the files before the game starts;
  they are then saved to OPFS like the game's own. It does not learn (only unseeded first launches teach).
- **Off:** manifest compat flag `"profileSeed": false` (nothing offered nor learned for that game), `?profileseed=0`
  (page), `--profile-seed 0` (harness).

The files are the game's own output under Orthros (e.g. its options file with the detail level its first-launch
benchmark chose on the emulated machine); a player can change them in the game's options as usual.
