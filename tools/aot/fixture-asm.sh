#!/bin/sh
# Assemble a fixture (.s, Intel syntax) at 0x200000 into a flat blob and print
# the verifier command line for it: fixture-asm.sh <fixture.s> [/tmp/out-prefix]
set -e
src="$1"
out="${2:-/tmp/$(basename "$src" .s)}"
as --32 -o "$out.o" "$src"
ld -m elf_i386 -Ttext=0x200000 -e start -o "$out.elf" "$out.o"
objcopy -O binary -j .text "$out.elf" "$out.bin"
entries="$(nm "$out.elf" | awk '$3 ~ /^t_/ { printf "%s0x%s", sep, $1; sep="," }')"
echo "bun tools/aot/verify-c.ts $out.bin --raw-base 0x200000 --entries $entries"
