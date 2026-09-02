#!/bin/sh
# Assemble fixture-x87.s at 0x200000 into a flat blob and print the verifier
# command line for it.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-/tmp/fixture-x87}"
as --32 -o "$out.o" "$here/fixture-x87.s"
ld -m elf_i386 -Ttext=0x200000 -e start -o "$out.elf" "$out.o"
objcopy -O binary -j .text "$out.elf" "$out.bin"
entries="$(nm "$out.elf" | awk '$3 ~ /^x87_/ { printf "%s0x%s", sep, $1; sep="," }')"
echo "bun tools/aot/verify-c.ts $out.bin --raw-base 0x200000 --entries $entries"
