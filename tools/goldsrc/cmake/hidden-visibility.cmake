# Included after project(regamedll) of the game modules' build (tools/goldsrc/build-modules.sh): the game server
# exports only what it marks DLLEXPORT. Emscripten's dynamic linker has one symbol table for every module: the client's
# same-named symbols (the weapon and entity code both share) would otherwise bind in place of the server's own.
add_compile_options(-fvisibility=hidden -fvisibility-inlines-hidden)
