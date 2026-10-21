# The OpenMW engine's compiler (tools/openmw/build.sh): the pinned Emscripten image the upstream builds with
# (Dockerfile.builder64: emscripten/emsdk:6.0.1) plus the two tools its CMake build needs and the image lacks.
# Built once, with network, by build.sh; its ID is recorded in lock.json ("build"."image").
FROM emscripten/emsdk:6.0.1@sha256:d0be652409a4d3362b8a36c3279dd1123ff1c9327e603d86d9361aa84f1d2e4c
RUN apt-get update && apt-get install -y --no-install-recommends ninja-build pkg-config && rm -rf /var/lib/apt/lists/* \
 && dpkg-query -W ninja-build pkg-config pkgconf > /usr/local/share/orthros-packages.txt
