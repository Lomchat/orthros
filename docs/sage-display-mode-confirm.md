# A resolution chosen in BFME, BFME II, RotWK and Age of the Ring: kept only once confirmed

The owner, 2026-11-17: "is the resolution I choose kept? It seems not: I must choose the max resolution again at every
launch." The chain was read end to end; the loss is in the game's own confirmation of a new display mode, whose ten
seconds Orthros spends rebuilding the menus. The fix is a manifest patch per version (the D112 mechanism,
`src/win32/process.js` `applyPatches`) that gives the confirmation 127 seconds — data outside Git, installed in the
manifests of `data/games` together with this page (until then the game still has its 10 s).

## What the evidence says

- **The profile is kept.** The account's copies of his Age of the Ring profile (20 versions, 2026-11-10 to 11-17,
  read only) carry the other settings he chose (`StaticGameLOD = High` since 11-10, volumes, health bars), and his two
  sessions of 11-17 list `Options.ini` as the previous session wrote it (telemetry `profile` event: 418 bytes, 09:01Z).
  But every copy says `Resolution = 800 600`, although he played at 2560x1440 (flicker samples of session z4c413il:
  800x600 at 12:21 and 12:23Z, 2560x1440 at 12:26Z). The writes of 12:23, 12:24 and 12:24Z only increment
  `TimesInGame` (the main menu writes it each time it is built): the game never wrote another `Resolution`.
