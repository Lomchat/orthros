# Compatibility telemetry: what the players' games asked for that Orthros does not do

The players' sessions already said *how many* imports had no implementation (`unknownImports`, a count). That says
nothing about *which* gap to fill first. Since 2026-11-12 every Win32 session with telemetry on also reports the
names, with how often they were met, for the three kinds of gaps the runtime can see itself:

| kind (`compat` field) | what is counted | where |
|---|---|---|
| `imports` | an import without an implementation that the game **called** (resolved but never called: left out) — calls | `vm.js` tracing stub, `proc.unknownImports` |
| `notImpl` | a COM method that answered `E_NOTIMPL`: a method without an implementation (whatever code its object answers) or an implementation's own `E_NOTIMPL` — calls | `com.js` `Com.notImpl` (transient: not in snapshots) |
| `shaderOps` | a shader instruction the translators left out (`// unsupported vs\|ps op N`), named `ps9 texm3x2depth` — programs built with it | `d3d8-webgl.js` `noteUnsupported`, device `stats.unsupportedOps`; logged once per instruction (`d3d-webgl: warning: shader instruction …`) |

**One module** (`src/core/compat-stats.js`): `compatSummary()` turns the three sources into `{ imports, notImpl,
shaderOps: [[name, count]…], more? }`, the most counted first, **at most 40 names per kind** (names cut to 96
characters; `more` = the names left out per kind) — a few KB of JSON at worst; `null` when there is no gap. The
emulator's worker adds it to every stats message (`compat`, ~0.5 s; the shader counts come from the device's stats,
which the render worker already sends with its own). The page (`main.js sendCompat`) queues a `compat` telemetry event
(cumulative, so the latest one of a session is the whole session) when the **set of names** changes, at most every 30 s,
and once more at the end (exit, crash, page hidden) when the counts moved.

**Reading** (`tools/dev/telemetry-report.mjs`): each session's report prints its gaps (`unknown imports called (n):
name xcalls, …`, `COM E_NOTIMPL (n)`, `untranslated shader instructions (n)`); `--compat` merges them per game over the
sessions: each gap with the number of sessions that met it and its counts summed, the most frequent first
(`--players` leaves the benches out, `--json` for tools).

Nothing about the player is in it: names of Windows APIs, COM methods and shader opcodes only.
