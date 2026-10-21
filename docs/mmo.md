# Vice City — Orthros Edition: the shared world ("MMO")

Status: built 2026-10-20/21 (DECISIONS.md D102). The owner's decisions are binding (section 1). This is the contract
between the server (`src/host/mmo.js`, `mmo-proto.js`), the page (`src/host/web/mmo-link.js`, `src/ports/re3/play.js`)
and the engine (fork Lomchat/reVC, branch `orthros`, `src/extras/mmo/`, built with `-DREVC_ORTHROS_EXTRAS=ON`: the
Orthros Edition's release; the plain reVC build has none of it). Engine-defined record bodies (PLAYER_STATE, the
ENTITY_STATE kinds, EVENT / TARGETED subs, the character state blob, debug keys, test commands) are documented at the
top of each engine module (`mmo_players.cpp`, `mmo_entities.cpp`, `mmo_combat.cpp`, `mmo_session.cpp`,
`mmo_world.cpp`, `mmo_social.cpp`, `mmo_lobby.cpp`, `mmo_wire.cpp`).

## 1. The owner's decisions

1. Death works like the game: weapons lost, $100 hospital fee, respawn at the nearest hospital, remaining money kept.
2. A new character starts with $5000 and a pistol, at the Ocean View hotel.
3. Several characters per account (max from the manifest, default 8), each with its pseudo, skin and own state (money,
   weapons, position, health, armour); chosen when entering the multiplayer; the skin can be changed from the
   character menu. All characters of an admin account may use cheats.
