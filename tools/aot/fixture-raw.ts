/**
 * Synthetic code blob for verify-c.ts --raw-base: one function per feature the
 * translator models beyond plain integer code, each ending in `ret`, so the
 * differential verifier can judge rep movs/stos, div/idiv/mul, setcc, cmovcc,
 * adc/sbb, imul with an immediate and enter/leave against v86 itself.
 *
 *   bun tools/aot/fixture-raw.ts /tmp/fixture.bin   (prints the entry list)
 */
const out: number[] = [];
const entries: Array<{ name: string; addr: number }> = [];
const BASE = 0x200000;
function fn(name: string, bytes: number[]) {
    while (out.length % 16 !== 0) out.push(0xcc);
    entries.push({ name, addr: BASE + out.length });
    out.push(...bytes);
}
// edi = [esp+4], esi = [esp+8] are pointers (default args), ecx = [esp+12]
// small. Callers fill the stack as the verifier does: args are pointers into
// scratch with --args pointers, small integers with --args small.
fn("rep_movsd", [
    0x56,                               // push esi
    0x57,                               // push edi
    0x8b, 0x7c, 0x24, 0x0c,             // mov edi, [esp+12]
    0x8b, 0x74, 0x24, 0x10,             // mov esi, [esp+16]
    0xb9, 0x09, 0x00, 0x00, 0x00,       // mov ecx, 9
    0xf3, 0xa5,                         // rep movsd
    0x5f, 0x5e,                         // pop edi; pop esi
    0xc3,                               // ret
]);
fn("rep_stosb", [
    0x57,                               // push edi
    0x8b, 0x7c, 0x24, 0x08,             // mov edi, [esp+8]
    0xb8, 0x5a, 0x00, 0x00, 0x00,       // mov eax, 0x5a
    0xb9, 0x0d, 0x00, 0x00, 0x00,       // mov ecx, 13
    0xf3, 0xaa,                         // rep stosb
    0x5f,                               // pop edi
    0xc3,
]);
fn("div_mul", [
    0xb8, 0x39, 0x30, 0x00, 0x00,       // mov eax, 12345
    0xba, 0x00, 0x00, 0x00, 0x00,       // mov edx, 0
    0xb9, 0x07, 0x00, 0x00, 0x00,       // mov ecx, 7
    0xf7, 0xf1,                         // div ecx
    0xf7, 0xe1,                         // mul ecx
    0xb9, 0xfd, 0xff, 0xff, 0xff,       // mov ecx, -3
    0xba, 0xff, 0xff, 0xff, 0xff,       // mov edx, -1
    0xb8, 0xf6, 0xff, 0xff, 0xff,       // mov eax, -10
    0xf7, 0xf9,                         // idiv ecx
    0xc3,
]);
fn("setcc_cmov", [
    0x8b, 0x44, 0x24, 0x04,             // mov eax, [esp+4]
    0x8b, 0x4c, 0x24, 0x08,             // mov ecx, [esp+8]
    0x3b, 0xc1,                         // cmp eax, ecx
    0x0f, 0x9c, 0xc2,                   // setl dl
    0x0f, 0x97, 0xc3,                   // seta bl
    0x0f, 0x4c, 0xc1,                   // cmovl eax, ecx
    0x6b, 0xc0, 0x0a,                   // imul eax, eax, 10
    0x69, 0xc9, 0xe8, 0x03, 0x00, 0x00, // imul ecx, ecx, 1000
    0xc3,
]);
fn("sbb_after_cmp", [
    0x8b, 0x44, 0x24, 0x04,             // mov eax, [esp+4]
    0x3b, 0x44, 0x24, 0x08,             // cmp eax, [esp+8]
    0x1b, 0xf6,                         // sbb esi, esi
    0xc3,
]);
fn("adc_after_add", [
    0x8b, 0x44, 0x24, 0x04,             // mov eax, [esp+4]
    0x03, 0x44, 0x24, 0x08,             // add eax, [esp+8]
    0x13, 0xff,                         // adc edi, edi
    0xc3,
]);
fn("sub_flags_branch", [
    0x8b, 0x44, 0x24, 0x04,             // mov eax, [esp+4]
    0x2b, 0x44, 0x24, 0x08,             // sub eax, [esp+8]
    0x7c, 0x03,                         // jl +3
    0x83, 0xc0, 0x07,                   // add eax, 7
    0xc3,                               // ret
]);
fn("enter_leave", [
    0xc8, 0x10, 0x00, 0x00,             // enter 16, 0
    0x8b, 0x45, 0x08,                   // mov eax, [ebp+8]
    0x89, 0x45, 0xfc,                   // mov [ebp-4], eax
    0x83, 0x45, 0xfc, 0x05,             // add dword [ebp-4], 5
    0x8b, 0x45, 0xfc,                   // mov eax, [ebp-4]
    0xc9,                               // leave
    0xc3,
]);
await Bun.write(process.argv[2]!, new Uint8Array(out));
console.log(`base=0x${BASE.toString(16)} ` + entries.map((e) => `${e.name}=0x${e.addr.toString(16)}`).join(" "));
console.log(entries.map((e) => `0x${e.addr.toString(16)}`).join(","));
