# MSS32 Reference Signatures

This directory contains reference signatures for Miles Sound System (MSS32) API.

## Source

MSS32 is a proprietary audio library, so official headers are not available in ReactOS.
Reference signatures were created based on:
- Existing `mss32.api.ts` implementation
- MSS32 documentation (where available)
- Reverse engineering of existing implementations

## Files

- **mss32.sig.json**: Reference function signatures for validation

## Usage

These signatures are used for validating API descriptors in `src/worker/api/mss32.api.ts`.
The validator compares function signatures against these reference files to ensure
binary compatibility with Windows MSS32 implementations.

## Updating

To update these signatures, edit `mss32.sig.json` manually or use:
```bash
bun run parse-reference-headers mss32
```

Note: This requires `ail.h` header file to be present in this directory.
