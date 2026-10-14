// Native runner of the x87 condition-code probe (tools/x87cc-cases.mjs, tools/x87cc-probe.mjs): runs byte sequences on
// the host FPU in 64-bit mode (the encodings used mean the same there: x87 instructions, [eax + disp] operands with
// eax < 2^32, `or word`, `mov eax, imm32`). Input file: the 256-byte data block, then (u16 length, bytes)* ; output on
// stdout: one u16 (AX after the sequence) per case. Build: clang-18 -O1 -o x87cc tools/oracle/x87cc.c
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "usage: x87cc <cases.bin>\n"); return 2; }
  FILE *f = fopen(argv[1], "rb");
  if (!f) { perror(argv[1]); return 1; }
  uint8_t *code = mmap(NULL, 1 << 16, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS | MAP_32BIT, -1, 0);
  uint8_t *data = mmap(NULL, 1 << 16, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_32BIT, -1, 0);
  if (code == MAP_FAILED || data == MAP_FAILED) { perror("mmap"); return 1; }
  uint8_t init[256], buf[4096];
  if (fread(init, 1, sizeof init, f) != sizeof init) return 1;
  uint16_t len;
  while (fread(&len, 2, 1, f) == 1) {
    if (len > sizeof buf - 8 || fread(buf, 1, len, f) != len) return 1;
    memcpy(data, init, sizeof init);
    uint32_t d = (uint32_t)(uintptr_t)data;
    code[0] = 0xb8; memcpy(code + 1, &d, 4); // mov eax, data
    memcpy(code + 5, buf, len);
    code[5 + len] = 0xc3; // ret (the sequence ends with fninit)
    uint16_t ax = ((uint32_t(*)(void))code)() & 0xffff;
    fwrite(&ax, 2, 1, stdout);
  }
  return 0;
}
