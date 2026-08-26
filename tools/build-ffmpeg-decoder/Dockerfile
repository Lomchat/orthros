# Dockerfile for building video-decoder.wasm
# Optional: use this if you prefer a containerised build instead of WSL2/native.
#
# Build:
#   docker build -t orthros-ffmpeg-builder tools/build-ffmpeg-decoder/
#
# Run (from project root):
#   docker run --rm \
#     -v "$(pwd):/project" \
#     -w /project \
#     orthros-ffmpeg-builder \
#     bash tools/build-ffmpeg-decoder/build.sh

FROM emscripten/emsdk:3.1.64

RUN apt-get update && apt-get install -y --no-install-recommends \
    git make pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /project
