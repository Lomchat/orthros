# Build unpack-streaming.wasm (Rust → wasm32-unknown-unknown)
# Output: public/unpack-streaming.wasm

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $Root
$env:CARGO_TARGET_DIR = Join-Path $Root "target"
try {
    Write-Host "[build-unpack-streaming] cargo build --release --target wasm32-unknown-unknown"
    cargo build --release --target wasm32-unknown-unknown
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $Artifact = Join-Path $Root "target/wasm32-unknown-unknown/release/unpack_streaming.wasm"
    $Dest = Join-Path $Root "../../public/unpack-streaming.wasm"
    if (-not (Test-Path $Artifact)) {
        throw "Artifact not found: $Artifact"
    }
    Copy-Item -Force $Artifact $Dest
    $Size = (Get-Item $Dest).Length
    Write-Host "[build-unpack-streaming] Done: $Dest ($Size bytes)"
} finally {
    Pop-Location
}
