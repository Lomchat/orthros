#!/bin/sh
# Builds the CRT-free Win32 test programs into build/pe/. Requires clang, lld-link, llvm-dlltool.
set -e
cd "$(dirname "$0")/../.."
OUT=build/pe
mkdir -p $OUT
DLLTOOL=${DLLTOOL:-llvm-dlltool-18}
for def in tools/pe/*.def; do
  lib=$OUT/$(basename "$def" .def).lib
  [ "$lib" -nt "$def" ] || $DLLTOOL -m i386 -d "$def" -l "$lib" -k
done
CFLAGS="--target=i686-pc-windows-msvc -O1 -ffreestanding -fno-builtin -fno-stack-protector -mno-stack-arg-probe -Wall -Wno-unused-function"
for src in tools/pe/*.c; do
  name=$(basename "$src" .c)
  exe=$OUT/$name.exe
  if [ "$exe" -nt "$src" ] && [ "$exe" -nt tools/pe/win.h ]; then continue; fi
  sub=console
  case "$name" in window*|gdi*) sub=windows ;; esac
  extra=""
  case "$name" in bench*) extra="-O2 -mno-sse -mfpmath=387" ;; esac
  clang $CFLAGS $extra -c -o $OUT/$name.obj "$src"
  lld-link /nologo /subsystem:$sub /entry:start /nodefaultlib /out:$exe $OUT/$name.obj $OUT/kernel32.lib $OUT/user32.lib $OUT/gdi32.lib $OUT/gdiplus.lib
  echo "built $exe"
done
