# DirectX Reference Headers

This directory holds the derived DirectX `.sig.json` signature data. The raw `.h`
headers are gitignored (local-only regeneration inputs, re-fetchable from ReactOS —
see below); only the `.sig.json` are tracked and shipped.

## Source

Headers are fetched from the ReactOS GitHub repository:
- Base URL: `https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk`
- Repository: https://github.com/reactos/reactos
- Path: `sdk/include/psdk/`

## Files

- **ddraw.h**: DirectDraw header (IDirectDraw7, IDirectDrawSurface7)
- **d3d.h**: Direct3D header (IDirect3D7, IDirect3DDevice7, IDirect3D3, etc.)

## Updating

To update these headers, run:

```bash
bun run fetch-reference-headers
```

Or manually download from:
- ddraw.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/ddraw.h
- d3d.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/d3d.h

## Usage

These headers are used as reference for validating API signatures in `src/worker/api/ddraw.api.ts`.
The validator compares interface method signatures against these reference files to ensure
binary compatibility with Windows DirectX implementations.
