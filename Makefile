# Orthros build/test entry points. No build step for the runtime itself (plain ES modules).

CLANG ?= clang
BUILD := build
GEN := tests/generated
SUITES := alu stack branch string x87 sse verify_float verify_mech verify_int verify_trans
CASES ?= 1500

.PHONY: all test test-unit tools gen serve headless clean

all: test

# Unit tests + CPU conformance (conformance suites are generated on demand by the native oracle).
test: gen pe-tests test-unit

test-unit:
	node --test 'tests/**/*.test.js'

# ---- native x86-32 reference oracle (runs the same snippets on the host CPU)
tools: $(BUILD)/oracle

$(BUILD)/oracle: tools/oracle/oracle.S tools/oracle/oracle.c
	@mkdir -p $(BUILD)
	$(CLANG) -m32 -nostdlib -static -ffreestanding -fno-builtin -fno-stack-protector -fno-pic -fno-pie \
	  -O1 -Wall -Wl,-z,noexecstack -o $@ tools/oracle/oracle.S tools/oracle/oracle.c

# ---- conformance case generation: one .results.bin per suite, regenerated when the generator or
# the oracle changes.
gen: $(foreach s,$(SUITES),$(GEN)/$(s).results.bin)

$(GEN)/%.results.bin: tools/gen/gen_cases.py $(BUILD)/oracle
	@mkdir -p $(GEN)
	python3 tools/gen/gen_cases.py --suite $* --count $(CASES) --out $(GEN)

# ---- CRT-free Win32 test programs (clang + lld-link, no SDK)
pe-tests:
	@sh tools/pe/build.sh

serve:
	node src/host/server.js

headless:
	node src/host/harness/run.js

clean:
	rm -rf $(BUILD) $(GEN)
