# Development & self-hosting

## Prerequisites

- [Bun](https://bun.sh/) (the toolchain — install, dev server, tests, scripts).
- A browser with **WebGPU** (Chrome / Edge 113+) and **SharedArrayBuffer**. SAB requires the
  page to be cross-origin isolated (COOP/COEP headers); the dev server and
  `deploy/server.ts` set these for you. `localhost` is a secure context, so no TLS cert is
  needed for local development.

## Develop

```bash
bun install
bun run dev          # http://localhost:5174  (plain HTTP; localhost is a secure context)
```

Useful extras:

```bash
bun run dev:ssl      # opt into HTTPS (only needed to exercise the secure-context path)
bun run dev:logs     # log server on :3001 (start before streaming worker logs)
```

Open `?game=dev` for a bare emulator that exposes `window.loadApp('<url>')`, `window.worker`
and `window.dbg` — the entry point the automation harness drives (see
[`harness.md`](harness.md)).

## Build & self-host

```bash
bun run build                 # → dist/
bun run deploy/server.ts      # static server: COOP/COEP + HTTP Range (for WGB streaming)
```

The server must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (SAB) and honor HTTP `Range` requests (so large
`.wgb` bundles stream instead of fully downloading). `deploy/server.ts` does both; any static
host works as long as it sets those headers and supports ranges.

## Quality gate

Run before sending a change — in this order:

```bash
bun tools/generate-index.ts          # 1. regenerate module barrel indexes
bun tools/validate-signatures.ts     # 2. WinAPI signature ⇆ implementation consistency
bun tools/validate-struct-offsets.ts # 3. struct layout offsets match the ABI
bun run typecheck                    # 4. TypeScript
bun test                             # unit + smoke tests
```

- **generate-index** — rebuilds the generated `index.ts` barrels for module directories.
  Custom hand-written indexes are detected and skipped.
- **validate-signatures** — cross-checks declared WinAPI function signatures against their
  implementations (parameter counts, calling conventions).
- **validate-struct-offsets** — verifies the field offsets of guest-visible structs against
  the documented Win32 / DirectX ABI.

## Repository layout

```
bottleship/
├── src/
│   ├── app/                     # React host UI
│   ├── harness/                 # main-thread half of the automation harness
│   └── worker/
│       ├── emulator.worker.ts   # Web Worker entry point
│       ├── core/                # CPU/scheduler, thunking, memory, HLE framework
│       ├── modules/             # WinAPI module implementations
│       ├── backends/webgpu/     # D3D/DDraw → WebGPU translation + post-FX
│       └── runtime/             # VFS, bundle loader, input, dialogs
├── packages/                    # standalone libraries (formats, repack)
├── tools/                       # build, bundling, harness, RE, quality-gate scripts
├── public/                      # static assets (fonts, covers, prebuilt wasm, bios)
├── deploy/                      # production static server
└── vendor/v86/                  # x86 emulator core (submodule)
```

## The v86 core

`vendor/v86/` is a fork of [v86](https://github.com/copy/v86), vendored as a submodule
(clone with `--recurse-submodules`). It is built to WebAssembly with
`vendor/v86/build-wasm.sh`; the generated Rust files are produced by that script and are not
checked in. From TypeScript, always access v86 properties with bracket notation
(`this["prop"]`) — the Closure Compiler advanced pass renames dot-notation properties.