- **No snapshot was involved**: both sessions started cold (the launcher's `CreateProcess` of game.dat is in their
  telemetry). A snapshot would not have hidden a new `Options.ini` either: the worker refuses one whose profile files
  the game saw at boot changed since (docs/snapshot.md stage 2, `tests/snapshot.test.js` "the profile stays the
  player's"), and the server's shared snapshot is only for a player without a profile (`main.js` `hasProfile`). D127's
  `newProfileIni` only touches a profile that was empty when the session started (`worker.js` `profileWasNew`).

## How these games save a resolution (game.dat of Age of the Ring 10.0.2, the RotWK 2.01 layout)

1. OPTIONS > SETTINGS > ACCEPT (`AptOptions::Save`, 0x91fc9c) only records the chosen mode; closing the screen asks the
   display manager (0x6455f3) for it, "to be validated".
2. The display manager switches (0x645dad: old mode kept, `setDisplayMode`), the shell is deleted and built again.
   The new main menu enters its state 8 when a validation is pending (0x91ca18) and shows *Validate Display Mode* /
   "Do you wish to keep the current display mode? The display mode will automatically revert in 10 seconds", Yes/No,
   with a timer: deadline = `timeGetTime()` + 10.0 s (0x91c0dc loads the 10.0, 0x95309c computes the deadline).
3. Yes: 0x6488d8 writes `Resolution = W H` to Options.ini. No, or the deadline: 0x645622 switches back. This is the
   only place the game writes a chosen resolution (the other writer is the first-launch measurement, 0x602d72).

## Why the player never gets to answer in Orthros

The deadline is set while the rebuilt menus are still loading, and that load is far longer than on a PC. Headless
(SwiftShader, 4 cores, Age of the Ring fr, 800x600 -> 1280x720): a single frame of 30 s after the switch, then the
menu, and the switch back 2-3 s later — the dialog was never on a screenshot. The owner's telemetry shows the same
frames on his RTX laptop: 23.8 s (22.6 s of guest code) and 40.7 s around his change. On a PC it is a second or two.
The game then switches back — or, most likely the owner's case (not reproduced), cannot: his tab was hidden during the
23.8 s frame (telemetry `visible` 0, "application deactivated: device lost"), so the switch back's `Reset` met a lost
device, failed as on Windows, and the game went on at 2560x1440 for the session without saving it. Either way the next
launch is at the old resolution again.

## The fix: 127 seconds to answer (manifest `patches`)

The 6 bytes that load the 10.0 (`fld dword [10.0f]`) become `push 127; fild dword [esp]; pop ecx` (`6a7fdb042459`):
the same x87 stack, 127.0 instead of 10.0 — the most a `push imm8` gives in the same 6 bytes; the owner's two long
frames around his change (23.8 + 40.7 s) would leave about a minute to answer, 100 s (the first version, verified
below) only ~35 s. `ecx` is free there (the next instruction pushes it only to make room for
the float argument, and it is reloaded after the call). The text still says 10 seconds; a browser shows every mode the
game lists, so the switch back is a safety only.

| Version (manifest id) | Module | rva | from | to |
| --- | --- | --- | --- | --- |
| Age of the Ring 10.0.2 (aotr-10) | game.dat | 0x51c0dc | d905d883bd00 | 6a7fdb042459 |
| RotWK 2.01 (rotwk-201) | game.dat | 0x51c0dc | d905d883bd00 | 6a7fdb042459 |
| RotWK 2.02 (rotwk-202) | lotrbfme2ep1.exe | 0x51c0dc | d905d883bd00 | 6a7fdb042459 |
| BFME II 1.09 (bfme2) | game.dat | 0x51c0dc | d905d883bd00 | 6a7fdb042459 |
| BFME II 1.06 (bfme2-106) | game.dat | 0x515ade | d9052824bc00 | 6a7fdb042459 |
| BFME 1.03 / 2.22, 1.08 (bfme-vanilla, bfme1-108) | lotrbfme.exe | 0x51f130 | 6800002041 | 680000fe42 |

The site was found by its context — `fld [c]; push ecx; fstp [esp]; call; pop ecx; mov ecx, [g]; push 1; call`
whose constant `c` holds 10.0, right after the dialog's creation —: exactly once in each executable, at the same rva
wherever docs/sage-camera-patch.md has the same one. BFME (lotrbfme.exe, both versions run the base's executable)
passes the 10.0 as an immediate (`push 0x41200000`, then its timer setter, 0x921de0, the same `timeGetTime` deadline):
127.0 is `0x42fe0000` (`680000fe42`). A patch whose bytes differ (another release) is skipped with a warning.

Changing a manifest changes the snapshot key of that version: players' own snapshots and the shared ones of these
versions are made again once (a cold start each).

## Verified

Age of the Ring 10.0.2 fr, headless Chromium, scratch manifest with the patch, profile at `Resolution = 800 600`,
screen 1920x1080, OPTIONS > SETTINGS > 1280x720 > ACCEPT:

- without the patch: no dialog on screen, switched back to 800x600 2-3 s after the menus came back; Options.ini
  unchanged;
- with the patch (100 s, the first version): the dialog on screen for about a minute after the menus came back (still
  there 50 s later), then the switch back at the 100 s deadline when nobody answers;
- with the patch and Yes clicked once the menus came back: the main menu at 1280x720, `Resolution = 1280 720` in the
  profile the harness saved;
- the snapshots (`--opfs`, `?snapshot=auto`, the same browser store each time): a session at 800x600 kept its own
  snapshot at the menu; the next one, its profile at 1280 720, refused it ("options.ini changed since the snapshot"),
  started cold with `CreateDevice 1280x720` and kept a new snapshot; the one after, from the browser's profile alone,
  restored that snapshot in 0.9 s, at 1280x720. The server's shared snapshot was not exercised: a player with a
  profile never takes it.

Not verified in a browser: RotWK, BFME II and BFME (same code and bytes, found by them), a player's machine.

The page's telemetry now carries the `CreateDevice WxH` and `Reset WxH` lines (`main.js` `TELEMETRY_GFX`): the mode a
cold start creates its device in and each switch, so a player's kept or reverted resolution can be read after their
next session. A session restored from a snapshot makes no `CreateDevice` (its mode is the snapshot's: one per display
mode, docs/snapshot.md). Since background play (the page's blur no longer deactivates the game) a `Reset` is a real mode
change, or a return from a lost device under `?bg=pause`.
