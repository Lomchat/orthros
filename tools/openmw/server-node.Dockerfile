# The native multiplayer gateway's image (tools/openmw/server.mjs): the pinned upstream image (lock.json "serverImage")
# with its Node.js replaced by the official release lock.json "serverBuild"."node" names (nodejs.org linux-x64 tarball,
# its SHA-256 checked here again), same major version, so the gateway's N-API addon (@node-rs/argon2) loads as before.
# Everything else (OpenMW binary, gateway bundle, entrypoint, user, env, healthcheck) is the upstream image's.
# Built by tools/openmw/build-server-image.sh, without network; its image ID is recorded in lock.json.
ARG BASE
FROM ${BASE}
ARG BASE
ARG NODE_VERSION
ARG NODE_SHA256
# (the tarball only bind-mounted: not kept in a layer; the image has no xz, its p7zip unpacks it; the upstream layout kept — /usr/bin/node, npm and corepack in
# /usr/lib/node_modules, their /usr/bin links unchanged, headers in /usr/include/node)
RUN --mount=type=bind,source=node.tar.xz,target=/tmp/node.tar.xz \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && mkdir /tmp/node && 7z x -so -txz /tmp/node.tar.xz | tar -xf - -C /tmp/node --strip-components=1 --no-same-owner \
 && install -m 755 /tmp/node/bin/node /usr/bin/node \
 && rm -rf /usr/lib/node_modules/npm /usr/lib/node_modules/corepack /usr/include/node \
 && cp -R /tmp/node/lib/node_modules/npm /tmp/node/lib/node_modules/corepack /usr/lib/node_modules/ \
 && cp -R /tmp/node/include/node /usr/include/node \
 && rm -rf /tmp/node \
 && test "$(node --version)" = "v${NODE_VERSION}" \
 && cd /app && node -e "require('@node-rs/argon2').hashSync('x')" \
 && node --version > /usr/local/share/orthros-node.txt
LABEL org.opencontainers.image.base.name="${BASE}" org.orthros.node.version="${NODE_VERSION}" org.orthros.node.sha256="${NODE_SHA256}"