4. World cheats (weather, time, traffic, pedestrians' behaviour) apply to everyone. Slow / fast motion is disabled for
   everyone (cheats, adrenaline, scripted time scale). Personal cheats (weapons, vehicles, health, armour, wanted level,
   skin) are visible to everyone through the normal replication.
5. Police and wanted levels are kept: cops spawn around the wanted player and the others see them. Over remote players:
   the pseudo AND the wanted stars, MMO style.
6. Missions and activities are disabled in the multiplayer.
7. Garages are not personal: whatever is in any garage persists on the server; everyone can use every garage. Street
   cars despawn as in the game.
8. "teleport" typed (like HELP) opens a list of all the game's save points; choosing one teleports there. For everyone,
   even with a wanted level.
9. Text chat on T, and names over heads.
10. A server admin list containing lomchat; only admins may use cheats in the multiplayer, the others are refused.
Also: combat everywhere (PvP), money / weapons / position kept except on death, a few players (not thousands),
traffic and pedestrians synchronised ("the same world"), no game saves in the multiplayer (all state on the server,
garage cars included), world persistence: nobody connected → the world is saved and frozen (its clock too); the first
arrival loads it; it stays live until the last one leaves.

The multiplayer is an entry of the game's own main menu ("Multiplayer" / "Multijoueur"), like the free mode: inherent to
the game, not a choice before launching it. It exists only in the Orthros Edition (`vice-city-orthros`), whose
manifest version has an `mmo` object.

## 2. Architecture

```
 engine (C++/wasm, one per browser tab)          page (JS)                     server (Node, one process)
 src/extras/mmo/*.cpp  --EM_JS-->  Module.orthrosNet = mmo-link  --WebSocket-->  src/host/mmo.js
   owns every game rule                generic: framing, queue,          generic hub: accounts, characters,
   (what a record means)               reconnect, heartbeat, away        slots, relay, ownership of ids,
                                                                          records + locks, world clock + vars,
                                                                          admins, persistence
```

* The server knows nothing about Vice City (CLAUDE.md: no game-specific code). It stores opaque blobs (character
  state, records), opaque world variables (id → int32), a clock (game minutes advancing at a rate), and arbitrates
  ownership of 32-bit network ids. Admin rights are checked on the server for world changes; personal cheats are a
  client rule (the engine refuses cheats when the server said "not admin").
* The page is a generic relay (`src/host/web/mmo-link.js`, Standardization rule: one shared module, usable by any
  runtime): the engine builds and parses every record; the page only adds its own PING / AWAY records.
* The engine is authoritative for its own player and for the ambient entities it owns (section 7). Hits are decided
  by the shooter's client and applied by the victim's owner.

## 3. Manifest

Version level (any runtime may use it; validated by the server's `mmoProblem(version)`), e.g. in
`data_games/vice-city-orthros/manifest.json` → `versions[0].mmo`:

```json
"mmo": { "maxCharacters": 8, "maxPlayers": 16 }
```

`maxCharacters` 1–16 (default 8), `maxPlayers` 2–32 (default 16). A version without `mmo` has no shared world: the
WebSocket refuses with reason 2 and the page does not create `Module.orthrosNet`. `docs/game-manifest.schema.json`
documents it. `/api/manifests` exposes `mmo: true` for such versions (the home card may show "Multijoueur").

## 4. Server (`src/host/mmo.js`)

`mmoApi({ getManifest, identify, dir, log, now }) → { handle(req, res, url) → bool, upgrade(req, socket, url) → bool,
flush() → void, close() → void }`, all state in its closure; wired in `server.js` (import; create after the account
API; `handle` in the handler chain; `upgrade` in the `upgrades` array; `server.mmo`; flush on 'close'; SIGTERM/SIGINT
flush in the CLI part). `dir` = `--mmo <dir>`, default `<accountsDir>/mmo`; without accounts the MMO is disabled.

* `GET /api/mmo/<versionId>` → `{ enabled, signedIn, admin, players }` (JSON, no-store).
* WebSocket `GET /api/mmo/<versionId>/ws` (`acceptWebSocket` from lan.js). Same-origin check (Origin's host ==
  Host header, as goldsrc.js udpRelay) before accepting, else raw 403. Not signed in (`identify(req)` null) → accept,
  send REFUSED(1) and close (so the page can tell). Unknown/disabled version → REFUSED(2). Session re-checked every
  60 s (logout → REFUSED(1), close).
* Files under `<dir>`: `admins.json` = `["lomchat"]` (lowercase usernames; re-read when its mtime changes; missing →
  no admin); `<versionId>/characters.json` = `{ nextId, characters: [{ id, user (account id), name, skin, money,
  state (base64), createdAt, updatedAt }] }`; `<versionId>/world.json` = `{ minutes, msPerMinute, vars: {id: value},
  records: {key: base64} }`. Atomic writes (`<f>.<pid>.tmp`, fsync, rename). Debounced 5 s while live; flushed when the
  last player leaves, on `flush()`, on `close()`.
* World lifecycle: a world is loaded at its first JOIN and unloaded (after flushing) when its last player leaves. Its
  clock only advances while it is loaded: `minutes(now) = baseMinutes + (now - baseMs) / msPerMinute`; on unload
  `minutes` is stored. Default `msPerMinute` 1000 (the game's own rate: one game minute per real second); new world
  starts at 12:00 of day 0 (minutes = 720).
* Slots: 0..maxPlayers-1, given at JOIN, freed at LEAVE/close. Rank: a world-wide counter increasing at each JOIN (the
  lowest present rank is the most senior player). Tag: a 12-bit value 1..0xFFE per in-world session, never one in use
  (by a live session, or by an id in the ownership table).
* Network ids (u32): players `0xFFF00000 | slot`; entities `(tag << 20) | counter` (counter 1..0xFFFFF, chosen by the
  engine). Owner of an entity id: the ownership table's entry, else the session whose tag it carries, else none.
* Ownership table: changed by OWN records and by departures. On LEAVE / close / AWAY(away=1) of a slot, every entity
  it owns whose position is known (from its ENTITY_STATE records in the last 15 s) is given to the nearest present,
  not-away player within 300 m (by their last PLAYER_STATE position); otherwise it is orphaned (owner 255: clients
  delete their copies). Each change is broadcast as OWNER. An entry naming another present player lasts until
  ENTITY_GONE, that player's departure or another OWN (forgetting it would hand the entity back to its creator): the
  engine sends ENTITY_GONE for every owned entity it deletes. Only orphan entries untouched for 60 s are forgotten.
  WELCOME's player list includes the joining player itself (its rank); LEAVE is answered LEFT then LOBBY.
* Records + locks (garages, generic): `key` u16 → bytes (≤ 4096) + holder slot. LOCK: if free or held by the asker →
  holder = asker, reply RECORD (holder = asker) to the asker and RECORD (holder) to the others; if held by another →
  reply RECORD (holder = other) to the asker. STORE: only from the holder: store data, holder = none, broadcast
  RECORD. UNLOCK: holder = none, broadcast. A holder leaving / going away releases its locks (data unchanged).
* Characters: name `^[A-Za-z0-9][A-Za-z0-9 _.-]{1,15}$` (2–16 characters, ASCII), unique case-insensitively per
  version; skin `^[A-Za-z0-9_]{1,20}$`; state ≤ 4096 bytes, opaque (empty = new character: the engine applies its
  defaults). At most `maxCharacters` per account. JOIN of a character already in the world from another socket:
  that older socket gets REFUSED(5) and is closed; the new one joins.
* Chat: text 1–120 bytes, printable ASCII or Latin-1 0xA0–0xFF only (else DENIED(3)); at most 1 per second (burst 5).
  The server keeps the last 20 lines per world and sends them after WELCOME.
* Admin-only requests (WORLD_SET, WORLD_EVENT) from non-admins → DENIED(type, 1).
* Limits per socket: frames ≤ 64 KB (bigger → close), ≤ 800 records/s and ≤ 256 KB/s inbound on average (token
  buckets; excess dropped, with one DENIED(type, 2) per second at most); lobby requests ≤ 5/s. Output: records to a
  socket are coalesced per event-loop turn into one frame; if `socket.writableLength` > 1 MB, realtime records
  (0x20–0x24) to it are dropped until it drains (control records still go).
* A peer silent for 45 s is closed (the page pings every 15 s).

## 5. Wire protocol

All little-endian. `str8` = u8 length + bytes. One WebSocket binary message = one or more records.
Client → server record: `u16 len | u8 type | body` (len counts type + body, ≤ 65535).
Server → client record: `u16 len | u8 type | u8 from | body` (len counts type + from + body; from = sender slot, 255 =
the server). Unknown types are ignored by both sides (forward compatibility).

### Client → server

| type | name | body |
|---|---|---|
| 0x01 | HELLO | u16 protocol (=1), u8 lang (0 en, 1 fr) — first record after the socket opens; reply LOBBY |
| 0x02 | CHAR_CREATE | str8 name, str8 skin → CHAR_RESULT then LOBBY |
| 0x03 | CHAR_SKIN | u32 charId, str8 skin → CHAR_RESULT then LOBBY |
| 0x04 | CHAR_DELETE | u32 charId → CHAR_RESULT then LOBBY |
| 0x05 | JOIN | u32 charId → WELCOME (+ RECORDs, CHAT history, PLAYER_JOIN to the others) or CHAR_RESULT(op 5, error) |
| 0x06 | LEAVE | — → LEFT; others get PLAYER_LEAVE (+ OWNER changes) |
| 0x07 | PING | f64 clientMs → PONG |
| 0x08 | AWAY | u8 source (0 engine: pause menu; 1 page: tab hidden), u8 away (0/1). A player is away if any source says so |
| 0x09 | CHAR_SAVE | i32 money, u16 n, n bytes state (in world only; stored for the joined character) |
| 0x0A | CHAT | str8 text → CHAT to everyone in the world (sender included) |
| 0x0B | WORLD_SET | admin: u8 op; op 1: u8 varId, i32 value; op 2: u16 minuteOfDay (0–1439, same day); op 3: f32 msPerMinute (30–60000) → WORLD to everyone |
| 0x0C | WORLD_EVENT | admin: u8 id, i32 arg → WORLD_EVENT to everyone (sender included) |
| 0x0D | LOCK | u16 key |
| 0x0E | STORE | u16 key, u16 n, n bytes (≤ 4096) |
| 0x0F | UNLOCK | u16 key |
| 0x10 | OWN | u32 netid, u8 op (1 claim: owner = me; 2 give: owner = `to`), u8 to. Claim refused (OWNER unchanged, to the asker only) when the entity's last state had flag bit 0 (driven by its owner's player) and its owner is present and not away. Give accepted only from the current owner |
| 0x11 | PLAYER_INFO | str8 skin → PLAYER_INFO to the others |
| 0x20 | PLAYER_STATE | f32 x, y, z, then engine bytes (≤ 240) — relayed to the others |
| 0x21 | ENTITY_STATE | u32 netid, u8 kind, u8 flags, f32 x, y, z, then engine bytes (≤ 400) — dropped unless sender owns netid; relayed |
| 0x22 | ENTITY_GONE | u32 netid, u8 reason — owner only; forgets the entry; relayed |
| 0x23 | EVENT | u8 sub, engine bytes (≤ 1000) — relayed to the others |
| 0x24 | TARGETED | u32 target netid, u8 sub, engine bytes (≤ 1000) — sent to the owner of target (player id → that slot) only |

### Server → client

| type | name | body |
|---|---|---|
| 0x80 | REFUSED | u8 reason (1 sign-in needed, 2 no shared world for this version, 3 world full, 4 protocol, 5 joined elsewhere, 6 server error), str8 detail; the socket closes after it |
| 0x81 | LOBBY | u8 admin, u8 maxCharacters, str8 username, u8 n, n × { u32 id, str8 name, str8 skin, i32 money, u8 online } |
| 0x82 | CHAR_RESULT | u8 op (2 create, 3 skin, 4 delete, 5 join), u8 status (0 ok, 1 invalid name, 2 name taken, 3 too many, 4 not found, 5 world full, 6 error, 7 invalid skin), u32 charId |
| 0x85 | WELCOME | u8 slot, u16 tag, f64 serverMs, u8 admin, u32 charId, str8 name, str8 skin, u16 n, n bytes state, WORLD body, u8 nPlayers, nPlayers × PLAYERINFO |
| 0x86 | LEFT | — |
| 0x87 | PONG | f64 clientMs, f64 serverMs |
| 0x8A | CHAT | u8 kind (0 player, 1 server notice), str8 name, str8 text (from = slot) |
| 0x8B | WORLD | f64 baseServerMs, f64 baseMinutes, f32 msPerMinute, u8 n, n × { u8 id, i32 value } |
| 0x8C | DENIED | u8 type (the request's), u8 reason (1 not admin, 2 rate limit, 3 invalid) |
| 0x8D | WORLD_EVENT | u8 id, i32 arg (from = the admin's slot) |
| 0x8E | RECORD | u16 key, u8 holder (255 none), u16 n, n bytes |
| 0x90 | OWNER | u32 netid, u8 owner (255: orphaned, delete it), u8 previous |
| 0x91 | PLAYER_JOIN | PLAYERINFO |
| 0x92 | PLAYER_AWAY | u8 slot, u8 away |
| 0x93 | PLAYER_LEAVE | u8 slot |
| 0x94 | PLAYER_INFO | u8 slot, str8 skin |
| 0x20–0x24 | relayed | as sent, with `from` = sender slot |

PLAYERINFO = u8 slot, u32 rank, u8 admin, u8 away, str8 name, str8 skin. After WELCOME the server sends every RECORD
of the world, then the chat history (CHAT records), then the current OWNER entries (if any). Game minutes are a
double: `minutes(serverNow) = baseMinutes + (serverNow - baseServerMs) / msPerMinute`; day = floor(minutes / 1440).

Page-made records (the shared link, section 6): PING every 15 s, AWAY(source 1) on visibility changes; and one
pseudo-record into the engine queue after a reconnection: `u16 len=2 | u8 0xFE | u8 255` (LINK_RESET).

### Engine-owned ranges (the server never reads them)

* ENTITY kinds (0x21): 1 ped, 2 automobile (cars, flyable helis, Dodo), 3 bike, 4 boat, 5 police heli (CHeli),
  6 plane, 7 object. Flags: bit 0 driven by its owner's player (locks it), bit 1 law entity (wanted player's police),
  bit 2 parked (from a car generator), bit 3 mission/script, bit 4 dead/wrecked.
* EVENT subs (0x23) and TARGETED subs (0x24), by module: 0x01–0x1F players, 0x20–0x3F combat, 0x40–0x5F entities,
  0x60–0x7F world, 0x80–0x9F social, 0xA0–0xBF session.
* World variables (WORLD n × {id, value}): 1 forced weather (-1 none), 2 world cheat bits (bit list in the world
  module), 3–15 reserved for the world module. Records: keys 0x0100 + hideout index (garages, 160 bytes).
* WORLD_EVENT ids: 1 BIGBANG (blow up cars: each client its own), others by the world module.

## 6. Page (`src/host/web/mmo-link.js` + `src/ports/re3/play.js`)

`createMmoLink({ url, log, onState }) → link` (generic, no game knowledge; node-testable):
* `link.open()` connect (idempotent); automatic reconnection with backoff (1, 2, 4, 8, 15 s…) after an unexpected
  close, then the LINK_RESET pseudo-record is queued for the engine. A REFUSED record stops reconnection
  (`state 3`, `refusal` = reason) until `open()` again.
* `link.state()` 0 closed, 1 connecting, 2 open, 3 refused, 4 waiting to reconnect; `link.refusal()`.
* `link.send(bytes /*Uint8Array, one or more client records*/, unreliable)` → bool; unreliable data is dropped when
  `bufferedAmount` > 256 KB; reliable data is sent (or queued while connecting, ≤ 1 MB).
* `link.drain(heapU8, ptr, cap)` → bytes written: queued server messages, each as `u32 length | message bytes`
  (whole messages only; a message bigger than cap is dropped); 0 when empty; -1 once after an overflow (queue > 8 MB
  was emptied: the engine resynchronises).
* `link.away(bool)` (page source); `link.close()`; heartbeat PING every 15 s while open.
* play.js: when the version has `mmo`, `engine.orthrosNet = { ...link, user: () => username or '', signIn: () =>
  shell.showLoaderSignIn-like sign-in prompt, testing: URL has `mmotest`, testCommands: [], debug(json) }`, the url
  `/api/mmo/<versionId>/ws` (ws/wss from location). Visibility → `link.away(document.hidden)`; pagehide → close.
  `window.orthrosMmo` = { link, state: last engine debug object, command(str) } for the test harness.

EM_JS functions (engine, `src/extras/mmo/mmo_wire.cpp`), all non-blocking:
`OrthrosNetAvailable()` (Module.orthrosNet exists), `OrthrosNetOpen()`, `OrthrosNetClose()`, `OrthrosNetState()`,
`OrthrosNetRefusal()`, `OrthrosNetSend(ptr, len, unreliable)`, `OrthrosNetDrain(ptr, cap)`, `OrthrosNetUser(ptr, cap)`,
`OrthrosNetSignIn()`, `OrthrosNetTesting()`, `OrthrosNetTestCommand(ptr, cap)` (next command string or 0),
`OrthrosNetDebug(jsonPtr)`. Pointers are converted with `>>> 0`; bodies keep explicit semicolons (EM_JS is
stringified on one line); `EM_JS_DEPS(orthros_mmo, "$UTF8ToString,$stringToUTF8")`.

## 7. Engine (`src/extras/mmo/`, compiled only with ORTHROS_EXTRAS)

Files and owners (one agent each during the build-up; headers `mmo.h` = hooks called by the game's code,
`mmo_internal.h` = between modules; `mmo_weak.cpp` = weak defaults of every function so each module builds alone):

| file | module | content |
|---|---|---|
| mmo_wire.cpp | core | EM_JS bridge, record framing (Out/In), dispatch by type/sub range, link state machine (HELLO on open, LINK_RESET → HELLO + JOIN again), clock sync (PING every 2 s; offset from the best of the last 8 RTTs), AWAY detection (pause menu), lobby data (LOBBY/CHAR_RESULT parsed), request helpers, the entity registry (side tables by pool index: netid, owner, flags; netid ↔ entity), remote players table (PLAYERINFO), test commands + debug JSON |
| mmo_session.cpp | session | join flow (WELCOME → load the base world like the free mode's "new free game" → GameLoaded), world preparation (stop the single-player threads, $313 = 0, remove clothes and save pickups, interior state reset, perks: m_bGetOutOfHospitalFree / JailFree false), character apply (skin, money, weapons, health, armour, position, new-character defaults), CHAR_SAVE every 10 s and at death/respawn/leave/money or weapon change, pause menu in MMO (no save; "Leave multiplayer"), leaving to the main menu, guards (missions, SCRIPT_NAME stop list, time scale, adrenaline, debug menu for non-admins), death rules (no PassTime, no ClearExcitingStuffFromArea, skin kept at respawn), test auto-join |
| mmo_lobby.cpp | lobby | main-menu entry "ORT_MP" and pages: characters list, character (Play, Appearance, Delete), new character (pseudo text field, appearance, Create), delete confirmation, connection / sign-in / errors; skin list (Tommy's outfits, special characters, ordinary peds — names EN/FR) |
| mmo_players.cpp | players | local player state (PLAYER_STATE ~15 Hz moving, 2 Hz still), remote player puppets (CCivilianPed, special model slots MI_SPECIAL01..21, kinematic, animations, weapon in hand, aim IK, seated in vehicle puppets), name tags + wanted stars, "away" marker, interiors (other area → hidden), skin changes (PLAYER_INFO) |
| mmo_entities.cpp | entities | ambient replication: local entities found by pool scan → netid; ENTITY_STATE for those near any remote player (peds 6 Hz, vehicles 10 Hz within 250 m); puppets (create when the model is loaded, kinematic ProcessControl, interpolation 100 ms behind, CanBeDeleted false); ownership: generation predicate, migration instead of removal, claim on entering a remote car, OWNER handling (puppet ↔ real conversion), law entities (wanted player's police: kept by their owner), car generators link, car parks |
| mmo_combat.cpp | combat | shooter-authoritative damage (peds, vehicles, tyres, melee impulses, knock-off, car vs ped), shot visuals (bullet traces, sniper bullets, flame shots), projectiles, explosions and fires (each owner damages only its own entities), deaths and kill feed, pickups (dynamic ones created and taken, static ones taken) |
| mmo_world.cpp | world | clock from the server (CClock), weather (deterministic from the clock + forced var), traffic lights on the shared clock, world cheats as absolute bits + world events, garages (records + locks, door mirror) |
| mmo_social.cpp | social | chat (T opens a line; Enter sends; Esc cancels; history of 8 lines, 15 s), server notices and kill feed lines, teleport list ("teleport" typed or sent in chat: the 17 save points, clicked or chosen with arrows/Enter; fade, LoadScene, teleport; in a vehicle the vehicle goes too), admin gate for cheats (non-admins: "reserved to administrators"; admins: world cheats → WORLD_SET/WORLD_EVENT, personal ones as in the game, slow/fast motion refused), HELP list not pausing in MMO |

### Frame order (one main-loop iteration)

1. `OrthrosFrameYield` (sdl2.cpp) — page events, WebSocket messages queue up.
2. `OrthrosMmo::Pump()` — drain the page queue, dispatch every record (handlers may create/delete puppets: this is
   outside CWorld::Process; when the world is not ready they only store), send nothing yet.
3. `inputEventHandler` — keys (`KeyDown`, `TextInput`) and mouse.
4. In game: `CGame::Process`: `BeginProcess()` after `CPad::UpdatePads` (chat key, lists); `CClock::Update` →
   `ClockUpdate()`; …; `PreWorld()` before `CWorld::Process` (puppet creation from pending models, conversions);
   `CWorld::Process` (puppets' ProcessControl = interpolation); `PostWorld()` after it (capture local player + owned
   entities); …; `EndProcess()` at the end (flush the frame's records in one `OrthrosNetSend`).
   In the frontend: `FrontendFrame()` after `FrontEndMenuManager.Process`, then flush.
5. Rendering: `Render2d()` (name tags, before the HUD), `RenderOverlay()` (chat, lists, notices over everything).

Timing rule: interpolation and send rates use wall-clock `emscripten_get_now()` (never CTimer, which pauses, clamps
and scales). Puppet transforms are applied every frame from the buffered states.

### Ownership and population (entities)

* Every non-player ped and every vehicle in the pools is either *owned* (simulated here, has a netid with our tag) or
  a *puppet* (a copy of another client's entity: kinematic, no AI, no physics integration, `CanBeDeleted()` false,
  `bIsLocked`/UNK_CHAR so the game's removers leave it alone).
* Generation (`MayGenerateAt(pos, kind)`, called by every ambient spawner: peds, traffic, boats, parked cars, car
  parks, emergency vehicles): allowed iff no present, not-away remote player in the same area within 300 m of `pos`
  is strictly closer to `pos` than the local player (ties: the more senior rank wins). Law spawns for the local
  wanted player always pass (they belong to the wanted player).
* Migration instead of removal: where the game would delete an owned ambient entity for distance, if a remote player
  is within that entity's removal radius (peds 51 m, vehicles 120 m ×1.5) → OWN give to the nearest such player; the
  local copy becomes a puppet (deleted later when out of our view). Never for law entities or mission entities.
* Puppets beyond 300 m (or in another area) are deleted locally; they come back with the next state.
* OWNER received: owner = us → convert the puppet to a real entity (peds wander, cars `JoinCarWithRoadSystem` +
  cruise); owner = other → our real copy becomes a puppet; 255 → delete.
* Entering a remote-owned empty car (or one with an ambient driver): claim it (and its occupants) optimistically
  before the enter animation; a car driven by a remote player cannot be entered (later: jack request).
* Vehicles driven by the local player are owned by us with flag bit 0.
* Puppets count in the game's ped/car counters (density stays the game's where players overlap).

### Combat authority

* A hit on a puppet (bullet, shotgun pellet, melee, sniper bullet, car impact by our own driven car) is detected by
  the shooter's client, which sends TARGETED damage to the victim's owner with the raw damage, method, piece, direction
  and the attacker netid; nothing is applied to the puppet locally except effects (blood, sparks). The owner calls the
  game's own `InflictDamage` with the attacker's puppet as culprit (armour, the player's ×0.33, death, credit).
* Explosions, projectiles, flames and fires are EVENTs replayed on every client; each client damages only what it
  owns (and its own player); puppets are skipped. A remote shot only draws (trace, muzzle flash, sound).
* The local player's death: EVENT with killer netid (from the last network damage) and weapon; every client prints
  the kill line; the puppet plays its death and is revived at the respawn state.

### Session flow

Main menu → Multiplayer → (page: not signed in → message + "Sign in" opens the page's sign-in) → lobby (LOBBY) →
choose / create a character → JOIN → WELCOME → the base world (`orthros\freemode.b`, as the free mode's new game, but
without the free mode's save rules) loads → `GameLoaded` → world preparation, character, world state, records →
`IsActive()` true → playing. Pause menu: no Save; "Leave multiplayer" → CHAR_SAVE, LEAVE → back to the main menu.
Tab closed: the last CHAR_SAVE (every 10 s and at every money/weapon change) is the character's state.

### Test hooks

With `?mmotest` on the page URL (`OrthrosNetTesting()`), the engine reads one command per frame from
`orthrosNet.testCommands` and publishes a debug JSON every 500 ms (`window.orthrosMmo.state`): `{ mode, link, slot,
admin, inWorld, pos, area, health, money, wanted, weapon, vehicle, players: [{slot, name, pos, dist, area, away,
visible, stars}], owned: {peds, vehicles}, puppets: {peds, vehicles}, lobby: {characters}, chat: [last lines],
fps }`. Commands: `join <name> [skin]` (create if missing, then join; from the main menu), `leave`,
`tp <x> <y> <z>`, `weapon <id> <ammo>`, `fire` (one shot), `aim <slot>` (turn to a remote player), `car <model>`,
`say <text>`, `cheat <code>`, `teleport <index>`, `die`, `money <n>`, `key <rsKey>`, `menu` (open the pause menu).

## 8. Test plan

* `node --test tests/mmo.test.js`: manifest validation; REFUSED without sign-in / cross-origin 403; lobby CRUD (name
  rules, uniqueness, max); JOIN → WELCOME; relay (from stamping, owner check, TARGETED routing); OWN claim/give/lock
  flag; departures → OWNER reassignment by distance; records/locks; chat rules + history; WORLD_SET admin only; clock
  frozen while empty; persistence across server restart; limits.
* `node --test tests/mmo-link.test.js`: framing, drain format, overflow, reconnection + LINK_RESET, away.
* Engine: every module builds (`/tmp/orthros-scratch/mmo/dev/build.sh <src> <build> <id>`), then
  `tools/re3/mmo-check.mjs` (two pages in one Chromium, two accounts, `?mmotest`): join both, see each other
  (positions within 2 m), chat both ways, shoot → damage → death → respawn at hospital with −$100 and no weapons,
  ambient peds/cars near both present on both (same netids), owner migration when one walks away, wanted level →
  remote stars + cops visible to the other, world cheat by the admin applied on both, refused for the other, teleport
  list, garages store/restore across clients, leave + rejoin restores state, server restart → page reconnects.

## 9. How it was checked (2026-10-21)

* Node: `tests/mmo.test.js`, `tests/mmo-link.test.js`, `tests/mmo-check.test.js` (44 tests); `make test` green.
* Every module was reviewed and each finding verified by a second reader before being fixed (server: abuse limits,
  locks kept while away, records' key ranges, ping frames for hidden tabs, name rules; engine: untrusted bytes on every
  record, garage records sanitised, resynchronisation resets, leaving during an outage, the arrest penalty,
  test commands an allow-list for non-administrators, pickups claimed once).
* `tools/re3/mmo-check.mjs`, two players in one headless Chromium (SwiftShader, 0.3–2 frames a second), on a test
  server, development build then the pinned `revc-web-e3bf84d-plus-r1`: setup, basic (each sees the other within 2 m,
  away, money and place kept across leave/join, a dropped connection rejoined), chat, combat (shots, death, the kill
  line, respawn at the hospital with −$100 and no weapons), the combat module's own scenarios (TARGETED hits, blast,
  pickups, flames, grenade, vehicles), population (copies of the other's peds and cars with the same network ids, the
  owner's departure handing them over), world (cheats refused for a non-administrator, wanted stars over the
  administrator, police copies seen by the other, a world cheat on both, the teleport list with a wanted level),
  garage (a car stored by the door closing, kept by the server, known by the other). Last full run 51/56 (the five:
  harness waits and a ram too soft to hurt a player, as in the game — since adjusted); the pinned release 20/20 on
  basic, chat and population. `tools/re3/check.mjs`: reVC `--new-game`, the Orthros Edition `--new-game` and free mode
  through the menu, unchanged.
* Bandwidth: a player's link carried ~0.3 KB/s on average over a 30-minute run with both players together (states of
  the other player and of ~10–20 shared entities); well under the owner's slowest link (85 KB/s), not measured on a
  throttled link.
* Not checked in a real browser at 60 frames a second, nor with more than two players, nor on a real GPU: the feel of
  the remote players' animations and vehicles, and the population's density where three or more players meet.
