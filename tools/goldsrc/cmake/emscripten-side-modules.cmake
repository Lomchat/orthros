# Included after each project() of the game modules' build (tools/goldsrc/build-modules.sh): Emscripten builds a SHARED
# library as a side module (-sSIDE_MODULE=1, .wasm) that the engine, the main module, loads with dlopen.
set_property(GLOBAL PROPERTY TARGET_SUPPORTS_SHARED_LIBS TRUE)
set(CMAKE_SHARED_LIBRARY_SUFFIX ".wasm")
set(CMAKE_SHARED_LIBRARY_CREATE_C_FLAGS "-sSIDE_MODULE=1")
set(CMAKE_SHARED_LIBRARY_CREATE_CXX_FLAGS "-sSIDE_MODULE=1")
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
add_compile_options(-fPIC)
