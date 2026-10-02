// API dispatch benchmark (tools/apicall-bench.mjs): the round trip of an API call handled in JavaScript — guest code
// calling GetVersion (a trivial JavaScript handler) in a loop, between two GetCommandLineA calls the harness times.
#include "win.h"

#define CALLS 1000000

void __stdcall start(void) {
  DWORD sum = 0;
  GetCommandLineA(); // mark: start
  for (int i = 0; i < CALLS; i++) sum += GetVersion();
  GetCommandLineA(); // mark: end
  ExitProcess(sum == (DWORD)(CALLS * 0x0a280105u) ? 0 : 1);
}
