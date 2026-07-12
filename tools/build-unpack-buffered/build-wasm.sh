#!/usr/bin/env bash
# Build unpack-buffered.wasm + wasm-bindgen glue (Rust → wasm32-unknown-unknown).
#
# Outputs:
#   pkg/        wasm-bindgen --target web   (worker/browser loader)
#   pkg-node/   wasm-bindgen --target nodejs (bun smoke test)
#   public/unpack-buffered.wasm   mirrored core .wasm (Vite serves wasm from
#                             public/ in dev, dist/ in prod — same rationale as
#                             vendor/v86/build-wasm.sh: keep them in sync so the
#                             worker can fetch the served path).
#
# Requirements: cargo + wasm32-unknown-unknown target, wasm-bindgen CLI 0.2.123
# (pinned to match the wasm-bindgen crate in Cargo.toml).
set -euo pipefail

cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target"

echo "=== cargo build --release --target wasm32-unknown-unknown ==="
cargo build --release --target wasm32-unknown-unknown

CORE=target/wasm32-unknown-unknown/release/unpack_buffered.wasm

echo "=== wasm-bindgen --target web → pkg/ ==="
wasm-bindgen --target web --out-dir pkg/ "$CORE"

echo "=== wasm-bindgen --target nodejs → pkg-node/ ==="
wasm-bindgen --target nodejs --out-dir pkg-node/ "$CORE"

# Mirror the bindgen-processed core .wasm to public/ (and dist/ if present) so
# the worker's --target web loader can fetch it from the served path. The
# bindgen step rewrites the .wasm (snips bindgen imports), so mirror pkg/'s
# output, NOT the raw cargo artifact.
BINDGEN_WASM=pkg/unpack_buffered_bg.wasm
REPO_ROOT="$(cd ../.. && pwd)"
for dest in "$REPO_ROOT/public/unpack-buffered.wasm" "$REPO_ROOT/dist/unpack-buffered.wasm"; do
    if [ -f "$dest" ] || [ -d "$(dirname "$dest")" ]; then
        cp "$BINDGEN_WASM" "$dest"
        echo "  → $dest ($(du -h "$dest" | cut -f1))"
    fi
done

echo "=== Done! ($(du -h "$BINDGEN_WASM" | cut -f1)) ==="
