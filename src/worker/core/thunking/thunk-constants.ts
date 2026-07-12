// thunk-constants.ts
// X86 instruction bytecode constants used throughout the thunking system
// These constants ensure consistency between ThunkGenerator, ThunkDispatcher, and CallbackManager

// RET instruction variants
export const RET = 0xC3;           // RET (no stack cleanup)
export const RET_N = 0xC2;         // RET imm16 (stack cleanup)

// MOV EAX, imm32
export const MOV_EAX_IMM32 = 0xB8;

// MOV EDX, imm32 (for port 0xB077)
export const MOV_EDX_IMM32 = 0xBA;
export const THUNK_PORT = 0x0000B077;  // Port for thunk/callback traps

// OUT DX, EAX (trap to JS)
export const OUT_DX_EAX = 0xEF;

// Stack operations
export const PUSH_EAX = 0x50;
export const POP_EAX = 0x58;

// JMP rel8 (for spin loops)
export const JMP_REL8 = 0xEB;
export const JMP_LOOP = 0xFE;      // -2 (jump to self, infinite loop)

// HLT instruction (yields CPU, more efficient than spin loop)
export const HLT = 0xF4;

// NOP padding
export const NOP = 0x90;

// Common stack cleanup amounts for stdcall APIs (bytes)
export const CLEANUP_AMOUNTS = [0, 4, 8, 12, 16, 20, 24, 32];

// Callback ID base (special IDs >= this are callback returns, not thunks)
export const CALLBACK_ID_BASE = 0x80000000;

// Stub sizes
export const CALLBACK_STUB_SIZE = 32;  // Bytes per callback return stub (aligned)
export const THUNK_STUB_SIZE = 16;     // Bytes per thunk stub (aligned)

// Default number of stubs per cleanup amount
export const DEFAULT_STUBS_PER_CLEANUP = 1024;
