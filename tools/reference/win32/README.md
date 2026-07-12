# WIN32 Reference Headers

This directory holds the derived win32 `.sig.json` signature data. The raw `.h`
headers are gitignored (local-only regeneration inputs, re-fetchable from ReactOS —
see below); only the `.sig.json` are tracked and shipped.

## Source

Headers are fetched from the ReactOS GitHub repository:
- Base URL: `https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk`
- Repository: https://github.com/reactos/reactos
- Path: `sdk/include/psdk/`

## Files

- **winbase.h**: Windows Base API header (kernel32, advapi32 functions)
- **winuser.h**: Windows User API header (user32 functions)
- **wingdi.h**: Windows GDI API header (gdi32 functions)
- **mmsystem.h**: Windows Multimedia API header (winmm functions)
- **objbase.h**: OLE Base API header (ole32 functions)

## Updating

To update these headers, run:

```bash
bun run fetch-reference-headers win32
```

Or manually download from:
- winbase.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/winbase.h
- winuser.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/winuser.h
- wingdi.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/wingdi.h
- mmsystem.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/mmsystem.h
- objbase.h: https://raw.githubusercontent.com/reactos/reactos/master/sdk/include/psdk/objbase.h

## Usage

These headers are used as reference for validating API signatures in `src/worker/api/`.
The validator compares interface/function signatures against these reference files to ensure
binary compatibility with Windows implementations.
