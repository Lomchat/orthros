# x87 state contract for translated modules

Facts relevé dans le fork v86 (`src/rust/cpu/global_pointers.rs`, `cpu/fpu.rs`,
`softfloat.rs`, `codegen.rs`) que le code C produit par `x86-to-c.ts` doit
respecter pour rester bit-identique au JIT en mode relâché (celui livré :
`relaxedFpu` ON, `x87Locals` ON, `x87Writeback` (config 39) OFF).

## Offsets fixes (octets dans la mémoire linéaire de v86)

| global              | offset | type   | note                                   |
| ------------------- | -----: | ------ | -------------------------------------- |
| `fpu_simd_dirty`    |    632 | u8     | mettre à 1 à toute mutation x87/MMX/SSE |
| `fpu_stack_empty`   |    816 | u8     | bitmap par slot **physique** (1 = vide) |
| `fpu_stack_ptr`     |   1032 | u8     | TOP, 0..7 ; ST(i) = `fpu_st[(TOP+i)&7]` |
| `fpu_control_word`  |   1036 | u16    | bits 8-9 = precision control            |
| `fpu_status_word`   |   1040 | u16    | TOP (bits 11-13) n'y est **pas** stocké |
| `fpu_st`            |   1152 | 8 × 16 | `mantissa u64 @+0`, `sign_exponent u16 @+8`, 6 octets de bourrage |

## Représentation relâchée

Un slot est « relâché » ssi `sign_exponent == 0x7FFE` ; `mantissa` contient
alors les bits IEEE-754 binary64 bruts. Tout autre `sign_exponent` est un vrai
F80 (arithmétique f64 dans le fork, mais encodage 80 bits). Un module traduit :

- ne lit un slot en f64 que si son tag vaut `0x7FFE` ; sinon il **sort** vers
  le dispatcher à l'adresse de l'instruction (le JIT, lui, appelle le helper
  F80) ;
- n'écrit jamais un payload f64 sous un autre tag ; l'écriture d'un résultat
  arithmétique dans un slot déjà relâché peut se limiter à la mantisse.

Chargements mémoire (`fld m32/m64`, `fild`) : convertir en f64, écrire
`{bits, 0x7FFE}`. Stockages (`fst(p) m32/m64`) : `m64` = mantisse brute ;
`m32` = demote f64→f32.

## Pile

- push : `TOP = (TOP-1)&7 ; stack_empty &= ~(1<<TOP) ; fpu_st[TOP] = {m, tag}`
  — **sans** test de débordement (identique au JIT, pas au helper).
- pop : `stack_empty |= 1<<TOP ; TOP = (TOP+1)&7` — sans test de sous-flux, le
  contenu du slot est laissé en place.
- `fxch` : échange brut des 16 octets. `fst(p) st(i)` : copie brute des 16
  octets (`i == 0` : no-op ou pop seul).

## Precision control

Après chaque `add/sub/mul/div` f64, si `(control_word >> 8) & 3 == 0`
(simple précision), arrondir par `(double)(float)v`. Le JIT lit un drapeau
interne équivalent à l'exécution ; lire les bits du control word donne le même
résultat tant que `FLDCW/FLDENV/FRSTOR` passent par les helpers (c'est le cas).

## Comparaisons

`fcom*` écrivent C0/C2/C3 et **effacent C1** (`status &= ~0x4700` puis OR) ;
ordre de test : `<`, `==`, `>`, sinon non ordonné (C0|C2|C3). `fcomi*`
matérialisent CF/PF/ZF dans `flags` et remettent `flags_changed` à zéro.
`fnstsw ax` : `AX = (status & ~0x3800) | (TOP << 11)`.

## Conversions entières

`fist(p) m32/m16` : rounding control = `(control_word >> 10) & 3`
(0 nearest, 1 floor, 2 ceil, 3 trunc) ; NaN ou hors plage → `INT_MIN`
(`m16` : `-0x8000`).

## Exceptions

Le chemin rapide ne lève ni ne signale aucune exception x87 (pas de #MF, pas de
bits IE/ZE/DE/OE/UE/PE) ; seules les fautes de page des opérandes mémoire sont
observables. Les seules obligations sont `fpu_simd_dirty = 1` et `TOP ∈ 0..7`.

## Conventions d'opérandes de capstone (syntaxe Intel)

- formes D8 (destination ST(0)) : un seul opérande, `fadd st(1)` = ST(0) += ST(1),
  `fsubr st(1)` = ST(0) = ST(1) − ST(0) ;
- formes DC (destination ST(i)) : deux opérandes, `fsub st(1), st(0)` = ST(1) −= ST(0),
  `fdivr st(1), st(0)` = ST(1) = ST(0) / ST(1) (conforme au manuel Intel) ;
- formes DE (pop) : un opérande, `fsubp st(1)` = ST(1) −= ST(0) puis pop,
  `fsubrp st(1)` = ST(1) = ST(0) − ST(1) puis pop ;
- `fcomip st, st(1)` peut être imprimé `fcompi` selon la version.

v86 décode ces formes conformément au manuel Intel (`instr_DC_4_reg` = FSUBR
ST(i),ST(0), `instr_DC_5_reg` = FSUB ST(i),ST(0)).

## Vérification

`tools/aot/fixture-x87.s` (assemblé par `fixture-x87.sh` avec GNU as, base
0x200000) couvre arithmétique dans toutes les formes, comparaisons (status word,
`sahf`, `fcomi`, `fucomi` avec NaN), conversions entières (arrondi, dépassement,
`fisttp`), constantes, `fxch`/`fst st(i)`/`ffree`, et les sorties vers
l'interpréteur (`fsqrt`, `fldcw`, `fsin`, `fincstp`) avec reprise dans le module.
Le vérificateur compare aussi l'état x87 : valeur des huit slots (les deux
représentations sont normalisées en f64), TOP, bitmap vide, status word sans ses
bits d'exception, control word et drapeau dirty.
