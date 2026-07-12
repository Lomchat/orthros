## What & why

<!-- What gap between our recreation and real Windows behavior does this close? -->

## Faithfulness

- **The real API contract:** <!-- what documented behavior this implements -->
- **Public source for it:** <!-- Microsoft docs / public SDK header / observed Wine behavior
     (its conformance tests are ideal). Cite as reference only — never copy code from
     differently-licensed projects. -->
- [ ] The fix is **generic** — no branching on a game's name/exe/hash, no magic offsets for
      one title. Every game on this code path gets the corrected behavior.

## Proof it works

<!-- The harness script / verb sequence you drove and what it showed. "It typechecks" is
     not verification — say which game/flow you exercised and paste the relevant output. -->

```
harness()...
```

## Quality gate

- [ ] `bun tools/generate-index.ts`
- [ ] `bun tools/validate-signatures.ts`
- [ ] `bun tools/validate-struct-offsets.ts`
- [ ] `bun run typecheck`
- [ ] `bun test`

## Authorship

AI-assisted contributions are welcome — see
[docs/contributing-with-ai.md](docs/contributing-with-ai.md). By submitting you confirm you
ran the loop yourself, read the diff, and stand behind it; no game files, decompiled
binaries, or leaked source are included.
